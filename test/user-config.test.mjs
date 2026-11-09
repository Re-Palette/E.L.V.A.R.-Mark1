// The configuration of a signed-in user's request and of cron is an ALLOWLIST (review P1-4 / P1-5): only keys the ledger marks `platform: true`
// fall back to the platform environment. Every other key in the ledger, every family member that is not a platform default, and any unknown
// name come back undefined, even when the platform environment has a value for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, KEY_PREFIXES, keyInfo, isPlatformDefault } from '../server/config/keys.js';
import { env, cfgEnv, runWithConfig, currentConfig } from '../server/config/resolve.js';
import { userConfigShell, cronConfig, strictConfig } from '../server/auth/user-config.js';

const uid = { uid: '11111111-1111-4111-8111-111111111111' };
const LEAK = 'PLATFORM-OWNER-VALUE';
const names = [...KEYS.map((k) => k.name), 'NOT_IN_THE_LEDGER', 'ELVAR_PROFILE_X', 'AGENT_LLM_SOMETHING', 'ROUTE_NEWS', 'STD_FAST_MODEL', 'toString', '__proto__', ''];

async function withEnvAll(fn) {
  const saved = {};
  for (const n of names) if (n) { saved[n] = process.env[n]; process.env[n] = LEAK; }
  try { return await fn(); } finally { for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } }
}

for (const [label, make] of [['user', () => userConfigShell({ uid })], ['cron', () => cronConfig()]]) {
  test(`${label} context: every key of the ledger and an unknown name -> only platform defaults come from the environment`, () => withEnvAll(async () => {
    await runWithConfig(make(), async () => {
      for (const n of names) {
        const want = isPlatformDefault(n) ? LEAK : undefined;
        assert.equal(env(n), want, `${label}: env(${JSON.stringify(n)})`);
        assert.equal(cfgEnv[n], want, `${label}: cfgEnv[${JSON.stringify(n)}]`);
        assert.equal(currentConfig().get(n), want, `${label}: cfg.get(${JSON.stringify(n)})`);
      }
    });
  }));
}

test('the allowlist: no secret, no owner personal setting, no infrastructure key is a platform default; models and public URLs are', () => {
  for (const k of KEYS) if (k.kind === 'secret') assert.ok(!isPlatformDefault(k.name), k.name);
  for (const n of ['BRAIN_REPO', 'BRAIN_BRANCH', 'BRAIN_DIR', 'BUILD_REPO', 'BUILD_SELF_REPO', 'BUILD_GITHUB_TOKEN', 'WEATHER_PLACE', 'GOOGLE_TIMEZONE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SERVICES', 'GOOGLE_READONLY',
    'ELVAR_PROFILE', 'ELVAR_ACCESS_TOKEN', 'ELVAR_SETUP_CODE', 'ELVAR_DB_URL', 'ELVAR_KEK', 'ELVAR_KEK_PREV', 'SUPABASE_SECRET_KEY', 'CRON_SECRET', 'UPSTASH_REDIS_REST_TOKEN', 'GEMINI_LIVE_VOICE', 'GEMINI_LIVE_INPUT_LANGS',
    'SARASHINA_ENABLED', 'CLAUDE_SESSION_RUN_LIMIT', 'GEMINI_LIVE_DAILY_MINUTES', 'NO_SUCH_KEY']) assert.equal(isPlatformDefault(n), false, n);
  for (const n of ['GROQ_MODEL', 'GEMINI_LIVE_MODEL', 'DEEP_THINK_FALLBACK_MODEL', 'WEB_SEARCH_MODEL', 'SARASHINA_MODEL', 'SARASHINA_BASE_URL', 'METNO_USER_AGENT', 'ELVAR_PUBLIC_ORIGIN', 'AGENT_LLM_MEMORY', 'ROUTE_NEWS']) assert.equal(isPlatformDefault(n), true, n);
  for (const p of KEY_PREFIXES) assert.equal(keyInfo(p + 'X').platform, true, p);
  // a platform default is never a secret or something that identifies the owner: keep the list reviewable
  const allowed = KEYS.filter((k) => k.platform).map((k) => k.name).sort();
  assert.deepEqual(allowed, ['DEEP_THINK_FALLBACK_MODEL', 'ELVAR_PUBLIC_ORIGIN', 'GEMINI_LIVE_END_SENSITIVITY', 'GEMINI_LIVE_MODEL', 'GEMINI_LIVE_MODEL_FALLBACK', 'GEMINI_LIVE_PREFIX_MS', 'GEMINI_LIVE_SILENCE_MS',
    'GEMINI_LIVE_START_SENSITIVITY', 'GROQ_MODEL', 'GROQ_REASONING', 'METNO_USER_AGENT', 'REASONING_PROVIDER', 'ROUTE_SEARCH_QUICK', 'SARASHINA_AGENT_MODEL', 'SARASHINA_BASE_URL', 'SARASHINA_FAST_MODEL', 'SARASHINA_MODEL',
    'SUBAGENT_GEMINI_MODEL', 'SUBAGENT_MODEL', 'SUBAGENT_PROVIDER', 'VERCEL', 'WEB_SEARCH_MODEL', 'WEB_SEARCH_PROVIDER']);
});

test('a value the user set wins; absence never falls through to a non-platform environment value', () => withEnvAll(async () => {
  const own = { get: (n) => ({ BRAIN_REPO: 'me/my-notes', GROQ_MODEL: 'mine' })[n] };
  await runWithConfig(strictConfig({ mode: 'user' }, own), async () => {
    assert.equal(env('BRAIN_REPO'), 'me/my-notes'); assert.equal(env('GROQ_MODEL'), 'mine');
    assert.equal(env('BRAIN_BRANCH'), undefined, 'not set by the user, not a platform default');
  });
}));

test('the router gives cron the strict configuration, not the owner-mode environment', async () => {
  const { createRouter } = await import('../server/router.js');
  const { getDb, resetDb } = await import('../server/db/index.js');
  await resetDb(); await getDb();
  process.env.CRON_SECRET = 'c'.repeat(32); process.env.BRAIN_REPO = LEAK; process.env.GEMINI_API_KEY = LEAK; process.env.GROQ_MODEL = 'platform-model';
  try {
    const route = createRouter([{ method: 'POST', path: '/api/elvar/t/c', auth: 'cron', handler: () => ({ status: 200, body: { repo: env('BRAIN_REPO') ?? null, key: env('GEMINI_API_KEY') ?? null, model: env('GROQ_MODEL') ?? null, mode: currentConfig().auth.mode } }) }]);
    const r = await route({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'c'.repeat(32) }, socket: {} }, { pathname: '/api/elvar/t/c', body: {} });
    assert.deepEqual(r, { status: 200, body: { repo: null, key: null, model: 'platform-model', mode: 'cron' } });
  } finally { delete process.env.BRAIN_REPO; delete process.env.GEMINI_API_KEY; delete process.env.GROQ_MODEL; delete process.env.CRON_SECRET; await resetDb(); }
});
