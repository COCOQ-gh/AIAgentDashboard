## 開発プロセス
タスクは HyperHelix(`doc/HyperHelix/` にネスト・別リポジトリ)のタスクループで実行する: `/helix <タスク>`。
フレームワークのエントリは `doc/HyperHelix/entrypoint.md`。作業記録(コミット本文の hh-record)・学習ノートは
HyperHelix の `project/AIAgentDashboard` ブランチへ、プロダクトのコード・ドキュメントは本リポジトリへコミットする。

## トークン消費の自己確認
長い作業の途中や Distill の前に `/token-usage`(= `node src/cli.mjs`)で現在のセッションの消費・コンテキスト量・
ツール別の文脈追加を確認し、提案に沿って進め方を調整する(README「AI エージェントから使う」)。
