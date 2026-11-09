// The browser-side half of the per-user namespace (web/public/ns.js does the prefixing). After sign-in the user's namespace is recorded; on sign-out that
// user's local data (their localStorage keys and IndexedDB databases) is erased, so a shared computer keeps nothing of them.
const POINTER = 'elvar_ns';
// The patched Storage methods (web/public/ns.js) add the user's prefix to every key; this module works with ALREADY prefixed keys, so it uses the original methods
// that ns.js keeps in window.__elvarRawStorage (without ns.js there is no prefixing and the normal methods are the originals).
const orig = () => (typeof window !== 'undefined' && window.__elvarRawStorage) || { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v), removeItem: (k) => localStorage.removeItem(k) };
const raw = {
  get: (k) => { try { return orig().getItem(k); } catch { return null; } },
  set: (k, v) => { try { orig().setItem(k, v); } catch { /* blocked */ } },
  del: (k) => { try { orig().removeItem(k); } catch { /* blocked */ } },
};
/** sha256(uid) -> 16 hex characters. The id itself is never used as a name. */
export async function nsOf(uid) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('elvar-ns|' + String(uid)));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const activeNs = () => (typeof window !== 'undefined' && window.__elvarNs) || 'anon';
export const storedNs = () => raw.get(POINTER) || '';

/** @returns {Promise<boolean>} true when the namespace CHANGED (the page must reload so that every module starts in the new one) */
export async function adoptUser(uid) {
  const ns = await nsOf(uid);
  raw.set(POINTER, ns);
  return ns !== activeNs();
}

/** Erase everything this browser holds for the given namespace (default: the current user's). */
export async function clearUserLocal(ns = activeNs()) {
  if (!/^[a-f0-9]{16}$/.test(ns)) return;
  try {
    const prefix = `u.${ns}.`, keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
    for (const k of keys) raw.del(k);
  } catch { /* blocked */ }
  try {
    const dbs = (await indexedDB.databases?.()) || [];
    await Promise.all(dbs.filter((d) => d.name && d.name.endsWith('@' + ns)).map((d) => new Promise((res) => {
      const r = (window.__elvarRawIdb?.deleteDatabase || ((n) => indexedDB.deleteDatabase(n)))(d.name);   // the full name: the shim would add the active namespace again
      r.onsuccess = r.onerror = r.onblocked = () => res();
    })));
  } catch { /* not supported */ }
}

/** Forget who is signed in on this device (sign-out): the pointer goes back to "anon". */
export function leaveUser() { raw.del(POINTER); }
