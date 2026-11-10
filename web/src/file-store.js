// The ファイル library's storage, since the multi-user platform (docs/ELVAR_MULTIUSER.md 3.3, 8.2; principles 4 and 6): the account's own vault on the server.
//   originals   Supabase Storage (users/<uid>/...), uploaded straight from this page with the user's OWN access token (Storage checks the live reservation on every
//               write; there is no signed upload link to hold): reserve -> POST -> finalize
//   the memory  keywords, kind, tags, memo, version mark, the extracted text: the database (read here by the Worker, sent at finalize; searched on the server)
//   this device IndexedDB `elvar-files-cache` is only a CACHE of what the account already has: the originals used last (200 MB), and the last list for reading
//               when offline. The shim of web/public/ns.js gives it a per-user name and web/src/elvar/local.js erases it at sign-out / when another person signs in.
// The object that createFileStore() returns has the same methods the screen always used (list, get, blob, put, remove, indexes, getText, putIndex, patchIndex...),
// so the screen and the tools did not have to change shape. The print log stays on the device (a convenience, per user through ns.js).
import { addLog, LIMITS } from './file-lib.js';
import { sha256Hex } from './file-index.js';
import { toColumns, indexOf, metaOf } from '../../shared/file-record.js';

export const CACHE_BYTES = 200 * 1024 * 1024;
/** The most extracted text one file keeps in the account: with Japanese at 3 bytes a character that is about 3.9 MB, which keeps the request under the 4.5 MB a serverless function accepts. */
export const TEXT_MAX_CHARS = 1_300_000;
const TEXT_CUT_NOTE = '長いため、先頭の約130万字だけをアカウントに保存しました';
export const capText = (t) => { if (t.length <= TEXT_MAX_CHARS) return t; let s = t.slice(0, TEXT_MAX_CHARS); const c = s.charCodeAt(s.length - 1); if (c >= 0xd800 && c <= 0xdbff) s = s.slice(0, -1); return s; };
const DB = 'elvar-files-cache', V = 1, FRESH_MS = 4000;
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('IndexedDB error')); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('IndexedDB error')); tx.onabort = () => rej(tx.error || new Error('IndexedDB aborted')); });

/** An error with the server's own (Japanese) message, its code and the whole answer. */
export function apiError(r, fallback = 'サーバーとの通信に失敗しました') {
  const e = new Error(r?.body?.message || fallback);
  e.code = r?.body?.error || 'error'; e.status = r?.status; e.body = r?.body;
  return e;
}

/** POST a Blob to Storage with the user's own access token (`headers()` gives the Authorization header), with real progress (fetch cannot report upload progress) and cancel. */
export function xhrUpload(upload, blob, { onProgress, signal, headers = () => ({}) } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(upload.method || 'POST', upload.url);
    for (const [k, v] of Object.entries(upload.headers || {})) x.setRequestHeader(k, v);
    if (upload.userToken) for (const [k, v] of Object.entries(headers() || {})) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.({ stage: 'アップロード中', done: e.loaded, total: e.total }); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(Object.assign(new Error(x.status === 403 ? 'アップロードの有効時間が過ぎたか、取り消されました。もう一度取り込んでください' : x.status === 413 ? 'ファイルが大きすぎて、保存先に受け付けられませんでした' : `アップロードできませんでした（${x.status}）`), { code: 'upload_failed', status: x.status })));
    x.onerror = () => reject(Object.assign(new Error('アップロードできませんでした。ネットワークを確認して、もう一度お試しください'), { code: 'upload_failed' }));
    x.onabort = () => reject(Object.assign(new Error('中止しました'), { cancelled: true }));
    if (signal) { if (signal.aborted) { x.abort(); return; } signal.addEventListener('abort', () => x.abort(), { once: true }); }
    x.send(blob);
  });
}

/**
 * @param {{ api: (path:string, o?:{method?:string, body?:any}) => Promise<{status:number, body:any}>, idb?: IDBFactory, storage?: Storage, authHeaders?: () => object,
 *           upload?: typeof xhrUpload, download?: (url:string) => Promise<Blob>, now?: () => number }} o
 */
export function createFileStore({ api, idb = globalThis.indexedDB, storage = globalThis.localStorage, authHeaders = () => ({}), upload = xhrUpload, download = null, now = () => Date.now() }) {
  if (typeof api !== 'function') throw new Error('createFileStore needs api');
  let dbp = null, files = null, usage = null, loadedAt = 0, dirty = true, offline = false, savedSnap = '';
  const texts = new Map();   // id -> extracted text (this page only)
  const dl = download || (async (url) => { const r = await fetch(url, { credentials: 'omit', cache: 'no-store' }); if (!r.ok) throw Object.assign(new Error('ファイルを取得できませんでした'), { status: r.status }); return r.blob(); });

  // ---------------------------------------------------------------- the cache (IndexedDB; never the source of truth)
  const open = () => dbp ??= new Promise((res, rej) => {
    if (!idb) return rej(new Error('no IndexedDB'));
    const r = idb.open(DB, V);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); if (!d.objectStoreNames.contains('cmeta')) d.createObjectStore('cmeta', { keyPath: 'id' }); if (!d.objectStoreNames.contains('snap')) d.createObjectStore('snap'); };
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error || new Error('cache unavailable')); };
  });
  const cache = {
    async get(id) {
      try {
        const d = await open(), b = await req(d.transaction('blobs').objectStore('blobs').get(id)); if (!b) return null;
        const m = await req(d.transaction('cmeta').objectStore('cmeta').get(id)); if (m) { const tx = d.transaction('cmeta', 'readwrite'); tx.objectStore('cmeta').put({ ...m, at: now() }); await done(tx); }   // used just now: last to be dropped
        return b;
      } catch { return null; }
    },
    async put(id, blob) {
      try {
        if (blob.size > CACHE_BYTES / 2) return;
        const d = await open(), metas = await req(d.transaction('cmeta').objectStore('cmeta').getAll());
        let used = metas.reduce((s, m) => s + m.size, 0); const drop = [];
        for (const m of metas.sort((a, b) => a.at - b.at)) { if (used + blob.size <= CACHE_BYTES) break; drop.push(m.id); used -= m.size; }   // least recently used first
        const tx = d.transaction(['blobs', 'cmeta'], 'readwrite');
        for (const k of drop) { tx.objectStore('blobs').delete(k); tx.objectStore('cmeta').delete(k); }
        tx.objectStore('blobs').put(blob, id); tx.objectStore('cmeta').put({ id, size: blob.size, at: now() });
        await done(tx);
      } catch { /* the cache is optional */ }
    },
    async del(ids) { try { const d = await open(), tx = d.transaction(['blobs', 'cmeta'], 'readwrite'); for (const id of ids) { tx.objectStore('blobs').delete(id); tx.objectStore('cmeta').delete(id); } await done(tx); } catch { /* ignore */ } },
    async saveSnap(v) { try { const d = await open(), tx = d.transaction('snap', 'readwrite'); tx.objectStore('snap').put(v, 'list'); await done(tx); } catch { /* ignore */ } },
    async loadSnap() { try { const d = await open(); return (await req(d.transaction('snap').objectStore('snap').get('list'))) || null; } catch { return null; } },
  };

  // ---------------------------------------------------------------- the list (the server's, remembered for a moment)
  async function reload() {
    let r;
    try { r = await api('/api/elvar/files'); }
    catch {   // no network: the last list this device saw, read only
      const snap = await cache.loadSnap();
      if (!snap) throw Object.assign(new Error('サーバーに接続できません。ネットワークを確認してください'), { code: 'offline' });
      files = snap.files; usage = snap.usage; offline = true; loadedAt = now(); dirty = false; return files;
    }
    if (r.status !== 200) throw apiError(r, 'ファイルの一覧を読み込めませんでした');
    files = r.body.files; usage = r.body.usage; offline = false; loadedAt = now(); dirty = false;
    const snap = JSON.stringify({ n: files.length, at: files[0]?.updatedAt, u: usage.usedBytes });
    if (snap !== savedSnap) { savedSnap = snap; cache.saveSnap({ files, usage }); }
    const keep = new Set(files.map((f) => f.id)); for (const id of [...texts.keys()]) if (!keep.has(id)) texts.delete(id);
    return files;
  }
  const ensure = async () => { if (!files || dirty || now() - loadedAt > FRESH_MS) await reload(); return files; };
  const writable = () => { if (offline) throw Object.assign(new Error('オフラインのため、変更できません（読み取り専用です）'), { code: 'offline' }); };
  const row = (id) => files?.find((f) => f.id === id) || null;
  const replace = (f) => { if (!files) return; const i = files.findIndex((x) => x.id === f.id); if (i >= 0) files[i] = f; else files.unshift(f); };

  return {
    // ---- reading
    /** All files, newest first, in the shape the screen keeps (id, name, type, kind, size, addedAt, source). */
    async list() { await ensure(); return files.map(metaOf).sort((a, b) => b.addedAt - a.addedAt); },
    /** Force a fresh read (after the account changed somewhere else) and return the usage numbers too. */
    async reload() { await reload(); return { files: files.map(metaOf), usage }; },
    /** What the account is using (bytes), the limit, and the per-file limit: the server's numbers. */
    async usage() { await ensure(); return usage; },
    get offline() { return offline; },
    async get(id) { await ensure(); const f = row(id); return f ? metaOf(f) : undefined; },
    /** The original. From this device's cache when it is there, otherwise downloaded through a short-lived signed link (and cached). Typed by what the server knows, never by what Storage says. */
    async blob(id) {
      await ensure(); const f = row(id); if (!f) return undefined;
      const hit = await cache.get(id); if (hit) return new Blob([hit], { type: f.mime });
      const d = await api(`/api/elvar/files/${id}/download`); if (d.status !== 200) throw apiError(d, 'ファイルを取得できませんでした');
      const b = await dl(d.body.url); if (b.size !== f.size) throw new Error('取得したファイルの大きさが一致しません。もう一度お試しください');
      const typed = new Blob([b], { type: f.mime }); cache.put(id, typed); return typed;
    },
    /** @returns {Promise<Map<string, object>>} id -> index record (the memory of each file) */
    async indexes() { await ensure(); return new Map(files.map((f) => [f.id, indexOf(f)])); },
    async getIndex(id) { await ensure(); const f = row(id); return f ? indexOf(f) : undefined; },
    async getText(id) {
      if (texts.has(id)) return texts.get(id);
      const r = await api(`/api/elvar/files/${id}/text`); if (r.status !== 200) return '';
      texts.set(id, r.body.text || ''); return texts.get(id);
    },
    /** The texts stay on the server and are searched there: nothing is loaded for a local search any more. */
    async allTexts() { return new Map(); },
    /** Server-side search over this account's files. @returns {Promise<{id:string,name:string,kind:string,score:number,matched:string[],snippet:string}[]>} */
    async search(query) {
      const r = await api(`/api/elvar/files/search?q=${encodeURIComponent(String(query).slice(0, 200))}`);
      if (r.status === 429) throw apiError(r); if (r.status !== 200) throw apiError(r, '検索できませんでした');
      return r.body.results;
    },

    // ---- writing
    /**
     * Upload one file: reserve room (the server checks the quota first), PUT the bytes to Storage, then send the memory. Rejects with the server's own Japanese message when the
     * account is full; with { code:'duplicate', duplicate } when this account already holds the same content (unless allowDuplicate); with { cancelled } on cancel.
     * @param {{name:string,type?:string,kind?:string,size?:number,addedAt?:number,source?:string}} meta  @param {Blob} blob  @param {object} [index] the memory built by the Worker  @param {string} [text]
     */
    async put(meta, blob, index = null, text = '', { onProgress, signal, allowDuplicate = false } = {}) {
      writable();
      const sha = index?.sha256 || await sha256Hex(new Uint8Array(await blob.arrayBuffer())), body = capText(text || '');
      const r = await api('/api/elvar/files/reserve', { method: 'POST', body: { name: meta.name, size: blob.size, sha256: sha, textBytes: new TextEncoder().encode(body).length, source: meta.source || 'picker', allowDuplicate } });
      if (r.status !== 200) throw apiError(r, 'アップロードを始められませんでした');
      if (r.body.duplicate) throw Object.assign(new Error('同じ内容のファイルがすでにあります'), { code: 'duplicate', duplicate: r.body.duplicate });
      const id = r.body.fileId, cancelUpload = () => api(`/api/elvar/files/${id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
      try { await upload(r.body.upload, blob, { onProgress, signal, headers: authHeaders }); }
      catch (e) { await cancelUpload(); throw e; }
      onProgress?.({ stage: '確認中' });
      const cols = toColumns(index || {});
      if (body.length < (text || '').length) cols.analysis = { ...cols.analysis, textTruncated: true, notes: [...(cols.analysis.notes || []), TEXT_CUT_NOTE].slice(-6) };
      if (meta.addedAt) cols.analysis = { ...cols.analysis, addedAt: meta.addedAt };   // a file moved up from this device keeps the date it was added
      const f = await api(`/api/elvar/files/${id}/finalize`, { method: 'POST', body: { ...cols, text: body } });
      if (f.status !== 200) { if (f.status >= 500 || !f.body?.error) await cancelUpload(); throw apiError(f, '保存を完了できませんでした'); }
      let file = f.body.file;
      const own = { ...(index?.tags?.length ? { tags: index.tags } : {}), ...(index?.memo ? { memo: index.memo } : {}), ...(index?.kind ? { kindLabel: index.kind } : {}) };
      if (Object.keys(own).length) { const p = await api(`/api/elvar/files/${id}`, { method: 'PATCH', body: own }); if (p.status === 200) file = p.body.file; }
      replace(file); dirty = true; texts.delete(id);
      cache.put(id, new Blob([blob], { type: file.mime }));
      return metaOf(file);
    },
    async remove(id) {
      writable();
      const r = await api(`/api/elvar/files/${id}`, { method: 'DELETE' });
      if (r.status !== 200 && r.status !== 404) throw apiError(r, 'ファイルを削除できませんでした');
      if (files) files = files.filter((f) => f.id !== id); dirty = true; texts.delete(id); await cache.del([id]);
    },
    /** Replace the memory (and the extracted text) of a file: it was read again, or read by the AI after the owner approved. The owner's tags / memo / label stay. */
    async putIndex(id, index, text = null) {
      writable();
      const cols = toColumns(index || {}), cur = row(id);
      if (text === null) {   // only the memory changes: the extracted text stays as it is
        const r = await api(`/api/elvar/files/${id}`, { method: 'PATCH', body: { ...cols, analysis: { ...cols.analysis, ...(cur?.analysis?.addedAt ? { addedAt: cur.analysis.addedAt } : {}) } } });
        if (r.status !== 200) throw apiError(r, '読み取った内容を保存できませんでした');
        replace(r.body.file); dirty = true; return indexOf(r.body.file);
      }
      const full = text, sent = capText(full), cut = sent.length < full.length;
      const r = await api(`/api/elvar/files/${id}/text`, { method: 'PUT', body: { ...cols, analysis: { ...cols.analysis, ...(cut ? { textTruncated: true, notes: [...(cols.analysis.notes || []), TEXT_CUT_NOTE].slice(-6) } : {}), ...(cur?.analysis?.addedAt ? { addedAt: cur.analysis.addedAt } : {}) }, text: sent } });
      if (r.status !== 200) throw apiError(r, '読み取った内容を保存できませんでした');
      replace(r.body.file); texts.set(id, sent); dirty = true; return indexOf(r.body.file);
    },
    /** Merge fields into the memory: tags / memo / kind are the owner's columns; anything else (AI summary, note path ...) goes into the analysis. */
    async patchIndex(id, patch) {
      writable();
      const body = {}, analysis = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'tags') body.tags = v; else if (k === 'memo') body.memo = v; else if (k === 'kind') body.kindLabel = v || ''; else if (k === 'related') body.related = v; else if (k !== 'id') analysis[k] = v;
      }
      if (Object.keys(analysis).length) body.analysis = analysis;
      const r = await api(`/api/elvar/files/${id}`, { method: 'PATCH', body }); if (r.status !== 200) throw apiError(r, '保存できませんでした');
      replace(r.body.file); dirty = true; return indexOf(r.body.file);
    },
    /** Delete everything in the account's vault (principle 7). */
    async removeAll() { writable(); const r = await api('/api/elvar/files/delete-all', { method: 'POST', body: { confirm: 'delete' } }); if (r.status !== 200) throw apiError(r); const ids = (files || []).map((f) => f.id); files = []; dirty = true; texts.clear(); await cache.del(ids); return r.body.deleted; },
    invalidate() { dirty = true; },
    /** Forget this device's cached originals (the account keeps everything). */
    async clearCache() { try { const d = await open(), tx = d.transaction(['blobs', 'cmeta', 'snap'], 'readwrite'); for (const s of ['blobs', 'cmeta', 'snap']) tx.objectStore(s).clear(); await done(tx); } catch { /* ignore */ } },

    // ---- print log (this device only)
    readLog() { try { const v = JSON.parse(storage?.getItem('elvar_print_log') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } },
    appendLog(entry) { const log = addLog(this.readLog(), entry, LIMITS.maxLog); try { storage?.setItem('elvar_print_log', JSON.stringify(log)); } catch { /* storage blocked: the log is just not kept */ } return log; },
    updateLog(id, outcome) { const log = this.readLog().map((e) => (e.id === id ? { ...e, outcome } : e)); try { storage?.setItem('elvar_print_log', JSON.stringify(log)); } catch { /* ignore */ } return log; },
    clearLog() { try { storage?.removeItem('elvar_print_log'); } catch { /* ignore */ } },
  };
}
