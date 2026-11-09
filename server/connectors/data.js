// The ONLY place that knows where connector data lives and how its keys are named: manifests, secrets, pinned tool hashes (inside the manifests),
// OAuth tokens, MCP session ids, refresh locks and rate-limit counters. Everything else in server/connectors/ goes through `scope()`.
//
// Today there is one owner, so the prefix is the existing `elvar:v1:` (keys are unchanged). ELVAR is to become a shared platform where every user has
// their own connections: then `currentScope()` is the single function that has to return the signed-in user's scope (prefix `elvar:v1:u:<userId>:` and
// that user's vault doc). Nothing outside this file builds a connector key by hand.
import { currentConfig } from '../config/resolve.js';

export const OWNER_ID = 'owner';
const USER_RE = /^[a-z0-9_-]{1,64}$/;
export const EXPORT_FORMAT = 'elvar-connectors-v1';

/** @param {string} [userId] */
export function scope(userId = OWNER_ID) {
  if (!USER_RE.test(String(userId))) throw new Error('bad_user');
  const prefix = userId === OWNER_ID ? 'elvar:v1:' : `elvar:v1:u:${userId}:`;
  const secretName = (id, what = 'auth') => `cx:${id}:${what}`;
  return {
    userId, prefix,
    // ---- store keys
    tokKey: (id) => `${prefix}tok:cx:${id}`,                  // OAuth tokens (sealed under the connector key)
    sessKey: (id) => `${prefix}mcpsess:${id}`,                // MCP session id (short TTL)
    refreshLockKey: (id) => `${prefix}cxrefresh:${id}`,
    rateKey: (id, minute) => `${prefix}rl:cx:${id}:${minute}`,
    // ---- inside the user's vault doc
    secretName,
    getSecret: (secrets, id, what = 'auth') => (secrets?.[secretName(id, what)] ? String(secrets[secretName(id, what)]) : ''),
    connectorsOf: (doc) => (Array.isArray(doc?.connectors) ? doc.connectors : []),
    setSecret(d, id, what, value) { d.secrets = d.secrets || {}; if (value === null || value === undefined || value === '') delete d.secrets[secretName(id, what)]; else d.secrets[secretName(id, what)] = value; },
    purgeSecrets(d, id) { for (const k of Object.keys(d.secrets || {})) if (k.startsWith(`cx:${id}:`)) delete d.secrets[k]; },
    secretsMap: (connectors, getter) => Object.fromEntries(connectors.flatMap((c) => [[secretName(c.id), getter(c.id, 'auth')], [secretName(c.id, 'oauthSecret'), getter(c.id, 'oauthSecret')]])),
  };
}
/** The scope of the current request. The single switch point for per-user data. */
export const currentScope = () => scope(currentConfig().auth?.userId || OWNER_ID);   // a signed-in user's request is scoped to that user, never to the owner

/** Everything the owner may take with them: no secret, no token, no vault key. */
export function exportConnectors(doc, s = currentScope()) {
  const secrets = doc?.secrets || {};
  return {
    format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), user: s.userId,
    connectors: s.connectorsOf(doc).map((c) => ({
      id: c.id, slug: c.slug, name: c.name, type: c.type, enabled: c.enabled, description: c.description || '', mcp: c.mcp || null, http: c.http || null,
      auth: { ...c.auth, secretSet: Boolean(s.getSecret(secrets, c.id)), clientSecretSet: Boolean(s.getSecret(secrets, c.id, 'oauthSecret')) },   // whether a secret exists, never its value
      network: c.network, grantAgents: c.grantAgents || [], limits: c.limits, syncedAt: c.syncedAt || null, serverInfo: c.serverInfo || null,
      tools: (c.tools || []).map((t) => ({ ...t })),                                                                                                   // includes each tool's pinned hash and the owner's approval choices
    })),
    note: '認証の値（トークン・シークレット）と OAuth のトークンは含まれません。取り込むときは、認証をもう一度設定してください',
  };
}
