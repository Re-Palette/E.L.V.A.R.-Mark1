import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPdf, parseBlocks, safeFileName, stripInline } from '../web/src/pdf-doc.js';
import { PDFDocument } from 'pdf-lib';

const font = fs.readFileSync(new URL('../web/public/fonts/NotoSansJP-Regular.ttf', import.meta.url));
const MD = `# 概要
新しい企画「スマートグラス議事録」についてのまとめ。**重要**な点は [[案件/ELVAR]] を参照。

## 要点
- 会議の音声をその場で文字にする
  - 話者ごとに分ける
- 1. 発言は要約する 😀
1. 試作を作る
- [ ] 見積もり
- [x] 目的の整理

> 引用の例です。

| 項目 | 内容 | 期限 |
|---|---|---|
| 試作 | 小さく作って試す | 来月 |
| 本番 | 未定 | 未定 |

\`\`\`
code line
\`\`\`
---
最後の段落。`;

test('pdf: builds a valid A4 PDF with embedded Japanese font; blocks parse; emoji dropped silently', async () => {
  const blocks = parseBlocks(MD);
  assert.deepEqual(blocks.map((b) => b.t).slice(0, 4), ['h', 'p', 'h', 'li']);
  assert.ok(blocks.some((b) => b.t === 'table' && b.rows.length === 3));
  assert.equal(stripInline('**太** [[a/b|別名]] [x](https://e.com)'), '太 別名 x（https://e.com）');
  const { bytes, pages } = await buildPdf({ title: 'スマートグラス議事録 企画書', markdown: MD, fontBytes: font, subtitle: '2026-11-02 作成' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const d = await PDFDocument.load(bytes);
  assert.equal(d.getPageCount(), pages); assert.ok(pages >= 1);
  const [w, h] = [d.getPage(0).getWidth(), d.getPage(0).getHeight()]; assert.ok(Math.abs(w - 595.28) < 0.1 && Math.abs(h - 841.89) < 0.1);
  assert.ok(bytes.length < 3_000_000, 'size ok for upload: ' + bytes.length);
});

test('pdf: long documents flow onto more pages; file names are safe', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `## 節${i}\n` + 'これは長い文章の例です。日本語は文字ごとに折り返され、句読点が行頭に来ないようにします。'.repeat(3)).join('\n\n');
  const { pages } = await buildPdf({ title: '長い資料', markdown: long, fontBytes: font });
  assert.ok(pages >= 8, 'pages: ' + pages);
  assert.equal(safeFileName('a/b:c*?"<>|\n資料'), 'a b c 資料.pdf');
  assert.equal(safeFileName(''), '資料.pdf');
});
