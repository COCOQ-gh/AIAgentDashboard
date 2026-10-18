# AI Agent Dashboard

Claude Code が `~/.claude/projects/` に残すトランスクリプト(JSONL)を読み取り、
**どの指示(プロンプト)でどれだけトークンを消費したか**をブラウザで可視化するローカルツール。
外部依存なし(Node.js 18 以上のみ)。データは読み取り専用で、どこにも送信しない。

## 使い方

```bash
npm start
```

`http://127.0.0.1:4317/` を開く。初回は全ファイルを走査する(数百 MB で 10〜20 秒程度)。
以後はファイルの size/mtime が変わったものだけ再パースする。「再走査」ボタンで最新化。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | 走査対象ディレクトリ |
| `PORT` | `4317` | 待受ポート |
| `HOST` | `127.0.0.1` | 待受アドレス(ローカル専用のまま使うこと) |

テスト: `npm test`

## 画面

- **合計タイル** — 合計 / 出力 / キャッシュ読取 / 指示数 / セッション数
- **トークン消費の多い指示** — 1 本 = 人間の 1 指示。積み上げ色はキャッシュ読取・キャッシュ作成・入力・出力
- **プロジェクト別** / **セッション一覧** — セッションをクリックすると指示ごとの内訳(時系列)
- 各グラフは「表で見る」で同じ数値を表に切り替えられる

## 集計ルール(src/parse.mjs・src/scan.mjs)

- **指示** = `type: user` かつ `origin.kind === "human"` の行(旧形式は tool_result でも isMeta でもない user 行)。
  スキル本文などの注入(`isMeta`)やツール結果は指示に数えない。
- **トークン** = `type: assistant` の `message.usage`(input / cache_creation / cache_read / output)。
  1 応答は複数行に分割記録され同じ `message.id` と同じ usage を持つので、`message.id` で 1 回だけ数える。
- **帰属** = assistant 行は promptId を持たないため、同一ファイル内で「直前の指示」に帰属させる。
- **サブエージェント** = `<project>/<sessionId>/subagents/agent-*.jsonl`。先頭 user 行の `promptId` で親の指示に合流する。
- **フォーク / 再開** = 新しいセッションファイルに履歴が丸ごと複製されるため、全ファイル横断で `message.id` を
  重複排除し、複製で中身が空になった指示は落とす(開始時刻 → ファイル更新時刻の昇順で先のファイルが所有)。

## API

| パス | 内容 |
|---|---|
| `GET /api/overview` | プロジェクト別集計と全体合計 |
| `GET /api/prompts?project=&since=&sort=total|output|recent&limit=` | 指示一覧 |
| `GET /api/sessions?project=` | セッション一覧 |
| `GET /api/session?id=` | 1 セッションの指示別内訳 |
| `POST /api/rescan` | 再走査 |

## 開発プロセス

タスクは HyperHelix(`doc/HyperHelix/` にネスト)のタスクループで実行する。詳細は `CLAUDE.md`。
