// ~/.claude/projects/**/*.jsonl を走査してセッション要約を集める。
//   <project>/<sessionId>.jsonl                 … 主セッション
//   <project>/<sessionId>/subagents/agent-*.jsonl … サブエージェント(isSidechain)。
//        先頭の user 行の promptId が親セッションの人間プロンプトを指す
// ファイルごとに (size, mtimeMs) をキーにメモリキャッシュし、変化したものだけ再パースする。
// 再パースは worker_threads(scan-worker.mjs)で CPU 数まで並列に行う(JSON.parse が支配的なため)。
// 解決(resolveSessions)はキャッシュを変更せず、毎回新しいオブジェクトを組み立てる。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { parseTranscript, emptyUsage, addUsage, newPrompt, recomputeSession } from './parse.mjs';

export function defaultProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/** 並列パースのワーカー数。AIAD_SCAN_WORKERS で上書き(0 = ワーカーを使わず同一スレッドで逐次)。既定は CPU 数。 */
export function defaultWorkerCount() {
  const env = process.env.AIAD_SCAN_WORKERS;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
}

/** 1 ファイルを読んでパースし、ファイル情報を付けたセッションを返す(主スレッド・ワーカー共通)。 */
export async function readSession(entry) {
  const st = await fs.stat(entry.filePath);
  const text = await fs.readFile(entry.filePath, 'utf8');
  const session = parseTranscript(text, { sessionId: entry.sessionId });
  session.sessionId = entry.sessionId; // ファイル名を正とする(フォークはレコード内 sessionId が旧 ID のことがある)
  session.projectKey = entry.projectKey;
  session.parentSessionId = entry.parentSessionId;
  session.fileSize = st.size;
  session.fileMtime = st.mtimeMs;
  return session;
}

function errorSession(entry, e) {
  return { sessionId: entry.sessionId, projectKey: entry.projectKey, parentSessionId: entry.parentSessionId, error: String(e.message || e), prompts: [], usage: emptyUsage(), apiCalls: 0, models: {}, fileMtime: 0 };
}

export class TranscriptStore {
  /** @param {{workers?: number}} [opts] workers: 並列パースのワーカー数(0 = 逐次) */
  constructor(projectsDir = defaultProjectsDir(), opts = {}) {
    this.projectsDir = projectsDir;
    this.workers = opts.workers ?? defaultWorkerCount();
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

  /** キャッシュ命中ならその session、未命中なら読み直してキャッシュに入れる(逐次パス)。 */
  async loadSession(entry) {
    const st = await fs.stat(entry.filePath);
    const hit = this.cache.get(entry.filePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.session;
    const session = await readSession(entry);
    this.cache.set(entry.filePath, { size: session.fileSize, mtimeMs: session.fileMtime, session });
    return session;
  }

  /**
   * 変化したファイル群をワーカーで並列にパースする。戻り値は entries と同じ順の
   * { session } | { error } 配列。ワーカー自体が落ちたら reject する(呼び出し側が逐次へ退避)。
   */
  parseWithWorkers(entries, workerCount) {
    // 大きいファイルから配ると、末尾で 1 本の巨大ファイルを待つ時間が短くなる
    const queue = entries.map((entry, seq) => ({ entry, seq })).sort((a, b) => (b.entry.size || 0) - (a.entry.size || 0));
    const results = new Array(entries.length);
    return new Promise((resolve, reject) => {
      const workers = [];
      let next = 0;
      let done = 0;
      let failed = false;
      const stopAll = () => workers.forEach((w) => w.terminate());
      const feed = (w) => {
        if (next >= queue.length) {
          w.terminate();
          return;
        }
        const { entry, seq } = queue[next++];
        w.postMessage({ seq, entry: { projectKey: entry.projectKey, filePath: entry.filePath, sessionId: entry.sessionId, parentSessionId: entry.parentSessionId } });
      };
      for (let k = 0; k < workerCount; k++) {
        const w = new Worker(new URL('./scan-worker.mjs', import.meta.url));
        w.on('message', (m) => {
          results[m.seq] = m;
          done++;
          if (done === queue.length) {
            stopAll();
            resolve(results);
          } else {
            feed(w);
          }
        });
        w.on('error', (err) => {
          if (failed) return;
          failed = true;
          stopAll();
          reject(err);
        });
        workers.push(w);
        feed(w);
      }
    });
  }

  /** 全ファイルを(キャッシュを使って)読み、解決済みセッション配列を返す。 */
  async scan() {
    const t0 = Date.now();
    const files = await this.listFiles();
    const live = new Set(files.map((f) => f.filePath));
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);

    // 1. stat でキャッシュ命中を判定し、変化分だけを集める
    const parsed = new Array(files.length);
    const stale = [];
    await Promise.all(
      files.map(async (f, i) => {
        try {
          const st = await fs.stat(f.filePath);
          const hit = this.cache.get(f.filePath);
          if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) parsed[i] = hit.session;
          else stale.push({ index: i, entry: { ...f, size: st.size } });
        } catch (e) {
          parsed[i] = errorSession(f, e);
        }
      })
    );

    // 2. 変化分をパース(複数あればワーカー並列、1 件以下または workers=0 なら逐次)
    const workerCount = Math.min(this.workers, stale.length);
    let results = null;
    if (workerCount > 1) {
      try {
        results = await this.parseWithWorkers(stale.map((s) => s.entry), workerCount);
      } catch (e) {
        console.error('scan: worker pool failed, falling back to sequential parse:', e && e.message ? e.message : e);
      }
    }
    for (let k = 0; k < stale.length; k++) {
      const { index, entry } = stale[k];
      let r = results && results[k];
      if (!r) {
        try {
          r = { session: await readSession(entry) };
        } catch (e) {
          r = { error: String(e.message || e) };
        }
      }
      if (r.session) {
        this.cache.set(entry.filePath, { size: r.session.fileSize, mtimeMs: r.session.fileMtime, session: r.session });
        parsed[index] = r.session;
      } else {
        parsed[index] = errorSession(entry, { message: r.error });
      }
    }

    const sessions = resolveSessions(parsed);
    this.lastScan = { at: new Date().toISOString(), ms: Date.now() - t0, files: files.length, sessions: sessions.length, duplicatesDropped: sessions.reduce((n, s) => n + s.duplicatePrompts, 0), parsed: stale.length, workers: workerCount };
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
