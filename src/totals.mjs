// 期間指定の KPI 集計。call / prompt / session はそれぞれ自身の時刻で判定する。
import { emptyUsage, addUsage } from './parse.mjs';
import { callCost } from './pricing.mjs';

export function sessionInPeriod(s, since) {
  return !since || !!(s.endedAt && s.endedAt >= since);
}

export function periodTotals(sessions, { since = '' } = {}) {
  const totals = {
    since,
    usage: emptyUsage(),
    cost: 0,
    unpricedCalls: 0,
    apiCalls: 0,
    prompts: 0,
    sessions: 0,
  };
  for (const s of sessions) {
    if (sessionInPeriod(s, since)) totals.sessions++;
    for (const p of s.prompts) {
      if (!since || (p.timestamp && p.timestamp >= since)) totals.prompts++;
      for (const c of p.calls) {
        if (since && (!c.timestamp || c.timestamp < since)) continue;
        addUsage(totals.usage, c.usage);
        const cc = callCost(c.model, c.usage);
        totals.cost += cc.usd;
        if (!cc.priced) totals.unpricedCalls++;
        totals.apiCalls++;
      }
    }
  }
  return totals;
}
