import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parse.mjs';
import { resolveSessions, summarizeProjects } from '../src/scan.mjs';

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
