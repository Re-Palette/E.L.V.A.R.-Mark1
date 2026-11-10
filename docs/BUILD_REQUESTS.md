# 製作依頼（ELVAR → Claude Code）

この機能は、**利用者ごとの任意の機能**です。リポジトリとトークンは、あなた専用の設定（トークンは暗号化して保存）で、ほかの利用者にも運営者にも見えません。
運営者は、環境変数を設定する必要はありません。使わない人は、何も設定しなくて構いません。
依頼の記録は、あなたのアカウントの「ビルド依頼」（「私のデータ」で見て、書き出して、消せます）に入ります。

ELVARに「〇〇を作って」と頼むと、次の流れで進みます（企画書は作りません）。

1. ELVARが、頼んだ内容を、そのまま、短く**復唱して声で確認**します。同時に、**依頼内容つきの確認カード**が画面に出ます。
2. 声で「**はい**」と言うか、ボタン「**依頼する**」を押すと、そのまま送られます（「直す」「やめる」もあります）。短い「はい」だけが承認になります。長い話や、ELVARが話している間の声は、承認になりません。
3. 承認すると、あなたの製作用リポジトリ（設定 `BUILD_REPO`）に **Issue**（本文の先頭が `@claude …`）が作られます。リポジトリに入れた **Claude Code Action** が、ブランチを切って実装し、**Pull Request** を作ります。
4. ELVARは、Issueのコメント・PR・状態を読み取り、**要約**して、画面の活動欄・通知・音声で知らせます。「製作の状況は？」でいつでも確認できます。完了・確認待ちの結果は `製作/<名前>/結果.md` にも残ります。

「企画書を作って」と頼んだときだけ、製作企画担当が `製作/<名前>/企画書.md` を作ります。

## 用意するもの（あなた側）

### 1. 製作用のGitHubリポジトリ
空のリポジトリでも構いません（Claude Codeが中身を作ります）。第二の脳のミラー（任意）に使うリポジトリとは**別**にしてください（コードが混ざらないように）。

### 2. Claude Code Action を入れる（公式ドキュメントで確認済みの手順）
1. https://github.com/apps/claude からGitHubアプリを入れ、対象リポジトリに製作用のものだけを選びます。権限の更新の求め（黄色い帯の「Review request」）が出たら承認します。
2. リポジトリのシークレットに、次のどちらかを登録します。
   - `ANTHROPIC_API_KEY`：Claude ConsoleのAPIキー（従量課金）。
   - `CLAUDE_CODE_OAUTH_TOKEN`：Pro/Max等のサブスクの枠で動かすトークン。PCで `claude setup-token` を実行して得ます。
3. `.github/workflows/claude.yml` を作ります（下は、`@claude` を含むIssue・コメントに反応する形。OAuthトークンの場合は、`anthropic_api_key` の行を `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` に変えます）。

```yaml
name: Claude Code
on:
  issues: { types: [opened, assigned] }
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  claude:
    if: contains(github.event.issue.body, '@claude') || contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write, issues: write, id-token: write, actions: read }
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

`@claude` を送れるのは、リポジトリに書き込み権限のある人間のアカウントです（ELVARは、あなたのトークンでIssueを作るので、この条件を満たします）。

### 3. ELVAR側の設定（あなた専用。環境変数ではありません）
| 名前 | 入れる場所 | 内容 |
|---|---|---|
| `BUILD_REPO` | 設定 → 連携アプリ → 製作依頼 | `owner/name`（上のリポジトリ） |
| `BUILD_GITHUB_TOKEN` | 設定 → APIキー →「製作依頼の GitHub トークン」 | 細かい権限のトークン：対象はそのリポジトリだけ。Issues = Read and write、Pull requests = Read、Contents = Read、Actions = Read、Metadata = Read |

設定したら、「APIの接続状況は？」で「GitHub（Claude Codeへの製作依頼）」が「接続中」になることを確認します。Claude Codeのワークフローが見つからないときは、その旨が出ます。

`CLAUDE_SESSION_RUN_LIMIT`（任意）は、5時間あたりの実行回数の目安を入れる設定です（公式の上限ではありません）。

## 注意
- **費用**：Claude Code Action は、あなたのAnthropicの利用枠（またはAPIキー）を使います。依頼のたびに承認カードが出るのは、そのためです。
- **完成の保証はありません**：Claude Codeの成果は、PRの内容をあなたが確認するまで「未確認」です。ELVARも、そう伝えます。
- **通知**：ELVARが知らせられるのは、このアプリが開いている間です。閉じている間は、GitHubのスマホアプリやメールの通知（Issue・PRのウォッチ）が先に届きます。次に開いたとき、ELVARが「留守中の更新」として伝えます。
- 企画書には、パスワードやキーを書きません（環境変数の名前だけ）。


## E.L.V.A.R.自身の改造（自己改造）

「エルヴァーに〇〇の機能を足して」「ここを直して」と頼むと、`build_request`（`target=self`）で **あなたが指定した E.L.V.A.R. のリポジトリ（設定 `BUILD_SELF_REPO`。自分のフォークなど）** にIssueが作られ、Claude Code Actionが **Pull Request** を作ります。

共通プラットフォームそのものは、これでは変わりません。変わるのは、あなたのリポジトリのコードだけです。共通プラットフォームを直したい人は、`CONTRIBUTING.md` に沿ってプルリクエストを送ってください。

- 承認カードに「E.L.V.A.R.自身の改造」と出ます（声で「はい」またはボタンで承認）。
- Claude Codeには、**mainへ直接コミットしない・`npm test` と `npm run build` を通す・承認の仕組みや認証、「嘘をつかない」等の規則は依頼に無い限り変えない**、と指示します。
- PRができると、`.github/workflows/test.yml` が、テストとビルドを自動で実行します。**マージはあなたが、PRの内容とテスト結果を見て行います**（マージして再デプロイするまで、今の動作は変わりません）。
- 状況は「製作の状況は？」で、新規製作と自己改造の両方がまとめて出ます。

### 用意するもの
1. あなたのフォーク（E.L.V.A.R.のコードのコピー）に、上と同じ手順で **Claude Code Action**（`.github/workflows/claude.yml` とシークレット）を入れる。
2. 設定の `BUILD_SELF_REPO` に `your-account/your-elvar-fork` を入れる。`BUILD_GITHUB_TOKEN` の対象に、このリポジトリを加える（Issues = Read and write、Pull requests / Contents / Actions = Read）。
3. （おすすめ）GitHubの Settings → Branches で、`main` に「Require status checks（Test）」を付け、テストが通らないPRをマージできないようにする。
