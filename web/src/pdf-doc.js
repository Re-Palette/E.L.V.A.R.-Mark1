// Markdown -> A4 PDF, entirely in the browser (pdf-lib + fontkit, Noto Sans JP (pre-reduced to JIS X 0208) embedded). Japanese line breaking by character
// with simple kinsoku (no line starts with 、。）」…), latin words stay whole. Supports headings, paragraphs, bullets (nested), numbered
// lists, check boxes, quotes, code blocks, rules and pipe tables. Characters the font cannot draw (emoji) are dropped, never shown as boxes.
const PAGE = { w: 595.28, h: 841.89, m: 54, top: 60, bottom: 62 };
const NO_START = new Set('、。，．,.）)」』】〕〉》！？!?…・：:；;ー々ゝゞ'.split(''));
const NO_END = new Set('（(「『【〔〈《'.split(''));
const C = { text: [0.10, 0.12, 0.16], accent: [0.07, 0.30, 0.50], mute: [0.38, 0.44, 0.50], rule: [0.74, 0.80, 0.86], tint: [0.93, 0.96, 0.98] };

export function stripInline(t) {
  return String(t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/~~([^~]+)~~/g, '$1');
}

/** Parse the markdown into simple blocks. */
export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r/g, '').replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  const out = []; let para = [], code = null;
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; let m;
    if (/^```/.test(line)) { if (code) { out.push({ t: 'code', lines: code }); code = null; } else { flush(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push({ t: 'h', level: m[1].length, text: m[2] }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push({ t: 'hr' }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush(); const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      i--; out.push({ t: 'table', rows }); continue;
    }
    if ((m = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/))) { flush(); out.push({ t: 'li', level: Math.floor(m[1].length / 2), mark: /x/i.test(m[2]) ? '■' : '□', text: m[3] }); continue; }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { flush(); out.push({ t: 'li', level: Math.floor(m[1].length / 2), mark: '•', text: m[2] }); continue; }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) { flush(); out.push({ t: 'li', level: Math.floor(m[1].length / 2), mark: m[2] + '.', text: m[3] }); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flush(); out.push({ t: 'quote', text: m[1] }); continue; }
    para.push(line.trim());
  }
  flush(); if (code) out.push({ t: 'code', lines: code });
  return out;
}

/**
 * @param {{title:string, markdown:string, fontBytes:ArrayBuffer|Uint8Array, subtitle?:string}} o
 * @returns {Promise<{bytes:Uint8Array, pages:number}>}
 */
export async function buildPdf({ title, markdown, fontBytes, subtitle }) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  // subset:false on purpose: pdf-lib's runtime subsetter drops glyphs of this CJK font. The font file is already cut down (JIS X 0208 + ASCII, ~2 MB).
  const font = await doc.embedFont(fontBytes, { subset: false });
  const has = new Set(font.getCharacterSet());
  const clean = (t) => { let s = ''; for (const ch of stripInline(t).replace(/\t/g, '    ')) { const cp = ch.codePointAt(0); if (cp === 0x20 || has.has(cp)) s += ch; else if (cp === 0xa0 || cp === 0x3000) s += ' '; } return s; };
  const W = (s, size) => font.widthOfTextAtSize(s, size);
  const color = (c) => rgb(c[0], c[1], c[2]);
  doc.setTitle(String(title || '資料').slice(0, 200)); doc.setProducer('E.L.V.A.R.'); doc.setCreator('E.L.V.A.R.');

  let page, y; const pages = [];
  const newPage = () => { page = doc.addPage([PAGE.w, PAGE.h]); pages.push(page); y = PAGE.h - PAGE.top; };
  const need = (h) => { if (y - h < PAGE.bottom) newPage(); };
  const text = (s, x, size, c = C.text, bold = false) => {
    if (!s) return; const o = { x, y, size, font, color: color(c) }; page.drawText(s, o);
    if (bold) page.drawText(s, { ...o, x: x + size * 0.028 });
  };
  const rule = (c = C.rule, w = 0.7) => page.drawLine({ start: { x: PAGE.m, y }, end: { x: PAGE.w - PAGE.m, y }, thickness: w, color: color(c) });

  /** Break `s` into lines no wider than `maxW` (latin words kept whole; CJK per character; kinsoku). */
  const wrap = (s, size, maxW) => {
    const toks = s.match(/[A-Za-z0-9][A-Za-z0-9'’\-_.,:;!?%()/@#&+=~*]*|\s+|[\s\S]/gu) || [];
    const lines = []; let cur = '', cw = 0;
    for (const t of toks) {
      if (/^\s+$/.test(t)) { if (cur) { cur += ' '; cw += W(' ', size); } continue; }
      let tw = W(t, size);
      if (tw > maxW) { // an over-long word: split by character
        for (const ch of t) { const w = W(ch, size); if (cw + w > maxW) { lines.push(cur); cur = ''; cw = 0; } cur += ch; cw += w; }
        continue;
      }
      const overflow = cw + tw > maxW + 0.01;
      if (overflow && cur && !(t.length === 1 && NO_START.has(t) && cw + tw <= maxW + size * 1.1)) {   // hang a closing mark instead of starting a line with it
        const last = cur.trimEnd().slice(-1);
        if (NO_END.has(last)) { cur = cur.trimEnd().slice(0, -1); lines.push(cur.trimEnd()); cur = last; cw = W(cur, size); }
        else { lines.push(cur.trimEnd()); cur = ''; cw = 0; }
      }
      cur += t; cw += tw;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    return lines.length ? lines : [''];
  };
  const para = (s, { x = PAGE.m, size = 10.5, lh = 1.72, c = C.text, bold = false, after = 6, maxW = PAGE.w - PAGE.m - x } = {}) => {
    const lines = wrap(clean(s), size, maxW);
    for (const l of lines) { need(size * lh); y -= size * lh; text(l, x, size, c, bold); }
    y -= after;
  };

  newPage();
  // ---- title block
  for (const l of wrap(clean(title || '資料'), 22, PAGE.w - PAGE.m * 2)) { y -= 22 * 1.45; text(l, PAGE.m, 22, C.accent, true); }
  y -= 4; para(subtitle || '', { size: 9.5, c: C.mute, after: 4 });
  y -= 2; rule(C.accent, 1.4); y -= 10;

  for (const b of parseBlocks(markdown)) {
    if (b.t === 'h') {
      const size = [0, 16, 13.5, 11.5, 10.5][b.level] || 10.5, gap = b.level <= 2 ? 12 : 7;
      y -= gap; need(size * 2.4); para(b.text, { size, c: b.level <= 2 ? C.accent : C.text, bold: true, lh: 1.5, after: 2 });
      if (b.level === 1) { y += 1; rule(C.rule); y -= 5; }
    } else if (b.t === 'p') para(b.text);
    else if (b.t === 'li') {
      const x = PAGE.m + 6 + b.level * 16, lines = wrap(clean(b.text), 10.5, PAGE.w - PAGE.m - (x + 15));
      lines.forEach((l, i) => { need(10.5 * 1.7); y -= 10.5 * 1.7; if (i === 0) text(clean(b.mark) || '•', x, 10.5, C.accent); text(l, x + 15, 10.5); });
      y -= 2.5;
    } else if (b.t === 'quote') {
      const lines = wrap(clean(b.text), 10.5, PAGE.w - PAGE.m * 2 - 14), h = lines.length * 10.5 * 1.7;
      need(Math.min(h, 120)); const top = y;
      for (const l of lines) { need(10.5 * 1.7); y -= 10.5 * 1.7; text(l, PAGE.m + 14, 10.5, C.mute); }
      page.drawLine({ start: { x: PAGE.m + 4, y: y - 3 }, end: { x: PAGE.m + 4, y: Math.min(top, PAGE.h - PAGE.top) }, thickness: 2.2, color: color(C.accent) }); y -= 6;
    } else if (b.t === 'code') {
      for (const raw of b.lines) for (const l of wrap(clean(raw) || ' ', 9, PAGE.w - PAGE.m * 2 - 12)) {
        need(9 * 1.6); y -= 9 * 1.6; page.drawRectangle({ x: PAGE.m, y: y - 3, width: PAGE.w - PAGE.m * 2, height: 9 * 1.6, color: color(C.tint) }); text(l, PAGE.m + 6, 9, C.text);
      }
      y -= 8;
    } else if (b.t === 'hr') { y -= 6; need(10); rule(); y -= 8; }
    else if (b.t === 'table' && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length)), full = PAGE.w - PAGE.m * 2;
      const weight = Array.from({ length: cols }, (_, c) => Math.max(4, Math.min(40, Math.max(...b.rows.map((r) => clean(r[c] || '').length))))), tot = weight.reduce((a, c) => a + c, 0);
      const cw = weight.map((w) => Math.max(40, (w / tot) * full)), scale = full / cw.reduce((a, c) => a + c, 0), widths = cw.map((w) => w * scale);
      y -= 4;
      b.rows.forEach((row, ri) => {
        const cells = widths.map((w, c) => wrap(clean(row[c] || ''), 9.5, w - 10)), h = Math.max(...cells.map((l) => l.length)) * 9.5 * 1.6 + 8;
        need(h); const top = y; let x = PAGE.m;
        if (ri === 0) page.drawRectangle({ x: PAGE.m, y: top - h, width: full, height: h, color: color(C.tint) });
        cells.forEach((lines, c) => { let yy = top - 4; for (const l of lines) { yy -= 9.5 * 1.6; page.drawText(l, { x: x + 5, y: yy + 3, size: 9.5, font, color: color(ri === 0 ? C.accent : C.text) }); if (ri === 0) page.drawText(l, { x: x + 5.25, y: yy + 3, size: 9.5, font, color: color(C.accent) }); } x += widths[c]; });
        page.drawLine({ start: { x: PAGE.m, y: top - h }, end: { x: PAGE.m + full, y: top - h }, thickness: 0.5, color: color(C.rule) });
        y = top - h;
      });
      y -= 8;
    }
  }
  // ---- footer on every page
  const n = pages.length, short = clean(title || '').slice(0, 40);
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${n}`; p.drawLine({ start: { x: PAGE.m, y: 44 }, end: { x: PAGE.w - PAGE.m, y: 44 }, thickness: 0.5, color: color(C.rule) });
    p.drawText(short, { x: PAGE.m, y: 31, size: 8, font, color: color(C.mute) });
    p.drawText(label, { x: PAGE.w - PAGE.m - W(label, 8), y: 31, size: 8, font, color: color(C.mute) });
  });
  return { bytes: await doc.save(), pages: n };
}

export const safeFileName = (title) => (String(title || '資料').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '資料') + '.pdf';
