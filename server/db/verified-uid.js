// VerifiedUid: the only thing asUser() accepts. A plain string (or an object somebody built by hand) is refused, so a user id can only reach the
// database after it went through one of the checks that mint it:
//   'jwt'            server/auth/jwt.js           a Supabase access token whose signature, issuer, audience and expiry were verified
//   'device'         server/auth/with-user.js     a device token whose hash matched a row of app.devices
//   'oauth_pending'  (P3)                         the user a single-use OAuth state belongs to
//   'purge'          server/rights/*              the account-deletion job, acting for the account it is deleting
//   'migrate'        scripts/migrate-owner.mjs    the operator's one-time import of an old single-owner install into one account they name
//   'test'           tests only                   needs ELVAR_TEST_MODE=1
// test/verified-uid.test.mjs lists the modules that may import mintVerifiedUid; anything else fails the build.
import { dbError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['jwt', 'device', 'oauth_pending', 'purge', 'migrate', 'test']);
const minted = new WeakSet();

export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

export function mintVerifiedUid(uid, source) {
  if (!SOURCES.has(source)) throw dbError('bad_uid_source', 500);
  if (source === 'test' && process.env.ELVAR_TEST_MODE !== '1') throw dbError('bad_uid_source', 500);
  if (!isUuid(uid)) throw dbError('bad_uid', 500);
  const id = uid.toLowerCase();
  const v = Object.freeze({ uid: id, source, toString: () => id, toJSON: () => id });
  minted.add(v);
  return v;
}
export const isVerifiedUid = (v) => v !== null && typeof v === 'object' && minted.has(v);

/** @returns {string} the uuid. @throws unverified_uid for anything that was not minted here */
export function requireVerifiedUid(v) {
  if (!isVerifiedUid(v)) throw dbError('unverified_uid', 500);
  return v.uid;
}
