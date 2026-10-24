import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCost, priceFor, formatUsd, MODELS, PRICING_UPDATED } from '../src/pricing.mjs';
import { parseTranscript } from '../src/parse.mjs';

const usage = (input, cc, cc1h, cr, output) => ({ input, cacheCreation: cc, cacheCreation1h: cc1h, cacheRead: cr, output, total: input + cc + cr + output });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('callCost: 入力/出力/読取/書込(5 分 1.25 倍・1 時間 2 倍)を単価で足す', () => {
  // Opus 5.5: 入力 $4 / 出力 $20 / 読取 $0.2 / 書込 5m $5 / 1h $8(1 百万トークンあたり)
  const r = callCost('claude-opus-5-5', usage(1_000_000, 1_000_000, 400_000, 1_000_000, 100_000));
  near(r.usd, 4 + 2 + (600_000 * 5 + 400_000 * 8) / 1e6 + 0.2);
  assert.equal(r.priced, true);
});

test('callCost: Fable 5.1 の読取は $0.25(入力の 0.025 倍)、日付サフィックスは同じ単価', () => {
  near(callCost('claude-fable-5-1', usage(0, 0, 0, 4_000_000, 0)).usd, 1);
  near(callCost('claude-haiku-4-5-20251001', usage(1_000_000, 0, 0, 0, 0)).usd, 1);
  const mythos = priceFor('claude-mythos-5-1');
  assert.ok(mythos);
  assert.deepEqual(mythos, priceFor('claude-fable-5-1'));
});

test('callCost: 単価未登録は 0 円で priced=false、<synthetic> は 0 円で priced=true', () => {
  assert.deepEqual(callCost('claude-unknown-9', usage(1e6, 0, 0, 0, 1e6)), { usd: 0, priced: false });
  assert.deepEqual(callCost('<synthetic>', usage(0, 0, 0, 0, 0)), { usd: 0, priced: true });
  assert.equal(priceFor(null), null);
});

test('callCost: Haiku 5.5 はプロンプト 100K 超で長文単価、1h が cacheCreation を超えても丸める', () => {
  near(callCost('claude-haiku-5-5', usage(50_000, 0, 0, 0, 0)).usd, 0.005);
  near(callCost('claude-haiku-5-5', usage(200_000, 0, 0, 0, 0)).usd, 0.1);
  near(callCost('claude-opus-5-5', usage(0, 1_000_000, 9_000_000, 0, 0)).usd, 8, '1h は cacheCreation(1M)に丸める');
});

test('テーブルの整合: 全モデルで out > in > read、更新日は日付形式', () => {
  for (const [name, p] of Object.entries(MODELS)) assert.ok(p.out > p.in && p.in > p.read && p.read > 0, name);
  assert.match(PRICING_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.0456), '$0.046');
  assert.equal(formatUsd(12.345), '$12.35');
  assert.equal(formatUsd(12345.6), '$12,346');
});

test('パース: cache_creation の TTL 内訳を 1 時間分として拾い、プロンプト・セッションへコストを集計する', () => {
  const line = (o) => JSON.stringify(o);
  const text = [
    line({ type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-10-20T00:00:00Z', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } }),
    line({ type: 'assistant', uuid: 'a1', sessionId: 's', timestamp: '2026-10-20T00:00:01Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } } } }),
    line({ type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: '2026-10-20T00:00:02Z', message: { id: 'm2', model: 'claude-mystery-1', content: [], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 7 } } }),
  ].join('\n');
  const s = parseTranscript(text);
  assert.equal(s.usage.cacheCreation1h, 400);
  assert.equal(s.prompts[0].calls[1].usage.cacheCreation1h, 0, 'TTL 内訳が無い旧形式は 5 分扱い');
  const expected = callCost('claude-opus-5-5', s.prompts[0].calls[0].usage).usd;
  near(s.cost, expected);
  near(s.prompts[0].cost, expected);
  assert.equal(s.unpricedCalls, 1, '単価未登録のモデルは件数だけ数える');
});
