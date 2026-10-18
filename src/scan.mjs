// ~/.claude/projects/**/*.jsonl を走査してセッション要約を集める。
//   <project>/<sessionId>.jsonl                 … 主セッション
//   <project>/<sessionId>/subagents/agent-*.jsonl … サブエージェント(isSidechain)。
//        先頭の user 行の promptId が親セッションの人間プロンプトを指す
// ファイルごとに (size, mtimeMs) をキーにメモリキャッシュし、変化したものだけ再パースする。
// 解決(resolveSessions)はキャッシュを変更せず、毎回新しいオブジェクトを組み立てる。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTranscript, emptyUsage, addUsage, newPrompt, recomputeSession } from './parse.mjs';

export function defaultProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

export class TranscriptStore {
  constructor(projectsDir = defaultProjectsDir()) {
    this.projectsDir = projectsDir;
    this.cache = new Map(); // filePath -> { size, mtimeMs, session }
    this.lastScan = null;
  }

  async listFiles() {
    const out = [];
    let dirs;
    try {
      dirs = await fs.readdir(this.projectsDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return out;
      throw e;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const projDir = path.join(this.projectsDir, d.name);
      let entries;
      try {
        entries = await fs.readdir(projDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ projectKey: d.name, filePath: path.join(projDir, e.name), sessionId: e.name.slice(0, -6), parentSessionId: null });
        } else if (e.isDirectory()) {
          const subDir = path.join(projDir, e.name, 'subagents');
          let subs = [];
          try {
            subs = await fs.readdir(subDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const s of subs) {
            if (s.isFile() && s.name.endsWith('.jsonl')) {
              out.push({ projectKey: d.name, filePath: path.join(subDir, s.name), sessionId: e.name + '/' + s.name.slice(0, -6), parentSessionId: e.name });
            }
          }
        }
      }
    }
    return out;
  }

  async loadSession(entry) {
    const st = await fs.stat(entry.filePath);
    const hit = this.cache.get(entry.filePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.session;
    const text = await fs.readFile(entry.filePath, 'utf8');
    const session = parseTranscript(text, { sessionId: entry.parentSessionId ? entry.sessionId : entry.sessionId });
    session.sessionId = entry.sessionId; // ファイル名を正とする(フォークはレコード内 sessionId が旧 ID のことがある)
    session.projectKey = entry.projectKey;
    session.parentSessionId = entry.parentSessionId;
    session.fileSize = st.size;
    session.fileMtime = st.mtimeMs;
    this.cache.set(entry.filePath, { size: st.size, mtimeMs: st.mtimeMs, session });
    return session;
  }

  /** 全ファイルを(キャッシュを使って)読み、解決済みセッション配列を返す。 */
  async scan() {
    const t0 = Date.now();
    const files = await this.listFiles();
    const live = new Set(files.map((f) => f.filePath));
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);
    const parsed = [];
    for (const f of files) {
      try {
        parsed.push(await this.loadSession(f));
      } catch (e) {
        parsed.push({ sessionId: f.sessionId, projectKey: f.projectKey, parentSessionId: f.parentSessionId, error: String(e.message || e), prompts: [], usage: emptyUsage(), apiCalls: 0, models: {}, fileMtime: 0 });
      }
    }
    const sessions = resolveSessions(parsed);
    this.lastScan = { at: new Date().toISOString(), ms: Date.now() - t0, files: files.length, sessions: sessions.length, duplicatesDropped: sessions.reduce((n, s) => n + s.duplicatePrompts, 0) };
    return sessions;
  }
}

function cloneSession(s) {
  return { ...s, prompts: s.prompts.map((p) => ({ ...p, calls: p.calls.slice(), models: { ...p.models } })), models: { ...s.models }, usage: { ...s.usage } };
}

/**
 * パース済みセッション群を解決する(純関数):
 *  1. サブエージェントファイルの calls を親セッションの該当プロンプト(promptId 一致)に合流
 *  2. フォーク/再開で複製された履歴を、message.id の横断重複排除で 1 回だけ数える
 *     (開始時刻→ファイル更新時刻の昇順で先に出たファイルが所有する)
 *  3. 複製で中身が空になったプロンプトは落とす(duplicatePrompts に計数)
 */
export function resolveSessions(parsed) {
  const mains = parsed.filter((s) => !s.parentSessionId).map(cloneSession);
  const byId = new Map(mains.map((s) => [s.sessionId, s]));

  for (const sub of parsed.filter((s) => s.parentSessionId)) {
    const parent = byId.get(sub.parentSessionId);
    if (!parent) continue;
    for (const sp of sub.prompts) {
      let target = sp.promptId ? parent.prompts.find((p) => p.promptId === sp.promptId) : null;
      if (!target) {
        // promptId で結べなければ、WO の時刻より前の最後のプロンプトへ
        target = [...parent.prompts].reverse().find((p) => p.kind !== 'subagent' && p.timestamp && sp.timestamp && p.timestamp <= sp.timestamp);
      }
      if (!target) {
        target = newPrompt({ message: { content: '(サブエージェントのみ・親プロンプト不明)' }, timestamp: sp.timestamp }, parent.prompts.length, 'orphan');
        parent.prompts.push(target);
      }
      for (const c of sp.calls) target.calls.push({ ...c, sidechain: true, agentId: sp.agentId });
    }
  }

  mains.sort((a, b) => ((a.startedAt || '') < (b.startedAt || '') ? -1 : (a.startedAt || '') > (b.startedAt || '') ? 1 : (a.fileMtime || 0) - (b.fileMtime || 0)));
  const seenCalls = new Set();
  const seenPrompts = new Set();
  for (const s of mains) {
    s.duplicatePrompts = 0;
    const kept = [];
    for (const p of s.prompts) {
      p.calls = p.calls.filter((c) => {
        if (!c.id) return true;
        if (seenCalls.has(c.id)) return false;
        seenCalls.add(c.id);
        return true;
      });
      const dupPrompt = p.uuid && seenPrompts.has(p.uuid);
      if (p.uuid) seenPrompts.add(p.uuid);
      if (dupPrompt && p.calls.length === 0) {
        s.duplicatePrompts++;
        continue;
      }
      p.duplicate = !!dupPrompt;
      kept.push(p);
    }
    kept.forEach((p, i) => (p.index = i));
    s.prompts = kept;
    recomputeSession(s);
  }
  return mains;
}

/** プロジェクト別の集計(セッションの cwd を名前に使う。無ければディレクトリ名)。 */
export function summarizeProjects(sessions) {
  const byKey = new Map();
  for (const s of sessions) {
    let p = byKey.get(s.projectKey);
    if (!p) {
      p = { key: s.projectKey, cwd: null, sessions: 0, prompts: 0, apiCalls: 0, usage: emptyUsage(), firstActivity: null, lastActivity: null, models: {} };
      byKey.set(s.projectKey, p);
    }
    if (s.cwd && !p.cwd) p.cwd = s.cwd;
    p.sessions++;
    p.prompts += s.prompts.length;
    p.apiCalls += s.apiCalls;
    addUsage(p.usage, s.usage);
    if (s.startedAt && (!p.firstActivity || s.startedAt < p.firstActivity)) p.firstActivity = s.startedAt;
    if (s.endedAt && (!p.lastActivity || s.endedAt > p.lastActivity)) p.lastActivity = s.endedAt;
    for (const [m, c] of Object.entries(s.models)) p.models[m] = (p.models[m] || 0) + c;
  }
  return [...byKey.values()].sort((a, b) => b.usage.total - a.usage.total);
}

export function sessionSummary(s) {
  return {
    sessionId: s.sessionId,
    projectKey: s.projectKey,
    title: s.title,
    cwd: s.cwd,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    prompts: s.prompts.length,
    duplicatePrompts: s.duplicatePrompts || 0,
    apiCalls: s.apiCalls,
    usage: s.usage,
    models: s.models,
    fileSize: s.fileSize,
    error: s.error || null,
  };
}

/** API 出力用: calls を落として軽くする。 */
export function promptView(p) {
  const { calls, ...rest } = p;
  return rest;
}

/** 全セッション横断の「指示」一覧(セッション参照付き)。 */
export function flattenPrompts(sessions) {
  const out = [];
  for (const s of sessions) {
    for (const p of s.prompts) {
      out.push({ ...promptView(p), sessionId: s.sessionId, sessionTitle: s.title, projectKey: s.projectKey, cwd: s.cwd });
    }
  }
  return out;
}
