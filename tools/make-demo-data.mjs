#!/usr/bin/env node
// 合成トランスクリプトの生成器(スクリーンショット・デモ用)。
// 実データで撮ると、プロジェクト名・ローカルのパス・指示の本文が画面に写る。公開してよい架空の内容だけで
// Claude Code と同じ形の JSONL(<project>/<sessionId>.jsonl とサブエージェント)を作る。
//
//   node tools/make-demo-data.mjs [--out tmp/demo-projects] [--days 6] [--seed 7]
//   CLAUDE_PROJECTS_DIR=tmp/demo-projects npm start
//
// 乱数はシード固定なので、同じ引数なら同じ内容になる(時刻だけは実行時点を基準にずらす)。
// 各タブが空にならないよう、モデル切替・60 分超のアイドル・圧縮(文脈の縮小)・サブエージェントを必ず含める。

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const OUT = path.resolve(args.out || 'tmp/demo-projects');
const DAYS = Number(args.days || 6);
let seed = Number(args.seed || 7);

function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
const uid = () => Array.from({ length: 4 }, () => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')).join('');
const uuid = () => `${uid()}-${uid().slice(0, 4)}-4${uid().slice(0, 3)}-a${uid().slice(0, 3)}-${uid()}${uid().slice(0, 4)}`;

const PROJECTS = [
  {
    cwd: '/home/dev/weather-api',
    prompts: [
      '気象 API のレスポンスをキャッシュする層を追加して',
      'タイムゾーン変換のテストが落ちる原因を調べて直して',
      'OpenAPI の定義から型を生成するスクリプトを書いて',
      'レート制限のエラー処理をリトライ付きにして',
      'README に環境変数の一覧を追記して',
    ],
  },
  {
    cwd: '/home/dev/recipe-app',
    prompts: [
      'レシピ検索の画面に材料での絞り込みを付けて',
      '画像アップロードのサイズ上限を設定して',
      'モバイル幅でカードが崩れるのを直して',
      'お気に入り機能の E2E テストを追加して',
    ],
  },
  {
    cwd: '/home/dev/cli-toolkit',
    prompts: [
      'サブコマンドの補完スクリプトを zsh 用に作って',
      '設定ファイルの読み込み順を整理してドキュメント化して',
      'ログ出力に --json オプションを追加して',
    ],
  },
  {
    cwd: '/home/dev/blog-site',
    prompts: ['記事一覧のページネーションを実装して', 'RSS フィードを生成して', 'ビルド時間が長い原因を調べて'],
  },
];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const TOOLS = ['Read', 'Read', 'Read', 'Edit', 'Bash', 'Bash', 'Grep', 'Glob', 'Write'];

const projectKey = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const J = (o) => JSON.stringify(o);

function makeSession(project, start, opts) {
  const sessionId = uuid();
  const lines = [];
  const sub = [];
  let t = start.getTime();
  let ctx = between(14_000, 22_000); // 初期コンテキスト(システム・ツール定義・CLAUDE.md)
  let model = opts.model;
  let msgN = 0;
  const base = { sessionId, cwd: project.cwd, version: '2.3.0', gitBranch: 'main' };
  const nPrompts = between(2, 4);
  for (let p = 0; p < nPrompts; p++) {
    if (p > 0) t += opts.idleAt === p ? between(70, 140) * 60_000 : between(2, 12) * 60_000;
    if (opts.switchAt === p) model = pick(MODELS.filter((m) => m !== model));
    const promptId = uuid();
    const text = pick(project.prompts);
    lines.push(J({ ...base, type: 'user', origin: { kind: 'human' }, promptId, uuid: uuid(), timestamp: new Date(t).toISOString(), message: { role: 'user', content: text } }));
    let fresh = between(40, 400) + text.length * 2; // 指示本文 + 注入
    const nCalls = between(6, 22);
    for (let c = 0; c < nCalls; c++) {
      t += between(4, 40) * 1000;
      if (opts.compactAt === p && c === Math.floor(nCalls / 2)) {
        ctx = Math.round(ctx * 0.25); // 圧縮: 要約に置き換わって文脈が縮む
        fresh = between(3_000, 6_000);
      }
      const tools = c === nCalls - 1 ? [] : Array.from({ length: rand() < 0.3 ? 2 : 1 }, () => pick(TOOLS));
      const output = between(80, 1_800);
      const usage = { input_tokens: between(1, 12), cache_creation_input_tokens: fresh, cache_read_input_tokens: ctx, output_tokens: output };
      const id = `msg_demo_${sessionId.slice(0, 8)}_${msgN++}`;
      lines.push(J({ ...base, type: 'assistant', uuid: uuid(), timestamp: new Date(t).toISOString(), message: { id, role: 'assistant', model, usage, content: [{ type: 'text', text: '…' }, ...tools.map((name) => ({ type: 'tool_use', id: 'toolu_' + uid(), name, input: {} }))] } }));
      ctx += fresh;
      // 次の呼出で新たに入る文脈 = この応答の出力 + ツール結果
      fresh = output + tools.reduce((s, name) => s + (name === 'Read' ? between(1_500, 9_000) : name === 'Bash' ? between(300, 4_000) : between(150, 1_200)), 0);
      if (opts.subagentAt === p && c === 2) {
        const agentT = t;
        sub.push(J({ ...base, type: 'user', isSidechain: true, promptId, uuid: uuid(), timestamp: new Date(agentT).toISOString(), message: { role: 'user', content: '関連ファイルを調査して要点を報告して' } }));
        let actx = between(9_000, 12_000);
        for (let k = 0; k < 8; k++) {
          const af = between(1_000, 6_000);
          sub.push(J({ ...base, type: 'assistant', isSidechain: true, uuid: uuid(), timestamp: new Date(agentT + (k + 1) * 9_000).toISOString(), message: { id: `msg_demo_${sessionId.slice(0, 8)}_a${k}`, role: 'assistant', model: 'claude-haiku-5-5', usage: { input_tokens: 3, cache_creation_input_tokens: af, cache_read_input_tokens: actx, output_tokens: between(100, 600) }, content: [{ type: 'tool_use', id: 'toolu_' + uid(), name: pick(['Read', 'Grep', 'Glob']), input: {} }] } }));
          actx += af;
        }
      }
    }
  }
  lines.push(J({ type: 'ai-title', sessionId, aiTitle: project.prompts[0].slice(0, 30) }));
  return { sessionId, lines, sub };
}

fs.rmSync(OUT, { recursive: true, force: true });
const now = Date.now();
let sessions = 0;
for (let d = DAYS - 1; d >= 0; d--) {
  const perDay = between(2, 5);
  for (let i = 0; i < perDay; i++) {
    const project = PROJECTS[Math.min(PROJECTS.length - 1, Math.floor(rand() ** 1.6 * PROJECTS.length))];
    const day = new Date(now - d * 86_400_000);
    day.setHours(between(9, 20), between(0, 59), 0, 0);
    if (day.getTime() > now - 30 * 60_000) day.setTime(now - between(60, 240) * 60_000);
    const s = makeSession(project, day, {
      model: rand() < 0.6 ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
      switchAt: rand() < 0.35 ? 1 : -1,
      idleAt: rand() < 0.3 ? 2 : -1,
      compactAt: rand() < 0.25 ? 1 : -1,
      subagentAt: rand() < 0.4 ? 0 : -1,
    });
    const dir = path.join(OUT, projectKey(project.cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, s.sessionId + '.jsonl'), s.lines.join('\n') + '\n');
    if (s.sub.length) {
      const subDir = path.join(dir, s.sessionId, 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'agent-' + uid() + '.jsonl'), s.sub.join('\n') + '\n');
    }
    sessions++;
  }
}
console.log(`${sessions} sessions → ${OUT}`);
