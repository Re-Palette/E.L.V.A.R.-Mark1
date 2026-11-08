// Relay for phone notifications -> PC. The phone encrypts each notification (AES-256-GCM, key derived from the vault's notification secret); this server and
// Upstash Redis only ever see ciphertext + a timestamp. Everything expires after 3 days (enforced on every call, plus a Redis TTL).
import { getStore } from './store/index.js';
const KEY = 'elvar:notif:v1', KEEP_MS = 3 * 864e5, MAX_ITEMS = 200;
export const syncConfigured = () => !!getStore();

async function pipeline(cmds) {
  const store = getStore();
  if (!store) throw Object.assign(new Error('保存先（Upstash Redis）が未設定です。Vercel の Storage から Upstash を追加してください'), { status: 503 });
  return store.cmd(cmds);
}

const b64 = /^[A-Za-z0-9+/_=-]+$/;
export function validItem(x) {
  return x && typeof x === 'object' && typeof x.id === 'string' && /^[\w.:-]{1,64}$/.test(x.id) && Number.isFinite(x.at) && x.at > 0
    && typeof x.iv === 'string' && x.iv.length >= 12 && x.iv.length <= 32 && b64.test(x.iv) && typeof x.ct === 'string' && x.ct.length >= 16 && x.ct.length <= 6000 && b64.test(x.ct);
}

/** @returns {Promise<{stored:number}>} */
export async function pushItems(items, now = Date.now()) {
  const ok = (Array.isArray(items) ? items : []).slice(0, 50).filter(validItem);
  if (!ok.length) return { stored: 0 };
  const cmds = [['ZREMRANGEBYSCORE', KEY, '-inf', String(now - KEEP_MS)]];
  for (const x of ok) cmds.push(['ZADD', KEY, String(Math.min(x.at, now + 60_000)), JSON.stringify({ id: x.id, at: x.at, iv: x.iv, ct: x.ct })]);
  cmds.push(['ZREMRANGEBYRANK', KEY, '0', String(-(MAX_ITEMS + 1))], ['EXPIRE', KEY, String(Math.ceil(KEEP_MS / 1000) + 3600)]);
  await pipeline(cmds);
  return { stored: ok.length };
}

/** Items at or after `since` (ms), oldest first, at most 100. The caller de-duplicates by id. */
export async function pullSince(since = 0, now = Date.now()) {
  const res = await pipeline([['ZREMRANGEBYSCORE', KEY, '-inf', String(now - KEEP_MS)], ['ZRANGEBYSCORE', KEY, String(Math.max(0, Number(since) || 0)), '+inf', 'LIMIT', '0', '100']]);
  const items = []; for (const m of res[1] || []) { try { const o = JSON.parse(m); if (validItem(o)) items.push(o); } catch { /* skip */ } }
  return { items };
}
export async function clearAll() { await pipeline([['DEL', KEY]]); return { cleared: true }; }
export async function syncStatus() {
  if (!syncConfigured()) return { configured: false };
  try { const [, n] = await pipeline([['ZREMRANGEBYSCORE', KEY, '-inf', String(Date.now() - KEEP_MS)], ['ZCARD', KEY]]); return { configured: true, reachable: true, stored: Number(n) || 0, keepDays: 3 }; }
  catch (e) { return { configured: true, reachable: false, error: String(e.message).slice(0, 100) }; }
}

/** HTTP handler body shared by the Vercel function and the local server. @returns {{status:number, body:object}} */
export async function handleNotif({ method, query = {}, body = {} }) {
  try {
    if (method === 'GET') return query.status ? { status: 200, body: await syncStatus() } : { status: 200, body: await pullSince(Number(query.since) || 0) };
    if (method === 'POST') {
      if (body.action === 'clear') return { status: 200, body: await clearAll() };
      return { status: 200, body: await pushItems(body.items) };
    }
    return { status: 405, body: { error: 'method_not_allowed' } };
  } catch (e) { return { status: e.status || 500, body: { error: String(e.message || e).slice(0, 160) } }; }
}
