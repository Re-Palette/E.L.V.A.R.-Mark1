// The greeting prompt, plus a background generator that records the greeting once (no playback, no HUD changes).
import { GoogleGenAI } from '@google/genai';
import { ownerAddress, profileCache } from '../brand.js';

/** The recording prompt for the wake greeting. `vars` = { honorific, ownerAddress, language } (default: the cached profile). */
export function greetingPrompt(line, vars = greetingVars()) {
  const lang = vars.language === 'ja' ? '日本語' : '英文';
  const hon = vars.honorific ? `文中の「${vars.honorific}」は、そのまま読み、「${vars.ownerAddress}」などに言い換えないでください（この挨拶だけの例外です）。` : '';
  return `システム起動の挨拶です。次の${lang}を、一字一句そのまま、ネイティブのように早口で、歯切れよくテンポよく、一度だけ読み上げてください。ゆっくり話したり、間を空けたり、前置きや追加の言葉を足したりしないでください。${hon}：「${line}」`;
}
export function greetingVars(p = profileCache()) {
  return { honorific: p?.greeting?.honorific ?? 'sir', ownerAddress: ownerAddress(), language: p?.greeting?.language || 'en' };
}

export function phrasePrompt(text) {
  return `システムの相槌の録音です。次の日本語を、一字一句そのまま、落ち着いた丁寧な口調で、短く、一度だけ読み上げてください。前置きや追加の言葉、説明は一切付けないでください：「${text}」`;
}

export function decodePcm16(b64) {
  const bin = atob(b64), n = bin.length >> 1, f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = (((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16) / 32768;
  return f32;
}

/**
 * Opens a throw-away Live session, asks for the greeting, returns the raw audio. Never plays it.
 * @param {string} line
 * @param {() => Promise<{token:string, model:string, cacheKey?:string}>} getToken
 */
export async function generateGreeting(line, getToken, { prompt = greetingPrompt, minSec = 0.5 } = {}) {
  const { token, model, cacheKey } = await getToken();
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  const chunks = [];
  let session;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('greeting generation timed out')), 25000);
    ai.live.connect({
      model,
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent; if (!sc) return;
          for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(decodePcm16(p.inlineData.data));
          if (sc.turnComplete) { clearTimeout(timer); resolve(); }
        },
        onerror: (e) => { clearTimeout(timer); reject(new Error('live error')); },
        onclose: () => { clearTimeout(timer); resolve(); },
      },
    }).then((s) => { session = s; s.sendRealtimeInput({ text: prompt(line) }); }, reject);
  }).finally(() => { try { session?.close(); } catch {} });
  const n = chunks.reduce((a, c) => a + c.length, 0);
  if (n < 24000 * minSec) throw new Error('greeting audio too short');
  const pcm = new Float32Array(n); let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return { cacheKey, pcm };
}
