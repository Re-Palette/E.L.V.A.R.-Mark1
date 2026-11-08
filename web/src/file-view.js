// ファイル screen: import (drop / picker / paste) with progress and cancel, the library list with search / filters, the preview + the file's "memory" (kind, tags, memo, keywords,
// extracted text), and the print flow (preview -> approval card -> browser print dialog -> "did it print?").
// Files and everything read from them stay on this device (IndexedDB). Nothing is uploaded, except when the owner approves an explicit card (AIで要約 / AIで内容を読み取る / file_read).
// Printing only ever starts after the owner approves the card; the printer is chosen in the browser's print dialog.
// It reuses the .vf-* look injected by finance-view.js (same family of screens).
import { ACCEPT, LIMITS, TROUBLESHOOT, approvalLines, checkQuota, classify, clampCopies, countPdfPagesRough, decodeText, escHtml as esc, fmtSize, formatLogEntry, imagePrintHtml, matchFiles, printMode, quotaText, safeName, textPrintHtml } from './file-lib.js';
import { KINDS, STATUS_JA, LANG_JA, buildIndex, choiceDetail, deviceSpace, findExactDuplicate, findNearDuplicate, gatedRead, indexNote, kindOf, normTags, searchFiles } from './file-index.js';
import { startAnalysis } from './file-analyze-client.js';
import { classifyReply } from './approval.js';
import { toBase64 } from './doc-card.js';
import { ownerAddress } from './brand.js';

const ICON = { pdf: '📕', image: '🖼', text: '📄', office: '📎', other: '📄' };
const SORTS = { new: '新しい順', old: '古い順', name: '名前順', kind: '種類順', size: '大きい順' };
const CSS = `
.vfl{width:min(1040px,100%)}
.vfl .vf-top small{color:#7fb6d6;font-size:12px;margin-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 0}.vfl .vf-top .vf-btn{white-space:nowrap;flex:0 0 auto}
.vfl-body{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:10px;flex:1;min-height:0;overflow:hidden;padding:10px 14px 12px;transition:padding-bottom .15s}
.vf-back.printing .vfl-body{padding-bottom:var(--vfl-pad,270px)}
.vfl-side{display:flex;flex-direction:column;gap:6px;min-height:0;min-width:0}
.vfl-drop{border:1.5px dashed rgba(25,211,255,.6);border-radius:5px;padding:6px 8px;text-align:center;background:rgba(25,211,255,.05);color:#9fc3d8;font-size:13px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 10px}.vfl-drop .dz-n{flex-basis:100%;font-size:11.5px;margin:0}
.vfl-drop.hot,.vfl-drop.flash{border-color:#1ee8c0;background:rgba(30,232,192,.14);color:#fff}
.vfl-drop .vf-btn{font-weight:600;background:rgba(25,211,255,.22);color:#fff}
.vfl-prog{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#cfeeff;border:1px solid rgba(40,150,200,.4);border-radius:4px;padding:4px 8px}.vfl-prog[hidden]{display:none}
.vfl-prog .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vfl-prog progress{width:70px;flex:0 0 auto;height:8px}
.vfl-flt{display:flex;flex-wrap:wrap;gap:4px}
.vfl-flt input,.vfl-flt select,.vfl-info input,.vfl-info select,.vfl-info textarea{background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.5);border-radius:3px;padding:4px 6px;font:inherit;font-size:13px;min-width:0}
.vfl-flt input{flex:1 1 100%}.vfl-flt select{flex:1 1 30%;max-width:100%}
.vfl-list{flex:1;min-height:0;overflow:auto;border:1px solid rgba(40,150,200,.35);border-radius:4px}
.vfl-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid rgba(40,150,200,.18);cursor:pointer}
.vfl-row:hover{background:rgba(25,211,255,.08)}.vfl-row.sel{background:rgba(25,211,255,.2)}
.vfl-row .ic{flex:0 0 auto;font-size:18px}.vfl-row .tx{flex:1;min-width:0}.vfl-row .nm{color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px}.vfl-row .sb,.vfl-row .sn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vfl-row .sb{color:#7fb6d6;font-size:11.5px}.vfl-row .sn{color:#8aa9bd;font-size:11.5px}
.bd{display:inline-block;margin-left:5px;padding:0 5px;border:1px solid rgba(25,211,255,.6);border-radius:8px;color:#8fe3ff;font-size:10.5px;vertical-align:1px}.bd.w{border-color:#ffb347;color:#ffb347}
.vfl-x{flex:0 0 auto;background:transparent;border:1px solid transparent;color:#7fb6d6;cursor:pointer;border-radius:3px;padding:2px 7px;font:inherit}.vfl-x:hover,.vfl-x:focus-visible{border-color:#ff6b6b;color:#ff6b6b;outline:none}
.vfl-empty{padding:14px 10px;color:#7fb6d6;font-size:13px}
.vfl-main{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:8px 10px}
.vfl-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}.vfl-h b{color:#fff;font-size:15px;word-break:break-all}.vfl-h span{color:#7fb6d6;font-size:12.5px}
.vfl-tabs{display:flex;gap:4px}.vfl-tabs button{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.45);border-radius:3px;padding:3px 12px;cursor:pointer;font:inherit;font-size:12.5px}.vfl-tabs button.on{background:rgba(25,211,255,.28);color:#fff}
.vfl-pv{flex:1;min-height:0;overflow:auto;background:rgba(0,12,28,.7);border:1px solid rgba(40,150,200,.3);border-radius:3px;display:flex;align-items:stretch;justify-content:center}
.vfl-pv iframe{width:100%;height:100%;border:0;background:#fff;min-height:160px}.vfl-pv img{max-width:100%;max-height:100%;object-fit:contain;align-self:center}
.vfl-pv pre{margin:0;padding:8px 10px;width:100%;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font:12.5px/1.5 ui-monospace,Menlo,Consolas,'Noto Sans Mono CJK JP',monospace;color:#d9eef9}
.vfl-note{align-self:center;padding:14px;color:#cfeeff;text-align:center;font-size:13.5px;max-width:34em}
.vfl-info{display:block;width:100%;padding:8px 10px;box-sizing:border-box;font-size:13px;color:#cfeeff;line-height:1.55}
.vfl-info .r{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0 0 6px}.vfl-info .r>b{flex:0 0 5.2em;color:#7fb6d6;font-weight:600}.vfl-info .r>:not(b){min-width:0}
.vfl-info .r input[type=text]{flex:1 1 12em}.vfl-info textarea{flex:1 1 12em;resize:vertical}
.vfl-info .kw{display:inline-block;margin:1px 3px 1px 0;padding:0 7px;border-radius:9px;background:rgba(25,211,255,.14);color:#cfeeff;font-size:12px}
.vfl-info .hint{color:#7fb6d6;font-size:12px}.vfl-info .warn{color:#ffb347}
.vfl-info .ai{margin-top:8px;padding-top:6px;border-top:1px solid rgba(40,150,200,.3)}
.vfl-act{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.vfl-act label{color:#7fb6d6;font-size:12.5px}.vfl-act input[type=number]{width:3.4em;background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.5);border-radius:3px;padding:3px 4px;font:inherit}
.vfl-act .vf-btn.pri{background:rgba(25,211,255,.3);color:#fff;font-weight:600}.vfl-act .sp{margin-left:auto}
.vfl-msg{min-height:1.3em;color:#1ee8c0;font-size:13px;white-space:pre-line}.vfl-msg.warn{color:#ffb347}.vfl-msg:empty{display:none}
.vfl-dup{border:1px solid #ffb347;border-radius:4px;padding:6px 8px;color:#ffd9a0;font-size:13px}.vfl-dup[hidden]{display:none}.vfl-dup .b{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.vfl-conf{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:#ffd9a0;font-size:13px}
.vfl-log{max-height:26vh;overflow:auto;border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:6px 10px;font-size:12.5px;color:#cfeeff}.vfl-log div{padding:1px 0}
.vfl-ask{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:62;width:min(520px,calc(100% - 24px));display:none;box-sizing:border-box;
  background:linear-gradient(180deg,rgba(3,26,52,.99),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:12px 14px;box-shadow:0 0 14px rgba(25,190,255,.45);font:14.5px/1.55 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif;max-height:70vh;overflow:auto}
.vfl-ask.on{display:block;animation:va-in .16s ease-out}.vfl-ask h3{margin:0 0 4px;font-size:12.5px;letter-spacing:2px;color:#8fe3ff;font-weight:600}.vfl-ask .q{font-weight:700;color:#fff}
.vfl-ask ul{margin:6px 0 0;padding-left:1.2em;color:#cfeeff;font-size:13px}.vfl-ask .b{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.vfl-ask .b button{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.7);border-radius:3px;padding:7px 18px;cursor:pointer;font:inherit;font-weight:600}.vfl-ask .b button:hover,.vfl-ask .b button:focus-visible{background:rgba(25,211,255,.22);color:#fff;outline:none}.vfl-ask .b .go{background:rgba(25,211,255,.28)}
.vfl-dz{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;background:rgba(0,40,60,.72);border:3px dashed #1ee8c0;color:#fff;font:600 22px 'Noto Sans JP','Yu Gothic UI',sans-serif;pointer-events:none;letter-spacing:2px;text-align:center;padding:20px}
.vfl-dz.on{display:flex}
.vfl-pf{position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none}
@media (max-width:760px){.vfl-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(300px,52%) minmax(0,1fr);overflow:auto}.vfl-drop .dz-n,.vfl-drop .dz-t{display:none}.vfl-drop{padding:4px 8px}.vf-back.printing .vfl-body{padding-bottom:var(--vfl-pad,360px);grid-template-rows:minmax(0,1fr)}.vf-back.printing .vfl-side{display:none}.vfl .vf-top small{display:none}.vfl-flt input{flex-basis:100%}.vfl-info .r>b{flex-basis:100%}}
@media (min-width:761px) and (max-height:640px){.vf-back.printing .vfl-body{grid-template-columns:minmax(0,1fr)}.vf-back.printing .vfl-side{display:none}.vfl-body{gap:6px;padding:6px 10px 8px}.vfl-main{padding:6px 8px;gap:4px}.vfl-drop{padding:3px 8px}.vfl-drop .dz-n{display:none}.vfl-row{padding:3px 8px}}
`;

const isNative = () => !!(window.ElvarAndroid && window.ElvarAndroid.saveFile);
const jst = (t) => { const d = new Date(t + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const uid = () => (globalThis.crypto?.randomUUID?.() || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/** An image, shrunk for the AI (max 1600 px, JPEG). Done here, on the device, before anything is sent. */
async function shrinkImage(blob) {
  const bmp = await createImageBitmap(blob), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  for (const q of [0.85, 0.7, 0.5]) { const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q)); if (b && b.size * 1.37 < 3_400_000) return { blob: b, w, h }; }
  throw new Error('画像が大きすぎて、縮小しても送れません');
}

/**
 * @param {{approval:{ask:Function}, store:ReturnType<import('./file-store.js').createFileStore>, saveToBrain?:(a:{path:string,content:string,replace?:boolean})=>Promise<{ok:boolean,message:string}>, callAI?:(body:object)=>Promise<object>, sendText?:(t:string)=>void, onActivity?:(a:{icon:string,title:string,sub:string})=>void}} o
 */
export function initFileView({ approval, store, saveToBrain = null, callAI = null, sendText = () => {}, onActivity = () => {} }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'ファイル');
  back.innerHTML = `<div class="vf vfl"><div class="vf-top"><i></i><h2>FILES</h2><small id="vfl-quota"></small><span class="sp"></span><button class="vf-btn" data-showlog type="button">印刷ログ</button><button class="vf-btn" data-x type="button">閉じる</button></div>
    <div class="vfl-body">
      <div class="vfl-side">
        <div class="vfl-drop" id="vfl-drop"><div class="dz-t">ここにドロップ／貼り付け（Ctrl+V）</div><button class="vf-btn" data-pick type="button">ファイルを取り込む</button><div class="vf-muted dz-n">PDF・画像・テキスト・Office ／ 1ファイル ${Math.round(LIMITS.perFile / 1048576)} MBまで ／ 中身は端末の中で読み取り、外には送りません</div></div>
        <div class="vfl-prog" id="vfl-prog" hidden><span class="t" id="vfl-prog-t"></span><progress id="vfl-prog-p" max="100" value="0"></progress><button class="vf-btn" data-cancel type="button">キャンセル</button></div>
        <div class="vfl-dup" id="vfl-dup" hidden></div>
        <div class="vfl-msg" id="vfl-msg" role="status"></div>
        <div class="vfl-flt"><input type="search" id="vfl-q" placeholder="検索（名前・中身・タグ）" aria-label="ファイルを検索" autocomplete="off"><select id="vfl-fk" aria-label="種類で絞り込み"></select><select id="vfl-ft" aria-label="タグで絞り込み"></select><select id="vfl-fs" aria-label="並び順">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="vfl-list" id="vfl-list"></div>
      </div>
      <div class="vfl-main" id="vfl-main"></div>
    </div>
    <input type="file" id="vfl-input" multiple hidden accept="${ACCEPT}"></div>`;
  document.body.appendChild(back);
  const dz = document.createElement('div'); dz.className = 'vfl-dz'; dz.textContent = 'ここにドロップすると、ファイルを取り込みます'; document.body.appendChild(dz);
  const ask = document.createElement('div'); ask.className = 'vfl-ask'; ask.setAttribute('role', 'alertdialog'); ask.setAttribute('aria-label', '印刷の確認'); document.body.appendChild(ask);
  const $ = (id) => back.querySelector('#' + id);
  const input = $('vfl-input'), listEl = $('vfl-list'), mainEl = $('vfl-main'), msgEl = $('vfl-msg'), quotaEl = $('vfl-quota'), progEl = $('vfl-prog'), dupEl = $('vfl-dup');
  const qEl = $('vfl-q'), fkEl = $('vfl-fk'), ftEl = $('vfl-ft'), fsEl = $('vfl-fs');

  let files = [], indexes = new Map(), textCache = null, space = null, persisted = null, dfCache = null;
  let selectedId = null, tab = 'view', pvUrl = '', showLog = false, printing = false, pendingConfirm = null, lastDoc = null, lastDocSavedId = null, pf = null, pfTimer = 0;
  let running = null, batchCancelled = false, pendingDups = [];
  const flt = { q: '', kind: '', tag: '', sort: 'new' };
  const readGrants = new Set();   // file ids the owner let the AI read in this session
  const say = (t, warn = false) => { msgEl.textContent = t; msgEl.className = 'vfl-msg' + (warn ? ' warn' : ''); };
  const setPv = (blob) => { if (pvUrl) URL.revokeObjectURL(pvUrl); pvUrl = blob ? URL.createObjectURL(blob) : ''; return pvUrl; };

  // ---------------------------------------------------------------- data
  async function spaceInfo() {
    try { space = deviceSpace(await navigator.storage?.estimate?.()); } catch { space = null; }
    try { persisted = (await navigator.storage?.persisted?.()) ?? null; } catch { persisted = null; }
  }
  async function refresh() {
    try { files = await store.list(); indexes = await store.indexes(); } catch (e) { files = []; indexes = new Map(); say(String(e?.message || e), true); }
    textCache = null; dfCache = null;
    await spaceInfo();
    const used = files.reduce((s, f) => s + (f.size || 0), 0);
    quotaEl.textContent = quotaText(used, LIMITS, space, persisted); quotaEl.title = quotaEl.textContent;
    fillFilters();
    return files;
  }
  /** Full texts for searching (loaded once per change; a memory budget leaves the rest out). */
  async function ensureTexts() { if (!textCache) { try { textCache = await store.allTexts(); } catch { textCache = new Map(); } } return textCache; }
  function docFreq() {
    if (dfCache) return dfCache;
    const df = {}; for (const ix of indexes.values()) for (const k of new Set(ix.keywords || [])) df[k] = (df[k] || 0) + 1;
    return (dfCache = { df, n: indexes.size });
  }
  /** The library plus the document ELVAR made last (when it has not been saved), so 「さっきの資料」 can be printed without saving it first. */
  function allFiles() {
    const out = [...files];
    if (lastDoc && !lastDocSavedId) out.unshift({ id: 'lastdoc', name: lastDoc.name, type: 'application/pdf', kind: 'pdf', size: lastDoc.bytes.length, addedAt: lastDoc.at, source: 'elvar-doc', transient: true });
    return out;
  }
  const lastDocId = () => (lastDoc ? lastDocSavedId || 'lastdoc' : null);
  async function record(id) {
    if (id === 'lastdoc' && lastDoc) return { meta: allFiles()[0], blob: new Blob([lastDoc.bytes], { type: 'application/pdf' }) };
    const meta = files.find((f) => f.id === id) || await store.get(id); if (!meta) return null;
    const blob = await store.blob(id); if (!blob) return null;
    return { meta, blob };
  }

  // ---------------------------------------------------------------- progress / cancel
  function showProg(p) {
    if (!p) { progEl.hidden = true; return; }
    progEl.hidden = false;
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
    $('vfl-prog-t').textContent = `${p.name ? p.name + '：' : ''}${p.stage || '処理中'}${pct != null ? ` ${pct}%` : ''}${p.n > 1 ? `（${p.i}/${p.n}）` : ''}`;
    const bar = $('vfl-prog-p'); if (pct != null) bar.value = pct; else bar.removeAttribute('value');
  }
  const throttle = (fn) => { let last = 0; return (p) => { const t = Date.now(); if (t - last < 120 && p.done !== p.total) return; last = t; fn(p); }; };
  /** Run the analysis of one file in the worker, with progress. Rejects with {cancelled:true} when the owner cancels. */
  async function analyse(file, name, mime, progressBase) {
    const { df, n } = docFreq();
    running = startAnalysis(file, { name, mime, docFreq: df, docCount: n, onProgress: throttle((p) => showProg({ ...progressBase, ...p })) });
    try { return await running.promise; } finally { running = null; showProg(null); }
  }

  // ---------------------------------------------------------------- import
  function dupBox() {
    dupEl.hidden = !pendingDups.length;
    dupEl.innerHTML = pendingDups.map((d, i) => `<div>同じ内容のファイルがすでにあります（${esc(d.dup.name)}）。「${esc(d.name)}」は二重に保存しません。</div><div class="b"><button class="vf-btn" data-dupkeep="${i}" type="button">それでも保存する</button><button class="vf-btn" data-dupskip="${i}" type="button">保存しない</button></div>`).join('');
  }
  async function storeOne({ file, name, c, an, source, dup = null }) {
    const near = dup ? null : findNearDuplicate({ name, keywords: an.index.keywords, sha256: an.sha256 }, files, indexes);
    const index = { ...an.index, related: near, ...(dup ? { dupOf: { id: dup.id, name: dup.name } } : {}) };
    const meta = { id: uid(), name, type: c.mime, kind: c.kind, size: file.size, addedAt: Date.now(), source };
    await store.put(meta, file.slice(0, file.size, c.mime), index, an.text);
    files = [meta, ...files]; indexes.set(meta.id, index); textCache = null; dfCache = null;
    return { meta, near };
  }
  async function importFiles(list, source = 'picker') {
    const arr = Array.from(list || []); const added = [], rejected = [], duplicates = [], similar = [];
    if (!arr.length) return { added, rejected, duplicates };
    open(); batchCancelled = false;
    await refresh(); let used = files.reduce((s, f) => s + (f.size || 0), 0);
    for (let i = 0; i < arr.length; i++) {
      if (batchCancelled) { rejected.push({ name: arr[i].name, reason: `「${safeName(arr[i].name)}」：取り込みをキャンセルしました` }); continue; }
      const f = arr[i], name = safeName(f.name || 'ファイル'), c = classify(name, f.type);
      if (!c.ok) { rejected.push({ name, reason: `「${name}」：${c.reason}` }); continue; }
      const q = checkQuota({ name, size: f.size, used, deviceFree: space ? space.free : null });
      if (!q.ok) { rejected.push({ name, reason: q.reason }); continue; }
      let an;
      try { an = await analyse(f, name, c.mime, { name, i: i + 1, n: arr.length }); }
      catch (e) {
        if (e?.cancelled) { batchCancelled = true; rejected.push({ name, reason: `「${name}」：取り込みをキャンセルしました` }); continue; }
        // the reader itself failed: the file is still kept, with the failure recorded (nothing is hidden)
        an = { sha256: '', text: '', index: buildIndex({ text: '', status: 'failed', error: String(e?.message || e) }, { name, ext: c.ext, size: f.size }).index };
      }
      const dup = findExactDuplicate(an.sha256, files, indexes);
      if (dup) { duplicates.push({ name, dup }); pendingDups.push({ file: f, name, c, an, source, dup }); continue; }
      try { const { meta, near } = await storeOne({ file: f, name, c, an, source }); used += f.size; added.push(meta); if (near) similar.push({ name, near }); }
      catch (e) { rejected.push({ name, reason: `「${name}」を保存できませんでした：${e?.message || e}（この端末の空き容量や、ブラウザの保存設定を確認してください）` }); }
    }
    showProg(null); dupBox();
    if (added.length && persisted === false) { try { persisted = (await navigator.storage?.persist?.()) ?? persisted; } catch { /* ignore */ } }
    await refresh();
    if (added.length) { selectedId = added[added.length - 1].id; onActivity({ icon: 'doc', title: 'ファイルを取り込み', sub: added.length === 1 ? added[0].name : `${added.length}件` }); }
    open(); await render();
    const parts = [];
    if (added.length) parts.push(`${added.length}件を取り込みました（この端末の中だけに保存）`);
    for (const s of similar) parts.push(`「${s.name}」は「${s.near.name}」の別版かもしれません（まとめたり、消したりはしていません）`);
    for (const a of added) { const ix = indexes.get(a.id); if (ix && ix.status !== 'ok' && ix.status !== 'image') parts.push(`「${a.name}」：${STATUS_JA[ix.status] || ''}${ix.error ? '（' + ix.error + '）' : ''}`); }
    if (rejected.length) parts.push(rejected.map((r) => r.reason).join('\n'));
    say(parts.join('\n'), (!!rejected.length || !!duplicates.length) && !added.length);
    return { added, rejected, duplicates };
  }
  async function keepDuplicate(i) {
    const d = pendingDups[i]; if (!d) return; pendingDups.splice(i, 1); dupBox();
    try { await storeOne({ ...d, dup: d.dup }); await refresh(); selectedId = files[0]?.id || selectedId; await render(); say(`「${d.name}」を、同じ内容のファイルとして別に保存しました`); }
    catch (e) { say(`保存できませんでした：${e?.message || e}`, true); }
  }
  function skipDuplicate(i) { const d = pendingDups[i]; pendingDups.splice(i, 1); dupBox(); if (d) say(`「${d.name}」は保存しませんでした（すでにある「${d.dup.name}」と同じ内容です）`); }

  /** (Re)read a stored file: the old files from before the memory existed, or "読み取り直す". The owner's tags / memo / label / summaries are kept. */
  async function reanalyse(id, { quiet = false } = {}) {
    const rec = await record(id); if (!rec) return false;
    const old = indexes.get(id) || {};
    try {
      const an = await analyse(rec.blob, rec.meta.name, rec.meta.type, { name: rec.meta.name });
      const keep = {}; for (const k of ['tags', 'memo', 'kind', 'summaryAI', 'summaryAt', 'brainPath', 'brainSavedAt', 'related', 'dupOf', 'ocrAI']) if (old[k] !== undefined && !(k === 'tags' && !old.tags?.length)) keep[k] = old[k];
      const index = { ...an.index, ...keep, sha256: an.sha256 || old.sha256 || '' };
      await store.putIndex(id, index, an.text); indexes.set(id, index); textCache = null; dfCache = null;
      if (!quiet) { await render(); say('読み取りました'); }
      return true;
    } catch (e) { if (!e?.cancelled && !quiet) say(`読み取れませんでした：${e?.message || e}`, true); return false; }
  }
  let autoBusy = false;
  async function autoIndexMissing() {   // files stored before the memory existed
    if (autoBusy || running) return; autoBusy = true;
    try { for (const f of [...files]) { if (indexes.has(f.id) || batchCancelled) continue; await reanalyse(f.id, { quiet: true }); renderList(); } if (back.classList.contains('on')) await renderMain(); }
    finally { autoBusy = false; }
  }

  // ---------------------------------------------------------------- drawing
  function fillFilters() {
    const kinds = [...new Set([...indexes.values()].map(kindOf))].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b)), tags = [...new Set([...indexes.values()].flatMap((x) => x.tags || []))].sort();
    if (flt.kind && !kinds.includes(flt.kind)) flt.kind = ''; if (flt.tag && !tags.includes(flt.tag)) flt.tag = '';
    fkEl.innerHTML = `<option value="">すべての種類</option>${kinds.map((k) => `<option${k === flt.kind ? ' selected' : ''}>${esc(k)}</option>`).join('')}`;
    ftEl.innerHTML = `<option value="">すべてのタグ</option>${tags.map((t) => `<option value="${esc(t)}"${t === flt.tag ? ' selected' : ''}>#${esc(t)}</option>`).join('')}`;
    fsEl.value = flt.sort;
  }
  function visible() {
    let arr = files.map((file) => ({ file, ix: indexes.get(file.id) }));
    if (flt.kind) arr = arr.filter((x) => kindOf(x.ix) === flt.kind);
    if (flt.tag) arr = arr.filter((x) => (x.ix?.tags || []).includes(flt.tag));
    if (flt.q.trim()) {
      const by = new Map(arr.map((x) => [x.file.id, x]));
      return searchFiles({ files: arr.map((x) => x.file), indexes, texts: textCache }, flt.q, { limit: 200 }).map((r) => ({ ...by.get(r.file.id), where: r.where }));
    }
    const cmp = { new: (a, b) => b.file.addedAt - a.file.addedAt, old: (a, b) => a.file.addedAt - b.file.addedAt, name: (a, b) => a.file.name.localeCompare(b.file.name, 'ja'), kind: (a, b) => KINDS.indexOf(kindOf(a.ix)) - KINDS.indexOf(kindOf(b.ix)) || b.file.addedAt - a.file.addedAt, size: (a, b) => b.file.size - a.file.size }[flt.sort] || (() => 0);
    return arr.sort(cmp);
  }
  const countBit = (ix) => (ix?.pages ? `${ix.pages}ページ` : ix?.slides ? `${ix.slides}枚` : ix?.sheets?.length ? `${ix.sheets.length}シート` : '');
  function badges(ix) {
    if (!ix) return '<span class="bd w" title="中身をまだ読み取っていません">未読取</span>';
    let s = '';
    if (ix.related) s += `<span class="bd w" title="${esc(ix.related.name)} の別版かもしれません">別版かも</span>`;
    if (ix.dupOf) s += `<span class="bd w" title="${esc(ix.dupOf.name)} と同じ内容です（それでも保存しました）">同内容</span>`;
    if (ix.status === 'no_text') s += '<span class="bd w" title="文字が読み取れません（スキャン画像）">スキャン</span>';
    else if (ix.status === 'failed') s += '<span class="bd w" title="読み取りに失敗しました">読取失敗</span>';
    return s;
  }
  function renderList() {
    const rows = visible();
    listEl.innerHTML = rows.length ? rows.map(({ file: f, ix }) => {
      const tags = (ix?.tags || []).slice(0, 3).map((t) => '#' + t).join(' '), sub = [ix ? kindOf(ix) : '', countBit(ix), fmtSize(f.size), jst(f.addedAt), f.source === 'elvar-doc' ? 'E.L.V.A.R.作成' : '', tags].filter(Boolean).join('・');
      const sn = ix ? (ix.status === 'ok' ? ix.snippet : (STATUS_JA[ix.status] || '')) : '';
      return `<div class="vfl-row${f.id === selectedId ? ' sel' : ''}" data-id="${esc(f.id)}" tabindex="0" role="button"><span class="ic">${ICON[f.kind] || ICON.other}</span><span class="tx"><div class="nm" title="${esc(f.name)}">${esc(f.name)}${badges(ix)}</div><div class="sb">${esc(sub)}</div>${sn ? `<div class="sn">${esc(sn)}</div>` : ''}</span><button class="vfl-x" data-del="${esc(f.id)}" type="button" aria-label="${esc(f.name)} を削除" title="削除">✕</button></div>`;
    }).join('')
      : files.length ? '<div class="vfl-empty">条件に合うファイルはありません。</div>' : '<div class="vfl-empty">まだファイルがありません。上のボタンで取り込むか、ここにドロップしてください。</div>';
  }
  const infoRow = (k, v) => (v ? `<div class="r"><b>${k}</b><span>${v}</span></div>` : '');
  function infoPane(sel, ix) {
    if (!ix) return `<div class="vfl-info"><div class="r"><b>状態</b><span class="warn">中身をまだ読み取っていません</span></div><div class="ai"><button class="vf-btn pri" data-reindex type="button">読み取る</button></div></div>`;
    const c = classify(sel.name, sel.type), hasText = (ix.chars || 0) >= 20;
    const status = STATUS_JA[ix.status] || ix.status;
    return `<div class="vfl-info">
      <div class="r"><b>種類</b><select id="vfl-kind" aria-label="種類の名前">${KINDS.map((k) => `<option${k === kindOf(ix) ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select><span class="hint">${ix.kind ? '（' + ownerAddress() + 'が変更）自動判定：' + esc(ix.docKind) : '自動判定（推測です）'}</span></div>
      <div class="r"><b>タグ</b><input type="text" id="vfl-tags" value="${esc((ix.tags || []).join(', '))}" placeholder="カンマ区切り（例：経費, 2026）" aria-label="タグ"></div>
      <div class="r"><b>メモ</b><textarea id="vfl-memo" rows="2" placeholder="自由にメモ" aria-label="メモ">${esc(ix.memo || '')}</textarea></div>
      <div class="r"><b></b><button class="vf-btn pri" data-saveinfo="${esc(sel.id)}" type="button">タグ・メモ・種類を保存</button></div>
      <div class="r"><b>読み取り</b><span class="${ix.status === 'ok' || ix.status === 'image' ? '' : 'warn'}">${esc(status)}${ix.error ? '：' + esc(ix.error) : ''}</span></div>
      ${(ix.notes || []).map((n) => `<div class="r"><b></b><span class="hint">${esc(n)}</span></div>`).join('')}
      ${ix.title ? infoRow('題名', esc(ix.title)) : ''}
      ${infoRow('構成', esc([ix.pages ? `${ix.pages}ページ` : '', ix.slides ? `${ix.slides}枚のスライド` : '', ix.sheets?.length ? 'シート：' + ix.sheets.slice(0, 8).join('、') : '', ix.width ? `${ix.width}×${ix.height}px` : '', ix.exifDate ? `撮影日 ${ix.exifDate}` : '', ix.chars ? `約${ix.chars.toLocaleString('en-US')}字${ix.textTruncated ? '（長いため途中まで）' : ''}` : '', ix.lang && ix.lang !== 'unknown' ? LANG_JA[ix.lang] : ''].filter(Boolean).join('　／　')))}
      ${ix.headings?.length ? infoRow('見出し', esc(ix.headings.slice(0, 8).join(' ／ '))) : ''}
      ${ix.keywords?.length ? `<div class="r"><b>キーワード</b><span>${ix.keywords.map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</span></div>` : ''}
      ${infoRow('日付', esc((ix.dates || []).join('、')))}${infoRow('金額', esc((ix.amounts || []).join('、')))}
      ${ix.summary ? infoRow('冒頭', esc(ix.summary)) : ''}
      ${ix.summaryAI ? infoRow('AIの要約', esc(ix.summaryAI) + `<br><span class="hint">AIに送って作った要約です（${ix.summaryAt ? jst(ix.summaryAt) : ''}）。間違いがあるかもしれません</span>`) : ''}
      ${ix.related ? `<div class="r"><b>別版？</b><span class="warn">「${esc(ix.related.name)}」の別版かもしれません</span> <button class="vf-btn" data-gorel="${esc(ix.related.id)}" type="button">見る</button></div>` : ''}
      ${ix.dupOf ? infoRow('同内容', `「${esc(ix.dupOf.name)}」と同じ内容です`) : ''}
      ${ix.sha256 ? infoRow('識別', `<span class="hint">SHA-256 ${esc(ix.sha256.slice(0, 16))}…（同じファイルかどうかの判定に使います）</span>`) : ''}
      <div class="ai">${callAI && hasText ? '<button class="vf-btn" data-ai-sum type="button" title="文字をAIに送って要約します（承認カードが出ます）">AIで要約</button> ' : ''}${callAI && c.kind === 'image' ? '<button class="vf-btn" data-ai-ocr type="button" title="画像をAIに送って文字を読み取ります（承認カードが出ます）">AIで内容を読み取る</button> ' : ''}<button class="vf-btn" data-reindex type="button">読み取り直す</button>
        <div class="hint" style="margin-top:4px">${c.kind === 'image' ? '画像の文字は、この端末では読み取れません（OCRは使えません）。' : ''}「AIで…」は、承認したときだけ、内容をAIサービスに送ります。</div></div></div>`;
  }
  async function renderMain() {
    if (showLog) {
      const log = store.readLog();
      mainEl.innerHTML = `<div class="vfl-h"><b>印刷ログ</b><span>この端末に残る、印刷の記録です（${ownerAddress()}の答えを記録します）</span></div><div class="vfl-log">${log.length ? log.map((e) => `<div>${esc(formatLogEntry(e))}</div>`).join('') : '<div class="vf-muted">まだ記録がありません。</div>'}</div><div class="vfl-act"><button class="vf-btn" data-closelog type="button">ファイルに戻る</button>${log.length ? '<button class="vf-btn" data-clearlog type="button">ログを消す</button>' : ''}</div>`;
      return;
    }
    const sel = files.find((f) => f.id === selectedId);
    if (!sel) { setPv(null); mainEl.innerHTML = '<div class="vfl-note">ファイルを選ぶと、ここに中身が表示されます。<br>「請求書をプリントして」「履修表を探して」のように話しかけると、探して、中身を見せて、承認をいただいてから印刷します。</div>'; return; }
    const c = classify(sel.name, sel.type), rec = await record(sel.id), ix = indexes.get(sel.id);
    if (!rec) { mainEl.innerHTML = '<div class="vfl-note">ファイルの中身を読み込めませんでした。</div>'; return; }
    let pv = '', tail = '', info = `${c.label}・${fmtSize(sel.size)}・${jst(sel.addedAt)}に取り込み`;
    if (ix) info += `・${kindOf(ix)}`;
    if (tab === 'info') { setPv(null); pv = infoPane(sel, ix); }
    else if (tab === 'text') {
      setPv(null); const txt = ix ? await store.getText(sel.id) : '';
      const shown = txt.slice(0, LIMITS.previewText);
      pv = txt.trim() ? `<pre>${esc(shown)}${txt.length > shown.length ? `\n\n…（長いため、先頭の ${fmtSize(LIMITS.previewText)} だけを表示しています。全部で約${txt.length.toLocaleString('en-US')}字を読み取っています）` : ''}${ix.textTruncated ? '\n\n…（ファイルが長いため、読み取りはここまでです）' : ''}</pre>`
        : `<div class="vfl-note">${!ix ? '中身をまだ読み取っていません。「情報」タブの「読み取る」で読み取れます。' : ix.status === 'no_text' ? '文字が読み取れません（スキャン画像）。文字の層がないPDFです。この端末では、画像の文字を読み取れません。' : esc(STATUS_JA[ix.status] || '文字がありません')}${ix?.error ? '<br>' + esc(ix.error) : ''}</div>`;
    } else if (c.kind === 'text') { const d = decodeText(new Uint8Array(await rec.blob.arrayBuffer()), LIMITS.previewText); pv = `<pre>${esc(d.text)}${d.truncated ? `\n\n…（長いため、先頭の ${fmtSize(LIMITS.previewText)} だけを表示しています）` : ''}</pre>`; setPv(null); }
    else if (c.kind === 'image') pv = `<img src="${setPv(rec.blob)}" alt="${esc(sel.name)}">`;
    else if (c.kind === 'pdf') {
      const url = setPv(rec.blob), pages = ix?.pages || await pageCount(rec.blob); if (pages) info += `・${pages}ページ`;
      pv = isNative() ? '<div class="vfl-note">このアプリの画面では、PDFを埋め込んで表示できません。「ダウンロード」で端末に保存して、PDFビューアで開いてください。</div>' : `<iframe src="${url}" title="${esc(sel.name)}"></iframe>`;
      if (!isNative()) tail = '<div class="vf-muted">PDFが表示されないときは、「ダウンロード」で保存して開いてください。</div>';
    } else { setPv(null); pv = `<div class="vfl-note"><b>${esc(c.label)}のファイルです</b><br>この画面では見た目を表示できません（表示のふりはしません）。中身の文字は、「文字」タブで読めます。<br>「ダウンロード」で端末に保存し、${esc(c.label)}などのアプリで開いてください。印刷もそこから行います。</div>`; }
    const tabs = `<div class="vfl-tabs" role="tablist">${[['view', '表示'], ['text', '文字'], ['info', '情報']].map(([k, v]) => `<button type="button" role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${v}</button>`).join('')}</div>`;
    mainEl.innerHTML = `<div class="vfl-h"><b>${esc(sel.name)}</b><span>${esc(info)}</span></div>${tabs}<div class="vfl-pv">${pv}</div>${tab === 'view' ? tail : ''}<div class="vfl-act" id="vfl-act">
      <button class="vf-btn pri" data-print="${esc(sel.id)}" type="button">印刷…</button><label>部数 <input type="number" id="vfl-copies" min="1" max="${LIMITS.maxCopies}" value="1" inputmode="numeric"></label>
      <button class="vf-btn" data-dl="${esc(sel.id)}" type="button">ダウンロード</button>${ix && saveToBrain ? `<button class="vf-btn" data-brain="${esc(sel.id)}" type="button" title="種類・キーワード・要約・タグのメモ（全文ではありません）を第二の脳（プライベートなGitHub）に保存します。パスワード等が含まれていないか確認してください">第二の脳にも保存</button>` : ''}
      <span class="sp"></span><button class="vf-btn" data-del="${esc(sel.id)}" type="button">削除…</button></div><div class="vfl-conf" id="vfl-conf" hidden></div>`;
  }
  async function render() { renderList(); await renderMain(); }

  async function pageCount(blob) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try { const { PDFDocument } = await import('pdf-lib'); return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount(); }
      catch { return countPdfPagesRough(bytes); }
    } catch { return null; }
  }

  // ---------------------------------------------------------------- open / close / select
  function open({ flash = false } = {}) {
    back.classList.add('on');
    if (flash) { const d = $('vfl-drop'); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 2500); $('vfl-drop').querySelector('[data-pick]').focus({ preventScroll: true }); }
  }
  function close() { back.classList.remove('on'); setPv(null); }
  async function openLibrary({ flash = false, query = null } = {}) {
    await refresh(); showLog = false; if (selectedId && !files.some((f) => f.id === selectedId)) selectedId = null;
    if (query !== null) { flt.q = query; qEl.value = query; flt.kind = ''; flt.tag = ''; fillFilters(); if (query) await ensureTexts(); }
    open({ flash }); await render();
    autoIndexMissing().catch((e) => console.warn('[files] index', e?.message || e));
  }
  async function select(id, { tab: t = 'view' } = {}) {
    showLog = false; tab = t; await refresh(); open();
    if (id === 'lastdoc' && lastDoc) { selectedId = null; await renderTransient(await record('lastdoc')); return; }
    selectedId = id; await render();
  }

  // ---------------------------------------------------------------- download / brain
  async function download(id) {
    const rec = await record(id); if (!rec) throw new Error('ファイルを読み込めませんでした');
    if (isNative()) { const b64 = toBase64(new Uint8Array(await rec.blob.arrayBuffer())); const ok = window.ElvarAndroid.saveFile(rec.meta.name, rec.meta.type || 'application/octet-stream', b64); if (!ok) throw new Error('保存できませんでした'); return '端末の「ダウンロード」に保存しました'; }
    const url = URL.createObjectURL(rec.blob), a = document.createElement('a'); a.href = url; a.download = rec.meta.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'ダウンロードしました';
  }
  /** 「第二の脳にも保存」: a summary note (title, kind, keywords, snippet/summary, tags) under ファイル/ — not the full text (a short text file is the one exception). An own-record write, so no approval card. */
  async function toBrain(id) {
    if (!saveToBrain) return { ok: false, message: '第二の脳は使えません' };
    const meta = files.find((f) => f.id === id), ix = indexes.get(id); if (!meta) return { ok: false, message: 'ファイルを読み込めませんでした' };
    if (!ix) return { ok: false, message: '中身をまだ読み取っていないため、保存できません（「情報」タブの「読み取る」を先に）' };
    const text = ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json'].includes(ix.ext) ? await store.getText(id) : '';
    const note = indexNote(meta, ix, { text });
    if (note.tooLong) return { ok: false, message: 'メモが長すぎて保存できません（約2万字まで）' };
    const replace = ix.brainPath === note.path;
    const r = await saveToBrain({ path: note.path, content: note.content, replace });
    if (r.ok) { const next = await store.patchIndex(id, { brainPath: note.path, brainSavedAt: Date.now() }); indexes.set(id, next); }
    else if (/すでに存在/.test(r.message || '')) return { ok: false, message: `第二の脳に、同じ名前のノートがすでにあります（${note.path}）。別のファイルのノートかもしれないため、上書きしていません` };
    return r;
  }

  // ---------------------------------------------------------------- tags / memo / kind (a local edit of the owner's own data)
  async function tagFile(id, { tags, memo, kind } = {}) {
    const ix = indexes.get(id); if (!ix) return { ok: false, error: 'このファイルは、まだ中身を読み取っていないため、タグを付けられません' };
    const patch = {};
    if (tags !== undefined) patch.tags = normTags(tags);
    if (memo !== undefined) patch.memo = String(memo).slice(0, 1000);
    if (kind !== undefined) { const k = String(kind).trim(); if (k && !KINDS.includes(k)) return { ok: false, error: `種類は ${KINDS.join('・')} のどれかです` }; patch.kind = k === ix.docKind ? '' : k; }
    const next = await store.patchIndex(id, patch); indexes.set(id, next); dfCache = null;
    fillFilters(); await render();
    return { ok: true, tags: next.tags || [], memo: next.memo || '', kind: kindOf(next) };
  }

  /** Ask on an approval card at the bottom while keeping the preview clear of it (same trick as the print card). */
  async function askBottom(spec) {
    back.classList.add('printing');
    requestAnimationFrame(() => { const h = document.querySelector('.va-back.bottom .va-panel')?.getBoundingClientRect().height; if (h) back.style.setProperty('--vfl-pad', Math.ceil(h + 26) + 'px'); });
    try { return await approval.ask({ ...spec, placement: 'bottom' }); } finally { back.classList.remove('printing'); }
  }

  // ---------------------------------------------------------------- reading to the model / AI summary / AI image reading (each one an approval card)
  async function readFile(id, { part = 1, approvalId } = {}) {
    const meta = files.find((f) => f.id === id); if (!meta) return { status: 'notfound' };
    const ix = indexes.get(id);
    if (!ix) return { status: 'not_indexed', name: meta.name, note: 'このファイルの中身は、まだこの端末で読み取っていません。画面の「情報」タブの「読み取る」を押してもらってください。中身は分かりません' };
    selectedId = id; tab = 'text'; open(); await render();
    const out = await gatedRead({
      file: meta, ix, part, granted: readGrants, load: () => store.getText(id),
      ask: (lines) => askBottom({ id: approvalId || 'fileread:' + id + ':' + Date.now(), tool: 'file_read', summary: lines, danger: 'high', voice: true, yes: '読ませる', no: 'やめる', title: 'AIに読ませる確認' }),
    });
    return out;
  }
  async function aiSummarize(id) {
    const meta = files.find((f) => f.id === id), ix = indexes.get(id); if (!callAI || !meta || !ix) return { ok: false, message: 'AIは使えません' };
    const text = (await store.getText(id)).trim(); if (text.length < 20) return { ok: false, message: '要約できる文章がありません' };
    const sent = text.slice(0, 12000);
    const ok = await askBottom({ id: 'aisum:' + id + ':' + Date.now(), tool: 'file_ai_summary', summary: [`「${meta.name}」をAIに要約してもらいます`, `送るもの：このファイルの文字（${sent.length.toLocaleString('en-US')}字${text.length > sent.length ? '。長いので先頭だけ' : ''}）`, '送り先：AIサービス（Gemini など。使えないときは別のAIサービス）', '※ 承認するまでは、何も送りません。要約はこの端末に保存します。'], danger: 'high', voice: true, yes: '送って要約する', no: 'やめる', title: 'AIに送る確認' });
    if (ok !== true) return { ok: false, message: 'やめました（何も送っていません）' };
    const r = await callAI({ action: 'file_summarize', name: meta.name, text: sent });
    if (!r?.summary) return { ok: false, message: r?.error || '要約できませんでした' };
    const next = await store.patchIndex(id, { summaryAI: r.summary, summaryAt: Date.now() }); indexes.set(id, next); await render();
    return { ok: true, message: 'AIの要約を保存しました' };
  }
  async function aiReadImage(id) {
    const meta = files.find((f) => f.id === id), ix = indexes.get(id); if (!callAI || !meta || !ix) return { ok: false, message: 'AIは使えません' };
    const rec = await record(id); if (!rec) return { ok: false, message: 'ファイルを読み込めませんでした' };
    let sm; try { sm = await shrinkImage(rec.blob); } catch (e) { return { ok: false, message: String(e?.message || e) }; }
    const ok = await askBottom({ id: 'aiocr:' + id + ':' + Date.now(), tool: 'file_ai_ocr', summary: [`「${meta.name}」の文字をAIに読み取ってもらいます`, `送るもの：この画像（${sm.w}×${sm.h}px に縮小したもの、約${fmtSize(sm.blob.size)}）`, '送り先：AIサービス（Gemini）。写っているものはすべてAIに渡ります', '※ 承認するまでは、何も送りません。読み取った文字はこの端末に保存します（間違いがあるかもしれません）。'], danger: 'high', voice: true, yes: '送って読み取る', no: 'やめる', title: 'AIに送る確認' });
    if (ok !== true) return { ok: false, message: 'やめました（何も送っていません）' };
    const r = await callAI({ action: 'file_ocr', image: await blobToBase64(sm.blob), mime: 'image/jpeg' });
    if (!r?.text) return { ok: false, message: r?.error || '読み取れませんでした' };
    const rebuilt = buildIndex({ text: r.text, status: 'ok', width: ix.width, height: ix.height, exifDate: ix.exifDate, notes: ['AIが読み取った文字です（間違いがあるかもしれません）'] }, { name: meta.name, ext: ix.ext, size: meta.size, sha256: ix.sha256, ...(() => { const { df, n } = docFreq(); return { docFreq: df, docCount: n }; })() });
    const index = { ...rebuilt.index, tags: ix.tags || [], memo: ix.memo || '', kind: ix.kind || '', ocrAI: true, related: ix.related || null, summaryAI: ix.summaryAI, summaryAt: ix.summaryAt, brainPath: ix.brainPath };
    await store.putIndex(id, index, rebuilt.text); indexes.set(id, index); textCache = null; tab = 'text'; await render();
    return { ok: true, message: 'AIが読み取った文字を保存しました（「文字」タブ）' };
  }

  // ---------------------------------------------------------------- delete (screen button -> inline confirm; voice -> approval card)
  async function removeFile(id) { await store.remove(id); readGrants.delete(id); indexes.delete(id); textCache = null; dfCache = null; if (selectedId === id) selectedId = null; if (lastDocSavedId === id) lastDocSavedId = null; await refresh(); await render(); }
  async function confirmDeleteInline(id) {
    const f = files.find((x) => x.id === id); if (!f) return;
    const conf = back.querySelector('#vfl-conf');
    const target = conf && selectedId === id ? conf : null;
    if (!target) { selectedId = id; await render(); return confirmDeleteInline(id); }
    target.hidden = false; target.innerHTML = `<span>「${esc(f.name)}」をこの端末から削除します。元に戻せません。</span><button class="vf-btn" data-delyes="${esc(id)}" type="button">削除する</button><button class="vf-btn" data-delno type="button">やめる</button>`;
    target.querySelector('[data-delno]').focus();
  }
  async function requestDelete(id, approvalId) {
    const f = files.find((x) => x.id === id); if (!f) return { status: 'notfound' };
    selectedId = id; open(); await render();
    const ok = await approval.ask({ id: approvalId || 'filedel:' + id, tool: 'file_delete', summary: [`「${f.name}」を削除します`, `種類：${classify(f.name, f.type).label}　サイズ：${fmtSize(f.size)}`, 'この端末のファイル一覧から消えます。元に戻せません。'], danger: 'high', voice: true, yes: '削除する', no: 'やめる', title: '削除の確認' });
    if (ok !== true) return { status: 'declined' };
    await removeFile(id); return { status: 'deleted', name: f.name };
  }

  // ---------------------------------------------------------------- print
  function dropFrame() { clearTimeout(pfTimer); if (pf) { pf.remove(); pf = null; } }
  const waitFor = (target, ev, ms) => new Promise((res) => { let d = false; const fin = (v) => { if (d) return; d = true; target.removeEventListener(ev, h); clearTimeout(t); res(v); }; const h = () => fin(true); const t = setTimeout(() => fin(false), ms); target.addEventListener(ev, h); });

  /** Opens the print dialog on an isolated hidden frame. Resolves once the dialog closed (or an error). The page cannot know whether anything was printed. */
  async function printFrame(rec, copies) {
    const mode = printMode(rec.meta);
    dropFrame(); pf = document.createElement('iframe'); pf.className = 'vfl-pf'; pf.setAttribute('aria-hidden', 'true'); pf.tabIndex = -1; document.body.appendChild(pf);
    let note = '';
    if (mode === 'pdf') {
      let blob = rec.blob;
      if (copies > 1) {
        try { const { PDFDocument } = await import('pdf-lib'); const src = await PDFDocument.load(new Uint8Array(await rec.blob.arrayBuffer()), { ignoreEncryption: true }), out = await PDFDocument.create(), idx = src.getPageIndices();
          for (let i = 0; i < copies; i++) for (const p of await out.copyPages(src, idx)) out.addPage(p);
          blob = new Blob([await out.save()], { type: 'application/pdf' });
        } catch { note = '部数を指定して作れなかったため、1部分だけ開きました。部数はプリンターのダイアログで指定してください。'; }
      }
      const url = URL.createObjectURL(blob); setTimeout(() => URL.revokeObjectURL(url), 10 * 60e3);
      const loaded = waitFor(pf, 'load', 15000); pf.src = url; await loaded; await sleep(500);
    } else {
      let html;
      if (mode === 'text') { const d = decodeText(new Uint8Array(await rec.blob.arrayBuffer()), LIMITS.printText); html = textPrintHtml(rec.meta.name, d.text, copies); }
      else { const url = URL.createObjectURL(rec.blob); setTimeout(() => URL.revokeObjectURL(url), 10 * 60e3); html = imagePrintHtml(rec.meta.name, url, copies); }
      const loaded = waitFor(pf, 'load', 15000); pf.srcdoc = html; await loaded;
      if (mode === 'image') { const imgs = [...(pf.contentDocument?.images || [])]; await Promise.race([Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })))), sleep(8000)]); }
    }
    const win = pf.contentWindow; if (!win) throw new Error('印刷用の枠を作れませんでした');
    const after = new Promise((res) => { let d = false; const fin = () => { if (d) return; d = true; try { win.removeEventListener('afterprint', fin); } catch {} removeEventListener('afterprint', fin); res(); }; try { win.addEventListener('afterprint', fin); } catch {} addEventListener('afterprint', fin); setTimeout(fin, 20000); });
    try { win.focus(); win.print(); }
    catch (e) {
      // The print frame did not work (some PDF viewers): open the file itself so the owner can press Ctrl+P there.
      const u = URL.createObjectURL(rec.blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 10 * 60e3);
      return { opened: true, note: 'このブラウザでは直接の印刷を始められなかったため、ファイルを別のタブで開きました。そこで Ctrl+P（印刷）を押してください。' };
    }
    await after;   // afterprint also fires when the owner cancelled: it only means "the dialog is gone"
    pfTimer = setTimeout(dropFrame, 60000);
    return { note };
  }

  /**
   * The whole flow. Nothing is printed unless the approval card returns exactly `true`.
   * @returns {Promise<{status:'declined'|'busy'|'notfound'|'saved'|'dialog_closed'|'error', ...}>}
   */
  async function requestPrint(id, { copies = 1, approvalId } = {}) {
    if (printing) return { status: 'busy' };
    printing = true; copies = clampCopies(copies);
    try {
      const rec = await record(id); if (!rec) return { status: 'notfound' };
      const meta = rec.meta, mode = printMode(meta);
      if (meta.transient) await refresh();
      selectedId = meta.transient ? null : meta.id; showLog = false; tab = 'view'; open();
      if (meta.transient) { await renderTransient(rec); } else await render();
      const pages = meta.kind === 'pdf' ? (indexes.get(meta.id)?.pages || await pageCount(rec.blob)) : null;
      const canPrint = !isNative() && typeof window.print === 'function';
      const truncatedAt = mode === 'text' && meta.size > LIMITS.printText ? LIMITS.printText : 0;
      const lines = approvalLines(meta, { copies, pages, truncatedAt, canPrint });
      back.classList.add('printing');
      requestAnimationFrame(() => { const h = document.querySelector('.va-back.bottom .va-panel')?.getBoundingClientRect().height; if (h) back.style.setProperty('--vfl-pad', Math.ceil(h + 26) + 'px'); });   // keep the preview clear of the card
      const ok = await approval.ask({ id: approvalId || 'print:' + meta.id + ':' + Date.now(), tool: 'print_file', summary: lines, voice: true, yes: mode === 'download' || !canPrint ? '保存する' : '印刷する', no: 'やめる', title: '印刷の確認', placement: 'bottom' });
      back.classList.remove('printing');
      if (ok !== true) return { status: 'declined', file: meta.name };
      // ---- approved
      if (mode === 'download' || !canPrint) {
        try { const m = await download(meta.id); const log = store.appendLog({ file: meta.name, outcome: 'saved', copies }); void log; say(m + '。印刷は、保存したファイルを開いて行ってください'); onActivity({ icon: 'doc', title: 'ファイルを保存（印刷用）', sub: meta.name }); await renderLogIfOpen(); return { status: 'saved', file: meta.name, note: '承認のあと、端末に保存しました。印刷は、保存したファイルを開いて、' + ownerAddress() + 'が行います（ここからは印刷できません）。印刷したとは言わないでください' }; }
        catch (e) { return { status: 'error', error: String(e?.message || e) }; }
      }
      let r;
      try { r = await printFrame(rec, copies); } catch (e) { return { status: 'error', error: `印刷を始められませんでした：${e?.message || e}` }; }
      const entry = store.appendLog({ file: meta.name, outcome: 'unknown', copies }); const logId = entry[0].id;
      onActivity({ icon: 'doc', title: '印刷ダイアログを開きました', sub: meta.name });
      askDidItPrint({ meta, copies, logId, opened: !!r.opened, note: r.note });
      return { status: r.opened ? 'opened_in_tab' : 'dialog_closed', file: meta.name, copies, note: (r.opened ? 'ファイルを別のタブで開きました。' : '印刷ダイアログが閉じました。') + '印刷できたかどうかは、こちらでは分かりません（キャンセルされた場合も同じ通知になります）。画面に「印刷できましたか？」と確認を出しています。' + ownerAddress() + 'が「印刷できた」と答えるまで、印刷が終わったとは言わないでください。短く「印刷できましたか？」と尋ねてください' };
    } finally { printing = false; back.classList.remove('printing'); }
  }
  async function renderTransient(rec) {   // the document ELVAR just made (not saved yet): show it in the preview pane
    renderList(); const url = setPv(rec.blob), pages = await pageCount(rec.blob), c = classify(rec.meta.name, rec.meta.type);
    mainEl.innerHTML = `<div class="vfl-h"><b>${esc(rec.meta.name)}</b><span>${esc(c.label)}・${fmtSize(rec.meta.size)}${pages ? `・${pages}ページ` : ''}・E.L.V.A.R.が作成（まだライブラリには保存していません）</span></div><div class="vfl-pv">${isNative() ? '<div class="vfl-note">このアプリの画面では、PDFを埋め込んで表示できません。</div>' : `<iframe src="${url}" title="${esc(rec.meta.name)}"></iframe>`}</div>`;
  }
  const renderLogIfOpen = async () => { if (showLog) await renderMain(); };

  // ---------------------------------------------------------------- "did it print?" card
  function askDidItPrint({ meta, copies, logId, opened, note }) {
    pendingConfirm = { meta, copies, logId, failed: false };
    const draw = () => {
      const c = pendingConfirm; if (!c) { ask.classList.remove('on'); return; }
      ask.innerHTML = c.failed
        ? `<h3>PRINT</h3><div class="q">印刷できなかったのですね。次を確認してみてください</div><ul>${TROUBLESHOOT.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><div class="b"><button class="go" data-again type="button">もう一度印刷する</button><button data-done type="button">閉じる</button></div>`
        : `<h3>PRINT</h3><div class="q">印刷できましたか？</div><div style="font-size:13px;color:#cfeeff;margin-top:2px">「${esc(c.meta.name)}」${opened ? '（別のタブで開きました）' : '（印刷ダイアログを閉じました）'}。<br>こちらでは、実際に印刷されたかどうかは分かりません（キャンセルした場合も同じ通知になります）。結果を教えてください。${note ? `<br>※ ${esc(note)}` : ''}</div><div class="b"><button class="go" data-ok type="button">印刷できた</button><button data-ng type="button">できなかった</button></div>`;
      ask.classList.add('on'); ask.querySelector('button')?.focus({ preventScroll: true });
    };
    pendingConfirm.draw = draw; draw();
  }
  async function answerPrint(outcome, via) {
    const c = pendingConfirm; if (!c) return;
    store.updateLog(c.logId, outcome);
    onActivity({ icon: 'doc', title: outcome === 'printed' ? '印刷できた' : '印刷できなかった', sub: c.meta.name });
    if (outcome === 'printed') { pendingConfirm = null; ask.classList.remove('on'); say(`「${c.meta.name}」の印刷を記録しました`); }
    else { c.failed = true; c.draw(); }
    if (via === 'button') { try { sendText(outcome === 'printed' ? '印刷できた' : '印刷できなかった'); } catch {} }   // a button = the owner's typed answer
    await renderLogIfOpen();
  }
  ask.addEventListener('click', (e) => {
    if (e.target.closest('[data-ok]')) answerPrint('printed', 'button');
    else if (e.target.closest('[data-ng]')) answerPrint('failed', 'button');
    else if (e.target.closest('[data-done]')) { pendingConfirm = null; ask.classList.remove('on'); }
    else if (e.target.closest('[data-again]')) { const c = pendingConfirm; pendingConfirm = null; ask.classList.remove('on'); if (c) requestPrint(c.meta.id, { copies: c.copies }).catch((err) => say(String(err?.message || err), true)); }
  });

  // ---------------------------------------------------------------- events
  const aiRun = async (btn, fn) => { btn.disabled = true; say('AIに送る確認を出しています…'); try { const r = await fn(); say(r.message, !r.ok); } catch (err) { say(String(err?.message || err), true); } btn.disabled = false; };
  back.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === back || t.closest('[data-x]')) { close(); return; }
    if (t.closest('[data-pick]')) { input.click(); return; }
    if (t.closest('[data-cancel]')) { batchCancelled = true; running?.cancel(); say('キャンセルしています…'); return; }
    const dk = t.closest('[data-dupkeep]'); if (dk) { await keepDuplicate(Number(dk.dataset.dupkeep)); return; }
    const ds = t.closest('[data-dupskip]'); if (ds) { skipDuplicate(Number(ds.dataset.dupskip)); return; }
    if (t.closest('[data-showlog]')) { showLog = !showLog; await renderMain(); return; }
    if (t.closest('[data-closelog]')) { showLog = false; await render(); return; }
    if (t.closest('[data-clearlog]')) { store.clearLog(); await renderMain(); return; }
    const tb = t.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; await renderMain(); return; }
    const si = t.closest('[data-saveinfo]'); if (si) { const r = await tagFile(si.dataset.saveinfo, { tags: back.querySelector('#vfl-tags')?.value ?? '', memo: back.querySelector('#vfl-memo')?.value ?? '', kind: back.querySelector('#vfl-kind')?.value }); say(r.ok ? '保存しました（この端末の中だけ）' : r.error, !r.ok); return; }
    const gr = t.closest('[data-gorel]'); if (gr) { await select(gr.dataset.gorel, { tab: 'info' }); return; }
    const ri = t.closest('[data-reindex]'); if (ri) { ri.disabled = true; say('読み取っています…'); await reanalyse(selectedId); ri.disabled = false; return; }
    const as = t.closest('[data-ai-sum]'); if (as) { await aiRun(as, () => aiSummarize(selectedId)); return; }
    const ao = t.closest('[data-ai-ocr]'); if (ao) { await aiRun(ao, () => aiReadImage(selectedId)); return; }
    const del = t.closest('[data-del]'); if (del) { e.stopPropagation(); await confirmDeleteInline(del.dataset.del); return; }
    const yes = t.closest('[data-delyes]'); if (yes) { await removeFile(yes.dataset.delyes); say('削除しました'); return; }
    if (t.closest('[data-delno]')) { const c = back.querySelector('#vfl-conf'); if (c) c.hidden = true; return; }
    const pr = t.closest('[data-print]'); if (pr) { const copies = clampCopies(back.querySelector('#vfl-copies')?.value); requestPrint(pr.dataset.print, { copies }).then((r) => { if (r.status === 'declined') say('印刷をやめました（何も印刷していません）'); else if (r.status === 'error') say(r.error, true); else if (r.status === 'busy') say('いま、別の印刷の確認中です', true); }).catch((err) => say(String(err?.message || err), true)); return; }
    const dl = t.closest('[data-dl]'); if (dl) { try { say(await download(dl.dataset.dl)); } catch (err) { say(String(err?.message || err), true); } return; }
    const br = t.closest('[data-brain]'); if (br) { br.disabled = true; say('第二の脳に保存しています…'); try { const r = await toBrain(br.dataset.brain); say(r.message, !r.ok); } catch (err) { say(String(err?.message || err), true); } br.disabled = false; return; }
    const row = t.closest('.vfl-row'); if (row) await select(row.dataset.id, { tab });
  });
  back.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('vfl-row')) { e.preventDefault(); select(e.target.dataset.id, { tab }); } });
  let qTimer = 0;
  qEl.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(async () => { flt.q = qEl.value; if (flt.q.trim()) await ensureTexts(); renderList(); }, 150); });
  fkEl.addEventListener('change', () => { flt.kind = fkEl.value; renderList(); });
  ftEl.addEventListener('change', () => { flt.tag = ftEl.value; renderList(); });
  fsEl.addEventListener('change', () => { flt.sort = fsEl.value; renderList(); });
  input.addEventListener('change', async () => { const l = [...input.files]; input.value = ''; await importFiles(l, 'picker'); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on') && !ask.classList.contains('on')) { e.stopImmediatePropagation(); close(); } }, true);

  // drag & drop anywhere on the HUD, and paste of files
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; dz.classList.add('on'); $('vfl-drop').classList.add('hot'); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { dz.classList.remove('on'); $('vfl-drop').classList.remove('hot'); } });
  addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; dz.classList.remove('on'); $('vfl-drop').classList.remove('hot'); importFiles(e.dataTransfer.files, 'drop').catch((err) => say(String(err?.message || err), true)); });
  addEventListener('paste', (e) => {
    const fs = [...(e.clipboardData?.files || [])]; if (!fs.length) return;
    const tag = (e.target?.tagName || '').toLowerCase(); if (tag === 'input' && e.target.type !== 'file' || tag === 'textarea' || e.target?.isContentEditable) return;   // text fields keep their own paste
    e.preventDefault();
    const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const named = fs.map((f, i) => (!f.name || /^image\.\w+$/i.test(f.name) ? new File([f], `貼り付け-${stamp}${fs.length > 1 ? '-' + (i + 1) : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }) : f));
    importFiles(named, 'paste').catch((err) => say(String(err?.message || err), true));
  });

  return {
    el: back, open: openLibrary, close, importFiles, select, requestPrint, requestDelete, refresh, download, toBrain, readFile, tagFile, reanalyse,
    /** The files ELVAR knows by name (for matching), including the last made document. The extracted texts are loaded here so matching and searching can use them. */
    async candidates() { await refresh(); await ensureTexts(); return allFiles(); },
    match(query) { return matchFiles(allFiles(), query, { lastDocId: lastDocId(), indexes, texts: textCache }); },
    /** Local search. The caller decides what goes to the model (see searchResultForModel in file-index.js: names, kinds and short snippets only). */
    async search(query) { await refresh(); await ensureTexts(); return searchFiles({ files, indexes, texts: textCache }, query, { limit: 8 }); },
    indexOf: (id) => indexes.get(id) || null,
    detail: (items) => choiceDetail(items, indexes, 250),
    get selectedId() { return selectedId; },
    get isOpen() { return back.classList.contains('on'); },
    get lastDocumentId() { return lastDocId(); },
    get count() { return files.length; },
    get busy() { return printing; },
    /** The document ELVAR just made: printable by name even before it is saved. */
    setLastDocument({ name, bytes }) { lastDoc = { name, bytes, at: Date.now() }; lastDocSavedId = null; },
    /** Save that PDF into the library (the 資料 card's button). */
    async saveDocument({ name, bytes }) {
      await refresh(); const used = files.reduce((s, f) => s + (f.size || 0), 0), n = safeName(name), q = checkQuota({ name: n, size: bytes.length, used, deviceFree: space ? space.free : null });
      if (!q.ok) return { ok: false, message: q.reason };
      const blob = new Blob([bytes], { type: 'application/pdf' });
      let an = null; try { an = await analyse(blob, n, 'application/pdf', { name: n }); } catch { /* saved without a memory; it is read later */ }
      const meta = { id: uid(), name: n, type: 'application/pdf', kind: 'pdf', size: bytes.length, addedAt: Date.now(), source: 'elvar-doc' };
      await store.put(meta, blob, an?.index || null, an?.text || '');
      if (lastDoc && lastDoc.name === name) lastDocSavedId = meta.id;
      await refresh(); if (back.classList.contains('on')) await render();
      onActivity({ icon: 'doc', title: '資料をファイルに保存', sub: n });
      return { ok: true, message: 'ファイルに保存しました（この端末の中だけ）', id: meta.id };
    },
    /** A spoken answer to 「印刷できましたか？」. Ignored while the assistant is talking (its own echo must not answer). */
    hear(text, { modelBusy = false } = {}) {
      if (!pendingConfirm || pendingConfirm.failed || modelBusy) return false;
      const r = classifyReply(text);
      if (r === 'yes') { answerPrint('printed', 'voice'); return true; }
      if (r === 'no') { answerPrint('failed', 'voice'); return true; }
      return false;
    },
    get confirmOpen() { return !!pendingConfirm; },
    log: () => store.readLog(),
  };
}
