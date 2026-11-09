// Static checks of supabase/migrations (no database needed): the same rules the catalog tests check on a live database (test/db/catalog.test.mjs), so a
// mistake is caught by plain `npm test` too. Plus: the registry rows in the SQL are identical to server/rights/registry.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY } from '../server/rights/registry.js';

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const SQL = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));
// comments removed, so a rule is not satisfied (or broken) by prose
const code = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const ALL = FILES.map((f) => code(SQL[f])).join('\n');
const PLATFORM = new Set(['data_registry', 'deletion_receipts', 'platform_config', 'blocked_email_domains', 'signup_invites', 'signup_attempts']);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function tables() {
  const out = [];
  for (const m of ALL.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_.]+)\s*\(/gi)) {
    let depth = 1, i = m.index + m[0].length; const start = i;
    while (depth && i < ALL.length) { if (ALL[i] === '(') depth++; else if (ALL[i] === ')') depth--; i++; }
    out.push({ qname: m[1], body: ALL.slice(start, i - 1) });
  }
  return out;
}

test('migration files: timestamp_name.sql, unique and strictly increasing', () => {
  assert.ok(FILES.length >= 5);
  for (const f of FILES) assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/, f);
  const ts = FILES.map((f) => f.slice(0, 14)); assert.deepEqual(ts, [...new Set(ts)].sort());
  assert.equal(FILES[0].slice(15), 'roles_schema.sql', 'the schema and the role come first');
});

test('every table is created inside schema app (nothing in public, nothing unqualified)', () => {
  const t = tables(); assert.ok(t.length >= 18);
  assert.deepEqual(t.filter((x) => !x.qname.startsWith('app.')).map((x) => x.qname), []);
  assert.doesNotMatch(ALL, /create\s+(?:or\s+replace\s+)?(?:function|view|materialized\s+view)\s+public\./i);
});

test('every user table: user_id uuid default auth.uid() -> auth.users(id) ON DELETE CASCADE, locked with app._secure(), and in the registry', () => {
  for (const { qname, body } of tables()) {
    const name = qname.slice(4);
    assert.match(ALL, new RegExp(`app\\._secure\\(\\s*'${name}'`), `${name}: no app._secure('${name}', ...) call (RLS, force, grants, policies)`);
    if (PLATFORM.has(name)) { assert.match(ALL, new RegExp(`app\\._secure\\(\\s*'${name}'\\s*,\\s*''\\s*,\\s*false\\s*\\)`), `${name}: a platform table is locked with p_owned = false`); assert.doesNotMatch(body, /^\s*user_id\s+uuid/m, `${name} holds no user data`); continue; }
    if (name === 'rate_limits') assert.match(body, /\buser_id\s+uuid\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'rate_limits.user_id is optional (signed-out callers have none) but cascades');
    else assert.match(body, /\buser_id\s+uuid\b[^,\n]*\bdefault\s+auth\.uid\(\)[^,\n]*references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, `${name}: user_id must be uuid default auth.uid() references auth.users (id) on delete cascade`);
    assert.ok(REGISTRY.some((e) => e.table === name), `${name}: add it to server/rights/registry.js (and to app.data_registry)`);
  }
  const created = new Set(tables().map((t) => t.qname.slice(4)));
  assert.deepEqual(REGISTRY.filter((e) => !created.has(e.table)).map((e) => e.table), [], 'registry entries without a table');
});

test('no policy or grant opens a table to anon / public; no RLS switch-off; policies are for authenticated and use (select auth.uid())', () => {
  assert.doesNotMatch(ALL, /disable\s+row\s+level\s+security/i);
  assert.doesNotMatch(ALL, /no\s+force\s+row\s+level\s+security/i);
  assert.doesNotMatch(ALL, /grant\s+[^;]*\bon\s+(?:table\s+)?app\.[a-z_]+[^;]*\bto\s+(?:public|anon)\b/i);
  assert.doesNotMatch(ALL, /grant\s+[^;]*\bto\s+(?:public|anon)\b/i);
  for (const m of ALL.matchAll(/create\s+policy\s+[^;]*;/gi)) {
    const p = m[0];
    assert.match(p, /\bto\s+authenticated\b/i, p); assert.doesNotMatch(p, /\busing\s*\(\s*true\s*\)|\bwith\s+check\s*\(\s*true\s*\)/i, p);
    if (!/as\s+restrictive/i.test(p)) assert.match(p, /\(\s*select\s+auth\.uid\(\)\s*\)/i, p);
  }
  // the helper builds the standard policies; its text must keep the planner-friendly form
  assert.match(ALL, /user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(ALL, /create\s+policy[^;]*(?<!select\s+)auth\.uid\(\)/i, 'a bare auth.uid() in a policy is re-evaluated per row');
});

test('every SECURITY DEFINER function pins its search_path and has its execute rights set explicitly', () => {
  const fns = [...ALL.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(app\.[a-z_]+)\s*\(([^)]*)\)[^$]*\$\$[\s\S]*?\$\$\s*;/gi)];
  assert.ok(fns.length >= 7);
  for (const m of fns) {
    const name = m[1], text = m[0];
    if (/security\s+definer/i.test(text)) assert.match(text, /set\s+search_path\s*=\s*pg_catalog\s*,\s*app\b/i, `${name}: search_path`);
    assert.match(ALL, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${name.replace('.', '\\.')}\\s*\\([^)]*\\)\\s+from\\s+public`, 'i'), `${name}: revoke ... from public`);
  }
});

test('extensions: only the search migrations (05 notes, 06 conversations) create any, inside the available-or-fallback branch; pg_cron and pgvector are not used yet', () => {
  for (const f of FILES) {
    const has = /create\s+extension/i.test(code(SQL[f]));
    assert.equal(has, /_(notes|conversations)\.sql$/.test(f), `${f}: create extension is allowed only in the notes / conversations migrations`);
  }
  assert.match(code(SQL['20261110000005_notes.sql']), /pg_available_extensions[\s\S]*pgroonga[\s\S]*else[\s\S]*pg_trgm/i, 'PGroonga where it exists, a trigram index otherwise');
  assert.doesNotMatch(ALL, /\b(pg_cron|vector\s*\()/i);
});

test('the registry rows in the migrations are identical to server/rights/registry.js (SQL is the database copy, JS the code copy)', () => {
  const rows = [];
  for (const m of ALL.matchAll(/insert\s+into\s+app\.data_registry\s*\([^)]*\)\s*values([\s\S]*?);/gi)) {
    for (const t of m[1].matchAll(/\(\s*'(\w+)'\s*,\s*'([^']*)'\s*,\s*'\{([^']*)\}'\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(\d+)\s*,\s*\$f\$([\s\S]*?)\$f\$\s*\)/g)) {
      rows.push({ table: t[1], exportAs: t[2], exportExclude: t[3].split(',').filter(Boolean), editable: t[4] === 'true', countsStorage: t[5] === 'true', fixtureOrder: Number(t[6]), fixtureSql: norm(t[7]) });
    }
  }
  const js = REGISTRY.map((e) => ({ table: e.table, exportAs: e.exportAs, exportExclude: [...e.exportExclude], editable: e.editable, countsStorage: e.countsStorage, fixtureOrder: e.fixtureOrder, fixtureSql: norm(e.fixtureSql) }));
  const by = (a, b) => (a.table < b.table ? -1 : 1);
  assert.deepEqual(rows.sort(by), js.sort(by));
});

test('O1: the default quota is 500 MB and the per-file limit 60 MB is documented where it is enforced', () => {
  assert.match(ALL, /storage_quota_bytes\s+bigint\s+not\s+null\s+default\s+524288000\b/);
  assert.match(SQL['20261110000002_accounts.sql'], /62914560[^\n]*60 MB|60 MB[^\n]*62914560/);
});

test('O3: a deletion request is either immediate or after 7 days', () => {
  assert.match(ALL, /grace_days\s+smallint\s+not\s+null\s+check\s*\(\s*grace_days\s+in\s*\(\s*0\s*,\s*7\s*\)\s*\)/);
});
