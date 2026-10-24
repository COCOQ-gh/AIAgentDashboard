import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRows, normalizeModel, isSyntheticModel } from '../src/models.mjs';

const u = (input, cc, cr, output) => ({ input, cacheCreation: cc, cacheRead: cr, output, total: input + cc + cr + output });
const t = (day) => new Date(Date.UTC(2026, 9, day, 0, 0, 0)).toISOString();
const call = (model, day, usage) => ({ id: Math.random().toString(36), model, timestamp: day == null ? null : t(day), usage });
const session = (...calls) => ({ prompts: [{ index: 0, calls }] });

test('モデル別: call ごとにモデルへ足し、日付サフィックスは同じモデルに畳む', () => {
  const rows = modelRows([
    session(call('claude-opus-5', 1, u(1, 10, 100, 5)), call('claude-haiku-4-5-20251001', 1, u(2, 0, 20, 1)), call('claude-haiku-4-5', 2, u(1, 0, 10, 1))),
    session(call('claude-opus-5', 3, u(0, 0, 50, 5))),
  ]);
  assert.deepEqual(rows.map((r) => r.model), ['claude-opus-5', 'claude-haiku-4-5']);
  const opus = rows[0];
  assert.equal(opus.calls, 2);
  assert.equal(opus.sessions, 2);
  assert.deepEqual(opus.usage, u(1, 10, 150, 10));
  const haiku = rows[1];
  assert.equal(haiku.calls, 2);
  assert.equal(haiku.sessions, 1, '同一セッション内の 2 つの表記は 1 セッションと数える');
  assert.deepEqual(haiku.usage, u(3, 0, 30, 2));
  assert.equal(opus.firstAt, t(1));
  assert.equal(opus.lastAt, t(3));
  assert.ok(Math.abs(rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9, '比率の合計は 1');
});

test('モデル別: <synthetic> は出さず、since は call のタイムスタンプで絞る', () => {
  const s = session(call('<synthetic>', 1, u(0, 0, 0, 0)), call('m1', 1, u(1, 0, 0, 1)), call('m1', 5, u(5, 0, 0, 5)), call('m2', null, u(9, 0, 0, 9)));
  const all = modelRows([s]);
  assert.deepEqual(all.map((r) => r.model).sort(), ['m1', 'm2']);
  const recent = modelRows([s], { since: t(3) });
  assert.deepEqual(recent.map((r) => r.model), ['m1']);
  assert.equal(recent[0].usage.total, 10);
});

test('normalizeModel / isSyntheticModel', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('claude-fable-5-1'), 'claude-fable-5-1', '世代の数字は 8 桁の日付ではないので落とさない');
  assert.equal(normalizeModel(null), '(不明)');
  assert.equal(isSyntheticModel('<synthetic>'), true);
  assert.equal(isSyntheticModel('claude-opus-5'), false);
});
