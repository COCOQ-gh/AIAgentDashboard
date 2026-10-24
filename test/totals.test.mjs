import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodTotals, sessionInPeriod } from '../src/totals.mjs';
import { callCost } from '../src/pricing.mjs';

const u = (input, cacheCreation, cacheCreation1h, cacheRead, output) => ({
  input,
  cacheCreation,
  cacheCreation1h,
  cacheRead,
  output,
  total: input + cacheCreation + cacheRead + output,
});
const call = (model, timestamp, usage, extra = {}) => ({ model, timestamp, usage, ...extra });
const prompt = (timestamp, calls) => ({ timestamp, calls });
const session = (endedAt, prompts) => ({ endedAt, prompts });

test('全期間は synthetic・時刻なし・sidechain を含む全 call をセッション集計と同じ値にする', () => {
  const calls = [
    call('claude-opus-5-5', '2026-10-20T00:00:01.000Z', u(10, 20, 10, 30, 4)),
    call('<synthetic>', null, u(1, 0, 0, 0, 0)),
    call('claude-unknown-9', '2026-10-22T00:00:01.000Z', u(2, 3, 0, 4, 5), { sidechain: true }),
  ];
  const sessions = [
    session('2026-10-20T00:10:00.000Z', [prompt('2026-10-20T00:00:00.000Z', calls.slice(0, 2))]),
    session(null, [prompt(null, calls.slice(2))]),
  ];
  const total = periodTotals(sessions, { since: '' });
  assert.equal(total.since, '');
  assert.deepEqual(total.usage, u(13, 23, 10, 34, 9));
  assert.equal(total.cost, calls.reduce((n, c) => n + callCost(c.model, c.usage).usd, 0));
  assert.equal(total.unpricedCalls, 1);
  assert.equal(total.apiCalls, 3);
  assert.equal(total.prompts, 2);
  assert.equal(total.sessions, 2);
});

test('since 指定は古い call と時刻なし call を除外し、prompt/session は自身の時刻で数える', () => {
  const since = '2026-10-21T00:00:00.000Z';
  const recent = call('claude-opus-5-5', '2026-10-22T00:00:01.000Z', u(5, 6, 4, 7, 8), { sidechain: true });
  const sessions = [
    session('2026-10-20T23:59:59.000Z', [
      prompt('2026-10-20T00:00:00.000Z', [call('claude-opus-5-5', '2026-10-20T00:00:01.000Z', u(100, 0, 0, 0, 0)), recent]),
    ]),
    session('2026-10-23T00:00:00.000Z', [
      prompt('2026-10-22T00:00:00.000Z', [call('claude-opus-5-5', null, u(200, 0, 0, 0, 0))]),
      prompt(null, []),
    ]),
  ];
  const total = periodTotals(sessions, { since });
  assert.deepEqual(total.usage, recent.usage);
  assert.equal(total.cost, callCost(recent.model, recent.usage).usd);
  assert.equal(total.unpricedCalls, 0);
  assert.equal(total.apiCalls, 1, 'sidechain call も含める');
  assert.equal(total.prompts, 1, 'prompt は開始時刻で判定する');
  assert.equal(total.sessions, 1, 'session は終了時刻で判定する');
});

test('sessionInPeriod は全期間なら終了時刻なしも含み、since 指定時は endedAt で判定する', () => {
  assert.equal(sessionInPeriod({ endedAt: null }, ''), true);
  assert.equal(sessionInPeriod({ endedAt: null }, '2026-10-21T00:00:00.000Z'), false);
  assert.equal(sessionInPeriod({ endedAt: '2026-10-21T00:00:00.000Z' }, '2026-10-21T00:00:00.000Z'), true);
});
