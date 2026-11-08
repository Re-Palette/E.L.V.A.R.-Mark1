// Approval tickets: the server shows the user a summary of an action and signs EXACTLY (tool + args). Only a request that carries
// a valid ticket for identical args is executed. A model cannot change the args after the user approved, and cannot forge a ticket.
import crypto from 'node:crypto';

const TTL_MS = 120_000;
const used = new Map(); // jti -> exp (single use per server instance)
const fallbackKey = crypto.randomBytes(32);

const key = () => (process.env.ELVAR_ACCESS_TOKEN
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

/** @returns {{ok:true}|{ok:false, reason:string}} — consumes the ticket on success */
export function verifyTicket(ticket, tool, args, now = Date.now()) {
  try {
    const [payload, sig] = String(ticket).split('.');
    const want = crypto.createHmac('sha256', key()).update(payload).digest();
    const got = Buffer.from(sig || '', 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: '許可証が不正です' };
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.e < now) return { ok: false, reason: '承認の有効期限（2分）が切れました。もう一度お願いします' };
    if (p.t !== tool || p.a !== crypto.createHash('sha256').update(canonical(args)).digest('hex')) return { ok: false, reason: '承認された内容と実行内容が一致しません' };
    for (const [j, e] of used) if (e < now) used.delete(j);
    if (used.has(p.j)) return { ok: false, reason: 'この承認は使用済みです' };
    used.set(p.j, p.e);
    return { ok: true };
  } catch { return { ok: false, reason: '許可証を確認できません' }; }
}

// ---- OAuth "state" for the in-browser Google login: signed, 10 minutes, single use, bound to the redirect URI.
const stateKey = () => crypto.createHmac('sha256', key()).update('elvar-oauth-state-v1').digest();
const usedStates = new Map();
export function signState(redirectUri, now = Date.now()) {
  const payload = b64(JSON.stringify({ r: redirectUri, e: now + 600_000, j: crypto.randomUUID() }));
  return `${payload}.${b64(crypto.createHmac('sha256', stateKey()).update(payload).digest())}`;
}
/** @returns {{ok:true, redirectUri:string}|{ok:false, reason:string}} */
export function verifyState(state, now = Date.now()) {
  try {
    const [payload, sig] = String(state).split('.');
    const want = crypto.createHmac('sha256', stateKey()).update(payload).digest();
    const got = Buffer.from(sig || '', 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'state が不正です' };
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.e < now) return { ok: false, reason: 'ログインの有効期限（10分）が切れました。もう一度ボタンを押してください' };
    for (const [j, e] of usedStates) if (e < now) usedStates.delete(j);
    if (usedStates.has(p.j)) return { ok: false, reason: 'このログインは使用済みです。もう一度ボタンを押してください' };
    usedStates.set(p.j, p.e);
    return { ok: true, redirectUri: p.r };
  } catch { return { ok: false, reason: 'state を確認できません' }; }
}
