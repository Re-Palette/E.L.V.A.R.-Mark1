// The pending OAuth flows of ONE user, as the small interface server/oauth/flow.js uses: { put, begin, settle, get, take }.
//   pendingFor(run)               run = (fn) => Promise: runs fn(repos) as the user (cfg.db / ctx.db). Each call is its own transaction, so the network
//                                 exchange in the middle of a callback never holds a transaction open.
//   openPendingByState(db, provider) for the callback: no token, only the state. Finds the owner of that state's hash (a definer function) and returns that user's
//                                 pending interface; every later step runs as THAT user and sees only their rows.
// The user id found this way is minted a VerifiedUid 'oauth_pending' (server/db/verified-uid.js): the only way an id that did not come from a token reaches asUser().
import { mintVerifiedUid } from '../db/verified-uid.js';

export const pendingFor = (run) => ({
  put: (a) => run((r) => r.oauthPending.put(a)),
  begin: (h, provider) => run((r) => r.oauthPending.begin(h, provider)),
  settle: (h, a) => run((r) => r.oauthPending.settle(h, a)),
  get: (h) => run((r) => r.oauthPending.get(h)),
  take: (h) => run((r) => r.oauthPending.take(h)),
});

/** @param {{system:{oauthPendingOwner:Function}, asUser:Function}} db  @param {'google'|'mcp'} provider the kind of callback asking: a state of another kind is not found
 *  @returns {(stateHash:Buffer) => Promise<object|null>} */
export const openPendingByState = (db, provider) => async (stateHash) => {
  if (provider !== 'google' && provider !== 'mcp') throw new Error('openPendingByState: provider is required');
  const uid = await db.system.oauthPendingOwner(stateHash, provider);
  if (!uid) return null;
  const v = mintVerifiedUid(uid, 'oauth_pending');
  return pendingFor((fn) => db.asUser(v, fn));
};
