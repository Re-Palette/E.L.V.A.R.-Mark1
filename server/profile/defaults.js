// Neutral default profile. Used before setup, in tests, and as the base for any partial profile.
// Nothing here may identify a real person: the owner-specific values come from the stored profile.
export const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  assistant: Object.freeze({
    displayName: 'E.L.V.A.R.',
    spokenName: 'エルヴァー',
    expansion: 'Evolving Learning Virtual Adaptive Reasoning',
    voice: 'Kore',
    speechRate: 1.2,
    personaPreset: 'butler',
    customPersona: '',
    voiceStyle: '落ち着いた丁寧な口調で、やや早口に',
  }),
  owner: Object.freeze({
    name: 'User',
    reading: 'ユーザー',
    romaji: 'User',
    address: 'ご主人様',
    addressReading: 'ごしゅじんさま',
    avoidAddresses: Object.freeze(['お客様', 'あなた様']),
    useAddressSparingly: true,
  }),
  locale: Object.freeze({ language: 'ja', replyLanguages: Object.freeze(['ja', 'en']), inputLangs: Object.freeze(['ja-JP', 'en-US']), timeZone: 'Asia/Tokyo', currency: 'JPY' }),
  home: Object.freeze({ city: '東京', labelEn: 'TOKYO', lat: 35.6895, lon: 139.6917 }),
  greeting: Object.freeze({ template: 'All systems online. Good {partOfDay}, {honorific}.', honorific: 'sir', language: 'en' }),
  features: Object.freeze({ finance: true, shift: false, courses: false, build: false, humanProtocol: true, notifications: true }),
});

/** Shallow-per-section merge of a (possibly partial) stored profile over the defaults. */
// Keep each value the same type as its default, so a wrongly shaped profile (e.g. a string where a list is expected) falls back instead of crashing.
function sameShape(d, v) {
  if (v === undefined || v === null) return d;
  if (Array.isArray(d)) return Array.isArray(v) ? v : d;
  if (d !== null && d !== undefined && typeof v !== typeof d) return d;
  return v;
}
function mergeSection(d, v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const out = { ...src };
  for (const k of Object.keys(d)) out[k] = sameShape(d[k], src[k]);
  return out;
}

export function mergeProfile(partial) {
  const p = partial && typeof partial === 'object' ? partial : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_PROFILE)) {
    const d = DEFAULT_PROFILE[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) ? mergeSection(d, p[k]) : sameShape(d, p[k]);
  }
  return out;
}
