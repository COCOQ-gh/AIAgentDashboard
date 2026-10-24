// モデル別の集計。純関数のみ — I/O はしない。
// 1 API 応答(call)が 1 つのモデルに属するので、call を横断してモデルごとに usage を足す。
// モデル名は日付サフィックス(claude-haiku-4-5-20251001)を落として同じモデルに畳む。
// 全期間のセッション合計やプロジェクト合計はモデルを混ぜて持つため、モデル別は call から作り直す。
import { emptyUsage, addUsage } from './parse.mjs';
import { normalizeModel, isSyntheticModel } from './model-name.mjs';
import { callCost } from './pricing.mjs';

export { normalizeModel, isSyntheticModel };

/**
 * セッション群を call 単位でモデル別に集計する。
 * @param {Array} sessions prompts[].calls[] を持つセッション
 * @param {{since?: string}} [opts] since: この ISO 時刻以降の call だけ(タイムスタンプの無い call は落とす)
 * @returns {Array<{model, calls, sessions, usage, cost, unpricedCalls, firstAt, lastAt, share}>} 合計トークン降順。
 *   cost は USD 概算(src/pricing.mjs)、unpricedCalls は単価未登録で 0 円計上した呼出数
 */
export function modelRows(sessions, opts = {}) {
  const since = opts.since || '';
  const byModel = new Map();
  for (const s of sessions) {
    const seenHere = new Set();
    for (const p of s.prompts) {
      for (const c of p.calls) {
        if (isSyntheticModel(c.model)) continue;
        if (since && !(c.timestamp && c.timestamp >= since)) continue;
        const key = normalizeModel(c.model);
        let r = byModel.get(key);
        if (!r) {
          r = { model: key, calls: 0, sessions: 0, usage: emptyUsage(), cost: 0, unpricedCalls: 0, firstAt: null, lastAt: null };
          byModel.set(key, r);
        }
        r.calls++;
        addUsage(r.usage, c.usage);
        const cc = callCost(c.model, c.usage);
        r.cost += cc.usd;
        if (!cc.priced) r.unpricedCalls++;
        if (!seenHere.has(key)) {
          seenHere.add(key);
          r.sessions++;
        }
        if (c.timestamp) {
          if (!r.firstAt || c.timestamp < r.firstAt) r.firstAt = c.timestamp;
          if (!r.lastAt || c.timestamp > r.lastAt) r.lastAt = c.timestamp;
        }
      }
    }
  }
  const rows = [...byModel.values()].sort((a, b) => b.usage.total - a.usage.total || b.calls - a.calls);
  const total = rows.reduce((n, r) => n + r.usage.total, 0);
  for (const r of rows) r.share = total > 0 ? r.usage.total / total : 0;
  return rows;
}
