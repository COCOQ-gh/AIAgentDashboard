// キャッシュの内訳(純関数のみ — I/O はしない)。
//
// 1) キャッシュ作成の原因: 主系列(sidechain でない)API 呼出を時刻順に並べ、各呼出の cache_creation を
//    直前の呼出との関係で分類する。
//      first       … セッション最初の呼出(初期コンテキストの作成)
//      modelSwitch … 直前と model が違う(プロンプトキャッシュはモデル別なので全文脈を作り直す)
//      idleLong    … 直前から idleLongMinutes 超(キャッシュ TTL 切れ → 作り直し)
//      compaction  … 文脈が直前の shrinkRatio 未満に縮んだ(/compact 等で要約に置き換わった)
//      idleShort   … 直前から idleShortMinutes 超(5 分 TTL なら切れている可能性)
//      growth      … 上記以外 = 新しく増えた内容(ツール結果・指示・前の応答)の分
// 2) キャッシュ読取の構成: 「いま文脈に積まれているものの由来」を呼出ごとに台帳で追跡し、各呼出の
//    cache_read をその構成比で按分する。由来は baseline(初期コンテキスト)/ prompt(人間の指示)/
//    assistantOutput(直前の応答)/ tools.<name>(ツール結果)/ compactedSummary(圧縮後の要約)/ other。
//    推定の前提: 呼出 k で新たに入力されたトークン(input + cache_creation)は「直前の応答の出力」+
//    「直前の呼出のツール結果(ツールが複数なら等分)」か、指示の最初の呼出なら「指示本文+注入文脈」。
//    過去の thinking は文脈から落ちることがあるため assistantOutput は上限側の概算。

export const CAUSES = ['first', 'modelSwitch', 'idleLong', 'compaction', 'idleShort', 'growth'];
export const CAUSE_LABELS = {
  first: '初回(初期コンテキスト)',
  modelSwitch: 'モデル切替',
  idleLong: 'アイドル後(60 分超)',
  compaction: '圧縮(/compact 等)',
  idleShort: 'アイドル後(5〜60 分)',
  growth: '通常の追加',
};
export const COMPONENTS = ['baseline', 'prompt', 'assistantOutput', 'compactedSummary', 'other'];
export const COMPONENT_LABELS = {
  baseline: '初期コンテキスト(システム・CLAUDE.md・スキル)',
  prompt: '人間の指示(+注入文脈)',
  assistantOutput: 'アシスタントの出力',
  compactedSummary: '圧縮後の要約',
  other: 'その他',
};
const DEFAULTS = { idleLongMinutes: 60, idleShortMinutes: 5, shrinkRatio: 0.7, minContextForShrink: 20_000 };

export function contextOf(call) {
  return call.usage.input + call.usage.cacheRead + call.usage.cacheCreation;
}

export function emptyBreakdown() {
  const creationByCause = {};
  for (const c of CAUSES) creationByCause[c] = { tokens: 0, calls: 0 };
  const readByComponent = { tools: {} };
  for (const k of COMPONENTS) readByComponent[k] = 0;
  return { calls: 0, cacheCreation: 0, cacheRead: 0, creationByCause, readByComponent, modelSwitches: { count: 0, tokens: 0 } };
}

export function addBreakdown(target, b) {
  target.calls += b.calls;
  target.cacheCreation += b.cacheCreation;
  target.cacheRead += b.cacheRead;
  for (const c of CAUSES) {
    target.creationByCause[c].tokens += b.creationByCause[c].tokens;
    target.creationByCause[c].calls += b.creationByCause[c].calls;
  }
  for (const k of COMPONENTS) target.readByComponent[k] += b.readByComponent[k];
  for (const [t, v] of Object.entries(b.readByComponent.tools)) target.readByComponent.tools[t] = (target.readByComponent.tools[t] || 0) + v;
  target.modelSwitches.count += b.modelSwitches.count;
  target.modelSwitches.tokens += b.modelSwitches.tokens;
  return target;
}

/** 主系列の呼出を時刻順に。各要素は call に promptIndex / firstOfPrompt を添えたもの。 */
export function orderedMainCalls(session) {
  const out = [];
  for (const p of session.prompts) {
    let first = true;
    for (const c of p.calls) {
      if (c.sidechain) continue;
      out.push({ ...c, promptIndex: p.index, firstOfPrompt: first });
      first = false;
    }
  }
  // ファイル内の出現順 = 時刻順が基本だが、合流・複製の影響を受けないよう timestamp で安定ソート
  return out.map((c, i) => [c, i]).sort((a, b) => ((a[0].timestamp || '') < (b[0].timestamp || '') ? -1 : (a[0].timestamp || '') > (b[0].timestamp || '') ? 1 : a[1] - b[1])).map((x) => x[0]);
}

function classify(c, prev, ctxNow, ctxPrev, o) {
  if (!prev) return 'first';
  if (prev.model && c.model && prev.model !== c.model) return 'modelSwitch';
  const gap = c.timestamp && prev.timestamp ? (Date.parse(c.timestamp) - Date.parse(prev.timestamp)) / 60000 : 0;
  if (gap > o.idleLongMinutes) return 'idleLong';
  if (ctxPrev >= o.minContextForShrink && ctxNow < ctxPrev * o.shrinkRatio) return 'compaction';
  if (gap > o.idleShortMinutes) return 'idleShort';
  return 'growth';
}

/**
 * @param {object} session 解決済みセッション(prompts[].calls を持つ)
 * @param {{since?: string, idleLongMinutes?: number, idleShortMinutes?: number, shrinkRatio?: number}} [opts]
 *   since: この ISO 時刻以降の呼出だけを集計に入れる(文脈台帳の追跡は先頭から行う)
 */
export function analyzeSession(session, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const b = emptyBreakdown();
  b.switches = []; // {timestamp, from, to, cacheCreation, promptIndex}
  b.promptExtras = {}; // promptIndex -> {modelSwitches, switchTokens, creationByCause}
  const calls = orderedMainCalls(session);
  let prev = null;
  let ctxPrev = 0;
  let ledger = {}; // component -> tokens currently in context ('tool:<name>' for tools)
  for (const c of calls) {
    const ctxNow = contextOf(c);
    const cause = classify(c, prev, ctxNow, ctxPrev, o);
    // --- 集計(since フィルタはここで)。cache_read は「この呼出の前から文脈にあったもの」を読むので、
    //     台帳を更新する前の構成比で按分する ---
    if (!o.since || (c.timestamp && c.timestamp >= o.since)) {
      b.calls++;
      b.cacheCreation += c.usage.cacheCreation;
      b.cacheRead += c.usage.cacheRead;
      b.creationByCause[cause].tokens += c.usage.cacheCreation;
      b.creationByCause[cause].calls++;
      const pe = (b.promptExtras[c.promptIndex] ||= { modelSwitches: 0, switchTokens: 0 });
      if (cause === 'modelSwitch') {
        b.modelSwitches.count++;
        b.modelSwitches.tokens += c.usage.cacheCreation;
        b.switches.push({ timestamp: c.timestamp, from: prev.model, to: c.model, cacheCreation: c.usage.cacheCreation, promptIndex: c.promptIndex });
        pe.modelSwitches++;
        pe.switchTokens += c.usage.cacheCreation;
      }
      if (c.usage.cacheRead > 0) {
        const tot = Object.values(ledger).reduce((a, v) => a + v, 0);
        if (tot > 0) {
          for (const [k, v] of Object.entries(ledger)) {
            const share = c.usage.cacheRead * (v / tot);
            if (k.startsWith('tool:')) b.readByComponent.tools[k.slice(5)] = (b.readByComponent.tools[k.slice(5)] || 0) + share;
            else b.readByComponent[k] += share;
          }
        } else {
          b.readByComponent.baseline += c.usage.cacheRead; // 初回の読取(共有プレフィックス等)は初期コンテキスト扱い
        }
      }
    }
    // --- 文脈台帳の更新 ---
    if (cause === 'first') {
      ledger = { baseline: ctxNow };
    } else if (cause === 'compaction') {
      ledger = { compactedSummary: ctxNow };
    } else if (cause === 'modelSwitch' || cause === 'idleLong') {
      // 中身は同じまま作り直し。構成比を保って現在量に合わせる
      const tot = Object.values(ledger).reduce((a, v) => a + v, 0) || 1;
      for (const k of Object.keys(ledger)) ledger[k] = (ledger[k] / tot) * ctxNow;
    } else {
      let rest = c.usage.input + c.usage.cacheCreation;
      if (prev) {
        const out = Math.min(prev.usage.output, rest);
        ledger.assistantOutput = (ledger.assistantOutput || 0) + out;
        rest -= out;
      }
      if (rest > 0) {
        if (c.firstOfPrompt) ledger.prompt = (ledger.prompt || 0) + rest;
        else if (prev && Array.isArray(prev.tools) && prev.tools.length) {
          const per = rest / prev.tools.length;
          for (const t of prev.tools) ledger['tool:' + t] = (ledger['tool:' + t] || 0) + per;
        } else ledger.other = (ledger.other || 0) + rest;
      }
    }
    prev = c;
    ctxPrev = ctxNow;
  }
  return b;
}

/** 複数セッションの合算(switches / promptExtras は落とす)。 */
export function analyzeMany(sessions, opts = {}) {
  const total = emptyBreakdown();
  for (const s of sessions) addBreakdown(total, analyzeSession(s, opts));
  return total;
}

/** 表示用: 原因を tokens 降順の行に。 */
export function causeRows(b) {
  return CAUSES.map((c) => ({ key: c, label: CAUSE_LABELS[c], tokens: Math.round(b.creationByCause[c].tokens), calls: b.creationByCause[c].calls, pct: b.cacheCreation ? b.creationByCause[c].tokens / b.cacheCreation : 0 })).sort((x, y) => y.tokens - x.tokens);
}

/** 表示用: 構成を tokens 降順の行に(ツールは個別行、上位 maxTools 件以降は「他のツール」に畳む)。 */
export function componentRows(b, maxTools = 8) {
  const rows = COMPONENTS.map((k) => ({ key: k, label: COMPONENT_LABELS[k], tokens: b.readByComponent[k] }));
  const tools = Object.entries(b.readByComponent.tools).map(([t, v]) => ({ key: 'tool:' + t, label: `ツール結果: ${t}`, tokens: v })).sort((x, y) => y.tokens - x.tokens);
  const head = tools.slice(0, maxTools);
  const tail = tools.slice(maxTools);
  if (tail.length) head.push({ key: 'tool:*', label: `ツール結果: 他 ${tail.length} 種`, tokens: tail.reduce((a, r) => a + r.tokens, 0) });
  const out = [...rows, ...head]
    .filter((r) => r.tokens > 0)
    .map((r) => ({ ...r, tokens: Math.round(r.tokens), pct: b.cacheRead ? r.tokens / b.cacheRead : 0 }))
    .sort((x, y) => y.tokens - x.tokens);
  // 「他 N 種」のまとめ行は量に関わらず末尾へ
  const i = out.findIndex((r) => r.key === 'tool:*');
  if (i >= 0) out.push(...out.splice(i, 1));
  return out;
}
