/* ダッシュボードのクライアント。API から JSON を取り、横棒(積み上げ)と表を描く。
   画面は固定高のシェル(上部バー / 左サイドバー / KPI 帯 + タブ + ペイン)で、ページはスクロールしない。
   プロジェクトの選択は左サイドバー(検索・ソート付き)が唯一の入口で、全グラフのフィルタを兼ねる。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const SERIES = [
    { key: 'cacheRead', label: 'キャッシュ読取', cls: 'cacheRead' },
    { key: 'cacheCreation', label: 'キャッシュ作成', cls: 'cacheCreation' },
    { key: 'input', label: '入力', cls: 'input' },
    { key: 'output', label: '出力', cls: 'output' },
  ];
  const PAGE = 20; // 「もっと見る」1 回で増える件数
  const TABS = ['prompts', 'trend', 'breakdown', 'models', 'sessions', 'detail'];
  const state = {
    project: '', sinceDays: '', sort: 'total', limit: PAGE, extra: 0, overview: null,
    projQuery: '', projSort: 'total', tab: 'prompts', prevTab: 'prompts', bucket: 'day', metric: 'tokens', trend: null, split: true, detailSession: null,
  };

  const fmt = (n) => {
    if (n == null) return '–';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    return String(n);
  };
  const full = (n) => (n == null ? '–' : n.toLocaleString('ja-JP'));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '');
  // USD 概算の表示(src/pricing.mjs の formatUsd と同じ刻み)
  const usd = (x) => (x >= 100 ? '$' + Math.round(x).toLocaleString('en-US') : x >= 1 ? '$' + x.toFixed(2) : x > 0 ? '$' + x.toFixed(3) : '$0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const projName = (key, cwd) => (cwd ? cwd.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : key);

  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  }
  function sinceISO() {
    if (!state.sinceDays) return '';
    const d = new Date();
    if (state.sinceDays === '1') d.setHours(0, 0, 0, 0);
    else d.setDate(d.getDate() - Number(state.sinceDays));
    return d.toISOString();
  }

  // ---- density (文字サイズ) ---------------------------------------------
  function applyDensity(name) {
    document.documentElement.dataset.density = name;
    try { localStorage.setItem('aiad-density', name); } catch { /* 保存できなくても描画はする */ }
    for (const b of document.querySelectorAll('.topctl .group button')) b.setAttribute('aria-pressed', String(b.dataset.density === name));
  }

  // ---- tabs ----------------------------------------------------------------
  function showTab(name) {
    if (state.tab !== name) state.prevTab = state.tab;
    state.tab = name;
    for (const t of TABS) {
      const on = t === name;
      $('tab-' + t).setAttribute('aria-selected', String(on));
      $('pane-' + t).hidden = !on;
    }
    $('pane-' + name).scrollTop = 0;
  }

  // ---- tooltip -------------------------------------------------------------
  const tip = $('tooltip');
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    moveTip(e);
  }
  function moveTip(e) {
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }
  function attachTip(el, html) {
    el.addEventListener('mouseenter', (e) => showTip(e, html));
    el.addEventListener('mousemove', moveTip);
    el.addEventListener('mouseleave', hideTip);
  }
  function usageTipHTML(title, u, extra = '') {
    const rows = SERIES.map((s) => `<div class="row"><span><i class="sw seg ${s.cls}"></i>${s.label}</span><span>${full(u[s.key])}</span></div>`).join('');
    return `<div class="tt-title">${esc(title)}</div>${rows}<div class="row"><span>合計</span><span><b>${full(u.total)}</b></span></div>${extra}`;
  }

  // ---- 指示の棒を、キャッシュ内訳タブと同じ分類で塗り分ける -------------------------------
  // 読取 = 文脈に積まれた内容の由来(初期コンテキスト / 指示 / アシスタント出力 / ツール結果 / 要約)
  // 作成 = 作成の原因(初回 / 通常の追加 / モデル切替 / アイドル後 / 圧縮)。
  // 分類は主系列だけが対象なので、サブエージェント分(= usage との差)は別色の「分類外」にする。
  const KNOWN_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent'];
  const READ_PARTS = [
    { key: 'baseline', label: '初期コンテキスト', cls: 'rd-baseline' },
    { key: 'prompt', label: '指示(+注入文脈)', cls: 'rd-prompt' },
    { key: 'assistantOutput', label: 'アシスタントの出力', cls: 'rd-assistantOutput' },
    ...KNOWN_TOOLS.map((t) => ({ key: 'tool:' + t, label: 'ツール結果: ' + t, cls: 'rd-tool-' + t })),
    { key: 'tool:*', label: 'ツール結果: 他', cls: 'rd-tool-other' },
    { key: 'compactedSummary', label: '圧縮後の要約', cls: 'rd-compactedSummary' },
    { key: 'other', label: 'その他', cls: 'rd-other' },
    { key: 'sub', label: 'サブエージェント(分類外)', cls: 'rd-sub' },
  ];
  const CREATE_PARTS = [
    { key: 'first', label: '初回(初期コンテキスト)', cls: 'cr-first' },
    { key: 'growth', label: '通常の追加', cls: 'cr-growth' },
    { key: 'modelSwitch', label: 'モデル切替', cls: 'cr-modelSwitch' },
    { key: 'idleLong', label: 'アイドル後(60 分超)', cls: 'cr-idleLong' },
    { key: 'idleShort', label: 'アイドル後(5〜60 分)', cls: 'cr-idleShort' },
    { key: 'compaction', label: '圧縮(/compact 等)', cls: 'cr-compaction' },
    { key: 'sub', label: 'サブエージェント(分類外)', cls: 'cr-sub' },
  ];
  const sumOf = (m) => Object.values(m).reduce((a, v) => a + v, 0);
  /** 指示(または call 集計)の API 値から {read, creation} の部品別トークンを作る。分類データが無ければ null。 */
  function partsOf(p) {
    if (!p.read && !p.creation) return null;
    const read = {};
    const creation = {};
    for (const [k, v] of Object.entries(p.read || {})) {
      let key = k;
      if (k.startsWith('tool:')) {
        const n = k.slice(5) === 'Task' ? 'Agent' : k.slice(5);
        key = KNOWN_TOOLS.includes(n) ? 'tool:' + n : 'tool:*';
      }
      read[key] = (read[key] || 0) + v;
    }
    for (const [k, v] of Object.entries(p.creation || {})) creation[k] = (creation[k] || 0) + v;
    read.sub = Math.max(0, p.usage.cacheRead - sumOf(read));
    creation.sub = Math.max(0, p.usage.cacheCreation - sumOf(creation));
    return { read, creation };
  }
  /** 棒の部品の並び: 読取 → 作成 → 入力 → 出力。 */
  function barSegments(u, parts) {
    const segs = [];
    for (const d of READ_PARTS) if (parts.read[d.key] > 0) segs.push({ cls: d.cls, value: parts.read[d.key] });
    for (const d of CREATE_PARTS) if (parts.creation[d.key] > 0) segs.push({ cls: d.cls, value: parts.creation[d.key] });
    if (u.input > 0) segs.push({ cls: 'input', value: u.input });
    if (u.output > 0) segs.push({ cls: 'output', value: u.output });
    return segs;
  }
  function splitTipHTML(title, u, parts, extra = '') {
    const rows = (defs, m) => defs.filter((d) => m[d.key] > 0).map((d) => `<div class="row"><span><i class="sw seg ${d.cls}"></i>${d.label}</span><span>${full(m[d.key])}</span></div>`).join('');
    const sec = (label, n) => `<div class="tt-sec"><span>${label}</span><span>${full(n)}</span></div>`;
    return `<div class="tt-title">${esc(title)}</div>`
      + sec('キャッシュ読取', u.cacheRead) + rows(READ_PARTS, parts.read)
      + sec('キャッシュ作成', u.cacheCreation) + rows(CREATE_PARTS, parts.creation)
      + `<div class="tt-sec"><span>入力・出力</span><span></span></div>`
      + `<div class="row"><span><i class="sw seg input"></i>入力</span><span>${full(u.input)}</span></div>`
      + `<div class="row"><span><i class="sw seg output"></i>出力</span><span>${full(u.output)}</span></div>`
      + `<div class="row"><span>合計</span><span><b>${full(u.total)}</b></span></div>${extra}`;
  }
  function splitLegendHTML() {
    const grp = (title, defs) => `<div class="lg-row"><span class="lg-h">${title}</span>${defs.map((d) => `<span><i class="sw seg ${d.cls}"></i>${d.label}</span>`).join('')}</div>`;
    return grp('キャッシュ読取(文脈の由来)', READ_PARTS) + grp('キャッシュ作成(原因)', CREATE_PARTS)
      + `<div class="lg-row"><span class="lg-h">その他</span><span><i class="sw seg input"></i>入力</span><span><i class="sw seg output"></i>出力</span></div>`;
  }

  // ---- bar rows (上段ラベル / 下段 棒 + 値) ----------------------------------
  function stackedRow(label, sub, u, max, tipTitle, tipExtra, onClick, p) {
    const lbl = document.createElement('div');
    lbl.className = 'lbl' + (onClick ? ' clickable' : '');
    lbl.innerHTML = esc(label) + (sub ? `<small>${esc(sub)}</small>` : '');
    lbl.title = label;
    if (onClick) lbl.addEventListener('click', onClick);
    const track = document.createElement('div');
    track.className = 'track';
    const width = max > 0 ? (u.total / max) * 100 : 0;
    track.style.width = Math.max(width, u.total > 0 ? 0.6 : 0) + '%';
    // 分類データ(指示ごとの作成の原因・読取の構成)があり、内訳表示が有効なら細分化して塗る
    const parts = state.split && p ? partsOf(p) : null;
    if (parts) {
      track.classList.add('split');
      for (const s of barSegments(u, parts)) {
        if (s.value / u.total < 0.0008) continue; // 画素にならない細片は描かない(合計の 0.08% 未満)
        const seg = document.createElement('div');
        seg.className = 'seg ' + s.cls;
        seg.style.flex = `${s.value} 0 0`;
        track.appendChild(seg);
      }
      attachTip(track, splitTipHTML(tipTitle || label, u, parts, tipExtra));
    } else {
      for (const s of SERIES) {
        if (!u[s.key]) continue;
        const seg = document.createElement('div');
        seg.className = 'seg ' + s.cls;
        seg.style.flex = `${u[s.key]} 0 0`;
        track.appendChild(seg);
      }
      attachTip(track, usageTipHTML(tipTitle || label, u, tipExtra));
    }
    const val = document.createElement('div');
    val.className = 'val';
    val.textContent = fmt(u.total);
    return [lbl, track, val];
  }
  // 単一系列の横棒(順序付きカテゴリ: 原因・構成)
  function singleRow(label, sub, tokens, max, tipHTML) {
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.innerHTML = esc(label) + (sub ? `<small>${esc(sub)}</small>` : '');
    const track = document.createElement('div');
    track.className = 'track';
    track.style.width = (max > 0 ? Math.max((tokens / max) * 100, tokens > 0 ? 0.6 : 0) : 0) + '%';
    const seg = document.createElement('div');
    seg.className = 'seg';
    track.appendChild(seg);
    if (tipHTML) attachTip(track, tipHTML);
    const val = document.createElement('div');
    val.className = 'val';
    val.textContent = fmt(tokens);
    return [lbl, track, val];
  }
  function renderBars(container, rows) {
    container.innerHTML = '';
    if (!rows.length) { container.innerHTML = '<div class="empty">データがありません</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const els of rows) els.forEach((el) => frag.appendChild(el));
    container.appendChild(frag);
  }
  function usageTable(headers, rows) {
    const cls = (h) => [h.num ? 'num' : '', h.total ? 'total' : ''].filter(Boolean).join(' ');
    const th = headers.map((h) => `<th class="${cls(h)}">${esc(h.label)}</th>`).join('');
    const body = rows.map((r) => '<tr>' + r.map((c, i) => `<td class="${cls(headers[i])}">${esc(c)}</td>`).join('') + '</tr>').join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
  }
  const usageCols = [{ label: 'キャッシュ読取', num: true }, { label: 'キャッシュ作成', num: true }, { label: '入力', num: true }, { label: '出力', num: true }, { label: '合計', num: true, total: true }];
  const usageCells = (u) => [full(u.cacheRead), full(u.cacheCreation), full(u.input), full(u.output), full(u.total)];

  // ---- sidebar: プロジェクト一覧(検索・ソート) -----------------------------
  const PROJ_SORT = {
    total: (a, b) => b.usage.total - a.usage.total,
    recent: (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')),
    name: (a, b) => projName(a.key, a.cwd).localeCompare(projName(b.key, b.cwd), 'ja'),
    sessions: (a, b) => b.sessions - a.sessions || b.usage.total - a.usage.total,
  };
  function projRow({ key, label, value, meta, usage, max, title }) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pj';
    b.dataset.key = key;
    b.setAttribute('aria-pressed', String(state.project === key));
    b.title = title || label;
    const segs = SERIES.filter((s) => usage[s.key]).map((s) => `<i class="seg ${s.cls}" style="flex:${usage[s.key]} 0 0"></i>`).join('');
    const w = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1.5 : 0) : 0;
    b.innerHTML = `<span class="top"><span class="nm">${esc(label)}</span><span class="vl">${fmt(value)}</span></span>`
      + `<span class="mt">${esc(meta)}</span>`
      + `<span class="mini"><span class="fill" style="width:${w}%">${segs}</span></span>`;
    b.addEventListener('click', () => {
      if (state.project === key) return;
      state.project = key;
      renderSidebar();
      onFilterChange();
    });
    attachTip(b, usageTipHTML(title || label, usage));
    li.appendChild(b);
    return li;
  }
  function renderSidebar() {
    const o = state.overview;
    if (!o) return;
    const q = state.projQuery.trim().toLowerCase();
    const hit = (p) => !q || [projName(p.key, p.cwd), p.cwd || '', p.key].some((s) => s.toLowerCase().includes(q));
    const list = o.projects.filter(hit).sort(PROJ_SORT[state.projSort] || PROJ_SORT.total);
    $('projCount').textContent = q ? `${list.length} / ${o.projects.length}` : String(o.projects.length);
    const max = Math.max(0, ...o.projects.map((p) => p.usage.total));
    const ul = $('projList');
    ul.innerHTML = '';
    ul.appendChild(projRow({
      key: '', label: 'すべてのプロジェクト', value: o.totals.usage.total, usage: o.totals.usage,
      meta: `${full(o.totals.sessions)} セッション · 指示 ${full(o.totals.prompts)} 件`,
      max: o.totals.usage.total, title: o.projectsDir,
    }));
    for (const p of list) {
      ul.appendChild(projRow({
        key: p.key, label: projName(p.key, p.cwd), value: p.usage.total, usage: p.usage,
        meta: `${day(p.lastActivity)} · ${full(p.sessions)} セッション · 指示 ${full(p.prompts)} 件`,
        max, title: p.cwd || p.key,
      }));
    }
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'side-empty';
      li.textContent = '該当するプロジェクトがありません';
      ul.appendChild(li);
    }
  }

  // ---- sections -----------------------------------------------------------
  function renderLegend() {
    const html = SERIES.map((s) => `<span><i class="sw seg ${s.cls}"></i>${s.label}</span>`).join('');
    const promptLegend = state.split ? splitLegendHTML() : html;
    for (const id of ['legend', 'detailLegend']) {
      $(id).innerHTML = promptLegend;
      $(id).classList.toggle('split', state.split);
    }
    $('modelLegend').innerHTML = html;
    $('trendLegend').innerHTML = html;
  }
  // 単価テーブルの更新日と、単価未登録のモデルがあればその呼出数
  function costNote(unpriced) {
    const upd = state.overview && state.overview.pricing ? state.overview.pricing.updated : '';
    return `単価 ${upd} 時点の概算` + (unpriced ? ` · 単価未登録 ${full(unpriced)} 回は除外` : '');
  }
  function renderKpis(totals, promptsShown, scopeLabel) {
    const u = totals.usage;
    const items = [
      ['合計トークン' + (scopeLabel ? ` — ${scopeLabel}` : ''), fmt(u.total), `${full(u.total)} / API ${full(totals.apiCalls)} 回`, 'lead'],
      ['出力トークン', fmt(u.output), '応答として生成された分'],
      ['キャッシュ読取', fmt(u.cacheRead), (u.total ? Math.round((u.cacheRead / u.total) * 100) : 0) + '% が再利用'],
      ['キャッシュ作成', fmt(u.cacheCreation), '文脈を積み直した分'],
      ['概算コスト', usd(totals.cost || 0), costNote(totals.unpricedCalls)],
      ['指示', full(totals.prompts), promptsShown != null ? `条件に合う ${full(promptsShown)} 件` : ''],
      ['セッション', full(totals.sessions), ''],
    ];
    $('kpis').innerHTML = items.map(([l, v, n, cls]) =>
      `<div class="kpi ${cls || ''}"><div class="l" title="${esc(l)}">${esc(l)}</div><div class="v">${v}</div><div class="n">${esc(n)}</div></div>`).join('');
  }
  async function loadOverview() {
    const o = await getJSON('/api/overview');
    state.overview = o;
    $('scanMeta').textContent = `${o.projectsDir} — ${o.scan ? `${o.scan.files} ファイル / ${o.scan.ms} ms` : '走査中'}`;
    // 再走査で消えたプロジェクトが選択されたままになるのを防ぐ
    if (state.project && !o.projects.some((p) => p.key === state.project)) state.project = '';
    renderSidebar();
    return o;
  }
  async function loadPrompts() {
    const limit = state.limit + state.extra;
    const q = new URLSearchParams({ project: state.project, sort: state.sort, limit, since: sinceISO() });
    const r = await getJSON('/api/prompts?' + q);
    const max = Math.max(0, ...r.prompts.map((p) => p.usage.total));
    const swText = (p) => (p.modelSwitches ? ` · モデル切替 ${p.modelSwitches} 回(${fmt(p.switchTokens)} 再作成)` : '');
    renderBars($('promptBars'), r.prompts.map((p) => stackedRow(p.text || '(空の指示)', `${when(p.timestamp)} · ${projName(p.projectKey, p.cwd)} · API ${p.apiCalls} 回 · ${usd(p.cost)}${swText(p)}`, p.usage, max, p.text,
      `<div class="row"><span>概算コスト</span><span>${usd(p.cost)}</span></div><div class="row"><span>API 応答</span><span>${full(p.apiCalls)}</span></div><div class="row"><span>ツール呼出</span><span>${full(p.toolUses)}</span></div><div class="row"><span>モデル切替</span><span>${full(p.modelSwitches || 0)} 回</span></div><div class="row"><span>セッション</span><span>${esc(p.sessionTitle || '')}</span></div>`,
      () => openSession(p.sessionId), p)));
    $('promptsTable').innerHTML = usageTable([{ label: '日時' }, { label: '指示' }, { label: 'プロジェクト' }, { label: 'API', num: true }, { label: 'ツール', num: true }, ...usageCols, { label: '概算 USD', num: true }],
      r.prompts.map((p) => [when(p.timestamp), p.text, projName(p.projectKey, p.cwd), full(p.apiCalls), full(p.toolUses), ...usageCells(p.usage), usd(p.cost)]));
    const more = $('moreBtn');
    more.hidden = r.count <= r.prompts.length;
    more.textContent = `もっと見る(${full(r.prompts.length)} / ${full(r.count)} 件)`;
    return r;
  }
  async function loadBreakdown() {
    const q = new URLSearchParams({ project: state.project, since: sinceISO() });
    const b = await getJSON('/api/breakdown?' + q);
    const pct = (x) => Math.round(x * 100) + '%';
    const causes = b.causes.filter((r) => r.calls > 0);
    const maxC = Math.max(0, ...causes.map((r) => r.tokens));
    renderBars($('causeBars'), causes.map((r) => singleRow(r.label, `${pct(r.pct)} · ${full(r.calls)} 回`, r.tokens, maxC, `<div class="tt-title">${esc(r.label)}</div><div class="row"><span>トークン</span><span>${full(r.tokens)}</span></div><div class="row"><span>API 応答</span><span>${full(r.calls)}</span></div>`)));
    $('causeSub').textContent = `キャッシュ作成 ${fmt(b.cacheCreation)} トークンの内訳。モデル切替 ${full(b.modelSwitches.count)} 回で ${fmt(b.modelSwitches.tokens)} を作り直し。`;
    $('causeTable').innerHTML = usageTable([{ label: '原因' }, { label: '回数', num: true }, { label: 'トークン', num: true, total: true }, { label: '比率', num: true }], causes.map((r) => [r.label, full(r.calls), full(r.tokens), pct(r.pct)]));
    const comps = b.components;
    const maxK = Math.max(0, ...comps.map((r) => r.tokens));
    renderBars($('compBars'), comps.map((r) => singleRow(r.label, pct(r.pct), r.tokens, maxK, `<div class="tt-title">${esc(r.label)}</div><div class="row"><span>トークン</span><span>${full(r.tokens)}</span></div>`)));
    $('compSub').textContent = `キャッシュ読取 ${fmt(b.cacheRead)} トークンを「文脈に積まれた内容の由来」で按分した概算(出力は上限側)。`;
    $('compTable').innerHTML = usageTable([{ label: '文脈の由来' }, { label: 'トークン', num: true, total: true }, { label: '比率', num: true }], comps.map((r) => [r.label, full(r.tokens), pct(r.pct)]));
  }
  // モデル別の行(モデルタブとセッション詳細で共用)。比率は合計トークンに対する割合
  const pctText = (x) => (x >= 0.995 ? '100%' : x >= 0.1 ? Math.round(x * 100) + '%' : (x * 100).toFixed(1) + '%');
  function modelBarRows(rows) {
    const max = Math.max(0, ...rows.map((r) => r.usage.total));
    return rows.map((r) => stackedRow(r.model, `${pctText(r.share)} · ${r.unpricedCalls ? '単価未登録' : usd(r.cost)} · API ${full(r.calls)} 回 · ${full(r.sessions)} セッション · ${day(r.firstAt)}〜${day(r.lastAt)}`, r.usage, max, r.model,
      `<div class="row"><span>概算コスト</span><span>${r.unpricedCalls ? '単価未登録' : usd(r.cost)}</span></div><div class="row"><span>API 応答</span><span>${full(r.calls)}</span></div><div class="row"><span>セッション</span><span>${full(r.sessions)}</span></div><div class="row"><span>全体に占める比率</span><span>${pctText(r.share)}</span></div>`));
  }
  const modelCols = [{ label: 'モデル' }, { label: '比率', num: true }, { label: 'API', num: true }, { label: 'セッション', num: true }, ...usageCols, { label: '概算 USD', num: true }];
  const modelCells = (r) => [r.model, pctText(r.share), full(r.calls), full(r.sessions), ...usageCells(r.usage), r.unpricedCalls ? '未登録' : usd(r.cost)];
  async function loadModels() {
    const r = await getJSON('/api/models?' + new URLSearchParams({ project: state.project, since: sinceISO() }));
    renderBars($('modelBars'), modelBarRows(r.models));
    $('modelsTable').innerHTML = usageTable(modelCols, r.models.map(modelCells));
    return r;
  }
  // ---- 推移(日別 / 週別の積み上げ縦棒) ------------------------------------
  const md = (key) => { const [, m, d] = key.split('-'); return Number(m) + '/' + Number(d); };
  const bucketLabel = (key) => md(key) + (state.bucket === 'week' ? ' 週' : '');
  function renderTrend() {
    const t = state.trend;
    if (!t) return;
    const usdMode = state.metric === 'usd';
    const val = (r) => (usdMode ? r.cost : r.usage.total);
    const show = (n) => (usdMode ? usd(n) : fmt(n));
    const chart = $('trendChart');
    $('trendLegend').innerHTML = usdMode ? '<span><i class="sw seg cost"></i>概算 USD</span>' : SERIES.map((s) => `<span><i class="sw seg ${s.cls}"></i>${s.label}</span>`).join('');
    if (!t.rows.length) { chart.innerHTML = '<div class="empty">データがありません</div>'; $('trendTable').innerHTML = ''; return; }
    const max = Math.max(0, ...t.rows.map(val));
    const unit = state.bucket === 'week' ? '週' : '日';
    const total = t.rows.reduce((n, r) => n + val(r), 0);
    chart.innerHTML = `<div class="ts-cap"><span>1${unit}あたり最大 ${show(max)}</span><span>${t.rows.length} ${unit}・合計 ${show(total)}</span></div><div class="ts"></div><div class="ts-axis"></div>`;
    const ts = chart.querySelector('.ts');
    const axis = chart.querySelector('.ts-axis');
    const every = Math.max(1, Math.ceil(t.rows.length / 10));
    t.rows.forEach((r, i) => {
      const col = document.createElement('div');
      col.className = 'tcol';
      const bar = document.createElement('div');
      bar.className = 'tbar';
      const h = max > 0 ? (val(r) / max) * 100 : 0;
      bar.style.height = (val(r) > 0 ? Math.max(h, 0.8) : 0) + '%';
      if (usdMode) {
        const seg = document.createElement('div');
        seg.className = 'seg cost';
        seg.style.flex = '1 1 0';
        bar.appendChild(seg);
      } else {
        for (const s of SERIES) {
          if (!r.usage[s.key]) continue;
          const seg = document.createElement('div');
          seg.className = 'seg ' + s.cls;
          seg.style.flex = `${r.usage[s.key]} 0 0`;
          bar.appendChild(seg);
        }
      }
      col.appendChild(bar);
      const cost = r.unpricedCalls ? `${usd(r.cost)}(未登録 ${r.unpricedCalls} 回を除く)` : usd(r.cost);
      attachTip(col, usageTipHTML(bucketLabel(r.key) + (state.bucket === 'week' ? '(月曜始まり)' : ''), r.usage,
        `<div class="row"><span>概算コスト</span><span>${cost}</span></div><div class="row"><span>API 応答</span><span>${full(r.calls)}</span></div>`));
      ts.appendChild(col);
      const lab = document.createElement('span');
      lab.textContent = i % every === 0 && t.rows.length - i > every / 2 ? md(r.key) : '';
      axis.appendChild(lab);
    });
    $('trendTable').innerHTML = usageTable([{ label: state.bucket === 'week' ? '週(月曜)' : '日' }, { label: 'API', num: true }, ...usageCols, { label: '概算 USD', num: true }],
      t.rows.map((r) => [r.key, full(r.calls), ...usageCells(r.usage), usd(r.cost)]));
    $('trendSub').textContent = `API 応答(call)のタイムスタンプで振り分け。日の区切りはこのブラウザのローカル時刻、週は月曜始まり。${usdMode ? '単価は ' + t.pricing.updated + ' 時点の概算。' : ''}`;
  }
  async function loadTrend() {
    const q = new URLSearchParams({ project: state.project, since: sinceISO(), bucket: state.bucket, tz: String(new Date().getTimezoneOffset()) });
    state.trend = await getJSON('/api/timeseries?' + q);
    renderTrend();
  }
  function setPressed(groupId, attr, value) {
    for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  }
  async function loadSessions() {
    const r = await getJSON('/api/sessions?' + new URLSearchParams({ project: state.project }));
    const list = $('sessionList');
    list.innerHTML = r.sessions.length ? '' : '<div class="empty">セッションがありません</div>';
    for (const s of r.sessions) {
      const el = document.createElement('div');
      el.className = 'sess';
      el.innerHTML = `<div class="t">${esc(s.title)}</div><div class="n">${fmt(s.usage.total)}</div><div class="d">${when(s.startedAt)} · ${projName(s.projectKey, s.cwd)} · 指示 ${s.prompts} 件 · ${usd(s.cost)}${s.error ? ' · 読込エラー' : ''}</div>`;
      el.addEventListener('click', () => openSession(s.sessionId));
      list.appendChild(el);
    }
  }
  async function openSession(id) {
    const s = await getJSON('/api/session?' + new URLSearchParams({ id }));
    state.detailSession = s;
    renderDetail(s);
    $('tab-detail').hidden = false;
    showTab('detail');
  }
  function renderDetail(s) {
    $('detailTitle').textContent = `セッション: ${s.title}`;
    const sw = s.breakdown ? s.breakdown.modelSwitches : { count: 0, tokens: 0 };
    $('detailSub').textContent = `${when(s.startedAt)} 〜 ${when(s.endedAt)} · ${projName(s.projectKey, s.cwd)} · 指示 ${s.prompts} 件 · 合計 ${full(s.usage.total)} トークン · ${usd(s.cost)} · ${Object.keys(s.models).join(', ')}${sw.count ? ` · モデル切替 ${sw.count} 回(${fmt(sw.tokens)} 再作成)` : ''}`;
    const max = Math.max(0, ...s.promptList.map((p) => p.usage.total));
    renderBars($('detailBars'), s.promptList.map((p) => stackedRow(`${p.index + 1}. ${p.text || '(空の指示)'}`, `${when(p.timestamp)} · API ${p.apiCalls} 回 · ツール ${p.toolUses} 回 · ${usd(p.cost)}${p.modelSwitches ? ` · モデル切替 ${p.modelSwitches} 回` : ''}`, p.usage, max, p.text,
      `<div class="row"><span>API 応答</span><span>${full(p.apiCalls)}</span></div><div class="row"><span>ツール呼出</span><span>${full(p.toolUses)}</span></div>`, null, p)));
    const showModels = s.modelRows && s.modelRows.length > 0;
    $('detailModelsHead').hidden = !showModels;
    $('detailModelBars').hidden = !showModels;
    renderBars($('detailModelBars'), showModels ? modelBarRows(s.modelRows) : []);
    $('detailTable').innerHTML = usageTable([{ label: '#', num: true }, { label: '日時' }, { label: '指示' }, { label: 'API', num: true }, { label: 'ツール', num: true }, ...usageCols, { label: '概算 USD', num: true }],
      s.promptList.map((p) => [p.index + 1, when(p.timestamp), p.text, full(p.apiCalls), full(p.toolUses), ...usageCells(p.usage), usd(p.cost)]));
  }

  // ---- wiring -------------------------------------------------------------
  async function onFilterChange(keepExtra = false) {
    state.sinceDays = $('sinceSel').value;
    state.sort = $('sortSel').value;
    state.limit = Number($('limitSel').value);
    if (!keepExtra) state.extra = 0;
    document.body.style.opacity = '0.85';
    try {
      const [, r] = await Promise.all([loadSessions(), loadPrompts(), loadBreakdown(), loadModels(), loadTrend()]);
      const o = state.overview;
      const proj = state.project ? o.projects.find((x) => x.key === state.project) : null;
      const totals = proj ? { sessions: proj.sessions, prompts: proj.prompts, apiCalls: proj.apiCalls, usage: proj.usage, cost: proj.cost, unpricedCalls: proj.unpricedCalls } : o.totals;
      renderKpis(totals, r.count, proj ? projName(proj.key, proj.cwd) : '');
    } finally {
      document.body.style.opacity = '';
    }
  }
  async function refreshAll() {
    try {
      await loadOverview();
      await onFilterChange();
    } catch (e) {
      $('scanMeta').textContent = '読み込みに失敗: ' + e.message;
      console.error(e);
    }
  }
  for (const id of ['sinceSel', 'sortSel', 'limitSel']) $(id).addEventListener('change', () => onFilterChange());
  $('projQuery').addEventListener('input', () => { state.projQuery = $('projQuery').value; renderSidebar(); });
  $('projSort').addEventListener('change', () => { state.projSort = $('projSort').value; renderSidebar(); });
  $('moreBtn').addEventListener('click', () => { state.extra += PAGE; onFilterChange(true); });
  $('rescanBtn').addEventListener('click', async () => {
    $('rescanBtn').disabled = true;
    try { await getJSON('/api/rescan', { method: 'POST' }); await refreshAll(); } finally { $('rescanBtn').disabled = false; }
  });
  for (const b of document.querySelectorAll('.topctl .group button')) b.addEventListener('click', () => applyDensity(b.dataset.density));
  for (const t of TABS) $('tab-' + t).addEventListener('click', () => showTab(t));
  $('splitToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-split]');
    if (!b) return;
    const on = b.dataset.split === '1';
    if (state.split === on) return;
    state.split = on;
    setPressed('splitToggle', 'split', on ? '1' : '0');
    renderLegend();
    loadPrompts();
    if (state.detailSession) renderDetail(state.detailSession);
  });
  $('trendBucket').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bucket]');
    if (!b || state.bucket === b.dataset.bucket) return;
    state.bucket = b.dataset.bucket;
    setPressed('trendBucket', 'bucket', state.bucket);
    loadTrend();
  });
  $('trendMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b || state.metric === b.dataset.metric) return;
    state.metric = b.dataset.metric;
    setPressed('trendMetric', 'metric', state.metric);
    renderTrend();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.toggle[data-target]');
    if (!b) return;
    const t = $(b.dataset.target);
    const bars = t.previousElementSibling; // 表の直前の .bars(ペイン内に複数あっても対応する側だけ切り替える)
    t.hidden = !t.hidden;
    bars.hidden = !t.hidden;
    b.textContent = t.hidden ? '表で見る' : 'グラフで見る';
  });
  $('detailClose').addEventListener('click', () => {
    $('tab-detail').hidden = true;
    showTab(state.prevTab === 'detail' ? 'prompts' : state.prevTab);
  });

  applyDensity(document.documentElement.dataset.density || 'normal');
  renderLegend();
  refreshAll();
})();
