import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LIMITS, MB, EXTRACT, checkQuota, quotaText, matchFiles, decodeText, cleanQuery } from '../web/src/file-lib.js';
import { tokenize, extractKeywords, leadText, snippetOf, extractDates, extractAmounts, guessKind, buildIndex, kindOf, normTags, nameStem, nameSimilarity, keywordSimilarity, findExactDuplicate, findNearDuplicate, sha256Hex, searchFiles, searchResultForModel, parseDateQuery, fileInRange, chunkText, chunkParts, gatedRead, readApprovalLines, indexNote, deviceSpace, choiceDetail, KINDS, SNIPPET_MAX, READ_CHUNK, kindFromQuery, detectLanguage } from '../web/src/file-index.js';
import { extractFile, openZip, docxText, sheetRows, sharedStringsOf, pptxShapes, imageInfo, unxml } from '../web/src/file-extract.js';
import { analyzeBlob } from '../web/src/file-analyze.js';
import { TOOLS, declarations } from '../server/google/tools.js';
import { buildInstruction } from '../server/persona.js';
import { buildPdf } from '../web/src/pdf-doc.js';

// ------------------------------------------------------------ a tiny zip writer for the Office samples
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files, { stored = false } = {}) {
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), nm = Buffer.from(name), method = stored || name.endsWith('.bin') ? 0 : 8, data = method ? zlib.deflateRawSync(raw) : raw, crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Blob([Buffer.concat([...parts, cd, end])]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const docx = (body, extra = {}) => makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`, 'word/styles.xml': `<w:styles ${W}><w:style w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="2"><w:name w:val="heading 2"/></w:style><w:style w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`, ...extra });

// ------------------------------------------------------------ limits and quota
test('60 MB per file, 600 MB total: one constant, clear messages, real device room honoured', () => {
  assert.equal(LIMITS.perFile, 60 * MB); assert.equal(LIMITS.total, 600 * MB);
  assert.deepEqual(checkQuota({ size: 60 * MB }), { ok: true });
  const big = checkQuota({ name: 'big.pdf', size: 60 * MB + 1 }); assert.equal(big.ok, false); assert.match(big.reason, /big\.pdf.*60 MB.*取り込めません/);
  assert.equal(checkQuota({ size: 58 * MB }).ok, true);
  const full = checkQuota({ name: 'a.pdf', size: 50 * MB, used: 560 * MB }); assert.equal(full.ok, false); assert.match(full.reason, /上限.*600 MB.*残り 40 MB/);
  const dev = checkQuota({ name: 'v.mp4', size: 50 * MB, used: 0, deviceFree: 20 * MB }); assert.equal(dev.ok, false); assert.match(dev.reason, /端末の保存領域.*約 20 MB/);
  assert.equal(checkQuota({ size: 10 * MB, deviceFree: 500 * MB }).ok, true); assert.equal(checkQuota({ size: 10 * MB, deviceFree: null }).ok, true);
  assert.equal(deviceSpace(null), null); assert.equal(deviceSpace({ usage: 1, quota: 0 }), null); assert.deepEqual(deviceSpace({ usage: 30, quota: 100 }), { quota: 100, usage: 30, free: 70 });
  assert.match(quotaText(5 * MB, LIMITS, { free: 2000 * MB }, false), /5\.0 MB \/ 600 MB.*60 MB まで.*空き：約 1[.,]?\d* ?GB|空き：約 2000 MB/);
  assert.match(quotaText(0, LIMITS, null, false), /自動で消す可能性/); assert.ok(!/自動で消す/.test(quotaText(0, LIMITS, null, true)));
  assert.equal(EXTRACT.textChars, 2 * MB); assert.equal(EXTRACT.pdfPages, 300);
});

test('decodeText: a UTF-8 text cut in the middle of a character is still UTF-8', () => {
  const b = new TextEncoder().encode('あ'.repeat(100)); const d = decodeText(b, 100); assert.equal(d.truncated, true); assert.ok(/^あ+$/.test(d.text)); assert.equal(d.text.length, 33);
});

// ------------------------------------------------------------ tokenisation, keywords, snippet
test('tokenize: kanji runs, katakana, latin; hiragana particles and stopwords are dropped', () => {
  const t = tokenize('履修登録の期間は4月です。Reactのコンポーネントを学ぶ。データベース');
  assert.ok(t.has('履修登録') && t.has('react') && t.has('コンポーネント') && t.has('データベース'));
  assert.ok(!t.has('の') && !t.has('です') && !t.has('4'));
  assert.ok(!t.has('修登'), 'a bigram only inside one longer word adds nothing');
  assert.ok(tokenize('履修 履修 履修登録').has('履修'), 'a bigram counted on its own stays');
  assert.equal(tokenize('the and for').size, 0);
});
test('keywords: frequent and heading words first, other documents lower the common ones', () => {
  const text = '光合成の実験を行った。光合成は葉緑体で起こる。葉緑体の数を顕微鏡で数えた。結果として光合成の速度は光の強さに比例した。' + '参考文献'.repeat(1);
  const kw = extractKeywords(text, { title: '光合成の実験レポート', headings: ['実験方法'], n: 6 });
  assert.equal(kw[0], '光合成'); assert.ok(kw.includes('葉緑体'));
  const withDf = extractKeywords('会議 会議 光合成 光合成', { docFreq: { 会議: 9 }, docCount: 10, n: 2 }); assert.equal(withDf[0], '光合成', 'a word every document has weighs less');
  assert.deepEqual(extractKeywords('', {}), []);
});
test('language, snippet / lead sentences, dates, amounts', () => {
  assert.equal(detectLanguage('これは日本語の文章です。今日は天気がよいです。'), 'ja'); assert.equal(detectLanguage('This is a long english sentence for the language test only.'), 'en'); assert.equal(detectLanguage('hi'), 'unknown');
  const s = leadText('1\n\n2026年度 前期 履修登録のご案内\n履修登録は4月1日から始まります。期間内に手続きをしてください。最後の文です。', 40);
  assert.ok(s.startsWith('2026年度') && s.length <= 40 && s.endsWith('…')); assert.ok(!/^1 /.test(s));
  assert.equal(snippetOf('短い', 100), ''); assert.ok(snippetOf('これは十分に長い最初の文章になります。次の文章です。', 100).includes('次の文章'));
  assert.deepEqual(extractDates('提出期限は2026年11月30日、令和8年12月1日に発表。2026/3/5 と 2026-04-07。2027年1月の予定'), ['2026-03-05', '2026-04-07', '2026-11-30', '2026-12-01', '2027-01']);
  assert.deepEqual(extractDates('1月5日までに提出'), [], 'no year: nothing is invented'); assert.deepEqual(extractDates('99999-99-99'), []);
  const a = extractAmounts('ご請求金額 ¥12,800 （税込）。送料 500円。合計 13,300円');
  assert.ok(a.includes('請求金額 ¥12,800') && a.some((x) => /合計 ¥13,300/.test(x))); assert.ok(a.includes('¥500'));
  assert.deepEqual(extractAmounts('3人で2回行った。100%'), [], 'only obvious amounts');
});

// ------------------------------------------------------------ document kind heuristics, realistic Japanese
test('kind heuristics on realistic samples', () => {
  const samples = [
    ['領収書_2026-10.pdf', '領収書\nテスト 太郎 様\n金額 ¥3,300 （税込）\n但し 書籍代として\n上記正に領収いたしました。\n登録番号 T1234567890123', '領収書・請求書'],
    ['invoice.pdf', '請求書\n請求金額 ¥88,000\n振込先 みずほ銀行 普通 1234567\nお支払期限 2026年11月30日', '領収書・請求書'],
    ['秋学期時間割.xlsx', '月曜日 1限 線形代数 2限 プログラミング演習\n火曜日 3限 英語 教室 3-201 単位 2\n履修登録', '履修・時間割'],
    ['業務委託契約書.docx', '業務委託契約書\n甲は乙に対し、次の業務を委託し、乙はこれを受託する。\n第1条（目的） 第2条（期間）\n秘密保持 損害賠償 署名 捺印', '契約書'],
    ['11月シフト.xlsx', 'シフト表\n田中 早番 9:00-17:00\n佐藤 遅番 17:00-22:00 休み希望 11/3\n店長', 'シフト表'],
    ['定例会議メモ.md', '議事録\n日時 2026年11月5日\n参加者 田中、佐藤\n議題 来月の予定\n決定事項 次回会議は12月3日', '議事録'],
    ['生態学レポート.docx', 'はじめに\n本レポートでは光合成の速度を調べた。\n実験方法\n考察\n結論\n参考文献\n図1 結果', 'レポート/論文'],
    ['手紙.docx', '拝啓 秋涼の候、貴社におかれましては益々ご清栄のこととお慶び申し上げます。\n何卒よろしくお願い致します。\n敬具', '手紙'],
    ['発表.pptx', '概要 まとめ 今後の予定', '資料/スライド'],
    ['data.csv', 'a,b\n1,2', '表計算'],
    ['メモ.txt', '今日は晴れ。散歩した。', 'その他'],
  ];
  for (const [name, text, want] of samples) { const ext = name.split('.').pop(); assert.equal(guessKind({ name, text, ext }).kind, want, name); }
  assert.ok(KINDS.includes('その他') && KINDS.length === 10);
  assert.equal(guessKind({ name: '何か.pdf', text: '' }).kind, 'その他');
  assert.equal(kindFromQuery('履修表をプリントして'), '履修・時間割'); assert.equal(kindFromQuery('領収書'), '領収書・請求書'); assert.equal(kindFromQuery('こんにちは'), null);
});

test('buildIndex: keywords, snippet, kind, counts, title; scanned PDF and failures are recorded, not hidden', () => {
  const ex = { text: '領収書\n書籍代 ¥3,300 税込\n2026年11月3日 発行。ご利用ありがとうございました。', title: '', headings: [], pages: 1, status: 'ok' };
  const { index, text } = buildIndex(ex, { name: '領収書.pdf', ext: 'pdf', size: 1234, sha256: 'abc' });
  assert.equal(index.docKind, '領収書・請求書'); assert.equal(kindOf(index), '領収書・請求書'); assert.equal(index.pages, 1); assert.ok(index.snippet.length <= 100 && index.snippet.length > 0);
  assert.deepEqual(index.dates, ['2026-11-03']); assert.ok(index.amounts.some((a) => a.includes('3,300'))); assert.ok(index.keywords.length > 0); assert.equal(index.status, 'ok'); assert.equal(text, ex.text);
  assert.equal(kindOf({ ...index, kind: '契約書' }), '契約書', 'the owner\'s label wins');
  const scan = buildIndex({ text: '  \n', pages: 3, status: 'no_text' }, { name: 'scan.pdf', ext: 'pdf' }).index; assert.equal(scan.status, 'no_text'); assert.equal(scan.keywords.length, 0); assert.equal(scan.snippet, '');
  assert.equal(buildIndex({ text: '', status: 'failed', error: 'x'.repeat(500) }, { name: 'a.docx', ext: 'docx' }).index.error.length, 200);
  assert.equal(buildIndex({ text: '', status: 'unsupported' }, { name: 'a.doc', ext: 'doc' }).index.status, 'unsupported');
  assert.equal(buildIndex({ text: '', status: 'image', width: 10, height: 5 }, { name: 'a.png', ext: 'png' }).index.status, 'image');
  assert.equal(buildIndex({ text: ' ' }, { name: 'a.docx', ext: 'docx' }).index.status, 'empty');
  const capped = buildIndex({ text: 'あ'.repeat(100) }, { name: 'a.txt', ext: 'txt', textCap: 40 }); assert.equal(capped.text.length, 40); assert.equal(capped.index.textTruncated, true);
  assert.deepEqual(normTags(' #提出, 提出、 課題 ,,'), ['提出', '課題']); assert.equal(normTags(['a', 'a']).length, 1);
});

// ------------------------------------------------------------ zip + Office extraction
test('docx: paragraphs, tabs, headings (even with Japanese style ids), title, entities, tables', async () => {
  const body = para('報告書のタイトル', 'Title') + para('はじめに', '1') + '<w:p><w:r><w:t>本文です &amp; 次の行</w:t></w:r><w:r><w:br/></w:r></w:p>' + para('詳細', '2') + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const r = await extractFile(docx(body), { name: 'x.docx' });
  assert.equal(r.status, 'ok'); assert.equal(r.title, '報告書のタイトル'); assert.deepEqual(r.headings, ['はじめに', '詳細']); assert.match(r.text, /本文です & 次の行/); assert.match(r.text, /A\t\nB|A\t/);
  const t = docxText(`<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t></w:r></w:p>`); assert.equal(t.text, 'a\tb');
  assert.equal(unxml('&lt;&#65;&#x42;&amp;&bogus;'), '<AB&&bogus;');
  const core = docx(para('本文だけ'), { 'docProps/core.xml': '<cp:coreProperties><dc:title>メタのタイトル</dc:title></cp:coreProperties>' });
  assert.equal((await extractFile(core, { name: 'm.docx' })).title, 'メタのタイトル');
});
test('docx: broken or encrypted files fail with a recorded reason, never an exception', async () => {
  const bad = await extractFile(new Blob(['not a zip at all, just some bytes here....']), { name: 'bad.docx' });
  assert.equal(bad.status, 'failed'); assert.match(bad.error, /ZIP/);
  const nodoc = await extractFile(makeZip({ 'foo.txt': 'x' }), { name: 'n.docx' }); assert.equal(nodoc.status, 'failed'); assert.match(nodoc.error, /document\.xml/);
  const old = await extractFile(new Blob(['x']), { name: 'old.doc' }); assert.equal(old.status, 'unsupported'); assert.match(old.error, /旧形式/);
  const unknown = await extractFile(new Blob(['x']), { name: 'a.zip' }); assert.equal(unknown.status, 'unsupported');
});
test('xlsx: sheet names, shared strings, numbers, inline strings, row cap', async () => {
  const ss = '<sst><si><t>氏名</t></si><si><t>点数</t></si><si><r><t>田</t></r><r><t>中</t></r><rPh><t>タナカ</t></rPh></si></sst>';
  const rows = (n) => Array.from({ length: n }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}" t="inlineStr"><is><t>行${i}</t></is></c><c r="C${i + 3}"><v>${i}</v></c></row>`).join('');
  const sheet1 = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>85.5</v></c><c r="D2" t="b"><v>1</v></c></row>${rows(600)}</sheetData></worksheet>`;
  const z = makeZip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="成績 &amp; 集計" sheetId="1" r:id="rId1"/><sheet name="空" sheetId="2" r:id="rId2"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>', 'xl/sharedStrings.xml': ss, 'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>' });
  const r = await extractFile(z, { name: 's.xlsx' });
  assert.equal(r.status, 'ok'); assert.deepEqual(r.sheets, ['成績 & 集計', '空']); assert.match(r.text, /【シート：成績 & 集計】\n氏名\t点数\n田中\t85\.5\t\tTRUE\n行0\t\t0/);
  assert.match(r.text, new RegExp(`…（602行のうち先頭の${EXTRACT.xlsxRows}行）`)); assert.ok(r.notes.some((n) => /先頭の500行/.test(n)));
  assert.deepEqual(sharedStringsOf(ss), ['氏名', '点数', '田中']); assert.equal(sheetRows('<row><c r="B1"><v>1</v></c></row>', []).rows[0], '\t1');
});
test('pptx: slide order, titles, body, notes; footers and slide numbers skipped', async () => {
  const slide = (title, body, extra = '') => `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="${title ? 'title' : 'body'}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title || body}</a:t></a:r></a:p></p:txBody></p:sp>${title ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p><a:p><a:r><a:t>二段落目</a:t></a:r></a:p></p:txBody></p:sp>` : ''}<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>9</a:t></a:r></a:p></p:txBody></p:sp>${extra}</p:spTree></p:cSld></p:sld>`;
  const notes = '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>話すこと：結論から</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>';
  const z = makeZip({ 'ppt/slides/slide2.xml': slide('', '最後のスライド'), 'ppt/slides/slide10.xml': slide('十枚目', '本文10'), 'ppt/slides/slide1.xml': slide('研究発表', '背景と目的'), 'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Target="../notesSlides/notesSlide1.xml"/></Relationships>', 'ppt/notesSlides/notesSlide1.xml': notes });
  const r = await extractFile(z, { name: 'p.pptx' });
  assert.equal(r.status, 'ok'); assert.equal(r.slides, 3); assert.equal(r.title, '研究発表'); assert.deepEqual(r.headings, ['研究発表', '十枚目']);
  assert.ok(r.text.indexOf('スライド 1') < r.text.indexOf('スライド 2') && r.text.indexOf('スライド 2') < r.text.indexOf('スライド 3'), 'numeric order, not 1,10,2');
  assert.match(r.text, /背景と目的\n二段落目/); assert.match(r.text, /\[ノート\] 話すこと：結論から/); assert.ok(!/\n9\n/.test(r.text)); assert.equal(pptxShapes('<p:sp><p:ph type="ftr"/><a:p><a:t>x</a:t></a:p></p:sp>').length, 0);
});
test('zip: deflate and stored entries, entry size cap (zip-bomb guard), directory only is read', async () => {
  const z = makeZip({ 'a.txt': 'hello', 'b.bin': 'stored-data', 'big.txt': 'x'.repeat(200000) });
  const zip = await openZip(z); assert.deepEqual(zip.names().sort(), ['a.txt', 'b.bin', 'big.txt']);
  assert.equal((await zip.text('a.txt')).text, 'hello'); assert.equal((await zip.text('b.bin')).text, 'stored-data');
  const capped = await zip.read('big.txt', 1000); assert.equal(capped.bytes.length, 1000); assert.equal(capped.truncated, true);
  assert.equal(await zip.read('nope'), null);
});
test('text / csv / json: UTF-8 and Shift_JIS, the 2 MB read cap says it truncated', async () => {
  const sjis = Blob.prototype ? new Blob([Uint8Array.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x2c, 0x31])]) : null;
  const r = await extractFile(sjis, { name: 'a.csv' }); assert.equal(r.text, 'テスト,1'); assert.equal(r.status, 'ok');
  const big = await extractFile(new Blob(['あいう\n'.repeat(400000)]), { name: 'big.txt' }); assert.equal(big.textTruncated, true); assert.ok(big.text.length <= EXTRACT.textChars); assert.ok(big.notes[0].includes('先頭'));
  assert.equal((await extractFile(new Blob(['{"a":1}']), { name: 'a.json' })).text, '{"a":1}');
});
test('images: size and EXIF date from the first bytes; honest note that OCR is not available', async () => {
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageInfo(png), { width: 640, height: 480, exifDate: '' });
  // JPEG with an EXIF DateTimeOriginal
  const date = Buffer.from('2026:10:03 12:34:56\0'); const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + date.length); tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26); tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(date.length, 32); tiff.writeUInt32LE(44, 36); tiff.writeUInt32LE(0, 40); date.copy(tiff, 44);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0'), tiff]); const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(app1.length + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0x03, 0x20, 0x04, 0xb0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg, app1, sof]);
  assert.deepEqual(imageInfo(jpg), { width: 1200, height: 800, exifDate: '2026-10-03' });
  const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1'); assert.deepEqual(imageInfo(gif), { width: 16, height: 32, exifDate: '' });
  assert.equal(imageInfo(Buffer.from('plain text')), null);
  const r = await extractFile(new Blob([jpg]), { name: 'photo.jpg' }); assert.equal(r.status, 'image'); assert.equal(r.width, 1200); assert.equal(r.exifDate, '2026-10-03'); assert.match(r.notes[0], /OCR/);
  const ix = buildIndex(r, { name: 'photo.jpg', ext: 'jpg' }).index; assert.equal(ix.status, 'image'); assert.equal(ix.width, 1200); assert.equal(ix.exifDate, '2026-10-03');
});

// ------------------------------------------------------------ PDF
async function pdfjsNode() { const lib = await import('pdfjs-dist/legacy/build/pdf.mjs'); const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs'); globalThis.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler }; return lib; }
const CMAPS = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).pathname;
test('pdf: text layer, page count, title metadata; a PDF without text is reported as a scan', async () => {
  const font = fs.readFileSync(new URL('../web/public/fonts/NotoSansJP-Regular.ttf', import.meta.url));
  const { bytes, pages } = await buildPdf({ title: '履修登録のご案内', markdown: '# 履修登録\n履修登録の期間は4月1日から10日までです。\n\n領収金額 ¥3,300', fontBytes: font, subtitle: '2026-11-06' });
  const r = await extractFile(new Blob([bytes]), { name: 'a.pdf', loadPdfjs: pdfjsNode, cMapUrl: CMAPS });
  assert.equal(r.status, 'ok', r.error); assert.equal(r.pages, pages); assert.match(r.text, /履修登録の期間は4月1日から10日まで/);
  const ix = buildIndex(r, { name: 'a.pdf', ext: 'pdf' }).index; assert.equal(ix.docKind, '履修・時間割'); assert.ok(ix.keywords.includes('履修登録')); assert.ok(ix.amounts.some((a) => a.includes('3,300')));
  // a page with no text at all (what a scan looks like)
  const { PDFDocument } = await import('pdf-lib'); const d = await PDFDocument.create(); d.addPage([200, 200]); d.addPage([200, 200]); d.setTitle('スキャン文書');
  const scan = await extractFile(new Blob([await d.save()]), { name: 'scan.pdf', loadPdfjs: pdfjsNode, cMapUrl: CMAPS });
  assert.equal(scan.status, 'no_text'); assert.equal(scan.pages, 2); assert.equal(scan.title, 'スキャン文書');
  const sx = buildIndex(scan, { name: 'scan.pdf', ext: 'pdf' }).index; assert.equal(sx.status, 'no_text'); assert.equal(sx.snippet, ''); assert.deepEqual(sx.keywords, []);
  const broken = await extractFile(new Blob([Buffer.from('%PDF-1.4 garbage')]), { name: 'b.pdf', loadPdfjs: pdfjsNode, cMapUrl: CMAPS }); assert.equal(broken.status, 'failed'); assert.ok(broken.error);
  const noLib = await extractFile(new Blob([bytes]), { name: 'a.pdf' }); assert.equal(noLib.status, 'failed');
});
test('analyzeBlob: hash + extraction + index in one pass, progress is reported, cancel stops it', async () => {
  const stages = []; const blob = docx(para('議事録') + para('議題：予算 参加者：田中'));
  const r = await analyzeBlob(blob, { name: '定例.docx', onProgress: (p) => stages.push(p.stage) });
  assert.match(r.sha256, /^[0-9a-f]{64}$/); assert.equal(r.index.docKind, '議事録'); assert.equal(r.index.sha256, r.sha256); assert.ok(stages.includes('読み込み中') && stages.includes('記憶を作成中'));
  const again = await analyzeBlob(docx(para('議事録') + para('議題：予算 参加者：田中')), { name: '別名.docx' }); assert.equal(again.sha256, r.sha256, 'same bytes = same hash, whatever the name');
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(() => analyzeBlob(blob, { name: 'x.docx', signal: ctrl.signal }), (e) => e.cancelled === true);
});

// ------------------------------------------------------------ telling files apart
test('hash and exact duplicates', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const files = [{ id: 1, name: 'a.pdf' }, { id: 2, name: 'b.pdf' }], idx = new Map([[1, { sha256: 'h1' }], [2, { sha256: 'h2' }]]);
  assert.deepEqual(findExactDuplicate('h2', files, idx), { id: 2, name: 'b.pdf' }); assert.equal(findExactDuplicate('h3', files, idx), null); assert.equal(findExactDuplicate('', files, idx), null);
  assert.deepEqual(findExactDuplicate('h1', files, { 1: { sha256: 'h1' } }), { id: 1, name: 'a.pdf' });
});
test('near duplicates / new versions: flagged by name + keywords, never for different documents, never the same bytes', () => {
  assert.equal(nameStem('レポート_最終版(2).docx'), nameStem('レポート_v3.docx')); assert.equal(nameStem('レポート_最終版(2).docx'), 'れぽーと');
  assert.ok(nameSimilarity('生態学レポート2026.docx', '生態学レポート_最終.docx') > 0.9); assert.ok(nameSimilarity('請求書.pdf', '履修表.xlsx') < 0.3);
  const kwA = ['光合成', '葉緑体', '実験', '速度', '顕微鏡', '考察', '結果', '比例'], kwB = ['光合成', '葉緑体', '実験', '速度', '顕微鏡', '考察', '結論', '強さ'];
  assert.ok(keywordSimilarity(kwA, kwB) > 0.5); assert.equal(keywordSimilarity([], kwB), 0);
  const files = [{ id: 1, name: '生態学レポート.docx' }, { id: 2, name: '請求書.pdf' }], idx = new Map([[1, { sha256: 'old', keywords: kwA }], [2, { sha256: 'x', keywords: ['請求', '金額'] }]]);
  const near = findNearDuplicate({ name: '生態学レポート_修正版.docx', keywords: kwB, sha256: 'new' }, files, idx); assert.equal(near.id, 1); assert.ok(near.score > 0.5);
  assert.equal(findNearDuplicate({ name: '全然別の話.docx', keywords: ['天気', '散歩', '夕食', '映画', '音楽', '旅行'], sha256: 'n' }, files, idx), null);
  assert.equal(findNearDuplicate({ name: '生態学レポート_修正版.docx', keywords: kwB, sha256: 'old' }, files, idx), null, 'identical bytes are an exact duplicate, not a "version"');
  assert.equal(findNearDuplicate({ name: '同じ名前.docx', keywords: ['a1', 'b1'], sha256: 'q' }, [{ id: 3, name: '同じ名前.docx' }], new Map([[3, { sha256: 'z', keywords: ['c3', 'd3'] }]])), null, 'a similar name alone is not enough');
});

// ------------------------------------------------------------ search and matching
const NOW = Date.UTC(2026, 10, 6, 3, 0);   // 2026-11-06 12:00 JST
const lib = () => {
  const mk = (id, name, addedAt, ex) => ({ f: { id, name, addedAt, size: 100, type: 'x' }, i: buildIndex(ex, { name, ext: name.split('.').pop() }) });
  const items = [
    mk(1, '履修表_2026前期.xlsx', Date.UTC(2026, 3, 2), { text: '月曜日 1限 線形代数 単位 2\n火曜日 2限 プログラミング演習 履修登録 時間割', sheets: ['前期'] }),
    mk(2, 'scan0007.pdf', Date.UTC(2026, 9, 20), { text: '領収書\n書籍代 ¥3,300 税込 2026年10月18日 上記正に領収しました', pages: 1 }),
    mk(3, '電気代.pdf', Date.UTC(2026, 10, 2), { text: '請求書\nご請求金額 ¥6,420 お支払期限 2026年11月30日 振込先', pages: 1 }),
    mk(4, '生態学の課題.docx', Date.UTC(2026, 9, 12), { text: 'はじめに\n光合成の速度を調べるレポートです。実験方法 考察 結論 参考文献', title: '光合成と光の強さ' }),
    mk(5, '会議.md', Date.UTC(2026, 10, 1), { text: '議事録\n議題 来月の計画\n参加者 田中\n決定事項 12月に発表' }),
    mk(6, 'cover.pdf', Date.UTC(2026, 10, 3), { text: '', status: 'no_text', pages: 4 }),
  ];
  return { files: items.map((x) => x.f), indexes: new Map(items.map((x) => [x.f.id, { ...x.i.index, tags: x.f.id === 4 ? ['光合成ゼミ'] : [] }])), texts: new Map(items.map((x) => [x.f.id, x.i.text])) };
};
test('search ranks by name, tags, kind, keywords and body; local only', () => {
  const L = lib(), s = (q) => searchFiles(L, q, { now: NOW }).map((r) => r.file.id);
  assert.equal(s('履修表')[0], 1); assert.equal(s('領収書')[0], 2, 'found by content although the name is scan0007.pdf'); assert.equal(s('電気代')[0], 3);
  assert.equal(s('光合成ゼミ')[0], 4, 'tag'); assert.ok(s('光合成の速度').includes(4)); assert.equal(s('決定事項 来月の計画')[0], 5);
  assert.deepEqual(s('まったく無関係なたんご'), []); assert.deepEqual(s(''), []);
  const r = searchFiles(L, '領収書', { now: NOW })[0]; assert.equal(r.kind, '領収書・請求書'); assert.ok(r.where.length > 0);
  assert.equal(searchFiles(L, '請求', { now: NOW })[0].file.id, 3, 'kind alias 請求 -> 請求書');
});
test('search results for the model: names, kinds and short snippets only (they are sent to the AI)', () => {
  const L = lib(); L.indexes.get(2).snippet = 'あ'.repeat(400);
  const out = searchResultForModel(searchFiles(L, '領収書', { now: NOW }));
  assert.ok(out.length); for (const o of out) { assert.deepEqual(Object.keys(o).sort(), ['kind', 'matched', 'name', 'score', 'snippet']); assert.ok(o.snippet.length <= SNIPPET_MAX); }
  assert.ok(!JSON.stringify(out).includes(L.texts.get(2).slice(0, 30)) || SNIPPET_MAX >= 30, 'the full text is not in the list');
  assert.ok(JSON.stringify(out).length < 1000);
});
test('date words: 先月 / 今月 / 昨日 / N月 with JST boundaries', () => {
  const sep = parseDateQuery('先月のレポート', NOW); assert.equal(sep.range.label, '先月'); assert.equal(sep.rest, 'レポート');
  assert.equal(sep.range.from, Date.UTC(2026, 9, 1) - 9 * 3600e3); assert.equal(sep.range.to, Date.UTC(2026, 10, 1) - 9 * 3600e3);
  assert.equal(parseDateQuery('今月の請求書', NOW).range.from, Date.UTC(2026, 10, 1) - 9 * 3600e3); assert.equal(parseDateQuery('昨日の', NOW).range.label, '昨日');
  assert.equal(parseDateQuery('10月の議事録', NOW).range.from, Date.UTC(2026, 9, 1) - 9 * 3600e3); assert.equal(parseDateQuery('12月の予定', NOW).range.from, Date.UTC(2025, 11, 1) - 9 * 3600e3, 'a later month than now = last year');
  assert.equal(parseDateQuery('レポート', NOW).range, null); assert.equal(parseDateQuery('2026年10月18日の領収書', NOW).range, null, 'a full date is not a relative word');
  assert.equal(fileInRange({ addedAt: Date.UTC(2026, 9, 15) }, null, sep.range), true); assert.equal(fileInRange({ addedAt: Date.UTC(2026, 10, 3) }, { dates: [] }, sep.range), false);
  assert.equal(fileInRange({ addedAt: Date.UTC(2026, 10, 3) }, { dates: ['2026-10-18'] }, sep.range), true, 'a date written inside the file counts');
});
test('print matching by content: 「履修表をプリントして」「領収書を印刷」「先月のレポート」, ambiguity still asks', () => {
  const L = lib(), m = (q) => matchFiles(L.files, q, { indexes: L.indexes, texts: L.texts, now: NOW });
  assert.equal(m('履修表をプリントして').file.id, 1);
  assert.equal(m('領収書を印刷して').file.id, 2, 'receipt found by content, name is scan0007.pdf');
  assert.equal(m('先月のレポート').file.id, 4, '10月に取り込んだ課題レポート');
  assert.equal(m('今月のレポート').kind, 'none', 'nothing from this month is a report: nothing is guessed');
  assert.equal(m('電気代').file.id, 3); assert.equal(m('全然関係ない話').kind, 'none');
  const two = [...L.files, { id: 7, name: 'scan0008.pdf', addedAt: Date.UTC(2026, 10, 4), size: 1, type: 'x' }]; const idx = new Map(L.indexes); idx.set(7, buildIndex({ text: '領収書\nコピー用紙 ¥1,200 領収しました' }, { name: 'scan0008.pdf', ext: 'pdf' }).index);
  const many = matchFiles(two, '領収書を印刷', { indexes: idx, now: NOW }); assert.equal(many.kind, 'many', 'two receipts: ask which'); assert.ok([2, 7].every((id) => many.items.some((x) => x.file.id === id)));
  const detail = choiceDetail(many.items, idx); assert.match(detail, /scan000[78]\.pdf：領収書・請求書「/); assert.ok(detail.length <= 300);
  assert.equal(matchFiles(L.files, '時間割', { now: NOW }).kind, 'none', 'without an index only names count (old behaviour)'); assert.equal(m('時間割').file.id, 1, 'with the index the content finds it');
  assert.equal(cleanQuery('scan0007.pdf (11/6)'), 'scan0007.pdf');
});

// ------------------------------------------------------------ reading to the model: chunks and the approval gate
test('chunking: ~6000 characters per part, cut at line breaks, parts cover the text exactly', () => {
  const text = Array.from({ length: 1500 }, (_, i) => `行${i}：内容内容内容`).join('\n'); const c1 = chunkText(text, 1);
  assert.ok(c1.text.length <= READ_CHUNK && c1.text.length > READ_CHUNK * 0.7); assert.ok(c1.text.endsWith('\n')); assert.equal(c1.hasNext, true);
  const all = Array.from({ length: c1.parts }, (_, i) => chunkText(text, i + 1).text).join(''); assert.equal(all, text);
  assert.equal(chunkText(text, 9999).part, c1.parts, 'past the end = the last part'); assert.equal(chunkText(text, 0).part, 1); assert.equal(chunkText('', 1).text, ''); assert.deepEqual(chunkParts(''), []);
  assert.equal(chunkText('短い', 1).hasNext, false); assert.equal(chunkText('x'.repeat(13000), 1).parts, 3);
});
test('file_read gate: nothing is loaded or returned before approval; a "no" returns no content; the grant is remembered per file', async () => {
  const file = { id: 'f1', name: '請求書.pdf' }, ix = { status: 'ok', chars: 20, kind: '', docKind: '領収書・請求書', textTruncated: false };
  let loads = 0, asked = []; const load = async () => { loads++; return '合計 ¥12,800'; }, granted = new Set();
  const no = await gatedRead({ file, ix, granted, ask: async (lines) => { asked.push(lines); return false; }, load });
  assert.equal(no.status, 'declined'); assert.equal(loads, 0, 'the text was not even read'); assert.equal(no.text, undefined); assert.ok(!JSON.stringify(no).includes('12,800')); assert.equal(granted.size, 0);
  assert.match(asked[0][0], /請求書\.pdf/); assert.ok(asked[0].some((l) => l.includes('この内容をAIに読ませます')));
  const undef = await gatedRead({ file, ix, granted, ask: async () => undefined, load }); assert.equal(undef.status, 'declined', 'only exactly true approves'); assert.equal(loads, 0);
  const yes = await gatedRead({ file, ix, granted, ask: async (l) => { asked.push(l); return true; }, load });
  assert.equal(yes.status, 'ok'); assert.equal(yes.text, '合計 ¥12,800'); assert.equal(loads, 1); assert.match(yes.rule, /分かりません/); assert.match(yes.next, /最後/);
  let again = 0; const second = await gatedRead({ file, ix, granted, ask: async () => { again++; return false; }, load }); assert.equal(again, 0, 'granted for the session: not asked again'); assert.equal(second.status, 'ok');
  const other = await gatedRead({ file: { id: 'f2', name: '別.pdf' }, ix, granted, ask: async () => { again++; return false; }, load }); assert.equal(again, 1, 'another file asks again'); assert.equal(other.status, 'declined');
});
test('file_read is honest: scans, failures, truncation, next part', async () => {
  const f = { id: 'a', name: 'x.pdf' }, g = () => new Set(), yes = async () => true;
  const scan = await gatedRead({ file: f, ix: { status: 'no_text' }, granted: g(), ask: yes, load: async () => assert.fail('no text to load') }); assert.equal(scan.status, 'no_text'); assert.match(scan.note, /スキャン画像/); assert.equal(scan.text, undefined);
  const failed = await gatedRead({ file: f, ix: { status: 'failed', error: '壊れています' }, granted: g(), ask: yes, load: async () => '' }); assert.equal(failed.status, 'failed'); assert.match(failed.note, /壊れています.*推測しないで/);
  const img = await gatedRead({ file: f, ix: { status: 'image' }, granted: g(), ask: yes, load: async () => '' }); assert.equal(img.status, 'no_text'); assert.match(img.note, /画像/);
  const long = 'あ'.repeat(14000) + '\n'; const p1 = await gatedRead({ file: f, ix: { status: 'ok', textTruncated: true, chars: 14001 }, granted: g(), ask: yes, load: async () => long });
  assert.equal(p1.parts, 3); assert.match(p1.next, /part=2/); assert.match(p1.truncated, /先頭の14,001字までしか/); assert.ok(p1.text.length <= READ_CHUNK);
  const p3 = await gatedRead({ file: f, ix: { status: 'ok' }, part: 3, granted: g(), ask: yes, load: async () => long }); assert.equal(p3.part, 3); assert.match(p3.next, /最後/);
  assert.equal(readApprovalLines({ name: 'n.pdf' }, {}).length, 4);
});

// ------------------------------------------------------------ the second-brain note
test('second-brain note: summary + metadata, NOT the full text (text files within the cap are the exception)', () => {
  const { index } = buildIndex({ text: '領収書\n書籍代 ¥3,300 2026年10月18日 上記正に領収しました。'.repeat(30), pages: 2 }, { name: '領収書.pdf', ext: 'pdf', sha256: 'h' });
  index.tags = ['経費']; index.memo = '確定申告用';
  const n = indexNote({ name: '領収書.pdf' }, index, { text: 'FULLTEXT-SHOULD-NOT-APPEAR', now: Date.UTC(2026, 10, 6) });
  assert.equal(n.path, 'ファイル/領収書.md'); assert.match(n.content, /種類：領収書・請求書/); assert.match(n.content, /タグ：#経費/); assert.match(n.content, /## メモ\n確定申告用/); assert.match(n.content, /## 要約/); assert.match(n.content, /ページ：2/); assert.match(n.content, /保存日：2026-11-06/);
  assert.ok(!n.content.includes('FULLTEXT-SHOULD-NOT-APPEAR')); assert.equal(n.withText, false); assert.equal(n.tooLong, false);
  const t = buildIndex({ text: '# メモ\n買うもの', status: 'ok' }, { name: 'メモ.md', ext: 'md' }).index; const nt = indexNote({ name: 'メモ.md' }, t, { text: '# メモ\n買うもの' }); assert.equal(nt.withText, true); assert.match(nt.content, /## 本文\n# メモ/);
  const bigT = indexNote({ name: 'a.txt' }, { ...t, ext: 'txt' }, { text: 'x'.repeat(13000) }); assert.equal(bigT.withText, false);
  const ai = indexNote({ name: 'a.pdf' }, { ...index, summaryAI: 'AIの要約です' }); assert.match(ai.content, /AIの要約です\n\n（AIによる要約）/);
  const scan = indexNote({ name: 's.pdf' }, buildIndex({ text: '', status: 'no_text' }, { name: 's.pdf', ext: 'pdf' }).index); assert.match(scan.content, /スキャン画像/);
  assert.ok(!indexNote({ name: '../../a#b.pdf' }, index).path.includes('..'));
});

// ------------------------------------------------------------ tools and persona
test('new tools: declared like the other file tools; file_read says it sends content to the AI; file_search says only names/kinds/snippets', () => {
  for (const n of ['file_search', 'file_read', 'file_tag']) { const t = TOOLS.find((x) => x.name === n); assert.ok(t, n); assert.equal(t.kind, 'read'); assert.equal(t.alwaysOn, true); assert.ok(declarations({ alwaysOnly: true }).some((d) => d.name === n)); }
  assert.deepEqual(TOOLS.find((x) => x.name === 'file_search').schema.required, ['query']);
  assert.deepEqual(Object.keys(TOOLS.find((x) => x.name === 'file_read').schema.properties).sort(), ['name', 'part']);
  assert.deepEqual(Object.keys(TOOLS.find((x) => x.name === 'file_tag').schema.properties).sort(), ['kind', 'memo', 'name', 'tags']);
  assert.match(TOOLS.find((x) => x.name === 'file_read').description, /AIに読ませ.*承認/); assert.match(TOOLS.find((x) => x.name === 'file_search').description, /名前・種類・短い抜粋/);
  assert.equal(TOOLS.filter((t) => t.alwaysOn).length, 12);
  assert.ok(TOOLS.find((x) => x.name === 'file_tag').schema.properties.kind.description.includes('履修'));
});
test('persona teaches search / read / tag with the approval and honesty rules', () => {
  for (const google of [false, true]) {
    const p = buildInstruction({ google });
    for (const k of ['file_search', 'file_read', 'file_tag']) assert.ok(p.includes(k), k);
    assert.match(p, /この内容をAIに読ませ/); assert.match(p, /分かりません/); assert.match(p, /スキャン画像/); assert.match(p, /60 ?MB/);
  }
});

// ------------------------------------------------------------ the AI routes (only reached after an approval card in the page)
test('server: file_summarize / file_ocr validate input and send only what they are given', async () => {
  const { handleChat } = await import('../server/chat-api.js');
  assert.equal((await handleChat({ method: 'POST', body: { action: 'file_summarize', name: 'a', text: '短い' } })).status, 400);
  assert.equal((await handleChat({ method: 'POST', body: { action: 'file_summarize', name: 'a', text: 'あ'.repeat(13000) } })).status, 400);
  assert.equal((await handleChat({ method: 'POST', body: { action: 'file_ocr', image: 'not base64 !!', mime: 'image/jpeg' } })).status, 400);
  assert.equal((await handleChat({ method: 'POST', body: { action: 'file_ocr', image: 'A'.repeat(200), mime: 'image/svg+xml' } })).status, 400, 'only raster images');
  assert.equal((await handleChat({ method: 'POST', body: { action: 'file_ocr', image: 'A'.repeat(3_600_000), mime: 'image/png' } })).status, 400, 'size cap');
  // with a stubbed Gemini: the request carries the image + the fixed prompt only
  const saved = { fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY }; let sent = null;
  process.env.GEMINI_API_KEY = 'test';
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '請求書 合計 1,000円' }] } }] }), { status: 200 }); };
  try {
    const r = await handleChat({ method: 'POST', body: { action: 'file_ocr', image: 'A'.repeat(400), mime: 'image/png' } });
    assert.equal(r.status, 200); assert.equal(r.body.text, '請求書 合計 1,000円');
    const parts = sent.contents[0].parts; assert.equal(parts.length, 2); assert.equal(parts[0].inlineData.mimeType, 'image/png'); assert.match(parts[1].text, /推測で補わない/);
    assert.ok(!sent.tools && !sent.systemInstruction, 'no tools, no persona: a plain transcription');
  } finally { globalThis.fetch = saved.fetch; if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key; }
});

test('a UTF-8 Japanese text cut in the middle of a character (the extraction reads only the first 2 MB) is still UTF-8, not Shift_JIS mojibake', () => {
  const full = new TextEncoder().encode('日本語のテキスト'.repeat(1000)), headBytes = full.subarray(0, 3 * 1000 + 1);   // ends one byte into a 3-byte character
  assert.match(decodeText(headBytes, headBytes.length, { cut: true }).text, /^日本語のテキスト/); assert.equal(decodeText(headBytes, headBytes.length, { cut: true }).truncated, true);
  assert.ok(!decodeText(headBytes, headBytes.length, { cut: true }).text.includes('\ufffd'));
  assert.equal(decodeText(headBytes, headBytes.length).text.startsWith('日本語'), false, 'without the hint the old behaviour: a cut byte makes it look like Shift_JIS');
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]); assert.equal(decodeText(sjis, sjis.length, { cut: true }).text, '日本語', 'real Shift_JIS is still recognised');
});
