// The data registry (docs/ELVAR_MULTIUSER.md section 7.1): one entry per table that holds a user's data. It is the single list behind
//   - the export (which file, which columns never leave the database),
//   - the deletion check (app.residual_check counts every table listed here),
//   - the generated isolation tests (fixtureSql inserts one row per table for a user),
//   - MemoryDb (it creates exactly these tables).
// The same list is in the database as app.data_registry (inserted by the migration that creates each table). test/db/catalog.test.mjs requires the
// two to be identical and requires every table of schema `app` to be here; test/migrations-lint.test.mjs does the table check without a database.
// To add a table: create it with app._secure(), add its row to the migration's insert into app.data_registry, and add the same entry below.
//
//   exportAs        file in the export zip ('none' = internal data or key material, not exported)
//   exportExclude   columns removed from exported rows (ciphertext, hashes)
//   editable        the user may change it from the "my data" screen
//   countsStorage   counts against the user's storage quota
//   fixtureOrder    tests insert fixtures in this order (parents first)
//   fixtureSql      one INSERT (or several) for the user {{uid}}
import { dbError } from '../db/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REGISTRY = Object.freeze([
  { table: 'accounts', exportAs: 'account.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 10,
    fixtureSql: `insert into app.accounts (user_id) values ({{uid}})` },
  { table: 'admins', exportAs: 'account.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 20,
    fixtureSql: `insert into app.admins (user_id) values ({{uid}})` },
  { table: 'profiles', exportAs: 'profile.json', exportExclude: [], editable: true, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.profiles (user_id, profile) values ({{uid}}, '{"version":1,"owner":{"name":"fixture"}}'::jsonb)` },
  { table: 'settings', exportAs: 'settings.json', exportExclude: [], editable: true, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.settings (user_id, settings) values ({{uid}}, '{"fixture":true}'::jsonb)` },
  { table: 'user_keys', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.user_keys (user_id, kek_id, wrapped, iv) values ({{uid}}, 'fixture', decode(repeat('00', 48), 'hex'), decode(repeat('00', 12), 'hex'))` },
  { table: 'user_secrets', exportAs: 'secrets.json', exportExclude: ['ct', 'iv'], editable: true, countsStorage: false, fixtureOrder: 35,
    fixtureSql: `insert into app.user_secrets (user_id, name, ct, iv, dek_ver, last4) values ({{uid}}, 'GEMINI_API_KEY', decode(repeat('11', 32), 'hex'), decode(repeat('00', 12), 'hex'), 1, 'abcd')` },
  { table: 'devices', exportAs: 'devices.json', exportExclude: ['token_hash'], editable: true, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.devices (user_id, id, name, token_hash, scopes) values ({{uid}}, '0123456789abcdef', 'fixture', sha256(convert_to('fixture-device-' || {{uid}}::text, 'UTF8')), array['notif:push'])` },
  { table: 'audit_log', exportAs: 'audit.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.audit_log (user_id, actor, actor_id, action, target) values ({{uid}}, 'user', {{uid}}, 'fixture', 'fixture')` },
  { table: 'kv_ephemeral', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.kv_ephemeral (user_id, key, value, expires_at) values ({{uid}}, 'fixture', '{"x":1}'::jsonb, now() + interval '1 hour')` },
  { table: 'rate_limits', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.rate_limits (bucket, who, window_start, n, user_id, expires_at) values ('fixture', 'u:' || {{uid}}::text, now(), 1, {{uid}}, now() + interval '1 hour')` },
  { table: 'ticket_uses', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.ticket_uses (user_id, jti, exp) values ({{uid}}, 'fixture-jti', now() + interval '1 hour')` },
  { table: 'oauth_pending', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.oauth_pending (state_hash, user_id, sealed, expires_at) values (sha256(convert_to('fixture-state-' || {{uid}}::text, 'UTF8')), {{uid}}, decode('00', 'hex'), now() + interval '1 hour')` },
  { table: 'usage_events', exportAs: 'usage.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.usage_events (user_id, provider, metric, amount, source) values ({{uid}}, 'gemini', 'calls', 1, 'server')` },
  { table: 'usage_daily', exportAs: 'usage.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.usage_daily (user_id, day, provider, metric, amount) values ({{uid}}, current_date, 'gemini', 'calls', 1)` },
  { table: 'usage_limits', exportAs: 'usage.json', exportExclude: [], editable: true, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.usage_limits (user_id, provider, metric, period, soft) values ({{uid}}, 'gemini', 'live_seconds', 'day', 3600)` },
  { table: 'storage_usage', exportAs: 'usage.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.storage_usage (user_id, files_bytes) values ({{uid}}, 1)` },
  { table: 'export_jobs', exportAs: 'none', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.export_jobs (user_id) values ({{uid}})` },
  { table: 'deletion_requests', exportAs: 'account.json', exportExclude: [], editable: false, countsStorage: false, fixtureOrder: 30,
    fixtureSql: `insert into app.deletion_requests (user_id, grace_days, purge_after) values ({{uid}}, 7, now() + interval '7 days')` },
].map((e) => Object.freeze({ ownerColumn: 'user_id', deleteVia: 'cascade', ...e, exportExclude: Object.freeze([...e.exportExclude]) })));

export const registryTables = () => REGISTRY.map((e) => e.table);
export const entryFor = (table) => REGISTRY.find((e) => e.table === table) || null;
/** Entries in the order fixtures must be inserted. */
export const fixtureOrder = () => [...REGISTRY].sort((a, b) => a.fixtureOrder - b.fixtureOrder || a.table.localeCompare(b.table));

/** The fixture statement(s) for one user, with {{uid}} replaced by a uuid literal (the id is validated, never interpolated raw). */
export function fixtureSqlFor(entry, uid) {
  if (!UUID_RE.test(String(uid))) throw dbError('bad_uid', 500);
  return entry.fixtureSql.replaceAll('{{uid}}', `'${String(uid).toLowerCase()}'::uuid`);
}

const snake = (k) => String(k).replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
/** A row (snake_case or camelCase keys) without the columns that never leave the database. */
export function redactRow(entry, row) {
  const drop = new Set(entry.exportExclude);
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(snake(k))));
}

/** Export plan: which tables go into which file of the zip. Tables with exportAs 'none' are not exported. */
export function exportPlan() {
  const files = new Map();
  for (const e of REGISTRY) {
    if (e.exportAs === 'none') continue;
    if (!files.has(e.exportAs)) files.set(e.exportAs, []);
    files.get(e.exportAs).push({ table: e.table, exclude: [...e.exportExclude] });
  }
  return [...files].map(([file, tables]) => ({ file, tables }));
}

/** Structural problems of the registry itself (empty list = fine). */
export function validateRegistry(reg = REGISTRY) {
  const problems = [], seen = new Set();
  for (const e of reg) {
    if (seen.has(e.table)) problems.push(`duplicate table ${e.table}`); seen.add(e.table);
    if (!/^[a-z_][a-z0-9_]*$/.test(e.table)) problems.push(`bad table name ${e.table}`);
    if (!e.exportAs) problems.push(`${e.table}: exportAs is empty`);
    if (!e.fixtureSql.includes('{{uid}}')) problems.push(`${e.table}: fixtureSql does not use {{uid}}`);
    if (!new RegExp(`\\bapp\\.${e.table}\\b`).test(e.fixtureSql)) problems.push(`${e.table}: fixtureSql does not insert into app.${e.table}`);
    if (e.exportAs === 'none' && e.exportExclude.length) problems.push(`${e.table}: exportExclude on a table that is not exported`);
    if (!['cascade', 'cascade+storage', 'cascade+external'].includes(e.deleteVia)) problems.push(`${e.table}: bad deleteVia`);
  }
  return problems;
}
