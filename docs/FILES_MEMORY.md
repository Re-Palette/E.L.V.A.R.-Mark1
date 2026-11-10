# ファイルの「記憶」: 読み取り・区別・検索 (File memory)

Extends `docs/FILES_PRINT.md`. When a file is imported, E.L.V.A.R. now reads its content **on this device**, remembers what it is (keywords, kind, dates, a lead snippet), tells identical / similar files apart, can search them, and — only with an approval card — hand text to the AI.

Code: `web/src/file-index.js` (pure: tokenising, keywords, kind guess, duplicates, search, chunking, the file_read gate, the second-brain note), `web/src/file-extract.js` (zip / docx / xlsx / pptx / pdf / image readers), `web/src/file-analyze.js` + `file-worker.js` + `file-analyze-client.js` (Web Worker pipeline: read, hash, extract, index; progress, cancel), `file-pdfjs.js` (lazy pdfjs), `file-store.js` (IndexedDB v2), `file-view.js` (screen), tools in `web/src/google-tools.js` / `server/google/tools.js`, AI routes in `server/chat-api.js` (`file_summarize`, `file_ocr`). Tests: `test/files-memory.test.mjs` (+ `test/files.test.mjs`).

## Limits and big files
- **60 MB per file; the total is the account's storage quota (500 MB by default, per user)** — `LIMITS.perFile` in `file-lib.js`, and `accounts.storage_quota_bytes` on the server (see `docs/ELVAR_MULTIUSER.md` section 16). Older text below that says 600 MB / device describes the pre-account library. Over the limit: 「〇〇は 61 MB あり、1ファイル 60 MB までのため取り込めません」; empty files are refused.
- Real room: `navigator.storage.estimate()` is shown in the header (「端末の空き：約 … ／ ブラウザの見積もり」) and a file that would not fit the estimated free space is refused with that number. `navigator.storage.persist()` is requested after the first successful import; when the browser says no, the header warns that it may clear the library when space is short. Both are the browser's estimates, not guarantees.
- Nothing heavy runs on the main thread: the file is read as a Blob stream in a **Web Worker** (`file-worker.js`) in 1 MB steps (real progress bar: 「name：読み込み中 34%（1/3）」 + キャンセル), SHA-256 and text extraction run there too. If workers are unavailable the same code runs on the main thread in small steps. Cancelling stops the worker and stores nothing.
- Extraction caps (`EXTRACT` in `file-lib.js`): the first 2 MB of a text file (→ at most 2M characters), the first 300 PDF pages, 500 rows × 20 sheets of a workbook, 300 slides, 24 MB per zip entry (zip-bomb guard). When something is cut, the 情報 tab says so (「長いため、先頭の約2 MBだけ読み取りました」) and `file_read` says it too.
- Measured in headless Chromium (Playwright): a 58 MB text file and a 57 MB xlsx were imported with **no main-thread long task** (0 long tasks, max timer gap 2 ms). A phone with little RAM may still struggle with 60 MB (the worker holds the file in memory while hashing); that is not verified here.

## What is read (local only)
| Format | What is extracted |
|---|---|
| PDF | text layer via `pdfjs-dist` (lazy chunk, legacy build; Japanese CMaps are served from `/pdfjs-cmaps/`), page count, title metadata. **No text layer = 「文字が読み取れません（スキャン画像）」**, never made up |
| Word `.docx` | `word/document.xml`: paragraphs, tabs, line breaks, table cells (one row per line), headings (by style name, also Japanese styles), title, core.xml title |
| Excel `.xlsx` | sheet names, shared + inline strings, numbers as stored (dates stay serial numbers), first 500 rows per sheet |
| PowerPoint `.pptx` | slide order, slide titles, body text, speaker notes (slide numbers / footers skipped) |
| Text / md / csv / tsv / json / log | UTF-8 or Shift_JIS (`decodeText`, safe at a cut multibyte character) |
| Images | width/height (PNG/JPEG/GIF/WebP) and EXIF shooting date; **no OCR locally** |
| Old `.doc .xls .ppt` | not readable: recorded as 「旧形式…の中身は読み取れません」 |
Failures are recorded in the index (`status: failed`, `error`) and shown (badge 「読取失敗」, 情報 tab); the file itself is still kept.

Zip reading is a small own reader (Blob.slice + `DecompressionStream('deflate-raw')`), so no zip library was added. The only new dependency is `pdfjs-dist` (lazy).

## The index ("memory") — the account's `app.files` / `app.file_texts` (was: IndexedDB `elvar-files` v2)
Since P5 the record below is stored in columns (title, kind guess, keywords, snippet, tags, memo, kind label, version mark) and one JSON field (`analysis`: headings, dates, amounts, pages ...) of `app.files`, the extracted text in `app.file_texts`; `shared/file-record.js` turns the browser's index into columns and back. Reading still happens in the browser's Worker; searching is on the server (`GET /api/elvar/files/search`: the same ranking code over the account's files, plus a text search for the words only the body contains). Text kept per file is capped at 1.3 million characters (the page says so). Text of the stored version is below.
Stores: `meta` and `blobs` (as before), `index` (light record, listed often), `texts` (capped extracted text). Upgrading v1 keeps every file; files imported before this feature show 「未読取」 and are read in the background when the library opens (or with 「読み取る」). Per file the index holds: SHA-256, status, notes, page / sheet / slide counts, title, headings, **keywords** (Japanese-aware: kanji runs + bigrams of long runs, katakana runs, latin words; stopwords; tf × idf-like weight using the other files; title/headings count double), a **snippet** (lead sentences, plain code, no model), language, **dates** written in the text (西暦/令和/平成 normalised, no year = not invented), obvious **amounts** (¥ / 円, with label like 合計), a **kind guess** by heuristics (レポート/論文, 領収書・請求書, 契約書, 履修・時間割, シフト表, 議事録, 資料/スライド, 表計算, 手紙, その他), and the owner's **tags**, **memo** and **kind label** (editable; the owner's label wins over the guess). Everything is a guess from patterns; the screen says 「自動判定（推測です）」.

## Telling files apart
- **Exact duplicate** (same SHA-256): not stored twice. The screen says 「同じ内容のファイルがすでにあります（名前）」 with [それでも保存する] / [保存しない]. Kept anyway = badge 「同内容」.
- **Near duplicate / new version**: similar name stem (version words, digits, copy marks removed) **and** high keyword-set similarity (or very high similarity alone) → badge 「別版かも」 and 「〇〇の別版かもしれません」. Never merged or deleted automatically.
- List rows: type icon, name, badges (別版かも / 同内容 / スキャン / 読取失敗 / 未読取), kind label, page/slide/sheet count, size, date, tags, snippet — each on one line (ellipsis). Search box (name, tags, kind, headings, keywords, summary, full text), filters by kind and tag, sort (新しい順 / 古い順 / 名前順 / 種類順 / 大きい順).

## Printing by content
`print_file` matching now also uses the index: 「履修表をプリントして」 (kind), 「領収書を印刷」 (found by content even if the name is `scan0007.pdf`), 「先月のレポート」 (date words 今日/昨日/今週/先週/今月/先月/先々月/去年/N月 are a hard condition: the day the file was added or a date written in it). The never-guess rule is unchanged: nothing found = say so; several = the choice card, which now shows **kind and a short snippet** for each candidate so they can be told apart.

## New tools (declared like the other file tools; handled in the page; blocked while the phone is locked)
- `file_search {query}`: local search. **What goes back to the model (= to the AI) is only names, kinds and snippets of at most 120 characters** (`searchResultForModel`); never the full text. The screen shows the results.
- `file_read {name, part?}`: returns extracted text to the model so it can answer 「このファイルに何て書いてある？」. **This sends file content to the AI**, so the first time per file (per session) an approval card appears: file name + 「この内容をAIに読ませます」. Only exactly `true` approves; a "no" returns no content and the text is not even loaded (`gatedRead`, tested). Up to ~6000 characters per call (cut at a line break), `next` tells how to read the following part, truncation / scan / failure are reported honestly, and the model is told to quote only what the text says and answer 「分かりません」 otherwise.
- `file_tag {name, tags?, memo?, kind?}`: local edit of tags / memo / kind label (kind must be one of the ten labels).
The persona section 「ファイルと印刷」 teaches all of this.

## Approval cards for sending content outward
| Where | What the card says | What is sent |
|---|---|---|
| `file_read` | file name, 「この内容をAIに読ませます」 | the text, in chunks, as the tool result |
| 情報 tab 「AIで要約」 | file name, characters (≤ 12,000), 「送り先：AIサービス（Gemini など）」 | that text → `/api/chat` `file_summarize`; the summary is stored in the index (`summaryAI`) and marked as AI-made |
| 情報 tab 「AIで内容を読み取る」 (images) | file name, the shrunken size (max 1600 px JPEG), 「写っているものはすべてAIに渡ります」 | one image → `/api/chat` `file_ocr` (Gemini `inlineData`, fixed transcription prompt, no tools); the text is stored as the file's text |
Nothing is sent before the card returns `true`. There is **no offline OCR**; only the explicit button above reads text from an image (needs a Gemini key on the server).

## 第二の脳にも保存
Now a **summary note** at `ファイル/<name>.md`: title, kind, keywords, snippet/summary (AI summary if there is one, marked), tags, memo, counts, dates, amounts — **not the full text** (a text/md/csv/json file of at most ~12,000 characters keeps its text as a 本文 section). Written through the guarded `file_note_save` (private repo only, `ファイル/` only), as the owner's own record without an approval card, so ELVAR remembers the file on every device. A second save replaces the note only if this screen saved it before (`brainPath` in the index); otherwise an existing note of the same name is never overwritten.

## Bundle / build
`npm run build`: main bundle `index-*.js` 794.44 kB → 842.62 kB (gzip 203.67 → 221.89 kB; +48 kB raw for file-index / the larger screen). New lazy chunks, loaded only when a file is analysed: `file-worker` 26.7 kB, `file-analyze` 14.9 kB, pdfjs `pdf` ≈ 500 kB + `pdf.worker` ≈ 1.2 MB (the worker bundle and the main-thread fallback each carry a copy, so `dist` grows by ~3.5 MB plus 1.7 MB of CMaps in `pdfjs-cmaps/`; none of it is fetched until a PDF is read). `vite.config.js`: `worker.format: 'es'` (code splitting in the worker) and a plugin that serves / copies the CMaps.

## Not verified / cannot be done
- OCR of scans and photos offline: impossible here; scans are reported as 「文字が読み取れません（スキャン画像）」.
- Real huge files on real phones (memory, IndexedDB write speed, quota prompts); `persist()` outcome on Safari/Android; Android WebView.
- Real voice (「領収書を印刷して」 by speech), and what the model actually answers from `file_read` / `file_search` results.
- Real Gemini calls for 「AIで要約」 / 「AIで内容を読み取る」 (the page and the server request shape are tested with stubs).
- PDFs with unusual encodings / non-embedded CJK fonts beyond the bundled CMaps; encrypted PDFs and password-protected Office files (reported as failures).
- Keyword / kind heuristics are patterns tested on realistic samples, not a measured accuracy.
