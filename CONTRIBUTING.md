# 開発に加わる

E.L.V.A.R. への貢献を歓迎します。このファイルは、開発の準備と、**すべての変更が守る決まり**を書いたものです。

## 準備

必要なもの: Node.js 22.12 以上。`npm run test:db` には Docker も要ります。

```bash
npm install
npm run build
ELVAR_DB=memory ELVAR_DEV_AUTH=1 npm run dev:server
```

表示されたアドレス（既定は http://127.0.0.1:8787）を開くと、偽のログインとメモリ上のデータで、サインアップから HUD まで試せます。確認メールは `/dev-supabase/dev/mailbox` にあります。データは、サーバーを止めると消えます。

画面を直しながら試すときは、`ELVAR_DB=memory ELVAR_DEV_AUTH=1 npm run dev`（サーバーと Vite を一緒に起動）を使います。

本物の Supabase を使うときは `docs/SETUP.md` と `supabase/README.md` を読んでください。`.env.example` に環境変数の見本があります。`.env` は、決してコミットしません。

## テスト

| コマンド | Docker | 中身 |
|---|---|---|
| `npm test` | 不要 | 単体テスト、メモリ上のDB（`MemoryDb`）での契約テスト、API の分離テスト、マイグレーションの静的検査、公開用の検査（public-scrub） |
| `npm run test:db` | 必要 | 使い捨ての Postgres（既定は `postgres:17`）を Docker で起動し、マイグレーションを適用して、RLS・2ユーザーの分離・削除の残り確認・Storage のポリシー・契約テストを、本物の Postgres で動かす |

- `ELVAR_TEST_DB_IMAGE` で、Docker のイメージを変えられます。
- 使い捨てのデータベースがすでにあるときは、`ELVAR_TEST_DB_ADMIN_URL`（スーパーユーザーの URL）を使えます。`app` スキーマは、消して作り直されます。必ず使い捨てのものにしてください。
- `npm run build` も通してください。
- CI（`.github/workflows/test.yml`）が、プルリクエストごとに `npm test`、`npm run build`、`npm run test:db` を動かします。

変更には、テストを付けてください。バグを直すときは、先に落ちるテストを書きます。

## すべての変更が守る決まり

`CLAUDE.md` の「E.L.V.A.R. の基本方針」にある7つの原則が、いちばん上です（README を見てください）。守れない変更は、入れません。

### 1. すべてのデータは `userId` で分ける

- 別のユーザーのデータに届く道を作りません。作っていないことを、テストで確かめます。
- 新しいテーブルは、スキーマ `app` に置き、`user_id uuid not null default auth.uid() references auth.users (id) on delete cascade` を付け、`select app._secure('<表>', '<操作>')` で閉じます（RLS の有効化と強制、`anon`/`public` の権限なし、標準のポリシー）。
- 複合キーとインデックスは、`user_id` から始めます。子テーブルは、`(user_id, parent_id)` で親につなぎます。
- 保存先のキーとパスは、必ずユーザーごとの名前空間を通して作ります。Storage は `users/<uid>/...` です。ブラウザの localStorage と IndexedDB は、`web/public/ns.js` の名前空間を通します。
- サーバーの SQL は、`server/db/` の repos だけに書きます。`asUser(uid)` に渡すユーザーIDは、検証を通ったものだけです。
- service role（`SUPABASE_SECRET_KEY`）は、`server/db/service.js` だけが読みます。ほかで import するとテストが落ちます（`test/service-role-usage.test.mjs`）。
- プラットフォームの環境変数にある AI キーに、フォールバックしません。ユーザーの設定として読める新しいキーは、`server/config/keys.js` の台帳で `platform: true` を付けたものだけです（許可リスト方式）。

### 2. 新しい保存データは、台帳・エクスポート・完全削除に入れる

新しいテーブルを足すとき、次を**すべて**行います。

1. マイグレーション（`supabase/migrations/`）で、`app.data_registry` に行を入れる。
2. `server/rights/registry.js` に、同じ内容を書く（エクスポートのファイル、外に出さない列、編集できるか、`{{uid}}` を使った固定データの INSERT、削除の方法）。
3. `server/rights/mydata-types.js` で、「私のデータ」の種類のどれか**ちょうど1つ**に入れる。
4. Storage に置くものは、ユーザーごとの接頭辞の下に置き、エクスポートと削除の対象にする。

これを忘れると、`test/migrations-lint.test.mjs`、`test/mydata.test.mjs`、`test/export-job.test.mjs`、`npm run test:db` のどれかが落ちます。落ちたら、台帳を直してください。テストを弱めないでください。

### 3. 新しい API は、ルーターに足す

- Vercel の関数は増やしません。新しい入口は、`server/router.js` の表に足します（`api/elvar.js` が受けます）。
- ルートごとに `auth` の種類（`user`、`admin`、`device:<scope>`、`cron` など）を決めます。
- `none`、`state`、`cron` 以外のルートは、「他人のIDで叩くケース」のテストが要ります（`test/routes-isolation.test.mjs`）。無いと落ちます。

### 4. 容量と利用量

- 保存するデータは、容量に数えます。AIや外部サービスの呼び出しは、`server/usage.js` の経路で、本人の利用量に数えます。
- 上限は、ブレーキであり、鍵ではありません。大切な確認（容量など）は、サーバーで行います。

### 5. 個人情報を入れない

このリポジトリは、公開されます。次を入れないでください。

- 実在の人の名前、学校、勤め先、アカウント名、メールアドレス、住所。例には `example.test` のようなダミーを使います。
- APIキーやトークン。テストのダミーも、本物に見える形（`AIza...` など）にしないでください。
- 旧ブランドの名前（`test/public-scrub.test.mjs` が検査します）。

`test/public-scrub.test.mjs` が、全ファイルを検査します。

- 本物に見える秘密と、旧ブランドの名前は、必ず見つけます。
- 個人名などの「非公開の語」の一覧は、**それ自体が個人情報**なので、コミットしません。手元の `.scrub-terms.local`（`.gitignore` 済み、1行に1語）か、環境変数 `ELVAR_SCRUB_TERMS`（改行区切り。CI ではリポジトリのシークレット）から読みます。一覧が無いときは、この検査は飛ばされます。手元に一覧を置いて、テストを動かしてください。
- 一覧の中身を、コミット、Issue、プルリクエスト、チャットに書かないでください。

### 6. 文書

- 利用者向けの文書は `docs/USER_GUIDE.md`、運営者向けは `docs/SETUP.md`、設計は `docs/ELVAR_MULTIUSER.md` です。仕組みを変えたら、該当する文書も直します。
- 確かめていないことを、「動く」と書かないでください。未確認は、未確認と書きます。
- 文は短く、やさしく書きます。

## プルリクエストの前に

- [ ] `npm test` が通る。
- [ ] DB やマイグレーションを触ったなら、`npm run test:db` が通る。
- [ ] `npm run build` が通る。
- [ ] 新しい保存データは、台帳・エクスポート・削除に入れた。
- [ ] 新しいルートに、分離のテストを足した。
- [ ] 個人情報と秘密を入れていない。
- [ ] 文書を直した。

## AIツールで作業する人へ

このリポジトリで AI コーディングツールを使うときは、`CLAUDE.md` を読んでください。7つの原則と、作業の種類ごとのモデルの使い分けが書いてあります。

## ライセンス

貢献は、MIT ライセンス（`LICENSE`）で公開されることに同意したものとして、受け付けます。
