// Personal Finance in the second brain (private repo): a monthly ledger (家計/YYYY-MM.md), a budget (家計/予算.md), asset snapshots (家計/資産.md) and
// category rules the owner taught (家計/分類ルール.md). Everything is computed by plain code from those notes (no model arithmetic); the 家計担当 agent and the
// voice model only explain the numbers. There is no bank connection: entries come from the owner's voice, receipts/statements in mail, payment notifications
// on the phone, and pasted card/bank CSV text.
import crypto from 'node:crypto';
import { brainReadRaw, brainWrite, brainRepoIsPrivate, brainConfigured } from './brain.js';
import { U, TZ } from './profile/index.js';
import { localDate } from '../shared/tz.js';

const DAY = 864e5;
const tzDate = (ms) => localDate(ms, TZ());
const yen = (n) => `¥${Math.round(Math.abs(n)).toLocaleString('ja-JP')}`;
export const CATEGORIES = ['食費', '日用品', '交通', '住居', '光熱費', '通信', 'サブスク', '医療', '衣服・美容', '趣味・娯楽', '交際費', '教育', '保険・税金', '貯蓄・投資', 'その他', '収入'];

// ---------------------------------------------------------------- classification (rules first; the owner's own rules win)
const RULES = [
  ['収入', /(給与|給料|賞与|ボーナス|報酬|売上入金|入金|還付|キャッシュバック)/],
  ['サブスク', /(netflix|spotify|prime\s?video|amazon\s?prime|youtube\s?premium|apple\s?(music|one|tv)|icloud|google\s?(one|play)|chatgpt|openai|claude|anthropic|adobe|microsoft\s?365|office\s?365|dropbox|notion|u-?next|disney\+?|hulu|dazn|abema|kindle\s?unlimited|audible|月額|定額|サブスク)/i],
  ['通信', /(docomo|ドコモ|au\b|softbank|ソフトバンク|楽天モバイル|ahamo|povo|uq|mineo|ocn|nuro|wi-?fi|プロバイダ|インターネット|スマホ代|携帯)/i],
  ['光熱費', /(電気|ガス代|水道|東京電力|東京ガス|関西電力|電力|ガス料金|光熱)/],
  ['住居', /(家賃|管理費|共益費|敷金|礼金|住宅|ローン返済|更新料)/],
  ['保険・税金', /(保険|年金|税|住民税|所得税|固定資産|国保|健保)/],
  ['交通', /(suica|pasmo|icoca|電車|jr|地下鉄|バス|タクシー|uber(?!\s?eats)|駐車|ガソリン|高速|etc|新幹線|航空|ana|jal|交通)/i],
  ['食費', /(セブン|ローソン|ファミリーマート|ファミマ|コンビニ|スーパー|イオン|ライフ|西友|まいばすけっと|業務スーパー|マクドナルド|マック|すき家|吉野家|松屋|スタバ|スターバックス|ドトール|カフェ|珈琲|ラーメン|寿司|居酒屋|レストラン|ランチ|ディナー|弁当|パン|ウーバー\s?イーツ|uber\s?eats|出前館|食事|外食|食品|飲み物|飲料)/i],
  ['日用品', /(ドラッグ|マツモトキヨシ|ウエルシア|ダイソー|セリア|ニトリ|無印|ホームセンター|カインズ|日用品|洗剤|トイレット|ティッシュ)/],
  ['医療', /(病院|クリニック|薬局|歯科|医院|診察|処方|医療|整骨)/],
  ['衣服・美容', /(ユニクロ|gu\b|zara|しまむら|美容院|理容|ヘアサロン|化粧|コスメ|服|靴|クリーニング)/i],
  ['趣味・娯楽', /(映画|ゲーム|steam|playstation|nintendo|任天堂|本|書籍|漫画|amazon|アマゾン|楽天市場|カラオケ|ライブ|チケット|旅行|ホテル|宿泊)/i],
  ['交際費', /(飲み会|会食|プレゼント|ギフト|お祝い|香典|ご祝儀|交際)/],
  ['教育', /(学費|授業料|塾|スクール|講座|udemy|セミナー|受験|参考書)/i],
  ['貯蓄・投資', /(積立|nisa|投資|証券|ideco|株|ファンド|貯金)/i],
];
/** @param {string} description  @param {{keyword:string,category:string}[]} learned the owner's own rules (checked first) */
export function classify(description, learned = []) {
  const d = String(description || '');
  for (const r of learned) if (r.keyword && d.toLowerCase().includes(r.keyword.toLowerCase())) return r.category;
  for (const [cat, re] of RULES) if (re.test(d)) return cat;
  return 'その他';
}

// ---------------------------------------------------------------- ledger format
const HEAD = '| id | 日付 | 金額 | カテゴリ | 内容 | 支払い | 出所 | 備考 |\n|---|---|---|---|---|---|---|---|';
const cell = (s) => String(s ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
const normDesc = (s) => cell(s).toLowerCase().replace(/[\s　・\-_（）()]/g, '');
export const monthOf = (date) => String(date).slice(0, 7);
const pathOf = (month) => `家計/${month}.md`;

export function parseLedger(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\|\s*([0-9a-f]{6})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(-?\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|?\s*$/);
    if (m) out.push({ id: m[1], date: m[2], amount: Number(m[3]), category: m[4].trim(), description: m[5].trim(), method: m[6].trim(), source: m[7].trim(), note: m[8].trim() });
  }
  return out;
}
const idFor = (e, n) => crypto.createHash('sha1').update(`${e.date}|${e.amount}|${normDesc(e.description)}|${n}`).digest('hex').slice(0, 6);
const rowOf = (e) => `| ${e.id} | ${e.date} | ${e.amount} | ${cell(e.category)} | ${cell(e.description)} | ${cell(e.method)} | ${cell(e.source)} | ${cell(e.note)} |`;

const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
/** "今日" / "昨日" / "一昨日" / "3日前" / "11月3日" / "11/3" / "2026年11月3日" / "2026-11-03" → YYYY-MM-DD (owner's time zone), or null. Pure (tested). */
export function parseDateWord(w, nowMs = Date.now()) {
  const t = String(w ?? '').trim(); if (!t) return null;
  const today = tzDate(nowMs), back = (n) => tzDate(nowMs - n * DAY);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^(今日|きょう|本日)$/.test(t)) return today; if (/^(昨日|きのう)$/.test(t)) return back(1); if (/^(一昨日|おととい)$/.test(t)) return back(2);
  let m = t.match(/^(\d{1,2})日前$/); if (m) return back(Number(m[1]));
  m = t.match(/^(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})日?$/); if (m) { const y = m[1] || today.slice(0, 4); return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; }
  return null;
}

/** Normalises what the owner / a parser / a voice model gave (several key spellings are accepted): sign (expense = negative), date (today in the owner's time zone if missing), category (classified if missing). Pure (tested). */
export function normalizeEntry(raw, { nowMs = Date.now(), learned = [], source = '声' } = {}) {
  const description = cell(pick(raw, ['description', 'desc', '内容', 'name', 'item', 'store', 'shop', 'merchant', 'memo', 'title', '店', '用途']) || '').slice(0, 80);
  let amount = Math.round(Number(String(pick(raw, ['amount', 'price', '金額', 'cost', 'yen', '円']) ?? '').replace(/[,，円¥￥\s]/g, '')));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('金額が分かりません');
  if (!description) throw new Error('内容（何に使ったか）が分かりません');
  const dw = pick(raw, ['date', '日付']), date = parseDateWord(dw, nowMs) || tzDate(nowMs);
  const catIn = pick(raw, ['category', 'カテゴリ']);
  let category = CATEGORIES.includes(catIn) ? catIn : classify(description, learned);
  const income = category === '収入' || raw?.income === true || raw?.income === 'true';
  if (income) { category = '収入'; amount = Math.abs(amount); } else amount = -Math.abs(amount);   // an expense is always stored as a negative number
  return { date, amount, category, description, method: cell(pick(raw, ['method', 'payment', '支払い']) || ''), source: cell(raw?.source || source), note: cell(raw?.note || '') };
}

// ---------------------------------------------------------------- storage
async function learnedRules() {
  const t = await brainReadRaw('家計/分類ルール.md').catch(() => null); if (!t) return [];
  return [...t.matchAll(/^\s*[-*]\s*(.+?)\s*(?:→|->|＝|=)\s*(\S+)\s*$/gm)].map((m) => ({ keyword: m[1].trim(), category: m[2].trim() })).filter((r) => CATEGORIES.includes(r.category));
}
async function readMonth(month) { return parseLedger(await brainReadRaw(pathOf(month)).catch(() => null)); }
async function guardPrivate() { if (!(await brainRepoIsPrivate())) throw new Error('第二の脳のリポジトリが公開になっているため、家計のデータは保存しません（プライベートにしてください）'); }

/** Adds entries (classified, deduplicated for imported / notification entries). @returns {{added:object[], skipped:number}} */
export async function addEntries(list, { nowMs = Date.now(), source = '声', dedupe = false } = {}) {
  await guardPrivate();
  const learned = await learnedRules(), byMonth = new Map(), added = []; let skipped = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 80)) {
    const e = normalizeEntry(raw, { nowMs, learned, source: raw?.source || source }), month = monthOf(e.date);
    if (!byMonth.has(month)) byMonth.set(month, await readMonth(month));
    const cur = byMonth.get(month);
    if (dedupe && cur.some((x) => x.date === e.date && x.amount === e.amount && normDesc(x.description) === normDesc(e.description))) { skipped++; continue; }
    e.id = idFor(e, cur.filter((x) => x.date === e.date && x.amount === e.amount && normDesc(x.description) === normDesc(e.description)).length);
    cur.push(e); added.push(e);
  }
  for (const [month, rows] of byMonth) {
    const fresh = added.filter((e) => monthOf(e.date) === month); if (!fresh.length) continue;
    const exists = await brainReadRaw(pathOf(month)).catch(() => null);
    await brainWrite({ path: pathOf(month), content: (exists ? '' : `# 家計 ${month}\n\n金額は、支出がマイナス、収入がプラスです（円）。\n\n${HEAD}\n`) + fresh.map(rowOf).join('\n'), mode: 'append' });
  }
  return { added, skipped };
}

/** Removes one entry by id (the file is rewritten; git history keeps the old version). */
export async function cancelEntry(id, month) {
  await guardPrivate();
  const months = month ? [month] : [tzDate(Date.now()).slice(0, 7), tzDate(Date.now() - 31 * DAY).slice(0, 7)];
  for (const m of months) {
    const text = await brainReadRaw(pathOf(m)).catch(() => null); if (!text) continue;
    const lines = text.split('\n'); const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l));
    if (i >= 0) { const gone = parseLedger(lines[i])[0]; lines.splice(i, 1); await brainWrite({ path: pathOf(m), content: lines.join('\n'), mode: 'replace' }); return { removed: gone }; }
  }
  throw new Error(`id ${id} の記録が見つかりません`);
}


/** Changes one entry (by id; with no id, the most recent one). Only the given fields change; the month file is rewritten (git history keeps the old version). */
export async function updateEntry({ id, patch = {}, nowMs = Date.now() }) {
  await guardPrivate();
  const months = [tzDate(nowMs).slice(0, 7), tzDate(nowMs - 31 * DAY).slice(0, 7)];
  let found = null;
  for (const m of months) {
    const text = await brainReadRaw(pathOf(m)).catch(() => null); if (!text) continue;
    const lines = text.split('\n'); const rows = parseLedger(text);
    const row = id ? rows.find((r) => r.id === id) : rows.at(-1);
    if (row) { found = { m, lines, row }; break; }
  }
  if (!found) throw new Error(id ? `id ${id} の記録が見つかりません` : '直す記録が見つかりません（最近の記録がありません）');
  const old = found.row, learned = await learnedRules();
  const merged = { amount: Math.abs(old.amount), description: old.description, date: old.date, category: old.category, method: old.method, income: old.amount > 0, note: old.note, source: old.source };
  for (const k of ['amount', 'description', 'date', 'category', 'method', 'income']) if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') merged[k] = patch[k];
  const e = normalizeEntry(merged, { nowMs, learned, source: old.source }); e.id = old.id; e.note = [old.note, '修正済み'].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('／');
  const idx = found.lines.findIndex((l) => new RegExp(`^\\|\\s*${old.id}\\s*\\|`).test(l));
  if (monthOf(e.date) === found.m) { found.lines[idx] = rowOf(e); await brainWrite({ path: pathOf(found.m), content: found.lines.join('\n'), mode: 'replace' }); }
  else { found.lines.splice(idx, 1); await brainWrite({ path: pathOf(found.m), content: found.lines.join('\n'), mode: 'replace' }); e.id = idxId(e, await readMonth(monthOf(e.date))); const ex = await brainReadRaw(pathOf(monthOf(e.date))).catch(() => null); await brainWrite({ path: pathOf(monthOf(e.date)), content: (ex ? '' : `# 家計 ${monthOf(e.date)}\n\n金額は、支出がマイナス、収入がプラスです（円）。\n\n${HEAD}\n`) + rowOf(e), mode: 'append' }); }
  return { before: { id: old.id, date: old.date, amount: old.amount, category: old.category, description: old.description }, after: { id: e.id, date: e.date, amount: e.amount, category: e.category, description: e.description } };
}
const idxId = (e, cur) => idFor(e, cur.filter((x) => x.date === e.date && x.amount === e.amount && normDesc(x.description) === normDesc(e.description)).length);

export async function setBudget({ category = '合計', amount }) {
  await guardPrivate();
  const n = Math.round(Number(amount)); if (!Number.isFinite(n) || n < 0) throw new Error('予算の金額が分かりません');
  if (category !== '合計' && !CATEGORIES.includes(category)) throw new Error(`カテゴリは ${['合計', ...CATEGORIES].join(' / ')} のどれかです`);
  const cur = parseBudget(await brainReadRaw('家計/予算.md').catch(() => null)); cur[category] = n;
  const body = `# 月間予算\n\n毎月の予算です（円）。\n\n${Object.entries(cur).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n`;
  await brainWrite({ path: '家計/予算.md', content: body, mode: 'replace' });
  return { budget: cur };
}
export function parseBudget(text) { const o = {}; for (const m of String(text || '').matchAll(/^\s*[-*]\s*(\S+?)\s*[：:]\s*(\d+)/gm)) o[m[1]] = Number(m[2]); return o; }

export async function addAsset({ name, amount, kind = '資産', date, nowMs = Date.now() }) {
  await guardPrivate();
  const n = Math.round(Number(String(amount).replace(/[,，円¥￥\s]/g, ''))); if (!Number.isFinite(n)) throw new Error('金額が分かりません');
  const nm = cell(name).slice(0, 40); if (!nm) throw new Error('名前（預金・現金・投資など）が分かりません');
  const k = kind === '負債' ? '負債' : '資産', d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : tzDate(nowMs);
  const exists = await brainReadRaw('家計/資産.md').catch(() => null);
  await brainWrite({ path: '家計/資産.md', content: (exists ? '' : '# 資産の記録\n\n残高を記録した日ごとの値です（円）。負債はプラスの金額で、種別を「負債」にします。\n\n| 日付 | 名前 | 種別 | 金額 |\n|---|---|---|---|\n') + `| ${d} | ${nm} | ${k} | ${Math.abs(n)} |`, mode: 'append' });
  return { name: nm, kind: k, amount: Math.abs(n), date: d };
}
export function parseAssets(text) { const out = []; for (const m of String(text || '').matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]+)\|\s*(資産|負債)\s*\|\s*(\d+)\s*\|/gm)) out.push({ date: m[1], name: m[2].trim(), kind: m[3], amount: Number(m[4]) }); return out; }

export async function addRule({ keyword, category }) {
  await guardPrivate();
  if (!CATEGORIES.includes(category)) throw new Error(`カテゴリは ${CATEGORIES.join(' / ')} のどれかです`);
  const kw = cell(keyword).slice(0, 30); if (kw.length < 2) throw new Error('キーワードは2文字以上にしてください');
  const exists = await brainReadRaw('家計/分類ルール.md').catch(() => null);
  await brainWrite({ path: '家計/分類ルール.md', content: (exists ? '' : '# 分類ルール\n\n' + U() + 'が教えた分類です。「キーワード → カテゴリ」（内容にキーワードが含まれたら、そのカテゴリにします）。\n\n') + `- ${kw} → ${category}`, mode: 'append' });
  return { keyword: kw, category };
}


// ---------------------------------------------------------------- subscriptions the owner entered by hand (家計/サブスク.md); the last row per name wins (解約 removes it)
export function parseSubscriptions(text) {
  const rows = []; for (const m of String(text || '').matchAll(/^\|\s*([^|\n]+?)\s*\|\s*(\d+)\s*\|\s*(\d{1,2})\s*\|\s*(契約中|解約)\s*\|/gm)) if (m[1] !== '名前') rows.push({ name: m[1], monthly: Number(m[2]), day: Number(m[3]), status: m[4] });
  const last = new Map(); for (const r of rows) last.set(normDesc(r.name), r); return [...last.values()];
}
/** action 'add' (also changes the amount / day of an existing one) or 'cancel' (解約: it disappears from the list and the totals). */
export async function setSubscription({ name, monthly, day, action = 'add', nowMs = Date.now() }) {
  await guardPrivate();
  const nm = cell(name).slice(0, 40); if (!nm) throw new Error('サービスの名前が分かりません');
  const cur = parseSubscriptions(await brainReadRaw('家計/サブスク.md').catch(() => null)), old = cur.find((x) => normDesc(x.name) === normDesc(nm));
  let m = Math.round(Number(String(monthly ?? '').replace(/[,，円¥￥\s]/g, '')));
  if (action === 'cancel') m = old?.monthly || (Number.isFinite(m) && m > 0 ? m : 0);
  else if (!Number.isFinite(m) || m <= 0) throw new Error('月額が分かりません');
  const d = Math.max(1, Math.min(31, Math.round(Number(day) || old?.day || Number(tzDate(nowMs).slice(8)))));
  const exists = await brainReadRaw('家計/サブスク.md').catch(() => null);
  await brainWrite({ path: '家計/サブスク.md', content: (exists ? '' : '# サブスクリプション\n\n' + U() + 'が登録したサブスクです（月額は円、支払日は毎月の日にち）。同じ名前の最後の行が有効で、「解約」にすると一覧から消えます。\n\n| 名前 | 月額 | 支払日 | 状態 |\n|---|---|---|---|\n') + `| ${nm} | ${m} | ${d} | ${action === 'cancel' ? '解約' : '契約中'} |`, mode: 'append' });
  return { name: nm, monthly: m, day: d, status: action === 'cancel' ? '解約' : '契約中', changed: !!old };
}

// ---------------------------------------------------------------- analysis (pure)
const SERVICE_GROUP = [['動画配信', /(netflix|prime\s?video|amazon\s?prime|disney|hulu|u-?next|abema|dazn)/i], ['音楽', /(spotify|apple\s?music|youtube\s?premium|amazon\s?music)/i], ['AI', /(chatgpt|openai|claude|anthropic|gemini|copilot)/i], ['クラウド・ストレージ', /(icloud|google\s?one|dropbox|onedrive)/i]];
const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/** Recurring charges: the same payee in 2+ months with a similar amount (±12 %) and a similar day of month (±4), or the サブスク category. Pure (tested). */
export function findSubscriptions(entries, nowMs = Date.now()) {
  const exp = entries.filter((e) => e.amount < 0), by = new Map();
  for (const e of exp) { const k = normDesc(e.description); if (!k) continue; (by.get(k) || by.set(k, []).get(k)).push(e); }
  const subs = [];
  for (const [, list] of by) {
    const months = [...new Set(list.map((e) => monthOf(e.date)))].sort(); if (months.length < 2 && !list.some((e) => e.category === 'サブスク')) continue;
    const last = [...list].sort((a, b) => a.date.localeCompare(b.date)).at(-1), amt = Math.abs(last.amount);
    const similar = list.filter((e) => Math.abs(Math.abs(e.amount) - amt) <= amt * 0.12), sm = [...new Set(similar.map((e) => monthOf(e.date)))];
    const days = similar.map((e) => Number(e.date.slice(8))), spread = Math.max(...days) - Math.min(...days);
    const recurring = sm.length >= 2 && spread <= 4, tagged = list.some((e) => e.category === 'サブスク');
    if (!recurring && !(tagged && sm.length >= 1)) continue;
    const day = Math.round(days.reduce((a, b) => a + b, 0) / days.length), ym = tzDate(nowMs).slice(0, 7);
    let next = `${ym}-${String(Math.min(day, daysIn(ym))).padStart(2, '0')}`; if (next < tzDate(nowMs)) { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5) , 1)); const nm = d.toISOString().slice(0, 7); next = `${nm}-${String(Math.min(day, daysIn(nm))).padStart(2, '0')}`; }
    subs.push({ name: last.description, monthly: amt, annual: amt * 12, day, nextDate: next, months: sm.length, category: last.category, group: (SERVICE_GROUP.find(([, re]) => re.test(last.description)) || [])[0] || null });
  }
  return subs.sort((a, b) => b.monthly - a.monthly);
}

/** The month at a glance + suggestions. entries = this month; history = earlier months' entries; all numbers computed here. Pure (tested). */
export function summarize({ month, entries = [], history = [], budget = {}, assets = [], manualSubs = [], nowMs = Date.now() }) {
  const exp = entries.filter((e) => e.amount < 0), income = entries.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0);
  const spent = exp.reduce((a, e) => a - e.amount, 0), byCat = {}; for (const e of exp) byCat[e.category] = (byCat[e.category] || 0) + -e.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount, share: spent ? Math.round((amount / spent) * 100) : 0 }));
  const cur = month === tzDate(nowMs).slice(0, 7), dim = daysIn(month), elapsed = cur ? Math.max(1, Number(tzDate(nowMs).slice(8))) : dim;
  const projected = cur ? Math.round((spent / elapsed) * dim) : spent;
  const bStatus = (spentX, b) => ({ budget: b, spent: spentX, remaining: b - spentX, pct: b ? Math.round((spentX / b) * 100) : null, state: !b ? '予算なし' : spentX >= b ? '超過' : spentX >= b * 0.8 ? '注意' : '順調' });
  const budgets = Object.entries(budget).filter(([k]) => k !== '合計').map(([category, b]) => ({ category, ...bStatus(byCat[category] || 0, b) })).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const total = budget['合計'] != null ? { ...bStatus(spent, budget['合計']), projected, projectedOver: cur && projected > budget['合計'], dailyAllowance: cur ? Math.max(0, Math.round((budget['合計'] - spent) / Math.max(1, dim - elapsed + 1))) : null } : null;
  // subscriptions (this month + history)
  const manualKey = new Set(manualSubs.map((m) => normDesc(m.name)));
  const nextOf = (day) => { const ym = tzDate(nowMs).slice(0, 7); let n = `${ym}-${String(Math.min(day, daysIn(ym))).padStart(2, '0')}`; if (n < tzDate(nowMs)) { const nm = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 1)).toISOString().slice(0, 7); n = `${nm}-${String(Math.min(day, daysIn(nm))).padStart(2, '0')}`; } return n; };
  const subs = [...findSubscriptions([...history, ...entries], nowMs).filter((x) => !manualKey.has(normDesc(x.name))),
    ...manualSubs.filter((m) => m.status === '契約中').map((m) => ({ name: m.name, monthly: m.monthly, annual: m.monthly * 12, day: m.day, nextDate: nextOf(m.day), months: 0, category: 'サブスク', group: (SERVICE_GROUP.find(([, re]) => re.test(m.name)) || [])[0] || null, manual: true }))].sort((a, b) => b.monthly - a.monthly);
  const subTotal = subs.reduce((a, s) => a + s.monthly, 0);
  // assets: latest balance per name
  const latest = new Map(); for (const a of [...assets].sort((x, y) => x.date.localeCompare(y.date))) latest.set(`${a.kind}:${a.name}`, a);
  const assetList = [...latest.values()], assetTotal = assetList.filter((a) => a.kind === '資産').reduce((s, a) => s + a.amount, 0), debtTotal = assetList.filter((a) => a.kind === '負債').reduce((s, a) => s + a.amount, 0);
  const netNow = assetTotal - debtTotal, cutoff = tzDate(nowMs - 25 * DAY), older = new Map(); for (const a of [...assets].sort((x, y) => x.date.localeCompare(y.date))) if (a.date <= cutoff) older.set(`${a.kind}:${a.name}`, a);
  const olderList = [...older.values()], netBefore = olderList.length ? olderList.filter((a) => a.kind === '資産').reduce((s, a) => s + a.amount, 0) - olderList.filter((a) => a.kind === '負債').reduce((s, a) => s + a.amount, 0) : null;
  // suggestions (deterministic; each with a rough monthly yen where it can be stated)
  const suggestions = [];
  const prevByCat = {}; const prevMonths = [...new Set(history.map((e) => monthOf(e.date)))].filter((m) => m < month).sort().slice(-1);
  for (const e of history) if (e.amount < 0 && prevMonths.includes(monthOf(e.date))) prevByCat[e.category] = (prevByCat[e.category] || 0) + -e.amount;
  for (const c of cats) { const p = prevByCat[c.category] || 0; if (cur ? false : false) continue; if (p && c.amount >= p * 1.3 && c.amount - p >= 3000) suggestions.push({ text: `${c.category}が先月より${yen(c.amount - p)}（${Math.round((c.amount / p - 1) * 100)}%）増えています（${yen(p)}→${yen(c.amount)}）。内訳を見直す余地があります`, monthlyYen: c.amount - p, kind: 'increase' }); }
  const small = new Map(); for (const e of exp) if (-e.amount < 1000) { const k = normDesc(e.description); const v = small.get(k) || { n: 0, sum: 0, name: e.description }; v.n++; v.sum += -e.amount; small.set(k, v); }
  for (const v of small.values()) if (v.n >= 6 && v.sum >= 3000) suggestions.push({ text: `「${v.name}」の少額の支払いが今月${v.n}回、合計${yen(v.sum)}です。回数を減らすと、積み重なって効きます`, monthlyYen: Math.round(v.sum * 0.3), kind: 'small' });
  const groups = new Map(); for (const s of subs) if (s.group) (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s);
  for (const [g, list] of groups) if (list.length >= 2) { const cheapest = Math.min(...list.map((s) => s.monthly)); suggestions.push({ text: `${g}のサブスクが${list.length}件あります（${list.map((s) => s.name).join('・')}）。使っていないものを1つ解約すると、月${yen(cheapest)}以上の節約です`, monthlyYen: cheapest, kind: 'duplicate-sub' }); }
  if (subs.length >= 3 && subTotal >= 5000) suggestions.push({ text: `サブスクの合計が月${yen(subTotal)}（年${yen(subTotal * 12)}）です。この1か月に使ったかどうかを、見直してみてください`, monthlyYen: 0, kind: 'sub-total' });
  for (const b of budgets) if (b.state === '超過') suggestions.push({ text: `${b.category}が予算を${yen(-b.remaining)}超えています（${yen(b.spent)} / ${yen(b.budget)}）`, monthlyYen: -b.remaining, kind: 'over-budget' });
  suggestions.sort((a, b) => b.monthlyYen - a.monthlyYen);
  return {
    month, today: tzDate(nowMs), spent, income, balance: income - spent, count: exp.length, categories: cats, budgetTotal: total, budgets, projected, subscriptions: subs, subscriptionMonthly: subTotal,
    assets: { list: assetList, assetTotal, debtTotal, net: netNow, netBefore, change: netBefore == null ? null : netNow - netBefore }, suggestions: suggestions.slice(0, 8),
    note: '金額・割合・予測は、記録された支出から計算した値です。月末の予測は、これまでの1日あたりの支出を月の日数に延ばした目安です。記録が少ないほど、不正確になります',
  };
}

const lastMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7)); };

/** The same shape as a real summary, with nothing in it: the screen can always draw every card and chart (also before anything is set up). */
export function emptySummary({ month, nowMs = Date.now(), unconfigured = false } = {}) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : tzDate(nowMs).slice(0, 7);
  return { ...summarize({ month: m, nowMs }), recent: [], monthly: lastMonths(m, 6).reverse().map((mm) => ({ month: mm, spent: 0 })), empty: true, unconfigured };
}

/** Reads the notes and builds the summary for `month` (default: this month). Never throws just because nothing is recorded or the vault is not set up. */
export async function financeSummary({ month, nowMs = Date.now() } = {}) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : tzDate(nowMs).slice(0, 7);
  if (!brainConfigured()) return emptySummary({ month: m, nowMs, unconfigured: true });
  const prior = lastMonths(m, 6).slice(1);
  let entries, hist, budgetText, assetText, subText;
  try {
    [entries, ...hist] = await Promise.all([readMonth(m), ...prior.map(readMonth)]);
    [budgetText, assetText, subText] = await Promise.all([brainReadRaw('家計/予算.md').catch(() => null), brainReadRaw('家計/資産.md').catch(() => null), brainReadRaw('家計/サブスク.md').catch(() => null)]);
  } catch (e) { return { ...emptySummary({ month: m, nowMs }), error: String(e?.message || e).slice(0, 120) }; }
  const s = summarize({ month: m, entries, history: hist.flat(), budget: parseBudget(budgetText), assets: parseAssets(assetText), manualSubs: parseSubscriptions(subText), nowMs });
  return { ...s, recent: [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12), monthly: prior.slice().reverse().map((pm, i) => ({ month: pm, spent: hist[prior.length - 1 - i].filter((e) => e.amount < 0).reduce((a, e) => a - e.amount, 0) })).concat([{ month: m, spent: s.spent }]), empty: !entries.length && !hist.flat().length };
}

// ---------------------------------------------------------------- importing pasted card / bank CSV text
/** One CSV/TSV line → cells; commas inside "quotes" (like "1,490") stay in the cell. Pure (tested). */
export function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of String(line)) { if (ch === '"') q = !q; else if ((ch === ',' || ch === '\t') && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim()); return out;
}
export function parseCsv(text, { nowMs = Date.now() } = {}) {
  const rows = []; const y0 = Number(tzDate(nowMs).slice(0, 4));
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = splitCsvLine(line); if (cols.length < 2) continue;
    const dm = cols.map((c) => c.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/) || c.match(/^(\d{1,2})[/月](\d{1,2})日?$/)).find(Boolean); if (!dm) continue;
    const date = dm.length === 4 ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : `${y0}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
    const amt = cols.map((c) => c.replace(/[,，円¥￥\s]/g, '')).find((c) => /^-?\d{2,9}$/.test(c) && c !== dm[0]); const desc = cols.filter((c) => c && c !== dm[0] && !/^-?[\d,，円¥￥\s]+$/.test(c)).sort((a, b) => b.length - a.length)[0];
    if (amt && desc) rows.push({ date, amount: Math.abs(Number(amt)), description: desc, income: Number(amt) > 0 && /入金|振込|給与/.test(desc) });
  }
  return rows;
}

// ---------------------------------------------------------------- payment notifications on the phone
/** "PayPay: 580円を支払いました（セブン-イレブン）" etc. → { amount, description } | null. Pure (tested); only clear "paid" messages count. */
export function parsePaymentNotification({ app = '', from = '', text = '' } = {}) {
  const t = `${from} ${text}`.replace(/\s+/g, ' ');
  if (!/(支払い|お支払い|ご利用|決済|チャージ|引き落とし|利用がありました|ご請求)/.test(t) || /(キャンペーン|ポイント(?!利用)|お得|クーポン|当選|ログイン)/.test(t) && !/ご利用/.test(t)) return null;
  const m = t.match(/(?:¥|￥)\s?([\d,]{2,9})|([\d,]{2,9})\s?円/); if (!m) return null;
  const amount = Number((m[1] || m[2]).replace(/,/g, '')); if (!amount || amount > 2_000_000) return null;
  const where = (t.match(/[（(]([^）)]{2,30})[）)]/) || t.match(/(?:で|にて)\s*([^\s。、]{2,24})\s*(?:を|の)?(?:支払い|ご利用|決済)/) || t.match(/ご利用先[:：]?\s*([^\s。、]{2,24})/) || [])[1];
  return { amount, description: (where || app || from || '通知').slice(0, 40) };
}
