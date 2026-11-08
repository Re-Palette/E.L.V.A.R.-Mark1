// Relay for phone notifications -> PC. The phone encrypts each notification (AES-256-GCM, key from the owner's access token); this server and
// Upstash Redis only ever see ciphertext + a timestamp. Everything expires after 3 days (enforced on every call, plus a Redis TTL).
const KEY = 'elvar:notif:v1', KEEP_MS = 3 * 864e5, MAX_ITEMS = 200;
const url = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const token = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
export const syncConfigured = () => !!(url() && token());

async function pipeline(cmds) {
  if (!syncConfigured()) throw Object.assign(new Error('Redis（Upstash）が未設定です（UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN）'), { status: 503 });
  let r;
  try { r = await fetch(url() + '/pipeline', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds) }); }
  catch (e) { throw Object.assign(new Error(`Redisに接続できません: ${e?.cause?.code || e?.message || e}`), { status: 502 }); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw Object.assign(new Error(`Redisのエラー (${r.status})`), { status: 502 });
  const bad = j.find((x) => x?.error); if (bad) throw Object.assign(new Error(`Redisのエラー: ${String(bad.error).slice(0, 80)}`), { status: 502 });
  return j.map((x) => x.result);
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
