// ファイル library storage: IndexedDB on this device only (binary is fine). Four stores: small metadata records, the Blobs, the light "index" records
// (keywords, kind, tags, memo... listed often) and the extracted full texts (read only when searching / previewing / reading to the model).
// Nothing here talks to a server. The print log is a small localStorage list (a per-device convenience; it works without storage too).
import { addLog, LIMITS } from './file-lib.js';

const DB = 'elvar-files', V = 2;
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('IndexedDB error')); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('IndexedDB error')); tx.onabort = () => rej(tx.error || new Error('IndexedDB aborted')); });

export function createFileStore({ idb = globalThis.indexedDB, storage = globalThis.localStorage } = {}) {
  let dbp = null;
  const open = () => dbp ??= new Promise((res, rej) => {
    if (!idb) return rej(new Error('この端末のブラウザでは、ファイルを保存できません（IndexedDBが使えません）'));
    const r = idb.open(DB, V);
    r.onupgradeneeded = () => {   // v1 -> v2 keeps every file; the new stores start empty and are filled by "読み取る" (re-analysis)
      const d = r.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      if (!d.objectStoreNames.contains('index')) d.createObjectStore('index', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
    };
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error || new Error('保存領域を開けませんでした')); };
  });
  return {
    /** All records, newest first. */
    async list() { const d = await open(); const all = await req(d.transaction('meta').objectStore('meta').getAll()); return all.sort((a, b) => b.addedAt - a.addedAt); },
    async usedBytes() { return (await this.list()).reduce((s, f) => s + (f.size || 0), 0); },
    async get(id) { const d = await open(); return req(d.transaction('meta').objectStore('meta').get(id)); },
    async blob(id) { const d = await open(); return req(d.transaction('blobs').objectStore('blobs').get(id)); },
    /** @param {{id:string,name:string,type:string,kind:string,size:number,addedAt:number,source:string}} meta  @param {object} [index] light index record (without id: it is set here) @param {string} [text] */
    async put(meta, blob, index = null, text = '') {
      const d = await open(), tx = d.transaction(['meta', 'blobs', 'index', 'texts'], 'readwrite');
      tx.objectStore('meta').put(meta); tx.objectStore('blobs').put(blob, meta.id);
      if (index) { tx.objectStore('index').put({ ...index, id: meta.id }); if (text) tx.objectStore('texts').put(text, meta.id); }
      await done(tx); return meta;
    },
    async remove(id) { const d = await open(), tx = d.transaction(['meta', 'blobs', 'index', 'texts'], 'readwrite'); for (const s of ['meta', 'blobs', 'index', 'texts']) tx.objectStore(s).delete(id); await done(tx); },
    // ---- the index ("memory")
    /** @returns {Promise<Map<string, object>>} id -> index record */
    async indexes() { const d = await open(); const all = await req(d.transaction('index').objectStore('index').getAll()); return new Map(all.map((x) => [x.id, x])); },
    async getIndex(id) { const d = await open(); return req(d.transaction('index').objectStore('index').get(id)); },
    async getText(id) { const d = await open(); return (await req(d.transaction('texts').objectStore('texts').get(id))) || ''; },
    /** @returns {Promise<Map<string,string>>} every extracted text (for searching; loaded on demand) */
    async allTexts(budgetChars = 64 * 1024 * 1024) {   // a budget keeps a huge library from filling the phone's memory: later texts are left out of the full-text search
      const d = await open(), out = new Map(); let used = 0;
      await new Promise((res, rej) => { const c = d.transaction('texts').objectStore('texts').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (used + cur.value.length <= budgetChars) { out.set(cur.key, cur.value); used += cur.value.length; } cur.continue(); } else res(); }; c.onerror = () => rej(c.error); });
      return out;
    },
    /** Replace the index (and text) of a file, e.g. after re-analysis. */
    async putIndex(id, index, text = null) {
      const d = await open(), tx = d.transaction(['index', 'texts'], 'readwrite');
      tx.objectStore('index').put({ ...index, id }); if (text !== null) { if (text) tx.objectStore('texts').put(text, id); else tx.objectStore('texts').delete(id); }
      await done(tx); return index;
    },
    /** Merge fields into an index record (tags, memo, kind, summaryAI...). */
    async patchIndex(id, patch) {
      const d = await open(), tx = d.transaction('index', 'readwrite'), st = tx.objectStore('index'), cur = (await req(st.get(id))) || { id };
      const next = { ...cur, ...patch, id }; st.put(next); await done(tx); return next;
    },
    // ---- print log
    readLog() { try { const v = JSON.parse(storage?.getItem('elvar_print_log') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } },
    appendLog(entry) { const log = addLog(this.readLog(), entry, LIMITS.maxLog); try { storage?.setItem('elvar_print_log', JSON.stringify(log)); } catch { /* storage blocked: the log is just not kept */ } return log; },
    updateLog(id, outcome) { const log = this.readLog().map((e) => (e.id === id ? { ...e, outcome } : e)); try { storage?.setItem('elvar_print_log', JSON.stringify(log)); } catch { /* ignore */ } return log; },
    clearLog() { try { storage?.removeItem('elvar_print_log'); } catch { /* ignore */ } },
  };
}
