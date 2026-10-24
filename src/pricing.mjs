// モデル別の単価と USD 概算コスト。純関数のみ — I/O はしない。
//
// 単価は **手で更新するテーブル**。Anthropic の価格改定には追従しないので、更新日(PRICING_UPDATED)を画面と
// CLI に出す。新しいモデルが出たら MODELS に 1 行足す(足すまでそのモデルは「単価未登録」で 0 円計上し、
// 件数を別に数える)。
//   出典: Anthropic 公式の Claude API 価格(1 百万トークンあたり USD)。2026-10-06 時点の写しを使った。
//   キャッシュ書込は 5 分 TTL が入力単価の 1.25 倍、1 時間 TTL が 2 倍。キャッシュ読取は read(モデルごとに倍率が違う)。
// 実データの cache_creation はほぼ全てが 1 時間 TTL(Claude Code の既定)なので、5 分/1 時間を分けて計算する。
// 概算の限界: Priority Tier・Fast mode・バッチ割引・データレジデンシーの上乗せは見ていない。
import { normalizeModel, isSyntheticModel } from './model-name.mjs';

export const PRICING_UPDATED = '2026-10-06';

/** @type {Record<string, {in: number, out: number, read: number, long?: {above: number, in: number, out: number, read: number}}>} */
export const MODELS = {
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-fable-5': { in: 10, out: 50, read: 1 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-opus-5': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-7': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, read: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, read: 0.3 },
  // Haiku 5.5 はプロンプト 100K トークン超で 5 倍の単価(読取は入力単価の 0.1 倍と仮定)
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, long: { above: 100_000, in: 0.5, out: 2.5, read: 0.05 } },
  'claude-haiku-4-5': { in: 1, out: 5, read: 0.1 },
};

const WRITE_5M = 1.25;
const WRITE_1H = 2;

/** モデルの単価(未登録なら null)。 */
export function priceFor(model) {
  return MODELS[normalizeModel(model)] || null;
}

/**
 * 1 API 応答の USD 概算。
 * @returns {{usd: number, priced: boolean}} priced=false は単価未登録(usd は 0)。`<synthetic>` は 0 円で priced=true。
 */
export function callCost(model, usage) {
  if (isSyntheticModel(model)) return { usd: 0, priced: true };
  const base = priceFor(model);
  if (!base) return { usd: 0, priced: false };
  const prompt = usage.input + usage.cacheCreation + usage.cacheRead;
  const p = base.long && prompt > base.long.above ? base.long : base;
  const c1h = Math.min(usage.cacheCreation1h || 0, usage.cacheCreation);
  const c5m = usage.cacheCreation - c1h;
  const usd = (usage.input * p.in + usage.output * p.out + usage.cacheRead * p.read + c5m * p.in * WRITE_5M + c1h * p.in * WRITE_1H) / 1e6;
  return { usd, priced: true };
}

/** USD の表示用文字列。小さい額は小数を残す。 */
export function formatUsd(usd) {
  if (usd >= 100) return '$' + Math.round(usd).toLocaleString('en-US');
  if (usd >= 1) return '$' + usd.toFixed(2);
  if (usd > 0) return '$' + usd.toFixed(3);
  return '$0';
}
