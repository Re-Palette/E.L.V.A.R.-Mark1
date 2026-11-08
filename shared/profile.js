// The owner profile: neutral defaults, a lenient merge (for stored / env profiles) and a strict validator (for input from the UI).
// Plain ES module with no dependencies: the server (vault, API) and the browser (wizard, settings) use the same rules.
// Nothing here may identify a real person: the owner-specific values come from the stored profile.
import { isValidTimeZone } from './tz.js';

const frozen = (o) => (o && typeof o === 'object' ? Object.freeze(Array.isArray(o) ? o.map(frozen) : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, frozen(v)]))) : o);

export const DEFAULT_PROFILE = frozen({
  version: 1,
  assistant: {
    displayName: 'E.L.V.A.R.',
    spokenName: 'エルヴァー',
    expansion: 'Evolving Learning Virtual Adaptive Reasoning',
    voice: 'Kore',
    speechRate: 1.2,
    personaPreset: 'butler',
    customPersona: '',
    voiceStyle: '落ち着いた丁寧な口調で、やや早口に',
  },
  owner: {
    name: 'User',
    reading: 'ユーザー',
    romaji: 'User',
    address: 'ご主人様',
    addressReading: 'ごしゅじんさま',
    avoidAddresses: ['お客様', 'あなた様'],
    useAddressSparingly: true,
  },
  locale: { language: 'ja', replyLanguages: ['ja', 'en'], inputLangs: ['ja-JP', 'en-US'], timeZone: 'Asia/Tokyo', currency: 'JPY' },
  home: { city: '東京', labelEn: 'TOKYO', lat: 35.6895, lon: 139.6917 },
  greeting: { template: 'All systems online. Good {partOfDay}, {honorific}.', honorific: 'sir', language: 'en' },
  briefing: {
    morning: { enabled: true, from: '05:30', to: '08:00' },
    evening: { enabled: true, from: '18:00', to: '23:59' },
    newsTopics: [],
  },
  school: { enabled: false, label: '大学', periodTimes: { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'] }, termStartMonths: [4, 10] },
  work: { enabled: false, eventPrefix: 'バイト：', nightPremium: { from: '22:00', to: '05:00', rate: 0.25 } },
  preferences: { vocabulary: [], interests: [], notes: '' },
  features: { finance: true, shift: false, courses: false, build: false, humanProtocol: true, notifications: true },
});

// ---- lenient merge: keep each value the same type as its default, so a wrongly shaped profile falls back instead of crashing.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function merge(d, v) {
  if (v === undefined || v === null) return d;
  if (Array.isArray(d)) return Array.isArray(v) ? v : d;
  if (isObj(d)) { const src = isObj(v) ? v : {}; const out = { ...src }; for (const k of Object.keys(d)) out[k] = merge(d[k], src[k]); return out; }
  if (d !== null && d !== undefined && typeof v !== typeof d) return d;
  return v;
}
/** A (possibly partial / hostile) stored profile merged over the defaults. */
export function mergeProfile(partial) { return merge(DEFAULT_PROFILE, isObj(partial) ? partial : {}); }

// ---- strict validation of what the UI sends
export const PERSONA_PRESETS = ['butler', 'friendly', 'concise', 'custom'];
export const LANGUAGES = ['ja', 'en'];
export const FEATURE_KEYS = Object.keys(DEFAULT_PROFILE.features);
export const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * @param {unknown} input  the whole profile as sent by the client (unknown keys are dropped; missing ones take the stored/default value)
 * @param {object} [base]  the profile to complete from (default: DEFAULT_PROFILE)
 * @returns {{ok:boolean, profile:object, errors:{path:string, message:string}[]}}
 */
export function validateProfile(input, base = DEFAULT_PROFILE) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const src = isObj(input) ? input : {};
  const baseP = mergeProfile(base);
  const out = {};

  const section = (name) => (isObj(src[name]) ? src[name] : {});
  const str = (sec, key, { max = 80, req = false, multiline = false, path } = {}) => {
    const p = path || `${sec}.${key}`, raw = (isObj(src[sec]) ? src[sec] : {})[key];
    const cur = baseP[sec][key];
    if (raw === undefined) return cur;
    if (typeof raw !== 'string') { err(p, '文字で入力してください'); return cur; }
    const v = multiline ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
    if (CTRL.test(v) || (!multiline && /[\n\r\t]/.test(v))) { err(p, '使えない文字が入っています'); return cur; }
    if (req && !v) { err(p, '入力してください'); return cur; }
    if (v.length > max) { err(p, `${max}文字までです`); return cur; }
    return v;
  };
  const num = (sec, key, min, max, label) => {
    const raw = section(sec)[key], cur = baseP[sec][key];
    if (raw === undefined) return cur;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) { err(`${sec}.${key}`, `${label}は ${min} から ${max} の数にしてください`); return cur; }
    return raw;
  };
  const bool = (obj, key, cur, path) => { const raw = obj[key]; if (raw === undefined) return cur; if (typeof raw !== 'boolean') { err(path, 'オンかオフで指定してください'); return cur; } return raw; };
  const list = (raw, cur, path, { max, item, each }) => {
    if (raw === undefined) return cur;
    if (!Array.isArray(raw) || raw.length > max) { err(path, `${max}件までの一覧にしてください`); return cur; }
    const res = [];
    for (const x of raw) { if (typeof x !== 'string') { err(path, '文字で入力してください'); return cur; } const t = x.trim(); if (!t) continue; if (t.length > item || CTRL.test(t) || (each && !each.test(t))) { err(path, `「${t.slice(0, 12)}」は使えません`); return cur; } if (!res.includes(t)) res.push(t); }
    return res;
  };
  const oneOf = (sec, key, allowed, label) => { const raw = section(sec)[key], cur = baseP[sec][key]; if (raw === undefined) return cur; if (!allowed.includes(raw)) { err(`${sec}.${key}`, `${label}を選び直してください`); return cur; } return raw; };

  out.version = 1;
  out.assistant = {
    displayName: str('assistant', 'displayName', { req: true, max: 40 }),
    spokenName: str('assistant', 'spokenName', { req: true, max: 40 }),
    expansion: str('assistant', 'expansion', { max: 120 }),
    voice: (() => { const v = str('assistant', 'voice', { req: true, max: 40 }); if (!/^[A-Za-z0-9_-]+$/.test(v)) { err('assistant.voice', '声の名前が正しくありません'); return baseP.assistant.voice; } return v; })(),
    speechRate: num('assistant', 'speechRate', 0.5, 2, '話す速さ'),
    personaPreset: oneOf('assistant', 'personaPreset', PERSONA_PRESETS, '話し方'),
    customPersona: str('assistant', 'customPersona', { max: 2000, multiline: true }),
    voiceStyle: str('assistant', 'voiceStyle', { max: 80 }),
  };
  out.owner = {
    name: str('owner', 'name', { req: true, max: 40 }),
    reading: str('owner', 'reading', { max: 40 }),
    romaji: str('owner', 'romaji', { max: 40 }),
    address: str('owner', 'address', { req: true, max: 40 }),
    addressReading: str('owner', 'addressReading', { max: 40 }),
    avoidAddresses: list(section('owner').avoidAddresses, baseP.owner.avoidAddresses, 'owner.avoidAddresses', { max: 10, item: 40 }),
    useAddressSparingly: bool(section('owner'), 'useAddressSparingly', baseP.owner.useAddressSparingly, 'owner.useAddressSparingly'),
  };
  {
    const l = section('locale');
    const tz = l.timeZone === undefined ? baseP.locale.timeZone : l.timeZone;
    let timeZone = baseP.locale.timeZone;
    if (typeof tz !== 'string' || !isValidTimeZone(tz)) err('locale.timeZone', 'タイムゾーンが正しくありません（例: Asia/Tokyo）'); else timeZone = tz;
    const cur = l.currency === undefined ? baseP.locale.currency : l.currency;
    let currency = baseP.locale.currency;
    if (typeof cur !== 'string' || !/^[A-Z]{3}$/.test(cur)) err('locale.currency', '通貨コードは英大文字3文字です（例: JPY）'); else currency = cur;
    const replyLanguages = list(l.replyLanguages, baseP.locale.replyLanguages, 'locale.replyLanguages', { max: 4, item: 5, each: new RegExp(`^(${LANGUAGES.join('|')})$`) });
    out.locale = {
      language: oneOf('locale', 'language', LANGUAGES, '言語'),
      replyLanguages: replyLanguages.length ? replyLanguages : baseP.locale.replyLanguages,
      inputLangs: list(l.inputLangs, baseP.locale.inputLangs, 'locale.inputLangs', { max: 8, item: 16, each: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/ }),
      timeZone, currency,
    };
  }
  out.home = {
    city: str('home', 'city', { max: 80 }),
    labelEn: str('home', 'labelEn', { max: 80 }),
    lat: num('home', 'lat', -90, 90, '緯度'),
    lon: num('home', 'lon', -180, 180, '経度'),
  };
  out.greeting = {
    template: str('greeting', 'template', { req: true, max: 200 }),
    honorific: str('greeting', 'honorific', { max: 40 }),
    language: oneOf('greeting', 'language', LANGUAGES, '挨拶の言語'),
  };
  {
    const b = section('briefing'), win = (k) => {
      const w = isObj(b[k]) ? b[k] : {}, cur = baseP.briefing[k], r = { enabled: bool(w, 'enabled', cur.enabled, `briefing.${k}.enabled`), from: cur.from, to: cur.to };
      for (const f of ['from', 'to']) if (w[f] !== undefined) { if (typeof w[f] === 'string' && HM.test(w[f])) r[f] = w[f]; else err(`briefing.${k}.${f}`, '時刻は 07:30 の形で入力してください'); }
      return r;
    };
    out.briefing = { morning: win('morning'), evening: win('evening'), newsTopics: list(b.newsTopics, baseP.briefing.newsTopics, 'briefing.newsTopics', { max: 10, item: 40 }) };
  }
  {
    const s = section('school'), pt = baseP.school.periodTimes;
    let periodTimes = pt;
    if (s.periodTimes !== undefined) {
      if (!isObj(s.periodTimes)) err('school.periodTimes', '時限の形式が正しくありません');
      else {
        const res = {}; let bad = false;
        for (const [k, v] of Object.entries(s.periodTimes)) if (!/^[1-9]$/.test(k) || !Array.isArray(v) || v.length !== 2 || !HM.test(v[0]) || !HM.test(v[1]) || v[0] >= v[1]) bad = true; else res[k] = [v[0], v[1]];
        if (bad) err('school.periodTimes', '時限は 09:00〜10:30 の形（開始が終了より前）で入力してください'); else periodTimes = res;
      }
    }
    let termStartMonths = baseP.school.termStartMonths;
    if (s.termStartMonths !== undefined) { if (Array.isArray(s.termStartMonths) && s.termStartMonths.length >= 1 && s.termStartMonths.length <= 4 && s.termStartMonths.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) termStartMonths = [...s.termStartMonths]; else err('school.termStartMonths', '学期の開始月は 1〜12 の数で入力してください'); }
    out.school = { enabled: bool(s, 'enabled', baseP.school.enabled, 'school.enabled'), label: str('school', 'label', { max: 40 }), periodTimes, termStartMonths };
  }
  {
    const w = section('work'), np = isObj(w.nightPremium) ? w.nightPremium : {}, cur = baseP.work.nightPremium, night = { ...cur };
    for (const f of ['from', 'to']) if (np[f] !== undefined) { if (typeof np[f] === 'string' && HM.test(np[f])) night[f] = np[f]; else err(`work.nightPremium.${f}`, '時刻は 22:00 の形で入力してください'); }
    if (np.rate !== undefined) { if (typeof np.rate === 'number' && np.rate >= 0 && np.rate <= 1) night.rate = np.rate; else err('work.nightPremium.rate', '割増率は 0 から 1 の数にしてください'); }
    out.work = { enabled: bool(w, 'enabled', baseP.work.enabled, 'work.enabled'), eventPrefix: str('work', 'eventPrefix', { max: 40 }), nightPremium: night };
  }
  {
    const p = section('preferences');
    out.preferences = {
      vocabulary: list(p.vocabulary, baseP.preferences.vocabulary, 'preferences.vocabulary', { max: 30, item: 40 }),
      interests: list(p.interests, baseP.preferences.interests, 'preferences.interests', { max: 30, item: 40 }),
      notes: str('preferences', 'notes', { max: 2000, multiline: true }),
    };
  }
  {
    const f = section('features'); out.features = {};
    for (const k of FEATURE_KEYS) out.features[k] = bool(f, k, baseP.features[k], `features.${k}`);
  }
  return { ok: errors.length === 0, profile: out, errors };
}
