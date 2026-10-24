# TODO

HyperHelix のタスク(`/helix`)で消化する。完了した行は削除する。

## 機能


## 不具合

- [ ] `src/report.mjs` の `contextWindowFor` が文脈窓を 200K と誤推定するモデルがある(`/fable-5|opus-5/` だけ 1M)。
      Sonnet 5 / 5.5・Opus 4.6〜4.8・Sonnet 4.6・Haiku 5.5 も 1M なので、CLI が「コンテキスト 147%」と誤報して
      不要な /compact を勧める(TASK-AIAgentDashboard-20261024-004 の確認中に発見)

## プロセス(D2b 由来)

- [ ] Search S4 で「`find` の総数と自前列挙の総数が合わない」ときは即座に突合する手順を
      調査テンプレに入れる(TASK-AIAgentDashboard-20261018-001: 128 vs 81 の差 = subagents/ 配下を見落とし、
      Execute 中に前提ズレとして発覚)
- [ ] I/O を含む所要時間を記録するときは OS ファイルキャッシュの冷温(cold / warm)を併記する
      (TASK-AIAgentDashboard-20261018-002: TODO に書かれた「20 s」は cold 実測、warm では逐次 3.8 s・
      並列 1.1 s で、目標「半分以下」の分母が計測条件で 5 倍変わった)
