import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, MB, classify, safeName, fmtSize, checkQuota, normalizeName, cleanQuery, nameScore, matchFiles, choiceLabels, parseCopies, clampCopies, printMode, approvalLines, addLog, formatLogEntry, textPrintHtml, imagePrintHtml, decodeText, countPdfPagesRough, brainNote, TROUBLESHOOT, PRINTER_NOTE, escHtml } from '../web/src/file-lib.js';
import { TOOLS, declarations } from '../server/google/tools.js';
import { buildInstruction } from '../server/persona.js';

test('classify: extension decides, office is stored but not previewable/printable, unknown is refused', () => {
  assert.deepEqual(['pdf', 'image', 'text', 'text', 'text', 'office', 'office', 'office'], ['a.PDF', 'b.png', 'c.md', 'd.csv', 'e.json', 'f.docx', 'g.xlsx', 'h.pptx'].map((n) => classify(n).kind));
  assert.equal(classify('x.jpeg').mime, 'image/jpeg');
  assert.equal(classify('メモ.txt').label, 'テキスト');
  assert.equal(classify('report.docx').previewable, false); assert.equal(classify('report.docx').printable, false);
  assert.equal(classify('a.csv').brainable, true); assert.equal(classify('a.pdf').brainable, false);
  assert.equal(classify('noext', 'application/pdf').kind, 'pdf'); assert.equal(classify('noext', 'text/plain; charset=utf-8').kind, 'text');
  assert.equal(classify('page.html', 'text/html').ok, false, 'a text/* type does not make an html file importable');
  for (const bad of ['a.exe', 'a.svg', 'a.html', 'a.js', 'archive.zip']) { const c = classify(bad); assert.equal(c.ok, false, bad); assert.match(c.reason, /取り込めません/); }
});

test('safeName: no path, no control/reserved characters, bounded, extension kept', () => {
  assert.equal(safeName('C:\\Users\\a\\請求書.pdf'), '請求書.pdf');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a<b>:"c|d?*.txt'), 'a_b___c_d__.txt');
  assert.equal(safeName('  \u0000\u202ehidden\u0007.md  '), 'hidden.md');
  assert.equal(safeName('.hidden'), 'hidden'); assert.equal(safeName(''), 'ファイル'); assert.equal(safeName(null), 'ファイル');
  const long = safeName('あ'.repeat(300) + '.pdf'); assert.equal(long.length, 100); assert.ok(long.endsWith('.pdf'));
});

test('size and quota math: 60 MB per file, 600 MB total, clear messages', () => {
  assert.equal(fmtSize(0), '0 B'); assert.equal(fmtSize(1536), '1.5 KB'); assert.equal(fmtSize(5 * MB), '5.0 MB'); assert.equal(fmtSize(30 * MB), '30 MB');
  assert.equal(LIMITS.perFile, 60 * MB); assert.equal(LIMITS.total, 600 * MB);
  assert.deepEqual(checkQuota({ size: 60 * MB, used: 0 }), { ok: true });
  const big = checkQuota({ name: 'big.pdf', size: 60 * MB + 1, used: 0 }); assert.equal(big.ok, false); assert.match(big.reason, /big\.pdf.*60 MB/);
  const full = checkQuota({ name: 'a.pdf', size: 20 * MB, used: 590 * MB }); assert.equal(full.ok, false); assert.match(full.reason, /上限.*600 MB.*残り 10 MB/);
  assert.equal(checkQuota({ size: 10 * MB, used: 590 * MB }).ok, true, 'exactly full is allowed');
  assert.equal(checkQuota({ size: 0, used: 0 }).ok, false);
});

test('name matching: normalisation, fuzzy score, one / many / none, last document', () => {
  assert.equal(normalizeName('Ｒｅｐｏｒｔ　2026.PDF'), 'report2026');
  assert.equal(normalizeName('セイキュウショ.pdf'), normalizeName('せいきゅうしょ.pdf'));
  assert.equal(cleanQuery('請求書をプリントして'), '請求書'); assert.equal(cleanQuery('議事録を印刷して'), '議事録'); assert.equal(cleanQuery('履歴書ファイル'), '履歴書');
  const files = [{ id: 1, name: '請求書_2026-10.pdf', addedAt: 3 }, { id: 2, name: '議事録.md', addedAt: 2 }, { id: 3, name: '履歴書.docx', addedAt: 1 }];
  assert.equal(matchFiles(files, '議事録をプリントして').file.id, 2);
  assert.equal(matchFiles(files, 'ぎじろく').kind, 'none', 'hiragana vs kanji is not guessed');
  assert.equal(matchFiles(files, '請求書 2026').file?.id, 1);
  assert.equal(matchFiles(files, '').kind, 'none'); assert.equal(matchFiles([], '請求書').kind, 'none'); assert.equal(matchFiles(files, '全然ちがう名前').kind, 'none');
  const two = [{ id: 1, name: '議事録_1月.md', addedAt: 1 }, { id: 2, name: '議事録_2月.md', addedAt: 2 }];
  const m = matchFiles(two, '議事録'); assert.equal(m.kind, 'many'); assert.equal(m.items.length, 2);
  assert.equal(matchFiles(two, '議事録 2月').file?.id, 2);
  const same = [{ id: 1, name: 'a.pdf', addedAt: Date.UTC(2026, 9, 1) }, { id: 2, name: 'a.pdf', addedAt: Date.UTC(2026, 9, 5) }];
  assert.equal(matchFiles(same, 'a.pdf').kind, 'many'); const labels = choiceLabels(matchFiles(same, 'a.pdf').items); assert.equal(new Set(labels).size, 2); assert.ok(labels.every((l) => l.length <= 24));
  const withLast = [...files, { id: 'lastdoc', name: '週報.pdf', addedAt: 9 }];
  assert.equal(matchFiles(withLast, 'さっきの資料', { lastDocId: 'lastdoc' }).file.id, 'lastdoc');
  assert.equal(matchFiles(files, 'さっきの資料', { lastDocId: null }).kind, 'none', 'no last document: nothing is guessed');
  assert.ok(nameScore('請求書', '請求書_2026-10.pdf') > 0.6);
});

test('copies: 「2部」 and friends, clamped, default 1', () => {
  assert.equal(parseCopies('2部'), 2); assert.equal(parseCopies('請求書を3部プリントして'), 3); assert.equal(parseCopies('二部'), 2); assert.equal(parseCopies('十部'), 10); assert.equal(parseCopies('十二部'), 12);
  assert.equal(parseCopies('２枚'), 2); assert.equal(parseCopies('請求書を印刷して'), 1); assert.equal(parseCopies('999部'), LIMITS.maxCopies); assert.equal(parseCopies('0部'), 1); assert.equal(parseCopies(''), 1); assert.equal(parseCopies(undefined, 4), 4);
  assert.equal(clampCopies('abc'), 1); assert.equal(clampCopies(2.9), 2); assert.equal(clampCopies(-3), 1);
});

test('print job: mode per kind, approval text says what will happen and is honest about the printer', () => {
  assert.deepEqual(['a.pdf', 'a.png', 'a.txt', 'a.docx', 'a.zip'].map((n) => printMode({ name: n })), ['pdf', 'image', 'text', 'download', 'none']);
  const f = { name: '請求書.pdf', type: 'application/pdf', size: 1536 * 1024 };
  const t = approvalLines(f, { copies: 1, pages: 3 }).join('\n');
  assert.match(t, /「請求書\.pdf」を印刷します/); assert.match(t, /PDF/); assert.match(t, /1\.5 MB/); assert.match(t, /3 ページ/); assert.match(t, /部数：1 部/);
  assert.ok(t.includes(PRINTER_NOTE)); assert.match(t, /印刷ダイアログで、接続されているプリンターを選びます/); assert.match(t, /承認するまでは、何も印刷しません/);
  assert.match(approvalLines(f, { pages: null }).join('\n'), /ページ数：不明/);
  assert.match(approvalLines(f, { copies: 2, pages: 3 }).join('\n'), /部数：2 部/);
  const off = approvalLines({ name: '履歴書.docx', size: 20000 }, {}).join('\n');
  assert.match(off, /ブラウザでは印刷できません/); assert.ok(!off.includes(PRINTER_NOTE), 'no printer dialog is promised for office files');
  const app = approvalLines(f, { canPrint: false }).join('\n'); assert.match(app, /ダウンロード/); assert.ok(!app.includes(PRINTER_NOTE));
  assert.match(approvalLines({ name: 'big.txt', size: 5 * MB }, { truncatedAt: LIMITS.printText }).join('\n'), /先頭の 1\.0 MB だけ/);
});

test('print log: newest first, capped, outcome is only what the owner answered, formatted for the screen', () => {
  let log = [];
  log = addLog(log, { file: 'a.pdf', at: Date.UTC(2026, 10, 6, 1, 5), outcome: 'unknown' });
  log = addLog(log, { file: 'b.pdf', at: Date.UTC(2026, 10, 6, 2, 0), outcome: 'printed', copies: 2 });
  assert.deepEqual(log.map((e) => e.file), ['b.pdf', 'a.pdf']); assert.equal(log[1].outcome, 'unknown');
  assert.equal(addLog([], { file: 'x', outcome: 'bogus' })[0].outcome, 'unknown');
  assert.equal(formatLogEntry(log[0]), '11/6 11:00　b.pdf　2部　印刷できた'); assert.match(formatLogEntry(log[1]), /結果は未確認/);
  let many = []; for (let i = 0; i < 130; i++) many = addLog(many, { file: 'f' + i, at: i }); assert.equal(many.length, LIMITS.maxLog); assert.equal(many[0].file, 'f129');
  assert.ok(TROUBLESHOOT.some((t) => /電源/.test(t)) && TROUBLESHOOT.some((t) => /Android/.test(t)) && TROUBLESHOOT.some((t) => /キャンセル/.test(t)));
});

test('html for the print frame: everything from the file is escaped', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> & "q"';
  const h = textPrintHtml('<b>n</b>.txt', evil, 2);
  assert.ok(!/<script>|<img src=x/i.test(h)); assert.match(h, /&lt;script&gt;/); assert.match(h, /&lt;b&gt;n&lt;\/b&gt;\.txt/); assert.equal((h.match(/class="c"/g) || []).length, 2);
  assert.match(h, /white-space:pre-wrap/); assert.match(h, /@page\{margin:14mm\}/);
  const im = imagePrintHtml('p.png', 'blob:http://x/"><script>', 1); assert.ok(!/<script>/.test(im)); assert.match(im, /object-fit:contain/);
  assert.equal(escHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('text decoding: UTF-8, BOM, Shift_JIS fallback, preview cap', () => {
  assert.equal(decodeText(new TextEncoder().encode('\uFEFFこんにちは')).text, 'こんにちは');
  const sjis = Uint8Array.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); assert.equal(decodeText(sjis).text, 'テスト');
  const d = decodeText(new TextEncoder().encode('a'.repeat(300 * 1024)), LIMITS.previewText); assert.equal(d.truncated, true); assert.equal(d.text.length, LIMITS.previewText);
  assert.equal(decodeText(new TextEncoder().encode('short'), LIMITS.previewText).truncated, false);
});

test('pdf page count (rough) and the second-brain note', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Pages/Count 2>>endobj\n2 0 obj<</Type /Page /Parent 1 0 R>>endobj\n3 0 obj<</Type/Page>>endobj');
  assert.equal(countPdfPagesRough(pdf), 2); assert.equal(countPdfPagesRough(new TextEncoder().encode('hello')), null);
  const n = brainNote({ name: 'メモ/手順.csv' }, 'a,b\n1,2', { now: Date.UTC(2026, 10, 6) });
  assert.equal(n.path, 'ファイル/手順.md'); assert.match(n.content, /^# 手順\n/); assert.match(n.content, /```csv\na,b\n1,2\n```/); assert.match(n.content, /保存日：2026-11-06/); assert.equal(n.tooLong, false);
  assert.match(brainNote({ name: 'x.md' }, '# Hi\ntext').content, /\n# Hi\ntext\n$/);
  assert.match(brainNote({ name: 'x.json' }, '```inner```').content, /~~~~json/);
  assert.equal(brainNote({ name: 'x.txt' }, 'あ'.repeat(25000)).tooLong, true);
  assert.ok(!brainNote({ name: '../../a#b.txt' }, 'x').path.includes('..'));
});

test('tools: file tools are declared, always on (offered without Google), read-kind (executed in the page); the note saver is hidden', () => {
  const names = ['file_import', 'file_list', 'file_show', 'print_file', 'file_delete'];
  for (const n of names) { const t = TOOLS.find((x) => x.name === n); assert.ok(t, n); assert.equal(t.kind, 'read'); assert.equal(t.alwaysOn, true); assert.ok(declarations({ alwaysOnly: true }).some((d) => d.name === n)); }
  assert.deepEqual(Object.keys(TOOLS.find((x) => x.name === 'print_file').schema.properties).sort(), ['copies', 'name']);
  assert.deepEqual(TOOLS.find((x) => x.name === 'file_delete').schema.required, ['name']);
  const n = TOOLS.find((x) => x.name === 'file_note_save'); assert.equal(n.hidden, true); assert.equal(n.kind, 'write'); assert.ok(!declarations().some((d) => d.name === 'file_note_save'));
  assert.equal(TOOLS.filter((t) => t.alwaysOn).length, 12);
});

test('persona teaches the file and print flow, with the honest limits', () => {
  for (const google of [false, true]) {
    const p = buildInstruction({ google });
    for (const k of ['file_import', 'file_list', 'file_show', 'print_file', 'file_delete']) assert.ok(p.includes(k), k);
    assert.match(p, /印刷できましたか/); assert.match(p, /プリンターは、印刷ダイアログで選びます/); assert.match(p, /承認したときだけ印刷ダイアログが開きます/);
  }
});

test('note saver: refuses paths outside ファイル/ (the path check runs before anything else)', async () => {
  const t = TOOLS.find((x) => x.name === 'file_note_save');
  await assert.rejects(() => t.run({ path: '../x.md', content: 'a' }), /ファイル\//);
  await assert.rejects(() => t.run({ path: '人物/x.md', content: 'a' }), /ファイル\//);
});
