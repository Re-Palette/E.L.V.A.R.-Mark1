// ファイル library + print flow: the pure logic (tested in test/files.test.mjs). No DOM, no IndexedDB here.
// Files stay on this device. Printing goes through the browser's print dialog, so the printer is chosen there; the web cannot list printers or read their state.

export const MB = 1024 * 1024;
// The per-file import limit lives here and nowhere else (messages, the screen and the docs read it from LIMITS).
export const LIMITS = { perFile: 60 * MB, total: 600 * MB, previewText: 200 * 1024, printText: 1 * MB, maxCopies: 20, maxLog: 100 };
/** How much of a big file is read for the "memory" (index). Beyond these caps the text is cut and the screen says so. */
export const EXTRACT = { textBytes: 2 * MB, textChars: 2 * MB, pdfPages: 300, xlsxRows: 500, xlsxSheets: 20, pptxSlides: 300, entryBytes: 24 * MB, imageHead: 256 * 1024 };
import { searchFiles, parseDateQuery, fileInRange, kindFromQuery } from './file-index.js';
import { timeZone } from './brand.js';
import { localParts, localDate, localHM } from '../../shared/tz.js';

const EXT = {
  pdf: { kind: 'pdf', mime: 'application/pdf', label: 'PDF' },
  png: { kind: 'image', mime: 'image/png', label: '画像（PNG）' },
  jpg: { kind: 'image', mime: 'image/jpeg', label: '画像（JPEG）' },
  jpeg: { kind: 'image', mime: 'image/jpeg', label: '画像（JPEG）' },
  webp: { kind: 'image', mime: 'image/webp', label: '画像（WebP）' },
  gif: { kind: 'image', mime: 'image/gif', label: '画像（GIF）' },
  txt: { kind: 'text', mime: 'text/plain', label: 'テキスト' },
  log: { kind: 'text', mime: 'text/plain', label: 'テキスト' },
  md: { kind: 'text', mime: 'text/markdown', label: 'Markdown' },
  markdown: { kind: 'text', mime: 'text/markdown', label: 'Markdown' },
  csv: { kind: 'text', mime: 'text/csv', label: 'CSV' },
  tsv: { kind: 'text', mime: 'text/tab-separated-values', label: 'TSV' },
  json: { kind: 'text', mime: 'application/json', label: 'JSON' },
  doc: { kind: 'office', mime: 'application/msword', label: 'Word' },
  docx: { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  xls: { kind: 'office', mime: 'application/vnd.ms-excel', label: 'Excel' },
  xlsx: { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  ppt: { kind: 'office', mime: 'application/vnd.ms-powerpoint', label: 'PowerPoint' },
  pptx: { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
};
const MIME_EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json' };
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.markdown,.csv,.tsv,.json,.log,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

export const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim()); return m ? m[1].toLowerCase() : ''; };

/** What kind of file is this? The extension wins (browsers report odd types for csv/md); the reported type is the fallback. */
export function classify(name, mime = '') {
  let ext = extOf(name);
  if (!EXT[ext] && !ext) { const byMime = MIME_EXT[String(mime).toLowerCase().split(';')[0]]; ext = byMime || (/^text\/plain/i.test(mime) ? 'txt' : ext); }   // the reported type is only used for names without an extension
  const e = EXT[ext];
  if (!e) return { ok: false, kind: 'other', ext, mime: String(mime || ''), label: '不明', reason: 'この形式は取り込めません（PDF・画像・テキスト・CSV・JSON・Word・Excel・PowerPointに対応しています）' };
  return { ok: true, kind: e.kind, ext, mime: e.mime, label: e.label, previewable: e.kind !== 'office', printable: e.kind !== 'office', brainable: e.kind === 'text' };
}

/** A file name that is safe to show, store and offer for download: no path, no control or reserved characters, at most 100 characters (the extension is kept). */
export function safeName(name) {
  let s = String(name ?? '').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/[<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!s) return 'ファイル';
  if (s.length > 100) { const ext = extOf(s), keep = ext ? ext.length + 1 : 0; s = s.slice(0, 100 - keep) + (keep ? s.slice(-keep) : ''); }
  return s;
}

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

/** Can a file of `size` bytes be added when `used` bytes are already stored? `deviceFree` = what navigator.storage.estimate() says is left (optional, an estimate).
 *  `limits.account` = the numbers are the account's quota (the answer is worded like the server's); otherwise they are this device's. */
export function checkQuota({ name = 'ファイル', size, used = 0, deviceFree = null }, limits = LIMITS) {
  if (!(size > 0)) return { ok: false, reason: `「${name}」は空のファイルのため取り込めません` };
  if (size > limits.perFile) return { ok: false, reason: `「${name}」は ${fmtSize(size)} あり、1ファイル ${fmtSize(limits.perFile)} までのため取り込めません` };
  if (limits.account && used + size > limits.total) return { ok: false, reason: `保存容量の上限に達しました（使用中 ${fmtSize(used)} ／ 上限 ${fmtSize(limits.total)}）。このファイル（${fmtSize(size)}）を入れるには、あと ${fmtSize(used + size - limits.total)} の空きが必要です。不要なファイルを削除してから、もう一度お試しください` };   // the account's meter (the server says the same, and also counts the extracted text)
  if (used + size > limits.total) return { ok: false, reason: `保存の上限（合計 ${fmtSize(limits.total)}）を超えるため「${name}」は取り込めません（いま ${fmtSize(used)} 使用中・残り ${fmtSize(Math.max(0, limits.total - used))}）。要らないファイルを削除してください` };
  if (deviceFree != null && Number.isFinite(deviceFree) && size * 1.1 > deviceFree) return { ok: false, reason: `この端末の保存領域の空きが足りない可能性があります（ブラウザの見積もりで残り約 ${fmtSize(deviceFree)}、「${name}」は ${fmtSize(size)}）。要らないファイルを削除するか、端末の空きを増やしてください` };
  return { ok: true };
}
export function quotaText(used, limits = LIMITS, space = null, persisted = null) {
  let t = `${fmtSize(used)} / ${fmtSize(limits.total)} 使用中（この端末だけに保存・1ファイル ${fmtSize(limits.perFile)} まで）`;
  if (space) t += `　端末の空き：約 ${fmtSize(space.free)}（ブラウザの見積もり）`;
  if (persisted === false) t += '　※ ブラウザが容量不足のとき自動で消す可能性があります';
  return t;
}

/**
 * The account's storage meter (docs/ELVAR_MULTIUSER.md 6.2, 6.4). `u` is what GET /api/elvar/files returns as `usage`: bytes used (files, extracted text, notes, conversation),
 * reserved (uploads in progress), the quota and the per-file limit. null when there are no numbers (not loaded yet).
 */
export function meterModel(u) {
  if (!u || !Number.isFinite(u.quotaBytes) || u.quotaBytes <= 0) return null;
  const b = u.breakdown || {}, used = u.usedBytes || 0, reserved = u.reservedBytes || 0, quota = u.quotaBytes;
  const pct = (n) => Math.min(100, (n / quota) * 100), total = used + reserved;
  return {
    used, reserved, quota, pct: Math.round(pct(total) * 10) / 10, hot: total / quota >= 0.8, full: total >= quota, maxFile: u.maxFileBytes || LIMITS.perFile,
    parts: [['f', 'ファイルの原本', b.files || 0], ['x', '読み取った文字', b.text || 0], ['n', 'ノート', b.notes || 0], ['m', '会話の記録', b.messages || 0], ['r', 'アップロード中', reserved]].filter(([, , n]) => n > 0).map(([k, label, n]) => ({ k, label, bytes: n, width: pct(n) })),
  };
}
export function accountQuotaText(u) {
  const m = meterModel(u); if (!m) return 'アカウントに保存（あなただけが見られます）';
  return `使用中 ${fmtSize(m.used + m.reserved)} / ${fmtSize(m.quota)}（${m.pct}%）・1ファイル ${fmtSize(m.maxFile)} まで・あなたのアカウントにだけ保存`;
}

// ---------------------------------------------------------------- finding a file by what the owner said
export function normalizeName(s, { stripExt = true } = {}) {
  let t = String(s ?? '').normalize('NFKC').toLowerCase();
  if (stripExt) t = t.replace(/\.[a-z0-9]{1,8}$/, '');
  t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return t.replace(/[\s_\-・.,、。「」『』()（）\[\]【】"'’]+/g, '');
}
/** What the owner said, reduced to the name: 「請求書をプリントして」 -> 請求書 */
export function cleanQuery(q) {
  let t = String(q ?? '').normalize('NFKC').trim().replace(/\s?[(（]\d{1,2}\/\d{1,2}[)）]$/, '');
  t = t.replace(/(を|の)?(プリント|印刷|いんさつ|ぷりんと)(して|してください|お願い|おねがい|したい|する)?$/u, '').replace(/(ファイル|資料のファイル)$/u, '');
  t = t.replace(/[をはが]$/u, '');
  return t.trim();
}
const bigrams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; };
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a && a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b); let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
export function nameScore(query, name) {
  const cq = cleanQuery(query), q = normalizeName(cq), n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const toks = cq.split(/[\s\u3000]+/).map((t) => normalizeName(t, { stripExt: false })).filter(Boolean);   // 「議事録 2月」: every word must be in the name
  if (toks.length > 1 && toks.every((t) => n.includes(t))) return Math.min(0.95, 0.7 + 0.25 * (toks.join('').length / n.length));
  if (n.includes(q)) return Math.min(0.95, 0.65 + 0.3 * (q.length / n.length));
  if (q.length >= 3 && q.includes(n) && n.length >= 2) return 0.6 + 0.25 * (n.length / q.length);
  return Math.round(dice(q, n) * 0.85 * 1000) / 1000;
}
export const LAST_DOC_RE = /(さっき|先ほど|さきほど|直前|いま作った|今作った|最後に作った|最新)の?(資料|ドキュメント|PDF|pdf|やつ|もの|ファイル)?/;

/**
 * Pick the file the owner meant. @returns {{kind:'none'}|{kind:'one', file, score}|{kind:'many', items:[{file,score}]}}
 * files: [{id,name,addedAt,...}], lastDocId: the document ELVAR made most recently (may be a transient entry).
 */
export function matchFiles(files, query, { lastDocId = null, minScore = 0.45, indexes = null, texts = null, now = Date.now() } = {}) {
  const list = Array.isArray(files) ? files : [];
  const raw = String(query ?? '').trim();
  if (!raw) return { kind: 'none' };
  if (lastDocId && LAST_DOC_RE.test(raw)) { const f = list.find((x) => x.id === lastDocId); if (f) return { kind: 'one', file: f, score: 1 }; }
  // Content-aware scores (kind / keywords / tags / dates) only when the library has an index; the name score stays the primary signal.
  const content = new Map(); let outside = null;
  if (indexes) {
    const dq = parseDateQuery(raw, now), wantsKind = !!kindFromQuery(dq.rest);
    for (const r of searchFiles({ files: list, indexes, texts }, raw, { now, limit: 50, minScore: 0.3 })) content.set(r.file.id, Math.min(0.9, r.score * (wantsKind || dq.range ? 0.95 : 0.8)));
    if (dq.range) { // a period named in the request is a hard condition: files outside it are not candidates
      const ix = (id) => (indexes.get ? indexes.get(id) : indexes[id]);
      outside = new Set(list.filter((f) => !fileInRange(f, ix(f.id), dq.range) && !String(f.name).normalize('NFKC').includes(dq.range.label)).map((f) => f.id));
    }
  }
  const scored = list.map((file) => ({ file, score: outside?.has(file.id) ? 0 : Math.max(nameScore(raw, file.name), content.get(file.id) || 0) })).filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score || (b.file.addedAt || 0) - (a.file.addedAt || 0));
  if (!scored.length) return { kind: 'none' };
  const [a, b] = scored;
  if (!b) return { kind: 'one', file: a.file, score: a.score };
  if (a.score >= 0.99 && b.score < 0.99) return { kind: 'one', file: a.file, score: a.score };
  if (a.score >= 0.6 && a.score - b.score >= 0.15) return { kind: 'one', file: a.file, score: a.score };
  return { kind: 'many', items: scored.filter((x) => a.score - x.score < 0.15).slice(0, 4) };
}
/** Short, distinct button labels for the choice card (the label comes back as the owner's answer, so duplicates get the date). */
export function choiceLabels(items) {
  const names = items.map((x) => x.file.name), dup = (n) => names.filter((m) => m === n).length > 1;
  return items.map((x) => { let l = x.file.name; if (dup(l)) { const d = localParts(x.file.addedAt || 0, timeZone()); l = `${l.slice(0, 16)}(${d.month}/${d.day})`; } return l.length > 24 ? l.slice(0, 11) + '…' + l.slice(-12) : l; });
}

// ---------------------------------------------------------------- print job
const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNum(s) {
  if (s === '十') return 10;
  let m = /^十([一二三四五六七八九])$/.exec(s); if (m) return 10 + KANJI[m[1]];
  m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s); if (m) return KANJI[m[1]] * 10 + (m[2] ? KANJI[m[2]] : 0);
  return KANJI[s] || NaN;
}
export const clampCopies = (n) => { n = Math.floor(Number(n)); return Number.isFinite(n) && n >= 1 ? Math.min(n, LIMITS.maxCopies) : 1; };
/** 「2部」「二部ずつ」「３枚」 -> 2 / 2 / 3. Anything unclear is the fallback (1); never above LIMITS.maxCopies. */
export function parseCopies(text, fallback = 1) {
  const t = String(text ?? '').normalize('NFKC');
  const m = /([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*(部|枚|コピー|通|セット)/.exec(t);
  if (!m) return clampCopies(fallback);
  const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : kanjiNum(m[1]);
  return Number.isFinite(n) ? clampCopies(n) : clampCopies(fallback);
}

/** How this file can be printed from the page: pdf | image | text | download (office) | none. */
export function printMode(file) {
  const c = classify(file?.name, file?.type);
  if (!c.ok) return 'none';
  return c.kind === 'office' ? 'download' : c.kind;
}
export const PRINTER_NOTE = '印刷ダイアログで、接続されているプリンターを選びます（このアプリからはプリンターの一覧や状態は分かりません）';

/** The lines of the approval card: exactly what will happen. Pure (tested). */
export function approvalLines(file, { copies = 1, pages = null, truncatedAt = 0, canPrint = true } = {}) {
  const c = classify(file.name, file.type), mode = printMode(file), n = clampCopies(copies);
  const lines = [`「${file.name}」を印刷します`];
  lines.push(`種類：${c.label}　サイズ：${fmtSize(file.size)}　ページ数：${pages ? pages + ' ページ' : '不明'}`);
  lines.push(`部数：${n} 部${n > 1 ? '' : '（変えるときは「2部で」のように言い直してください）'}`);
  if (mode === 'download') {
    lines.push('※ このファイルはブラウザでは印刷できません。承認すると、端末にダウンロードします。印刷は、ダウンロードしたファイルを Word / Excel / PowerPoint などで開いて行います。');
  } else if (!canPrint) {
    lines.push('※ このアプリ（Androidアプリ）では印刷ダイアログを開けません。承認すると、端末の「ダウンロード」に保存します。印刷は、保存したファイルを開いて、端末の印刷機能で行います。');
  } else {
    lines.push(PRINTER_NOTE);
    if (mode === 'text' && truncatedAt) lines.push(`※ 長いため、先頭の ${fmtSize(truncatedAt)} だけを印刷します。`);
    if (n > 1 && mode === 'pdf') lines.push('※ 部数は、プリンターのダイアログでも確認してください。');
  }
  lines.push('※ 承認するまでは、何も印刷しません。');
  return lines;
}

export const TROUBLESHOOT = [
  'プリンターの電源が入っていて、このパソコン／スマホにつながっているか確認してください（USB・Wi-Fi・Bluetooth）。',
  '印刷ダイアログの「送信先／プリンター」で、使うプリンターが選ばれているか確認してください。',
  'パソコン（Chrome）では、ダイアログの「送信先」から別のプリンターを選べます。通常使うプリンターの設定も確認してください。',
  'Androidでは、設定の「接続済みのデバイス → 接続の設定 → 印刷」で、プリンターのサービス（プラグイン）が有効になっている必要があります。',
  'ダイアログで「キャンセル」を押した場合は、印刷されません。もう一度「印刷して」とお申し付けください。',
];

// ---------------------------------------------------------------- print log (this device only)
export function addLog(log, entry, max = LIMITS.maxLog) {
  const e = { id: entry.id || `${entry.at || Date.now()}-${Math.random().toString(36).slice(2, 6)}`, file: String(entry.file || '').slice(0, 100), at: entry.at || Date.now(), outcome: ['printed', 'failed', 'unknown', 'saved'].includes(entry.outcome) ? entry.outcome : 'unknown', copies: clampCopies(entry.copies || 1) };
  return [e, ...(Array.isArray(log) ? log : [])].slice(0, max);
}
export const OUTCOME_JA = { printed: '印刷できた', failed: '印刷できなかった', unknown: '結果は未確認', saved: 'ダウンロードに保存' };
export function formatLogEntry(e) {
  const d = localParts(e.at || 0, timeZone());
  return `${d.month}/${d.day} ${localHM(e.at || 0, timeZone())}　${e.file}　${e.copies > 1 ? e.copies + '部　' : ''}${OUTCOME_JA[e.outcome] || e.outcome}`;
}

// ---------------------------------------------------------------- text / html helpers
export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Bytes -> text. UTF-8 when valid, else Shift_JIS (CSV from Excel). Cut at `max` bytes. */
export function decodeText(bytes, max = Infinity, { cut: alreadyCut = false } = {}) {
  const cut = bytes.length > max ? bytes.subarray(0, max) : bytes;
  let text = null;
  // A cut can end in the middle of a UTF-8 character: step back (at most 3 bytes) before deciding the file is not UTF-8.
  // `cut: true` = the caller already cut `bytes` out of a longer file (the extraction reads only the first 2 MB), so its end may be mid-character too.
  for (let k = 0; k <= (cut === bytes && !alreadyCut ? 0 : 3) && text === null; k++) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(cut.subarray(0, cut.length - k)); } catch { /* next */ } }
  if (text === null) { try { text = new TextDecoder('shift_jis').decode(cut); } catch { text = new TextDecoder('utf-8').decode(cut); } }
  return { text: text.replace(/^\uFEFF/, ''), truncated: bytes.length > max || alreadyCut };
}

const PRINT_CSS = '@page{margin:14mm}html,body{margin:0;padding:0;background:#fff;color:#000}';
/** Standalone HTML for the hidden print frame. Everything the owner's file contains is escaped; nothing in it can run. */
export function textPrintHtml(name, text, copies = 1) {
  const pre = `<pre>${escHtml(text)}</pre>`;
  return `<!doctype html><meta charset="utf-8"><title>${escHtml(name)}</title><style>${PRINT_CSS}pre{margin:0;font:10.5pt/1.5 ui-monospace,Menlo,Consolas,"Noto Sans Mono CJK JP","MS Gothic",monospace;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}.c{break-after:page}.c:last-child{break-after:auto}</style>${Array.from({ length: clampCopies(copies) }, () => `<div class="c">${pre}</div>`).join('')}`;
}
export function imagePrintHtml(name, src, copies = 1) {
  return `<!doctype html><meta charset="utf-8"><title>${escHtml(name)}</title><style>${PRINT_CSS}.c{height:calc(100vh - 1px);display:flex;align-items:center;justify-content:center;break-after:page;overflow:hidden}.c:last-child{break-after:auto}img{max-width:100%;max-height:100%;object-fit:contain}</style>${Array.from({ length: clampCopies(copies) }, () => `<div class="c"><img src="${escHtml(src)}" alt=""></div>`).join('')}`;
}

/** Page count of a PDF without parsing it (fallback only; the page prefers pdf-lib). Counts /Type /Page objects. null if none are found. */
export function countPdfPagesRough(bytes) {
  let s = ''; const CH = 0x8000, end = Math.min(bytes.length, 8 * MB);
  for (let i = 0; i < end; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, end)));
  const n = (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  return n > 0 ? n : null;
}

/** The markdown note for "第二の脳にも保存" (text files only). */
export function brainNote(file, text, { now = Date.now() } = {}) {
  const d = localDate(now, timeZone()), ext = extOf(file.name);
  const base = safeName(file.name).replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[/\\#[\]^|]/g, '_') || 'ファイル';
  const fence = text.includes('```') ? '~~~~' : '```';
  const body = ['md', 'markdown', 'txt', 'log'].includes(ext) ? text.trim() : `${fence}${ext}\n${text.trim()}\n${fence}`;
  const content = `# ${base}\n\n- 取り込んだファイル：${file.name}\n- 保存日：${d}\n\n${body}\n`;
  return { path: `ファイル/${base.slice(0, 60)}.md`, content, tooLong: content.length > 19500 };
}
