// npm run test:db: runs the migrations and the RLS / isolation / contract tests (test/db/*.test.mjs) against a real Postgres.
//   default                     starts a throw-away Postgres in Docker (image ELVAR_TEST_DB_IMAGE, default postgres:17 - MERGE with row level security needs 15+, and CI pins the same major; plain Postgres is enough because
//                               test/db/support/supabase-emulation.sql stands in for the Supabase parts), removes it afterwards
//   ELVAR_TEST_DB_ADMIN_URL     use this superuser connection instead (a disposable database! schema `app` is dropped and recreated). If the database
//                               already is a Supabase one (`supabase start`), the emulation is skipped and the real auth schema is used.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { prepareDatabase, appUrlFrom } from '../test/db/support/prepare.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const IMAGE = process.env.ELVAR_TEST_DB_IMAGE || 'postgres:17';
const NAME = `elvar-testdb-${process.pid}`;
const say = (m) => console.log(`[test:db] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

let container = null;
function cleanup() { if (container) { docker('rm', '-f', container); container = null; } }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function waitReady(url, logsOf) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // the official image starts a temporary server for its init scripts and then restarts: wait for the second "ready"
    const ready = !logsOf || (docker('logs', logsOf).stderr + docker('logs', logsOf).stdout).split('ready to accept connections').length - 1 >= 2;
    if (ready) {
      const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 3 });
      try { await sql`select 1`; await sql.end(); return; } catch { try { await sql.end({ timeout: 1 }); } catch { /* ignore */ } }
    }
    await sleep(500);
  }
  throw new Error('Postgres did not become ready in time');
}

async function main() {
  let adminUrl = process.env.ELVAR_TEST_DB_ADMIN_URL;
  if (!adminUrl) {
    if (docker('version', '--format', '{{.Server.Version}}').status !== 0) throw new Error('Docker is not available. Start it, or set ELVAR_TEST_DB_ADMIN_URL to a disposable Postgres.');
    say(`starting ${IMAGE} in Docker`);
    const r = docker('run', '-d', '--rm', '--name', NAME, '-e', 'POSTGRES_PASSWORD=elvar_test', '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw',
      IMAGE, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=100');
    if (r.status !== 0) throw new Error('docker run failed: ' + r.stderr);
    container = NAME;
    const port = /:(\d+)\s*$/m.exec(docker('port', NAME, '5432/tcp').stdout)?.[1];
    if (!port) throw new Error('could not find the published port');
    adminUrl = `postgres://postgres:elvar_test@127.0.0.1:${port}/postgres`;
    await waitReady(adminUrl, NAME);
  } else { await waitReady(adminUrl, null); }

  say('preparing the database (emulation if needed, migrations)');
  await prepareDatabase(adminUrl, (m) => process.env.ELVAR_TEST_DB_VERBOSE && say(m));

  say('running test/db/*.test.mjs');
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', './test/_env.mjs', '--test', 'test/db/*.test.mjs'], {
      cwd: ROOT, stdio: 'inherit',
      env: { ...process.env, ELVAR_TEST_DB_ADMIN_URL: adminUrl, ELVAR_TEST_DB_APP_URL: appUrlFrom(adminUrl), ELVAR_TEST_MODE: '1' },
    });
    p.on('exit', (c, s) => resolve(c ?? (s ? 1 : 0)));
  });
  return code;
}

main().then((code) => { cleanup(); process.exit(code); }).catch((e) => { console.error('[test:db]', e.message || e); cleanup(); process.exit(1); });
