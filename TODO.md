# TODO

HyperHelix のタスク(`/helix`)で消化する。完了した行は削除する。

## 機能

(なし)

## 不具合

- [ ] `src/report.mjs` の `contextWindowFor` が文脈窓を 200K と誤推定するモデルがある(`/fable-5|opus-5/` だけ 1M)。
      Sonnet 5 / 5.5・Opus 4.6〜4.8・Sonnet 4.6・Haiku 5.5 も 1M なので、CLI が「コンテキスト 147%」と誤報して
      不要な /compact を勧める(TASK-AIAgentDashboard-20261024-004 の確認中に発見)

## プロセス(D2b 由来)

(なし)
