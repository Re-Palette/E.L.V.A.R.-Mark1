// Approval tickets: the server shows the user a summary of an action and signs EXACTLY (tool + args). Only a request that carries
// a valid ticket for identical args is executed. A model cannot change the args after the user approved, and cannot forge a ticket.
import crypto from 'node:crypto';
import { currentConfig } from '../config/resolve.js';
import { getStore } from '../store/index.js';

const TTL_MS = 120_000;
const used = new Map(); // jti -> exp: single-use memory when there is NO store (env mode without Redis); with a store the SET NX below is the source of truth
const fallbackKey = crypto.randomBytes(32);

// Vault mode: derived from the vault key (the same on every instance). Env mode: from the shared access token. Otherwise a per-process random key.
const key = () => currentConfig().ticketKey || (process.env.ELVAR_ACCESS_TOKEN
  ? crypto.createHmac('sha256', process.env.ELVAR_ACCESS_TOKEN).update('elvar-approval-ticket-v1').digest()
  : fallbackKey);

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const b64 = (b) => Buffer.from(b).toString('base64url');

export function signTicket(tool, args, now = Date.now()) {
  const payload = b64(JSON.stringify({ t: tool, a: crypto.createHash('sha256').update(canonical(args)).digest('hex'), e: now + TTL_MS, j: crypto.randomUUID() }));
  const sig = b64(crypto.createHmac('sha256', key()).update(payload).digest());
  return `${payload}.${sig}`;
}

const usedKey = (jti) => `elvar:v1:ticket:${jti}`;
const storeOrNull = () => { try { return getStore(); } catch { return null; } };

/**
 * Consumes the ticket on success. Single use holds across serverless instances: the first caller wins a store `SET NX` on the ticket id (TTL = the ticket's
 * remaining life + a minute); a second instance replaying the same ticket loses it. If the store is configured but unreachable the answer is "no" (fail closed).
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
    if (p.e < now) return { ok: false, reason: '承認の有効期限（2分）が切れました。もう一度お願いします' };
    if (p.t !== tool || p.a !== crypto.createHash('sha256').update(canonical(args)).digest('hex')) return { ok: false, reason: '承認された内容と実行内容が一致しません' };
    if (typeof p.j !== 'string' || !/^[0-9a-f-]{36}$/.test(p.j)) return { ok: false, reason: '許可証を確認できません' };
  } catch { return { ok: false, reason: '許可証を確認できません' }; }
  const store = storeOrNull();
  if (store) {
    try {
      const first = await store.set(usedKey(p.j), 1, { nx: true, ttlSec: Math.max(1, Math.ceil((p.e - now) / 1000)) + 60 });
      return first ? { ok: true } : { ok: false, reason: 'この承認は使用済みです' };
    } catch (e) { console.error('[elvar] approval ticket store unavailable:', e?.code || e?.message); return { ok: false, reason: '承認を確認できません（保存先に接続できません）。もう一度お願いします' }; }
  }
  for (const [j, e] of used) if (e < now) used.delete(j);
  if (used.has(p.j)) return { ok: false, reason: 'この承認は使用済みです' };
  used.set(p.j, p.e);
  return { ok: true };
}
// (The OAuth `state` of the Google login is no longer signed here: it is a random value kept hashed in the store, see server/oauth/flow.js.)
