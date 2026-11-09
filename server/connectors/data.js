// The ONLY place that knows where connector data lives and how it is named. On the platform every piece of it belongs to ONE user and sits behind Row Level
// Security (docs/ELVAR_MULTIUSER.md 5.1, 8.1):
//   manifests + tools (the pinned hash, the approval choice, the exposure)   app.connectors / app.connector_tools   (repos r.connectors)
//   secrets (bearer token, header value, OAuth client secret)                app.user_secrets  `cx:<connector id>:auth` / `cx:<id>:oauthSecret`   (envelope-encrypted, the DEK)
//   OAuth tokens of an MCP connector                                         app.oauth_tokens  provider `cx:<connector id>`                         (envelope-encrypted, the DEK)
//   MCP session ids, refresh locks                                           app.kv_ephemeral  `mcpsess:<id>` / `cxrefresh:<id>`                    (short TTL)
//   per-minute call counters                                                 app.rate_limits   bucket `cx:<id>`                                     (server/auth/rate-limit.js)
// Everything outside this file reaches them through the signed-in user's `cfg.db(fn)` (their own asUser transaction), never through a global store.
// Nothing here is shared between users: there is no owner scope any more.
export const EXPORT_FORMAT = 'elvar-connectors-v1';

export const secretName = (id, what = 'auth') => `cx:${id}:${what}`;
export const providerOf = (id) => `cx:${id}`;
export const kvSessionKey = (id) => `mcpsess:${id}`;
export const kvRefreshLockKey = (id) => `cxrefresh:${id}`;
export const getSecret = (secrets, id, what = 'auth') => (secrets?.[secretName(id, what)] ? String(secrets[secretName(id, what)]) : '');
/** { 'cx:<id>:auth': value, 'cx:<id>:oauthSecret': value } for the given connectors, read through `getter(id, what)` (the request configuration's cxSecret). */
export const secretsMap = (connectors, getter) => Object.fromEntries(connectors.flatMap((c) => [[secretName(c.id), getter(c.id, 'auth')], [secretName(c.id, 'oauthSecret'), getter(c.id, 'oauthSecret')]]));

/** Everything the user may take with them: no secret, no token, no key. */
export function exportConnectors(connectors, secrets, userId) {
  return {
    format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), user: userId,
    connectors: (connectors || []).map((c) => ({
      id: c.id, slug: c.slug, name: c.name, type: c.type, enabled: c.enabled, description: c.description || '', mcp: c.mcp || null, http: c.http || null,
      auth: { ...c.auth, secretSet: Boolean(getSecret(secrets, c.id)), clientSecretSet: Boolean(getSecret(secrets, c.id, 'oauthSecret')) },   // whether a secret exists, never its value
      network: c.network, grantAgents: c.grantAgents || [], limits: c.limits, syncedAt: c.syncedAt || null, serverInfo: c.serverInfo || null,
      tools: (c.tools || []).map((t) => ({ ...t })),                                                                                          // includes each tool's pinned hash and the user's approval choices
    })),
    note: '認証の値（トークン・シークレット）と OAuth のトークンは含まれません。取り込むときは、認証をもう一度設定してください',
  };
}

/**
 * Remove one connector with everything that belongs to it, inside the user's transaction `r`: the connector (its tools cascade), its secrets and its OAuth token.
 * (The provider-side revocation of the token is the caller's job: it needs the network, and a transaction must not wait for it.)
 */
export async function purgeConnectorData(r, ring, id) {
  await r.connectors.del(id);
  for (const s of await r.secrets.list()) if (s.name.startsWith(`cx:${id}:`)) await ring.deleteSecret(r, s.name);
  await r.oauthTokens.del(providerOf(id));
}
/** Every connector of the user (the "delete all" button and the account's "disconnect everything"). @returns {Promise<{connectors:number, secrets:number, tokens:number}>} */
export async function deleteAllConnectors(r, ring) {
  let secrets = 0, tokens = 0;
  for (const s of await r.secrets.list()) if (s.name.startsWith('cx:')) { await ring.deleteSecret(r, s.name); secrets++; }
  for (const t of await r.oauthTokens.list()) if (t.provider.startsWith('cx:')) { await r.oauthTokens.del(t.provider); tokens++; }
  const connectors = await r.connectors.delAll();
  return { connectors, secrets, tokens };
}
