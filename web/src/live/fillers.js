// Acknowledgements ("かしこまりました。", "作成いたします。", "作成中です。"...) so the owner never faces silence while E.L.V.A.R. is thinking
// or writing a document. The clips are recorded once with the assistant's own voice (like the greeting), kept on this device and played
// locally the instant they are due, so they cost no network time. They are queued before the real answer, never on top of it.
import { generateGreeting, phrasePrompt } from './greeting-gen.js';
import { getGreeting, putGreeting } from './greeting-cache.js';
import { profileCache } from '../brand.js';

// Per language and speaking style (profile.locale.language / assistant.personaPreset). Japanese butler = the original wording.
export const PHRASE_SETS = {
  ja: {
    butler: { ack: ['かしこまりました。', '承知いたしました。'], doc: ['作成いたします。', '作成中です。'], wait: ['少々お待ちください。', '確認いたします。'] },
    friendly: { ack: ['了解です。', 'わかりました。'], doc: ['作りますね。', '作っています。'], wait: ['ちょっと待ってくださいね。', '確認しますね。'] },
    concise: { ack: ['了解。', '承知しました。'], doc: ['作成します。', '作成中。'], wait: ['お待ちください。', '確認中。'] },
  },
  en: {
    butler: { ack: ['Certainly.', 'Very well.'], doc: ['I will prepare it.', 'Working on it.'], wait: ['One moment, please.', 'Let me check.'] },
    friendly: { ack: ['Sure thing.', 'Got it.'], doc: ['On it.', 'Working on it.'], wait: ['Just a sec.', 'Checking now.'] },
    concise: { ack: ['Okay.', 'Understood.'], doc: ['Preparing.', 'Working.'], wait: ['One moment.', 'Checking.'] },
  },
};
export function phrasesFor(p = profileCache()) {
  const lang = PHRASE_SETS[p?.locale?.language] ? p.locale.language : 'ja';
  return PHRASE_SETS[lang][p?.assistant?.personaPreset] || PHRASE_SETS[lang].butler;
}
export const PHRASES = PHRASE_SETS.ja.butler;
export const ALL_PHRASES = [...new Set(Object.values(PHRASES).flat())];
const allPhrases = () => [...new Set(Object.values(phrasesFor()).flat())];
const DOC_WORDS = /資料|ＰＤＦ|PDF|pdf|企画書|レポート|報告書|議事録|提案書|スライド|まとめ.*(作|書)|(作|書)って|作成|ドキュメント/;
export const kindFor = (text) => (DOC_WORDS.test(String(text || '')) ? 'doc' : 'ack');

/**
 * Decide whether a filler is due and which phrase. Pure function (tested).
 * turn: { n: fillers played so far, lastAt, spoke: the model already answered in this turn, last: last phrase }
 * @returns {string|null}
 */
export function nextFiller({ turn, now, silentMs, userText, rnd = Math.random, phrases = phrasesFor() }) {
  const PHRASES = phrases;
  const kind = kindFor(userText);
  const pick = (arr) => { const c = arr.filter((p) => p !== turn.last); return c[Math.floor(rnd() * c.length)] ?? arr[0]; };
  if (turn.n === 0) {
    if (turn.spoke || silentMs < 1100) return null;            // quick answers get no filler at all
    return kind === 'doc' ? PHRASES.doc[0] : pick(PHRASES.ack);
  }
  if (turn.n === 1 && silentMs > 9000 && now - turn.lastAt > 8000) return kind === 'doc' ? PHRASES.doc[1] : PHRASES.wait[0];
  if (turn.n === 2 && silentMs > 24000 && now - turn.lastAt > 12000) return PHRASES.wait[0];
  return null;                                                   // never more than three
}

export function initFillers({ live, store }) {
  const KEY = (p) => 'filler:' + p;
  const clips = new Map();            // phrase -> { pcm, sr }
  let busy = false, retryAt = 0, turn = null, fillerUntil = 0;
  const enabled = () => store.get('elvar_fillers') !== '0';

  async function load() {
    for (const p of allPhrases()) {
      if (clips.has(p)) continue;
      const rec = await getGreeting(KEY(p));
      if (rec && (!live.cacheKey || !rec.key || rec.key === live.cacheKey)) clips.set(p, rec);
    }
  }
  /** Record the missing clips, one at a time, only while idle (no conversation). */
  async function ensureCached() {
    if (busy || live.session || Date.now() < retryAt || !enabled()) return;
    await load();
    const missing = allPhrases().filter((p) => !clips.has(p));
    if (!missing.length) return;
    busy = true;
    try {
      for (const p of missing) {
        if (live.session) break;
        const { cacheKey, pcm } = await generateGreeting(p, () => live.fetchToken({ interactive: false }), { prompt: phrasePrompt, minSec: 0.3 });
        const rec = { key: cacheKey, sr: 24000, pcm }; await putGreeting(KEY(p), rec); clips.set(p, rec);
      }
    } catch (e) { console.warn('[fillers] could not record the acknowledgements:', e?.message ?? e); retryAt = Date.now() + 10 * 60_000; }
    finally { busy = false; }
  }

  /** Called ~5 times a second. */
  function tick() {
    const now = performance.now();
    if (!live.session || !live.userSpoke || !enabled()) { turn = null; return; }      // only after the owner spoke / typed (not for system notes)
    turn ||= { n: 0, lastAt: 0, spoke: false, last: '', begin: now, thinkSince: 0 };
    if (live.lastModelAudioAt > turn.begin) turn.spoke = true;
    const thinking = live.state === 'thinking' || live.pendingTools > 0;
    if (!thinking) { turn.thinkSince = 0; return; }
    turn.thinkSince ||= now;
    if (now < fillerUntil || live.lastModelAudioAt > turn.thinkSince) return;           // our own clip is playing / the real answer is starting
    const phrase = nextFiller({ turn, now, silentMs: now - turn.thinkSince, userText: live.userText });
    const rec = phrase && clips.get(phrase);
    if (!rec) return;
    turn.n++; turn.lastAt = now; turn.last = phrase;
    fillerUntil = now + (rec.pcm.length / (rec.sr || 24000)) * 1000 / Math.max(1, live.speechRate || 1) + 400;
    live.playGreetingRecord({ pcm: rec.pcm }).catch(() => {});                           // queued in the same player: the real answer follows it
  }
  load().catch(() => {});
  return { tick, ensureCached, load, _inject: (p, rec) => clips.set(p, rec), get ready() { return allPhrases().every((p) => clips.has(p)); } };
}
