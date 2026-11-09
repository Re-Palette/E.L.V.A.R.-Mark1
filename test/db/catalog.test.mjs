// Catalog-driven completeness tests (docs/ELVAR_MULTIUSER.md 3.5). They read the real catalog of the migrated database, so a table, policy, grant or
// function added later is checked automatically: nothing here lists the tables by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, appTables } from './support/pg.mjs';
import { REGISTRY, validateRegistry } from '../../server/rights/registry.js';

test.after(() => admin.end({ timeout: 5 }));

// Tables of schema app that hold no user data and therefore have no user_id (and no registry row).
const PLATFORM_TABLES = new Set(['data_registry', 'deletion_receipts', 'platform_config', 'blocked_email_domains', 'signup_invites', 'signup_attempts']);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

test('every table of schema app has row level security enabled and forced', async () => {
  const t = await appTables(); assert.ok(t.length >= 18, 'tables found: ' + t.length);
  assert.deepEqual(t.filter((x) => !x.rls || !x.forced).map((x) => x.name), []);
  assert.deepEqual(t.filter((x) => x.kind !== 'r').map((x) => x.name), [], 'no partitioned tables or views surprises');
});

test('every table is either in the registry or a listed platform table, and every registry row has a table', async () => {
  const names = (await appTables()).map((x) => x.name);
  assert.deepEqual(names.filter((n) => !PLATFORM_TABLES.has(n) && !REGISTRY.some((e) => e.table === n)), [], 'tables without a registry entry (add one with the table)');
  assert.deepEqual(REGISTRY.filter((e) => !names.includes(e.table)).map((e) => e.table), [], 'registry entries without a table');
  for (const p of PLATFORM_TABLES) assert.ok(names.includes(p), p);
  assert.deepEqual(validateRegistry(), []);
});

test('the registry in the database is identical to server/rights/registry.js (every column, every fixture)', async () => {
  const db = await admin`select table_name, export_as, export_exclude, editable, owner_column, delete_via, counts_storage, fixture_order, fixture_sql from app.data_registry order by table_name collate "C"`;
  const js = [...REGISTRY].sort((a, b) => (a.table < b.table ? -1 : 1));
  assert.deepEqual(db.map((r) => r.table_name), js.map((e) => e.table));
  for (let i = 0; i < js.length; i++) {
    const r = db[i], e = js[i];
    assert.deepEqual({ exportAs: r.export_as, exportExclude: r.export_exclude, editable: r.editable, ownerColumn: r.owner_column, deleteVia: r.delete_via, countsStorage: r.counts_storage, fixtureOrder: Number(r.fixture_order), fixtureSql: norm(r.fixture_sql) },
      { exportAs: e.exportAs, exportExclude: [...e.exportExclude], editable: e.editable, ownerColumn: e.ownerColumn, deleteVia: e.deleteVia, countsStorage: e.countsStorage, fixtureOrder: e.fixtureOrder, fixtureSql: norm(e.fixtureSql) }, e.table);
  }
});

test('every registered table has its owner column (uuid) with a foreign key to auth.users(id) ON DELETE CASCADE', async () => {
  for (const e of REGISTRY) {
    const [col] = await admin`select data_type from information_schema.columns where table_schema = 'app' and table_name = ${e.table} and column_name = ${e.ownerColumn}`;
    assert.equal(col?.data_type, 'uuid', `${e.table}.${e.ownerColumn}`);
    const fk = await admin`
      select c.confdeltype, c.confrelid::regclass::text as ref, (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) as refcol
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.conrelid = ${'app.' + e.table}::regclass and cardinality(c.conkey) = 1 and a.attname = ${e.ownerColumn}`;
    assert.equal(fk.length, 1, `${e.table}: no foreign key on ${e.ownerColumn}`);
    assert.deepEqual({ ref: fk[0].ref, col: fk[0].refcol, onDelete: fk[0].confdeltype }, { ref: 'auth.users', col: 'id', onDelete: 'c' }, e.table);
  }
});

test('foreign keys between app tables are composite on (user_id, ...) on both sides and cascade (a child cannot hang under another user\'s parent)', async () => {
  const fks = await admin`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.confdeltype,
      (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as child_first,
      (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) as parent_first, cardinality(c.conkey) as n
    from pg_constraint c where c.contype = 'f' and c.conrelid::regclass::text like 'app.%' and c.confrelid::regclass::text like 'app.%'`;
  for (const f of fks) assert.deepEqual({ first: [f.child_first, f.parent_first], onDelete: f.confdeltype, composite: f.n >= 2 }, { first: ['user_id', 'user_id'], onDelete: 'c', composite: true }, `${f.child} -> ${f.parent}`);
});

test('composite indexes start with user_id (the rate-limit counters are keyed by caller on purpose)', async () => {
  const idx = await admin`
    select t.relname as tbl, i.relname as idx, (select attname from pg_attribute where attrelid = t.oid and attnum = x.indkey[0]) as first, x.indnatts as n
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid join pg_namespace s on s.oid = t.relnamespace where s.nspname = 'app'`;
  assert.deepEqual(idx.filter((i) => i.n >= 2 && i.first !== 'user_id' && !['rate_limits', 'signup_attempts'].includes(i.tbl)).map((i) => `${i.tbl}.${i.idx}`), []);
});

test('no user data in schema public, and nothing of ours is executable there', async () => {
  assert.deepEqual((await admin`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')`).map((x) => x.relname), []);
  assert.deepEqual((await admin`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`).map((x) => x.proname), []);
});

test('privileges: anon and public have nothing in app; authenticated has only select/insert/update/delete; elvar_app has no table privilege at all', async () => {
  const tables = (await appTables()).map((t) => 'app.' + t.name);
  for (const t of tables) {
    for (const role of ['anon', 'service_role', 'elvar_app']) {
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
        const [r] = await admin`select has_table_privilege(${role}, ${t}, ${priv}) as ok`; assert.equal(r.ok, false, `${role} has ${priv} on ${t}`);
      }
    }
    for (const priv of ['truncate', 'references', 'trigger']) { const [r] = await admin`select has_table_privilege('authenticated', ${t}, ${priv}) as ok`; assert.equal(r.ok, false, `authenticated has ${priv} on ${t}`); }
  }
  assert.deepEqual((await admin`select 1 from information_schema.role_table_grants where table_schema = 'app' and grantee = 'PUBLIC'`).length, 0);
  for (const role of ['anon', 'service_role']) { const [r] = await admin`select has_schema_privilege(${role}, 'app', 'usage') as ok`; assert.equal(r.ok, false, role + ' can use schema app'); }
  assert.equal((await admin`select has_schema_privilege('authenticated', 'app', 'usage') as ok`)[0].ok, true);
  const seq = await admin`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'S' and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage') or has_sequence_privilege('elvar_app', c.oid, 'usage'))`;
  assert.deepEqual(seq.map((x) => x.relname), []);
});

test('the elvar_app role: login, no inherit, no bypassrls, not a superuser, owns nothing, can only become authenticated', async () => {
  const [r] = await admin`select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = 'elvar_app'`;
  assert.deepEqual(r, { rolcanlogin: true, rolinherit: false, rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
  assert.deepEqual((await admin`select 1 from pg_class c join pg_roles o on o.oid = c.relowner where o.rolname = 'elvar_app'`).length, 0, 'owns a relation');
  assert.deepEqual((await admin`select 1 from pg_namespace n join pg_roles o on o.oid = n.nspowner where o.rolname = 'elvar_app'`).length, 0, 'owns a schema');
  assert.deepEqual((await admin`select 1 from pg_proc p join pg_roles o on o.oid = p.proowner where o.rolname = 'elvar_app'`).length, 0, 'owns a function');
  const member = await admin`select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'elvar_app' order by 1`;
  assert.deepEqual(member.map((x) => x.rolname), ['authenticated']);
  for (const role of ['authenticated', 'anon']) { const [x] = await admin`select rolbypassrls, rolsuper, rolcanlogin from pg_roles where rolname = ${role}`; assert.deepEqual(x, { rolbypassrls: false, rolsuper: false, rolcanlogin: false }, role); }
});

test('every policy applies to authenticated only, is tied to auth.uid() through (select auth.uid()), and every granted command has a policy', async () => {
  const pols = await admin`select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname = 'app' order by 1, 2`;
  assert.ok(pols.length >= 20, 'policies found: ' + pols.length);
  for (const p of pols) {
    const id = `${p.tablename}.${p.policyname}`;
    assert.deepEqual([...p.roles], ['authenticated'], id);
    const expr = `${p.qual || ''} ${p.with_check || ''}`;
    if (p.permissive === 'PERMISSIVE') {
      assert.match(expr, /user_id\s*=\s*\(\s*SELECT\s+auth\.uid\(\)/i, `${id}: not tied to the caller through (select auth.uid())`);
      if (p.cmd === 'SELECT' || p.cmd === 'DELETE' || p.cmd === 'UPDATE' || p.cmd === 'ALL') assert.ok(p.qual, id + ' has no USING');
      if (p.cmd === 'INSERT' || p.cmd === 'UPDATE' || p.cmd === 'ALL') assert.ok(p.with_check, id + ' has no WITH CHECK');
    }
    assert.doesNotMatch(expr, /\btrue\b|current_setting|jwt/i, id + ' must not rely on anything but auth.uid()');
  }
  for (const t of (await appTables()).map((x) => x.name)) {
    for (const [priv, cmd] of [['select', 'SELECT'], ['insert', 'INSERT'], ['update', 'UPDATE'], ['delete', 'DELETE']]) {
      const [g] = await admin`select has_table_privilege('authenticated', ${'app.' + t}, ${priv}) as ok`;
      const covered = pols.some((p) => p.tablename === t && p.permissive === 'PERMISSIVE' && (p.cmd === cmd || p.cmd === 'ALL'));
      assert.equal(covered, g.ok, `${t}: ${priv} grant and policy disagree`);
    }
  }
});

test('write-restricted tables really are: no insert/update/delete grant on accounts and usage; audit_log and ticket_uses are append only', async () => {
  const priv = async (t, p) => (await admin`select has_table_privilege('authenticated', ${'app.' + t}, ${p}) as ok`)[0].ok;
  for (const t of ['accounts', 'usage_events', 'usage_daily', 'storage_usage', 'deletion_requests']) for (const p of ['insert', 'update', 'delete']) assert.equal(await priv(t, p), false, `${t} ${p}`);
  for (const t of ['audit_log', 'ticket_uses']) { assert.equal(await priv(t, 'insert'), true); for (const p of ['update', 'delete']) assert.equal(await priv(t, p), false, `${t} ${p}`); }
  for (const t of ['admins', 'rate_limits', 'data_registry', 'deletion_receipts', 'platform_config', 'blocked_email_domains', 'signup_invites', 'signup_attempts']) for (const p of ['select', 'insert', 'update', 'delete']) assert.equal(await priv(t, p), false, `${t} ${p}`);
});

test('definer functions: fixed search_path, never executable by public or anon, and exactly the expected callers', async () => {
  const fns = await admin`select p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, o.rolbypassrls or o.rolsuper as owner_bypasses
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles o on o.oid = p.proowner where n.nspname = 'app' order by p.proname`;
  const EXPECT = {   // function -> roles that may execute it
    _secure: [], ensure_account: ['authenticated'], is_admin: ['authenticated'], device_lookup: ['elvar_app'],
    rl_hit: ['elvar_app'], purge_expired: ['elvar_app'], residual_check: ['elvar_app'],
    account_count: ['elvar_app'], platform_signup_mode: ['elvar_app'],   // migration 16: how many accounts exist (single-user switch for private connector networks)
    search_notes: ['authenticated'], search_messages: ['authenticated'],   // migrations 05 / 06: SECURITY INVOKER (RLS applies), the candidate queries of the notes / conversation search
    oauth_pending_owner: ['elvar_app'],   // migration 04: the OAuth callback finds whose flow a single-use state belongs to
    // migration 12: the Auth hook (supabase_auth_admin only, none of the roles listed here), the caller-scoped ones, the admin ones (they check is_admin themselves), the cron / purge helpers
    before_user_created: [], record_usage: ['authenticated'], request_deletion: ['authenticated'], cancel_deletion: ['authenticated'],
    admin_users: ['authenticated'], admin_set_status: ['authenticated'], due_deletions: ['elvar_app'], record_deletion_receipt: ['elvar_app'], bootstrap_admin: ['elvar_app'],
  };
  assert.deepEqual(fns.map((f) => f.proname).sort(), Object.keys(EXPECT).sort(), 'a function was added or removed: update this list deliberately');
  for (const f of fns) {
    assert.ok(f.proacl, `${f.proname}: default ACL leaves execute to PUBLIC`);
    const grantees = await admin`select a.grantee from aclexplode(${f.proacl}) a`; assert.ok(!grantees.some((g) => Number(g.grantee) === 0), `${f.proname}: PUBLIC can execute`);
    const who = [];
    for (const role of ['anon', 'authenticated', 'elvar_app', 'service_role']) if ((await admin`select has_function_privilege(${role}, ${f.oid}, 'execute') as ok`)[0].ok) who.push(role);
    assert.deepEqual(who, [...EXPECT[f.proname]].sort(), f.proname);
    if (f.prosecdef) {
      assert.ok((f.proconfig || []).some((c) => /^search_path=pg_catalog, app$/.test(c)), `${f.proname}: search_path is not pinned to pg_catalog, app`);
      assert.equal(f.owner_bypasses, true, `${f.proname}: its owner must bypass RLS (Supabase postgres does)`);
    }
  }
});

test('O1: the default storage quota is 500 MB; a negative quota is refused', async () => {
  const [d] = await admin`select column_default from information_schema.columns where table_schema = 'app' and table_name = 'accounts' and column_name = 'storage_quota_bytes'`;
  assert.equal(String(d.column_default), '524288000');
  await assert.rejects(admin`insert into app.accounts (user_id, storage_quota_bytes) values (gen_random_uuid(), -1)`);
});

test('deletion receipts carry no user id and no e-mail', async () => {
  const cols = await admin`select column_name from information_schema.columns where table_schema = 'app' and table_name = 'deletion_receipts' order by 1`;
  assert.deepEqual(cols.map((c) => c.column_name), ['completed_at', 'id', 'tables_checked']);
});
