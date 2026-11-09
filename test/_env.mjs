// Loaded before every test file (npm test: node --import ./test/_env.mjs --test ...). Tests never touch a real store.
process.env.ELVAR_STORE = 'memory';
for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ELVAR_SETUP_CODE']) delete process.env[k];
// The database layer is the in-memory implementation; user identities may be minted for tests. Real Postgres is only used by npm run test:db.
process.env.ELVAR_DB = 'memory';
process.env.ELVAR_TEST_MODE = '1';
for (const k of ['ELVAR_DB_URL', 'ELVAR_KEK', 'ELVAR_KEK_PREV', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'CRON_SECRET']) delete process.env[k];
