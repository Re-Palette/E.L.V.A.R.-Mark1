// Relay for phone notifications -> PC, per user (docs/ELVAR_MULTIUSER.md 8.4). The phone encrypts each notification (AES-256-GCM, key = PBKDF2 of the
// user's own NOTIF_SECRET, "elvar-notif-v1"); this server and the database only ever hold ciphertext and a timestamp, for 3 days, at most 200 items.
// Who may call it (api/notif.js): the signed-in user (reads, clears, status) or the user's own device token (scope notif:push to upload, notif:pull to
// download; the device's repos contain nothing but the relay, server/auth/with-user.js limitDeviceRepos). The user comes from the token, never from the request.
const forbidden = () => ({ status: 403, body: { error: 'forbidden' } });

/** @param {{ user: object, method: string, query?: object, body?: object }} o  @returns {Promise<{status:number, body:object}>} */
export async function handleNotif({ user, method, query = {}, body = {} }) {
  if (method === 'GET') {
    if (query.status) return { status: 200, body: { configured: true, reachable: true, stored: await user.db((r) => (r.notif.count ? r.notif.count() : 0)), keepDays: 3 } };
    const since = Number(query.since) || 0;
    return { status: 200, body: { items: await user.db((r) => (r.notif.pull ? r.notif.pull({ since }) : [])) } };
  }
  if (method === 'POST') {
    if (body.action === 'clear') { const n = await user.db((r) => (r.notif.clear ? r.notif.clear() : null)); return n === null ? forbidden() : { status: 200, body: { cleared: true } }; }
    const stored = await user.db((r) => (r.notif.push ? r.notif.push(Array.isArray(body.items) ? body.items : []) : null));
    return stored === null ? forbidden() : { status: 200, body: stored };
  }
  return { status: 405, body: { error: 'method_not_allowed' } };
}
