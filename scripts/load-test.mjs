// A basic load test against the DEV STACK (docs/ELVAR_MULTIUSER.md 19.5). It signs up N users on the fake Auth issuer, then lets every user do an ordinary mix of
// requests in parallel for a while (read the session, write and read notes, log conversation turns, upload / read / delete a small file, read usage and the "my data" counts,
// export once), and reports per-request-kind latency (p50 / p95 / p99), the status codes, throughput, and a cross-user check (nobody ever sees another user's marker).
//
//   1. start the dev stack in another terminal:   ELVAR_DB=memory ELVAR_DEV_AUTH=1 HOST=127.0.0.1 PORT=18787 node server/index.js
//   2. node scripts/load-test.mjs [--base http://127.0.0.1:18787] [--users 20] [--seconds 20] [--think 700] [--settle 62] [--json result.json]
//
// It is a smoke / regression test of the application layer on the in-memory database: it says nothing about Supabase, Supavisor or Vercel (their limits are in docs/SETUP.md).
// 429 answers are the per-user limits doing their job (120 requests a minute per user by default) and are counted apart from errors.
import crypto from 'node:crypto';
import fs from 'node:fs';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def; };
const BASE = String(arg('base', process.env.BASE || 'http://127.0.0.1:18787')).replace(/\/+$/, '');
const USERS = Math.max(1, Number(arg('users', 20))), SECONDS = Math.max(1, Number(arg('seconds', 20))), THINK_MS = Math.max(0, Number(arg('think', 700)));
const AUTH = `${BASE}/dev-supabase/auth/v1`, KEY = 'dev-publishable-key', PASSWORD = 'Passw0rdPassw0rd-load';
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)) { console.error('The load test only runs against a local dev stack (127.0.0.1 / localhost).'); process.exit(2); }

const lat = new Map(), codes = new Map(); let started = 0;
const rec = (kind, ms, status) => { (lat.get(kind) || lat.set(kind, []).get(kind)).push(ms); const k = `${kind}|${status}`; codes.set(k, (codes.get(k) || 0) + 1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function call(kind, who, method, path, body) {
  const t = performance.now(); let status = 0, json = null;
  try {
    const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${who.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    status = r.status; const txt = await r.text(); try { json = JSON.parse(txt); } catch { json = txt; }
  } catch (e) { status = -1; json = { error: String(e?.cause?.code || e?.message) }; }
  rec(kind, performance.now() - t, status); return { status, body: json };
}

async function signup(i) {
  const email = `load-${Date.now()}-${i}@example.test`, h = { apikey: KEY, 'content-type': 'application/json' };
  await fetch(`${AUTH}/signup`, { method: 'POST', headers: h, body: JSON.stringify({ email, password: PASSWORD }) });
  const mb = await (await fetch(`${BASE}/dev-supabase/dev/mailbox`)).json(), m = mb.mailbox.filter((x) => x.to === email).at(-1);
  if (m) await fetch(m.link, { redirect: 'manual' });
  const t = await (await fetch(`${AUTH}/token?grant_type=password`, { method: 'POST', headers: h, body: JSON.stringify({ email, password: PASSWORD }) })).json();
  if (!t.access_token) throw new Error(`sign-up failed for user ${i}: ${JSON.stringify(t).slice(0, 160)}`);
  return { i, email, id: t.user?.id, token: t.access_token, marker: `MARK-${crypto.randomBytes(6).toString('hex')}`, leaks: 0, ops: 0, noteIds: [] };
}

async function oneRound(u, n) {
  const pick = n % 8;
  if (pick === 0) { const r = await call('session', u, 'GET', '/api/elvar/session'); if (r.status === 200 && JSON.stringify(r.body).includes('MARK-') && !JSON.stringify(r.body).includes(u.marker)) u.leaks++; }
  else if (pick === 1) { const r = await call('note-write', u, 'POST', '/api/elvar/notes', { path: `load/${u.i}-${n}.md`, content: `${u.marker} note ${n}` }); if (r.status === 200 && r.body?.note?.id) u.noteIds.push(r.body.note.id); }
  else if (pick === 2) { const r = await call('note-list', u, 'GET', '/api/elvar/notes'); const txt = JSON.stringify(r.body); if (r.status === 200 && /MARK-[0-9a-f]{12}/.test(txt) && txt.match(/MARK-[0-9a-f]{12}/g).some((m) => m !== u.marker)) u.leaks++; }
  else if (pick === 3) await call('message-write', u, 'POST', '/api/elvar/messages', { turns: [{ at: Date.now(), user: `${u.marker} q${n}`, model: `a${n}` }] });
  else if (pick === 4) { const r = await call('message-read', u, 'GET', '/api/elvar/messages'); const txt = JSON.stringify(r.body); if (r.status === 200 && /MARK-[0-9a-f]{12}/.test(txt) && txt.match(/MARK-[0-9a-f]{12}/g).some((m) => m !== u.marker)) u.leaks++; }
  else if (pick === 5) await call('usage', u, 'GET', '/api/elvar/usage');
  else if (pick === 6) await call('mydata', u, 'GET', '/api/elvar/mydata');
  else { await call('files-list', u, 'GET', '/api/elvar/files'); }
}

async function fileCycle(u) {   // reserve -> upload with the user's own token -> finalize -> download link -> delete
  const bytes = Buffer.from(`${u.marker} file ${crypto.randomUUID()}`), sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const r = await call('file-reserve', u, 'POST', '/api/elvar/files/reserve', { name: 'load.txt', size: bytes.length, sha256: sha, textBytes: 4 });
  if (r.status !== 200 || !r.body?.upload) return;
  const t = performance.now(); let up;
  try { up = await fetch(r.body.upload.url, { method: 'POST', headers: { ...r.body.upload.headers, authorization: `Bearer ${u.token}` }, body: bytes }); rec('file-upload', performance.now() - t, up.status); } catch { rec('file-upload', performance.now() - t, -1); return; }
  if (up.status !== 200) return;
  const f = await call('file-finalize', u, 'POST', `/api/elvar/files/${r.body.fileId}/finalize`, { text: 'load' });
  if (f.status === 200) { await call('file-download', u, 'GET', `/api/elvar/files/${r.body.fileId}/download`); await call('file-delete', u, 'DELETE', `/api/elvar/files/${r.body.fileId}`); }
}

async function worker(u, until) {
  for (let n = 0; Date.now() < until; n++) {
    await oneRound(u, n); u.ops++;
    if (n % 15 === 14) await fileCycle(u);
    if (THINK_MS) await sleep(THINK_MS * (0.5 + Math.random()));
  }
}

async function exportOnce(u) {   // the heaviest request kind: ask, step until done
  let r = await call('export-start', u, 'POST', '/api/elvar/export', {}); let job = r.body?.job;
  for (let i = 0; i < 60 && job && ['queued', 'running'].includes(job.status); i++) { r = await call('export-step', u, 'POST', `/api/elvar/export/${job.id}/step`, {}); job = r.body?.job; }
  return job?.status || `http ${r.status}`;
}

console.log(`[load] ${BASE}: ${USERS} users, ${SECONDS} s, think ~${THINK_MS} ms (per-user limit is 120 requests a minute: a smaller --think makes 429s)`);
const users = []; const t0s = performance.now();
for (let i = 0; i < USERS; i++) users.push(await signup(i));
console.log(`[load] signed up ${users.length} users in ${Math.round(performance.now() - t0s)} ms`);
for (const u of users) await call('session', u, 'GET', '/api/elvar/session');
started = Date.now(); const until = started + SECONDS * 1000;
await Promise.all(users.map((u) => worker(u, until)));
const wall = (Date.now() - started) / 1000;
const SETTLE = Math.max(0, Number(arg('settle', 62)));
if (SETTLE) { console.log(`[load] waiting ${SETTLE} s so the per-minute request window of every user is empty before the exports`); await sleep(SETTLE * 1000); }
const exports = await Promise.all(users.slice(0, Math.min(5, users.length)).map(exportOnce));

// isolation: every user's notes list holds only their own marker
let leaks = users.reduce((s, u) => s + u.leaks, 0);
for (const u of users) { const r = await fetch(`${BASE}/api/elvar/notes`, { headers: { authorization: `Bearer ${u.token}` } }), j = await r.json().catch(() => ({})); const found = (JSON.stringify(j).match(/load\/(\d+)-/g) || []).map((m) => Number(m.slice(5, -1))); if (found.some((i) => i !== u.i)) leaks++; }

const total = [...lat.values()].reduce((s, a) => s + a.length, 0), rows = [];
for (const [kind, a] of [...lat].sort()) rows.push({ kind, n: a.length, p50: +pct(a, 50).toFixed(1), p95: +pct(a, 95).toFixed(1), p99: +pct(a, 99).toFixed(1), max: +Math.max(...a).toFixed(1), statuses: Object.fromEntries([...codes].filter(([k]) => k.startsWith(kind + '|')).map(([k, v]) => [k.split('|')[1], v])) });
const byStatus = {}; for (const [k, v] of codes) { const s = k.split('|')[1]; byStatus[s] = (byStatus[s] || 0) + v; }
const summary = { base: BASE, users: USERS, seconds: SECONDS, wallSeconds: +wall.toFixed(1), requests: total, requestsPerSecond: +(total / wall).toFixed(1), byStatus, crossUserLeaks: leaks, exports, kinds: rows };
console.log('\nkind'.padEnd(18) + 'n'.padStart(7) + 'p50 ms'.padStart(9) + 'p95 ms'.padStart(9) + 'p99 ms'.padStart(9) + 'max ms'.padStart(9) + '  statuses');
for (const r of rows) console.log(r.kind.padEnd(18) + String(r.n).padStart(7) + String(r.p50).padStart(9) + String(r.p95).padStart(9) + String(r.p99).padStart(9) + String(r.max).padStart(9) + '  ' + JSON.stringify(r.statuses));
console.log(`\n[load] ${total} requests in ${summary.wallSeconds} s = ${summary.requestsPerSecond} req/s; statuses ${JSON.stringify(byStatus)}; exports ${JSON.stringify(exports)}; cross-user leaks: ${leaks}`);
const out = arg('json', ''); if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
const serverErrors = Object.entries(byStatus).filter(([s]) => s === '-1' || Number(s) >= 500).reduce((s, [, v]) => s + v, 0);
process.exit(leaks === 0 && serverErrors === 0 ? 0 : 1);
