# 自分のプラットフォームを動かす（運営者向け）

この文書は、E.L.V.A.R. を Supabase と Vercel で動かし、ほかの人にも使ってもらいたい人のためのものです。
「使う人」向けの案内は `docs/USER_GUIDE.md` にあります。

先に読んでください。

- 運営者は、利用者のAIキーを持ちません。利用者が自分のキー（Gemini は必須）を、アプリの中で入れます。プラットフォームの環境変数にAIキーを入れても、利用者の処理には使われません。
- 運営者が Vercel と Supabase の両方の画面を見られると、ノートと会話を平文で読めます。利用者に正直に伝えてください。くわしくは `docs/SECURITY.md` にあります。
- 本物の Supabase での通しの確認が、まだ終わっていない部分があります。`docs/ELVAR_MULTIUSER.md` の §12〜§18 にある「未着手・要確認」を読んでください。この文書の手順は、コードと設計から書いたものです。画面の名前は、Supabase や Vercel の更新で変わることがあります。

## 0. 無料プランについて

作って試すあいだは、Supabase と Vercel の無料プランで足ります（決定 O5/O6）。
**公開サービスとして始める前に、有料プランに切り替えてください。**
最新の上限と規約は、各社のページで確かめてください。次の点に気をつけます。

- Supabase の無料プランは、使われないとプロジェクトが止まることがあります。バックアップも当てにできません。有料プランに上げて、バックアップを有効にしてください。
- Supabase の無料プランでは、プロジェクト全体の「1ファイルのアップロード上限」が **50MB まで**で、バケットの上限もそれを超えられません（Supabase の公式ドキュメント「Storage → Uploads → Limits」で確認済み。有料プランは最大 500GB まで）。E.L.V.A.R. の既定の 1ファイル上限は 60MB（オーナーの決定 O1）なので、**無料プランで動かすときは `ELVAR_MAX_FILE_BYTES=52428800`（50MB）を設定してください**。そうしないと、50MB を超えるファイルは「予約は通るが、アップロードが Storage に断られる」状態になります。有料プランに上げて 60MB 以上にしたいときは、Supabase ダッシュボードの Storage Settings の「Global file size limit」も上げてください（こちらは手作業です）。
- Supabase 標準のメール送信は、数がとても少なく、本番に使えません。独自のSMTPが必要です（§1.6）。
- パスワードの漏洩チェックなど、一部の認証機能は上位のプランで使えます。
- Vercel の無料（Hobby）プランは、商用利用ができない決まりです。公開サービスには、有料プランが必要です。
- 関数の実行時間は、プランで上限が違います。`vercel.json` は、`agent-run` に 60 秒、`chat` に 40 秒などを指定しています。
- 定期処理（Cron）は、1日1回だけです（`vercel.json` の `crons`）。有料プランでは、`/api/elvar/cron/daily` の頻度を上げられます（例: `*/15 * * * *`。どの手順も繰り返して安全で、軽い処理です）。未完了のアップロードの掃除と、削除済みアカウントの残りのファイルの掃除が、その分すばやくなります。

## 1. Supabase

必要なもの: Supabase のアカウント、Node.js 22.12 以上、Supabase CLI（任意。SQLエディタだけでも進められます）。

### 1.1 プロジェクトを作る

1. Supabase で新しいプロジェクトを作ります。データベースのパスワードは、長いものにして、安全な場所に保管します。
2. 次の値を控えます（あとで Vercel に入れます）。
   - プロジェクトの URL（`https://<project-ref>.supabase.co`）→ `SUPABASE_URL`
   - 公開キー（publishable key、または anon key）→ `SUPABASE_PUBLISHABLE_KEY`
   - 秘密キー（secret key、または service_role key）→ `SUPABASE_SECRET_KEY`。これは強い権限のキーです。他人に見せません。

### 1.2 マイグレーション

`supabase/migrations/` のファイルを、ファイル名の順に適用します。全部で 19 本です（`20261110000001` 〜 `20261110000019`）。

CLI を使う場合:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

CLI を使わない場合は、SQLエディタに、ファイルを順に貼って実行します。

マイグレーションは、次のものを作ります。

- 非公開スキーマ `app`、サーバー用ロール `elvar_app`、全ユーザーデータのテーブル（RLS 強制）。
- 非公開の Storage バケット `user-files`（1ファイル 60MB。`ELVAR_MAX_FILE_BYTES` または `app.platform_config` の `max_file_bytes` を変えると、バケットの上限もトリガーで同じ値になります）と `user-exports`（512MB）。作る SQL がマイグレーションの中にあります。
- サインアップの制限用の関数（`app.before_user_created`）と、運営者用の設定テーブル。

日本語の全文検索は、PGroonga が使える環境では PGroonga、なければ `pg_trgm` を、マイグレーションが選びます。PGroonga の側は、本物の Supabase ではまだ確かめていません。

Data API（PostgREST）には、`app` スキーマを出さないでください。`supabase/config.toml` の `api.schemas` は `public` と `graphql_public` だけです。ホスティングされたプロジェクトでは、ダッシュボードの API 設定で、同じになっているか確かめます。

### 1.3 `elvar_app` ロールと `ELVAR_DB_URL`

SQLエディタで、パスワードを付けます。

```sql
alter role elvar_app password '<長いランダムな文字列>';
```

接続文字列は、Supavisor の「transaction」モード（ポート 6543）で作ります。

```
ELVAR_DB_URL=postgres://elvar_app.<project-ref>:<パスワード>@<pooler-host>:6543/postgres
```

`<pooler-host>` は、ダッシュボードの接続（Connect）画面に出ます。

**`ELVAR_DB_URL` は、全ユーザーの行を読める資格情報と同じです。** 他人に見せません。漏れたときは、`elvar_app` のパスワードを替えます。

### 1.4 認証の設定

ダッシュボードの Authentication で設定します。

| 項目 | 設定 |
|---|---|
| メール確認（Confirm email） | ON |
| パスワードの長さ | 10 文字以上（ローカル用の `supabase/config.toml` は、さらに大文字・小文字・数字を要求します） |
| 安全なメール変更・パスワード変更 | ON |
| 匿名サインイン | OFF |
| 署名鍵（JWT Signing Keys） | 非対称の鍵（ES256 か RS256）。サーバーは HS256 を受け付けません |
| リフレッシュトークンのローテーション | ON |
| アクセストークンの有効期限 | 1時間（既定） |

**URL の設定（URL Configuration）**

- Site URL: `https://<あなたのアプリのアドレス>`
- Redirect URLs（許可リスト）:
  - `https://<あなたのアプリのアドレス>/auth/callback`
  - `com.elvar.mark1://auth-callback`（Android 用）
  - `elvar://auth-callback`（デスクトップ用）

Android とデスクトップを使わないときも、入れておいて構いません。

### 1.5 Google でサインイン

1. Google Cloud で、**運営者の** OAuth クライアント（種類は「ウェブ アプリケーション」）を作ります。
2. 承認済みのリダイレクト URI に、`https://<project-ref>.supabase.co/auth/v1/callback` を入れます。
3. Supabase の Authentication → Sign In / Providers で、Google を有効にし、クライアント ID とシークレットを入れます。

このクライアントが求める範囲は `openid email profile` だけです。カレンダーやGmailなどの**データ連携は別物**です。データ連携は、利用者がそれぞれ自分のクライアントを作って使います（決定 O2）。運営者が、共通のGoogleクライアントを用意する必要はありません。

### 1.6 SMTP（確認メールの送信）

Authentication の SMTP 設定に、Resend や Amazon SES などの送信サービスを入れます。
送信元のドメインは、SPF と DKIM を設定してください。

### 1.7 サインアップの制限の Hook（必須）

**ホスティングされたプロジェクトは `supabase/config.toml` を読みません。** 手で有効にします。

Authentication → Hooks → 「Before User Created」→ Postgres function → スキーマ `app`、関数 `before_user_created` → 有効にする。

この手順を飛ばすと、サインアップの制限（open / invite / closed、1日の上限、使い捨てメールの拒否）が**効きません**。

サインアップの方針は、SQLエディタで変えます。

```sql
update app.platform_config set value = 'invite' where key = 'signup_mode';   -- open | invite | closed
```

- `invite` のときは、`app.signup_invites` に、許可するメールアドレス（小文字）を入れます。
- `daily_signup_limit`（1日の新規登録数、既定 500）と `ip_daily_signup_limit`（同じネットワークから1日に何件か、既定 5）も、同じ表で変えられます。
- サインアップ画面の表示も、同じ表から読みます。画面と実際の制限は食い違いません。

### 1.8 Turnstile（CAPTCHA、おすすめ）

1. Cloudflare で Turnstile のサイトを作ります。
2. **シークレットキー**を、Supabase の Authentication の CAPTCHA 設定（Attack Protection）に入れます。
3. **サイトキー**（公開してよい方）を、Vercel の `ELVAR_TURNSTILE_SITE_KEY` に入れます。

CSP は、`vercel.json` で `challenges.cloudflare.com` を許可済みです。

### 1.9 Storage

マイグレーションが、バケット `user-files` と `user-exports` を作ります。ダッシュボードの Storage で、2つとも**非公開（Private）**になっているか確かめます。
バケットにポリシーを足さないでください。本人の接頭辞 `users/<uid>/` だけを読める規則が、マイグレーションに入っています。

## 2. Vercel

### 2.1 プロジェクトを作る

1. このリポジトリを GitHub に置き、Vercel でインポートします。
2. `vercel.json` に、ビルドの設定があります（`npm install`、`npm run build`、出力は `web/dist`）。変えなくて構いません。
3. 環境変数を入れます（§2.2）。**秘密のものは、Sensitive にします。**
4. デプロイします。

### 2.2 環境変数

| 名前 | 必須 | 中身 |
|---|---|---|
| `SUPABASE_URL` | 必須 | §1.1 の URL |
| `SUPABASE_PUBLISHABLE_KEY` | 必須 | §1.1 の公開キー |
| `SUPABASE_SECRET_KEY` | 必須 | §1.1 の秘密キー。Auth の管理操作（削除、停止、管理者の印）と、Storage の掃除だけに使われます |
| `ELVAR_DB_URL` | 必須 | §1.3 の接続文字列 |
| `ELVAR_KEK` | 必須 | 利用者の鍵を包む鍵。`<id>:<base64 の32バイト>`（下を見てください） |
| `CRON_SECRET` | 必須 | 16文字以上の秘密の文字列。Vercel Cron が `Authorization: Bearer ...` で送ります。無いと、cron のルートは 503 を返します |
| `ELVAR_BOOTSTRAP_ADMIN_EMAIL` | おすすめ | 最初の管理者のメールアドレス（§3） |
| `ELVAR_TURNSTILE_SITE_KEY` | 任意 | §1.8 のサイトキー |
| `ELVAR_SIGNUP` | 任意 | `open`、`invite`、`closed`。データベースが無いときの表示だけに使われます。実際の制限は §1.7 の表です |
| `ELVAR_MAX_FILE_BYTES` | 任意 | 1ファイルの上限（バイト、1MB〜5GB。既定 62914560 = 60MB）。cron がデータベース（`app.platform_config` の `max_file_bytes`）に書き込み、Storage バケットの上限もトリガーで同じ値になります。**Supabase の無料プランは 52428800（50MB）** |
| `ELVAR_DEFAULT_LIMITS` | 任意 | 1アカウントごとの既定のハード上限（JSON）。例: `{"geminiCallsPerDay":2000,"requestsPerMinute":120}`。管理者が1人ずつ変えられます |
| `ELVAR_DELETION_RECEIPT_WEBHOOK` | 任意 | アカウント削除が完了したとき、`{to, subject, text}` を受け取る https の URL。確認メールは、あなたの側で送ります |
| `ELVAR_KEK_PREV` | 回転中だけ | 古い KEK（複数はカンマ区切り） |
| `ELVAR_PUBLIC_ORIGIN` | 通常は不要 | Vercel 上では、このデプロイのホストが使われます。Vercel の外で動かすときに設定します |

書式の見本は `.env.example` にあります。

**`ELVAR_KEK` の作り方**

```bash
openssl rand -base64 32
```

出てきた文字列の前に、鍵の名前と `:` を付けます。例: `k1:<出力>`。

- **KEK をなくすと、全員のAPIキーとトークンが読めなくなります。** 安全な場所に控えを置いてください。データベースにも、リポジトリにも置きません。
- 回転するときは、新しい鍵を `ELVAR_KEK` に、古い鍵を `ELVAR_KEK_PREV` に入れます。

**入れてはいけないもの**: `GEMINI_API_KEY` などのAIキーは、プラットフォームの環境変数に要りません。`ELVAR_ALLOW_PRIVATE_CONNECTORS` は、共通プラットフォームでは絶対に使いません（Vercel では無視されます）。`ELVAR_DEV_AUTH` と `ELVAR_DB=memory` も、本番に入れません。

### 2.3 Cron

`vercel.json` が、毎日 `/api/elvar/cron/daily`（04:17 UTC）を呼びます。次の掃除をします。

- 期限切れの一時データの削除。
- 最初の管理者への権限の付与。
- 削除の猶予（7日）が終わったアカウントの完全削除。
- 書き出しファイルと、未完成のアップロードの掃除。
- 保存容量の数え直し。

## 3. 最初の管理者

1. Vercel に `ELVAR_BOOTSTRAP_ADMIN_EMAIL` を入れて、再デプロイします。
2. そのメールアドレスで、サインアップして、確認メールのリンクを開きます（確認済みのアカウントだけが管理者になれます）。
3. 次の cron を待つか、手で呼びます。

   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET>" https://<あなたのアプリのアドレス>/api/elvar/cron/daily
   ```

4. 一度ログアウトして、入り直します。権限は、新しいトークンから有効になります。
5. 設定に「管理」タブが出ます（`docs/admin.png`）。

管理者に見えるのは、メール、日付、状態、容量、利用回数だけです。人格、会話、ノート、ファイル、キーは見えません。できるのは、停止と解除、容量の変更、ハード上限の変更です。

## 4. 動作の確認

システムチェックは、ログインしている**本人の**接続を確かめるものです（Geminiのキー、Google、第二の脳など）。プラットフォーム全体の診断ではありません。次の順で確かめます。

1. `https://<あなたのアプリのアドレス>/api/health` が応答する。
2. 管理者とは別のメールアドレスで、サインアップする。確認メールが届く（SMTP の確認）。
3. ウィザードで、自分の Gemini キーを入れる。「保存して確認」が通る。
4. HUD の「システムチェック」（上のバーの立方体のアイコン、または声で「システムチェック」）を実行する。「ログイン」と「Gemini（音声会話）」が「ok」になる。
5. ファイルを1つ取り込む。「ファイル」の画面に出て、容量のメーターが増える（Storage の確認）。
6. 「私のデータ」で、書き出しを始めて、zip をダウンロードできる。
7. 2人目のアカウントで、1人目のデータが何も見えない。
8. 管理者の画面で、2人の一覧が出て、中身は見えない。
9. サインアップの制限が効いている（`closed` にして、新しい登録が断られる）。

## 5. アプリ（任意）

### Android

GitHub Actions の「Build Android assistant APK」を使います。

1. Actions → 「Build Android assistant APK」→ Run workflow。
2. `url` に、デプロイ先の URL を入れます（またはリポジトリ変数 `ELVAR_URL`）。空のときは、アプリが初回に聞きます。
3. できた `app-debug.apk`（Artifacts の `elvar-assistant-apk`）を、スマホに入れます。

Google サインインは、WebView では拒否されます。アプリは、Custom Tab を開いて `com.elvar.mark1://auth-callback` で戻ります。§1.4 のリダイレクト URL に入れてください。
くわしくは `android/README.md` にあります。

### デスクトップ（Electron）

```bash
cd desktop
npm install
npm start -- --url=https://<あなたのアプリのアドレス>
```

拍手で窓を前面に出し、トレイに常駐します。`elvar://auth-callback` を、Google サインインの戻りに使います。
Windows での挙動は、まだ確かめていません。くわしくは `desktop/README.md` にあります。

### Chrome 拡張

アプリの `/extension/` ページに、ダウンロードと手順があります。`extension/README.md` も読んでください。

## 6. 運営のあと

- **鍵の管理**: KEK の控え、`ELVAR_DB_URL`、`SUPABASE_SECRET_KEY` を、安全に保ちます。
- **削除の依頼**: 利用者は、自分で完全に消せます。バックアップには、削除後も最大7日間残ることがあります。
- **プライバシーポリシーと利用規約**: アプリの `/privacy/` と `/terms/`（`web/public/privacy/index.html`、`web/public/terms/index.html`）は、**1人で使う人向けのテンプレートのままです**（「会員登録はありません」などと書いてあります）。複数の人に公開するときは、必ず書き直してください。運営者の情報、データを持つ場所（Supabase と Vercel）、運営者が平文のノートと会話を技術的には読めること、削除のしかた、法律（日本の個人情報保護法。必要ならGDPR）を入れます。
- **脆弱性の連絡窓口**: `docs/SECURITY.md` を読んでください。
