// Shared by the local Node server (server/index.js) and Vercel Functions (api/*.js).
import crypto from 'node:crypto';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { buildInstruction } from './persona.js';
import { googleConfigured, declarations } from './google/index.js';
import { promptVars } from './profile/vars.js';
import { currentVars } from './profile/index.js';
import { cfgEnv } from './config/resolve.js';
import { brainProfileSummary, profileBlock, brainCatalog, catalogBlock } from './brain.js';

// Changes only when the voice or the greeting wording changes (NOT with every persona / model edit: the saved greeting must survive redeploys) -> clients drop their cached greeting audio.
const GREETING_PROMPT_VERSION = 'g4';
const instructionFor = () => buildInstruction({ google: googleConfigured() });
export function cacheKeyFor(cfg) {
  return crypto.createHash('sha256').update([cfg.voice, GREETING_PROMPT_VERSION].join('\u0001')).digest('hex').slice(0, 12);
}

// Words the recogniser tends to mishear: hint them.
export function vocabFor(vars) {
  return [vars.A, vars.AS, vars.U, vars.UN, '第二の脳', 'ブリーフィング', 'イブニングリキャップ', 'サブエージェント', 'システムチェック', 'Gemini', 'Groq', 'Obsidian'].filter((w, i, a) => w && a.indexOf(w) === i);
}
export const VOCAB = vocabFor(promptVars());

export function readConfig(env = cfgEnv) {
  return {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    voice: env.GEMINI_LIVE_VOICE || 'Kore',
    fallbackModel: env.GEMINI_LIVE_MODEL_FALLBACK || '',   // used only if minting a token for the main model fails
    // How long a pause counts as "finished speaking" (ms). Lower = the reply starts sooner (but may cut in on slow talkers).
    silenceMs: Math.max(100, Math.min(2000, Number(env.GEMINI_LIVE_SILENCE_MS) || 600)),
    prefixMs: Math.max(0, Math.min(1000, env.GEMINI_LIVE_PREFIX_MS === undefined || env.GEMINI_LIVE_PREFIX_MS === '' ? 250 : Number(env.GEMINI_LIVE_PREFIX_MS) || 0)),
    endSens: String(env.GEMINI_LIVE_END_SENSITIVITY || 'low').toLowerCase() === 'high' ? 'HIGH' : 'LOW',
    // LOW (default): small sounds / the reply's own echo are less likely to count as the owner starting to speak (= the reply being cut off).
    startSens: ['high', 'low'].includes(String(env.GEMINI_LIVE_START_SENSITIVITY || '').toLowerCase()) ? String(env.GEMINI_LIVE_START_SENSITIVITY).toUpperCase() : '',   // default: the server's own setting (LOW made it miss the owner's quiet speech)
    // Languages the speech recogniser may choose from (BCP-47). Default Japanese + English only: stops it guessing Korean / Chinese / etc. for unclear audio. '' = automatic.
    inputLangs: (env.GEMINI_LIVE_INPUT_LANGS === undefined ? 'ja-JP,en-US' : env.GEMINI_LIVE_INPUT_LANGS).split(',').map((x) => x.trim()).filter(Boolean),
    accessToken: env.ELVAR_ACCESS_TOKEN || '',
    onVercel: Boolean(env.VERCEL),
  };
}

function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Fail-closed: with no ELVAR_ACCESS_TOKEN only a local (non-Vercel) loopback caller is allowed.
export function isAuthorized(req, cfg) {
  if (!cfg.accessToken) return !cfg.onVercel && isLoopback(req);
  const a = Buffer.from(String(req.headers['x-elvar-token'] || ''));
  const b = Buffer.from(cfg.accessToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Per-process cap (free-tier protection). On serverless this is per warm instance, i.e. best-effort only.
const MAX_TOKENS_PER_HOUR = 30;
const mintLog = [];

export async function mintLiveToken(cfg, { useFallback = false, plain = false } = {}) {
  const now = Date.now();
  while (mintLog.length && now - mintLog[0] > 3600_000) mintLog.shift();
  if (mintLog.length >= MAX_TOKENS_PER_HOUR) throw Object.assign(new Error('rate_limited'), { status: 429 });
  mintLog.push(now);
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
          tools: [{ functionDeclarations: declarations({ alwaysOnly: !googleConfigured() }) }],   // without Google only the self-check tool is offered
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
          ...(plain ? {} : { outputAudioTranscription: {} }),   // the assistant's own words as text too (for the conversation log in the second brain; no on-screen transcript of them)
          inputAudioTranscription: plain ? {} : { ...(cfg.inputLangs?.length ? { languageCodes: cfg.inputLangs } : {}), customVocabulary: vocabFor(currentVars()) },   // plain=1: the client's safe retry if the server rejects the language hints
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
    return { token: token.name, model: cfg.fallbackModel, cacheKey: cacheKeyFor({ ...cfg, model: cfg.fallbackModel }), fallback: true };
  }
  try { token = await create(model); }
  catch (e) {
    // Backup: if the main Live model cannot be used (renamed / retired / not available to this key), try GEMINI_LIVE_MODEL_FALLBACK once.
    if (!cfg.fallbackModel || cfg.fallbackModel === cfg.model || e?.status === 429) throw e;
    console.warn('[live-token] main model failed, trying the fallback model:', e?.message || e);
    token = await create(cfg.fallbackModel); model = cfg.fallbackModel; fellBack = true;
  }
  return { token: token.name, model, cacheKey: cacheKeyFor({ ...cfg, model }), ...(fellBack ? { fallback: true } : {}) };
}

// Framework-neutral request handlers returning { status, body }.
export async function handleLiveToken(req, cfg) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  if (!isAuthorized(req, cfg)) return { status: 401, body: { error: 'unauthorized' } };
  if (!cfg.apiKey) return { status: 503, body: { error: 'GEMINI_API_KEY is not set on the server' } };
  const useFallback = /[?&]fallback=1\b/.test(String(req.url || '')), plain = /[?&]plain=1\b/.test(String(req.url || ''));
  try {
    return { status: 200, body: await mintLiveToken(cfg, { useFallback, plain }) };
  } catch (e) {
    if (e?.message === 'no_fallback') return { status: 404, body: { error: 'no_fallback' } };
    console.error('[live-token]', e?.status || '', e?.message || e);
    return { status: e?.status === 429 ? 429 : 500, body: { error: e?.status === 429 ? 'rate_limited' : 'internal_error' } };
  }
}

export function handleHealth(cfg) {
  return { status: 200, body: { ok: true, geminiConfigured: Boolean(cfg.apiKey), accessTokenConfigured: Boolean(cfg.accessToken), model: cfg.model, fallbackModel: Boolean(cfg.fallbackModel) } };
}

export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(html);
}

export function sendJson(res, { status, body }) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
