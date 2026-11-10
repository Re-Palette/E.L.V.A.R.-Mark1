// The library this device kept BEFORE files lived in the account: IndexedDB `elvar-files` (stores meta, blobs, index, texts; web/src/file-store.js of the single-owner
// days). Two places can hold it: the plain name (made before per-user names existed) and the name of the user who is signed in now (web/public/ns.js adds `@<namespace>`).
// Nothing here uploads by itself: the screen asks the owner 「この端末のファイル（n件・xMB）は <アカウント> のものですか。移しますか」 (it NAMES the account, and the owner
// must tick that the files are theirs: on a shared computer the old library may belong to somebody else), then migrateLibrary() moves them one by one
// (reserve -> upload -> finalize, each file's memory and tags kept, the original date kept), skips what the account already has, stops when the account is full, and
// deletes each local copy only after it is safely in the account. A library that ends up empty is removed.
import { sha256Hex } from './file-index.js';
import { LIMITS } from './file-lib.js';

const NAME = 'elvar-files';
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('IndexedDB error')); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('IndexedDB error')); tx.onabort = () => rej(tx.error || new Error('aborted')); });

/** Open the old database ONLY if it exists (never create an empty one). null when there is none. */
function openExisting(factoryOpen) {
  return new Promise((resolve) => {
    let r; try { r = factoryOpen(); } catch { resolve(null); return; }
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch { /* ignore */ } resolve(null); };   // it did not exist: undo the creation
    r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('meta') || !d.objectStoreNames.contains('blobs')) { d.close(); resolve(null); } else resolve(d); };
    r.onerror = () => resolve(null); r.onblocked = () => resolve(null);
  });
}

/** The old libraries of this device (usually none). Each: { key, summary(), records(), remove(id), destroy() }. */
export async function legacyLibraries({ idb = globalThis.indexedDB, win = globalThis.window } = {}) {
  if (!idb) return [];
  const raw = win?.__elvarRawIdb;
  const variants = [{ key: 'ns', open: () => idb.open(NAME), destroy: () => idb.deleteDatabase(NAME) }];                                         // the signed-in user's own name
  if (raw?.open) variants.unshift({ key: 'plain', open: () => raw.open(NAME), destroy: () => raw.deleteDatabase(NAME) });                          // made before per-user names
  const out = [];
  for (const v of variants) {
    const db = await openExisting(v.open); if (!db) continue;
    const metas = async () => (await req(db.transaction('meta').objectStore('meta').getAll())).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const all = await metas();
    if (!all.length) { db.close(); await new Promise((r) => { const q = v.destroy(); q.onsuccess = q.onerror = q.onblocked = () => r(); }); continue; }   // an empty old library: just remove it
    out.push({
      key: v.key,
      async summary() { const m = await metas(); return { count: m.length, bytes: m.reduce((s, x) => s + (x.size || 0), 0) }; },
      /** One record at a time (the Blob is only read when it is its turn). */
      async *records() {
        for (const meta of await metas()) {
          const [blob, index, text] = await Promise.all([req(db.transaction('blobs').objectStore('blobs').get(meta.id)), db.objectStoreNames.contains('index') ? req(db.transaction('index').objectStore('index').get(meta.id)) : null, db.objectStoreNames.contains('texts') ? req(db.transaction('texts').objectStore('texts').get(meta.id)) : ''].map((p) => Promise.resolve(p)));
          yield { meta, blob, index: index || null, text: text || '' };
        }
      },
      async remove(id) { const names = ['meta', 'blobs', 'index', 'texts'].filter((s) => db.objectStoreNames.contains(s)), tx = db.transaction(names, 'readwrite'); for (const s of names) tx.objectStore(s).delete(id); await done(tx); },
      async destroy() { db.close(); await new Promise((r) => { const q = v.destroy(); q.onsuccess = q.onerror = q.onblocked = () => r(); }); },
    });
  }
  return out;
}

/**
 * Move one old library into the account.
 * @param {{ store:{ put:Function, indexes:Function }, analyse?:(blob:Blob,name:string,mime:string)=>Promise<{sha256:string,index:object,text:string}>,
 *           onProgress?:(p:{i:number,n:number,name:string,stage?:string,done?:number,total?:number})=>void, shouldStop?:()=>boolean, signal?:AbortSignal }} o
 * `confirmedAccount` is REQUIRED: the account (its e-mail) the owner explicitly confirmed the files belong to. Without it nothing is read and nothing is uploaded.
 * @returns {Promise<{moved:number, skipped:string[], failed:{name:string,reason:string}[], stopped:null|'quota'|'cancelled'|'offline', message:string, remaining:number}>}
 */
export async function migrateLibrary(lib, { store, analyse = null, onProgress = () => {}, shouldStop = () => false, signal, confirmedAccount = '' } = {}) {
  if (typeof confirmedAccount !== 'string' || !confirmedAccount.trim()) throw Object.assign(new Error('このファイルがこのアカウントのものか、確認が済んでいません'), { code: 'confirmation_required' });
  const { count } = await lib.summary(), known = new Set([...(await store.indexes()).values()].map((x) => x.sha256).filter(Boolean));
  const res = { moved: 0, skipped: [], failed: [], stopped: null, message: '', remaining: count };
  let i = 0;
  for await (const rec of lib.records()) {
    i++; const name = rec.meta.name || 'ファイル';
    if (shouldStop() || signal?.aborted) { res.stopped = 'cancelled'; break; }
    onProgress({ i, n: count, name, stage: '確認中' });
    try {
      if (!rec.blob || !(rec.blob.size > 0)) { res.failed.push({ name, reason: '中身が空か、読み出せませんでした' }); continue; }
      if (rec.blob.size > LIMITS.perFile) { res.failed.push({ name, reason: `1ファイル ${Math.round(LIMITS.perFile / 1048576)} MB をこえています` }); continue; }
      let index = rec.index, text = rec.text, sha = index?.sha256 || '';
      if (!index && analyse) { try { const an = await analyse(rec.blob, name, rec.meta.type); index = an.index; text = an.text; sha = an.sha256 || ''; } catch (e) { if (e?.cancelled) { res.stopped = 'cancelled'; break; } } }
      if (!sha) sha = await sha256Hex(new Uint8Array(await rec.blob.arrayBuffer()));
      if (known.has(sha)) { res.skipped.push(name); await lib.remove(rec.meta.id); res.remaining--; continue; }   // the account has it already
      await store.put({ name, type: rec.meta.type, kind: rec.meta.kind, size: rec.blob.size, addedAt: rec.meta.addedAt, source: 'migrate' }, rec.blob, { ...(index || {}), sha256: sha }, text, { onProgress: (p) => onProgress({ i, n: count, name, ...p }), signal });
      known.add(sha); await lib.remove(rec.meta.id); res.moved++; res.remaining--;
    } catch (e) {
      if (e?.cancelled) { res.stopped = 'cancelled'; break; }
      if (e?.code === 'duplicate') { res.skipped.push(name); await lib.remove(rec.meta.id); res.remaining--; continue; }
      if (e?.code === 'storage_quota_exceeded') { res.stopped = 'quota'; res.message = e.message; break; }   // the account is full: the rest stays on this device
      if (e?.code === 'offline') { res.stopped = 'offline'; res.message = e.message; break; }
      res.failed.push({ name, reason: String(e?.message || e) });
    }
  }
  if (!res.stopped && !res.failed.length) { res.remaining = 0; await lib.destroy(); }   // everything is in the account: the old library goes
  return res;
}

/** What the screen asks before anything moves. The account is NAMED, the count and size are shown, and there is a way out: "これは自分のファイルではない". */
export function legacyAsk({ count, bytes, account, fmt = (n) => `${n} B` }) {
  const who = String(account || '').trim() || 'このアカウント';
  return {
    who, headline: 'この端末に、以前のファイルが残っています',
    body: `この端末に、以前の方式（この端末の中だけ）で保存されたファイルが ${count}件（${fmt(bytes)}）あります。共用のパソコンでは、ほかの人のファイルかもしれません。`,
    confirmLabel: `これは ${who} のファイルです`, moveLabel: `${who} に移す`,
    notMineLabel: 'これは自分のファイルではない',
    notMineTitle: `この ${count}件（${fmt(bytes)}）は、${who} のファイルではないものとして扱います`,
    notMineBody: 'この端末から消すと元に戻せません。消さずに残すと、移さずにそのままにします（持ち主の人があとで開けます）。',
    removeLabel: `${count}件を、この端末から消す`, keepLabel: '消さずに残す（移さない）',
  };
}
/** The key under which "leave it" is remembered (per user through ns.js) and a signature of what was left, so a changed library asks again. */
export const LEGACY_KEEP_KEY = 'elvar_legacy_files_kept';
export const legacySig = (count, bytes) => `${count}:${bytes}`;
