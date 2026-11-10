// What the browser does with the `upload` part of the answer of /api/elvar/files/reserve: POST the bytes to Storage with the user's OWN access token. In the tests the
// fake Storage's HTTP layer is skipped (it has its own test); this calls the same write rule (uploadAs) as that layer, as the given user.
import assert from 'node:assert/strict';

/** The object path a reserve answer's upload target points at. */
export const pathOfUpload = (up) => { const m = /\/storage\/v1\/object\/user-files\/([^?#]+)/.exec(String(up?.url || '')); assert.ok(m, `not an upload target: ${up?.url}`); return m[1].split('/').map(decodeURIComponent).join('/'); };

/** @param {{uploadAs: Function}} st the (fake) storage  @param {string} uid who writes (their access token)  @param {{url:string, method:string, userToken:boolean, headers:object}} up */
export function browserUpload(st, uid, up, bytes) {
  assert.equal(up.method, 'POST'); assert.equal(up.userToken, true, 'the browser must send its own access token'); assert.ok(!/[?&]token=/.test(up.url), 'there is no signed upload link');
  return st.uploadAs(uid, pathOfUpload(up), bytes, { contentType: up.headers['content-type'] });
}
