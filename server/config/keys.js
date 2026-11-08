// The ledger of every configuration key: the single source for the setup wizard, the settings screen,
// the system check and the generated .env.example. kind: 'secret' (vault, write-only) | 'setting' | 'infra' (env only).
const secret = (name, group, label, extra = {}) => ({ name, kind: 'secret', group, label, envNames: [name], ...extra });
const setting = (name, group, label, def, extra = {}) => ({ name, kind: 'setting', group, label, envNames: [name], default: def, ...extra });
const infra = (name, group, label, extra = {}) => ({ name, kind: 'infra', group, label, envNames: [name], ...extra });

export const KEYS = [
  secret('GEMINI_API_KEY', 'gemini', 'Gemini API key', { test: 'gemini' }),
  secret('GROQ_API_KEY', 'groq', 'Groq API key', { test: 'groq' }),
  secret('EXA_API_KEY', 'search', 'Exa API key', { test: 'exa' }),
  secret('NEWSDATA_API_KEY', 'news', 'NewsData API key'),
  secret('SARASHINA_API_KEY', 'sarashina', 'Sarashina API key'),
  secret('BRAIN_GITHUB_TOKEN', 'brain', 'Second-brain GitHub token'),
  secret('BUILD_GITHUB_TOKEN', 'build', 'Build GitHub token'),
  secret('GOOGLE_CLIENT_SECRET', 'google', 'Google OAuth client secret'),
  secret('GOOGLE_REFRESH_TOKEN', 'google', 'Google refresh token'),

  setting('GEMINI_LIVE_MODEL', 'gemini', 'Live model', 'gemini-3.8-live'),
  setting('GEMINI_LIVE_MODEL_FALLBACK', 'gemini', 'Live fallback model', ''),
  setting('GEMINI_LIVE_VOICE', 'gemini', 'Live voice (moves to profile)', 'Kore'),
  setting('GEMINI_LIVE_INPUT_LANGS', 'gemini', 'Input languages (moves to profile)', 'ja-JP,en-US'),
  setting('GEMINI_LIVE_SILENCE_MS', 'gemini', 'Silence before end of speech (ms)', '600'),
  setting('GEMINI_LIVE_PREFIX_MS', 'gemini', 'Prefix padding (ms)', '250'),
  setting('GEMINI_LIVE_END_SENSITIVITY', 'gemini', 'End-of-speech sensitivity', 'low'),
  setting('GEMINI_LIVE_START_SENSITIVITY', 'gemini', 'Start-of-speech sensitivity', ''),
  setting('GEMINI_LIVE_DAILY_MINUTES', 'usage', 'Live minutes per day (guide)', '60'),
  setting('NEWSDATA_DAILY_CREDITS', 'usage', 'NewsData credits per day (guide)', '200'),
  setting('WEB_SEARCH_DAILY', 'usage', 'Web searches per day (guide)', '0'),
  setting('GOOGLE_CLIENT_ID', 'google', 'Google OAuth client id', ''),
  setting('GOOGLE_TIMEZONE', 'google', 'Time zone (moves to profile)', 'Asia/Tokyo'),
  setting('WEATHER_PLACE', 'weather', 'Weather place (moves to profile)', ''),
  setting('BRAIN_REPO', 'brain', 'Second-brain repository (owner/name)', ''),
  setting('BRAIN_BRANCH', 'brain', 'Second-brain branch', 'main'),
  setting('BRAIN_DIR', 'brain', 'Second-brain sub folder', ''),
  setting('BUILD_REPO', 'build', 'Build repository (owner/name)', ''),
  setting('BUILD_SELF_REPO', 'build', 'Repository for requests about this app itself (owner/name)', ''),
  setting('CLAUDE_SESSION_RUN_LIMIT', 'build', 'Claude Code runs per 5 hours (guide)', ''),
  setting('GROQ_MODEL', 'groq', 'Groq model', 'openai/gpt-oss-120b'),
  setting('GROQ_REASONING', 'groq', 'Groq reasoning effort', 'medium'),
  setting('SUBAGENT_PROVIDER', 'agents', 'Sub-agent provider', ''),
  setting('SUBAGENT_MODEL', 'agents', 'Sub-agent model', ''),
  setting('SUBAGENT_GEMINI_MODEL', 'agents', 'Sub-agent Gemini model', ''),
  setting('REASONING_PROVIDER', 'agents', 'Reasoning provider', ''),
  setting('DEEP_THINK_FALLBACK_MODEL', 'agents', 'deep_think fallback model', 'gemini-2.5-flash'),
  setting('WEB_SEARCH_PROVIDER', 'search', 'Web search provider', ''),
  setting('WEB_SEARCH_MODEL', 'search', 'Web search model', 'gemini-2.5-flash'),
  setting('ROUTE_SEARCH_QUICK', 'routing', 'Route: quick search', ''),
  setting('METNO_USER_AGENT', 'weather', 'MET Norway User-Agent', ''),
  setting('SARASHINA_ENABLED', 'sarashina', 'Use Sarashina', ''),
  setting('SARASHINA_BASE_URL', 'sarashina', 'Sarashina base URL', 'https://api.sarashina.ai/v1'),
  setting('SARASHINA_MODEL', 'sarashina', 'Sarashina model', 'sarashina3-mini'),
  setting('SARASHINA_FAST_MODEL', 'sarashina', 'Sarashina fast model', 'sarashina3-nano'),
  setting('SARASHINA_AGENT_MODEL', 'sarashina', 'Sarashina sub-agent model', 'sarashina3-nano'),

  infra('UPSTASH_REDIS_REST_URL', 'store', 'Upstash REST URL'),
  infra('UPSTASH_REDIS_REST_TOKEN', 'store', 'Upstash REST token'),
  infra('KV_REST_API_URL', 'store', 'Vercel KV REST URL'),
  infra('KV_REST_API_TOKEN', 'store', 'Vercel KV REST token'),
  infra('PORT', 'server', 'Local server port'),
  infra('VERCEL', 'server', 'Set by Vercel'),
  infra('ELVAR_ACCESS_TOKEN', 'auth', 'Shared access token (env mode)'),
  infra('ELVAR_PROFILE', 'profile', 'Profile JSON (env mode)'),
  infra('GOOGLE_API_MOCK_ORIGIN', 'test', 'Test only: mock Google origin'),
];

// Families of keys with a variable part (AGENT_LLM_<AGENT>, ROUTE_<CAP>, STD_*_MODEL ...) are settings too.
export const KEY_PREFIXES = ['AGENT_LLM_', 'ROUTE_', 'STD_', 'SUBAGENT_', 'WEB_SEARCH_'];

const BY_NAME = new Map(KEYS.map((k) => [k.name, k]));
export const keyInfo = (name) => BY_NAME.get(name) || (KEY_PREFIXES.some((p) => name.startsWith(p)) ? { name, kind: 'setting', group: 'advanced', label: name, envNames: [name], default: '' } : null);
export const isSecret = (name) => keyInfo(name)?.kind === 'secret';
