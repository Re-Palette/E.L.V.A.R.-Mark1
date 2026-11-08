# ファイルの取り込み・保存・印刷 (Files and printing)

The owner can bring files into E.L.V.A.R., keep them on this device, look at them, and say 「〇〇プリントして」: ELVAR shows the content, asks for approval, opens the browser's print dialog, and afterwards asks whether it really printed.

**Reading the content, memory (keywords, kind, tags), search, duplicates, 60 MB: see `docs/FILES_MEMORY.md`.**

Code: `web/src/file-lib.js` (pure logic, tested), `web/src/file-store.js` (IndexedDB + print log), `web/src/file-view.js` (screen, drop/paste, print flow), tool handlers in `web/src/google-tools.js` (`fileTool`), declarations in `server/google/tools.js`, persona section 「ファイルと印刷」 in `server/persona.js`. Tests: `test/files.test.mjs`.

## Importing and saving
- Three ways in: drag & drop anywhere on the HUD (an overlay shows while dragging), the 「ファイルを取り込む」 button on the ファイル screen, and pasting files (Ctrl+V / screenshots; pasted images get a name like `貼り付け-202611061030.png`).
- Voice 「ファイルを取り込んで」 → `file_import` opens the screen with the button highlighted. Browsers only open a file picker after a user gesture, so ELVAR says "choose it with the button on the screen"; it cannot pick files by voice.
- Supported: PDF; PNG/JPEG/WebP/GIF; txt/md/csv/tsv/json/log; Word, Excel, PowerPoint (stored, **not previewable** — the screen says so; printing them = download and open in Office). SVG/HTML/other types are refused (the reported MIME type only counts when a name has no extension).
- Limits: 60 MB per file, 600 MB in total (`LIMITS` in `file-lib.js`, the one place the numbers live); when exceeded the screen says which limit and how much room is left (and, from `navigator.storage.estimate()`, the browser's estimate of the device's real free space). Empty files are refused. Names are sanitised (`safeName`: no path, no control/reserved characters, ≤ 100 chars).
- Storage: IndexedDB `elvar-files` (`meta` records: id, name, type, kind, size, addedAt, source; `blobs`). **Per device, never uploaded.** Private browsing / cleared site data = empty library.
- 「第二の脳にも保存」 (any file with a memory, optional button): saves a **summary note** (title, kind, keywords, snippet/summary, tags, memo; the full text only for a text file of at most ~12,000 characters) through the hidden server tool `file_note_save` → `brainWrite` at `ファイル/<name>.md`. It refuses a public repo (`brainRepoIsPrivate`) and anything outside `ファイル/`. Own-record write like the other second-brain writes, so no approval card. Details in `docs/FILES_MEMORY.md`.
- ELVAR-made PDFs (create_document): the 資料 card has a 「ファイルに保存」 button (device only). The last made document can also be printed by name without saving it (「さっきの資料を印刷して」).

## The ファイル screen (`.vf` look, like 家計/シフト)
List (name, type, size, date, ✕ delete with an inline confirmation) + preview: text is rendered as escaped text (first 200 KB, a note says when cut; UTF-8 or Shift_JIS), PDF in an embedded viewer with the page count, images as `<img>`, Word/Excel/PowerPoint get name/size/type and an honest note. Buttons: 印刷…, 部数, ダウンロード, 第二の脳にも保存, 削除…; 印刷ログ shows the print log. Voice: `file_list` (「ファイル一覧」), `file_show` (「〇〇を見せて」), `file_delete` (approval card).

## Print flow
`print_file {name, copies}` (or the 印刷… button) → `requestPrint` in `file-view.js`:
1. Find the file (`matchFiles`: normalised names, kana folding, substring/word/bigram scores; 「さっきの資料」 = the last made document). Nothing found → says so (no guessing). Several → the existing choice card (`show_choice` UI) with distinct labels; the answer comes back as text and the model calls `print_file` again.
2. Show the content in the screen (see above).
3. Approval card (`approval.ask`, `voice: true`, bottom placement so the preview stays readable): file name, type, size, pages if known, copies (default 1; voice 「2部」 → `parseCopies`), and 「印刷ダイアログで、接続されているプリンターを選びます」. A spoken plain 「はい」 approves, 「やめて」 or 却下 cancels. **Nothing is printed unless the card returns exactly `true`; every call to `print_file` — also a second one right after a refusal — asks again.**
4. After approval: an isolated hidden `<iframe class="vfl-pf">` prints the file — PDF (the blob in the frame; with copies > 1 the pages are repeated with pdf-lib), image (HTML with `object-fit: contain`, one page per copy), text (escaped `<pre>`, monospace, wrapping, 14 mm margins; first 1 MB). If the frame cannot print, the file opens in a new tab ("press Ctrl+P there").
5. When the dialog closes (`afterprint`, or 20 s) ELVAR shows 「印刷できましたか？」 [印刷できた] [できなかった]. `afterprint` also fires on cancel, so it is never treated as "printed". The attempt is logged first as 結果は未確認; the owner's answer (button or a spoken はい/いいえ) updates it. 「できなかった」 shows hints (printer power/connection, the printer chosen in the dialog, Chrome's destination list, Android print service, cancel pressed) and [もう一度印刷する].
6. Print log: last 100 entries in `localStorage.elvar_print_log` (file, time, copies, outcome), shown by 印刷ログ.

Office files: the card says they cannot be printed from the browser; approving downloads them (logged as 保存). Android app (WebView, `window.ElvarAndroid.saveFile` exists): `window.print` does nothing there, so approval saves the file to Downloads and says so; printing is done from the system. `android/` is untouched.

## What the web cannot do (and ELVAR says so)
- It cannot list printers or read printer status; the connected printers are whatever the browser's print dialog shows. ELVAR never says "the printer is connected/ready".
- It cannot know whether a page was printed; only the owner's answer is recorded.
- It cannot set copies in the dialog: for PDFs/images/text it repeats the pages itself; if that fails it says to set copies in the dialog.

## Safety / privacy
Files stay in this browser profile. No upload anywhere (the only outward paths are the explicit 「第二の脳にも保存」 button to the owner's private repo and the existing Drive button on the 資料 card, which keeps its own approval card). File contents are escaped everywhere (`escHtml`), never executed, and the persona tells the model that instructions inside files are data. All eight tools (`file_import/list/show/delete`, `print_file`, `file_search/read/tag`) are blocked while the phone is locked (they are not in the locked allow-list in `google-tools.js`), and they are `alwaysOn` (offered without Google).

## Not verified
Real printers and a real print dialog, real voice, Chrome's PDF viewer inside the hidden frame (headless Chromium has no PDF viewer; print calls were stubbed), Android WebView printing (the fallback is a download).
