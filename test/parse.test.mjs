import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, displayText, isHumanPrompt } from '../src/parse.mjs';

const J = (o) => JSON.stringify(o);
const usage = (input, cc, cr, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
  output_tokens: output,
});

function human(text, extra = {}) {
  return J({
    type: 'user',
    origin: { kind: 'human' },
    promptId: extra.promptId || 'p-' + text,
    uuid: 'u-' + text,
    timestamp: extra.timestamp || '2026-10-18T00:00:00.000Z',
    message: { role: 'user', content: text },
    sessionId: 'S1',
    cwd: 'H:\\proj',
    ...extra,
  });
}
function assistant(id, u, content = [{ type: 'text', text: 'ok' }], extra = {}) {
  return J({
    type: 'assistant',
    uuid: 'a-' + id + '-' + Math.random(),
    timestamp: extra.timestamp || '2026-10-18T00:00:01.000Z',
    message: { id, role: 'assistant', model: 'claude-sonnet-5-5', usage: u, content },
    ...extra,
  });
}

test('usage は message.id で重複排除され、直前の人間プロンプトに帰属する', () => {
  const lines = [
    J({ type: 'queue-operation', operation: 'enqueue' }),
    human('最初の指示'),
    // 1 応答が thinking / tool_use / tool_use の 3 行に分割され usage は同一
    assistant('m1', usage(2, 100, 1000, 50), [{ type: 'thinking' }]),
    assistant('m1', usage(2, 100, 1000, 50), [{ type: 'tool_use', name: 'Read' }]),
    assistant('m1', usage(2, 100, 1000, 50), [{ type: 'tool_use', name: 'Grep' }]),
    // ツール結果(user 行だが人間の指示ではない)
    J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
    assistant('m2', usage(1, 0, 2000, 10)),
    human('二番目の指示'),
    assistant('m3', usage(5, 7, 9, 11)),
  ];
  const s = parseTranscript(lines.join('\n'));
  assert.equal(s.prompts.length, 2);
  const [p1, p2] = s.prompts;
  assert.equal(p1.text, '最初の指示');
  assert.deepEqual(p1.usage, { input: 3, cacheCreation: 100, cacheRead: 3000, output: 60, total: 3163 });
  assert.equal(p1.apiCalls, 2);
  assert.equal(p1.toolUses, 2);
  assert.deepEqual(p2.usage, { input: 5, cacheCreation: 7, cacheRead: 9, output: 11, total: 32 });
  assert.equal(s.usage.total, 3163 + 32);
  assert.equal(s.apiCalls, 3);
  assert.equal(s.sessionId, 'S1');
  assert.equal(s.cwd, 'H:\\proj');
  assert.deepEqual(s.models, { 'claude-sonnet-5-5': 3 });
});

test('isMeta(スキル本文の注入)は指示として数えない', () => {
  const lines = [
    human('<command-message>helix</command-message>\n<command-name>/helix</command-name>\n<command-args>ダッシュボードを作る</command-args>'),
    J({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill…' }] } }),
    assistant('m1', usage(1, 1, 1, 1)),
  ];
  const s = parseTranscript(lines.join('\n'));
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].kind, 'command');
  assert.equal(s.prompts[0].text, '/helix ダッシュボードを作る');
  assert.equal(s.prompts[0].usage.total, 4);
});

test('旧形式(origin なし・content が文字列)も指示として扱う', () => {
  const rec = { type: 'user', message: { role: 'user', content: 'こんにちは' } };
  assert.equal(isHumanPrompt(rec), true);
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } };
  assert.equal(isHumanPrompt(toolResult), false);
});

test('タイトルは custom-title を優先し、無ければ最初の指示', () => {
  const a = parseTranscript([human('指示A'), J({ type: 'custom-title', customTitle: 'HH Apply' })].join('\n'));
  assert.equal(a.title, 'HH Apply');
  const b = parseTranscript([human('指示B')].join('\n'));
  assert.equal(b.title, '指示B');
});

test('壊れた行は数えて読み飛ばし、プロンプト前の assistant は orphan に帰属', () => {
  const lines = ['{not json', assistant('m0', usage(1, 2, 3, 4)), human('後から来た指示'), assistant('m1', usage(1, 1, 1, 1))];
  const s = parseTranscript(lines.join('\n'));
  assert.equal(s.badLines, 1);
  assert.equal(s.prompts.length, 2);
  assert.equal(s.prompts[0].kind, 'orphan');
  assert.equal(s.prompts[0].usage.total, 10);
  assert.equal(s.prompts[1].usage.total, 4);
});

test('displayText は system-reminder を除去し空白を畳む', () => {
  const d = displayText('<system-reminder>秘密</system-reminder>\n\n  テスト   して  ');
  assert.deepEqual(d, { kind: 'text', text: 'テスト して' });
});
