// One error type for everything a connector can go wrong with. `message` is Japanese and safe to show the owner (never a secret, never raw remote text
// beyond a short cleaned excerpt); `status` is what the tool endpoint answers.
import { cleanMessage } from './manifest.js';
import { SafeFetchError } from '../net/safe-fetch.js';

export class ConnectorError extends Error {
  constructor(code, message, status = 502, extra = {}) { super(message); this.name = 'ConnectorError'; this.code = code; this.status = status; Object.assign(this, extra); }
}
/** Anything thrown while talking to a connector -> a ConnectorError with a message the owner can read. */
export function toConnectorError(e) {
  if (e instanceof ConnectorError) return e;
  if (e instanceof SafeFetchError) return new ConnectorError(e.code === 'timeout' ? 'timeout' : e.code, cleanMessage(e.message), e.code === 'timeout' ? 504 : e.code === 'network' || e.code === 'dns_failed' ? 502 : 400);
  return new ConnectorError('error', cleanMessage(e?.message || '連携アプリでエラーが起きました'), 502);
}
