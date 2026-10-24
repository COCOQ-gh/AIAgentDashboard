import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parse.mjs';
import { groupWorktrees, resolveSessions, summarizeProjects } from '../src/scan.mjs';
import { projectKeyFromCwd } from '../src/report.mjs';

const J = (o) => JSON.stringify(o);
const usage = (input, cc, cr, output) => ({ input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: output });
const human = (text, promptId, ts) => J({ type: 'user', origin: { kind: 'human' }, promptId, uuid: 'u-' + promptId, timestamp: ts, message: { role: 'user', content: text } });
const assistant = (id, u, ts, extra = {}) => J({ type: 'assistant', uuid: 'a-' + id, timestamp: ts, message: { id, role: 'assistant', model: 'm', usage: u, content: [{ type: 'text', text: 'x' }] }, ...extra });

function parsed(text, meta) {
  const s = parseTranscript(text);
  return Object.assign(s, { parentSessionId: null, fileMtime: 1, ...meta });
}

test('サブエージェントの calls は promptId で親プロンプトに合流する', () => {
  const main = parsed([human('親の指示', 'P1', '2026-10-18T00:00:00Z'), assistant('m1', usage(1, 1, 1, 1), '2026-10-18T00:00:01Z')].join('\n'), { sessionId: 'S', projectKey: 'proj' });
  const sub = parsed(
    [
      J({ type: 'user', isSidechain: true, promptId: 'P1', agentId: 'ag1', uuid: 'wo-1', timestamp: '2026-10-18T00:00:02Z', message: { role: 'user', content: 'WO 本文' } }),
      assistant('sm1', usage(0, 0, 500, 20), '2026-10-18T00:00:03Z', { isSidechain: true }),
      assistant('sm2', usage(0, 0, 600, 30), '2026-10-18T00:00:04Z', { isSidechain: true }),
    ].join('\n'),
    { sessionId: 'S/agent-ag1', projectKey: 'proj', parentSessionId: 'S' }
  );
  assert.equal(sub.prompts[0].kind, 'subagent');
  const [r] = resolveSessions([main, sub]);
  assert.equal(r.prompts.length, 1);
  assert.equal(r.prompts[0].usage.total, 4 + 520 + 630);
  assert.equal(r.prompts[0].apiCalls, 3);
  assert.equal(r.prompts[0].sidechainCalls, 2);
  assert.equal(r.usage.total, 1154);
});

test('フォークで複製された履歴は 1 回だけ数え、空になった複製プロンプトは落とす', () => {
  const shared = [human('共通の指示', 'P1', '2026-10-18T00:00:00Z'), assistant('m1', usage(10, 0, 0, 0), '2026-10-18T00:00:01Z')];
  const original = parsed(shared.join('\n'), { sessionId: 'A', projectKey: 'proj', fileMtime: 1 });
  const fork = parsed([...shared, human('フォーク後の指示', 'P2', '2026-10-18T00:01:00Z'), assistant('m2', usage(5, 0, 0, 0), '2026-10-18T00:01:01Z')].join('\n'), { sessionId: 'B', projectKey: 'proj', fileMtime: 2 });
  const out = resolveSessions([fork, original]); // 入力順に依存しない
  const a = out.find((s) => s.sessionId === 'A');
  const b = out.find((s) => s.sessionId === 'B');
  assert.equal(a.usage.total, 10);
  assert.equal(a.prompts.length, 1);
  assert.equal(b.prompts.length, 1, '複製された P1 は落ちる');
  assert.equal(b.prompts[0].text, 'フォーク後の指示');
  assert.equal(b.usage.total, 5);
  assert.equal(b.duplicatePrompts, 1);
  const [proj] = summarizeProjects(out);
  assert.equal(proj.usage.total, 15);
  assert.equal(proj.prompts, 2);
});

test('resolveSessions はキャッシュ側のオブジェクトを変更しない', () => {
  const shared = [human('指示', 'P1', '2026-10-18T00:00:00Z'), assistant('m1', usage(10, 0, 0, 0), '2026-10-18T00:00:01Z')];
  const a = parsed(shared.join('\n'), { sessionId: 'A', fileMtime: 1 });
  const b = parsed(shared.join('\n'), { sessionId: 'B', fileMtime: 2 });
  resolveSessions([a, b]);
  assert.equal(b.prompts.length, 1);
  assert.equal(b.prompts[0].calls.length, 1);
  assert.equal(b.usage.total, 10);
});

test('main と Claude Code worktree はルートリポジトリの 1 プロジェクトにまとまる', () => {
  const root = String.raw`H:\AI\HyperHelix`;
  const worktreeCwd = String.raw`H:\AI\HyperHelix\.claude\worktrees\vibrant-archimedes-2478ce`;
  const main = parsed([human('main', 'P1', '2026-10-18T00:00:00Z'), assistant('m1', usage(1, 0, 0, 0), '2026-10-18T00:00:01Z')].join('\n'), {
    sessionId: 'main',
    projectKey: projectKeyFromCwd(root),
    cwd: root,
  });
  const worktree = parsed([human('worktree', 'P2', '2026-10-18T01:00:00Z'), assistant('m2', usage(2, 0, 0, 0), '2026-10-18T01:00:01Z')].join('\n'), {
    sessionId: 'worktree',
    projectKey: 'H--AI-HyperHelix--claude-worktrees-vibrant-archimedes-2478ce',
    cwd: worktreeCwd,
  });
  const out = resolveSessions([main, worktree]);
  assert.equal(out[0].projectKey, out[1].projectKey);
  assert.equal(out.find((s) => s.sessionId === 'worktree').worktree, worktree.projectKey);
  const projects = summarizeProjects(out);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessions, 2);
  assert.equal(projects[0].worktrees, 1);
  assert.equal(projects[0].cwd, root);
});

test('groupWorktrees は通常パスを保ち、POSIX worktree もまとめ、入力を変更しない', () => {
  const scratch = { sessionId: 'scratch', projectKey: 'scratch', cwd: String.raw`H:\scratch\worktrees\name` };
  const posix = { sessionId: 'posix', projectKey: '-home-me-repo--claude-worktrees-feature', cwd: '/home/me/repo/.claude/worktrees/feature' };
  const out = groupWorktrees([scratch, posix]);
  assert.equal(out[0].projectKey, 'scratch');
  assert.equal(out[0].projectCwd, scratch.cwd);
  assert.equal(out[0].worktree, undefined);
  assert.equal(out[1].projectKey, projectKeyFromCwd('/home/me/repo'));
  assert.equal(out[1].projectCwd, '/home/me/repo');
  assert.equal(out[1].worktree, posix.projectKey);
  assert.equal(posix.projectCwd, undefined);
  assert.equal(posix.worktree, undefined);
});

test('TranscriptStore.scan はワーカー並列でも逐次と同じ結果を返し、変化したファイルだけ再パースする', async () => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { TranscriptStore } = await import('../src/scan.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiad-scan-'));
  try {
    const proj = path.join(dir, 'proj');
    await fs.mkdir(path.join(proj, 'S1', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(proj, 'S1.jsonl'), [human('親の指示', 'P1', '2026-10-18T00:00:00Z'), assistant('m1', usage(1, 1, 1, 1), '2026-10-18T00:00:01Z')].join('\n'));
    await fs.writeFile(
      path.join(proj, 'S1', 'subagents', 'agent-ag1.jsonl'),
      [J({ type: 'user', isSidechain: true, promptId: 'P1', agentId: 'ag1', uuid: 'wo-1', timestamp: '2026-10-18T00:00:02Z', message: { role: 'user', content: 'WO' } }), assistant('sm1', usage(0, 0, 500, 20), '2026-10-18T00:00:03Z', { isSidechain: true })].join('\n')
    );
    await fs.writeFile(path.join(proj, 'S2.jsonl'), [human('別の指示', 'P2', '2026-10-18T01:00:00Z'), assistant('m2', usage(10, 0, 0, 5), '2026-10-18T01:00:01Z')].join('\n'));
    await fs.writeFile(path.join(proj, 'S3.jsonl'), '{壊れた行\n' + human('三つ目', 'P3', '2026-10-18T02:00:00Z'));

    const seq = new TranscriptStore(dir, { workers: 0 });
    const par = new TranscriptStore(dir, { workers: 3 });
    const a = await seq.scan();
    const b = await par.scan();
    assert.equal(par.lastScan.workers, 3);
    assert.equal(par.lastScan.parsed, 4);
    assert.deepEqual(b, a);
    assert.equal(a.length, 3);
    assert.equal(a.find((s) => s.sessionId === 'S1').usage.total, 4 + 520);
    assert.equal(a.find((s) => s.sessionId === 'S3').badLines, 1);

    // 2 回目は全件キャッシュ命中 → パース 0 件。1 ファイルだけ書き換えるとそれだけ再パース(逐次パス)
    await par.scan();
    assert.equal(par.lastScan.parsed, 0);
    await fs.writeFile(path.join(proj, 'S2.jsonl'), [human('別の指示', 'P2', '2026-10-18T01:00:00Z'), assistant('m2', usage(10, 0, 0, 5), '2026-10-18T01:00:01Z'), assistant('m3', usage(7, 0, 0, 0), '2026-10-18T01:00:02Z')].join('\n'));
    const c = await par.scan();
    assert.equal(par.lastScan.parsed, 1);
    assert.equal(par.lastScan.workers, 1);
    assert.equal(c.find((s) => s.sessionId === 'S2').usage.total, 22);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
