// The caller's address, for the limits that apply before anybody is signed in (the sign-up state page, the dev issuer). Kept from the old owner-mode
// auth module (docs/ELVAR_MULTIUSER.md section 1): IPv6 is grouped by /64; off Vercel only the socket counts unless ELVAR_TRUST_PROXY names the header
// that YOUR reverse proxy sets.
import crypto from 'node:crypto';

const onVercel = () => Boolean(process.env.VERCEL);

/** IPv6 addresses are grouped by /64 (one subscriber gets a whole /64); IPv4 (and IPv4-mapped IPv6) as is. */
export function addrKey(ip) {
  let a = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (mapped) return mapped[1];
  if (!a.includes(':')) return a.slice(0, 64) || 'unknown';
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const full = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (full.length !== 8 || full.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return 'bad6';
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const h = req.headers || {};
  if (onVercel()) return addrKey(first(h['x-real-ip']) || first(h['x-forwarded-for']) || 'unknown');
  const trust = String(process.env.ELVAR_TRUST_PROXY || '').trim().toLowerCase();
  if (trust && /^[a-z0-9-]{1,40}$/.test(trust) && h[trust]) {
    const v = String(h[trust]).split(',').map((x) => x.trim()).filter(Boolean);
    return addrKey(v.at(-1) || 'unknown');   // the entry YOUR proxy appended (rightmost), not what the client sent
  }
  return addrKey(req.socket?.remoteAddress || 'unknown');
}

/** What goes into the rate-limit table for a signed-out caller: a hash of the address, never the address itself (and never uuid-shaped). */
export const addrHash = (req) => crypto.createHash('sha256').update('elvar-addr|' + clientIp(req)).digest('hex').slice(0, 40);
