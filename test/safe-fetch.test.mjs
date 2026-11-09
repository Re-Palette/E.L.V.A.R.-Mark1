// safeFetch: address ranges, URL forms, DNS pinning, redirects, header rules, size/time caps, and the test-only loopback hatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safeFetch, SafeFetchError, classifyIp, addressRefusal, loopbackHatchOn, privateAllowed, parseV6, cleanHeaders } from '../server/net/safe-fetch.js';

const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const clean = { ELVAR_UNSAFE_TEST_NETWORK: undefined, VERCEL: undefined, NODE_ENV: undefined };
const refused = async (url, opts, code) => { await assert.rejects(() => safeFetch(url, opts), (e) => e instanceof SafeFetchError && (!code || e.code === code), `${url} -> ${code || 'refused'}`); };
const okTransport = (calls) => async (t) => { calls.push(t); return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok'), truncated: false }; };

test('blocked ranges: IPv4 (every range in the plan, and both edges)', () => {
  for (const ip of ['0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
    assert.notEqual(addressRefusal(ip), null, `${ip} must be refused`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '169.255.0.1', '198.17.255.255', '198.20.0.1', '192.0.1.1', '11.0.0.1', '9.255.255.255', '223.255.255.255']) {
    assert.equal(addressRefusal(ip), null, `${ip} is public`);
  }
});

test('blocked ranges: IPv6, IPv4-mapped (dotted and hex), compatible, 6to4, NAT64, Teredo, multicast, link-local', () => {
  for (const ip of ['::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', 'fec0::1', '100::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:a01:203', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1', '::ffff:0:0',
    '::127.0.0.1', '::8.8.8.8', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::1', '2002:a9fe:a9fe::1', '2002:c0a8:101::1', '0000:0000:0000:0000:0000:ffff:7f00:0001']) {
    assert.notEqual(addressRefusal(ip), null, `${ip} must be refused`);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) assert.equal(addressRefusal(ip), null, `${ip} is public`);
  assert.equal(parseV6('1::2::3'), null); assert.equal(parseV6('fe80::1%eth0'), null); assert.equal(parseV6('12345::1'), null); assert.equal(classifyIp('not-an-ip'), 'reserved');
});

test('private ranges open only with allowPrivate (and never link-local / metadata); loopback only with the hatch', () => {
  assert.equal(addressRefusal('192.168.1.5', { allowPrivate: true }), null);
  assert.equal(addressRefusal('10.0.0.5', { allowPrivate: true }), null);
  assert.equal(addressRefusal('100.64.1.1', { allowPrivate: true }), null);
  assert.equal(addressRefusal('fd00::5', { allowPrivate: true }), null);
  assert.equal(addressRefusal('::ffff:192.168.1.5', { allowPrivate: true }), null);
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', '0.0.0.0', '224.0.0.1', '240.0.0.1', 'fe80::1', '64:ff9b::a9fe:a9fe']) assert.notEqual(addressRefusal(ip, { allowPrivate: true }), null, `${ip} stays blocked even with allowPrivate`);
  assert.equal(addressRefusal('127.0.0.1', { hatch: true }), null); assert.equal(addressRefusal('::1', { hatch: true }), null);
  assert.notEqual(addressRefusal('10.0.0.1', { hatch: true }), null, 'the hatch opens loopback only');
  assert.notEqual(addressRefusal('127.0.0.1', { allowPrivate: false, hatch: false }), null);
});

test('URL forms: scheme, credentials, ports, and every spelling of loopback / private is refused before any lookup', async () => withEnv(clean, async () => {
  const calls = []; const resolve = async () => { calls.push('dns'); return [{ address: '93.184.216.34', family: 4 }]; }; const transport = okTransport(calls);
  const o = { resolve, transport };
  await refused('http://example.com/', o, 'not_https');
  await refused('ftp://example.com/', o, 'not_https');
  await refused('file:///etc/passwd', o, 'not_https');
  await refused('javascript:alert(1)', o);
  await refused('https://user:pw@example.com/', o, 'bad_url');
  await refused('https://example.com:8080/', o, 'bad_port');
  await refused('https://example.com:22/', o, 'bad_port');
  await refused('not a url', o, 'bad_url');
  for (const u of ['https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/',
    'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/', 'https://[::]/', 'https://10.0.0.1/', 'https://192.168.0.1:8443/', 'https://100.100.100.200/', 'https://[fd00::1]/', 'https://[fe80::1]/']) {
    await refused(u, o, 'blocked_address');
  }
  assert.deepEqual(calls, [], 'nothing was resolved or sent for any of them');
  assert.equal((await safeFetch('https://example.com/', o)).status, 200);
  assert.equal((await safeFetch('https://example.com:8443/x', o)).status, 200, '8443 is allowed');
}));

test('DNS is resolved once; the connection goes to the checked address (pinned); SNI / Host keep the name', async () => withEnv(clean, async () => {
  const seen = []; let lookups = 0;
  const resolve = async (h) => { lookups++; return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };   // a rebinding server: the 2nd answer is internal
  const r = await safeFetch('https://api.example.com:8443/v1/x?q=1', { resolve, transport: okTransport(seen) });
  assert.equal(lookups, 1, 'one lookup per hop: the rebinding answer is never asked for');
  assert.equal(seen.length, 1); assert.equal(seen[0].ip, '93.184.216.34'); assert.equal(seen[0].hostname, 'api.example.com'); assert.equal(seen[0].hostHeader, 'api.example.com:8443');
  assert.equal(seen[0].port, 8443); assert.equal(seen[0].path, '/v1/x?q=1'); assert.equal(r.ip, '93.184.216.34');
}));

test('every resolved address is checked: one internal address among public ones refuses the name', async () => withEnv(clean, async () => {
  const calls = [];
  await refused('https://evil.example/', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], transport: okTransport(calls) }, 'blocked_address');
  await refused('https://evil.example/', { resolve: async () => [{ address: '2606:4700::1111', family: 6 }, { address: '::ffff:10.0.0.1', family: 6 }], transport: okTransport(calls) }, 'blocked_address');
  await refused('https://gone.example/', { resolve: async () => { throw new Error('ENOTFOUND'); }, transport: okTransport(calls) }, 'dns_failed');
  await refused('https://gone.example/', { resolve: async () => [], transport: okTransport(calls) }, 'dns_failed');
  assert.equal(calls.length, 0);
}));

test('redirects: never followed by default; same-origin hops only when asked, each hop is checked again', async () => withEnv(clean, async () => {
  const pub = [{ address: '93.184.216.34', family: 4 }];
  const hops = []; const redirTo = (loc, status = 302) => async (t) => { hops.push(t.path); return { status, headers: { location: loc }, body: Buffer.alloc(0), truncated: false }; };
  const r = await safeFetch('https://a.example/start', { resolve: async () => pub, transport: redirTo('https://169.254.169.254/') });
  assert.equal(r.status, 302); assert.equal(r.headers.location, 'https://169.254.169.254/'); assert.equal(hops.length, 1, 'a 3xx is just returned: not followed');

  // same-origin follow
  hops.length = 0; let n = 0;
  const chain = async (t) => { hops.push(t.method + ' ' + t.path); n++; return n < 3 ? { status: n === 1 ? 307 : 303, headers: { location: n === 1 ? '/second' : '/third' }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.from('end') }; };
  const f = await safeFetch('https://a.example/first', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' }, maxRedirects: 3, resolve: async () => pub, transport: chain });
  assert.equal(f.status, 200); assert.deepEqual(hops, ['POST /first', 'POST /second', 'GET /third'], '307 keeps the method, 303 becomes a GET');

  // cross-origin and internal targets
  await refused('https://a.example/x', { maxRedirects: 3, resolve: async () => pub, transport: redirTo('https://b.example/y') }, 'redirect_blocked');
  await refused('https://a.example/x', { maxRedirects: 3, resolve: async () => pub, transport: redirTo('http://a.example/y') }, 'not_https');
  await refused('https://a.example/x', { maxRedirects: 3, resolve: async () => pub, transport: redirTo('https://169.254.169.254/latest') }, 'redirect_blocked');
  // the same name that now resolves to an internal address on the second hop (rebinding between hops)
  let lk = 0;
  await refused('https://a.example/x', { maxRedirects: 3, resolve: async () => (++lk === 1 ? pub : [{ address: '10.0.0.7', family: 4 }]), transport: redirTo('/again') }, 'blocked_address');
  // a loop is cut after maxRedirects
  await refused('https://a.example/x', { maxRedirects: 2, resolve: async () => pub, transport: redirTo('/loop') }, 'redirect_blocked');
}));

test('headers: Host, Content-Length, hop-by-hop, cookies and our own token cannot be set; control characters are refused; accept-encoding is identity', async () => withEnv(clean, async () => {
  for (const h of ['Host', 'host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Upgrade', 'Keep-Alive', 'TE', 'Trailer', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'x-elvar-token', 'X-ELVAR-TOKEN', 'Accept-Encoding']) {
    assert.throws(() => cleanHeaders({ [h]: 'x' }), /使えません/, h);
  }
  assert.throws(() => cleanHeaders({ 'x-a': 'ok\r\nX-Evil: 1' }), /正しくありません/); assert.throws(() => cleanHeaders({ 'bad name': 'x' }), /使えません/);
  const seen = [];
  await safeFetch('https://a.example/', { headers: { Authorization: 'Bearer x', 'X-Custom': '1' }, resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: okTransport(seen) });
  assert.deepEqual(Object.keys(seen[0].headers).sort(), ['accept-encoding', 'authorization', 'x-custom']); assert.equal(seen[0].headers['accept-encoding'], 'identity');
  await refused('https://a.example/', { headers: { Host: 'evil.example' }, resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: okTransport(seen) }, 'bad_header');
  await refused('https://a.example/', { method: 'POST', body: 'x'.repeat(300_000), resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: okTransport(seen) }, 'too_large');
}));

test('the test-only hatch: needs the flag, is ignored on Vercel and in production, opens loopback only', async () => {
  assert.equal(loopbackHatchOn({}), false); assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: 'loopback', ELVAR_TEST_MODE: '1' }), true);
  assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: 'loopback', ELVAR_DEV_AUTH: '1' }), true, 'the local dev stack (fake sign-in) counts as a test environment');
  assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: 'loopback' }), false, 'the flag alone is not enough: a platform that is not in test mode never opens loopback');
  assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: 'loopback', ELVAR_TEST_MODE: '1', VERCEL: '1' }), false, 'never on Vercel');
  assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: 'loopback', ELVAR_TEST_MODE: '1', NODE_ENV: 'production' }), false, 'never in a production run');
  assert.equal(loopbackHatchOn({ ELVAR_UNSAFE_TEST_NETWORK: '1', ELVAR_TEST_MODE: '1' }), false, 'only the exact value counts');
  assert.equal(privateAllowed(true, {}), false, 'a connector\'s allowPrivate never counts by default (a user could probe the operator\'s internal network)');
  assert.equal(privateAllowed(true, { ELVAR_ALLOW_PRIVATE_CONNECTORS: '1' }), true, 'only a single-user install that opted in');
  assert.equal(privateAllowed(true, { ELVAR_ALLOW_PRIVATE_CONNECTORS: '1', VERCEL: '1' }), false, 'allowPrivate never counts on Vercel'); assert.equal(privateAllowed(false, { ELVAR_ALLOW_PRIVATE_CONNECTORS: '1' }), false);
  const calls = [];
  const t = { transport: okTransport(calls) };
  await withEnv({ ...clean, ELVAR_UNSAFE_TEST_NETWORK: 'loopback', ELVAR_TEST_MODE: '1' }, async () => {
    assert.equal((await safeFetch('http://127.0.0.1:9/x', t)).status, 200, 'loopback over http, any port');
    assert.equal((await safeFetch('https://localhost:9/x', { ...t, resolve: async () => [{ address: '::1', family: 6 }] })).status, 200);
    await refused('http://10.0.0.1/x', t, 'blocked_address');
    await refused('https://169.254.169.254/x', t, 'blocked_address');
    await refused('http://example.com/x', { ...t, resolve: async () => [{ address: '93.184.216.34', family: 4 }] }, 'not_https');
    await refused('https://example.com:9999/x', { ...t, resolve: async () => [{ address: '93.184.216.34', family: 4 }] }, 'bad_port');
  });
  for (const e of [{ ...clean }, { ...clean, ELVAR_UNSAFE_TEST_NETWORK: 'loopback', VERCEL: '1' }, { ...clean, ELVAR_UNSAFE_TEST_NETWORK: 'loopback', NODE_ENV: 'production' }]) {
    await withEnv(e, async () => { await refused('http://127.0.0.1:9/x', t, 'not_https'); await refused('https://127.0.0.1/x', t, 'blocked_address'); });
  }
  await withEnv({ ...clean, VERCEL: '1', ELVAR_ALLOW_PRIVATE_CONNECTORS: '1' }, async () => refused('https://192.168.0.1/x', { ...t, allowPrivate: true }, 'blocked_address'));
  await withEnv(clean, async () => refused('https://192.168.0.1:8123/x', { ...t, allowPrivate: true }, 'bad_port'));   // the platform default: refused
  await withEnv({ ...clean, ELVAR_ALLOW_PRIVATE_CONNECTORS: '1' }, async () => assert.equal((await safeFetch('https://192.168.0.1:8123/x', { ...t, allowPrivate: true })).status, 200, 'a single-user install that opted in honours allowPrivate'));
});

// ---- real sockets (hatch on): size cap, time cap, redirect, headers actually sent
test('real sockets: body cap, time cap, no redirect following, the Host header and no stray headers', async () => withEnv({ ...clean, ELVAR_UNSAFE_TEST_NETWORK: 'loopback' }, async () => {
  const log = [];
  const srv = http.createServer((req, res) => {
    log.push({ url: req.url, headers: req.headers });
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); const chunk = Buffer.alloc(64 * 1024, 97); let i = 0; const t = setInterval(() => { if (res.destroyed || i++ > 200) { clearInterval(t); res.end(); } else res.write(chunk); }, 1); res.on('close', () => clearInterval(t)); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('start'); return; /* never ends */ }
    if (req.url === '/redir') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url === '/echo') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: b })); }); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const small = await safeFetch(base + '/ok'); assert.equal(small.status, 200); assert.equal(small.text(), 'ok'); assert.equal(small.truncated, false);
    const big = await safeFetch(base + '/big', { maxBytes: 100_000 });
    assert.equal(big.truncated, true); assert.equal(big.body.length, 100_000, 'cut at exactly the cap');
    const t0 = Date.now(); await refused(base + '/slow', { timeoutMs: 600 }, 'timeout'); assert.ok(Date.now() - t0 < 3000, 'the time cap holds');
    const rd = await safeFetch(base + '/redir'); assert.equal(rd.status, 302); assert.equal(rd.headers.location, '/ok');
    assert.equal((await safeFetch(base + '/redir', { maxRedirects: 2 })).text(), 'ok', 'same-origin follow when asked');
    const echo = await safeFetch(base + '/echo', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', authorization: 'Bearer t' } });
    assert.deepEqual(echo.json(), { got: '{"a":1}' });
    const sent = log.find((l) => l.url === '/echo').headers;
    assert.equal(sent.host, `127.0.0.1:${srv.address().port}`); assert.equal(sent.authorization, 'Bearer t'); assert.equal(sent['content-length'], '7');
    for (const h of ['cookie', 'x-elvar-token', 'x-forwarded-for']) assert.equal(sent[h], undefined, h);
    await refused('http://127.0.0.1:1/', { timeoutMs: 2000 }, 'network');
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}));
