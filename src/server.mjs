// 依存ゼロの HTTP サーバ。静的 UI(public/)と JSON API を同一ポートで配信する。
//   GET /api/overview                       プロジェクト別集計 + 全体合計
//   GET /api/prompts?project=&limit=&sort=  指示一覧(トークン降順など)
//   GET /api/sessions?project=              セッション一覧
//   GET /api/session?id=                    1 セッションの指示別内訳
//   POST /api/rescan                        キャッシュを使って再走査
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TranscriptStore, summarizeProjects, sessionSummary, flattenPrompts, promptView } from './scan.mjs';
import { emptyUsage, addUsage } from './parse.mjs';

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
    const totals = { sessions: sessions.length, prompts: 0, apiCalls: 0, usage: emptyUsage() };
    for (const p of projects) {
      totals.prompts += p.prompts;
      totals.apiCalls += p.apiCalls;
      addUsage(totals.usage, p.usage);
    }
    return json(res, 200, { projectsDir: store.projectsDir, scan: store.lastScan, totals, projects });
  }
  if (url.pathname === '/api/prompts') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 1000);
    const sort = url.searchParams.get('sort') || 'total';
    const since = url.searchParams.get('since') || '';
    let list = flattenPrompts(filterByProject(sessions, project));
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
    return json(res, 200, { ...sessionSummary(s), promptList: s.prompts.map(promptView) });
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
