# E.L.V.A.R. マルチユーザー化 設計（1つの共通プラットフォーム × 多数のユーザー）

状態: 設計。**P1（土台）・P2（ログインとユーザー単位の設定）・P3（Google・コネクタ・ビルド依頼）・P4（記憶: 第二の脳・会話・通知箱・通知中継）は実装済み**（§12〜§15 に実装メモ）。P5 以降は未実装 / 前提: `docs/ELVAR_ARCHITECTURE.md` の Phase 1–4 実装済みツリー（オーナー1人用 Vault・デバイストークン・ルーター・コネクタ）
最優先の規則: `CLAUDE.md`「E.L.V.A.R. の基本方針」7原則。この文書のどの判断もそれより下位。

---

## 0. 決定事項（先に結論）

| # | 論点 | 決定 |
|---|------|------|
| M1 | データ基盤 | Supabase（Postgres + RLS、Storage、Auth）。Upstash / FileStore / オーナー Vault は廃止（MemoryStore はテスト用に残す） |
| M2 | DB への入り方 | **テーブルは非公開スキーマ `app` に置き、Data API（PostgREST）に出さない**。サーバーは専用ロール `elvar_app` で Supavisor（transaction mode）に接続し、リクエストごとのトランザクションで `set local role authenticated` ＋ `request.jwt.claims` を設定してから SQL を打つ → **RLS が常に効く**。service role は §3.4 の一覧だけ |
| M3 | 認証 | Supabase Auth（メール＋パスワード、メール確認必須、Google サインイン、パスワード再設定、CAPTCHA）。サーバーは `Authorization: Bearer <access_token>` を JWKS（非対称署名鍵）で検証。Android のバックグラウンド通知同期だけ、ユーザーごと・用途限定の **デバイストークン** を残す |
| M4 | ユーザーの秘密 | アプリ層の envelope 暗号: ユーザーごとの DEK（32B 乱数）を、Vercel env の KEK（`ELVAR_KEK`、鍵 ID 付き、将来は外部 KMS に差し替え可）で AES-256-GCM ラップ。Supabase Vault / pgsodium は採らない（§4） |
| M5 | AI の費用 | ユーザー持ち込みキーのみ（Gemini 必須、Groq/Exa/NewsData/Sarashina 任意）。**プラットフォームの env にある AI キーへは絶対にフォールバックしない**（テストで固定） |
| M6 | ファイル | 原本は Supabase Storage `user-files` の `users/<uid>/...`。ブラウザから Storage へ直接アップロード（Vercel の 4.5MB 本文上限を避ける）。抽出テキスト・索引はサーバー DB。IndexedDB は「ユーザーごとに名前を分けたキャッシュ」に格下げ、サインアウトで消す |
| M7 | 第二の脳 | GitHub リポジトリ → `app.notes`（Markdown 本文をそのまま行に）。`brain.js` の関数名・引数は維持し、裏側だけ差し替え。GitHub/Obsidian への同期は「本人の GitHub トークンを使う任意のコネクタ」 |
| M8 | 検索 | 日本語全文検索は `pgroonga`（Supabase で利用可）。長期記憶のベクトル検索は `pgvector`（埋め込みはユーザーの Gemini キーで作る・任意）。最初は HNSW を張らず、`user_id` で絞った正確検索 |
| M9 | 一時データ | レート制限・承認チケットの使用済み記録・OAuth 途中状態・MCP セッション ID は Postgres の TTL 付きテーブル（`pg_cron` で掃除）。Redis 不要 |
| M10 | Vercel 関数 | 9本のまま増やさない。新しいエンドポイントはすべて `api/elvar.js` のルーター。定期処理は Vercel Cron → `/api/elvar/cron/*`（`CRON_SECRET`） |
| M11 | 管理者 | アプリ内の管理者は「メタデータ（メール、作成日、状態、使用量）」だけ見えて、停止・上限変更ができる。**人格・会話・ノート・ファイル・秘密は見られない**（RLS で管理者用ポリシーを作らない、管理画面は SECURITY DEFINER 関数が返す列だけ） |
| M12 | データの権利 | 削除は `auth.users` からの `on delete cascade` ＋ Storage の明示削除 ＋ 外部トークンの失効 ＋ 鍵の破棄（crypto-shred）。全テーブルが「エクスポート台帳」「削除検証」に載っていることを **カタログ駆動テスト** で強制 |

---

## 1. 現状（オーナー1人用）からの差分

| 現状のもの | 何が1人前提か | マルチユーザーでの扱い |
|---|---|---|
| `server/config/vault.js`（meta/doc、パスワードラップ、端末ラップ） | 全体で DEK 1個 | 暗号の部品（`seal`/`open`/`hkdf`/AAD 付き `sealRecord`）だけ `server/crypto/envelope.js` へ移して再利用。meta・端末ラップ・パスワードラップは削除 |
| `server/config/auth.js`（セットアップコード、claim、login、端末） | 最初の1人がオーナー | Supabase Auth に置換。`clientIp`/`addrKey`/`isLoopback` とレート制限の考え方は再利用 |
| `server/config/with-owner.js` | owner しかいない | `server/auth/with-user.js`: `withUser` / `withAdmin` / `withDevice(scope)` / `withCron` |
| `server/config/resolve.js`（ALS、`env()`、`cfgEnv`） | Vault doc を読む | ALS と `env()` はそのまま。`getConfig(req)` を「JWT 検証 → `app.settings`・`app.user_secrets`・`app.profiles` を読む」に。**`secret` 種別は process.env へフォールバックしない** |
| `server/config/keys.js` | — | 再利用。各キーに `scope:'user'|'platform'` を追加（AI キー・GitHub トークン=user、`METNO_USER_AGENT` 等=platform） |
| `server/store/*` | 1つの Redis | `memory.js`/`local.js` はテスト用に残す。`upstash.js`/`file.js` 削除。新規 `server/store/pg.js`（同じ `get/set/del/incr` を `app.kv_ephemeral` で） |
| `server/router.js` | auth: none/owner/state | 再利用。auth 種別を `none`/`user`/`admin`/`device:<scope>`/`state`/`cron` に |
| `server/connectors/data.js` `scope()`/`currentScope()` | 既に「ここだけ差し替えれば per-user」 | `currentScope()` が ALS の `userId` を返し、保存先を `app.connectors`/`app.connector_tools`/`app.user_secrets`/`app.oauth_tokens` に。他の connectors/* はほぼ無変更 |
| `server/oauth/flow.js` | pending を Redis に | 再利用。pending を `app.oauth_pending` に、`claim` 時に `pending.user_id == 要求者` を検査 |
| `server/google/*` | オーナー自作の OAuth クライアント | 既定は **プラットフォームの OAuth クライアント**（§8.3）。「自分の Cloud クライアントを使う」は上級者向けに残す。`http.js` のアクセストークンキャッシュは `user_id` 単位 |
| `server/brain.js` + finance/shift/course/project-intel | GitHub の1リポジトリ | `NotesRepo` に差し替え（§8.5）。上位モジュールは `brainReadRaw`/`brainWrite` 経由なのでロジック無変更 |
| `server/notif-sync.js` | Redis の1キー | `app.notif_items`（user_id 付き、暗号文のまま、3日 TTL） |
| `server/build.js` | env の `BUILD_*` | 本人の `BUILD_GITHUB_TOKEN`/`BUILD_REPO`（user_secrets / settings）。`app.build_requests` で追跡 |
| `server/google/ticket.js` | HMAC 鍵 = 全体 DEK 由来 | `HKDF(userDEK, "elvar-approval-ticket-v2")`、ペイロードに `uid`。使用済み記録は `app.ticket_uses` |
| `server/live-token-core.js` | env/Vault の Gemini キー、時間あたり発行数は全体 | 本人の Gemini キーで発行、発行数は本人単位、`usage_events` に記録 |
| `web/src/file-store.js`（IndexedDB が正） | 端末だけ | Storage と DB が正。IndexedDB は `elvar-files-<uidHash>` のキャッシュ |
| `web/src/usage.js`（localStorage） | 端末ごとの集計 | サーバーの `usage_daily` が正。端末は Live 時間の心拍を送るだけ |
| `web/src/conv-log.js`, `inbox.js`, `agents.js` の報告, `builds.js` | localStorage / 脳のノート | サーバー（`messages`, `inbox_items`, `build_requests`）。送信待ちキューだけ端末に残す（ユーザー名前空間付き） |
| `web/src/elvar/auth.js` | デバイストークン | Supabase Auth のセッション（`@supabase/auth-js` のみ同梱）。`authHeaders()` の差し替え点は維持 |
| `web/src/setup/*` | セットアップコード → オーナーパスワード | サインアップ → メール確認 → Gemini キー → プロフィール → 人格 → 任意の連携 |
| `extension/` | サーバーと通信しない（拍手でウィンドウ前面化だけ） | **認証不要のまま**。通知同期は Android 側の機能なので拡張機能には関係しない |

---

## 2. 本人確認と認証

### 2.1 Supabase Auth の設定

- Email: `Confirm email = ON`、`Secure email change = ON`、パスワード最低 10 文字＋漏洩パスワード検査（HaveIBeenPwned、Pro 以上）。
- Google サインイン: スコープは `openid email profile` だけ。**Google データ連携（Calendar 等）とは別の同意**にする（§8.3）。サインイン時の `provider_token` は保存しない。
- CAPTCHA: Cloudflare Turnstile を Supabase Auth に設定（signup / signin / reset / OTP 全部）。CSP の `script-src`/`frame-src` に `challenges.cloudflare.com` を追加。
- SMTP: 独自 SMTP（Resend / SES など）必須。Supabase 既定の SMTP は送信数が極小で本番に使えない。
- Auth Hook `before_user_created`（Postgres 関数）: 使い捨てメールのドメイン拒否、`ELVAR_SIGNUP=open|invite|closed`（自前運用者向け）、1日の新規登録数の上限。
- Auth Hook `custom_access_token`: `app_metadata.elvar_role`（`admin` のみ）をクレームに載せる。`app_metadata` はユーザーが書き換えられない。
- JWT: 非対称署名鍵（ES256）を有効化。アクセストークン有効期限 1時間（既定）、refresh token rotation ON。
- Redirect URL 許可リスト: `https://<platform>/auth/callback`, `com.elvar.mark1://auth-callback`, `elvar://auth-callback`。

### 2.2 サーバーでの検証（`server/auth/jwt.js`, `server/auth/with-user.js`）

```js
// verifyAccessToken(token) -> { uid, email, role:'user'|'admin', iat, aal, sessionId }
//   jose.jwtVerify(token, createRemoteJWKSet(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), { issuer: `${SUPABASE_URL}/auth/v1`, audience: 'authenticated' })
//   拒否: role!=='authenticated', is_anonymous, exp 切れ, sub が uuid でない
// withUser(handler): verify → app.accounts.status を確認（30秒の warm cache） → suspended / pending_deletion は 403
//   → runWithConfig(userCfg, () => handler(ctx))  ctx = { uid, db: asUser(uid), cfg, jwt }
// withAdmin: withUser + role==='admin' + app.admins に行がある（二重確認）
// requireFresh(ctx, 600): 削除・メール変更・エクスポート・管理操作は iat が 10分以内（古ければ 401 reauth_required → クライアントが再ログイン）＋ auth.getUser(jwt) で失効していないか確認
```

- JWKS はインスタンス内でキャッシュ（ネットワーク往復なし）。失効の即時反映が要る操作だけ `getUser`。
- Cookie は使わない（CSRF なし）。CORS は出さない（同一オリジン）。`JSON 以外の書き込み → 415` は維持。

### 2.3 端末ごとのログイン

| 端末 | 方法 |
|---|---|
| ブラウザ | `@supabase/auth-js`（PKCE）。セッションは localStorage（キー `sb-<ref>-auth-token`）。`authHeaders()` → `{ authorization: 'Bearer ' + access_token }`。401 で refresh → 再試行1回 → ログイン画面 |
| Android（WebView） | 同じ Web アプリ。メール＋パスワードは WebView 内。**Google サインインは WebView が拒否される**ので、WebView が PKCE を開始（verifier は WebView の localStorage）→ Kotlin が Custom Tab で認可 URL を開く → `com.elvar.mark1://auth-callback?code=` で戻る → `window.__elvarAuthCode(code)` → WebView が `exchangeCodeForSession` |
| Android（バックグラウンド通知同期 `NotifSync.kt`） | WebView が `POST /api/elvar/devices {name, scopes:['notif:push','notif:pull']}` で **デバイストークン** `elv2.<deviceId>.<secret>` を発行し、`setSyncConfig(baseUrl, deviceToken, enabled, notifSecret)` で Kotlin に渡す。サーバーは `sha256(secret)` だけ保存。使えるのは `/api/notif` だけ。設定画面から失効可 |
| デスクトップ（Electron） | 同じ Web アプリを固定パーティションで表示。Google サインインはシステムブラウザ ＋ `elvar://auth-callback`（`app.setAsDefaultProtocolClient`）で Android と同じ受け渡し。`preload.js` の `accessToken`（env トークン）は削除 |
| Chrome 拡張 | サーバー通信なし。変更不要 |

refresh token をネイティブ側に渡さない理由: WebView と同時に更新すると refresh token の再使用検出でセッションごと失効するため。

### 2.4 管理者

- `app.admins(user_id pk, granted_by, granted_at)` ＋ `app_metadata.elvar_role='admin'`（両方必要）。最初の管理者は `ELVAR_BOOTSTRAP_ADMIN_EMAIL` に一致するメールが確認済みになった時点で `cron/daily` が付与（自前運用者もこれで済む）。
- 管理者が **できる**: ユーザー一覧（id、メール、作成日、最終ログイン、状態、保存容量、使用量の集計）、停止／解除（`accounts.status` ＋ Auth の `ban_duration`）、ハード上限の変更、迷惑行為によるアカウント削除の開始、監査ログ（管理者操作）の閲覧。
- 管理者が **できない**: 人格・設定・会話・ノート・ファイル・コネクタ定義・秘密の閲覧。管理者用の RLS ポリシーは作らず、管理画面は `app.admin_*` の SECURITY DEFINER 関数（返す列を固定）だけを呼ぶ。
- 正直な限界（プライバシーポリシーに書く）: Supabase と Vercel のダッシュボードを持つ **運営者** は、技術的には DB の平文（ノート・会話）を読める。秘密（API キー・トークン）は KEK が DB の外なので DB だけでは読めない。§4.4。

### 2.5 消えるもの・残るもの

| 旧 | 扱い |
|---|---|
| セットアップコード、`/setup/claim`、オーナーパスワード、パスワードラップ | 削除 |
| `x-elvar-token` のデバイストークン（全権） | 削除。Android 通知専用・用途限定の `elv2` トークンとして形だけ残す |
| `ELVAR_ACCESS_TOKEN`（env モード）、ループバック無認証 | 削除（ローカル開発もローカル Supabase で本物のログイン） |
| `notifSecret`（通知暗号の鍵素材） | 残す。ユーザーごとに `user_secrets.NOTIF_SECRET`、`/api/elvar/session` で本人の端末にだけ返す |
| `GET /api/elvar/state` | 残す（`{signup, captchaSiteKey, supabaseUrl, publishableKey, version}` を返す公開情報） |

---

## 3. テナント分離

### 3.1 原則

1. ユーザーのデータを持つ全テーブルに `user_id uuid not null default auth.uid() references auth.users(id) on delete cascade`。
2. 全テーブル `enable row level security` ＋ `force row level security`。
3. ポリシーは型どおり（`(select auth.uid())` で initPlan 化し速度を確保）:
   ```sql
   create policy own_select on app.<t> for select to authenticated using (user_id = (select auth.uid()));
   create policy own_insert on app.<t> for insert to authenticated with check (user_id = (select auth.uid()));
   create policy own_update on app.<t> for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
   create policy own_delete on app.<t> for delete to authenticated using (user_id = (select auth.uid()));
   ```
   書き込みを制限したい表（`accounts`, `usage_*`, `quota`, `audit_log`, `ticket_uses`）は select だけ、または insert だけ。
4. 複合インデックスは必ず `user_id` を先頭に。
5. 主キーが他ユーザーと衝突しても漏れないよう、子テーブルの外部キーは `(user_id, parent_id)` の複合で張る（他人の親行にぶら下げられない）。

### 3.2 サーバーの DB 接続（`server/db/`）

```
server/db/pool.js      postgres(ELVAR_DB_URL, { prepare:false, max:3 })  // Supavisor :6543 transaction mode、ロール elvar_app
server/db/as-user.js   asUser(uid, fn) = sql.begin(async tx => {
                          await tx`select set_config('request.jwt.claims', ${JSON.stringify({sub:uid, role:'authenticated'})}, true)`;
                          await tx`set local role authenticated`;
                          return fn(repos(tx, uid)) })
server/db/repos/*.js   notes, files, messages, connectors, secrets, settings, usage ... (SQL はここだけ)
server/db/memory.js    MemoryDb: 同じ repos インターフェースの in-memory 実装（npm test 用）
server/db/service.js   service role（§3.4 の用途だけ。ここ以外で import したらテスト失敗）
```

- `elvar_app` ロール: `login noinherit nobypassrls`、`grant authenticated to elvar_app`、スキーマ `app` の所有者ではない。claims を設定し忘れると `auth.uid()` が null → RLS で 0 行（**失敗は閉じる**）。
- `asUser(uid)` に渡す `uid` は、JWT 検証・デバイストークン検証・OAuth pending の照合のどれかを通った値だけ（型 `VerifiedUid` を返す関数経由に限定。素の文字列は受け付けない）。
- Data API は `public`/`graphql_public` だけ公開し、`app` は公開しない（`supabase/config.toml` の `api.schemas`）。ブラウザが anon key と自分の JWT で直接テーブルを触る道は無い → サーバー側の検証（容量・上限・承認）を迂回できない。
- **正直な限界**: `ELVAR_DB_URL`（`elvar_app` の接続文字列）は実質的に全テナント用の資格情報。`elvar_app` は `set role authenticated` のあと `request.jwt.claims` に任意のユーザー ID を書けるので、これを持つ人は全員分の行を読める（RLS は「サーバーのバグ」と「盗まれたユーザートークン」を防ぐもので、接続文字列の漏洩は防がない）。Sensitive env で保管し、漏れたら `elvar_app` のパスワードを替える。秘密（API キー）は別の資格情報（KEK）で守られる。
- 代替案（不採用）: supabase-js で PostgREST にユーザー JWT を付けて呼ぶ。RLS は効くが、同じ JWT を持つブラウザも直接書けるため、容量・使用量・状態の整合を全部 DB トリガーで守る必要が出る。

### 3.3 Storage

| bucket | 公開 | パス | 用途 |
|---|---|---|---|
| `user-files` | private, `file_size_limit = 60MB` | `users/<uid>/files/<fileId>/<sha256>` | 原本 |
| `user-exports` | private | `users/<uid>/exports/<jobId>/part-<n>.zip` | エクスポート（7日で削除） |
| `user-cache` | private | `users/<uid>/greetings/<cacheKey>.pcm` など | 再生成できる派生物（容量に数えない・削除対象） |

```sql
create policy files_read on storage.objects for select to authenticated using (
  bucket_id in ('user-files','user-exports','user-cache')
  and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid())::text);
create policy files_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'user-files' and (storage.foldername(name))[2] = (select auth.uid())::text
  and exists (select 1 from app.files f where f.user_id = (select auth.uid()) and f.object_path = name and f.status = 'pending' and f.reserved_until > now()));
create policy files_delete on storage.objects for delete to authenticated using (
  bucket_id in ('user-files','user-cache') and (storage.foldername(name))[2] = (select auth.uid())::text);
-- update ポリシーなし（上書き禁止）。user-exports への insert は service（エクスポート処理）だけ
```

ブラウザは自分の JWT で Storage に直接アップロード（6MB 超は TUS の再開可能アップロード）。予約（§6.2）が無いパスには書けない。

### 3.4 service role を使う場所（これ以外は禁止。`test/service-role-usage.test.mjs` が import 元を検査）

| 用途 | 理由 |
|---|---|
| `auth.admin.deleteUser`, `signOut(global)`, `updateUserById({ban_duration})`, `app_metadata` 付与 | Auth の管理 API は service role 専用 |
| 削除猶予が過ぎたユーザーの Storage 一括削除（cron） | 本人の JWT がもう無い |
| エクスポートの zip を `user-exports` に書く／cron での続き処理 | 本人の書き込み権を与えない（改ざん防止）＋ JWT 無しで続行 |
| 容量の照合（Storage の実サイズと `files.size_bytes` の突き合わせ、cron） | 全ユーザー横断の集計 |
| 管理画面の Auth 情報（最終ログイン等） | `auth.users` は service でしか読めない |

DB の行は service role でも `asUser` 経由でしか触らない（service 用の SQL も `where user_id = $uid` を必ず付け、レビューで確認）。

### 3.5 分離テスト

- **カタログテスト**（`supabase/tests/00_catalog.test.sql`, pgTAP）: スキーマ `app` の全テーブルで (a) RLS 有効＋force、(b) `user_id` 列あり（許可リスト `app.admins` 等を除く）、(c) `auth.users` への `on delete cascade`、(d) `app.data_registry` に登録済み（エクスポートと削除の対象。§7）、(e) `public` スキーマにユーザーデータの表が無い。
- **2ユーザーテスト**（`supabase/tests/10_isolation.test.sql`）: `tests.create_user('a')`, `('b')`、A として全テーブルにフィクスチャ（台帳の `fixture_sql`）を入れ、B として各表の select=0 行、update/delete=0 行、`user_id=A` の insert が拒否、A の Storage パスの read/insert/delete 拒否、を全表に対して自動で回す（表を足すと自動でテスト対象になる）。
- **API レベル**（`test/isolation.api.test.mjs`）: ルーター表 `ROUTES` の全エントリを列挙し、A のリソース ID を B の JWT で叩いて 404/403 になることを確認。`MemoryDb` 版（`npm test`）とローカル Supabase 版（`npm run test:db`）の両方で同じテストを回す。新しいルートに「他人の ID で叩くケース」の定義が無いとテストが失敗する。

---

## 4. ユーザーの秘密の暗号化

### 4.1 比較

| 観点 | (a) アプリ層 envelope（KEK=env/KMS、DEK=ユーザーごと） | (b) Supabase Vault | (c) pgsodium TCE |
|---|---|---|---|
| DB だけ漏れた場合 | 読めない（KEK が DB の外） | 鍵は Supabase 管理。DB 権限があれば `vault.decrypted_secrets` で平文 | 同左、かつ Supabase が非推奨化済み |
| アプリ内管理者・SQL エディタを使う人 | 平文は見えない | SQL エディタで全員分の API キーが見える → **M11 に反する** | 同左 |
| ユーザーごとの破棄（crypto-shred） | DEK 行を消せば、バックアップ内の暗号文も無意味 | 不可（共通鍵） | 不可 |
| 回転 | KEK: DEK の再ラップだけ（行数＝ユーザー数）。DEK: その人の秘密だけ再暗号化 | Supabase 任せ | — |
| 実装 | 既存 `vault.js` の部品を再利用 | 簡単 | 非推奨 |

**採用: (a)**。KEK は Vercel の Sensitive env（`ELVAR_KEK=<kid>:<base64 32B>`、回転中は `ELVAR_KEK_PREV`）。`KekProvider` を差し替え可能にし、将来 AWS/GCP KMS（`encrypt/decrypt` で DEK をラップ）に移せるようにする。

### 4.2 形式（`server/crypto/envelope.js`）

```
DEK_u          = 32B 乱数（初回サインイン時に生成）
app.user_keys  = { user_id, kek_id, dek_ver, wrapped: AES-256-GCM(KEK[kek_id], DEK_u, AAD="elvar:dek:v2|"+user_id+"|"+dek_ver) }
secret         = AES-256-GCM(DEK_u, value, AAD="elvar:sec:v2|"+user_id+"|"+name+"|"+dek_ver)
OAuth token    = 同じ（name = "oauth:google", "oauth:cx:<id>"）
ticketKey_u    = HKDF(DEK_u, salt=user_id, "elvar-approval-ticket-v2")
connectorKey_u = HKDF(DEK_u, salt=user_id, "elvar-connector-v2")   // 既存 connectorKeyFromDek の後継
```

AAD に `user_id` と名前を入れるので、行を別ユーザーや別の名前にすり替えても復号に失敗する（テスト）。warm インスタンスでは復号済み DEK を `user_id` キーで 60 秒だけ保持。

### 4.3 回転

- KEK: 新しい `kid` を `ELVAR_KEK` に、旧を `ELVAR_KEK_PREV` に → `cron/rewrap`（service ではなく `elvar_app` の SECURITY DEFINER 関数 `app.rewrap_batch()` で 500 行ずつ）→ 全行が新 kid になったら PREV を消す。
- DEK（ユーザーの「全端末からログアウトして鍵を作り直す」または漏洩疑い）: 新 DEK で本人の `user_secrets`/`oauth_tokens` を再暗号化（1トランザクション）、`dek_ver++`。承認チケットは自動で無効になる。

### 4.4 見える・見えない

| 主体 | API キー・トークン | ノート・会話・ファイル | メタデータ（容量・回数） |
|---|---|---|---|
| 本人（アプリ） | 書き込みのみ、`{set, last4, updatedAt}` だけ表示 | 閲覧・編集・エクスポート・削除 | 見える |
| 他のユーザー | 不可（RLS） | 不可（RLS ＋ Storage RLS） | 不可 |
| アプリ内管理者 | 不可 | 不可 | 見える |
| DB だけを入手した人 | 不可（KEK 無し） | **平文で読める** | 読める |
| 運営者（Vercel env ＋ DB の両方） | 技術的には可（サーバーが Live 発行や Google 更新に使う以上、避けられない） | 可 | 可 |

ノート・会話の保存時暗号化（列暗号）は検索（pgroonga/pgvector）が使えなくなるため採らない。未決 O4。

---

## 5. データモデル（`supabase/migrations/`）

```
supabase/
  config.toml                      # api.schemas = ["public","graphql_public"]（app は出さない）, auth hooks, storage buckets
  migrations/
    20261110000001_roles_schema.sql      # schema app, role elvar_app, extensions: pgroonga, vector, pg_cron, pgcrypto
    20261110000002_accounts.sql          # accounts, admins, profiles, settings, user_keys, user_secrets, devices, audit_log, data_registry
    20261110000003_ephemeral.sql         # kv_ephemeral, rate_limits, ticket_uses, oauth_pending + rl_hit()
    20261110000004_connectors.sql        # oauth_tokens, connectors, connector_tools, connector_tool_changes
    20261110000005_notes.sql             # notes, note_revisions, note_links
    20261110000006_conversations.sql     # conversations, messages
    20261110000007_files.sql             # files, file_texts, storage buckets + policies, quota triggers
    20261110000008_memory.sql            # memory_chunks (pgvector), embeddings jobs
    20261110000009_usage_quota.sql       # usage_events, usage_daily, usage_limits, storage_usage, quota functions
    20261110000010_inbox_notif_build.sql # inbox_items, notif_items, build_requests, agent_reports
    20261110000011_jobs_rights.sql       # export_jobs, deletion_requests, residual_check()
    20261110000012_admin_fns.sql         # admin_* security definer functions
    20261110000013_cron.sql              # pg_cron: TTL 掃除、保持期間
  tests/                                 # pgTAP（supabase test db）
    00_catalog.test.sql  10_isolation.test.sql  20_storage.test.sql  30_quota.test.sql  40_deletion.test.sql  50_admin.test.sql
  seed.sql                               # ローカル用のテストユーザー2人
```

### 5.1 主要テーブル（抜粋。全表に §3.1 の `user_id` と RLS）

```sql
create table app.accounts (                    -- select のみ本人。書き込みは definer 関数と service
  user_id uuid primary key references auth.users on delete cascade,
  status text not null default 'active' check (status in ('active','suspended','pending_deletion')),
  storage_quota_bytes bigint not null default 524288000,      -- 既定 500MB（O1 決定。管理者が人ごとに変更可）
  hard_limits jsonb not null default '{}',                    -- 管理者が設定（§6）
  suspended_reason text, created_at timestamptz default now());

create table app.profiles (                    -- 人格・呼び方・口調・あいさつ・声（原則2）
  user_id uuid primary key references auth.users on delete cascade,
  profile jsonb not null,                       -- server/profile/schema.js の形をそのまま（version 付き）
  updated_at timestamptz default now());

create table app.settings (user_id uuid primary key references auth.users on delete cascade, settings jsonb not null default '{}', updated_at timestamptz default now());

create table app.user_keys (user_id uuid primary key references auth.users on delete cascade, kek_id text not null, dek_ver int not null default 1, wrapped bytea not null, iv bytea not null, rotated_at timestamptz);

create table app.user_secrets (
  user_id uuid references auth.users on delete cascade, name text check (name ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  ct bytea not null, iv bytea not null, dek_ver int not null, last4 text, updated_at timestamptz default now(),
  primary key (user_id, name));                 -- GEMINI_API_KEY, GROQ_API_KEY, EXA_API_KEY, NEWSDATA_API_KEY, SARASHINA_API_KEY, BRAIN_GITHUB_TOKEN, BUILD_GITHUB_TOKEN, NOTIF_SECRET, cx:<id>:auth, cx:<id>:oauthSecret, GOOGLE_CLIENT_SECRET(BYO)

create table app.oauth_tokens (                 -- Google と MCP の OAuth（頻繁に更新されるので分ける）
  user_id uuid references auth.users on delete cascade, provider text,  -- 'google' | 'cx:<id>'
  ct bytea not null, iv bytea not null, dek_ver int not null,
  scopes text[] not null default '{}', status text default 'ok' check (status in ('ok','reauth_required')),
  revoke_url text, updated_at timestamptz default now(), primary key (user_id, provider));

create table app.devices (user_id uuid references auth.users on delete cascade, id text, name text, token_hash bytea not null unique, scopes text[] not null, created_at timestamptz default now(), last_seen_at timestamptz, primary key (user_id, id));

create table app.connectors (user_id uuid references auth.users on delete cascade, id text, manifest jsonb not null, enabled boolean default true, synced_at timestamptz, primary key (user_id, id));
create table app.connector_tools (user_id uuid, connector_id text, name text, def jsonb not null, hash text not null, enabled boolean, approval text, expose text,
  primary key (user_id, connector_id, name), foreign key (user_id, connector_id) references app.connectors(user_id, id) on delete cascade);

create table app.notes (                         -- 第二の脳（長期記憶）。Obsidian 互換のパス
  user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(),
  path text not null check (path ~ '\.md$' and length(path) <= 300), content text not null, bytes int generated always as (octet_length(content)) stored,
  tags text[] default '{}', deleted_at timestamptz, updated_at timestamptz default now(),
  primary key (user_id, id), unique (user_id, path));
create index notes_fts on app.notes using pgroonga (path, content);
create table app.note_revisions (user_id uuid, note_id uuid, rev int, content text, at timestamptz default now(), primary key (user_id, note_id, rev),
  foreign key (user_id, note_id) references app.notes(user_id, id) on delete cascade);   -- 既定30版・90日（git 履歴の代わり）

create table app.conversations (user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(), started_at timestamptz, channel text, primary key (user_id, id));
create table app.messages (user_id uuid, conversation_id uuid, id bigint generated always as identity, role text check (role in ('user','assistant','tool')),
  text text not null, at timestamptz not null, primary key (user_id, id),
  foreign key (user_id, conversation_id) references app.conversations(user_id, id) on delete cascade);
create index messages_user_at on app.messages (user_id, at desc);
create index messages_fts on app.messages using pgroonga (text);

create table app.files (
  user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(),
  name text not null, mime text, kind text, sha256 text not null, size_bytes bigint not null check (size_bytes between 0 and 62914560),
  object_path text not null, status text not null default 'pending' check (status in ('pending','ready','rejected')), reserved_until timestamptz,
  tags text[] default '{}', memo text, index jsonb, added_at timestamptz default now(), source text,
  primary key (user_id, id), unique (user_id, sha256));                     -- 本人の中だけで重複排除
create table app.file_texts (user_id uuid, file_id uuid, text text not null, bytes int generated always as (octet_length(text)) stored, primary key (user_id, file_id),
  foreign key (user_id, file_id) references app.files(user_id, id) on delete cascade);
create index file_texts_fts on app.file_texts using pgroonga (text);

create table app.memory_chunks (                -- 任意: 埋め込み（ユーザーの Gemini キー）
  user_id uuid, source text check (source in ('note','file','message')), source_id text, ix int, content text, embedding vector(768), model text,
  primary key (user_id, source, source_id, ix));
create index memory_chunks_user on app.memory_chunks (user_id);   -- HNSW は利用者が増えてから（§8.6）

create table app.usage_events (user_id uuid references auth.users on delete cascade, at timestamptz default now(), provider text, metric text, amount numeric, source text check (source in ('server','client')), meta jsonb);
create table app.usage_daily (user_id uuid references auth.users on delete cascade, day date, provider text, metric text, amount numeric not null default 0, primary key (user_id, day, provider, metric));
create table app.usage_limits (user_id uuid references auth.users on delete cascade, provider text, metric text, period text check (period in ('day','month')),
  soft numeric, soft_action text default 'warn' check (soft_action in ('warn','block')), primary key (user_id, provider, metric, period));
create table app.storage_usage (user_id uuid primary key references auth.users on delete cascade, files_bytes bigint default 0, text_bytes bigint default 0, notes_bytes bigint default 0, messages_bytes bigint default 0, reserved_bytes bigint default 0);

create table app.inbox_items (user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(), kind text, title text, body text, at timestamptz default now(), read_at timestamptz, primary key (user_id, id));
create table app.notif_items (user_id uuid references auth.users on delete cascade, id text, at timestamptz, iv text, ct text check (length(ct) <= 6000), primary key (user_id, id));   -- 暗号文のみ・3日
create table app.build_requests (user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(), repo text, issue_number int, pr_number int, state text, title text, created_at timestamptz default now(), primary key (user_id, id));

create table app.audit_log (user_id uuid references auth.users on delete cascade, id bigint generated always as identity, at timestamptz default now(),
  actor text check (actor in ('user','admin','system')), actor_id uuid, action text, target text, meta jsonb, primary key (user_id, id));   -- 本人は select のみ。1年保持

create table app.export_jobs (user_id uuid references auth.users on delete cascade, id uuid default gen_random_uuid(), status text, cursor jsonb, parts int default 0, bytes bigint default 0, created_at timestamptz default now(), expires_at timestamptz, error text, primary key (user_id, id));
create table app.deletion_requests (user_id uuid primary key references auth.users on delete cascade, requested_at timestamptz default now(), purge_after timestamptz not null, email_for_receipt text);

-- 一時データ（user_id あり、TTL）
create table app.kv_ephemeral (user_id uuid references auth.users on delete cascade, key text, value jsonb, expires_at timestamptz not null, primary key (user_id, key));
create table app.rate_limits (bucket text, who text, window_start timestamptz, n int, primary key (bucket, who, window_start));   -- who = user_id か IP の hash（未ログイン時）
create table app.ticket_uses (user_id uuid references auth.users on delete cascade, jti text, exp timestamptz, primary key (user_id, jti));
create table app.oauth_pending (state_hash bytea primary key, user_id uuid not null references auth.users on delete cascade, sealed bytea not null, expires_at timestamptz not null);

-- 台帳（§7）: 全ユーザーデータ表の一覧。カタログテストがこれと実テーブルを突き合わせる
create table app.data_registry (table_name text primary key, export_as text not null, editable boolean not null, fixture_sql text not null, counts_storage boolean not null);
```

家計・シフト・履修・プロジェクトは **今どおり第二の脳のノート**（`家計/YYYY-MM.md`、`シフト/…`、`履修/…`、`プロジェクト/<名前>/…`）として `app.notes` に入る。計算はすべて既存コードのまま。専用テーブルは作らない（エクスポートが Markdown のまま Obsidian で読める利点も維持）。

### 5.2 保持期間（`pg_cron`）

| データ | 既定 | 本人が変更 |
|---|---|---|
| `messages`（短期記憶） | 180日 | 7日〜無期限、「今すぐ全部消す」 |
| `note_revisions` | 30版かつ90日 | 不可 |
| `notif_items` | 3日 | 不可 |
| `usage_events`（生） | 90日（`usage_daily` は2年） | 不可 |
| `audit_log` | 1年 | 不可（削除時は消える） |
| `kv_ephemeral`, `oauth_pending`, `ticket_uses`, `rate_limits` | 各 TTL | — |
| ゴミ箱（`notes.deleted_at`, `files` の削除） | 30日後に完全削除 | 「完全に削除」で即時 |

---

## 6. 容量と利用量

### 6.1 計測点（サーバーが正）

| 対象 | 記録する場所 | metric |
|---|---|---|
| Gemini（通常音声・エージェント・ファイル解析・埋め込み） | `server/llm.js` の呼び出し口、`agents/provider.js` | `calls`, `input_tokens`, `output_tokens`（`usageMetadata` から） |
| Gemini Live | `live-token-core.js`（発行＝server）、クライアントの心拍 `POST /api/elvar/usage/live`（30秒ごと、`source:'client'`） | `live_sessions`, `live_seconds` |
| Groq / Exa / NewsData / Sarashina / Web 検索 | 各呼び出し口 | `calls`, tokens（Groq はヘッダーの残量も `kv_ephemeral` に） |
| Google API / コネクタ | `executeTool` | `calls`（コネクタ別） |
| プラットフォーム資源 | ルーター、Storage | `requests`, `storage_bytes`, `exports` |

`record_usage(provider, metric, amount, source)`（definer、`usage_events` に insert ＋ `usage_daily` に upsert）。呼び出しは応答後に投げっぱなしにせず `await`（ALS が切れる問題を避ける）。

### 6.2 保存容量（プラットフォームが費用を持つので強制）

数えるもの: `files.size_bytes`（原本）＋ `file_texts.bytes`（抽出テキスト）＋ `notes.bytes`（＋版）＋ `messages` の本文。トリガーで `storage_usage` を増減。

アップロードの流れ:
1. `POST /api/elvar/files/reserve {name, mime, size, sha256}` → 同じ sha256 があれば `{duplicate: fileId}`。無ければ `app.reserve_file()`（`accounts` 行を `for update` → `使用量 + reserved + size <= quota` と `hard_limits.maxFileBytes` を確認 → `files` に `pending`、`reserved_until = now()+30min`、`reserved_bytes += size`）→ `{fileId, objectPath}`。超過は `413 quota_exceeded {used, quota}`。
2. ブラウザが Storage に直接アップロード（予約のある path だけ RLS で許可）。
3. `POST /api/elvar/files/:id/finalize {index, text}` → `storage.objects` の実サイズと宣言を比較（違えば Storage を消して `rejected`）、テキストのバイトも含めて再確認、`ready` に。
4. 予約切れ・未完了は cron が掃除。cron の照合でずれを直し、超過ユーザーは新規アップロードだけ止める（既存データは消さない）。

### 6.3 上限

| 種類 | 誰が | 動作 |
|---|---|---|
| ソフト上限（例: Gemini Live 60分/日、Groq 500回/日） | 本人（`usage_limits`） | `warn`: HUD メーター 80%/100% と音声で一言。`block`: そのプロバイダの呼び出しを 429 `soft_limit` で止める（本人がいつでも解除） |
| ハード上限 | 管理者（`accounts.hard_limits`）。既定値は env `ELVAR_DEFAULT_LIMITS` | 保存容量、1ファイル最大、リクエスト/分（120）、Live 発行/時（30）、コネクタ呼び出し/日、エクスポート/日（1）、コネクタ数（20）、ノート数。超過は 429/413 |

AI の費用は本人のキー持ちなので、プラットフォームのハード上限は「インフラ保護と悪用防止」に限る。

### 6.4 画面

- 設定 → 「利用状況」: 今日・今月のメーター（プロバイダ別）、保存容量バー（原本／テキスト／ノート／会話の内訳）、ソフト上限の編集。`usage_report` 音声ツールは `GET /api/elvar/usage` を読む（`web/src/usage.js` の `buildReport` を流用、`scope` 文言を「すべての端末の合計」に）。
- 管理画面: ユーザーごとの容量・回数の一覧と並べ替え、上限変更。

---

## 7. データの閲覧・修正・エクスポート・完全削除（原則7）

### 7.1 台帳（`app.data_registry` ＋ `server/rights/registry.js`）

各テーブルについて: エクスポート時の形式、編集できるか、画面の場所、削除の方法（cascade / Storage / 外部失効）。**表を足したら台帳に足さないとカタログテストが落ちる**（CLAUDE.md の「新しい保存データはエクスポートと完全削除の対象に」を機械的に守る）。

### 7.2 閲覧・修正の画面（設定 → 「私のデータ」）

| データ | 見る | 直す | 消す |
|---|---|---|---|
| プロフィール・人格・声 | ○ | ○（既存 `settings/profile.js`） | 既定に戻す |
| 設定・API キー | 状態と last4 | 入れ替え | 個別に削除 |
| 連携（Google・コネクタ） | 状態・スコープ・道具 | ○ | 切断（失効つき） |
| 第二の脳（ノート） | 一覧・本文（既存 `brain-viewer.js`） | エディタ | ゴミ箱 → 完全削除 |
| 会話 | 日ごと・検索 | 1件ずつ削除 | 期間で削除、全削除 |
| ファイル | 一覧・プレビュー・抽出テキスト | 名前・タグ・メモ・種類 | ○ |
| 長期記憶の索引（埋め込み） | 件数 | 作り直し | 全削除 |
| 通知箱・報告・ビルド依頼 | ○ | 既読 | ○ |
| 利用量・監査ログ | ○ | — | （アカウント削除で消える） |
| 端末・セッション | ○ | 名前 | 失効、全端末からログアウト |

### 7.3 エクスポート

- `POST /api/elvar/export`（`requireFresh`、1回/日）→ `export_jobs` 作成。
- 処理: `POST /api/elvar/export/:id/step`（画面が開いている間クライアントが呼ぶ）と `cron/daily` が、1回 50 秒以内の分だけ進める（`cursor` に続きを保存）。`fflate` のストリーミング zip、1パート最大 500MB。
- 中身:
  ```
  manifest.json           {format:"elvar-export-v1", userId, exportedAt, tables:{name: rows}, files: n}
  profile.json settings.json usage.json audit.json devices.json
  secrets.json            名前・設定済みか・last4 だけ（値は入れない）
  connectors.json         既存 exportConnectors() の形（秘密抜き）
  notes/<path>.md         そのまま Obsidian で開ける
  conversations/<YYYY-MM-DD>.jsonl
  files/<id>-<name> と files/index.json（タグ・メモ・抽出テキストのパス）
  inbox.json builds.json
  ```
- 完了 → 通知箱とメールで知らせ、`createSignedUrl`（24時間）。zip は 7日で削除。
- 取り込み（同じ形式の zip から復元）は Phase P8 以降の任意機能。

### 7.4 アカウント削除

1. `POST /api/elvar/account/delete {graceDays: 0|7}`（`requireFresh`、パスワード再入力 or 再ログイン）→ `accounts.status='pending_deletion'`、`deletion_requests` 作成、全セッションを `signOut(global)`、デバイストークン失効。猶予中はログインすると「削除を取り消す」画面だけ出る。
2. 期限が来たら（猶予0なら即）`server/rights/purge.js`:
   1. Google の refresh token を `https://oauth2.googleapis.com/revoke` で失効。MCP の OAuth は `revoke_url` があれば失効。失敗は記録して続行（トークンは手順4で読めなくなる）。
   2. 任意: 本人の GitHub 同期コネクタは触らない（本人のリポジトリは本人の物）。
   3. Storage: `users/<uid>/` 以下を全 bucket で一覧 → 削除（1000件ずつ、繰り返し）。
   4. `app.user_keys` を削除（crypto-shred: バックアップに残る暗号文も復号不能）。
   5. `auth.admin.deleteUser(uid)` → `on delete cascade` で `app.*` の全行が消える。
   6. 検証: `app.residual_check(uid)`（台帳の全表で `count(*) where user_id = uid`）＝0、Storage の一覧＝0。0 でなければ管理者にアラート、ジョブは失敗のまま再試行。
   7. 削除完了メール（手順1で控えた宛先、送信後に控えも消す）。残すのは `deletion_receipts(id, completed_at, tables_checked)`（**user_id もメールも持たない**）。
3. バックアップ: Supabase の PITR/日次バックアップには保持期間（例 7日）だけ残る。プライバシーポリシーに明記。
4. テスト（`supabase/tests/40_deletion.test.sql` ＋ `test/purge.test.mjs`）: 台帳の `fixture_sql` で全表と Storage にデータを作る → purge → 全表 0 行、Storage 0 件、他ユーザーのデータは無傷、Google 失効のモックが呼ばれた。

---

## 8. 既存機能の移行（モジュール別）

### 8.1 対応表

| 現在 | マルチユーザー版 | 再利用度 |
|---|---|---|
| `server/persona*`, `profile/*`, `honesty.js` | `app.profiles` から `currentProfile()` | 再利用（読み出し元だけ変更） |
| `server/live-token-core.js` | 本人の `GEMINI_API_KEY` で発行。発行数を本人単位（`rate_limits`）。挨拶キャッシュキーに `uid` を含める | 小改修 |
| `server/chat-api.js`, `llm.js`, `agents/*`, `predict.js`, `sarashina.js`, `routing.js` | `env()` 経由で本人のキー。`usage` 記録を追加 | 小改修 |
| `server/google/*` | §8.3 | 中改修 |
| `server/tools/execute.js`, `google/ticket.js`, `web/src/approval.js` | 承認チケットに `uid`、鍵は本人 DEK 由来、使用済みは `ticket_uses` | 小改修 |
| `server/connectors/*` | `data.js` の保存先を repos に。`allowPrivate` はプラットフォームでは **常に無効**（他人が運営側の内部網を探れるため。`ELVAR_ALLOW_PRIVATE_CONNECTORS=1` は自前の単独運用だけ） | 小改修 |
| `server/brain.js` | §8.5 | 中改修 |
| `finance.js`, `shift.js`, `course.js`, `project-intel.js`, `hud-data.js`, `briefing` | 変更なし（brain API 経由）。`project-intel` の会話ログ読み出しだけ `messages` へ | ほぼ無変更 |
| `web/src/conv-log.js` | 送信先を `POST /api/elvar/messages`。サーバーで `redactSecrets` 後に保存。「公開リポジトリには書かない」検査は不要に | 小改修 |
| `server/build.js`, `web/src/builds.js` | 本人の GitHub トークン・リポジトリ。`build_requests` で追跡。`BUILD_SELF_REPO`（ELVAR 自身の改造）は既定で無効、本人が自分のフォークを指定した場合だけ | 小改修 |
| `server/notif-sync.js`, `api/notif.js`, `NotifSync.kt` | §8.4 | 小改修 |
| `server/api-status.js`, `system-check.js` | 本人のキーの疎通。プラットフォーム側（DB・Storage・KEK）の確認は管理者だけ | 小改修 |
| `web/src/file-*` | §8.2 | 大改修（保存先） |
| `web/src/usage*.js` | サーバー集計の表示に | 中改修 |
| `web/src/inbox.js`, `agents.js` の報告 | `inbox_items` | 小改修 |
| `web/src/setup/*` | サインアップ以降の手順に | 中改修 |
| `web/src/settings/*` | `account.js`（メール・パスワード・セッション・削除・エクスポート）、`device.js`（端末=通知トークン）、新規 `usage.js`, `data.js`, `admin/*` | 中改修 |
| `server/config/vault.js`, `auth.js` のオーナー部分、`store/upstash.js`, `store/file.js` | — | 削除 |

### 8.2 ファイル（原則4）

- 正は Storage ＋ `app.files`/`app.file_texts`。読み取り（抽出・索引作り）は **今どおりブラウザの Worker**（`file-analyze.js`、pdf.js）で行い、結果を finalize で送る（サーバー CPU を使わない）。サーバーは受け取った索引の形と大きさを検証。
- `file_search` / `file_read` 道具: サーバーで pgroonga 検索（`/api/elvar/files/search`）。サブエージェントや別端末からも同じ結果になる。
- IndexedDB は **キャッシュ**: DB 名 `elvar-files-<sha256(uid)先頭12>`、原本は最近使った 200MB まで、サインアウト時と別ユーザーでのログイン時に削除。オフライン時は読み取り専用。正当化: 本人の端末の中だけ・本人の名前空間・消せる、なので原則4に反しない。
- 既存ライブラリの移行: 初回ログイン時に古い DB `elvar-files` があれば「この端末のファイル（n件・xMB）をアカウントに移しますか」→ 1件ずつ reserve/upload/finalize（容量超過はそこで止まる）→ 成功したら古い DB を削除。
- 印刷履歴（`elvar_print_log`）は端末の便利機能として端末に残す（ユーザー名前空間付き）。

### 8.3 Google 連携

> **決定 O2（`docs/DECISIONS.md`）: プラットフォーム共通の Google OAuth クライアントは作らない。** 全員が自分の Cloud クライアント ID / シークレットを入れる（下の「上級者モード」が唯一の方式）。Google の確認（verification）・CASA は不要。以下の「既定: プラットフォームのクライアント」「スコープの段階」は採用しない。

- ~~既定: **プラットフォームの OAuth クライアント**（Google Cloud プロジェクト1つ、redirect URI は `/api/google/callback` 固定）。ユーザーは「Google に接続」を押すだけ。サインインとは別の同意（incremental authorization）。~~（O2 により不採用）
- スコープの段階: (1) Calendar・Tasks・連絡先など「機密」スコープ → Google の確認（verification）が必要。(2) Gmail・Drive の「制限付き」スコープ → 確認に加えて **毎年の第三者セキュリティ評価（CASA）** が必要。確認前は「未確認アプリ」警告＋ユーザー数 100 人まで。→ 未決 O2。
- 上級者モード（現 Phase 3 の仕組みを残す）: 本人の Cloud クライアント ID/シークレット（`settings.GOOGLE_CLIENT_ID` ＋ `user_secrets.GOOGLE_CLIENT_SECRET`）を入れると、そのクライアントで接続。制限付きスコープを確認なしで本人だけ使える。
- トークンは `app.oauth_tokens(provider='google')`。`invalid_grant` → `reauth_required`。切断・アカウント削除で revoke。
- `server/google/http.js` のアクセストークンキャッシュは `Map<uid, …>`（最大 500、LRU）。

### 8.4 通知の中継

- Android がデバイストークン（scope `notif:push`）で `POST /api/notif` → `withDevice('notif:push')` → `asUser(device.user_id)` → `notif_items` に暗号文だけ保存。PC 側は JWT で `GET /api/notif?since=`。
- 鍵: 本人の `NOTIF_SECRET` から PBKDF2（既存の派生式 `elvar-notif-v1` を維持、`notifications.test.mjs` の照合も維持）。サーバーは平文を見ない。

### 8.5 第二の脳

- `brain.js` の `gh()` 層を `NotesRepo`（`list(folder)`, `read(path)`, `write(path, content, mode)`, `search(terms)`, `graph()`）に置換。`cleanPath`, `scoreNote`, `catalogFrom`, `profileSummaryFrom`, `redactSecrets`, `parseProjectNotes` はそのまま。書き込みは `note_revisions` に旧版を残す（「何も失われない」性質の代わり）。
- 「削除操作が存在しない」を改め、本人の UI からは削除可（原則7）。**AI の道具からは削除不可のまま**。
- `repoIsPrivate()` の検査は不要に（DB は非公開）。
- 任意コネクタ `github-brain`: (a) 取り込み（本人の GitHub リポジトリの `.md` を一括で `notes` へ）、(b) ミラー（ノートの変更を本人のリポジトリへ片方向で push、`kv_ephemeral` で 5分デバウンス、cron で続き）。Obsidian は「GitHub 経由」または「エクスポート zip」で対応。双方向同期は後回し（競合解決が要る）。
- 現オーナーの移行: `scripts/migrate-owner.mjs`（ローカル実行）が旧 Upstash Vault（オーナーパスワードで解錠）と GitHub の脳リポジトリを読み、新アカウントにプロフィール・設定・秘密・コネクタ・ノート・会話ログを入れる。

### 8.6 長期記憶の検索

- 第1段: pgroonga のキーワード検索（現在の `scoreNote` の点数付けをサーバー側で再現）。
- 第2段（任意・本人がオン）: ノート・ファイルテキスト・会話を 1500字程度に分け、本人の Gemini キーで `gemini-embedding-001`（768 次元）→ `memory_chunks`。検索は `where user_id = $uid order by embedding <=> $q limit 20` の正確検索（1人あたり数万行まで十分速い）。全体が大きくなったら HNSW ＋ `hnsw.iterative_scan` を検討。
- 埋め込みのコストは本人のキー、件数は usage に記録。オフにすると `memory_chunks` を全削除。

### 8.7 端末に残す設定（localStorage）

- 端末の使い勝手（拍手の感度、マイク、BGM、音声モード、自動で閉じる）は端末に残す。ただし **すべて `web/src/elvar/local.js` の `local.get/set(key)` 経由**で、キーは `elvar:<uidHash>:<key>`、サインアウトで削除。
- 本人の記録・好み（`elvar_learned_at`, `elvar_predict_seen`, `elvar_inbox`, `elvar_agent_reports`, `elvar_build_sigs`, `elvar_usage_v1`, `elvar_conv_queue` 以外の会話）はサーバーへ。
- テスト `test/local-storage-guard.test.mjs`: `web/src` で `localStorage.` / `indexedDB.open` を直接使うのは `elvar/local.js`, `file-store.js`, `greeting-cache.js` と Supabase のセッションだけ。

---

## 9. ローカル開発とテスト

| 層 | コマンド | Docker | 中身 |
|---|---|---|---|
| 単体（今の 565 テストの延長） | `npm test` | 不要 | `ELVAR_DB=memory` で `MemoryDb` ＋ `MemoryStore`。JWT は テスト用 ES256 鍵ペアで署名し、`jwt.js` の JWKS を差し替え。分離の API テストもここで回る |
| DB・RLS | `npm run test:db`（= `supabase start` 済みが前提で `supabase test db` ＋ `node --test test/db/*.test.mjs`） | 要 | pgTAP（§3.5, §7.4）、repos の契約テストを本物の Postgres で |
| 結合 | `npm run test:e2e`（任意） | 要 | ローカル Supabase ＋ `server/index.js` ＋ Storage への実アップロード、削除の全手順 |

- `MemoryDb` と本物の repos は **同じ契約テスト**（`test/contracts/*.mjs`）を通す。偽物だけ通って本物で落ちる差を防ぐ。
- CI（`.github/workflows/test.yml`）: job1 `npm test`（全 PR）、job2 `supabase/setup-cli` → `supabase start` → `supabase db reset` → `npm run test:db`（全 PR、約3分）。
- ローカル開発: `supabase start` → `.env` に `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ELVAR_DB_URL`（elvar_app）, `SUPABASE_SECRET_KEY`（service、`server/db/service.js` 以外は読まない）, `ELVAR_KEK`, `CRON_SECRET`。Inbucket（ローカルのメール受け）で確認メールを見る。
- `seed.sql`: `alice@example.test`, `bob@example.test`（パスワードは固定のテスト値）。

---

## 10. 段階的な作業リスト

各フェーズの終わりで `npm test` と `npm run test:db` が通り、そのフェーズだけでコミットできる。担当は CLAUDE.md の振り分け。

### P0 — 準備（コード変更なし）
| # | 作業 | 担当 |
|---|---|---|
| 0.1 | 未決 O1–O8 をオーナーが決める（特に O2, O5, O6） | オーナー |
| 0.2 | Supabase プロジェクト（本番・開発）、SMTP、Turnstile、Vercel env | オーナー |

### P1 — 土台: スキーマ・RLS・接続・分離テスト（機能はまだ旧方式のまま動く）
| # | 作業 | 主なファイル | 担当 |
|---|---|---|---|
| 1.1 | `supabase/` 一式、マイグレーション 01–03 ＋ 11 の雛形（accounts, profiles, settings, user_keys, user_secrets, devices, audit_log, data_registry, ephemeral）、`elvar_app` ロール、`app` 非公開 | supabase/ | builder（architect がロールと RLS を確認） |
| 1.2 | pgTAP: カタログテスト、2ユーザー分離テストの自動生成 | supabase/tests/ | builder |
| 1.3 | `server/db/{pool,as-user,memory,service}.js`、repos の契約テスト、`service-role-usage` テスト | server/db/, test/ | builder |
| 1.4 | `server/crypto/envelope.js`（vault.js の部品を移植）、KEK/DEK、AAD すり替え・回転のテスト | server/crypto/ | builder（architect 確認） |
| 1.5 | `server/auth/jwt.js`（JWKS、テスト鍵）、`with-user.js`（withUser/withAdmin/withDevice/withCron）、ルーターの auth 種別追加 | server/auth/, server/router.js | builder |
| 1.6 | `server/rights/registry.js` と `residual_check()`、削除検証の pgTAP（表は少ないが仕組みを先に） | server/rights/, supabase/ | builder |
| 1.7 | レビュー（RLS、ロール、service の範囲） | — | reviewer |

### P2 — 認証の切り替えとユーザー単位の設定（オーナー方式を撤去）
| # | 作業 | 主なファイル | 担当 |
|---|---|---|---|
| 2.1 | `getConfig(req)` を JWT → profiles/settings/user_secrets に。`secret` 種別の env フォールバック禁止（テスト）。warm cache を uid 単位 | server/config/resolve.js, keys.js | builder |
| 2.2 | 全 `api/*.js` を `withUser`、`/api/notif` を `withDevice`。`with-owner.js`・オーナー Vault・セットアップコード・`upstash.js`/`file.js` を削除、`store/pg.js` 追加 | api/, server/config/, server/store/ | builder |
| 2.3 | Web のサインアップ／ログイン／確認／再設定／Google サインイン（Turnstile）、`elvar/auth.js` を auth-js に、CSP 更新、`elvar/local.js` 名前空間 | web/src/elvar/, vercel.json | builder |
| 2.4 | Android（Custom Tab ＋ 戻り）、デスクトップ（`elvar://`）、`preload.js` の env トークン削除、通知用デバイストークン | android/, desktop/ | builder |
| 2.5 | ウィザード: Gemini キー必須＋疎通、プロフィール、人格 | web/src/setup/* | builder |
| 2.6 | Live トークン・承認チケット・レート制限をユーザー単位に | live-token-core.js, google/ticket.js | builder |
| 2.7 | 管理者の最小機能（bootstrap、停止、一覧）、`before_user_created` フック、アカウント削除（この時点の表だけで完結）とエクスポートの骨組み | server/admin/, supabase/, server/rights/ | builder |
| 2.8 | セキュリティレビュー（JWT、なりすまし、管理者の見える範囲、サインアップ悪用） | — | reviewer |

### P3 — 連携: Google・コネクタ・ビルド依頼
| # | 作業 | 担当 |
|---|---|---|
| 3.1 | マイグレーション 04、`connectors/data.js` を repos に、`allowPrivate` 無効化、台帳登録 | builder |
| 3.2 | `oauth/flow.js` の pending を DB に、claim の uid 照合 | builder |
| 3.3 | Google: プラットフォームのクライアント＋ BYO モード、トークンキャッシュを uid 単位、削除時 revoke | builder |
| 3.4 | `build.js` を本人のトークンで、`build_requests` | builder |
| 3.5 | 分離テストに連携系のルートを追加、レビュー | builder → reviewer |

### P4 — 記憶: 第二の脳・会話・通知箱・通知中継
| # | 作業 | 担当 |
|---|---|---|
| 4.1 | マイグレーション 05/06/10、`NotesRepo`、`brain.js` の裏側差し替え（finance/shift/course/project-intel のテストは無変更で通ること） | builder |
| 4.2 | 会話ログ → `messages`（保持期間、検索）、`project-intel` の読み出し | builder |
| 4.3 | 通知箱・エージェント報告・通知中継をサーバーへ | builder |
| 4.4 | `github-brain` コネクタ（取り込み・片方向ミラー）、`scripts/migrate-owner.mjs` | builder |

### P5 — ファイル: Storage と容量
| # | 作業 | 担当 |
|---|---|---|
| 5.1 | マイグレーション 07（files, file_texts, bucket, Storage RLS, 予約関数, 容量トリガー）と pgTAP（他人の path に書けない・予約なしで書けない・容量超過） | builder（architect が予約方式を確認） |
| 5.2 | reserve / 直接アップロード（TUS）/ finalize / 削除 / 検索 API、cron 照合 | builder |
| 5.3 | `file-store.js` をキャッシュ化（名前空間・サインアウトで削除）、`file_search`/`file_read` をサーバー検索に、旧ライブラリの移行 UI | builder |

### P6 — 利用量・上限・管理画面
| # | 作業 | 担当 |
|---|---|---|
| 6.1 | マイグレーション 09、`record_usage` を全計測点に、Live 心拍 | builder |
| 6.2 | ソフト上限（warn/block）、ハード上限の強制（ルーターのミドルウェア） | builder |
| 6.3 | 設定「利用状況」、HUD メーター、`usage_report` 道具の差し替え、管理画面 | builder |

### P7 — データの権利の仕上げ
| # | 作業 | 担当 |
|---|---|---|
| 7.1 | 「私のデータ」画面（§7.2 の全行） | builder |
| 7.2 | エクスポートの全表対応（step 処理、パート分割、署名 URL、7日削除、メール） | builder |
| 7.3 | 削除の全手順（猶予、取り消し、revoke、Storage、crypto-shred、検証、受領メール）と全表フィクスチャの削除テスト | builder → reviewer |

### P8 — 公開前
| # | 作業 | 担当 |
|---|---|---|
| 8.1 | 長期記憶の埋め込み（任意機能） | builder |
| 8.2 | 悪用対策の見直し（使い捨てメール一覧、IP レート、Turnstile、管理者アラート）、負荷試験（接続数・RLS の速度） | builder → reviewer |
| 8.3 | プライバシーポリシー・利用規約（運営者が読める範囲、バックアップ保持、BYO キーの扱い、年齢）、README（自前運用の手順: Supabase ＋ Vercel ＋ env） | writer |
| 8.4 | 総合セキュリティレビュー（`/cso`）と公開 | reviewer |

### Phase 2–4（既存実装）の扱い

| 既存 | 扱い |
|---|---|
| profile/persona/keys.js/resolve.js の ALS・`env()`/router.js/oauth/flow.js/connectors（manifest, http, mcp, mcp-oauth, policy）/net/safe-fetch.js/tools/execute.js/approval.js/shared/tz.js | **再利用** |
| vault.js の暗号部品、auth.js の IP・ループバック・レート制限、data.js の `scope()`、google/connect.js、settings/*、setup/*、elvar/auth.js、notif の派生式、store/memory.js | **改修** |
| vault.js の meta/端末/パスワード、セットアップコード・claim・login・password、with-owner.js、env モード・ループバック無認証、store/upstash.js・file.js、desktop の env トークン | **削除** |

---

## 11. リスクと未決事項

| # | 内容 | 対策 / 必要な判断 |
|---|---|---|
| R1 | Supavisor 経由の接続がサーバーレスで枯渇・遅延 | transaction mode、`max:3`、Fluid compute でインスタンス再利用。負荷試験（P8） |
| R2 | `asUser` に未検証の uid が入る実装ミス | `VerifiedUid` 型を返す関数以外から呼べない形、レビュー、API 分離テスト |
| R3 | 予約と実サイズのずれによる容量のすり抜け | bucket の `file_size_limit`、finalize の照合、cron 照合 |
| R4 | Live の利用時間はクライアント申告 | 発行回数（server）を正とし、時間は「目安」と表示 |
| R5 | pgroonga / pg_cron / pgvector が自前運用の Postgres に無い | Supabase 前提と明記。pgroonga が無い場合は `pg_trgm` に落とす分岐 |
| R6 | 1つの Google Cloud プロジェクトの割り当て（API クォータ）を全員で共有 | 利用者ごとの Google 呼び出し上限、BYO モード |
| R7 | 削除しても PITR/バックアップに保持期間だけ残る | 秘密は crypto-shred、残りは保持期間をポリシーに明記 |
| R8 | 運営者は DB の平文を読める | 文書で正直に開示（O4） |
| R9 | 承認チケットの鍵が DEK 回転で無効化 | 仕様（回転時は承認待ちカードを取り消す表示） |
| O1 | 1人あたりの既定保存容量（案 1GB）と 1ファイル上限（60MB） | オーナー |
| O2 | Google データ連携: プラットフォームのクライアントで Google の確認（＋ Gmail/Drive は CASA）を受けるか、Gmail/Drive は BYO モード限定にするか | オーナー（推奨: 当面 Calendar 等の機密スコープだけ確認を受け、Gmail/Drive は BYO） |
| O3 | 削除猶予の既定（案 7日、即時も選べる）。迷惑行為者の再登録を防ぐ記録（メールのハッシュ）を残すか | オーナー（推奨: 残さない。必要なら 90日だけ salt 付きハッシュ） |
| O4 | ノート・会話の保存時暗号化（検索とのトレードオフ） | オーナー（推奨: 当面なし、開示する） |
| O5 | Supabase の料金プラン（Free は 1週間無操作で停止・500MB DB・1GB Storage・PITR なし） | 公開運営なら Pro 以上 |
| O6 | Vercel Hobby は個人の非商用向け。多数のユーザーが使う公開サービスは規約上 Pro が必要になりうる。Hobby の Cron は1日1回 | オーナーが規約を確認（推奨: Pro。Cron の頻度も上がる） |
| O7 | 対象の法域（日本の個人情報保護法、EU 利用者がいれば GDPR）、年齢制限 | オーナー |
| O8 | 自前運用の単独モード（サインアップ closed ＋ bootstrap 管理者）以外に、旧オーナー方式（Supabase なし）を残すか | 推奨: 残さない（2系統の保守を避ける） |

---

## 12. P1 実装メモ（設計からの差分・未着手）

P1 で入ったもの: `supabase/`（マイグレーション 01・02・03・09・11、`config.toml`）、`server/db/`（pool・as-user・repos/pg・memory・service・index）、`server/crypto/envelope.js`、`server/auth/`（jwt・with-user・device-token・user-config）、`server/rights/`（registry・residual）、ルーターの auth 種別、`npm run test:db` と CI の `test-db` ジョブ。旧オーナー方式の機能は変更なし。

設計との違い:

| 項目 | 設計 | P1 の実装 | 理由 |
|---|---|---|---|
| 表のロックダウン | 表ごとに RLS/ポリシーを列挙 | `app._secure(表, 操作)` を通す（user_id 必須、RLS enable+force、anon/public の権限を剥奪、標準の own-row ポリシー） | 半端な表を作れない形にする。テストが全表を検査 |
| `rate_limits` | `(bucket, who, window_start, n)` | `user_id`（NULL 可・cascade）と `expires_at` を追加 | ログイン済みの行もアカウント削除で消える（原則7）。TTL 掃除を他の一時表と揃える |
| `deletion_requests` | 猶予日数なし | `grace_days smallint check (in (0, 7))` | O3: 削除時に即時 / 7日猶予をユーザーが選ぶ |
| `data_registry` | 5 列 | `export_exclude`, `owner_column`, `delete_via`, `fixture_order` を追加。`fixture_sql` は `{{uid}}` を uuid リテラルに置換 | エクスポートで出さない列・生成テストの挿入順を台帳で持つ |
| 台帳の写し | DB のみ | DB（`app.data_registry`）と `server/rights/registry.js` の2つ。同一性を `migrations-lint`（静的）と `test/db/catalog`（実DB）が検査 | Docker なしの `npm test` で完全性を検査するため |
| 追加の SECURITY DEFINER 関数 | — | `ensure_account()`, `is_admin()`, `device_lookup(hash)`, `rl_hit()`, `purge_expired()`, `residual_check(uid)`。実行できるのは表のとおり固定（テストで検査） | アカウント作成、管理者の二重確認、端末トークンの照会、レート制限、TTL 掃除、削除検証 |
| pgTAP | `supabase/tests/*.sql` | Node の `node:test`（`test/db/*.test.mjs`）。素の Postgres（Docker）＋ `test/db/support/supabase-emulation.sql` | Supabase CLI なしでも CI で回る。同じ検査（カタログ・2ユーザー・削除）を実装 |
| 契約テスト | `test/contracts/*.mjs` | `test/contracts/db.contract.mjs` を `MemoryDb`（`npm test`）と実 Postgres（`test:db`）で共有 | 偽物だけ通る差を防ぐ |
| repos | `server/db/repos/*.js` を領域ごとに | `server/db/repos/pg.js` に集約（P1 の範囲） | 小さいうちは1ファイルが読みやすい。領域が増えたら分割 |
| `asUser` の安全策 | claims と role の設定 | 加えて `statement_timeout` 8秒・`idle_in_transaction_session_timeout`、切り替え直後に `current_user` と `auth.uid()` を読み戻して照合（不一致は中止） | 失敗を閉じる |
| 拡張機能 | 01 で pgroonga・vector・pg_cron・pgcrypto | 作らない（必要になる 05 / 08 / 13 で） | P1 の表は不要。素の Postgres で通る |

未着手（それぞれのフェーズで）: Storage のバケットとポリシー・予約関数（P5）、`record_usage` と容量トリガー（P5・P6）、管理者用の definer 関数（P2.7）、`pg_cron` のスケジュール（13）、`seed.sql`（P2 の本物のログインと一緒に。Supabase スタックなしでは検証できないため）、`rewrap_batch`（KEK 回転の一括処理。ユーザー単位の `rewrap()` はあり）、DEK 回転での `oauth_tokens` の再暗号化（表が入る P3）。


---

## 13. P2 実装メモ（設計からの差分・未着手）

P2 で入ったもの: サインアップ・ログイン（メール＋パスワード、確認メール、Google、パスワード再設定、Turnstile 任意）、金色のサインイン／サインアップ画面（`docs/signin.png`, `docs/signup.png`）、ユーザー単位の設定（`server/auth/load-user-config.js`: 自分の `app.settings` / `app.user_secrets` / `app.profiles`、プラットフォーム既定は台帳の `platform: true` だけ）、自分の Gemini キー（ウィザードで必須＋疎通確認）、Live トークンは本人のキーで発行（発行数は本人単位、`usage_daily` に記録）、承認チケットは本人の DEK から導いた鍵（`uid` 入り、使用済み記録は本人の `ticket_uses`）、最小の管理者（一覧・停止／解除。メタデータのみ）、アカウント削除（即時／7日、取り消し、cron で実行）、データの書き出し、`/api/elvar/cron/daily`、ローカル開発用の偽の認証（`ELVAR_DB=memory ELVAR_DEV_AUTH=1`）。旧オーナー方式（Vault・セットアップコード・端末トークン・Upstash・ファイルストア）は削除（O8）。

設計との違い:

| 項目 | 設計 | P2 の実装 | 理由 |
|---|---|---|---|
| ブラウザの認証クライアント | `@supabase/auth-js` | 依存なしの小さな REST クライアント（`web/src/elvar/gotrue.js`: PKCE・更新の排他・fetch ラッパー） | 同じコードで本物の Supabase と偽の発行元に話せる。**本物の Supabase では未検証** |
| `store/pg.js` | 追加 | 追加せず。承認は `tickets`、レート制限は `rl_hit`、OAuth は P3 の専用表 | 使い手がいない汎用 KV を作らない |
| Google / コネクタ / 通知の中継 | P3・P4 | 「準備中」（503 `coming_soon`、設定画面にも表示）。`connectors/api.js`・`google/connect.js`・`notif-sync.js` は削除（P3・P4 で DB 上に作り直す） | 他人・オーナーのデータに触れない形で止める |
| ブラウザ内データ | `elvar/local.js` 名前空間 | `web/public/ns.js`（全 localStorage キー・IndexedDB 名にユーザーの名前空間を付ける）。ログアウトで本人分を消す | 30 か所を書き換えずに分離 |
| 管理者の停止 | `accounts.status` ＋ ban | 同じ。DB の状態は warm cache で最大30秒遅れる（機微な操作は `freshAccount`＋`requireFresh`） | 文書化 |
| メモリ内の共有状態 | — | brain のキャッシュ、LLM の「落ちている」印、廃止モデルの印をユーザー単位に（`server/auth/user-state.js`） | warm インスタンスが次のユーザーに渡さない |

未着手: Supabase 本物での結合確認（Auth フック設定、Turnstile、SMTP）、`seed.sql`、通知の中継（P4）、Google／コネクタ（P3）、削除完了メール、Storage の掃除（P5）、DEK 回転 UI、`record_usage` の計測点の拡大（P6）。


---

## 14. P3 実装メモ（設計からの差分・未着手）

P3 で入ったもの: **Google をユーザーごとに**（決定 O2: 共通クライアントなし。各自が自分の OAuth クライアント ID / シークレットを設定の「Google」タブに入れ、自分の同意で接続。トークンは本人の `oauth_tokens` に本人の DEK で暗号化。スコープ選択・スコープに応じた道具の絞り込み・`invalid_grant` はその人だけ「再接続が必要」・切断とアカウント削除で Google に失効）、**コネクタ（MCP / HTTP）をユーザーごとに**（マニフェスト・道具のハッシュと承認・秘密・MCP の OAuth・セッションが本人の行。プラットフォームではプライベートネットワークへは常に不可）、**ビルド依頼をユーザーごとに**（本人の GitHub リポジトリとトークン、`build_requests` に記録）、承認チケットは P2 のとおり本人の鍵（承認カードは今までどおり動く）。設定の「Google」「連携アプリ」タブは「準備中」をやめて実機能（`docs/google-connect.png`, `docs/connectors.png`）。

設計との違い:

| 項目 | 設計 | P3 の実装 | 理由 |
|------|------|-----------|------|
| テーブル | `connectors`, `connector_tools`, `connector_tool_changes`, `oauth_tokens`, `build_requests`（`inbox_items` などと同じ 10 番） | `connectors` / `connector_tools`（`pos` 列で並び順）/ `oauth_tokens`（`reason` 列を追加）はマイグレーション 04、`build_requests` だけを 10 番の最初の部分に。`connector_tool_changes` は作らない | 道具の変更履歴は「ハッシュが変わったら無効 + 差分を `prevDef` に持つ」で足りる（既存の仕組み）。10 番の残り（通知箱など）は P4 |
| トークン列 | `ct, iv, dek_ver, scopes, status, revoke_url` | 同じ + `reason`。AAD は `elvar:oauth:v2｜uid｜provider｜dek_ver`。`user_secrets` と同じ複合 FK（deferrable）。DEK 回転は `oauth_tokens` も再暗号化 | トークンも秘密と同じ守り方。表の追加でも DEK 回転が漏れない |
| `oauth_pending` | 表だけ（`state_hash, user_id, sealed, expires_at`） | `phase`（started → exchanging → done / error）を追加。コールバックは「誰の流れか」を定義者関数 `app.oauth_pending_owner(hash)`（`elvar_app` だけが実行可）で調べ、`VerifiedUid('oauth_pending')` で**その本人として**1回だけ `begin` → コード交換 → `settle`。claim は本人の行しか見えない | 1 回限りをアトミックに保証（Redis の SET NX の代わり）。他人の state を知っても横取りできない（テストで固定） |
| 一時データ | 専用の KV | 既存の `kv_ephemeral` に `setNx`（期限切れなら取り直せるロック）を追加。MCP のセッション ID・トークン更新ロックは本人の行、呼び出し回数は `rl_hit`（本人の `uid`） | 新しい表を作らない |
| 保存先の窓口 | `connectors/data.js` を repos に | `data.js` は名前（`cx:<id>:auth` など）とエクスポート・削除の窓口だけ。サーバーの旧 KV ストア（`getStore`）は Google・コネクタから消えた | 1 つの窓口に集約 |
| Google の `GOOGLE_API_MOCK_ORIGIN` | テスト用 | テストと、ローカル開発の偽ログイン（`ELVAR_DEV_AUTH=1`、本番では不可）でだけ読む | ユーザーのリクエストはプラットフォームの環境変数を読まない（M5）が、開発スタックの検証には必要 |
| ループバックの抜け道 | `ELVAR_UNSAFE_TEST_NETWORK=loopback` のみ | **テストモード（`ELVAR_TEST_MODE=1`）か開発スタック（`ELVAR_DEV_AUTH=1`）でなければ無効**（Vercel・本番では今までどおり無効）。`allowPrivate` は `ELVAR_ALLOW_PRIVATE_CONNECTORS=1` の単独運用だけ | 「プラットフォームでは localhost の抜け道を使わせない」を機械で固定 |
| 失効 | `revoke_url` があれば失効 | Google: 保存した失効 URL（実体は固定の Google）。MCP: 認可サーバーが `revocation_endpoint` を公開していれば `safeFetch` で。失敗は記録して続行（鍵を壊すので残りのトークンは読めなくなる）。`purgeAccount` が既定で呼ぶ（`server/rights/revoke.js`） | 設計 §7.4 の手順 1 |
| Google のコールバック画面 | 本人のトークン付きスクリプトで自動 claim | スクリプトなし（CSP `default-src 'none'`）。アプリ（同じブラウザ、または戻ってきたとき）が `google-watch.js` で claim | ブラウザのログインはユーザーごとの名前空間にあり、コールバックのページから読まない |

エクスポート（`connections.json` = 連携の状態とスコープ、`connectors.json` = マニフェストと道具（秘密は「設定済み」だけ）、`builds.json`）と完全削除（台帳の `deleteVia: 'cascade+external'` = トークンは Google / MCP で失効してから消える）はすべて台帳に入っていて、分離テスト（`test/routes-isolation.test.mjs`、DB の `test/db/isolation.test.mjs`）と削除の残り確認（`residual_check`）が自動でこの表を見る。

検証: `npm test`、`npm run test:db`（postgres:17）、`npx vite build web`、public-scrub がすべて通る。開発スタック（`ELVAR_DB=memory ELVAR_DEV_AUTH=1`）に Playwright で 2 人が入り、それぞれ自分の（偽の）Google クライアントとコネクタ（テスト用 MCP サーバー）を設定して、ユーザー B の画面・API・エクスポートに A の設定・道具・秘密が一切出ないことを確認した。

未着手: 本物の Google / Supabase での結合確認、Google の使用量（呼び出し数）の上限（P6）、MCP の OAuth トークンの「再認証」通知、`github-brain` コネクタ（P4）、DEK 回転の UI。


---

## 15. P4 実装メモ（設計からの差分・未着手）

P4 で入ったもの: **第二の脳をユーザーごとの `app.notes` に**（GitHub のリポジトリから移行。直す前の版は `note_revisions` に新しい30版・90日、ゴミ箱は30日）、**家計・シフト・履修・プロジェクトは今までどおり `brain.js` の読み書き関数経由**（コードは無変更、テストの土台だけ差し替え）、**会話の記録を `app.conversations` / `app.messages` に**（短期記憶。残す期間はユーザーごとの設定 `MESSAGE_RETENTION_DAYS`、既定180日、7日〜無期限、期間指定・全削除・1件ずつ削除）、**通知箱 `app.inbox_items`**、**通知の中継 `app.notif_items`**（Android の端末トークン `notif:push` / `notif:pull`、暗号文だけ、3日・200件。503 `coming_soon` は廃止）、**任意の `github-brain`**（自分のリポジトリ・自分のトークンで、取り込みと一方通行のミラー）、`scripts/migrate-owner.mjs`（旧オーナーの保管庫と GitHub の脳を1つのアカウントへ。`--dry-run`、何度実行しても重複しない）。画面は金色で、第二の脳ビューア（ノートの閲覧・編集・以前の版・ゴミ箱・完全削除・検索・グラフ、会話の履歴と1件ずつの削除）、通知箱、設定の「記憶」タブ（`docs/brain.png`, `docs/conversations.png`）。AI の道具には、新しく `conversation_search`（過去の会話を探す）が入り、削除の道具は今までどおり無い。

設計との違い:

| 項目 | 設計 | P4 の実装 | 理由 |
|------|------|-----------|------|
| マイグレーション番号 | 05 / 06 / 10 | 05（notes）・06（conversations）・**13（inbox_items, notif_items）**・**14（保持期間の掃除）** | 10 は P3 で `build_requests` に使った |
| 全文検索 | 日本語は pgroonga | 05 / 06 の中で、pgroonga が使える環境（Supabase）では pgroonga、なければ `pg_trgm` の三つ組み索引。どちらも関数 `app.search_notes` / `search_messages`（SECURITY INVOKER、RLS が効く）が「語を1つでも含むもの」を候補として返し、**順位付けは今までどおりアプリの `scoreNote`**。pgroonga の分岐は実物では未検証（`&@|`）。失敗したら ILIKE の同じ問い合わせに自動で切り替わる | 素の postgres:17 のテストと本番で同じ結果にするため |
| ベクトル（pgvector） | 任意 | 作らない（§8.6 の第2段のまま保留） | 入れる理由がまだない |
| `note_links` | あり | 作らない。リンクの図は今までどおり本文の `[[…]]` からその場で計算 | 表を増やさない |
| `agent_reports` | あり | 作らない。サブエージェントの報告は `inbox_items` に入る。「声で伝える順番待ち」（`elvar_agent_reports`）は端末に残す（ユーザーごとの名前空間付き） | 本人の記録ではなく、配信待ちの一時データ |
| 好みの学習・長期記憶 | `memory_chunks` | 学習した好みは今までどおり `00_プロフィール.md`（ノート。ユーザーごと・見て直して消せる）、要約は `brainProfileSummary` がユーザーごとにキャッシュ。`elvar_learned_at` などの「いつ実行したか」の印は端末のユーザー名前空間に残す | 表を増やさずに原則2・3・7を満たす |
| 保存容量 | トリガーで強制（P5・P6） | P4 の書き込みはその場で「ノート＋版＋会話」の合計が `accounts.storage_quota_bytes` を超えれば 413 `storage_quota_exceeded`。`storage_usage` への記帳は P6 | 容量なしで公開しないため |
| ユーザー単位の端末トークン | `kv` に `notif:` | 端末の repos は `notif`（push だけ / pull だけ）以外を持たない（`limitDeviceRepos`）。`clear` は本人のログインだけ | 漏れた端末トークンで読める範囲を最小に |
| 会話ログの形 | `会話/日付.md` | `messages`（行ごと）。30分以上あくと別の会話。`brainProjectMaterial` は日ごとに、昔と同じ形の文字列に組み立て直して `project-intel` に渡す（`project-intel` は無変更） | 1件ずつ消せるように |
| `github-brain` のミラー | 5分デバウンス + cron | 画面の5分タイマーと「今すぐ写す」ボタンが `POST /api/elvar/brain-sync/push` を呼ぶ（サーバーは `kv_ephemeral` の5分ロックで間引く）。cron は使わない（cron はユーザーの行に触れない） | RLS のもとで全員分を巡回しないため |
| 旧オーナーの「ローカルのデータ」 | Upstash の保管庫 | `--vault store.json --password …`（ローカルの `store.json`）を読む。Upstash はファイルに書き出してから。Google と MCP のログイントークンは移さない（旧環境の鍵で封じられているため。つなぎ直し） | 旧実装を戻さずに読むため |

エクスポート（`notes.json`＝ノートの全文・版・ゴミ箱、`conversations.json`、`inbox.json`、`notifications.json`＝件数だけ）と完全削除（全部 cascade）は台帳に入っており、分離テスト（`test/routes-isolation.test.mjs`、`test/db/isolation.test.mjs`）と `residual_check` が自動で見る。

検証: `npm test`、`npm run test:db`（postgres:17。契約テストは MemoryDb と実 Postgres で同じ）、`npx vite build web`、public-scrub がすべて通る。開発スタック（`ELVAR_DB=memory ELVAR_DEV_AUTH=1`）に Playwright で2人が入り、それぞれがノートを書き・会話し・通知箱に入れ、ユーザー B の画面と API にユーザー A のノート・会話・通知箱が一切出ないこと、B の操作（消す・ゴミ箱）が A に届かないことを確認した。

未着手: 実際の Supabase（pgroonga）での結合確認、第2段の埋め込み検索、`storage_usage` への記帳と Storage（P5・P6）、ミラーの双方向、通知中継の Android 側の画面確認（サーバーは既存のプロトコルのまま）。


---

## 16. P5 実装メモ（設計からの差分・未着手）

P5 で入ったもの: **ファイルをアカウントの保管庫に**（原則4・6）。原本はプライベートな Supabase Storage（bucket `user-files`、`users/<uid>/files/<fileId>/<sha256>`）、メタデータ・読み取った「記憶」（種類の推測・キーワード・タグ・メモ・別版の目印）・抽出テキストは `app.files` / `app.file_texts`（RLS ＋ cascade ＋ `data_registry`）。ブラウザは**自分の JWT で Storage に直接 POST**し（関数は通らない。予約 → アップロード → finalize）、Storage の RLS が**書き込みのたびに**生きている予約を確かめる。容量はアップロードの**前に**、DB の1つの関数（`app.reserve_file`）で原子的に確認する（使用中＋予約中＋このファイル＋申告した抽出テキスト）。finalize は Storage の**実物のサイズと SHA-256**を確かめてから記憶を受け取る。`storage_usage` は、ノート・版・会話・ファイル・抽出テキスト・予約中をトリガーで数える（P4 の「ノートと会話だけ」の件を解消）。管理者はユーザーごとの容量を変えられる（`POST /api/elvar/admin/users/:id/quota`、画面は設定 → 管理の「容量」）。サーバー側検索（`GET /api/elvar/files/search`）、署名付きダウンロード、タグ・メモ・名前の編集、削除（Storage の原本も消して容量を空ける）、全削除、エクスポート（`files.json`＝メタデータ・記憶・抽出テキスト・原本の取り出し口 `downloadPath`）、アカウント削除（全 bucket の `users/<uid>/` を一覧して削除し、残り確認は**行と Storage の両方**）。画面は金色で、容量メーター（原本／文字／ノート／会話／アップロード中）、サーバー検索、この端末の古いライブラリの「アカウントに移す」（進捗つき・同じ内容は飛ばす・容量超過で止まる・移し終えたものだけ端末から削除）。IndexedDB は**ユーザー単位のキャッシュ**（`elvar-files-cache@<ns>`、最近使った原本 200MB とオフライン読み取り用の一覧）。印刷の流れと AI 要約／OCR の承認カードはそのまま動く（`docs/files.png`）。

設計との違い:

| 項目 | 設計 | P5 の実装 | 理由 |
|------|------|-----------|------|
| bucket | `user-files` / `user-exports` / `user-cache` | `user-files` だけ作る。削除の掃除と残り確認は3つ全部を見る（`USER_BUCKETS`） | exports / cache は P7 以降で使う。使う側が来たときに作る |
| マイグレーション | 07 に表・bucket・RLS・予約関数・容量トリガー | 07 に加えて、09 の `storage_usage` の台帳行の `fixture_order` を 5 に変更（09 を直接編集） | トリガーが先に行を作るので、台帳の固定データを最初に入れないと2重 insert になる。まだ公開前でマイグレーションを使った実環境がないため、新しい番号を足さずに直した |
| Storage の書き込みポリシー | `f.object_path = name` | `f.object_path = objects.name` | `exists (select … from app.files f …)` の中の `name` は `app.files.name` になってしまい、**誰も書けなかった**（`test/db/storage.test.mjs` が見つけた）。テストと lint（`objects.name`）で固定 |
| アップロードの認可 | ブラウザは自分の JWT で直接アップロード、RLS が予約を確認 | **署名付きアップロード URL は使わない**。ブラウザが `Authorization: Bearer <本人の JWT>` で `POST /storage/v1/object/user-files/<path>`（1回の POST、60MB まで）。`files_upload` ポリシーが**書き込みのたびに**「本人の `pending` で期限内の予約が、まさにこのパスにある」ことを確かめ、UPDATE ポリシーは無い（上書き不可）。開発スタックの偽 Storage も同じ規則を書き込みのたびに適用 | 署名付きアップロード URL は 2 時間有効・使い捨てでなくポリシーを通らないため、消した後でも持っている人が書き直せた。JWT 直接なら、削除・完了・取り消し・期限切れのあとは同じ宛先でも 403（`test/files-vault.test.mjs`、`test/db/storage.test.mjs`）。予約の期限が切れて残ったものは次の予約時（本人）か毎日の掃除（service key）で Storage の物ごと消える（猶予 5 分） |
| `files` の書き込み | RLS の標準4ポリシー | **select だけ**を許し、変更は definer 関数（`reserve_file` / `finalize_file` / `patch_file` / `begin_delete_file` / `finish_delete_file`）だけ | 利用者が `status` や `size_bytes` や `storage_usage` を直接書いて容量をすり抜けないように。テストで確認 |
| 削除 | 行と物を消す | 2段階（`deleting` にして一覧から消す → Storage の物を消す → 行を消して容量を空ける）。Storage が落ちていれば行は `deleting` で残り、本人の次のリクエストか毎日の掃除が続きを消す | 物が残ったまま行だけ消えて、容量の外に孤児が溜まるのを防ぐ |
| 容量の照合 | cron で Storage の実サイズと突き合わせ | `app.reconcile_storage()`（表から全員分を数え直して `storage_usage` を直す）を毎日の cron で。Storage の実サイズとの突き合わせは、finalize で実物を確かめているので省略 | finalize で全ファイルの実サイズ・ハッシュを確認済み |
| 抽出テキストの大きさ | — | 1ファイル 130 万字まで（4MB。日本語は3バイト）。超えた分は切って「先頭の約130万字だけ」と記録 | Vercel の関数は本文 4.5MB まで。DB の check（400万バイト）とも揃える |
| 検索 | サーバーで pgroonga | ノートと同じ方式: 関数 `app.search_files` が「語を1つでも含む本文」の候補を返し（pgroonga があれば pgroonga、なければ pg_trgm）、順位付けは既存の `searchFiles`（`web/src/file-index.js`）をサーバーで動かす（日付の言い回しの時間帯は既定の Asia/Tokyo） | 画面・AI 道具・別端末で同じ順位にするため。pgroonga の分岐は未検証 |
| `file_search` / 印刷の名前探し | サーバー検索 | `file_search` はサーバー検索。印刷・表示・読み取りの名前探しは、名前と記憶（端末にある一覧）で探し、見つからないときだけサーバー検索（本文にだけある言葉）に回す（`matchOrSearch`） | 毎回の通信を避けつつ、本文でも見つけられるように |
| 台帳 `deleteVia` | `cascade+storage` | `files` に付けた。エクスポートの計画（`exportPlan()`）にも `originals: true` が付く | 原本をエクスポートの zip に入れる印（zip 作成は P7） |

そのほかに直したこと（P5 の作業中に見つかった既存の不具合）: ローカルサーバーの JSON 読み取りがチャンクごとに文字列化していて、チャンクの境目にある日本語が壊れていた（Vercel では起きない）。大きな本文を送ると文字数が合わなくなる原因になるので、バイトで集めて最後に1度だけ変換するようにした。抽出（先頭 2MB だけ読む）が UTF-8 の文字の途中で切れると Shift_JIS と誤判定して文字化けしていた（`decodeText` の `cut` ヒント）。

検証: `npm test`、`npm run test:db`（postgres:17。Storage の RLS は `test/db/support/supabase-emulation.sql` に作った `storage.objects`／`storage.foldername()` の上でテスト）、`npx vite build web`、public-scrub がすべて通る。開発スタック（`ELVAR_DB=memory ELVAR_DEV_AUTH=1`。偽の Storage を `/dev-supabase/storage/v1` で配る）に Playwright で 2 人が入り、ファイルをアップロードして（PUT が Storage の署名付き URL に直接行き、API の本文は小さいことを確認）、ユーザー B の画面・API・検索・エクスポートに A のファイルが一切出ないこと、容量メーター、容量超過の拒否（日本語の文言・数値つき、抽出テキストも数える）、管理者による容量変更、ファイル削除で容量が空くこと、印刷の承認カード、AI 要約と OCR の承認カード（承認前は何も送らない）、この端末の古いライブラリの移行を確認した。

未着手・未確認: **本物の Supabase Storage に対する結合確認**（`server/storage/supabase.js` は Storage API の形に合わせたが、実プロジェクトでは動かしていない。JWT 付きの `POST /object/<bucket>/<path>` が生のバイナリ（`x-upsert: false`）を受け付けるか、`object/info` の返り値の名前、CORS）、TUS（6MB 超の再開可能アップロード）は使わず、1回の POST（60MB まで。切れたらやり直し）、`pg_cron` ではなく Vercel Cron（1日1回）での掃除、エクスポートの zip（原本のコピー。P7）、容量の上限を超えたユーザーの既存データの扱い（今は新規だけ止める）、Android の WebView での PUT／ダウンロード、署名付きダウンロード URL を `Content-Disposition` なしで `<iframe>` に入れる場合の挙動（今は取得した Blob を自分の MIME で包んで使う）。


---

## 17. P6 実装メモ（設計からの差分・未着手）

P6 で入ったもの: **利用量の計測と上限**（原則6）。サーバーが呼び出し口で数える（`server/usage.js` の `meteredFetch`）: Gemini（文章・検索・通常の音声・ファイル要約）・Groq・Exa・NewsData・Sarashina・Google API は「呼び出し回数」と、答えに載っていれば「入力／出力トークン」（Gemini の `usageMetadata`、OpenAI 互換の `usage`）、連携アプリ（コネクタ）の呼び出し、Gemini Live の開始（トークン発行時）。数えるのは**本人の `usage_daily`**（日付は本人のタイムゾーンの日。`record_usage` に `p_day` を追加、DB の日付 ±1 日だけ受け付ける）。ブラウザだけが知っているもの（Live の時間、使った道具）は `POST /api/elvar/usage/report` の心拍（30 秒ごと）で **「端末からの報告」と明示**して記録し、サーバーが前回の報告からの経過時間で上限をかける（水増しできない）。
**上限**: 本人の**ソフト上限**（項目×指標×1日/1か月、`知らせる`＝メーター 80%/100% と HUD の活動記録・会話中の一言、`止める`＝その項目の呼び出しを呼び出しの**前に**断る。429 `soft_limit`、日本語の文。`PUT/DELETE /api/elvar/usage/limits`）と、管理者の**ハード上限**（`accounts.hard_limits`、`admin_set_limits`: 1分のリクエスト数 120、Live 開始/時 30、コネクタ呼び出し/日 2000、書き出し/日 1、コネクタ数 10、ノート数 20000、1ファイルの最大、各プロバイダの1日の呼び出し。`ELVAR_DEFAULT_LIMITS` で運営者が既定を変えられる。429 `hard_limit`）。画面は設定 → アカウントの「利用状況を見る」（`web/src/usage-view.js`: 今日・今月、直近14日、よく使った道具、保存容量の内訳、上限の編集）、HUD の SYSTEM（LIVE・API・STORAGE はサーバーの数字）、管理（一覧に上限の件数、「上限」「利用」の編集パネル。数字だけ、ツール名別の回数も管理者には出さない）。`usage_report` 音声ツールもサーバーの数字を読み上げる（`scope` は「すべての端末の合計」）。

設計との違い:

| 項目 | 設計 | P6 の実装 | 理由 |
|------|------|-----------|------|
| マイグレーション | 09 に `record_usage` 等 | **18**（`record_usage` の再定義、`admin_set_limits`、`admin_user_usage`、`admin_users` に上限と停止理由、`purge_expired` に生イベント90日・日次2年） | 公開前だが 09/12 は P1/P2 のもの。新番号で足した |
| `record_usage` の呼び出し | 応答後に await | 呼び出しの**直後に await**（ALS が切れる前）。失敗しても呼び出しは壊さない（ログだけ） | 設計どおり |
| ゲートの読み取り | — | 上限・今日・今月を **5 秒だけ**インスタンス内にキャッシュ（記録のたびに加算、本人の上限変更・管理者の変更で即破棄）。読めないときは通す（上限は「ブレーキ」で「鍵」ではない） | 呼び出しごとに DB を3回読まないため |
| リクエスト/分（ハード上限） | ルーターのミドルウェア | `authenticate()` 内の**インスタンスごとの**カウンタ（DB を叩かない）。複数インスタンスに散ると各インスタンスで数える | 暴走ループ・悪用へのブレーキ。厳密なメーターではない（文書化）。毎日・毎時の上限は DB の数字で厳密 |
| Gemini Live の時間 | サーバー計測 | 発行（開始）はサーバー計測。**時間はクライアント報告**をサーバーが経過時間で検算（`source:'client'`）。Live はブラウザから Google へ直接つながるため、サーバーは秒数を見られない | 画面に「端末からの報告」と表示 |
| 道具の回数 | `executeTool` で計測 | **ページの報告**（既存の `usage.tool` 呼び出しを流用。サーバーの `executeTool` では数えない） | サーバー実行の道具とブラウザ実行の道具が混ざり、二重計上になるため |
| Live の止め方 | — | Live の時間／開始の「止める」上限は Live トークンの発行を断る（日本語の文）。通常の音声モード（文章・音声の Gemini 呼び出し）は別の指標なので続く | 指標ごとに止める |
| Groq の残量 | `kv_ephemeral` に保存 | 端末のブラウザに残す（レスポンスヘッダーの読み取り）。使用量ではないので計測表には入れない | 必要な画面は端末のもの |
| 失敗する日付 | — | `p_day` が DB の日付から ±1 日を超えると 22023（`invalid_value`） | 古い日・遠い未来へ書けない |

未着手・要確認: 実際の Supabase での `admin_set_limits` / `admin_user_usage`、`system_check` / `api_status` の疎通確認呼び出しは計測しない（診断用）、天気（met.no / Open-Meteo）の呼び出しは計測しない（プラットフォームの無料API）、GitHub への呼び出し（ビルド依頼・ミラー）は計測しない、ハード上限の `exportsPerDay` は P7 の書き出しで使う。
