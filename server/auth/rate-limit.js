// Fixed-window counters in Postgres (app.rl_hit). Signed-in callers are counted per user, signed-out callers per address hash.
import { getDb } from '../db/index.js';
import { addrHash } from './client-ip.js';

/** @returns {Promise<boolean>} true while the caller is within `limit` hits per `windowSec`. Fails OPEN on a database problem (the caller has other checks). */
export async function rateLimit(req, bucket, limit, windowSec) {
  try { return (await (await getDb()).system.rlHit({ bucket, who: addrHash(req), windowSec })) <= limit; }
  catch (e) { console.error('[elvar] rate limit unavailable:', e?.code || e?.message); return true; }
}
