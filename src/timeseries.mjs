// 時間別 / 日別 / 週別の時系列集計。純関数のみ — I/O はしない。
// API 応答(call)のタイムスタンプで日(または週)に振り分けて usage と USD 概算を足す。
// 日付の区切りは「閲覧者のローカル時刻」で決めたいので、UTC との差(分)を引数で受ける
// (ブラウザの Date#getTimezoneOffset と同じ符号: UTC+9 なら -540)。週は月曜始まり。
// 先頭と末尾の間の空の時間・日・週も 0 の行として埋める(グラフに「使っていない期間」を出すため)。
// 各行の t は区間の開始(ローカル時刻を UTC として表した擬似 epoch ms)。グラフの横軸(時間)の位置に使う。
import { emptyUsage, addUsage } from './parse.mjs';
import { callCost } from './pricing.mjs';
import { isSyntheticModel } from './model-name.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** ローカル日付の 0 時を表す epoch ms(UTC として扱う擬似時刻)。 */
function localDayStart(ms, offsetMin) {
  const shifted = ms - offsetMin * 60_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS;
}

function ymd(dayStartMs) {
  return new Date(dayStartMs).toISOString().slice(0, 10);
}

/** 時間別の行キー(YYYY-MM-DDTHH)。 */
function ymdh(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

/** 日 → その週の月曜(擬似時刻)。1970-01-01 は木曜。 */
function mondayOf(dayStartMs) {
  const dow = (Math.floor(dayStartMs / DAY_MS) + 3) % 7; // 月=0 … 日=6
  return dayStartMs - dow * DAY_MS;
}

/**
 * @param {Array} sessions prompts[].calls[] を持つセッション
 * @param {{since?: string, bucket?: 'hour'|'day'|'week', tzOffsetMin?: number}} [opts]
 * @returns {{bucket: string, stepMs: number, rows: Array<{key, t, usage, cost, unpricedCalls, calls}>}}
 */
export function timeseries(sessions, opts = {}) {
  const bucket = opts.bucket === 'week' || opts.bucket === 'hour' ? opts.bucket : 'day';
  const offset = Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : 0;
  const since = opts.since || '';
  const step = bucket === 'week' ? 7 * DAY_MS : bucket === 'hour' ? HOUR_MS : DAY_MS;
  const keyOf = bucket === 'hour' ? ymdh : ymd;
  const byKey = new Map(); // 擬似時刻 → 行
  for (const s of sessions) {
    for (const p of s.prompts) {
      for (const c of p.calls) {
        if (isSyntheticModel(c.model) || !c.timestamp) continue;
        if (since && c.timestamp < since) continue;
        const ms = Date.parse(c.timestamp);
        if (!Number.isFinite(ms)) continue;
        const shifted = ms - offset * 60_000;
        const k = bucket === 'hour' ? Math.floor(shifted / HOUR_MS) * HOUR_MS : bucket === 'week' ? mondayOf(localDayStart(ms, offset)) : localDayStart(ms, offset);
        let r = byKey.get(k);
        if (!r) byKey.set(k, (r = { key: keyOf(k), t: k, usage: emptyUsage(), cost: 0, unpricedCalls: 0, calls: 0 }));
        addUsage(r.usage, c.usage);
        const cc = callCost(c.model, c.usage);
        r.cost += cc.usd;
        if (!cc.priced) r.unpricedCalls++;
        r.calls++;
      }
    }
  }
  if (byKey.size === 0) return { bucket, stepMs: step, rows: [] };
  const keys = [...byKey.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const rows = [];
  for (let k = first; k <= last; k += step) {
    rows.push(byKey.get(k) || { key: keyOf(k), t: k, usage: emptyUsage(), cost: 0, unpricedCalls: 0, calls: 0 });
  }
  return { bucket, stepMs: step, rows };
}
