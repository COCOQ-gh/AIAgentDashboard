/* ダッシュボードのクライアント。API から JSON を取り、横棒(積み上げ)と表を描く。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const SERIES = [
    { key: 'cacheRead', label: 'キャッシュ読取', cls: 'cacheRead' },
    { key: 'cacheCreation', label: 'キャッシュ作成', cls: 'cacheCreation' },
    { key: 'input', label: '入力', cls: 'input' },
    { key: 'output', label: '出力', cls: 'output' },
  ];
  const PAGE = 20; // 「もっと見る」1 回で増える件数
  const state = { project: '', sinceDays: '', sort: 'total', limit: PAGE, extra: 0, overview: null };

  const fmt = (n) => {
    if (n == null) return '–';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    return String(n);
  };
  const full = (n) => (n == null ? '–' : n.toLocaleString('ja-JP'));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
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
    for (const b of document.querySelectorAll('.density button')) b.setAttribute('aria-pressed', String(b.dataset.density === name));
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
  function usageTipHTML(title, u, extra = '') {
    const rows = SERIES.map((s) => `<div class="row"><span><i class="sw seg ${s.cls}"></i>${s.label}</span><span>${full(u[s.key])}</span></div>`).join('');
    return `<div class="tt-title">${esc(title)}</div>${rows}<div class="row"><span>合計</span><span><b>${full(u.total)}</b></span></div>${extra}`;
  }

  // ---- bar rows (上段ラベル / 下段 棒 + 値) ----------------------------------
  function stackedRow(label, sub, u, max, tipTitle, tipExtra, onClick) {
    const lbl = document.createElement('div');
    lbl.className = 'lbl' + (onClick ? ' clickable' : '');
    lbl.innerHTML = esc(label) + (sub ? `<small>${esc(sub)}</small>` : '');
    lbl.title = label;
    if (onClick) lbl.addEventListener('click', onClick);
    const track = document.createElement('div');
    track.className = 'track';
    const width = max > 0 ? (u.total / max) * 100 : 0;
    track.style.width = Math.max(width, u.total > 0 ? 0.6 : 0) + '%';
    for (const s of SERIES) {
      if (!u[s.key]) continue;
      const seg = document.createElement('div');
      seg.className = 'seg ' + s.cls;
      seg.style.flex = `${u[s.key]} 0 0`;
      track.appendChild(seg);
    }
    const tipHTML = usageTipHTML(tipTitle || label, u, tipExtra);
    track.addEventListener('mouseenter', (e) => showTip(e, tipHTML));
    track.addEventListener('mousemove', moveTip);
    track.addEventListener('mouseleave', hideTip);
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
    if (tipHTML) {
      track.addEventListener('mouseenter', (e) => showTip(e, tipHTML));
      track.addEventListener('mousemove', moveTip);
      track.addEventListener('mouseleave', hideTip);
    }
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

  // ---- sections -----------------------------------------------------------
  function renderLegend() {
    $('legend').innerHTML = SERIES.map((s) => `<span><i class="sw seg ${s.cls}"></i>${s.label}</span>`).join('');
  }
  function renderTiles(totals, promptsShown, scopeLabel) {
    const u = totals.usage;
    $('hero').innerHTML = `<div class="label">合計トークン${scopeLabel ? ' — ' + esc(scopeLabel) : ''}</div><div class="value">${fmt(u.total)}</div><div class="note">${full(u.total)} トークン / ${full(totals.apiCalls)} API 応答</div>`;
    const tiles = [
      ['出力トークン', fmt(u.output), '応答として生成された分'],
      ['キャッシュ読取', fmt(u.cacheRead), (u.total ? Math.round((u.cacheRead / u.total) * 100) : 0) + '% が再利用'],
      ['指示の数', full(totals.prompts), promptsShown != null ? `条件に合う指示 ${full(promptsShown)} 件` : ''],
      ['セッション', full(totals.sessions), ''],
    ];
    $('tiles').innerHTML = tiles.map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${n}</div></div>`).join('');
  }
  async function loadOverview() {
    const o = await getJSON('/api/overview');
    state.overview = o;
    $('scanMeta').textContent = `${o.projectsDir} — ${o.scan ? `${o.scan.files} ファイル / ${o.scan.ms} ms` : '走査中'}`;
    const sel = $('projectSel');
    const cur = sel.value;
    sel.innerHTML = '<option value="">すべて</option>' + o.projects.map((p) => `<option value="${esc(p.key)}">${esc(projName(p.key, p.cwd))} (${fmt(p.usage.total)})</option>`).join('');
    sel.value = cur;
    const max = Math.max(0, ...o.projects.map((p) => p.usage.total));
    renderBars($('projectBars'), o.projects.map((p) => stackedRow(projName(p.key, p.cwd), `${p.sessions} セッション · 指示 ${p.prompts} 件`, p.usage, max, p.cwd || p.key, `<div class="row"><span>指示</span><span>${full(p.prompts)}</span></div>`, () => { sel.value = p.key; onFilterChange(); })));
    $('projectsTable').innerHTML = usageTable([{ label: 'プロジェクト' }, { label: 'セッション', num: true }, { label: '指示', num: true }, ...usageCols], o.projects.map((p) => [projName(p.key, p.cwd), full(p.sessions), full(p.prompts), ...usageCells(p.usage)]));
    return o;
  }
  async function loadPrompts() {
    const limit = state.limit + state.extra;
    const q = new URLSearchParams({ project: state.project, sort: state.sort, limit, since: sinceISO() });
    const r = await getJSON('/api/prompts?' + q);
    const max = Math.max(0, ...r.prompts.map((p) => p.usage.total));
    const swText = (p) => (p.modelSwitches ? ` · モデル切替 ${p.modelSwitches} 回(${fmt(p.switchTokens)} 再作成)` : '');
    renderBars($('promptBars'), r.prompts.map((p) => stackedRow(p.text || '(空の指示)', `${when(p.timestamp)} · ${projName(p.projectKey, p.cwd)} · API ${p.apiCalls} 回${swText(p)}`, p.usage, max, p.text,
      `<div class="row"><span>API 応答</span><span>${full(p.apiCalls)}</span></div><div class="row"><span>ツール呼出</span><span>${full(p.toolUses)}</span></div><div class="row"><span>モデル切替</span><span>${full(p.modelSwitches || 0)} 回</span></div><div class="row"><span>セッション</span><span>${esc(p.sessionTitle || '')}</span></div>`,
      () => openSession(p.sessionId))));
    $('promptsTable').innerHTML = usageTable([{ label: '日時' }, { label: '指示' }, { label: 'プロジェクト' }, { label: 'API', num: true }, { label: 'ツール', num: true }, ...usageCols],
      r.prompts.map((p) => [when(p.timestamp), p.text, projName(p.projectKey, p.cwd), full(p.apiCalls), full(p.toolUses), ...usageCells(p.usage)]));
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
  async function loadSessions() {
    const r = await getJSON('/api/sessions?' + new URLSearchParams({ project: state.project }));
    const list = $('sessionList');
    list.innerHTML = r.sessions.length ? '' : '<div class="empty">セッションがありません</div>';
    for (const s of r.sessions) {
      const el = document.createElement('div');
      el.className = 'sess';
      el.innerHTML = `<div class="t">${esc(s.title)}</div><div class="n">${fmt(s.usage.total)}</div><div class="d">${when(s.startedAt)} · ${projName(s.projectKey, s.cwd)} · 指示 ${s.prompts} 件${s.error ? ' · 読込エラー' : ''}</div>`;
      el.addEventListener('click', () => openSession(s.sessionId));
      list.appendChild(el);
    }
  }
  async function openSession(id) {
    const s = await getJSON('/api/session?' + new URLSearchParams({ id }));
    $('detailTitle').textContent = `セッション: ${s.title}`;
    const sw = s.breakdown ? s.breakdown.modelSwitches : { count: 0, tokens: 0 };
    $('detailSub').textContent = `${when(s.startedAt)} 〜 ${when(s.endedAt)} · ${projName(s.projectKey, s.cwd)} · 指示 ${s.prompts} 件 · 合計 ${full(s.usage.total)} トークン · ${Object.keys(s.models).join(', ')}${sw.count ? ` · モデル切替 ${sw.count} 回(${fmt(sw.tokens)} 再作成)` : ''}`;
    const max = Math.max(0, ...s.promptList.map((p) => p.usage.total));
    renderBars($('detailBars'), s.promptList.map((p) => stackedRow(`${p.index + 1}. ${p.text || '(空の指示)'}`, `${when(p.timestamp)} · API ${p.apiCalls} 回 · ツール ${p.toolUses} 回${p.modelSwitches ? ` · モデル切替 ${p.modelSwitches} 回` : ''}`, p.usage, max, p.text,
      `<div class="row"><span>API 応答</span><span>${full(p.apiCalls)}</span></div><div class="row"><span>ツール呼出</span><span>${full(p.toolUses)}</span></div>`)));
    $('detailTable').innerHTML = usageTable([{ label: '#', num: true }, { label: '日時' }, { label: '指示' }, { label: 'API', num: true }, { label: 'ツール', num: true }, ...usageCols],
      s.promptList.map((p) => [p.index + 1, when(p.timestamp), p.text, full(p.apiCalls), full(p.toolUses), ...usageCells(p.usage)]));
    const card = $('sessionDetail');
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- wiring -------------------------------------------------------------
  async function onFilterChange(keepExtra = false) {
    state.project = $('projectSel').value;
    state.sinceDays = $('sinceSel').value;
    state.sort = $('sortSel').value;
    state.limit = Number($('limitSel').value);
    if (!keepExtra) state.extra = 0;
    document.body.style.opacity = '0.85';
    try {
      const [, r] = await Promise.all([loadSessions(), loadPrompts(), loadBreakdown()]);
      const o = state.overview;
      const proj = state.project ? o.projects.find((x) => x.key === state.project) : null;
      const totals = proj ? { sessions: proj.sessions, prompts: proj.prompts, apiCalls: proj.apiCalls, usage: proj.usage } : o.totals;
      renderTiles(totals, r.count, proj ? projName(proj.key, proj.cwd) : '');
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
  for (const id of ['projectSel', 'sinceSel', 'sortSel', 'limitSel']) $(id).addEventListener('change', () => onFilterChange());
  $('moreBtn').addEventListener('click', () => { state.extra += PAGE; onFilterChange(true); });
  $('rescanBtn').addEventListener('click', async () => {
    $('rescanBtn').disabled = true;
    try { await getJSON('/api/rescan', { method: 'POST' }); await refreshAll(); } finally { $('rescanBtn').disabled = false; }
  });
  for (const b of document.querySelectorAll('.density button')) b.addEventListener('click', () => applyDensity(b.dataset.density));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.toggle[data-target]');
    if (!b) return;
    const t = $(b.dataset.target);
    const bars = b.closest('figure').querySelector('.bars');
    t.hidden = !t.hidden;
    bars.hidden = !t.hidden;
    b.textContent = t.hidden ? '表で見る' : 'グラフで見る';
  });
  $('detailClose').addEventListener('click', () => { $('sessionDetail').hidden = true; });

  applyDensity(document.documentElement.dataset.density || 'normal');
  renderLegend();
  refreshAll();
})();
