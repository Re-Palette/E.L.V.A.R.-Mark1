// Approval tickets: the server shows the user a summary of an action and signs EXACTLY (tool + args). Only a request that carries
// a valid ticket for identical args is executed. A model cannot change the args after the user approved, and cannot forge a ticket.
import crypto from 'node:crypto';
import { currentConfig } from '../config/resolve.js';

const TTL_MS = 120_000;

// The signing key is derived from the signed-in user's OWN data key (HKDF(DEK, salt = user id, "elvar-approval-ticket-v2"), server/crypto/envelope.js) and the
// payload carries the user id: a ticket made for one user is worthless for any other, on any instance, and dies when the user's DEK is rotated.
// There is no platform-wide key and no fallback: without a user context nothing can be signed or verified.
const key = () => { const k = currentConfig().ticketKey; if (!k) throw Object.assign(new Error('承認を扱えません（ログインしていません）'), { status: 401 }); return k; };
const uidNow = () => currentConfig().uid || currentConfig().auth?.userId || '';

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const b64 = (b) => Buffer.from(b).toString('base64url');

export function signTicket(tool, args, now = Date.now()) {
  const payload = b64(JSON.stringify({ t: tool, a: crypto.createHash('sha256').update(canonical(args)).digest('hex'), e: now + TTL_MS, j: crypto.randomUUID(), u: uidNow() }));
  const sig = b64(crypto.createHmac('sha256', key()).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Consumes the ticket on success. Single use holds across serverless instances: the first caller inserts the ticket id into the user's own app.ticket_uses
 * (unique per user and jti); a second instance replaying it loses. If the database is unreachable the answer is "no" (fail closed).
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function verifyTicket(ticket, tool, args, now = Date.now()) {
  let p;
  try {
    const [payload, sig] = String(ticket).split('.');
    const want = crypto.createHmac('sha256', key()).update(payload).digest();
    const got = Buffer.from(sig || '', 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: '許可証が不正です' };
    p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.u !== uidNow() || !p.u) return { ok: false, reason: '許可証が不正です' };   // somebody else's ticket (the key already differs; this is the second lock)
    if (p.e < now) return { ok: false, reason: '承認の有効期限（2分）が切れました。もう一度お願いします' };
    if (p.t !== tool || p.a !== crypto.createHash('sha256').update(canonical(args)).digest('hex')) return { ok: false, reason: '承認された内容と実行内容が一致しません' };
    if (typeof p.j !== 'string' || !/^[0-9a-f-]{36}$/.test(p.j)) return { ok: false, reason: '許可証を確認できません' };
  } catch { return { ok: false, reason: '許可証を確認できません' }; }
  const cfg = currentConfig();
  if (typeof cfg.db !== 'function') return { ok: false, reason: '承認を確認できません（ログインしていません）' };
  try {
    const ttl = Math.max(1, Math.ceil((p.e - now) / 1000)) + 60;
    const first = await cfg.db((r) => r.tickets.markUsed(p.j, ttl));
    return first ? { ok: true } : { ok: false, reason: 'この承認は使用済みです' };
  } catch (e) { console.error('[elvar] approval ticket store unavailable:', e?.code || e?.message); return { ok: false, reason: '承認を確認できません（保存先に接続できません）。もう一度お願いします' }; }
}
// (The OAuth `state` of the Google login is no longer signed here: it is a random value kept hashed in the store, see server/oauth/flow.js.)
