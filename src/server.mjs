// 依存ゼロの HTTP サーバ。静的 UI(public/)と JSON API を同一ポートで配信する。
//   GET /api/overview                       プロジェクト別集計 + 全体合計
//   GET /api/prompts?project=&limit=&sort=  指示一覧(トークン降順など)
//   GET /api/sessions?project=              セッション一覧
//   GET /api/session?id=                    1 セッションの指示別内訳
//   GET /api/breakdown?project=&since=      キャッシュ作成の原因 / キャッシュ読取の構成
//   GET /api/models?project=&since=         モデル別の内訳(call 単位)
//   GET /api/timeseries?project=&since=&bucket=day|week&tz=  日別/週別の推移(tz = UTC との差(分)。ブラウザの getTimezoneOffset)
//   GET /api/report?session=&top=           AI エージェント向けレポート(コンテキスト推定・ツール別追加・提案)
//   POST /api/rescan                        キャッシュを使って再走査
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TranscriptStore, summarizeProjects, sessionSummary, flattenPrompts, promptView } from './scan.mjs';
import { emptyUsage, addUsage } from './parse.mjs';
import { buildReport } from './report.mjs';
import { analyzeSession, emptyBreakdown, addBreakdown, causeRows, componentRows } from './attribution.mjs';
import { modelRows } from './models.mjs';
import { PRICING_UPDATED } from './pricing.mjs';
import { timeseries } from './timeseries.mjs';

// セッションごとのキャッシュ内訳(since 無し)はセッションオブジェクトに紐づけてメモ化する(再走査で作り直される)
const analysisCache = new WeakMap();
function analysisFor(s) {
  let a = analysisCache.get(s);
  if (!a) analysisCache.set(s, (a = analyzeSession(s)));
  return a;
}
function breakdownView(b) {
  return { calls: b.calls, cacheCreation: b.cacheCreation, cacheRead: b.cacheRead, modelSwitches: b.modelSwitches, causes: causeRows(b), components: componentRows(b) };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const store = new TranscriptStore();
let sessions = [];
let scanning = null;

async function rescan() {
  if (!scanning) scanning = store.scan().then((s) => (sessions = s)).finally(() => (scanning = null));
  return scanning;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function filterByProject(list, project) {
  return project ? list.filter((x) => x.projectKey === project) : list;
}

async function api(url, req, res) {
  if (url.pathname === '/api/rescan' && req.method === 'POST') {
    await rescan();
    return json(res, 200, { ok: true, scan: store.lastScan });
  }
  if (sessions.length === 0 && !store.lastScan) await rescan();
  const project = url.searchParams.get('project') || '';

  if (url.pathname === '/api/overview') {
    const projects = summarizeProjects(sessions);
    const totals = { sessions: sessions.length, prompts: 0, apiCalls: 0, usage: emptyUsage(), cost: 0, unpricedCalls: 0 };
    for (const p of projects) {
      totals.prompts += p.prompts;
      totals.apiCalls += p.apiCalls;
      addUsage(totals.usage, p.usage);
      totals.cost += p.cost;
      totals.unpricedCalls += p.unpricedCalls;
    }
    return json(res, 200, { projectsDir: store.projectsDir, scan: store.lastScan, pricing: { updated: PRICING_UPDATED }, totals, projects });
  }
  if (url.pathname === '/api/prompts') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 1000);
    const sort = url.searchParams.get('sort') || 'total';
    const since = url.searchParams.get('since') || '';
    const scoped = filterByProject(sessions, project);
    const extrasBySession = new Map(scoped.map((s) => [s.sessionId, analysisFor(s).promptExtras]));
    let list = flattenPrompts(scoped).map((p) => ({ ...p, ...(extrasBySession.get(p.sessionId)?.[p.index] || { modelSwitches: 0, switchTokens: 0 }) }));
    if (since) list = list.filter((p) => p.timestamp && p.timestamp >= since);
    const key = { total: (p) => p.usage.total, output: (p) => p.usage.output, recent: (p) => p.timestamp || '' }[sort] || ((p) => p.usage.total);
    list.sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
    return json(res, 200, { count: list.length, prompts: list.slice(0, limit) });
  }
  if (url.pathname === '/api/sessions') {
    const list = filterByProject(sessions, project).map(sessionSummary).sort((a, b) => (b.endedAt || '') < (a.endedAt || '') ? -1 : 1);
    return json(res, 200, { sessions: list });
  }
  if (url.pathname === '/api/session') {
    const id = url.searchParams.get('id');
    const s = sessions.find((x) => x.sessionId === id);
    if (!s) return json(res, 404, { error: 'session not found' });
    const a = analysisFor(s);
    const promptList = s.prompts.map((p) => ({ ...promptView(p), ...(a.promptExtras[p.index] || { modelSwitches: 0, switchTokens: 0 }) }));
    return json(res, 200, { ...sessionSummary(s), promptList, modelRows: modelRows([s]), breakdown: { ...breakdownView(a), switches: a.switches } });
  }
  if (url.pathname === '/api/breakdown') {
    // キャッシュ作成の原因 / キャッシュ読取の構成(project・since で絞る)
    const since = url.searchParams.get('since') || '';
    const total = emptyBreakdown();
    for (const s of filterByProject(sessions, project)) addBreakdown(total, since ? analyzeSession(s, { since }) : analysisFor(s));
    return json(res, 200, breakdownView(total));
  }
  if (url.pathname === '/api/models') {
    // モデル別の内訳(project・since で絞る)。call 単位で集計する(src/models.mjs)
    const since = url.searchParams.get('since') || '';
    const rows = modelRows(filterByProject(sessions, project), { since });
    return json(res, 200, { pricing: { updated: PRICING_UPDATED }, models: rows });
  }
  if (url.pathname === '/api/timeseries') {
    const since = url.searchParams.get('since') || '';
    const bucket = url.searchParams.get('bucket') === 'week' ? 'week' : 'day';
    const tz = Number(url.searchParams.get('tz'));
    const r = timeseries(filterByProject(sessions, project), { since, bucket, tzOffsetMin: Number.isFinite(tz) ? tz : 0 });
    return json(res, 200, { pricing: { updated: PRICING_UPDATED }, ...r });
  }
  if (url.pathname === '/api/report') {
    // AI エージェント向け: 1 セッションの消費・コンテキスト推定・ツール別の文脈追加・提案(src/report.mjs)
    const id = url.searchParams.get('session');
    const s = sessions.find((x) => x.sessionId === id);
    if (!s) return json(res, 404, { error: 'session not found' });
    return json(res, 200, buildReport(s, { top: Math.min(Number(url.searchParams.get('top') || 5), 100) }));
  }
  return json(res, 404, { error: 'not found' });
}

async function serveStatic(url, res) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(url, req, res);
    else await serveStatic(url, res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Agent Dashboard: http://${HOST}:${PORT}/  (projects: ${store.projectsDir})`);
  rescan().then(() => console.log(`initial scan: ${store.lastScan.files} files in ${store.lastScan.ms} ms`)).catch((e) => console.error('scan failed', e));
});
