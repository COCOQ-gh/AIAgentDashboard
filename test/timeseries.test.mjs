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

test('時間別: 1 時間ごとに足し、空の時間も 0 で埋め、t は区間開始の擬似 epoch', () => {
  const r = timeseries([session(call('2026-10-19T03:10:00Z', 1), call('2026-10-19T03:50:00Z', 2), call('2026-10-19T06:00:00Z', 4))], { bucket: 'hour' });
  assert.equal(r.bucket, 'hour');
  assert.equal(r.stepMs, 3_600_000);
  assert.deepEqual(r.rows.map((x) => [x.key, x.usage.total]), [['2026-10-19T03', 3], ['2026-10-19T04', 0], ['2026-10-19T05', 0], ['2026-10-19T06', 4]]);
  assert.equal(r.rows[0].t, Date.UTC(2026, 9, 19, 3));
  assert.equal(r.rows[3].t - r.rows[0].t, 3 * 3_600_000, 't は等間隔');
  // ローカル時刻(UTC+9)では UTC 03:10 は 12 時台
  const jp = timeseries([session(call('2026-10-19T03:10:00Z', 1))], { bucket: 'hour', tzOffsetMin: -540 });
  assert.equal(jp.rows[0].key, '2026-10-19T12');
});

test('日別・週別の行にも t(区間開始)が付き、間隔は step と一致する', () => {
  const d = timeseries([session(call('2026-10-19T03:00:00Z', 1), call('2026-10-21T03:00:00Z', 1))]);
  assert.equal(d.rows[0].t, Date.UTC(2026, 9, 19));
  assert.equal(d.rows[2].t - d.rows[0].t, 2 * d.stepMs);
  const w = timeseries([session(call('2026-10-19T03:00:00Z', 1), call('2026-11-03T03:00:00Z', 1))], { bucket: 'week' });
  assert.equal(w.stepMs, 7 * 86_400_000);
  assert.equal(new Date(w.rows[0].t).getUTCDay(), 1, '週の開始は月曜');
});
