import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeseries } from '../src/timeseries.mjs';

const u = (n) => ({ input: n, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, output: 0, total: n });
const call = (iso, n, model = 'claude-opus-5-5') => ({ id: iso + n, model, timestamp: iso, usage: u(n) });
const session = (...calls) => ({ prompts: [{ index: 0, calls }] });

test('日別: 日付ごとに足し、間の空の日は 0 の行で埋める', () => {
  const r = timeseries([session(call('2026-10-19T03:00:00Z', 10), call('2026-10-19T20:00:00Z', 5), call('2026-10-22T01:00:00Z', 7))]);
  assert.equal(r.bucket, 'day');
  assert.deepEqual(r.rows.map((x) => [x.key, x.usage.total, x.calls]), [
    ['2026-10-19', 15, 2], ['2026-10-20', 0, 0], ['2026-10-21', 0, 0], ['2026-10-22', 7, 1],
  ]);
  assert.ok(r.rows[0].cost > 0 && r.rows[1].cost === 0);
});

test('日の区切りは閲覧者のローカル時刻: UTC+9(offset -540)では UTC 15:00 以降が翌日', () => {
  const s = [session(call('2026-10-19T14:59:00Z', 1), call('2026-10-19T15:00:00Z', 2))];
  assert.deepEqual(timeseries(s, { tzOffsetMin: 0 }).rows.map((x) => [x.key, x.usage.total]), [['2026-10-19', 3]]);
  assert.deepEqual(timeseries(s, { tzOffsetMin: -540 }).rows.map((x) => [x.key, x.usage.total]), [['2026-10-19', 1], ['2026-10-20', 2]]);
});

test('週別: 月曜始まり。日曜は前の週、月曜は次の週に入り、空の週も埋める', () => {
  // 2026-10-18 は日曜、10-19 は月曜、10-26 は次の月曜
  const r = timeseries([session(call('2026-10-18T12:00:00Z', 1), call('2026-10-19T12:00:00Z', 2), call('2026-10-24T12:00:00Z', 4), call('2026-11-03T12:00:00Z', 8))], { bucket: 'week' });
  assert.deepEqual(r.rows.map((x) => [x.key, x.usage.total]), [['2026-10-12', 1], ['2026-10-19', 6], ['2026-10-26', 0], ['2026-11-02', 8]]);
});

test('since・タイムスタンプなし・<synthetic>・未登録モデル', () => {
  const s = [session(call('2026-10-01T00:00:00Z', 100), call('2026-10-10T00:00:00Z', 3, 'claude-mystery-1'), call('2026-10-10T00:00:00Z', 9, '<synthetic>'), { id: 'x', model: 'claude-opus-5-5', timestamp: null, usage: u(50) })];
  const r = timeseries(s, { since: '2026-10-05T00:00:00Z' });
  assert.deepEqual(r.rows.map((x) => [x.key, x.usage.total, x.unpricedCalls]), [['2026-10-10', 3, 1]]);
  assert.deepEqual(timeseries([]).rows, []);
});
