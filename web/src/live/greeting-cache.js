// Device-local cache of the spoken greeting (raw 24 kHz mono PCM, one entry per greeting line).
// Lets a double clap answer with no network delay. Entries carry the server's cacheKey (voice/model/persona hash).
const DB = 'elvar-greetings', STORE = 'greetings';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** @returns {Promise<{key:string, sr:number, pcm:Float32Array}|null>} */
export async function getGreeting(line) {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const q = db.transaction(STORE).objectStore(STORE).get(line);
      q.onsuccess = () => resolve(q.result || null);
      q.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function putGreeting(line, rec) {
  try {
    const db = await open();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec, line);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch {}
}

export function concatPcm(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0), out = new Float32Array(n);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
