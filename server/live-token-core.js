// Shared by the local Node server (server/index.js) and Vercel Functions (api/*.js).
import crypto from 'node:crypto';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { buildInstruction } from './persona.js';
import { googleConfigured, declarations } from './google/index.js';
import { promptVars } from './profile/vars.js';
import { currentVars, currentProfile } from './profile/index.js';
import { cfgEnv, currentConfig } from './config/resolve.js';
import { listConnectorDeclarations } from './connectors/index.js';
import { recordUsage, gate, hardLimit } from './usage.js';
export { sendHtml, sendJson } from './http.js';
import { VERSION } from './version.js';
import { brainProfileSummary, profileBlock, brainCatalog, catalogBlock } from './brain.js';

// Changes only when the voice or the greeting wording changes (NOT with every persona / model edit: the saved greeting must survive redeploys) -> clients drop their cached greeting audio.
const GREETING_PROMPT_VERSION = 'g4';
const instructionFor = () => buildInstruction({ google: googleConfigured(), features: currentProfile().features, connectors: currentConfig().connectors });
// The saved greeting audio is valid only for the same voice, wording, address and language: change any of them and clients record it again.
export function cacheKeyFor(cfg, profile = currentProfile()) {
  return crypto.createHash('sha256').update([cfg.voice, GREETING_PROMPT_VERSION, profile.greeting?.template, profile.owner?.address, profile.locale?.language].join('\u0001')).digest('hex').slice(0, 12);
}

// Words the recogniser tends to mishear: hint them.
export function vocabFor(vars, profile) {
  return [vars.A, vars.AS, vars.U, vars.UN, ...(profile?.preferences?.vocabulary || []), '第二の脳', 'ブリーフィング', 'イブニングリキャップ', 'サブエージェント', 'システムチェック', 'Gemini', 'Groq', 'Obsidian'].filter((w, i, a) => w && a.indexOf(w) === i);
}
export const VOCAB = vocabFor(promptVars());

export function readConfig(env = cfgEnv) {
  return {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    voice: env.GEMINI_LIVE_VOICE || currentProfile().assistant.voice || 'Kore',
    fallbackModel: env.GEMINI_LIVE_MODEL_FALLBACK || '',   // used only if minting a token for the main model fails
    // How long a pause counts as "finished speaking" (ms). Lower = the reply starts sooner (but may cut in on slow talkers).
    silenceMs: Math.max(100, Math.min(2000, Number(env.GEMINI_LIVE_SILENCE_MS) || 600)),
    prefixMs: Math.max(0, Math.min(1000, env.GEMINI_LIVE_PREFIX_MS === undefined || env.GEMINI_LIVE_PREFIX_MS === '' ? 250 : Number(env.GEMINI_LIVE_PREFIX_MS) || 0)),
    endSens: String(env.GEMINI_LIVE_END_SENSITIVITY || 'low').toLowerCase() === 'high' ? 'HIGH' : 'LOW',
    // LOW (default): small sounds / the reply's own echo are less likely to count as the owner starting to speak (= the reply being cut off).
    startSens: ['high', 'low'].includes(String(env.GEMINI_LIVE_START_SENSITIVITY || '').toLowerCase()) ? String(env.GEMINI_LIVE_START_SENSITIVITY).toUpperCase() : '',   // default: the server's own setting (LOW made it miss the owner's quiet speech)
    // Languages the speech recogniser may choose from (BCP-47). Default Japanese + English only: stops it guessing Korean / Chinese / etc. for unclear audio. '' = automatic.
    inputLangs: (env.GEMINI_LIVE_INPUT_LANGS === undefined ? currentProfile().locale.inputLangs.join(',') : env.GEMINI_LIVE_INPUT_LANGS).split(',').map((x) => x.trim()).filter(Boolean),
    onVercel: Boolean(env.VERCEL),
  };
}

// Abuse protection: at most `liveTokensPerHour` session tokens an hour PER USER (an administrator can change it per account; default 30), counted in the database, the
// same on every serverless instance. Outside a request (scripts) there is no user and a per-process counter is used.
const MAX_TOKENS_PER_HOUR = 30;
const mintLog = [];
async function mintAllowed(now) {
  const c = currentConfig();
  if (typeof c.hit === 'function') {
    const lim = await hardLimit('liveTokensPerHour');
    if (lim === null) return true;   // unlimited for this account
    return c.hit('mint', 3600, lim ?? MAX_TOKENS_PER_HOUR);
  }
  while (mintLog.length && now - mintLog[0] > 3600_000) mintLog.shift();
  if (mintLog.length >= MAX_TOKENS_PER_HOUR) return false;
  mintLog.push(now); return true;
}

export async function mintLiveToken(cfg, { useFallback = false, plain = false } = {}) {
  const now = Date.now();
  // the user's own stop limit on Live time / starts ("warn" never stops anything); the administrator's hourly limit on starts is mintAllowed below
  await gate('gemini', { metrics: ['live_sessions', 'live_seconds'] });
  if (!(await mintAllowed(now))) throw Object.assign(new Error('rate_limited'), { status: 429 });
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  const [profile, catalog] = await Promise.all([brainProfileSummary().catch(() => null), brainCatalog().catch(() => null)]);
  const instruction = instructionFor() + profileBlock(profile) + catalogBlock(catalog);   // learned profile + what the vault contains (titles); kept out of the greeting cache key
  const create = (model) => ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      // Lock session config server-side so a leaked token cannot change model/persona.
      liveConnectConstraints: {
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: instruction,
          tools: [{ functionDeclarations: [...declarations({ alwaysOnly: !googleConfigured(), features: currentProfile().features }), ...listConnectorDeclarations(currentConfig(), { forVoice: true })] }],   // + the owner's connector tools (<= 24 pinned, the rest via connector_call)   // without Google only the self-check tool is offered
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
          ...(plain ? {} : { outputAudioTranscription: {} }),   // the assistant's own words as text too (for the conversation log in the second brain; no on-screen transcript of them)
          inputAudioTranscription: plain ? {} : { ...(cfg.inputLangs?.length ? { languageCodes: cfg.inputLangs } : {}), customVocabulary: vocabFor(currentVars(), currentProfile()) },   // plain=1: the client's safe retry if the server rejects the language hints
          // Faster turn-taking: treat a short pause as the end of the owner's turn and reply right away.
          realtimeInputConfig: { automaticActivityDetection: { ...(cfg.startSens ? { startOfSpeechSensitivity: StartSensitivity[`START_SENSITIVITY_${cfg.startSens}`] } : {}), endOfSpeechSensitivity: EndSensitivity[`END_SENSITIVITY_${cfg.endSens}`], prefixPaddingMs: cfg.prefixMs, silenceDurationMs: cfg.silenceMs } },
        },
      },
    },
  });
  let token, model = cfg.model, fellBack = false;
  if (useFallback) {   // the client hit the daily Live limit on the main model: use the other model (its own limit, if the limit is per model)
    if (!cfg.fallbackModel || cfg.fallbackModel === cfg.model) throw Object.assign(new Error('no_fallback'), { status: 404 });
    token = await create(cfg.fallbackModel);
    await recordUsage('gemini', 'live_sessions', 1);
    return { token: token.name, model: cfg.fallbackModel, cacheKey: cacheKeyFor({ ...cfg, model: cfg.fallbackModel }), fallback: true };
  }
  try { token = await create(model); }
  catch (e) {
    // Backup: if the main Live model cannot be used (renamed / retired / not available to this key), try GEMINI_LIVE_MODEL_FALLBACK once.
    if (!cfg.fallbackModel || cfg.fallbackModel === cfg.model || e?.status === 429) throw e;
    console.warn('[live-token] main model failed, trying the fallback model:', e?.message || e);
    token = await create(cfg.fallbackModel); model = cfg.fallbackModel; fellBack = true;
  }
  await recordUsage('gemini', 'live_sessions', 1);
  return { token: token.name, model, cacheKey: cacheKeyFor({ ...cfg, model }), ...(fellBack ? { fallback: true } : {}) };
}

// Framework-neutral request handlers returning { status, body }.
// The caller has already been authenticated (withOwner / the router): this only checks the method and the key.
export async function handleLiveToken(req, cfg) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  // the session token is minted with the USER'S OWN Gemini key (cfg.apiKey comes from their app.user_secrets); the platform has no key to fall back to
  if (!cfg.apiKey) return { status: 503, body: { error: 'setup_required', missing: ['GEMINI_API_KEY'] } };
  const useFallback = /[?&]fallback=1\b/.test(String(req.url || '')), plain = /[?&]plain=1\b/.test(String(req.url || ''));
  try {
    return { status: 200, body: await mintLiveToken(cfg, { useFallback, plain }) };
  } catch (e) {
    if (e?.message === 'no_fallback') return { status: 404, body: { error: 'no_fallback' } };
    if (e?.name === 'UsageLimitError') return { status: 429, body: { error: e.code, message: e.message, limit: e.limit } };   // a limit of the user's own (or the administrator's), in Japanese
    console.error('[live-token]', e?.status || '', e?.message || e);
    return { status: e?.status === 429 ? 429 : 500, body: { error: e?.status === 429 ? 'rate_limited' : 'internal_error' } };
  }
}

/** Platform health: nothing about any user, nothing about any key (the platform has none to give). */
export function handleHealth() {
  return { status: 200, body: { ok: true, version: VERSION } };
}
