import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSession, analyzeMany, causeRows, componentRows, CAUSES } from '../src/attribution.mjs';

const u = (input, cc, cr, output) => ({ input, cacheCreation: cc, cacheRead: cr, output, total: input + cc + cr + output });
const t = (min) => new Date(Date.UTC(2026, 9, 20, 0, min, 0)).toISOString();
const call = (o) => ({ id: o.id || Math.random().toString(36), model: o.model || 'm1', tools: o.tools || [], toolUses: (o.tools || []).length, sidechain: !!o.sidechain, timestamp: t(o.min), usage: o.usage });
const session = (prompts) => ({ prompts: prompts.map((calls, index) => ({ index, calls })) });

test('キャッシュ作成の原因: 初回 / 通常追加 / モデル切替 / 長いアイドル / 圧縮 / 短いアイドル', () => {
  const s = session([
    [
      call({ min: 0, usage: u(1000, 0, 0, 100) }), // first: ctx 1000
      call({ min: 1, usage: u(0, 300, 1000, 50), tools: ['Read'] }), // growth: +300(=出力 100 + Read 200)
      call({ min: 2, model: 'm2', usage: u(0, 1350, 0, 10) }), // modelSwitch: 全文脈 1350 を作り直し
    ],
    [
      call({ min: 90, model: 'm2', usage: u(0, 1360, 0, 10) }), // idleLong(88 分): 作り直し。指示の最初の呼出
      call({ min: 91, model: 'm2', usage: u(0, 20, 1360, 5) }), // growth: 出力 10 + 10
    ],
  ]);
  // 圧縮: 文脈が 30000 → 5000 に縮む
  const big = session([[call({ min: 0, usage: u(30000, 0, 0, 10) }), call({ min: 1, usage: u(0, 5000, 0, 10) }), call({ min: 10, usage: u(0, 100, 5000, 1) })]]);
  const b = analyzeSession(s);
  assert.equal(b.calls, 5);
  assert.deepEqual(b.creationByCause.first, { tokens: 0, calls: 1 });
  assert.deepEqual(b.creationByCause.growth, { tokens: 320, calls: 2 });
  assert.deepEqual(b.creationByCause.modelSwitch, { tokens: 1350, calls: 1 });
  assert.deepEqual(b.creationByCause.idleLong, { tokens: 1360, calls: 1 });
  assert.deepEqual(b.modelSwitches, { count: 1, tokens: 1350 });
  assert.deepEqual(b.switches[0], { timestamp: t(2), from: 'm1', to: 'm2', cacheCreation: 1350, promptIndex: 0 });
  assert.equal(b.promptExtras[0].modelSwitches, 1);
  const c = analyzeSession(big);
  assert.equal(c.creationByCause.compaction.calls, 1);
  assert.equal(c.creationByCause.compaction.tokens, 5000);
  assert.equal(c.creationByCause.idleShort.calls, 1, '10 分後の呼出は短いアイドル');
});

test('キャッシュ読取の構成: 台帳の構成比で按分し、合計は cache_read の総和に一致する', () => {
  const s = session([
    [
      call({ min: 0, usage: u(1000, 0, 0, 100) }), // baseline 1000
      call({ min: 1, usage: u(0, 300, 1000, 0), tools: ['Read', 'Bash'] }), // 読取 1000 は全部 baseline。追加 300 = 出力 100 + 残り 200 は前の呼出にツール無し → other
      call({ min: 2, usage: u(0, 400, 1300, 0) }), // 追加 400 = 出力 0 + Read 200 + Bash 200。読取 1300 = baseline 1000 / assistantOutput 100 / other 200
    ],
  ]);
  const b = analyzeSession(s);
  const r = b.readByComponent;
  assert.equal(Math.round(r.baseline + r.prompt + r.assistantOutput + r.other + r.compactedSummary + Object.values(r.tools).reduce((a, v) => a + v, 0)), 2300);
  assert.equal(Math.round(r.baseline), 1000 + 1000);
  assert.equal(Math.round(r.assistantOutput), 100);
  assert.equal(Math.round(r.other), 200);
  assert.deepEqual(r.tools, {}, 'Read/Bash の結果は 3 回目で積まれたが、その読取は次の呼出から');
  const rows = componentRows(b);
  assert.equal(rows[0].key, 'baseline');
  assert.ok(Math.abs(rows.reduce((a, x) => a + x.pct, 0) - 1) < 1e-6);
});

test('サブエージェント呼出は除外し、since で集計範囲を絞れる。analyzeMany は合算する', () => {
  const s = session([
    [call({ min: 0, usage: u(1000, 0, 0, 10) }), call({ min: 1, sidechain: true, usage: u(0, 999, 999, 9) }), call({ min: 2, usage: u(0, 10, 1000, 1), tools: ['Grep'] })],
  ]);
  const all = analyzeSession(s);
  assert.equal(all.calls, 2);
  assert.equal(all.cacheRead, 1000);
  const later = analyzeSession(s, { since: t(2) });
  assert.equal(later.calls, 1);
  assert.equal(later.creationByCause.first.calls, 0);
  assert.equal(later.creationByCause.growth.calls, 1);
  assert.equal(Math.round(later.readByComponent.baseline), 1000, 'since 以前に積まれた baseline も台帳には残る');
  const many = analyzeMany([s, s]);
  assert.equal(many.calls, 4);
  assert.equal(many.cacheRead, 2000);
  const rows = causeRows(many);
  assert.deepEqual(rows.map((r) => r.key).sort(), [...CAUSES].sort());
});

test('指示ごとの分類: 原因別の作成・構成別の読取が、主系列の cache_creation / cache_read に一致する', () => {
  const s = session([
    [
      call({ min: 0, usage: u(1000, 0, 0, 100) }),
      call({ min: 1, usage: u(0, 300, 1000, 50), tools: ['Read'] }),
      call({ min: 2, model: 'm2', usage: u(0, 1350, 0, 10) }),
    ],
    [
      call({ min: 90, model: 'm2', usage: u(0, 1360, 0, 10) }),
      call({ min: 91, model: 'm2', usage: u(0, 20, 1360, 5) }),
      call({ min: 92, model: 'm2', sidechain: true, usage: u(0, 999, 999, 9) }), // サブエージェント分は分類に含めない
    ],
  ]);
  const b = analyzeSession(s);
  const sum = (m) => Object.values(m).reduce((n, v) => n + v, 0);
  // 指示 0: 作成 = 300(通常の追加) + 1350(モデル切替)、読取 = 1000(初回の読取は初期コンテキスト)
  assert.deepEqual(b.promptExtras[0].creation, { growth: 300, modelSwitch: 1350 });
  assert.equal(sum(b.promptExtras[0].read), 1000);
  assert.equal(b.promptExtras[0].read.baseline > 0, true);
  // 指示 1: 作成 = 1360(アイドル後) + 20(通常の追加)。サブエージェントの 999 は含まない
  assert.deepEqual(b.promptExtras[1].creation, { idleLong: 1360, growth: 20 });
  assert.equal(sum(b.promptExtras[1].read), 1360);
  // 全指示の合計は内訳タブ(breakdown)と一致する(丸めの 1 トークン差まで)
  const allCreation = sum(b.promptExtras[0].creation) + sum(b.promptExtras[1].creation);
  assert.equal(allCreation, Math.round(b.cacheCreation));
  const allRead = sum(b.promptExtras[0].read) + sum(b.promptExtras[1].read);
  assert.ok(Math.abs(allRead - b.cacheRead) <= 2, `${allRead} vs ${b.cacheRead}`);
});
