// Supabase access-token verification: locally generated keys stand in for the project's JWKS (nothing leaves the machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import * as jose from 'jose';
import { createJwtVerifier, supabaseEndpoints, bearerFrom, AuthError, getVerifier, _setVerifierForTests, _clearVerifiers } from '../server/auth/jwt.js';
import { isVerifiedUid } from '../server/db/verified-uid.js';
import { makeKey, jwksOf, signToken, SUPABASE_URL, ISSUER } from './helpers/jwt-keys.mjs';

const key = await makeKey('k1'), other = await makeKey('k2');
const verifier = (k = key) => createJwtVerifier({ supabaseUrl: SUPABASE_URL, getKey: jose.createLocalJWKSet(jwksOf(k)) });
const verify = verifier();
const bad = (code, status = 401) => (e) => { assert.ok(e instanceof AuthError, String(e)); assert.deepEqual({ code: e.code, status: e.status }, { code, status }); return true; };

test('a valid token gives a VerifiedUid and the identity fields', async () => {
  const sub = crypto.randomUUID();
  const id = await verify(await signToken(key, { sub, email: 'a@example.test', aal: 'aal2', session_id: 'sess-1' }));
  assert.ok(isVerifiedUid(id.uid)); assert.equal(id.uid.uid, sub); assert.equal(id.uid.source, 'jwt');
  assert.deepEqual({ email: id.email, role: id.role, aal: id.aal, sessionId: id.sessionId }, { email: 'a@example.test', role: 'user', aal: 'aal2', sessionId: 'sess-1' });
  assert.ok(id.exp > id.iat);
  assert.equal((await verify(await signToken(key, { sub: sub.toUpperCase() }))).uid.uid, sub, 'ids are normalised to lower case');
});

test('RS256 keys work too; the key id picks the key', async () => {
  const rs = await makeKey('rs1', 'RS256');
  const v = createJwtVerifier({ supabaseUrl: SUPABASE_URL, getKey: jose.createLocalJWKSet(jwksOf(key, rs)) });
  assert.ok((await v(await signToken(rs, {}))).uid); assert.ok((await v(await signToken(key, {}))).uid);
});

test('rejected: expired, wrong issuer, wrong audience, missing exp / iat / sub, foreign signature, unknown key id', async () => {
  await assert.rejects(verify(await signToken(key, {}, { exp: Math.floor(Date.now() / 1000) - 60, iat: Math.floor(Date.now() / 1000) - 3600 })), bad('token_expired'));
  await assert.rejects(verify(await signToken(key, {}, { issuer: 'https://evil.example/auth/v1' })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, {}, { issuer: null })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, {}, { audience: 'other' })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, {}, { audience: null })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, {}, { exp: null })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, { sub: undefined })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(other, {}, { header: { kid: 'k1' } })), bad('invalid_token'), 'signed by another key but claiming k1');
  await assert.rejects(verify(await signToken(other, {})), bad('invalid_token'), 'unknown kid');
});

test('rejected: not a user token (service_role, anon role, anonymous user, non-uuid sub, junk)', async () => {
  await assert.rejects(verify(await signToken(key, { role: 'service_role' })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, { role: 'anon' })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, { role: undefined })), bad('invalid_token'));
  await assert.rejects(verify(await signToken(key, { is_anonymous: true })), bad('invalid_token'));
  for (const sub of ['not-a-uuid', '1', '../etc', "'; drop table app.accounts; --", '00000000-0000-0000-0000-00000000000g']) await assert.rejects(verify(await signToken(key, { sub })), bad('invalid_token'), sub);
  for (const junk of ['', 'abc', 'a.b', 'a.b.c', 'a.b.c.d', 'x'.repeat(9000), null, undefined, 5, {}]) await assert.rejects(verify(junk), bad('invalid_token'), String(junk).slice(0, 20));
});

test('rejected: alg none and HS256 (algorithm confusion: the public key used as an HMAC secret)', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUER, aud: 'authenticated', sub: crypto.randomUUID(), role: 'authenticated', iat: now, exp: now + 3600 };
  await assert.rejects(verify(`${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.`), bad('invalid_token'));
  await assert.rejects(verify(`${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.${Buffer.from('x'.repeat(20)).toString('base64url')}`), bad('invalid_token'));
  const spki = (await jose.exportSPKI(key.publicKey));
  const hs = await new jose.SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode(spki));
  await assert.rejects(verify(hs), bad('invalid_token'));
});

test('admin: only app_metadata.elvar_role = "admin" counts; user_metadata cannot grant it', async () => {
  assert.equal((await verify(await signToken(key, { app_metadata: { elvar_role: 'admin' } }))).role, 'admin');
  assert.equal((await verify(await signToken(key, { app_metadata: { elvar_role: 'user' } }))).role, 'user');
  assert.equal((await verify(await signToken(key, { user_metadata: { elvar_role: 'admin' } }))).role, 'user');
  assert.equal((await verify(await signToken(key, { elvar_role: 'admin' }))).role, 'user');
});

test('Supabase URL rules: https only (loopback may use http); the issuer and JWKS URL are derived from it', () => {
  assert.equal(supabaseEndpoints('https://x.supabase.co').issuer, 'https://x.supabase.co/auth/v1');
  assert.equal(supabaseEndpoints('https://x.supabase.co/').jwksUrl.href, 'https://x.supabase.co/auth/v1/.well-known/jwks.json');
  assert.equal(supabaseEndpoints('http://127.0.0.1:54321').issuer, 'http://127.0.0.1:54321/auth/v1');
  for (const u of ['http://x.supabase.co', 'ftp://x', '', undefined, 'not a url', 'https://']) assert.throws(() => supabaseEndpoints(u), bad('auth_unconfigured', 503), String(u));
  assert.throws(() => getVerifier({}), bad('auth_unconfigured', 503));
});

test('JWKS over HTTP: fetched once and cached, an unknown key id triggers one refetch, an unreachable JWKS never lets a token in', async () => {
  let hits = 0, served = [key];
  const srv = http.createServer((q, r) => { hits++; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(jwksOf(...served))); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // the project's JWKS lives at <url>/auth/v1/.well-known/jwks.json; the issuer must match, so mint with that issuer
    const issuer = `${url}/auth/v1`;
    const v = createJwtVerifier({ supabaseUrl: url, cooldownMs: 50 });
    for (let i = 0; i < 5; i++) await v(await signToken(key, {}, { issuer }));
    assert.equal(hits, 1, 'cached: one fetch for five tokens');
    served = [key, other];   // the project rotates in a new key
    await assert.rejects(v(await signToken(other, {}, { issuer })), bad('invalid_token'), 'inside the cooldown an unknown kid is refused without another fetch');
    assert.equal(hits, 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok((await v(await signToken(other, {}, { issuer }))).uid, 'new kid -> refetch -> accepted');
    assert.equal(hits, 2);
    await assert.rejects(v(await signToken(await makeKey('k9'), {}, { issuer })), bad('invalid_token'));
  } finally { await new Promise((r) => srv.close(r)); }
  // server gone: a cached key still verifies (no round trip); an uncached one is refused with 503, never accepted
  const v2 = createJwtVerifier({ supabaseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(v2(await signToken(key, {}, { issuer: 'http://127.0.0.1:1/auth/v1' })), bad('auth_unavailable', 503));
});

test('getVerifier uses SUPABASE_URL, is cached per URL and can be replaced in tests', async () => {
  _clearVerifiers();
  const a = getVerifier({ SUPABASE_URL }); assert.equal(a, getVerifier({ SUPABASE_URL }));
  _setVerifierForTests(async () => ({ uid: 'x' })); assert.deepEqual(await getVerifier({})(), { uid: 'x' }); _setVerifierForTests(null);
  assert.throws(() => getVerifier({}), bad('auth_unconfigured', 503));
});

test('bearerFrom: only a well-formed Bearer header', () => {
  const h = (authorization) => bearerFrom({ headers: { authorization } });
  assert.equal(h('Bearer abc.def-ghi_jkl'), 'abc.def-ghi_jkl'); assert.equal(h('bearer abc'), 'abc'); assert.equal(h('  Bearer   abc  '), 'abc');
  for (const x of ['', 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer a\nb', undefined]) assert.equal(h(x), null, String(x));
  assert.equal(bearerFrom({}), null); assert.equal(bearerFrom(null), null);
});
