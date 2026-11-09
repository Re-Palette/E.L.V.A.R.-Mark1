// Per-user, per-instance state for modules that keep something in memory between requests (note caches, "this API is down" marks, retired-model marks).
// A warm serverless instance serves many users one after another, so a module-level variable would hand one user's cache to the next (principle 3).
// Every such state goes through here: it is keyed by the signed-in user's id (from the request configuration), and outside a request (scripts, tests)
// there is a single 'none' state. Bounded: the least recently used users are dropped.
import { currentConfig } from '../config/resolve.js';

const MAX_USERS = 200;
const stores = new Map();   // name -> Map(uid -> state)

export const currentUserKey = () => currentConfig().auth?.userId || 'none';

/** @param {string} name which state  @param {() => any} init  makes a fresh state for a user */
export function userState(name, init) {
  let m = stores.get(name); if (!m) stores.set(name, (m = new Map()));
  const k = currentUserKey();
  let s = m.get(k);
  if (s === undefined) { s = init(); }
  else m.delete(k);            // re-insert: most recently used last
  m.set(k, s);
  while (m.size > MAX_USERS) m.delete(m.keys().next().value);
  return s;
}
export const _resetUserState = () => stores.clear();
