# マイグレーションの確認表（本番 Supabase に適用する前に読む）

対象: Supabase プロジェクト `dazixwtzqdsctnbofiqd`（無料プラン・東京・Postgres 17）。
`20261110000001` と `20261110000002` は適用済みです。この文書は、**残りの 19 本**（03, 04, 05, 06, 07, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22。08 は欠番）が何をするかを、SQL から1本ずつ書き出したものです。SQL と見比べて確かめてください。

## 0. 使いかた

### 0.1 ルール

- 本番プロジェクトに **SQLエディタや MCP から DDL（`create` / `alter` / `drop`）を流さない**。適用は `supabase db push` だけ。
  （運営者の設定値、たとえば `app.platform_config` の `insert` / `update` は DDL ではないので別です。）
- **適用済みのファイル（いまは 01 と 02）は書き換えない。** 直したいことは新しい番号のファイルで足す。
- `supabase db push` は 1ファイルを 1トランザクションで実行します。途中でエラーが出たファイルは、そのファイルの中身がまるごと取り消され、そこで止まります（前のファイルは適用済みのまま残ります）。

### 0.2 履歴を直す（最初に1回だけ）

01 と 02 は、履歴（`supabase_migrations.schema_migrations`）に、ファイル名と違う番号 `20261110135406` / `20261110135446` で記録されています。このままだと `db push` は「リモートにあってローカルにない番号がある」と止まります。履歴だけを直します（テーブルや関数は何も変わりません）。

```bash
supabase link --project-ref dazixwtzqdsctnbofiqd
supabase migration repair --status reverted 20261110135406 20261110135446   # 間違った番号の履歴の行を消す（中身はそのまま）
supabase migration repair --status applied 20261110000001 20261110000002    # 正しい番号で「適用済み」と記録する
supabase migration list                                                      # 01 と 02 が Local と Remote の両方に並び、03 以降は Local だけ、になっていれば OK
```

### 0.3 適用前に、読むだけの確認（任意・おすすめ）

次は**読むだけ**の SELECT です。SQLエディタで流しても何も変わりません。

```sql
-- (a) マイグレーションを流す役割 postgres に BYPASSRLS があるか（全部の SECURITY DEFINER 関数の前提。true が期待値）
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('postgres', 'supabase_auth_admin', 'supabase_storage_admin', 'elvar_app');
-- (b) 01/02 で作られたものの持ち主（全部 postgres が期待値。違うと 03 以降が作れない）
select 'schema app' as obj, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'app'
union all select 'table ' || relname, pg_get_userbyid(relowner) from pg_class where relnamespace = 'app'::regnamespace and relkind = 'r'
union all select 'function ' || proname, pg_get_userbyid(proowner) from pg_proc where pronamespace = 'app'::regnamespace;
-- (c) Storage に同じ名前のバケットやポリシーがないか（どちらも 0 行が期待値）
select id, file_size_limit from storage.buckets where id in ('user-files', 'user-exports');
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('files_read', 'files_upload', 'files_delete', 'exports_read');
-- (d) storage.buckets の列（id, name, public, file_size_limit があること）
select column_name from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' order by ordinal_position;
```

(a) が false、(b) が postgres 以外のときは、**push しないで**相談してください。03 の先頭に同じ確認を入れてあるので、その場合 push は 03 で止まり、何も作られません（§03）。

#### 実プロジェクトでの確認結果（2026-11-11、読み取り専用）

上の (a)〜(d) などを、実プロジェクトに対して**読むだけ**で確認した結果です（DDL は流していません）。

- **(a) 役割**: `postgres` は super=false、bypassrls=**true**（期待どおり）。`supabase_auth_admin` / `supabase_storage_admin` / `elvar_app` は bypassrls=false。
- **(b) 持ち主**: スキーマ `app` と、01/02 が作った表・関数は、すべて `postgres` の持ち物（期待どおり）。
- **(c) Storage**: バケット `user-files` / `user-exports` はまだなく、ポリシー `files_read` / `files_upload` / `files_delete` / `exports_read` もまだない（0 行が期待値で、そのとおり）。
- **(d) `storage.buckets` の列**: `id, name, owner, created_at, updated_at, public, avif_autodetection, file_size_limit, allowed_mime_types, owner_id, type, versioning_status, lifecycle_configuration, lifecycle_configuration_generation`（`id, name, public, file_size_limit` がある。07 の insert が使う列はそろっている）。
- **`extensions` スキーマ**: `authenticated` に USAGE がある。`postgres` は `extensions` に CREATE できる。`pgroonga` と `pg_trgm` は「特権拡張」で、`postgres` が作ってよい（05 の `create extension` は通る見込み）。
- **`storage.objects` のポリシー**: `storage.objects` の持ち主は `supabase_storage_admin` だが、`supautils.policy_grants` により `postgres` が `storage.objects` / `storage.buckets` にポリシーを作れる（`drop_trigger_grants` も同様）。07 / 19 / 20 の `create policy` / `drop policy` と 20 のトリガー関連はこの前提で通る。
- **`postgres` の権限**: `storage.buckets` に INSERT / UPDATE、`storage.objects` に SELECT / DELETE、`auth.users` に SELECT がある（07・19・20 の insert / update、削除関数、サインアップ関連の読み取りに足りる）。
- **`supabase_auth_admin`**: いまは `app` スキーマの USAGE を**持っていない**。Auth フック用に、マイグレーション側で付ける必要がある。確認した結果、**12 と 17 と 22 が、いずれも `grant usage on schema app to supabase_auth_admin` と `grant execute on function app.before_user_created(jsonb) to supabase_auth_admin` を実行する**（`pg_roles` に役割があるときだけ。実プロジェクトにはある）。したがって追加の修正は要らない。
- **`pg_cron`**: インストールされていない。この製品は使わない（定期処理は Vercel Cron が `/api/elvar/cron/daily` を呼ぶ）。

### 0.4 適用

```bash
supabase db push --dry-run    # 適用予定のファイル名だけが出る（03〜22 の 19 本のはず）。何も変わらない
supabase db push              # 確かめてから適用
supabase migration list       # 01〜22 が両側にそろったか
```

適用のあとの手作業（マイグレーションではできないもの）:
- Authentication → Hooks → 「Before User Created」→ Postgres 関数 `app.before_user_created` を選ぶ（サインアップ制限を有効にする。§12）。
- `alter role elvar_app password '...'`（docs/SETUP.md §1.3）。

### 0.5 この文書の言葉

- **適用時**: `db push` がそのファイルを実行した、その瞬間に起きること。
- **関数の中の削除**: 関数を作るだけでは何も起きません。あとでサーバーがその関数を呼んだときに起きることです。
- **実行できる人**: `authenticated` = サーバーが、ログイン中の利用者本人として（`set local role authenticated` のあと）呼ぶ。ブラウザからは呼べません（`app` スキーマは Data API に出していないため）。`elvar_app` = サーバー自身（利用者を決めずに）。`supabase_auth_admin` = Supabase Auth。どの関数も `public` と `anon` からは実行権を外しています。
- **`app._secure(テーブル, 操作)`**: 01 の関数。RLS を有効＋強制にし、`public/anon/authenticated` の権限を全部外してから、指定の操作だけを「自分の行（`user_id = auth.uid()`）だけ」の条件付きで `authenticated` に許します。操作が空ならポリシーも権限もなし（定義者関数だけが触れる）。
- **SECURITY DEFINER**: 関数の持ち主（postgres）の権限で動く関数。RLS を越えて読めるので、どれも中で `auth.uid()` などを確かめて、対象を絞っています。
- 03〜22 で作るテーブルは、適用時にはすべて空です。01/02 のテーブル（accounts, admins, profiles, settings, user_keys, user_secrets, devices, audit_log, data_registry）の**行を消す・変える文は、19 本のどこにもありません**。data_registry には行が足されるだけです（既存の 8 行は変わりません）。

---

## 03 `20261110000003_ephemeral.sql` — 短命データ

**目的**: Redis の代わりの、期限つきの小さなテーブル（キャッシュ、回数制限、使い捨てチケット、OAuth の途中状態）。

**適用時の確認（今回の追加）**: 先頭の `do $pre$ ... $pre$` は読むだけの確認です。実行する役割（postgres）に SUPERUSER か BYPASSRLS がない、または `app` スキーマの持ち主でない（そのメンバーでない）ときは、エラーで止まります（このファイルは何も作られません）。何も変えません。

**作るテーブル**
| テーブル | 中身 | 利用者の操作（_secure） |
|---|---|---|
| `app.kv_ephemeral` | 期限つきのキーと値 | 自分の行の select/insert/update/delete |
| `app.rate_limits` | 回数制限のカウンター（`u:<利用者id>` か `ip:<アドレスのハッシュ>`） | なし（関数 rl_hit だけが書く） |
| `app.ticket_uses` | 使用済みの承認チケット（二重使用を防ぐ） | 自分の行の select/insert |
| `app.oauth_pending` | OAuth の途中状態（暗号化済み） | 自分の行の select/insert/update/delete |

索引: `kv_ephemeral_expires`, `rate_limits_user`, `rate_limits_expires`, `ticket_uses_exp`, `oauth_pending_user`, `oauth_pending_expires`。

**作る関数**
- `app.rl_hit(bucket, who, window_secs, user)` — DEFINER。実行: elvar_app。カウンターを1つ増やす（insert / 同じ窓なら update）。削除なし。サーバーが回数制限を判定するたびに呼ぶ。
- `app.purge_expired()` — DEFINER。実行: elvar_app。**削除あり（全利用者が対象）**: `kv_ephemeral`（expires_at ≦ 今）、`rate_limits`（expires_at ≦ 今）、`ticket_uses`（exp ≦ 今）、`oauth_pending`（expires_at ≦ 今）。期限切れの行だけ。呼ぶのは Vercel Cron（`/api/elvar/cron/daily`、毎日 04:17 UTC）。※ 14・17・18 でこの関数は置き換わり、対象が増えます（最終形は §18）。

**適用時に既存のものを変える・消す文**: なし。**適用時に消えるユーザーデータ: なし。**
**Storage / Auth への変更**: なし（`auth.users` への外部キーを張るだけ）。**拡張機能**: なし。
**data_registry に足す行**: kv_ephemeral, rate_limits, ticket_uses, oauth_pending（4行、どれも export_as = none）。
**前提**: 01, 02。
**本番でのリスクと対応**: BYPASSRLS がないと、定義者関数がすべて「0行しか見えない」静かな故障になる → 先頭の確認で、適用前に止まるようにしました。

## 04 `20261110000004_connectors.sql` — 外部サービス連携

**目的**: 利用者ごとの OAuth トークン（Google、MCP コネクタ）と、コネクタとそのツールの一覧。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.oauth_tokens` | トークン（利用者の鍵 DEK で暗号化）、スコープ、状態 | 自分の行の select/insert/update/delete |
| `app.connectors` | コネクタの定義（秘密は入れない） | 同上 |
| `app.connector_tools` | 各ツールの定義・承認・ハッシュ | 同上 |

**作る関数**: `app.oauth_pending_owner(bytea)` — DEFINER。実行: elvar_app。読むだけ（OAuth の戻り先で、state のハッシュから持ち主を探す）。※ 15 で削除され、引数2つの版に置き換わります。

**適用時に既存のものを変える文**
- `alter table app.oauth_pending add column phase ...`（03 で作った、空のテーブルに列を足す）。
- `update app.data_registry set delete_via = 'cascade+external' where table_name = 'oauth_tokens'` — このファイルで足した oauth_tokens の行 1行だけが対象。

**適用時に消えるユーザーデータ: なし。** Storage / Auth: なし。拡張: なし。
**data_registry**: oauth_tokens（connections.json、ct/iv は出さない）、connectors、connector_tools。
**前提**: 02（user_keys への外部キー）、03（oauth_pending）。
**本番でのリスク**: なし。

## 05 `20261110000005_notes.sql` — 第二の脳（ノート）

**目的**: 利用者ごとのノート（Markdown）と、編集前の版。日本語の全文検索。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.notes` | ノートの本文、タグ、ゴミ箱（deleted_at） | 自分の行の select/insert/update/delete |
| `app.note_revisions` | 編集前の本文 | 自分の行の select/insert/delete |

索引: `notes_user_updated`、全文検索用 `notes_fts`。

**拡張機能（適用時に作る）**: `create schema if not exists extensions`（Supabase には既にあるので何もしない）。そのうえで
- PGroonga が使えるとき（本番 Supabase はこちら。pgroonga 3.2.5 が「使える・未インストール」）: `create extension if not exists pgroonga with schema extensions` → `notes_fts` は PGroonga 索引。
- 使えないとき: `pg_trgm` を `extensions` に作り、trigram 索引。

**作る関数**: `app.search_notes(terms, like, limit)` — **SECURITY INVOKER**（呼んだ人の権限で動く。RLS で自分のノートだけ）。実行: authenticated。読むだけ。PGroonga 版は演算子 `&@|` を使い、関数の search_path に `extensions` を入れてあります。

**適用時に既存のものを変える・消す文**: なし。**適用時に消えるユーザーデータ: なし。** Storage / Auth: なし。
**data_registry**: notes, note_revisions（notes.json、容量に数える）。
**前提**: 01, 02。
**本番でのリスクと対応**
- これまでのテスト用データベース（素の Postgres）には PGroonga がなく、**PGroonga の側は一度も動いていませんでした**。今回、PGroonga 入りの Postgres 17（`groonga/pgroonga:latest-debian-17`、PGroonga 4.1.0）で全マイグレーションと `npm run test:db` を通しました。
- そのとき見つかったこと: 検索関数は「呼んだ人（authenticated）」として動くので、`authenticated` に `extensions` スキーマの USAGE がないと `operator does not exist: text &@| text[]` で失敗します。Supabase は全プロジェクトで `extensions` の USAGE を anon / authenticated / service_role に与えているので本番では起きませんが、テスト用の Supabase の代役（`test/db/support/supabase-emulation.sql`）にこの付与がなく、見逃される状態でした。代役に同じ付与を足し、検索関数を実際に呼ぶテスト（`test/db/search.test.mjs`）を足しました。
- `create extension` はトランザクションの中でも動きます。`create index concurrently` のような、トランザクションの中で動かない文はどのファイルにもありません。

## 06 `20261110000006_conversations.sql` — 会話の記録

**目的**: 利用者ごとの会話（短期記憶）とメッセージ、その全文検索。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.conversations` | 会話（チャンネル、開始・最終時刻） | 自分の行の select/insert/update/delete |
| `app.messages` | 発言（8000字まで） | 自分の行の select/insert/delete |

索引: `conversations_user_last`, `messages_user_at`, `messages_conv`, `messages_fts`（05 と同じく PGroonga か trigram）。

**拡張**: 05 と同じ文（`if not exists` なので、05 で作った pgroonga をそのまま使う）。
**作る関数**: `app.search_messages(...)` — SECURITY INVOKER。実行: authenticated。読むだけ。
**適用時に消えるユーザーデータ: なし。** 既存を変える文: なし。Storage / Auth: なし。
**data_registry**: conversations, messages（conversations.json）。
**前提**: 01, 02。 **本番でのリスク**: 05 と同じ（対応済み）。

## 07 `20261110000007_files.sql` — ファイル保管庫

**目的**: 利用者ごとのファイル（原本は Storage、メタデータと抽出テキストはデータベース）。容量の予約と集計。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.files` | ファイルの情報、状態（pending/ready/deleting）、Storage の置き場所 | 自分の行の select だけ（変更は関数経由） |
| `app.file_texts` | 抽出したテキスト | 自分の行の select だけ |

索引: `files_user_created`, `files_user_sha`, `file_texts_fts`（PGroonga か trigram）。

**トリガー**（`app._storage_track`、DEFINER、誰も直接は実行できない）: `notes`, `note_revisions`, `messages`, `files`, `file_texts` の追加・変更・削除のたびに、その利用者の `app.storage_usage`（09 で作る）の数字を増減。削除はしません。

**作る関数**（すべて DEFINER）
| 関数 | 実行 | 中でする変更（呼ばれたとき） |
|---|---|---|
| `reserve_file` | authenticated | 本人の accounts / storage_usage 行がなければ作る。本人の files に pending 行を1つ insert（20 で置き換え） |
| `finalize_file` | authenticated | 本人のその1ファイルを ready に update、本人の file_texts を insert/update |
| `patch_file` | authenticated | 本人の ready のファイル1行を update。`p_set_text` で空文字なら**本人のそのファイルの file_texts 1行を delete** |
| `begin_delete_file` | authenticated | 本人のそのファイルを deleting に update |
| `finish_delete_file` | authenticated | **本人のそのファイル1行を delete**（deleting か、期限切れ pending のときだけ。file_texts も連鎖で消える） |
| `my_stale_files` | authenticated | 読むだけ |
| `stale_files` | elvar_app | 読むだけ（全利用者の deleting / 期限切れ5分超の pending） |
| `drop_stale_file(user, id)` | elvar_app | **指定の1ファイル行を delete**（deleting か、期限切れ5分超の pending のときだけ）。毎日の Cron が Storage の原本を消したあとに呼ぶ |
| `reconcile_storage` | elvar_app | 全利用者の storage_usage を、実際のテーブルから数え直して update（毎日の Cron） |
| `recount_my_storage` | authenticated | 本人の storage_usage を数え直して update |
| `admin_set_quota(user, bytes)` | authenticated（中で `app.is_admin()` を確認） | 指定利用者の accounts.storage_quota_bytes を update、その人の audit_log に記録 |
| `search_files` | authenticated | SECURITY INVOKER。読むだけ |

**Storage への変更（適用時）**
- `insert into storage.buckets ('user-files', 非公開, file_size_limit 62914560)`。同じ id があれば `public = false` と上限を上書き（§0.3 (c) で無いことを確認）。上限は 20 で 50MB になります。
- `storage.objects` にポリシーを3つ作る: `files_read`（select）, `files_upload`（insert）, `files_delete`（delete）。どれも `user-files` の `users/<自分のid>/...` だけ。update のポリシーはなし（上書き不可）。3つとも 20 で作り直されます。

**拡張**: 05 と同じ文。 **Auth**: なし。
**適用時に既存のものを変える文**: `update app.data_registry set delete_via = 'cascade+storage' where table_name = 'files'`（このファイルで足した files の行だけ）。**適用時に消えるユーザーデータ: なし。**
**data_registry**: files, file_texts（files.json、容量に数える）。
**前提**: 01, 02, 05, 06（トリガーを付けるテーブル）。トリガー関数が使う storage_usage は 09 で作られます（関数は呼ばれたときに解決されるので、作る順は問題ありません。テストで全体を通して確認済み）。
**本番でのリスクと対応**
- `storage.objects` は Supabase の Storage の持ち物です。ホスティングの Supabase では、postgres 役割がこのテーブルにポリシーを作る・消すことは許されています（Storage のドキュメントの手順も同じ SQL）。テーブル自体の `alter table` やトリガー作成はしていません。万一「must be owner」で失敗しても、このファイルは丸ごと取り消され、そこで止まります。
- Storage のアップロードは、まず利用者の権限で `INSERT` が許されるか（files_upload）だけを試し、書き込み自体は Storage の管理役割で行います（Storage の現行ソースで確認）。select のポリシーはアップロードには要りません。

## 09 `20261110000009_usage_quota.sql` — 利用量と保存容量

**目的**: API 利用量の記録（生の記録と日ごとの合計）、利用者の自主上限、保存容量の集計。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.usage_events` | 1回ごとの利用記録 | 自分の行の select |
| `app.usage_daily` | 日・提供元・指標ごとの合計 | 自分の行の select |
| `app.usage_limits` | 自分で決める上限（警告・停止） | 自分の行の select/insert/update/delete |
| `app.storage_usage` | 保存バイト数（ファイル、テキスト、ノート、会話、予約） | 自分の行の select |

**関数**: なし。 **適用時に消えるユーザーデータ: なし。** 既存を変える文: なし。Storage / Auth / 拡張: なし。
**data_registry**: usage_events, usage_daily, usage_limits, storage_usage（usage.json）。
**前提**: 01, 02。 **本番でのリスク**: なし。

## 10 `20261110000010_build_requests.sql` — 作成依頼

**目的**: 利用者が承認した「作成依頼」（利用者自身の GitHub リポジトリの issue）の一覧。

**作るテーブル**: `app.build_requests`（リポジトリ名、issue 番号、状態、題名）— 自分の行の select/insert/update/delete。
**関数**: なし。 **適用時に消えるユーザーデータ: なし。** 既存を変える文: なし。Storage / Auth / 拡張: なし。
**data_registry**: build_requests（builds.json）。 **前提**: 01, 02。 **本番でのリスク**: なし。

## 11 `20261110000011_jobs_rights.sql` — データの権利（エクスポート・削除）

**目的**: エクスポートの依頼、削除の依頼、削除の受領記録、削除後に何も残っていないかの確認。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.export_jobs` | エクスポートの依頼と進み具合 | 自分の行の select/insert。さらに制限ポリシー `export_jobs_new_only`: insert できるのは status=queued・空の状態だけ |
| `app.deletion_requests` | 削除の予定（猶予 0 日か 7 日） | 自分の行の select |
| `app.deletion_receipts` | 削除が済んだ記録（利用者 id もメールも持たない） | なし |

**作る関数**: `app.residual_check(user)` — DEFINER。実行: elvar_app。読むだけ（data_registry に載った全テーブルで、その利用者の行数を数える）。
**適用時に消えるユーザーデータ: なし。** 既存を変える文: なし。Storage / Auth / 拡張: なし。
**data_registry**: export_jobs（none）, deletion_requests（account.json）。 **前提**: 01, 02。 **本番でのリスク**: なし。

## 12 `20261110000012_admin_signup.sql` — サインアップの制限、管理者、削除の手順

**目的**: 運営者の設定テーブル、Auth フック（サインアップの可否）、利用量の記録、削除の依頼・取り消し、管理者用の最小限の関数。

**作るテーブル**（どれも利用者データなし。ポリシーも権限もなし＝定義者関数だけが読む）
| テーブル | 中身 | 適用時に入る行 |
|---|---|---|
| `app.platform_config` | 運営者の設定 | `signup_mode = open`, `daily_signup_limit = 500` |
| `app.blocked_email_domains` | 使い捨てメールのドメイン | 39 ドメイン（mailinator.com など） |
| `app.signup_invites` | 招待制のときのメール | なし |

**作る関数**（すべて DEFINER）
| 関数 | 実行 | 中でする変更 |
|---|---|---|
| `before_user_created(event)` | supabase_auth_admin（Auth フック） | 読むだけ（17・22 で置き換え） |
| `record_usage(...)` | authenticated | 本人の accounts 行がなければ作り、usage_events に insert、usage_daily を加算（18 で削除・置き換え） |
| `request_deletion(grace, email)` | authenticated | 本人の deletion_requests を insert、本人の accounts.status を pending_deletion に、audit_log に記録 |
| `cancel_deletion()` | authenticated | **本人の deletion_requests 1行を delete**（猶予つきで期限前のときだけ）、status を active に戻す |
| `admin_users(limit, offset)` | authenticated（中で is_admin を確認） | 読むだけ（メール・日付・状態・数字だけ）（18 で削除・置き換え） |
| `admin_set_status(user, status, reason)` | authenticated（is_admin 確認） | 指定利用者の accounts.status を update（管理者と削除中の人は不可）、その人の audit_log に記録 |
| `due_deletions(limit)` | elvar_app | 読むだけ（19 で削除・置き換え） |
| `record_deletion_receipt(n)` | elvar_app | deletion_receipts に1行 insert |
| `bootstrap_admin(email)` | elvar_app | そのメールの確認済みアカウントを accounts と admins に insert（毎日の Cron、`ELVAR_BOOTSTRAP_ADMIN_EMAIL` があるとき） |

**Auth への変更（適用時）**: `supabase_auth_admin` があれば、`grant usage on schema app` と `grant execute on function app.before_user_created(jsonb)` をこの役割に与える。Auth のテーブル（auth.users など）には何も作らず、何も変えません。フックを有効にするのはダッシュボードの手作業です（§0.4）。
**適用時に既存のものを変える・消す文**: なし（`revoke` は、このファイルで作った関数に対してだけ）。**適用時に消えるユーザーデータ: なし。**
**data_registry**: 変更なし（このファイルのテーブルは利用者データを持たない）。
**前提**: 02, 09（usage_*、storage_usage）, 11（deletion_*）。
**本番でのリスクと対応**: Supabase の Postgres フックの決まり（実行権を supabase_auth_admin にだけ、anon/authenticated/public から外す、スキーマの USAGE を与える）どおりです。フックは定義者関数なので、supabase_auth_admin に app のテーブルの権限は要りません。

## 13 `20261110000013_inbox_notif.sql` — お知らせとスマホ通知の中継

**目的**: ベルのお知らせ欄と、スマホ通知を PC に中継する箱（暗号文だけ）。

**作るテーブル**
| テーブル | 中身 | 利用者の操作 |
|---|---|---|
| `app.inbox_items` | お知らせ（題名、本文、URL、既読） | 自分の行の select/insert/update/delete |
| `app.notif_items` | 通知の暗号文（3日で消える） | 自分の行の select/insert/delete |

**関数**: なし。 **適用時に消えるユーザーデータ: なし。** 既存を変える文: なし。Storage / Auth / 拡張: なし。
**data_registry**: inbox_items（inbox.json）, notif_items（notifications.json、ct/iv は出さない）。 **前提**: 01, 02。 **本番でのリスク**: なし。

## 14 `20261110000014_retention.sql` — 保存期間の掃除

**目的**: `app.purge_expired()` を置き換えて、記憶のテーブルの保存期間の掃除を足す。

**置き換える関数**: `app.purge_expired()`（create or replace、DEFINER、実行: elvar_app）。03 の4つに加えて、**呼ばれたとき**に全利用者を対象に次を削除:
- `notif_items`: 3日より古いもの
- `note_revisions`: 90日より古いもの
- `notes`: ゴミ箱に入って30日たったもの（ゴミ箱に入っていないノートは消さない）
- `messages`: 利用者ごとの設定 `MESSAGE_RETENTION_DAYS`（既定 180 日、0 は無期限）より古いもの
- `conversations`: 最終時刻から1日以上たち、メッセージが1つもない会話
呼ぶのは毎日の Vercel Cron。

**適用時に既存のものを変える文**: 関数の置き換えだけ（03 の版が上書きされる）。**適用時に消えるユーザーデータ: なし**（関数は作るだけで、実行はしない）。
Storage / Auth / 拡張 / data_registry: なし。 **前提**: 03, 05, 06, 13。 **本番でのリスク**: なし。

## 15 `20261110000015_oauth_pending_provider.sql` — OAuth の種類を分ける

**目的**: OAuth の途中状態に「どの種類の戻り先のものか」（google / mcp）を持たせ、違う戻り先では使えないようにする。

**適用時に既存のものを変える・消す文**
- `alter table app.oauth_pending add column provider text not null default 'google' ...`（空のテーブル）
- `drop function if exists app.oauth_pending_owner(bytea)` — 04 で作った関数を消す（データは消えない）
**作る関数**: `app.oauth_pending_owner(bytea, text)` — DEFINER。実行: elvar_app。読むだけ。
**適用時に消えるユーザーデータ: なし。** Storage / Auth / 拡張 / data_registry: なし。 **前提**: 03, 04。 **本番でのリスク**: なし。

## 16 `20261110000016_account_count.sql` — アカウント数

**目的**: アカウントが何件あるかだけを返す（「自分のプライベートネットワークを許す」設定を、2人目がいたら拒むため）。
**作る関数**: `app.account_count()` — DEFINER。実行: elvar_app。読むだけ（件数だけ）。
**適用時に消えるユーザーデータ: なし。** 既存を変える文・Storage・Auth・拡張・data_registry: なし。 **前提**: 02。 **本番でのリスク**: なし。

## 17 `20261110000017_signup_policy.sql` — サインアップの回数制限（ネットワークごと）

**目的**: 同じネットワークからのサインアップを1日5回までにする（アドレスはハッシュにして2日だけ保持）。

**作るテーブル**: `app.signup_attempts`（ip のハッシュと時刻。利用者データなし、ポリシー・権限なし）。
**適用時に入る行**: `app.platform_config` に `ip_daily_signup_limit = 5`（既にあれば何もしない）。
**作る・置き換える関数**
- `app.before_user_created(event)`（置き換え。DEFINER、実行: supabase_auth_admin）— ネットワークごとの判定を足す。中で signup_attempts に1行 insert（削除なし）。
- `app.platform_signup_mode()`（新規。DEFINER、実行: elvar_app）— 読むだけ。
- `app.purge_expired()`（置き換え）— 14 の内容に加えて、**呼ばれたとき** `signup_attempts` の2日より古い行を削除。
**Auth への変更**: 12 と同じ grant をもう一度（同じ権限なので実質変化なし）。
**適用時に消えるユーザーデータ: なし。** Storage / 拡張 / data_registry: なし。 **前提**: 12, 14。 **本番でのリスク**: なし。

## 18 `20261110000018_usage_limits_admin.sql` — 利用量（本人の日付）と管理者の上限設定

**目的**: 利用量を利用者自身のタイムゾーンの日付で数える。管理者が利用者ごとの上限（数字だけ）を決められる。生の利用記録の保存期間。

**適用時に既存のものを変える・消す文**
- `drop function app.record_usage(text, text, numeric, text)` — 12 の関数を消し、日付つきの版を作り直す。
- `drop function app.admin_users(int, int)` — 12 の関数を消し、返す列を増やした版を作り直す。
（どちらも関数だけ。データは消えない。）
**作る・置き換える関数**（すべて DEFINER）
| 関数 | 実行 | 中でする変更 |
|---|---|---|
| `record_usage(..., p_day)` | authenticated | 12 と同じ（日付は今日±1日だけ受け付ける） |
| `admin_set_limits(user, limits)` | authenticated（is_admin 確認） | 指定利用者の accounts.hard_limits を update、その人の audit_log に記録 |
| `admin_user_usage(user, days)` | authenticated（is_admin 確認） | 読むだけ（数字だけ） |
| `admin_users(limit, offset)` | authenticated（is_admin 確認） | 読むだけ |
| `purge_expired()`（置き換え・**最終形**） | elvar_app | 呼ばれたとき、全利用者を対象に: kv_ephemeral・rate_limits・oauth_pending（期限切れ）、ticket_uses（exp 切れ）、notif_items（3日超）、note_revisions（90日超）、notes（ゴミ箱30日超）、messages（本人の保存期間超）、signup_attempts（2日超）、conversations（空で1日超）、**usage_events（90日超）、usage_daily（730日＝約2年以前）** を削除。毎日の Vercel Cron が呼ぶ |

**適用時に消えるユーザーデータ: なし。** Storage / Auth / 拡張 / data_registry: なし。 **前提**: 09, 12, 14, 17。 **本番でのリスク**: なし。

## 19 `20261110000019_exports.sql` — データのエクスポート

**目的**: エクスポートを非同期のジョブにし、zip を非公開バケット `user-exports` に置く。

**適用時に既存のものを変える・消す文**
- `alter table app.export_jobs add column updated_at ...`（11 で作った空のテーブル）
- `drop function app.due_deletions(int)` — 12 の関数を消し、メール列つきの版を作り直す（データは消えない）
**Storage への変更（適用時）**
- `insert into storage.buckets ('user-exports', 非公開, file_size_limit 536870912 = 512MB)`。同じ id があれば public=false と上限を上書き。
- `storage.objects` にポリシー `exports_read`（select、`user-exports` の `users/<自分のid>/...` だけ）。insert/update/delete のポリシーはなし（書くのと消すのはサーバーが秘密キーで行う）。
**作る関数**（すべて DEFINER、実行: elvar_app）
| 関数 | 中でする変更 |
|---|---|
| `export_job_create(user)` | 指定利用者の export_jobs に1行 insert、audit_log に記録（実行中のジョブがあれば拒否） |
| `export_job_update(user, id, ...)` | 指定のジョブ1行を update（queued/running のものだけ）、完了なら audit_log に記録 |
| `export_jobs_expired(limit)` | 全利用者の、30分止まっている queued/running ジョブを failed に update。消すべきジョブの一覧を返す（自分では消さない） |
| `export_job_drop(user, id)` | **指定のジョブ1行を delete**（サーバーが zip を消したあと。毎日の Cron と削除処理） |
| `due_deletions(limit)` | 読むだけ（削除予定の利用者 id、猶予、受領メール） |

**適用時に消えるユーザーデータ: なし。** Auth / 拡張 / data_registry: なし。 **前提**: 11, 12。
**本番でのリスク**: バケットの上限 512MB は、無料プランでは全体の 50MB 上限が先に効きます（データベースの値はそのまま、実際の上限は 50MB）。**サーバー側の注意（マイグレーションの外）**: エクスポートの zip の1部分は最大約 100MB（`server/rights/export-job.js` の `PART_BYTES`）なので、無料プランでは 50MB を超える部分のアップロードが失敗します。無料プランで大きなエクスポートを使う前に、別途直す必要があります。

## 20 `20261110000020_storage_hardening.sql` — Storage のポリシーを固くする、1ファイル上限

**目的**: 原本は「確認済み（ready）」になってから読める・「削除中（deleting）」のときだけ消せる、に締める。停止中のアカウントはアップロード不可。予約は15分。1ファイル上限と、全体の容量上限を設定で変えられるようにする。

**Storage への変更（適用時）**
- `drop policy if exists files_read / files_delete / files_upload on storage.objects` → 3つとも条件を足して作り直す（07 で作ったもの。消えるのはポリシーだけで、ファイルは消えない）。
- 下の「50MB で始める」行の insert で、トリガーが `storage.buckets` の `user-files` の `file_size_limit` を **52428800（50MB）に update** します。
**作る・置き換える関数**（すべて DEFINER）
| 関数 | 実行 | 中でする変更 |
|---|---|---|
| `platform_max_file_bytes()` | authenticated, elvar_app | 読むだけ（`max_file_bytes`。行がない・数字でないときは 60MB。60MB を超える値は 60MB に丸める） |
| `_sync_bucket_limit()`（トリガー関数） | 誰も直接は不可 | `storage.buckets` の `user-files` の file_size_limit を update |
| `set_max_file_bytes(bytes)` | elvar_app | platform_config の max_file_bytes を insert/update（毎日の Cron、`ELVAR_MAX_FILE_BYTES` があるときだけ）。1MB 未満は拒否、60MB を超える値は 60MB に丸めて保存（`app.files.size_bytes` の check が 60MB までのため。以前は 5GB まで受け付けていた不整合を直した） |
| `_platform_storage_full(add)` | 誰も直接は不可 | 読むだけ |
| `reserve_file(...)`（置き換え） | authenticated | 07 と同じ。上限は設定値、予約は15分、全体上限（`max_total_storage_bytes`）も確認 |
**作るトリガー**: `platform_max_file_sync` — `app.platform_config` への insert/update/delete のたび（文ごとに1回）に `_sync_bucket_limit()`。Storage のテーブルにはトリガーを作りません。
**適用時に入る行（今回の追加）**: `insert into app.platform_config ('max_file_bytes', '52428800') on conflict (key) do nothing`。
**適用時に消えるユーザーデータ: なし。** Auth / 拡張 / data_registry: なし。 **前提**: 07, 09, 12。
**本番でのリスクと対応（今回の変更）**
- 無料プランでは、Storage はバケットの設定にかかわらず 50MB を超えるファイルを断ります。これまでの初期値（60MB）のままだと、50〜60MB のファイルは「データベースの予約は通るが、アップロードで失敗する」状態でした。そこで、このファイルの最後で `max_file_bytes` を 50MB にして始めるようにしました（すでに値があれば変えません）。バケットの上限もトリガーで 50MB になります。
- オーナーの決定 O1（1ファイル 60MB）は変えていません。60MB は「上限の上限」と「行がないときの値」として残ります。有料プランで 60MB にしたいときは `ELVAR_MAX_FILE_BYTES=62914560`（docs/DECISIONS.md O1 に理由を記録）。

## 21 `20261110000021_orphan_sweep.sql` — 持ち主のいない原本の掃除、アカウントの鍵

**目的**: Storage に残った「もう存在しない利用者」の原本を見つけるための確認と、容量チェックの同時実行を防ぐ鍵。
**作る関数**
- `app.existing_users(ids)` — DEFINER。実行: elvar_app。読むだけ（渡した id のうち、まだ auth.users にあるものを返す。1000件まで）。削除は Cron がサーバー側で Storage に対して行います（データベースの関数は消しません）。
- `app.lock_my_account()` — DEFINER。実行: authenticated。本人の accounts 行を `for update` で鍵をかけるだけ（変更なし）。
**適用時に消えるユーザーデータ: なし。** 既存を変える文・Storage・Auth・拡張・data_registry: なし。 **前提**: 02。 **本番でのリスク**: なし。

## 22 `20261110000022_account_cap.sql` — アカウント数の上限

**目的**: プラットフォーム全体のアカウント数の上限（`max_accounts`。未設定なら上限なし）を Auth フックで確認する。
**置き換える関数**: `app.before_user_created(event)`（DEFINER、実行: supabase_auth_admin）— 17 の内容＋アカウント数の確認。中で signup_attempts に insert（削除なし）。
**Auth への変更**: 12 と同じ grant をもう一度（実質変化なし）。
**適用時に消えるユーザーデータ: なし。** Storage / 拡張 / data_registry: なし。 **前提**: 12, 17。 **本番でのリスク**: なし。

---

## まとめ表

「適用時の破壊的な操作」= `db push` の瞬間に既存のものを消す・変える文。「関数の中の削除」= あとでサーバーが呼んだときに行を消す関数（対象の条件つき）。

| ファイル | 適用時の破壊的な操作 | 適用時に消えるユーザーデータ | 関数の中の削除（呼ばれたとき） | Storage / Auth / 拡張 | data_registry |
|---|---|---|---|---|---|
| 03 | なし（先頭の確認は読むだけ） | なし | purge_expired: 期限切れの短命データ（全利用者） | なし | +4 |
| 04 | oauth_pending に列追加、registry の自分の行を update | なし | なし | なし | +3 |
| 05 | なし | なし | なし | 拡張 pgroonga（無ければ pg_trgm）を extensions に作成 | +2 |
| 06 | なし | なし | なし | 同上（既にあれば何もしない） | +2 |
| 07 | registry の自分の行を update | なし | patch_file / finish_delete_file: 本人の1ファイル。drop_stale_file: 指定の削除中・期限切れの1ファイル | バケット user-files 作成、storage.objects にポリシー3つ、拡張は同上 | +2 |
| 09 | なし | なし | なし | なし | +4 |
| 10 | なし | なし | なし | なし | +1 |
| 11 | なし | なし | なし | なし | +2 |
| 12 | なし | なし | cancel_deletion: 本人の削除依頼1行 | supabase_auth_admin に app の USAGE とフック関数の実行権 | なし |
| 13 | なし | なし | なし | なし | +2 |
| 14 | purge_expired を置き換え | なし | purge_expired: ＋通知3日・版90日・ゴミ箱30日・会話の保存期間・空の会話 | なし | なし |
| 15 | oauth_pending に列追加、関数 oauth_pending_owner(bytea) を drop | なし | なし | なし | なし |
| 16 | なし | なし | なし | なし | なし |
| 17 | before_user_created・purge_expired を置き換え | なし | purge_expired: ＋signup_attempts 2日超 | 12 と同じ grant（再） | なし |
| 18 | 関数 record_usage(4引数)・admin_users を drop して作り直し、purge_expired を置き換え | なし | purge_expired（最終形）: ＋usage_events 90日超・usage_daily 730日以前 | なし | なし |
| 19 | export_jobs に列追加、関数 due_deletions を drop して作り直し | なし | export_job_drop: 指定の1ジョブ（export_jobs_expired は failed に update するだけ） | バケット user-exports 作成、storage.objects にポリシー exports_read | なし |
| 20 | storage.objects のポリシー3つを drop して作り直し、reserve_file を置き換え、user-files の上限を 50MB に update | なし | なし | 上記のポリシーとバケット上限 | なし |
| 21 | なし | なし | なし | なし | なし |
| 22 | before_user_created を置き換え | なし | なし | 12 と同じ grant（再） | なし |

19 本を適用したあとの data_registry は 8 + 22 = **30 行**です。`auth` スキーマのテーブル・関数・トリガーを作る・変えるファイルはありません。`storage` スキーマでは、バケットの行（2つ）と `storage.objects` のポリシー（4つ）だけです。拡張機能は pgroonga だけ（pg_cron と vector は使いません。Cron は Vercel から呼びます）。

## 今回の事前確認で直したこと（2026-11-11）

1. **03 の先頭に、読むだけの事前確認を追加** — 定義者関数の前提（BYPASSRLS、app スキーマの持ち主）が崩れていると、エラーにならずに「何も見えない」故障になるため。崩れていれば 03 で止まり、何も作られません。
2. **20 で 1ファイル上限を 50MB から始める** — 無料プランの 50MB 上限と食い違わないように（上の §20）。docs/DECISIONS.md O1 に記録。
3. **テスト用の Supabase の代役に `extensions` スキーマの USAGE を追加し、検索関数を実際に呼ぶテストを追加** — 本番の PGroonga 側の検索で使う演算子の解決を、テストでも確かめるため。PGroonga 入りの Postgres 17 でも全テストが通ることを確認しました。

確かめられなかったこと（本番データベースは読んでいません）: postgres の BYPASSRLS、01/02 の持ち主、`storage.buckets` の列、`storage.objects` にポリシーを作れること。§0.3 の SELECT で確認できます。(a)(b) は 03 の先頭でも自動で確かめます。
