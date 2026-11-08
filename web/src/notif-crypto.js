// End-to-end-ish encryption of notifications for the cloud relay. AES-256-GCM; the key is derived (PBKDF2-SHA256, 100k rounds) from the vault notifSecret (the owner access token in env mode),
// so the relay and Redis only hold ciphertext. The Android app does the same derivation natively (NotifSync.kt) - keep them identical.
const SALT = 'elvar-notif-v1', ROUNDS = 100_000;
const enc = new TextEncoder(), dec = new TextDecoder();
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const keys = new Map();

export async function deriveKey(token) {
  if (!token) throw new Error('暗号化の鍵がありません（ログインしてください）');
  if (keys.has(token)) return keys.get(token);
  const base = await crypto.subtle.importKey('raw', enc.encode(token), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SALT), iterations: ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keys.set(token, key); return key;
}
export async function encryptJson(token, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(token), enc.encode(JSON.stringify(obj))));
  return { iv: toB64(iv), ct: toB64(ct) };
}
/** @returns the object, or null if the key is wrong / the data was tampered with. */
export async function decryptJson(token, { iv, ct }) {
  try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await deriveKey(token), fromB64(ct)))); } catch { return null; }
}
