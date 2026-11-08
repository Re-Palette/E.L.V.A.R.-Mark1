// Profile fields as data: rendered by the setup wizard and the settings screen, read back into a partial profile that the server validates
// again (shared/profile.js validateProfile runs on both sides).
import { esc } from '../elvar/ui.js';
import { VOICES, PERSONA_PRESETS } from '../../../shared/profile.js';

const COMMON_TZ = ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];
export function timeZones() { try { const all = Intl.supportedValuesOf('timeZone'); return all.includes('UTC') ? all : [...all, 'UTC']; } catch { return COMMON_TZ; } }
export function browserTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo'; } catch { return 'Asia/Tokyo'; } }

const PRESET_LABEL = { butler: '執事（丁寧・落ち着いた）', friendly: '親しみやすい', concise: '簡潔', custom: '自分で書く' };
export const FIELDS = {
  'owner.name': { label: 'お名前', type: 'text', max: 40, hint: '例: 太郎' },
  'owner.reading': { label: '読み（ひらがな）', type: 'text', max: 40 },
  'owner.address': { label: '呼び方', type: 'text', max: 40, hint: '例: 太郎様' },
  'owner.avoidAddresses': { label: '使わない呼び方（、区切り）', type: 'list', max: 200 },
  'locale.language': { label: '言語', type: 'select', options: [['ja', '日本語'], ['en', 'English']] },
  'locale.timeZone': { label: 'タイムゾーン', type: 'tz' },
  'locale.currency': { label: '通貨（3文字）', type: 'text', max: 3 },
  'home.city': { label: '住んでいる都市（天気の既定）', type: 'text', max: 80, hint: '例: 東京' },
  'home.labelEn': { label: '都市の英字表記（HUD）', type: 'text', max: 80, hint: '例: TOKYO' },
  'assistant.spokenName': { label: 'アシスタントの呼び名', type: 'text', max: 40 },
  'assistant.voice': { label: '声', type: 'select', options: VOICES.map((v) => [v, v]) },
  'assistant.personaPreset': { label: '話し方', type: 'select', options: PERSONA_PRESETS.map((p) => [p, PRESET_LABEL[p] || p]) },
  'assistant.customPersona': { label: '話し方の好み（自由に）', type: 'area', max: 2000 },
  'greeting.template': { label: '起動の挨拶', type: 'text', max: 200, hint: '{partOfDay} = morning など, {honorific} = 呼びかけ' },
  'greeting.honorific': { label: '挨拶での呼びかけ', type: 'text', max: 40, hint: '例: sir' },
  'briefing.morning.from': { label: '朝のブリーフィング 開始', type: 'time' },
  'briefing.morning.to': { label: '朝のブリーフィング 終了', type: 'time' },
  'briefing.evening.from': { label: '夜の振り返り 開始', type: 'time' },
  'briefing.evening.to': { label: '夜の振り返り 終了', type: 'time' },
  'features.finance': { label: '家計の管理', type: 'bool' },
  'features.shift': { label: 'シフト（バイト）の管理', type: 'bool' },
  'features.courses': { label: '履修登録のサポート', type: 'bool' },
  'features.build': { label: '製作依頼（Claude Code）', type: 'bool' },
  'features.humanProtocol': { label: 'ヒューマンプロトコル（人型の表示）', type: 'bool' },
  'features.notifications': { label: 'スマホの通知の読み上げ', type: 'bool' },
};

export const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v; }
const idOf = (p) => 'pf-' + p.replace(/\./g, '-');

/** HTML for the given field paths, filled from `profile` (every value escaped). */
export function renderFields(paths, profile, { disabled = false } = {}) {
  const dis = disabled ? ' disabled' : '';
  return paths.map((p) => {
    const f = FIELDS[p], v = getPath(profile, p), id = idOf(p);
    if (f.type === 'bool') return `<label class="ev-check"><input type="checkbox" id="${id}" data-pf="${p}"${v ? ' checked' : ''}${dis}><span>${esc(f.label)}</span></label>`;
    let input;
    if (f.type === 'select') input = `<select class="ev-select" id="${id}" data-pf="${p}"${dis}>${f.options.map(([val, l]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (f.type === 'tz') input = `<select class="ev-select" id="${id}" data-pf="${p}"${dis}>${timeZones().map((z) => `<option${z === v ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>`;
    else if (f.type === 'area') input = `<textarea class="ev-area" id="${id}" data-pf="${p}" maxlength="${f.max}"${dis}>${esc(v || '')}</textarea>`;
    else if (f.type === 'list') input = `<input class="ev-input" id="${id}" data-pf="${p}" type="text" maxlength="${f.max}" value="${esc((v || []).join('、'))}"${dis}>`;
    else input = `<input class="ev-input" id="${id}" data-pf="${p}" type="${f.type === 'time' ? 'time' : 'text'}"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(v ?? '')}"${f.hint ? ` placeholder="${esc(f.hint)}"` : ''}${dis}>`;
    return `<label class="ev-field"><span>${esc(f.label)}</span>${input}</label>`;
  }).join('');
}

/** The values of the rendered fields under `root`, as a partial profile. */
export function readFields(root) {
  const out = {};
  for (const el of root.querySelectorAll('[data-pf]')) {
    const p = el.dataset.pf, f = FIELDS[p];
    let v;
    if (f.type === 'bool') v = el.checked;
    else if (f.type === 'list') v = el.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
    else v = el.value;
    setPath(out, p, v);
  }
  return out;
}

/** Deep merge of `partial` over `base` (plain objects only), for "the profile as it will be saved". */
export function mergeInto(base, partial) {
  const out = structuredClone(base || {});
  const walk = (dst, src) => { for (const [k, v] of Object.entries(src || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) { dst[k] = dst[k] && typeof dst[k] === 'object' ? dst[k] : {}; walk(dst[k], v); } else dst[k] = v; } };
  walk(out, partial); return out;
}

/** Field errors from validateProfile -> one readable line. */
export const errorText = (errors) => errors.map((e) => `${FIELDS[e.path]?.label || e.path}：${e.message}`).join(' ／ ');
