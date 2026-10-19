import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parse.mjs';
import { resolveSessions } from '../src/scan.mjs';
import { projectKeyFromCwd, contextTokens, contextWindowFor, pickSession, toolCosts, buildReport, renderMarkdown, listRows } from '../src/report.mjs';

const J = (o) => JSON.stringify(o);
const usage = (input, cc, cr, output) => ({ input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: output });
const human = (text, promptId, ts) => J({ type: 'user', origin: { kind: 'human' }, promptId, uuid: 'u-' + promptId, timestamp: ts, cwd: 'H:\\AI\\Proj', message: { role: 'user', content: text } });
const assistant = (id, u, ts, tools = [], extra = {}) =>
  J({ type: 'assistant', uuid: 'a-' + id, timestamp: ts, message: { id, role: 'assistant', model: 'claude-fable-5-1', usage: u, content: [{ type: 'text', text: 'x' }, ...tools.map((name) => ({ type: 'tool_use', name, id: 't-' + name, input: {} }))] }, ...extra });

function session(lines, meta) {
  const s = parseTranscript(lines.join('\n'));
  return resolveSessions([Object.assign(s, { parentSessionId: null, fileMtime: 1, ...meta })])[0];
}

test('projectKeyFromCwd は Claude Code のディレクトリ名規則(英数字以外を - に)に従う', () => {
  assert.equal(projectKeyFromCwd('H:\\AI\\AIAgentDashboard'), 'H--AI-AIAgentDashboard');
  assert.equal(projectKeyFromCwd('E:\\AIera\\eraKami(改)'), 'E--AIera-eraKami---');
});

test('parse は呼出ごとのツール名を記録し、分割行のツール名も合流する', () => {
  const s = parseTranscript([human('a', 'P1', '2026-10-19T00:00:00Z'), assistant('m1', usage(1, 0, 0, 1), '2026-10-19T00:00:01Z', ['Read']), assistant('m1', usage(1, 0, 0, 1), '2026-10-19T00:00:01Z', ['Bash'])].join('\n'));
  assert.deepEqual(s.prompts[0].calls[0].tools, ['Read', 'Bash']);
  assert.equal(s.prompts[0].calls[0].toolUses, 2);
  assert.equal(s.prompts[0].apiCalls, 1);
});

test('contextTokens / contextWindowFor', () => {
  assert.equal(contextTokens({ usage: { input: 10, cacheRead: 1000, cacheCreation: 200, output: 50, total: 1260 } }), 1210);
  assert.equal(contextWindowFor('claude-fable-5-1', {}), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-4-5', {}), 200_000);
  assert.equal(contextWindowFor('claude-fable-5-1', { AIAD_CONTEXT_WINDOW: '123' }), 123);
});

test('toolCosts は次の呼出の新規入力を直前の呼出のツールへ按分する', () => {
  const s = session([
    human('読んで', 'P1', '2026-10-19T00:00:00Z'),
    assistant('m1', usage(100, 0, 0, 10), '2026-10-19T00:00:01Z', ['Read', 'Bash']), // 最初の呼出 → (指示+システム) 100
    assistant('m2', usage(0, 600, 100, 10), '2026-10-19T00:00:02Z', ['Read']), // 新規 600 → Read 300 / Bash 300
    assistant('m3', usage(0, 50, 700, 10), '2026-10-19T00:00:03Z'), // 新規 50 → Read 50
    assistant('m4', usage(0, 20, 750, 10), '2026-10-19T00:00:04Z'), // 新規 20 → (応答のみ)
  ]);
  const rows = Object.fromEntries(toolCosts(s).map((t) => [t.tool, t]));
  assert.deepEqual(rows['Read'], { tool: 'Read', uses: 2, addedTokens: 350 });
  assert.deepEqual(rows['Bash'], { tool: 'Bash', uses: 1, addedTokens: 300 });
  assert.equal(rows['(指示+システム)'].addedTokens, 100);
  assert.equal(rows['(応答のみ)'].addedTokens, 20);
  assert.equal(toolCosts(s)[0].tool, 'Read', 'addedTokens 降順');
});

test('buildReport はコンテキスト推定・上位指示・提案を返し、Markdown に描画できる', () => {
  const s = session([
    human('小さい指示', 'P1', '2026-10-19T00:00:00Z'),
    assistant('m1', usage(100, 0, 0, 10), '2026-10-19T00:00:01Z'),
    human('大きい指示', 'P2', '2026-10-19T00:01:00Z'),
    assistant('m2', usage(100, 0, 100, 10), '2026-10-19T00:01:01Z', ['Read']), // 指示 100 → (指示+システム)
    assistant('m3', usage(0, 900, 200, 10), '2026-10-19T00:01:02Z'), // Read の結果 900 が新規入力
  ]);
  const r = buildReport(s, { top: 1, window: 1200 });
  assert.equal(r.context.lastTokens, 1100);
  assert.equal(r.context.windowTokens, 1200);
  assert.equal(r.context.pct, 92);
  assert.equal(r.context.model, 'claude-fable-5-1');
  assert.equal(r.top.length, 1);
  assert.equal(r.top[0].index, 1);
  assert.equal(r.prompts[1].contextEnd, 1100);
  assert.ok(r.hints.some((h) => h.includes('92%')), 'コンテキスト 70% 超の提案');
  assert.ok(r.hints.some((h) => h.includes('Read')), 'ツール Read の提案');
  const md = renderMarkdown(r);
  assert.match(md, /^# トークン消費レポート/);
  assert.match(md, /\| 1 \| 00:01 \| 大きい指示 \|/);
  assert.match(md, /\| Read \| 1 \| 900 \|/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
});

test('pickSession は ID 指定を優先し、無ければ cwd と同じプロジェクトの最新セッションを選ぶ', () => {
  const a = session([human('a', 'P1', '2026-10-19T00:00:00Z'), assistant('m1', usage(1, 0, 0, 1), '2026-10-19T00:00:01Z')], { sessionId: 'A' });
  const b = session([human('b', 'P2', '2026-10-19T01:00:00Z'), assistant('m2', usage(1, 0, 0, 1), '2026-10-19T01:00:01Z')], { sessionId: 'B' });
  const other = session([human('c', 'P3', '2026-10-19T02:00:00Z'), assistant('m3', usage(1, 0, 0, 1), '2026-10-19T02:00:01Z')], { sessionId: 'C' });
  other.cwd = 'H:\\AI\\Other';
  assert.equal(pickSession([a, b, other], { sessionId: 'A' }).sessionId, 'A');
  assert.equal(pickSession([a, b, other], { cwd: 'H:/AI/Proj' }).sessionId, 'B');
  assert.equal(pickSession([a, b, other], { sessionId: 'Z' }), null);
  assert.deepEqual(listRows([a, b]).map((r) => r.sessionId), ['B', 'A']);
});
