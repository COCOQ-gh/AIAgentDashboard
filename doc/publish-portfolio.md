# ポートフォリオとして GitHub に公開する手順

このリポジトリを GitHub の公開リポジトリにして、ポートフォリオとして見せられる状態にするための手順。
上から順に進める。各段に「完了条件」があり、満たしてから次の段へ進む。

調査時点(2026-11-17)の状態:

| 項目 | 状態 | 公開への影響 |
|---|---|---|
| リモート | 未設定(`git remote -v` が空)。GitHub にも同名リポジトリなし | 新規作成から始める |
| 履歴 | `main` に 16 コミット。作成者は 1 人 | 書き換えても他人への影響はない |
| コミットの作成者メール | 16 件すべてが個人の Gmail アドレス | **公開すると誰でも見られる**(段 1-2) |
| `doc/HyperHelix/` | `.gitignore` 済み。リモートの HyperHelix リポジトリは **private** | 公開リポジトリからは見えず、参照だけが残る(段 1-1) |
| `.claude/settings.json` | 3 つのフックが `doc/HyperHelix/tools/compaction-hooks.mjs` を呼ぶ | clone した人の Claude Code で、プロンプトのたびにフックエラーが出る |
| `.claude/commands/` | `helix` `cycle` `sync` `compact-prep` は HyperHelix 用、`token-usage` は本ツール用 | HyperHelix 用の 4 つは clone した人には使えない |
| 秘密情報 | 全履歴の追加行を API キー・トークン・パスワードの形で検査して 0 件 | なし(段 3 で再確認) |
| 個人のパス | 追跡ファイル・全履歴に `C:\Users\<ユーザー名>` は 0 件。テストに `H:\proj` 等の架空パスのみ | なし |
| LICENSE | なし | 無いと他人は法的に使えない(段 2-1) |
| スクリーンショット・CI | なし | ポートフォリオとしての見栄えに直結(段 2-3・2-4) |
| 依存パッケージ | なし(Node.js 18 以上のみ)。`package.json` は `"private": true` | npm への誤公開は防がれている。そのままでよい |

## 段 0. 先に決めること

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| 0-1 | HyperHelix 連携をどう見せるか | **A: 公開リポジトリから実行部分を外し、README で「開発プロセス」として説明する** | B(HyperHelix も公開)は別プロジェクトの公開判断になる。A なら clone した人の環境でフックエラーが出ない |
| 0-2 | コミットの作成者メール | **GitHub の noreply アドレスに書き換える** | リモート未設定・作成者 1 人なので、書き換えても壊れるものがない。公開後に直すと force push が要る |
| 0-3 | 履歴を残すか | **残す** | `TASK-…` 付きのコミット列は「計測 → 改善」の進め方を見せる材料になる |
| 0-4 | ライセンス | **MIT** | 依存がなく単独作者なので制約がない。ポートフォリオで最も一般的 |
| 0-5 | リポジトリ名と README の言語 | `AIAgentDashboard`、README は日本語のまま冒頭に英語の概要を数行 | 海外の閲覧者にも何のツールか伝わる |

完了条件: 5 項目が決まっている。以降は推奨案で書く。

## 段 1. 公開してはいけないものを外す

### 1-1. HyperHelix 連携を外す(0-1 で A を選んだ場合)

1. `.claude/settings.json` を削除する(中身は HyperHelix のフックだけ)。手元では使い続けたいなら、同じ内容を
   `.claude/settings.local.json` へ移す(`.gitignore` 済みなので公開されない)
2. `.claude/commands/helix.md` `cycle.md` `sync.md` `compact-prep.md` を追跡から外す。手元には残したいので
   `git rm --cached` で外し、`.gitignore` に 4 ファイルを追加する。`token-usage.md` は本ツールの機能なので残す
3. `CLAUDE.md` の「開発プロセス」節(HyperHelix のタスクループの説明)を `CLAUDE.local.md`(Claude Code が読む手元専用ファイル。
   `.gitignore` に追加)へ移す。「調査・計測・編集の作法」は
   本ツールの開発知見なので残してよい。ただし `TASK-…` の出典表記はそのまま読めるので変えなくてよい
4. `README.md` の「開発プロセス」節を、外部の人が読める説明に書き換える。例:
   「AI エージェント(Claude Code)と自作のタスクループ(調査 → 計画 → 実行 → 評価 → 蒸留)で開発した。
   各コミットの `TASK-…` がタスク 1 件に対応する。フレームワーク本体は非公開」
5. `TODO.md` のプロセス節が `CLAUDE.md` を前提にしているので、3 の後で文面が成り立つか確認する

確認: `git grep -n HyperHelix` の残りが、意図して残した説明文だけであること。

### 1-2. コミットの作成者メールを書き換える(0-2)

GitHub 側の設定を先にする(ブラウザで本人が操作):

1. GitHub → Settings → Emails で **Keep my email addresses private** をオンにする
2. 同じ画面の **Block command line pushes that expose my email** をオンにする(誤 push を GitHub が拒否する)
3. 同じ画面に表示される `<数字>+COCOQ-gh@users.noreply.github.com` を控える(または `gh api user --jq .id` で数字を得る)

手元の作業(このリポジトリだけに効く設定にする):

```bash
git clone --mirror . ../AIAgentDashboard-backup.git
```

```bash
git config user.email "<数字>+COCOQ-gh@users.noreply.github.com"
```

```bash
git filter-branch --env-filter 'export GIT_AUTHOR_EMAIL="$(git config user.email)"; export GIT_COMMITTER_EMAIL="$(git config user.email)"' -- --all
```

- 3 行とも Git Bash で実行する(PowerShell では引用符の扱いが違う)
- `git filter-repo` は未導入なので標準の `filter-branch` を使う(16 コミットなら一瞬で終わる)。日時とメッセージは変わらない
- 書き換え後、`git for-each-ref refs/original` に旧履歴が残るので、確認が済んだら
  `git update-ref -d refs/original/refs/heads/main` で消す。バックアップは `../AIAgentDashboard-backup.git`
- **ネストの HyperHelix リポジトリは対象外**(別リポジトリで、private のまま)。そちらのメールは変えなくてよい

確認: `git log --format='%ae %ce' | sort -u` が noreply アドレス 1 行だけになること。

完了条件: 1-1・1-2 の確認がどちらも通る。

## 段 2. ポートフォリオとして見せる形に整える

### 2-1. LICENSE

リポジトリ直下に `LICENSE`(MIT、年 = 2026、名義 = GitHub のユーザー名など公開してよい名前)を置き、
`package.json` に `"license": "MIT"` を追加する。

### 2-2. README の冒頭を「3 秒で伝わる」形にする

今の README は使い方と仕様の説明から始まる。冒頭に次を足す(既存の本文はそのまま下に残す):

1. 1 行の説明(日本語)と英語の概要 2〜3 行
2. スクリーンショット 1 枚(2-3 で作る `doc/images/dashboard.png`)
3. 「作った理由」1〜2 行: AI エージェントのトークン消費が、どの指示・どのキャッシュ再作成で膨らんだかを見たかった
4. 「技術的な見どころ」箇条書き。本リポジトリで実測・実装済みのものだけを書く:
   - 外部依存ゼロ(Node.js 標準ライブラリのみ)
   - `worker_threads` で初回走査を並列化(129 ファイル / 414 MB で逐次 3.8 s → 1.1 s。OS キャッシュが温まった状態の値)
   - キャッシュ作成の原因推定(モデル切替・アイドル・圧縮)と、キャッシュ読取の構成推定
   - ローカル専用サーバとしての防御(Host / Origin 検査)
   - CDP で実ブラウザを駆動してレイアウトを実測する検査ツール(`tools/shot.mjs`)
   - `node:test` によるテスト(件数は公開時の `npm test` の値を書く)
5. CI のバッジ(2-4 の後)

### 2-3. スクリーンショットは合成データで撮る

実データで撮ると、プロジェクト名・ローカルのパス・**指示(プロンプト)の本文**が画像に写る。
公開してよい内容だけで構成した合成データを用意して撮る。

1. 合成トランスクリプトを生成するスクリプト(例: `tools/make-demo-data.mjs`)を作る。架空のプロジェクト 3〜4 個・
   数日分のセッション・複数モデル・圧縮やアイドル後の再作成を含め、各タブが空にならないようにする。
   形式はテストの `test/*.test.mjs` が使っている JSONL 行を手本にする
2. `CLAUDE_PROJECTS_DIR` に生成先を指定してサーバを起動し、`tools/shot.mjs` で撮影する
   (`tmp/` は `.gitignore` 済みなので、採用する画像だけ `doc/images/` へコピーする)
3. 撮った画像を拡大して、実在のパス・名前・指示本文が写っていないことを目で確認する

### 2-4. CI(GitHub Actions)

`.github/workflows/test.yml` を追加し、push と pull request で `npm test` を回す。
Windows 固有のパス処理(`H:\` 形式のテスト)があるので、`ubuntu-latest` と `windows-latest` の両方で回す。
Node.js は 22 / 24(`npm test` のグロブ指定 `node --test "test/**/*.test.mjs"` は Node 21 以降の機能のため)。
依存がないので `npm ci` は不要。

完了条件: 手元で `npm test` が通り、README を GitHub 上と同じように Markdown プレビューで読んで、
画像とリンクが切れていない。

## 段 3. 公開前の最終確認

上から順に実行し、すべて期待どおりなら段 4 へ進む。

| # | 確認 | 期待 |
|---|---|---|
| 3-1 | `npm test` | 全件 pass |
| 3-2 | 全履歴の秘密スキャン(段 1 の書き換え後に再実行): `git log -p --all` の追加行を `sk-ant-` `ghp_` `github_pat_` `AKIA` と `api_key=` `password=` 形で検索。`gitleaks` を使えるなら `gitleaks git .` も | 0 件 |
| 3-3 | 個人情報: `git grep -niE '<Windowsのユーザー名>\|gmail'` と、`git log --format='%an %ae %cn %ce %B'` に同じ検索 | 0 件 |
| 3-4 | 作成者メール: `git log --format='%ae %ce' \| sort -u` | noreply 1 行 |
| 3-5 | 追跡ファイルの一覧: `git ls-files` を目で読む | 公開してよいものだけ(`tmp/`・`doc/HyperHelix/`・`settings.local.json` が無い) |
| 3-6 | 素の環境での動作: 別ディレクトリへ `git clone` し、そこで `npm test`、`CLAUDE_PROJECTS_DIR` を合成データに向けて `npm start` | テスト pass、画面が出る、Claude Code で開いてもフックエラーが出ない |

## 段 4. GitHub に作って公開する

まず **private で作って** CI と見え方を確かめてから public にする(公開後に直すと、直す前の状態を誰かが見ている可能性がある)。

```bash
gh repo create AIAgentDashboard --private --source . --remote origin --push --description "Claude Code のトークン消費を指示ごとに可視化するローカルダッシュボード"
```

1. GitHub 上で README・画像・CI の結果を確認する(CI が赤なら直してから進む)
2. トピックを付ける:

```bash
gh repo edit --add-topic claude-code,token-usage,dashboard,nodejs,developer-tools
```

3. 公開する(**取り消しても、公開中に clone された分は戻らない**ので、段 3 が全部通ってから):

```bash
gh repo edit --visibility public --accept-visibility-change-consequences
```

4. 公開後に GitHub 上で Settings → Code security の **Secret scanning** と **Push protection** が有効か確認する
5. プロフィールに固定表示する(プロフィール画面の「Customize your pins」。ブラウザで本人が操作)

完了条件: ログアウト状態(シークレットウィンドウ)でリポジトリの URL を開き、README・画像・CI バッジが見える。

## 段 5. 公開後の運用

- 以後のコミットは `git push` で公開される。`.claude/settings.local.json` と HyperHelix 用コマンドは `.gitignore` 済みなので、
  手元の開発プロセス(`/helix`)はこれまでどおり使える
- 作業記録(hh-record)は今までどおり HyperHelix の `project/AIAgentDashboard` ブランチ(private)へ入る。
  公開リポジトリのコミットには入らない
- 本ファイル(`doc/publish-portfolio.md`)は公開作業の記録として残してよい。公開リポジトリに含めたくなければ段 4 の前に削除する
