// Reading a file's content, on this device only (the text never leaves it). Runs inside a Web Worker (file-worker.js) so a 60 MB file cannot freeze the screen,
// and the same code runs in Node for the tests. No DOM: zip reading uses Blob.slice + DecompressionStream, XML is read with plain string scanning.
//   PDF (text layer, via pdfjs-dist, loaded lazily) / Word .docx / Excel .xlsx / PowerPoint .pptx / text, CSV, JSON / images (size + EXIF date; no OCR).
// Old binary Office formats (.doc .xls .ppt) cannot be read: the result says so. Scanned PDFs have no text layer: the result says so, nothing is invented.
import { EXTRACT, classify, decodeText, extOf } from './file-lib.js';

// ---------------------------------------------------------------- small helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; } }
  return ENT[e.toLowerCase()] ?? m;
});
const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true));
const utf8 = new TextDecoder('utf-8');
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
const tick = async (opts) => { if (opts?.signal?.aborted) throw Object.assign(new Error('中止しました'), { cancelled: true }); if (opts?.yieldFn) await opts.yieldFn(); };

// ---------------------------------------------------------------- zip (central directory + one entry at a time)
/** Opens the zip directory of a Blob. Reads only the tail and the central directory; entries are inflated one by one, with a size cap (zip-bomb guard). */
export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('ZIPとして読めません');
  const tailLen = Math.min(size, 65535 + 22 + 20 + 56), tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('ZIPの終端が見つかりません（壊れているか、ZIPではありません）');
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {   // zip64
    const l = e - 20;
    if (l >= 0 && u32(tail, l) === 0x07064b50) {
      const z64 = u64(tail, l + 8), rec = new Uint8Array(await blob.slice(z64, z64 + 56).arrayBuffer());
      if (u32(rec, 0) === 0x06064b50) { count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48); }
    }
  }
  if (cdOff + cdSize > size || cdSize > 64 * 1024 * 1024) throw new Error('ZIPの目次が壊れています');
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), entries = new Map();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8), method = u16(cd, p + 10); let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
    const nl = u16(cd, p + 28), el = u16(cd, p + 30), cl = u16(cd, p + 32); let off = u32(cd, p + 42);
    const name = (flags & 0x800 ? utf8 : new TextDecoder('utf-8')).decode(cd.subarray(p + 46, p + 46 + nl));
    if (usize === 0xffffffff || csize === 0xffffffff || off === 0xffffffff) {   // zip64 extra field
      let q = p + 46 + nl; const end = q + el;
      while (q + 4 <= end) { const id = u16(cd, q), len = u16(cd, q + 2); if (id === 1) { let r = q + 4; if (usize === 0xffffffff) { usize = u64(cd, r); r += 8; } if (csize === 0xffffffff) { csize = u64(cd, r); r += 8; } if (off === 0xffffffff) off = u64(cd, r); break; } q += 4 + len; }
    }
    entries.set(name, { name, method, csize, usize, off, encrypted: !!(flags & 1) });
    p += 46 + nl + el + cl;
  }
  return {
    names: () => [...entries.keys()], has: (n) => entries.has(n), entry: (n) => entries.get(n),
    /** @returns {Promise<{bytes:Uint8Array, truncated:boolean}|null>} null when the entry does not exist */
    async read(name, maxBytes = EXTRACT.entryBytes) {
      const en = entries.get(name); if (!en) return null;
      if (en.encrypted) throw new Error('パスワードで保護されているため読み取れません');
      const lh = new Uint8Array(await blob.slice(en.off, en.off + 30).arrayBuffer());
      if (u32(lh, 0) !== 0x04034b50) throw new Error('ZIPの中身が壊れています');
      const start = en.off + 30 + u16(lh, 26) + u16(lh, 28), data = blob.slice(start, start + en.csize);
      if (en.method === 0) { const b = new Uint8Array(await data.slice(0, maxBytes).arrayBuffer()); return { bytes: b, truncated: en.csize > maxBytes }; }
      if (en.method !== 8) throw new Error('未対応のZIP圧縮方式です');
      const reader = data.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = []; let total = 0, truncated = false;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (total + value.length > maxBytes) { chunks.push(value.subarray(0, maxBytes - total)); total = maxBytes; truncated = true; await reader.cancel().catch(() => {}); break; }
        chunks.push(value); total += value.length;
      }
      const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return { bytes: out, truncated };
    },
    async text(name, maxBytes) { const r = await this.read(name, maxBytes); return r ? { text: utf8.decode(r.bytes), truncated: r.truncated } : null; },
  };
}

// ---------------------------------------------------------------- Word
const textRuns = (xml, tag) => { let s = ''; for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))) s += unxml(m[1]); return s; };
/** word/styles.xml -> Map(styleId -> style name), to know which paragraphs are headings (Japanese Word uses ids like "1" for 見出し 1). */
export function wordStyleNames(xml) {
  const m = new Map();
  for (const s of String(xml || '').matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="([^"]*)"/g)) m.set(s[1], s[2]);
  return m;
}
/** word/document.xml -> { text, headings, title }. Paragraphs, tabs, line breaks, table cells. */
export function docxText(xml, styles = new Map()) {
  const out = [], headings = []; let title = '', cur = '', style = '', cellStart = false, joinNext = false;
  const flush = () => {
    const t = cur.replace(/\s+$/, '');
    if (t.trim()) {
      if (cellStart && joinNext && out.length) out[out.length - 1] += '\t' + t; else out.push(t);   // table cells of one row share a line, separated by tabs
      const nm = (styles.get(style) || style || '').toLowerCase();
      if (/^(title|タイトル)$/.test(nm)) title ||= t.trim(); else if (/^(heading|見出し)\s*\d/.test(nm)) { headings.push(t.trim()); if (/(^|\s)1$/.test(nm)) title ||= t.trim(); }
    }
    if (t.trim() || cur) cellStart = false;
    cur = ''; style = '';
  };
  const re = /<w:p\b[^>]*>|<\/w:p>|<w:pStyle\b[^>]*w:val="([^"]*)"|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>|<w:tc\b[^>]*>|<\/w:tc>|<\/w:tr>/g;
  for (const m of String(xml).matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith('<w:pStyle')) style = m[1];
    else if (tok.startsWith('<w:t ') || tok.startsWith('<w:t>')) cur += unxml(m[2]);
    else if (tok.startsWith('<w:tab')) cur += '\t';
    else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) cur += '\n';
    else if (tok.startsWith('<w:tc')) cellStart = true;
    else if (tok === '</w:tc>') { joinNext = true; cellStart = false; }
    else if (tok === '</w:tr>') joinNext = false;
    else if (tok === '</w:p>') flush();
    else if (tok.startsWith('<w:p')) { if (cur) flush(); }
  }
  flush();
  return { text: out.join('\n'), headings, title };
}
const coreTitle = (xml) => { const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml || ''); return m ? unxml(m[1]).trim() : ''; };

async function extractDocx(zip, opts) {
  const doc = await zip.text('word/document.xml'); if (!doc) throw new Error('Wordの本文（word/document.xml）が見つかりません');
  await tick(opts);
  const styles = wordStyleNames((await zip.text('word/styles.xml', 4 * 1024 * 1024))?.text), core = await zip.text('docProps/core.xml', 1024 * 1024);
  const d = docxText(doc.text, styles);
  return { text: d.text, title: d.title || coreTitle(core?.text), headings: d.headings, entryTruncated: doc.truncated };
}

// ---------------------------------------------------------------- Excel
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/i.exec(ref || '')?.[0]?.toUpperCase() || '') n = n * 26 + ch.charCodeAt(0) - 64; return Math.max(0, n - 1); };
export function sharedStringsOf(xml) {
  const out = [];
  for (const si of String(xml || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(textRuns(si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't'));
  return out;
}
/** One worksheet's xml -> rows of cell text (first `maxRows` rows). Numbers are shown as stored (dates stay serial numbers). */
export function sheetRows(xml, shared, maxRows = EXTRACT.xlsxRows) {
  const rows = []; let total = 0;
  for (const r of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    total++;
    if (rows.length >= maxRows) continue;
    const cells = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || '', t = /\bt="(\w+)"/.exec(attrs)?.[1], ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      let v = '';
      if (t === 's') v = shared[Number(/<v>(\d+)<\/v>/.exec(body)?.[1])] ?? '';
      else if (t === 'inlineStr') v = textRuns(body, 't');
      else { const m = /<v>([\s\S]*?)<\/v>/.exec(body); v = m ? unxml(m[1]) : ''; if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE'; }
      const i = ref ? colIndex(ref) : cells.length; while (cells.length < i) cells.push(''); cells[i] = String(v).replace(/[\t\r\n]+/g, ' ');
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    rows.push(cells.join('\t'));
  }
  return { rows, total };
}
async function extractXlsx(zip, opts) {
  const wb = await zip.text('xl/workbook.xml', 4 * 1024 * 1024); if (!wb) throw new Error('Excelのブック（xl/workbook.xml）が見つかりません');
  const rels = (await zip.text('xl/_rels/workbook.xml.rels', 1024 * 1024))?.text || '', relMap = new Map();
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) { const id = /\bId="([^"]+)"/.exec(r[0])?.[1], tg = /\bTarget="([^"]+)"/.exec(r[0])?.[1]; if (id && tg) relMap.set(id, tg.startsWith('/') ? tg.slice(1) : 'xl/' + tg.replace(/^\.\//, '')); }
  const shared = sharedStringsOf((await zip.text('xl/sharedStrings.xml'))?.text), sheets = [], notes = []; let text = '', rowCount = 0;
  const list = [...wb.text.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(/\bname="([^"]*)"/.exec(m[0])?.[1] || ''), rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] }));
  for (let i = 0; i < list.length; i++) {
    const s = list[i]; sheets.push(s.name);
    if (i >= EXTRACT.xlsxSheets) { if (i === EXTRACT.xlsxSheets) notes.push(`シートが多いため、先頭の${EXTRACT.xlsxSheets}枚だけ読み取りました`); continue; }
    await tick(opts); opts?.onProgress?.({ stage: 'シートを読み取り中', done: i, total: list.length });
    const path = relMap.get(s.rid) || `xl/worksheets/sheet${i + 1}.xml`, x = await zip.text(path); if (!x) continue;
    const { rows, total } = sheetRows(x.text, shared);
    text += `【シート：${s.name}】\n${rows.join('\n')}\n` + (total > rows.length ? `…（${total}行のうち先頭の${rows.length}行）\n` : '') + (x.truncated ? '…（大きいため途中まで）\n' : '') + '\n'; rowCount += total;
    if (total > rows.length) notes.push(`「${s.name}」は${total}行あり、先頭の${rows.length}行だけ読み取りました`);
  }
  const core = await zip.text('docProps/core.xml', 1024 * 1024);
  return { text, title: coreTitle(core?.text), headings: sheets.slice(0, 20), sheets, notes, rowCount };
}

// ---------------------------------------------------------------- PowerPoint
/** Text of one slide / notes page: [{type, text}] per shape, placeholders for slide numbers, dates and footers skipped. */
export function pptxShapes(xml) {
  const out = [];
  for (const sp of String(xml).matchAll(/<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
    const type = /<p:ph\b[^>]*\btype="(\w+)"/.exec(sp[0])?.[1] || '';
    if (['sldNum', 'dt', 'ftr', 'sldImg', 'hdr'].includes(type)) continue;
    const paras = [];
    for (const p of sp[0].matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) { let t = ''; for (const m of p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) t += m[1] === undefined ? '\n' : unxml(m[1]); if (t.trim()) paras.push(t.trim()); }
    if (paras.length) out.push({ type, text: paras.join('\n') });
  }
  return out;
}
async function extractPptx(zip, opts) {
  const slidePaths = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!slidePaths.length) throw new Error('PowerPointのスライドが見つかりません');
  const notes = [], headings = []; let text = '', shown = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    if (i >= EXTRACT.pptxSlides) { notes.push(`スライドが多いため、先頭の${EXTRACT.pptxSlides}枚だけ読み取りました`); break; }
    await tick(opts); opts?.onProgress?.({ stage: 'スライドを読み取り中', done: i, total: slidePaths.length });
    const sx = await zip.text(slidePaths[i]); if (!sx) continue;
    const shapes = pptxShapes(sx.text), title = shapes.find((s) => s.type === 'title' || s.type === 'ctrTitle')?.text || '';
    if (title) headings.push(title.split('\n')[0].slice(0, 80));
    text += `--- スライド ${i + 1}${title ? '：' + title.split('\n')[0] : ''} ---\n` + shapes.filter((s) => s.text !== title).map((s) => s.text).join('\n') + '\n';
    const rel = (await zip.text(slidePaths[i].replace('slides/', 'slides/_rels/') + '.rels', 256 * 1024))?.text || '', nm = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rel);
    if (nm) { const nx = await zip.text('ppt/notesSlides/' + nm[1], 2 * 1024 * 1024); const nt = nx ? pptxShapes(nx.text).filter((s) => s.type === 'body' || s.type === '').map((s) => s.text).join('\n') : ''; if (nt.trim() && !/^\d+$/.test(nt.trim())) text += `[ノート] ${nt}\n`; }
    text += '\n'; shown++;
  }
  const core = await zip.text('docProps/core.xml', 1024 * 1024);
  return { text, title: coreTitle(core?.text) || headings[0] || '', headings, slides: slidePaths.length, notes };
}

// ---------------------------------------------------------------- images: size and the date the photo was taken (no OCR)
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
function exifDate(b, tiff) {
  if (tiff + 8 > b.length) return '';
  const le = b[tiff] === 0x49, r16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]), r32 = (o) => (le ? u32(b, o) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const readIfd = (off, want) => {
    const base = tiff + off; if (base + 2 > b.length) return null;
    const n = r16(base);
    for (let i = 0; i < n && base + 2 + i * 12 + 12 <= b.length; i++) {
      const e = base + 2 + i * 12, tag = r16(e);
      if (tag === want) return { type: r16(e + 2), count: r32(e + 4), val: e + 8 };
    }
    return null;
  };
  const ascii = (ent) => { if (!ent || ent.type !== 2) return ''; const o = ent.count > 4 ? tiff + r32(ent.val) : ent.val; if (o + ent.count > b.length) return ''; return String.fromCharCode(...b.subarray(o, o + ent.count - 1)); };
  const ifd0 = r32(tiff + 4), ptr = readIfd(ifd0, 0x8769);
  let s = ptr ? ascii(readIfd(r32(ptr.val), 0x9003)) : '';
  if (!s) s = ascii(readIfd(ifd0, 0x0132));
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s); return m && +m[1] > 1900 ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
/** @returns {{width:number,height:number,exifDate:string}|null} read from the first bytes of PNG / JPEG / GIF / WebP */
export function imageInfo(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0, exifDate: '' };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16(b, 6), height: u16(b, 8), exifDate: '' };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === 'VP8 ') return { width: u16(b, 26) & 0x3fff, height: u16(b, 28) & 0x3fff, exifDate: '' };
    if (t === 'VP8L') { const v = u32(b, 21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, exifDate: '' }; }
    if (t === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), exifDate: '' };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2, date = '';
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = be16(b, i + 2);
      if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) { try { date = exifDate(b, i + 10); } catch { /* ignore */ } }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: be16(b, i + 5), width: be16(b, i + 7), exifDate: date };
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- PDF (text layer only)
async function extractPdf(blob, opts) {
  if (!opts?.loadPdfjs) throw new Error('PDFの読み取り部品を読み込めませんでした');
  const pdfjs = await opts.loadPdfjs();
  const data = opts.bytes || new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0, cMapUrl: opts.cMapUrl, cMapPacked: true, disableFontFace: true, stopAtErrors: false, ...(opts.pdfOpts || {}) });
  const doc = await task.promise;
  try {
    const n = doc.numPages, limit = Math.min(n, EXTRACT.pdfPages), parts = [], notes = []; let chars = 0, nonSpace = 0, truncated = false;
    let title = ''; try { const md = await doc.getMetadata(); title = String(md?.info?.Title || '').trim(); if (/^(untitled|無題|microsoft word -)/i.test(title) || title.length < 2) title = ''; } catch { /* no metadata */ }
    for (let p = 1; p <= limit; p++) {
      await tick(opts); opts?.onProgress?.({ stage: 'PDFの文字を読み取り中', done: p - 1, total: limit });
      const page = await doc.getPage(p), tc = await page.getTextContent(); let t = '';
      for (const it of tc.items) { if (typeof it.str === 'string') t += it.str; if (it.hasEOL) t += '\n'; }
      page.cleanup?.();
      t = t.replace(/[ \t]+\n/g, '\n').trim(); nonSpace += t.replace(/\s+/g, '').length;
      if (t) { parts.push(t); chars += t.length + 2; }
      if (chars >= EXTRACT.textChars) { truncated = true; notes.push(`文字が多いため、${p}ページまでで読み取りを止めました`); break; }
    }
    if (n > limit) { truncated = true; notes.push(`ページが多いため、先頭の${limit}ページだけ読み取りました（全${n}ページ）`); }
    const text = parts.join('\n\n'), scanned = nonSpace < Math.min(10, limit) ;
    return { text, title, pages: n, textTruncated: truncated, notes, ...(scanned ? { status: 'no_text' } : {}) };
  } finally { try { await doc.destroy(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- the entry point
/**
 * @param {Blob} blob
 * @param {{name:string,type?:string,signal?:AbortSignal,onProgress?:(p:{stage:string,done?:number,total?:number})=>void,loadPdfjs?:()=>Promise<any>,cMapUrl?:string,yieldFn?:()=>Promise<void>}} opts
 * @returns {Promise<{status:'ok'|'no_text'|'image'|'failed'|'unsupported'|'cancelled', text:string, ...}>} never throws: a failure is a result, recorded in the index
 */
export async function extractFile(blob, opts = {}) {
  const c = classify(opts.name, opts.type), ext = extOf(opts.name);
  const base = { text: '', title: '', headings: [], notes: [], pages: 0, textTruncated: false, sheets: [], slides: 0 };
  try {
    if (!c.ok) return { ...base, status: 'unsupported', error: c.reason };
    opts.onProgress?.({ stage: '中身を読み取り中' });
    if (c.kind === 'text') {
      const head = new Uint8Array(await blob.slice(0, EXTRACT.textBytes).arrayBuffer());
      const truncated = blob.size > EXTRACT.textBytes, d = decodeText(head, head.length, { cut: truncated });   // a cut in the middle of a Japanese character is not "not UTF-8"
      return { ...base, text: cut(d.text, EXTRACT.textChars), textTruncated: truncated || d.text.length > EXTRACT.textChars, notes: truncated ? [`長いため、先頭の約${Math.round(EXTRACT.textBytes / 1048576)} MBだけ読み取りました`] : [], status: 'ok' };
    }
    if (c.kind === 'image') {
      const info = imageInfo(new Uint8Array(await blob.slice(0, EXTRACT.imageHead).arrayBuffer()));
      return { ...base, status: 'image', ...(info ? { width: info.width, height: info.height, exifDate: info.exifDate } : {}), notes: ['画像の文字は、この端末では読み取れません（文字認識＝OCRは使えません）。必要なときは「AIで内容を読み取る」（承認が必要）を使えます'] };
    }
    if (c.kind === 'pdf') return { ...base, status: 'ok', ...(await extractPdf(blob, opts)) };
    if (c.kind === 'office') {
      if (!['docx', 'xlsx', 'pptx'].includes(ext)) return { ...base, status: 'unsupported', error: `旧形式（.${ext}）のファイルの中身は読み取れません。新しい形式（.${ext}x）で保存し直すと読み取れます` };
      const zip = await openZip(blob); await tick(opts);
      const r = ext === 'docx' ? await extractDocx(zip, opts) : ext === 'xlsx' ? await extractXlsx(zip, opts) : await extractPptx(zip, opts);
      const notes = [...(r.notes || [])]; if (r.entryTruncated) notes.push('大きいため、本文の途中までしか読み取れていません');
      return { ...base, ...r, notes, status: 'ok', textTruncated: !!r.entryTruncated };
    }
    return { ...base, status: 'unsupported', error: 'この形式の中身は読み取れません' };
  } catch (e) {
    if (e?.cancelled || opts.signal?.aborted) return { ...base, status: 'cancelled', error: '読み取りを中止しました' };
    return { ...base, status: 'failed', error: String(e?.message || e).slice(0, 200) };
  }
}
