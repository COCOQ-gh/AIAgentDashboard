// AI エージェントが自分の消費トークンを読んで作業を調整するためのレポート(純関数のみ — I/O はしない)。
// 入力は scan.mjs の resolveSessions が返す解決済みセッション。
//
// 推定の根拠:
//   - コンテキスト量 ≈ 最後の主系列(sidechain でない)API 呼出の input + cache_read + cache_creation
//     (その呼出でモデルに渡した全トークン)
//   - ツール別の文脈追加 ≈ 「次の呼出で新たに入力されたトークン(input + cache_creation)」を
//     直前の呼出が使ったツールへ等分した概算。ツールを使わない応答は '(応答のみ)'、各指示の
//     最初の呼出(指示本文 + 注入されたシステム文脈)は '(指示+システム)' に計上する

export function projectKeyFromCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function contextTokens(call) {
  return call.usage.input + call.usage.cacheRead + call.usage.cacheCreation;
}

/** モデル名から文脈窓(トークン)を推定する。AIAD_CONTEXT_WINDOW で上書き可。 */
export function contextWindowFor(model, env = process.env) {
  const n = Number(env.AIAD_CONTEXT_WINDOW);
  if (Number.isFinite(n) && n > 0) return n;
  if (model && /\[1m\]|fable-5|opus-5/i.test(model)) return 1_000_000;
  return 200_000;
}

/** sessionId 指定ならそれ、無ければ cwd と同じプロジェクトの最新セッション(endedAt 降順)。 */
export function pickSession(sessions, { sessionId, cwd } = {}) {
  if (sessionId) return sessions.find((s) => s.sessionId === sessionId) || null;
  const key = cwd ? projectKeyFromCwd(cwd) : null;
  const cands = sessions.filter((s) => !s.parentSessionId && (!key || (s.cwd && projectKeyFromCwd(s.cwd) === key)));
  cands.sort((a, b) => ((a.endedAt || '') > (b.endedAt || '') ? -1 : (a.endedAt || '') < (b.endedAt || '') ? 1 : 0));
  return cands[0] || null;
}

function mainCalls(p) {
  return p.calls.filter((c) => !c.sidechain);
}

/** ツール別の文脈追加(概算)。戻り値は addedTokens 降順。 */
export function toolCosts(session) {
  const by = new Map();
  const get = (name) => {
    let t = by.get(name);
    if (!t) by.set(name, (t = { tool: name, uses: 0, addedTokens: 0 }));
    return t;
  };
  for (const p of session.prompts) {
    const calls = mainCalls(p);
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const names = Array.isArray(c.tools) && c.tools.length ? c.tools : [];
      for (const n of names) get(n).uses++;
      const added = c.usage.input + c.usage.cacheCreation;
      if (i === 0) {
        get('(指示+システム)').addedTokens += added;
        continue;
      }
      const prevTools = Array.isArray(calls[i - 1].tools) && calls[i - 1].tools.length ? calls[i - 1].tools : null;
      if (!prevTools) {
        get('(応答のみ)').addedTokens += added;
      } else {
        for (const n of prevTools) get(n).addedTokens += added / prevTools.length;
      }
    }
  }
  const rows = [...by.values()].map((t) => ({ ...t, addedTokens: Math.round(t.addedTokens) }));
  rows.sort((a, b) => b.addedTokens - a.addedTokens);
  return rows;
}

function promptRow(p) {
  const calls = mainCalls(p);
  const last = calls[calls.length - 1];
  return {
    index: p.index,
    kind: p.kind,
    timestamp: p.timestamp,
    text: p.text.slice(0, 80),
    apiCalls: p.apiCalls,
    toolUses: p.toolUses,
    sidechainCalls: p.sidechainCalls,
    usage: p.usage,
    contextEnd: last ? contextTokens(last) : null,
  };
}

/**
 * @param {object} session 解決済みセッション
 * @param {{top?: number, window?: number, env?: object}} [opts]
 */
export function buildReport(session, opts = {}) {
  const top = opts.top ?? 5;
  let lastCall = null;
  for (const p of session.prompts) {
    const calls = mainCalls(p);
    if (calls.length) lastCall = calls[calls.length - 1];
  }
  const model = lastCall ? lastCall.model : null;
  const windowTokens = opts.window || contextWindowFor(model, opts.env);
  const lastTokens = lastCall ? contextTokens(lastCall) : 0;
  const rows = session.prompts.map(promptRow);
  const sidechainTokens = session.prompts.reduce((n, p) => n + p.calls.filter((c) => c.sidechain).reduce((m, c) => m + c.usage.total, 0), 0);
  const report = {
    session: {
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      prompts: session.prompts.length,
      apiCalls: session.apiCalls,
      toolUses: session.prompts.reduce((n, p) => n + p.toolUses, 0),
      usage: session.usage,
      sidechainTokens,
      models: session.models,
    },
    context: { lastTokens, windowTokens, pct: windowTokens ? Math.round((lastTokens / windowTokens) * 100) : null, model, estimated: true },
    prompts: rows,
    top: [...rows].sort((a, b) => b.usage.total - a.usage.total).slice(0, top),
    tools: toolCosts(session),
    hints: [],
  };
  report.hints = hints(report);
  return report;
}

/** 数値から行動提案を作る(閾値は経験則)。 */
export function hints(report) {
  const h = [];
  const { context, session, tools } = report;
  if (context.pct !== null && context.pct >= 70) {
    h.push(`コンテキストが推定 ${context.pct}%(${fmt(context.lastTokens)} / ${fmt(context.windowTokens)})。区切りの良いところで /compact するか、残りの作業を別セッションに分ける`);
  }
  const u = session.usage;
  if (u.total > 0 && u.cacheRead / u.total >= 0.85) {
    h.push(`消費の ${Math.round((u.cacheRead / u.total) * 100)}% がキャッシュ読取 = 同じ文脈の再送。API 呼出(ツール往復)の回数を減らすほど効く: 独立した読み取り・コマンドは 1 回にまとめ、探索はサブエージェントへ委任する`);
  }
  const added = tools.reduce((n, t) => n + t.addedTokens, 0);
  const topTool = tools.find((t) => !t.tool.startsWith('('));
  if (topTool && added > 0 && topTool.addedTokens / added >= 0.2) {
    h.push(`文脈を最も増やしたツールは ${topTool.tool}(概算 ${fmt(topTool.addedTokens)} トークン・${topTool.uses} 回・全追加の ${Math.round((topTool.addedTokens / added) * 100)}%)。大きなファイルは範囲指定で読む / コマンド出力は head・grep で絞る / 同じ内容を二度読まない`);
  }
  const heavy = report.top[0];
  if (heavy && session.prompts > 1 && heavy.usage.total / Math.max(1, u.total) >= 0.5) {
    h.push(`指示 #${heavy.index} だけで合計の ${Math.round((heavy.usage.total / u.total) * 100)}%(API ${heavy.apiCalls} 回・ツール ${heavy.toolUses} 回)。大きな作業は計画 → 一括実行に分け、途中の調査はサブエージェントに切り出す`);
  }
  if (session.sidechainTokens > 0) {
    h.push(`サブエージェント側の消費 ${fmt(session.sidechainTokens)} トークンは親のコンテキストを増やしていない(委任は文脈を守る)`);
  }
  if (h.length === 0) h.push('目立った偏りなし。このまま継続してよい');
  return h;
}

export function fmt(n) {
  if (n === null || n === undefined) return '-';
  return Math.round(n).toLocaleString('en-US');
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function hhmm(ts) {
  return ts ? ts.slice(11, 16) : '-';
}

export function renderMarkdown(r) {
  const s = r.session;
  const u = s.usage;
  const out = [];
  out.push(`# トークン消費レポート: ${s.title} (${s.sessionId})`);
  out.push('');
  out.push(`- cwd: ${s.cwd || '-'} / 期間: ${s.startedAt || '-'} → ${s.endedAt || '-'}`);
  out.push(`- 指示 ${s.prompts} 件 / API 呼出 ${s.apiCalls} 回 / ツール呼出 ${s.toolUses} 回 / モデル: ${Object.keys(s.models).join(', ') || '-'}`);
  out.push(`- 合計 ${fmt(u.total)} トークン(入力 ${fmt(u.input)} / キャッシュ作成 ${fmt(u.cacheCreation)} / キャッシュ読取 ${fmt(u.cacheRead)} / 出力 ${fmt(u.output)})${s.sidechainTokens ? ` うちサブエージェント ${fmt(s.sidechainTokens)}` : ''}`);
  out.push(`- 現在のコンテキスト(推定): ${fmt(r.context.lastTokens)} / ${fmt(r.context.windowTokens)} トークン(${r.context.pct ?? '-'}%)`);
  out.push('');
  out.push('## 提案');
  for (const h of r.hints) out.push(`- ${h}`);
  out.push('');
  out.push(`## 消費の多い指示(上位 ${r.top.length})`);
  out.push('| # | 時刻 | 指示 | API | ツール | 合計 | 出力 | 文脈終端 |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const p of r.top) out.push(`| ${p.index} | ${hhmm(p.timestamp)} | ${cell(p.text.slice(0, 60))} | ${p.apiCalls} | ${p.toolUses} | ${fmt(p.usage.total)} | ${fmt(p.usage.output)} | ${fmt(p.contextEnd)} |`);
  out.push('');
  out.push('## ツール別の文脈追加(概算)');
  const added = r.tools.reduce((n, t) => n + t.addedTokens, 0);
  out.push('| ツール | 回数 | 追加トークン | 比率 |');
  out.push('|---|---|---|---|');
  for (const t of r.tools.slice(0, 12)) out.push(`| ${cell(t.tool)} | ${t.uses} | ${fmt(t.addedTokens)} | ${added ? Math.round((t.addedTokens / added) * 100) : 0}% |`);
  out.push('');
  out.push('## 指示の時系列');
  out.push('| # | 時刻 | 種別 | 指示 | API | ツール | 合計 | 文脈終端 |');
  out.push('|---|---|---|---|---|---|---|---|');
  const tail = r.prompts.length > 30 ? r.prompts.slice(-30) : r.prompts;
  if (tail.length < r.prompts.length) out.push(`| … | | | (先頭 ${r.prompts.length - tail.length} 件省略) | | | | |`);
  for (const p of tail) out.push(`| ${p.index} | ${hhmm(p.timestamp)} | ${p.kind} | ${cell(p.text.slice(0, 50))} | ${p.apiCalls} | ${p.toolUses} | ${fmt(p.usage.total)} | ${fmt(p.contextEnd)} |`);
  out.push('');
  out.push('> 推定の根拠: コンテキスト = 最後の API 呼出の input + cache_read + cache_creation。窓の大きさはモデル名からの推定(AIAD_CONTEXT_WINDOW で上書き)。ツール別の追加は「次の呼出で新たに入力されたトークン」を直前の呼出のツールへ按分した概算。');
  return out.join('\n');
}

/** セッション一覧(--list 用)。endedAt 降順。 */
export function listRows(sessions) {
  return sessions
    .filter((s) => !s.parentSessionId)
    .map((s) => ({ sessionId: s.sessionId, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, prompts: s.prompts.length, apiCalls: s.apiCalls, total: s.usage.total, output: s.usage.output }))
    .sort((a, b) => ((a.endedAt || '') > (b.endedAt || '') ? -1 : (a.endedAt || '') < (b.endedAt || '') ? 1 : 0));
}

export function renderListMarkdown(rows, projectKey) {
  const out = [`# セッション一覧: ${projectKey || '(全プロジェクト)'}(${rows.length} 件・新しい順)`, '', '| 最終更新 | セッション | 指示 | API | 合計 | 出力 | 題名 |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${(r.endedAt || '-').slice(0, 16)} | ${r.sessionId} | ${r.prompts} | ${r.apiCalls} | ${fmt(r.total)} | ${fmt(r.output)} | ${cell(String(r.title || '').slice(0, 40))} |`);
  return out.join('\n');
}
