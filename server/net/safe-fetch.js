// safeFetch: the only way the server talks to a URL the owner (or a remote server they connected) supplied. docs/ELVAR_ARCHITECTURE.md 5.3.
//   - https only, ports 443 / 8443 (lifted only for a connector the owner marked "allowPrivate", and only on a local node: never on Vercel)
//   - the host is resolved ONCE; every resolved address is checked and the connection is made to the checked address itself (pinned, no second lookup:
//     a DNS-rebinding answer cannot be used). TLS still verifies the certificate against the host name (SNI = host name).
//   - blocked: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, multicast, reserved,
//     ::, ::1, fc00::/7, fe80::/10, ... and IPv4-mapped / compatible / NAT64 / 6to4 forms of all of those.
//   - redirects are never followed by default (a 3xx is returned as it is). `maxRedirects` (<= 3) follows same-origin hops only, re-checking each one.
//   - hop-by-hop / Host / Content-Length / our own x-elvar-token and cookies can never be set by a caller; the response is capped in size and time.
//
// Test-only escape hatch (docs/CONNECTORS.md): ELVAR_UNSAFE_TEST_NETWORK=loopback allows http(s) to 127.0.0.0/8 and ::1 on any port. It is IGNORED when
// VERCEL is set or NODE_ENV is "production" (re-evaluated on every call, nothing is cached), and it never opens any other range.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export class SafeFetchError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.name = 'SafeFetchError'; }
}

export const DEFAULTS = Object.freeze({ timeoutMs: 15_000, maxBytes: 1_048_576, maxRequestBytes: 262_144 });
const PUBLIC_PORTS = new Set([443, 8443]);

/** True only for a local, non-production process that explicitly asked for the loopback hatch (tests, local verification). */
export function loopbackHatchOn(e = process.env) {
  return e.ELVAR_UNSAFE_TEST_NETWORK === 'loopback' && !e.VERCEL && e.NODE_ENV !== 'production';
}
/** A connector's `network.allowPrivate` counts only on a local node. */
export const privateAllowed = (flag, e = process.env) => Boolean(flag) && !e.VERCEL;

// ------------------------------------------------------------------ address parsing and classification
export function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}
export function parseV6(input) {
  let s = String(input);
  if (s.includes('%') || !s.includes(':')) return null;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[2]); if (!v4) return null;
    s = tail[1] + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const parts = s.split('::'); if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  let groups;
  if (parts.length === 1) { if (head.length !== 8) return null; groups = head; }
  else {
    const rest = parts[1] ? parts[1].split(':') : [], fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  }
  const out = [];
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
  return out.length === 16 ? out : null;
}

/** @returns {'public'|'unspecified'|'loopback'|'private'|'cgnat'|'linklocal'|'multicast'|'reserved'} */
export function classifyV4(b) {
  const [a, c] = b;
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 169 && c === 254) return 'linklocal';
  if (a === 172 && c >= 16 && c <= 31) return 'private';
  if (a === 192 && c === 0 && b[2] === 0) return 'reserved';          // 192.0.0.0/24
  if (a === 192 && c === 0 && b[2] === 2) return 'reserved';          // documentation
  if (a === 192 && c === 88 && b[2] === 99) return 'reserved';        // 6to4 relay
  if (a === 192 && c === 168) return 'private';
  if (a === 198 && (c === 18 || c === 19)) return 'reserved';         // benchmarking
  if (a === 198 && c === 51 && b[2] === 100) return 'reserved';
  if (a === 203 && c === 0 && b[2] === 113) return 'reserved';
  if (a >= 224) return a < 240 ? 'multicast' : 'reserved';            // 224/4 and 240/4 (incl. broadcast)
  return 'public';
}
export function classifyV6(b) {
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return 'unspecified';
  if (zero(0, 15) && b[15] === 1) return 'loopback';
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));   // ::ffff:a.b.c.d  (IPv4-mapped)
  if (zero(0, 12)) { const k = classifyV4(b.slice(12)); return k === 'public' ? 'reserved' : k; }   // ::a.b.c.d (IPv4-compatible, deprecated): never public
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return classifyV4(b.slice(12));                                      // 64:ff9b::/96 (NAT64)
    if (b[4] === 0 && b[5] === 1) return 'reserved';                                      // 64:ff9b:1::/48
  }
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));                   // 2002::/16 (6to4): the embedded IPv4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return 'reserved';       // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'; // 2001:db8::/32 documentation
  if ((b[0] & 0xfe) === 0xfc) return 'private';                                           // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'linklocal';                        // fe80::/10
  if (b[0] === 0xff) return 'multicast';
  if ((b[0] & 0xe0) === 0x20) return 'public';                                            // 2000::/3 global unicast
  return 'reserved';                                                                       // everything else (100::/64, fec0::/10, ...)
}
export function classifyIp(ip) {
  const s = String(ip);
  if (net.isIPv4(s)) return classifyV4(parseV4(s));
  const v6 = net.isIPv6(s) ? parseV6(s) : null;
  return v6 ? classifyV6(v6) : 'reserved';
}
const PRIVATE_KINDS = new Set(['private', 'cgnat', 'loopback']);
/** @returns {string|null} why the address must not be used, or null when it may */
export function addressRefusal(ip, { allowPrivate = false, hatch = false } = {}) {
  const k = classifyIp(ip);
  if (k === 'public') return null;
  if (hatch && k === 'loopback') return null;
  if (allowPrivate && PRIVATE_KINDS.has(k)) return null;
  return k;
}

// ------------------------------------------------------------------ headers
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
  'te', 'trailer', 'upgrade', 'expect', 'cookie', 'set-cookie', 'x-elvar-token', 'accept-encoding']);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export const isForbiddenHeader = (name) => FORBIDDEN_HEADERS.has(String(name).toLowerCase());
export function cleanHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v === undefined || v === null) continue;
    if (!HEADER_NAME.test(k) || isForbiddenHeader(k)) throw new SafeFetchError('bad_header', `ヘッダー ${String(k).slice(0, 40)} は使えません`);
    const s = String(v);
    if (s.length > 4096 || /[\u0000-\u001f\u007f]/.test(s)) throw new SafeFetchError('bad_header', `ヘッダー ${k} の値が正しくありません`);
    out[k.toLowerCase()] = s;
  }
  return out;
}

// ------------------------------------------------------------------ DNS + transport (both replaceable per call: tests only)
async function defaultResolve(hostname) {
  const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return r.map((x) => ({ address: x.address, family: x.family }));
}

function defaultTransport({ protocol, ip, port, hostname, hostHeader, method, path, headers, body, maxBytes, signal, stopWhen }) {
  return new Promise((resolve, reject) => {
    const lib = protocol === 'http:' ? http : https;
    const opts = { host: ip, port, method, path, headers: { ...headers, host: hostHeader }, agent: false, signal, ...(protocol === 'https:' && !net.isIP(hostname) ? { servername: hostname } : {}) };
    const req = lib.request(opts, (res) => {
      const chunks = []; let n = 0, truncated = false, stopped = false, done = false;
      const hdrs = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, headers: hdrs, body: Buffer.concat(chunks), truncated, stopped }); };
      res.on('data', (c) => {
        if (truncated || stopped) return;
        n += c.length;
        if (n > maxBytes) { chunks.push(c.subarray(0, c.length - (n - maxBytes))); truncated = true; res.destroy(); req.destroy(); finish(); return; }
        chunks.push(c);
        // a streaming answer (SSE) may stay open after the message we wanted: the caller can say "that is enough"
        if (stopWhen) { let enough = false; try { enough = stopWhen(Buffer.concat(chunks), hdrs); } catch { /* not enough yet */ } if (enough) { stopped = true; res.destroy(); req.destroy(); finish(); } }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', (e) => { if (truncated || stopped) finish(); else reject(e); });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------ the fetch
function parseTarget(raw, { allowPrivate, hatch }) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new SafeFetchError('bad_url', 'URLの形式が正しくありません'); }
  if (u.username || u.password) throw new SafeFetchError('bad_url', 'URLにユーザー名・パスワードは入れられません');
  const loopbackOk = hatch;
  if (u.protocol !== 'https:' && !(loopbackOk && u.protocol === 'http:')) throw new SafeFetchError('not_https', 'https のアドレスだけ使えます');
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (!host || host.length > 253) throw new SafeFetchError('bad_url', 'ホスト名が正しくありません');
  const port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
  if (!(port >= 1 && port <= 65535)) throw new SafeFetchError('bad_port', 'ポート番号が正しくありません');
  return { u, host, port, portOk: PUBLIC_PORTS.has(port) || allowPrivate || loopbackOk };
}

async function resolveChecked(host, port, portOk, flags, resolve, protocol) {
  if (!portOk) throw new SafeFetchError('bad_port', 'ポートは 443 か 8443 だけ使えます');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try { addrs = await resolve(host); } catch { throw new SafeFetchError('dns_failed', `${host} のアドレスを調べられません`); }
    if (!Array.isArray(addrs) || !addrs.length) throw new SafeFetchError('dns_failed', `${host} のアドレスを調べられません`);
  }
  // EVERY answer is checked: one private address among public ones refuses the whole name (no "pick the good one" trick for an attacker's DNS)
  for (const a of addrs) {
    const why = addressRefusal(a.address, flags);
    if (why) throw new SafeFetchError('blocked_address', `このアドレスには接続できません（${why}）`);
  }
  // Beyond 443 / 8443 only a private or loopback target the owner explicitly allowed (or the test hatch) may be reached; plain http only on loopback (hatch).
  const k = classifyIp(addrs[0].address);
  if (protocol === 'http:' && k !== 'loopback') throw new SafeFetchError('not_https', 'https のアドレスだけ使えます');
  if (!PUBLIC_PORTS.has(port) && k === 'public') throw new SafeFetchError('bad_port', 'ポートは 443 か 8443 だけ使えます');
  return addrs[0];
}

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeoutMs?:number, maxBytes?:number, allowPrivate?:boolean, maxRedirects?:number,
 *          resolve?:(host:string)=>Promise<{address:string,family:number}[]>, transport?:Function}} [opts]  (resolve / transport: tests only)
 * @returns {Promise<{status:number, ok:boolean, headers:object, body:Buffer, truncated:boolean, url:string, ip:string, text:()=>string, json:()=>any}>}
 */
export async function safeFetch(url, opts = {}) {
  const hatch = loopbackHatchOn(), allowPrivate = privateAllowed(opts.allowPrivate);
  const timeoutMs = Math.min(60_000, Math.max(500, Number(opts.timeoutMs) || DEFAULTS.timeoutMs)), maxBytes = Math.min(8_388_608, Math.max(1, Number(opts.maxBytes) || DEFAULTS.maxBytes));
  const maxRedirects = Math.min(3, Math.max(0, Number(opts.maxRedirects) || 0));
  const resolve = opts.resolve || defaultResolve, transport = opts.transport || defaultTransport;
  let method = String(opts.method || 'GET').toUpperCase(), body = opts.body;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new SafeFetchError('bad_url', 'メソッドが正しくありません');
  if (body !== undefined && body !== null && Buffer.byteLength(body) > DEFAULTS.maxRequestBytes) throw new SafeFetchError('too_large', '送る内容が大きすぎます');
  let headers = { 'accept-encoding': 'identity', ...cleanHeaders(opts.headers) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const deadline = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new SafeFetchError('timeout', '時間切れになりました')), { once: true }));
  deadline.catch(() => {});
  try {
    let current = String(url);
    const first = parseTarget(current, { allowPrivate, hatch });
    for (let hops = 0; ; hops++) {
      const t = parseTarget(current, { allowPrivate, hatch });
      if (hops > 0 && (t.u.origin !== first.u.origin)) throw new SafeFetchError('redirect_blocked', '別のサイトへの転送は追いません');
      const addr = await Promise.race([resolveChecked(t.host, t.port, t.portOk, { allowPrivate, hatch }, resolve, t.u.protocol), deadline]);
      const hostHeader = t.u.host;   // host[:port] exactly as the owner wrote it
      const reqHeaders = body !== undefined && body !== null ? { ...headers, 'content-length': String(Buffer.byteLength(body)) } : headers;
      let res;
      try {
        res = await Promise.race([transport({ protocol: t.u.protocol, ip: addr.address, family: addr.family, port: t.port, hostname: t.host, hostHeader, method, path: t.u.pathname + t.u.search, headers: reqHeaders, body, maxBytes, signal: ac.signal, stopWhen: opts.stopWhen }), deadline]);
      } catch (e) {
        if (e instanceof SafeFetchError) throw e;
        if (ac.signal.aborted) throw new SafeFetchError('timeout', '時間切れになりました');
        throw new SafeFetchError('network', `接続できませんでした（${String(e?.code || e?.message || 'error').slice(0, 60)}）`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location && maxRedirects > 0) {
        if (hops >= maxRedirects) throw new SafeFetchError('redirect_blocked', '転送が多すぎます');
        let next; try { next = new URL(res.headers.location, current).toString(); } catch { throw new SafeFetchError('redirect_blocked', '転送先が正しくありません'); }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')); }
        current = next; continue;
      }
      const buf = Buffer.from(res.body || []);
      return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers || {}, body: buf, truncated: Boolean(res.truncated), stopped: Boolean(res.stopped), url: current, ip: addr.address,
        text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) };
    }
  } finally { clearTimeout(timer); }
}

/** A fetch()-shaped adapter (Response-like: ok, status, headers.get, json(), text()) for code written against fetch, e.g. the OAuth token exchange. */
export function safeFetchAsFetch(base = {}) {
  return async (url, init = {}) => {
    const r = await safeFetch(String(url), { ...base, method: init.method, headers: init.headers, body: init.body instanceof URLSearchParams ? init.body.toString() : init.body });
    return { ok: r.ok, status: r.status, headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null }, text: async () => r.text(), json: async () => r.json() };
  };
}
