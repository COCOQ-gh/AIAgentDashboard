#!/usr/bin/env node
// AI エージェント向け CLI。サーバ不要で 1 セッションの消費トークンをレポートする。
//
//   node src/cli.mjs [--session <id>] [--cwd <dir>] [--project <key>] [--list]
//                    [--top N] [--format md|json] [--window <tokens>]
//
// 既定: $CLAUDE_CODE_SESSION_ID のセッション(無ければ cwd と同じプロジェクトの最新セッション)。
// 走査は cwd に対応する ~/.claude/projects/<key>/ だけ(フォーク重複排除・サブエージェント合流は同じ)。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TranscriptStore, defaultProjectsDir } from './scan.mjs';
import { projectKeyFromCwd, pickSession, buildReport, renderMarkdown, listRows, renderListMarkdown } from './report.mjs';

function parseArgs(argv) {
  const o = { session: process.env.CLAUDE_CODE_SESSION_ID || null, cwd: process.cwd(), project: null, list: false, top: 5, format: 'md', window: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--session') o.session = next();
    else if (a === '--cwd') o.cwd = next();
    else if (a === '--project') o.project = next();
    else if (a === '--list') o.list = true;
    else if (a === '--latest') o.session = null;
    else if (a === '--top') o.top = Number(next()) || 5;
    else if (a === '--format') o.format = next();
    else if (a === '--window') o.window = Number(next()) || 0;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return o;
}

const HELP = `usage: node src/cli.mjs [--session <id>] [--cwd <dir>] [--project <key>] [--list] [--latest] [--top N] [--format md|json] [--window <tokens>]
  --session   セッション ID(既定: $CLAUDE_CODE_SESSION_ID)
  --latest    環境変数を無視し、cwd と同じプロジェクトの最新セッションを対象にする
  --cwd       プロジェクトを決める作業ディレクトリ(既定: process.cwd())
  --project   ~/.claude/projects/ 配下のディレクトリ名を直接指定(cwd からの導出を上書き)
  --list      対象プロジェクトのセッション一覧を出す
  --top       上位指示の件数(既定 5)
  --format    md(既定)| json
  --window    文脈窓のトークン数(既定: モデル名から推定。AIAD_CONTEXT_WINDOW でも可)`;

async function dirExists(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) return console.log(HELP);
  const projectsDir = defaultProjectsDir();
  let projectKey = o.project || projectKeyFromCwd(path.resolve(o.cwd));
  // 導出したディレクトリが無ければ全プロジェクトを走査して cwd で突合する(導出規則の保険)
  if (!(await dirExists(path.join(projectsDir, projectKey)))) projectKey = null;
  let store = new TranscriptStore(projectsDir, { projectKey });
  let sessions = await store.scan();

  if (o.list) {
    const rows = listRows(projectKey ? sessions : sessions.filter((s) => s.cwd && projectKeyFromCwd(s.cwd) === projectKeyFromCwd(path.resolve(o.cwd))));
    return console.log(o.format === 'json' ? JSON.stringify({ projectKey, scan: store.lastScan, sessions: rows }, null, 2) : renderListMarkdown(rows, projectKey));
  }

  let session = pickSession(sessions, { sessionId: o.session, cwd: o.cwd });
  if (!session && o.session && projectKey) {
    // 指定 ID が cwd のプロジェクトに無い → 全プロジェクトから探す
    store = new TranscriptStore(projectsDir, { projectKey: null });
    sessions = await store.scan();
    session = pickSession(sessions, { sessionId: o.session });
  }
  if (!session) {
    console.error(o.session ? `session not found: ${o.session}` : `no session for cwd: ${o.cwd}`);
    process.exitCode = 1;
    return;
  }
  const report = buildReport(session, { top: o.top, window: o.window || undefined });
  report.scan = store.lastScan;
  console.log(o.format === 'json' ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exitCode = 1;
});
