// Claude Code トランスクリプト(JSONL)のパーサ。純関数のみ — I/O はしない。
//
// 1 行 = 1 レコード。関係するのは次の type:
//   user      … 人間の指示(origin.kind === "human")、サブエージェントへの Work Order(isSidechain)、
//               ツール結果、注入テキスト(isMeta)
//   assistant … API 応答。message.usage にトークン数。1 応答が複数行に分割されて
//               記録され、各行が同じ message.id と同じ usage を持つ → message.id で重複排除する
//   custom-title / ai-title / agent-name … セッション表示名
// 帰属ルール: assistant 行は promptId を持たないので、ファイル内の出現順で
// 「直前のプロンプト」に帰属させる。各プロンプトは API 呼出の一覧(calls)を保持し、
// 複数ファイル横断の重複排除(フォーク複製・サブエージェント合流)は scan.mjs が行う。

export function emptyUsage() {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, total: 0 };
}

export function addUsage(target, u) {
  target.input += u.input;
  target.cacheCreation += u.cacheCreation;
  target.cacheRead += u.cacheRead;
  target.output += u.output;
  target.total += u.total;
  return target;
}

function usageFromMessage(usage) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const u = {
    input: n(usage.input_tokens),
    cacheCreation: n(usage.cache_creation_input_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    output: n(usage.output_tokens),
    total: 0,
  };
  u.total = u.input + u.cacheCreation + u.cacheRead + u.output;
  return u;
}

function hasToolResult(rec) {
  const c = rec.message && rec.message.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
}

/** 人間が打った指示か。origin が無い旧形式は「meta でなく tool_result でもない user 行」で代替。 */
export function isHumanPrompt(rec) {
  if (rec.type !== 'user' || !rec.message || rec.isMeta || rec.isSidechain) return false;
  if (rec.origin && rec.origin.kind) return rec.origin.kind === 'human';
  const c = rec.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !hasToolResult(rec);
  return false;
}

/** サブエージェント(sidechain)への Work Order か。promptId で親プロンプトに結び付く。 */
export function isSubagentPrompt(rec) {
  return rec.type === 'user' && !!rec.message && !!rec.isSidechain && !rec.isMeta && !hasToolResult(rec);
}

export function promptText(rec) {
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** `<command-name>/helix</command-name><command-args>…</command-args>` 形式を表示用に畳む。 */
export function displayText(raw) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(raw);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw);
    const a = args ? args[1].trim() : '';
    return { kind: 'command', text: (name[1].trim() + (a ? ' ' + a : '')).trim() };
  }
  const stripped = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[貼り付け]')
    .replace(/\s+/g, ' ')
    .trim();
  return { kind: 'text', text: stripped };
}

export function newPrompt(rec, index, kind) {
  const raw = promptText(rec);
  const d = displayText(raw);
  return {
    index,
    kind: kind || d.kind, // command | text | subagent | orphan
    promptId: rec.promptId || null,
    uuid: rec.uuid || null,
    agentId: rec.agentId || null,
    timestamp: rec.timestamp || null,
    endTimestamp: rec.timestamp || null,
    text: d.text.slice(0, 400),
    rawLength: raw.length,
    calls: [], // {id, usage, model, toolUses, sidechain, timestamp}
    usage: emptyUsage(),
    apiCalls: 0,
    toolUses: 0,
    sidechainCalls: 0,
    models: {},
  };
}

/** calls から集計フィールドを計算し直す(scan の重複排除後にも使う)。 */
export function recomputePrompt(p) {
  p.usage = emptyUsage();
  p.apiCalls = 0;
  p.toolUses = 0;
  p.sidechainCalls = 0;
  p.models = {};
  for (const c of p.calls) {
    addUsage(p.usage, c.usage);
    p.apiCalls++;
    p.toolUses += c.toolUses;
    if (c.sidechain) p.sidechainCalls++;
    if (c.model) p.models[c.model] = (p.models[c.model] || 0) + 1;
    if (c.timestamp && (!p.endTimestamp || c.timestamp > p.endTimestamp)) p.endTimestamp = c.timestamp;
  }
  return p;
}

export function recomputeSession(s) {
  s.usage = emptyUsage();
  s.apiCalls = 0;
  s.models = {};
  for (const p of s.prompts) {
    recomputePrompt(p);
    addUsage(s.usage, p.usage);
    s.apiCalls += p.apiCalls;
    for (const [m, c] of Object.entries(p.models)) s.models[m] = (s.models[m] || 0) + c;
  }
  return s;
}

/**
 * @param {string} text JSONL 全文
 * @param {{sessionId?: string}} [opts]
 */
export function parseTranscript(text, opts = {}) {
  const session = {
    sessionId: opts.sessionId || null,
    title: null,
    cwd: null,
    version: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    usage: emptyUsage(),
    apiCalls: 0,
    models: {},
    badLines: 0,
  };
  const seenMessageIds = new Map(); // message.id -> call(同一応答の分割行で tool_use を足す)
  let current = null; // 直前のプロンプト
  let titleFromRecord = null;

  const lines = text.split('\n');
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      session.badLines++;
      continue;
    }
    if (!session.sessionId && rec.sessionId) session.sessionId = rec.sessionId;
    if (rec.cwd && !session.cwd) session.cwd = rec.cwd;
    if (rec.version) session.version = rec.version;
    if (rec.timestamp) {
      if (!session.startedAt || rec.timestamp < session.startedAt) session.startedAt = rec.timestamp;
      if (!session.endedAt || rec.timestamp > session.endedAt) session.endedAt = rec.timestamp;
    }

    switch (rec.type) {
      case 'custom-title':
        if (rec.customTitle) titleFromRecord = rec.customTitle;
        break;
      case 'ai-title':
        if (rec.aiTitle && !titleFromRecord) titleFromRecord = rec.aiTitle;
        break;
      case 'agent-name':
        if (rec.agentName && !titleFromRecord) titleFromRecord = rec.agentName;
        break;
      case 'user':
        if (isHumanPrompt(rec)) {
          current = newPrompt(rec, session.prompts.length);
          session.prompts.push(current);
        } else if (isSubagentPrompt(rec)) {
          current = newPrompt(rec, session.prompts.length, 'subagent');
          session.prompts.push(current);
        }
        break;
      case 'assistant': {
        const m = rec.message;
        if (!m || !m.usage) break;
        const id = m.id || rec.requestId || rec.uuid;
        const toolUses = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_use').length : 0;
        const prev = id && seenMessageIds.get(id);
        if (prev) {
          prev.toolUses += toolUses; // 同一応答の分割行。usage は数え済み
          break;
        }
        if (!current) {
          // 再開セッション等で先頭にプロンプトが無い場合の受け皿
          current = newPrompt({ message: { content: '(帰属先プロンプトなし)' }, timestamp: rec.timestamp, uuid: rec.uuid }, session.prompts.length, 'orphan');
          session.prompts.push(current);
        }
        const call = { id: id || null, usage: usageFromMessage(m.usage), model: m.model || null, toolUses, sidechain: !!rec.isSidechain, timestamp: rec.timestamp || null };
        if (id) seenMessageIds.set(id, call);
        current.calls.push(call);
        break;
      }
      default:
        break;
    }
  }

  recomputeSession(session);
  const firstReal = session.prompts.find((p) => p.kind === 'command' || p.kind === 'text');
  session.title = titleFromRecord || (firstReal ? firstReal.text.slice(0, 60) : '(無題)');
  return session;
}
