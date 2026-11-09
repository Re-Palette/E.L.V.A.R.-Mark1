// The process-wide keyring (per-user DEKs under the platform KEK, server/crypto/envelope.js). Created on first use, so importing this never needs ELVAR_KEK.
import { createKeyring, envKekProvider } from '../crypto/envelope.js';

let ring = null, override = null;
export const getKeyring = (env = process.env) => override || (ring ||= createKeyring({ kek: envKekProvider(env) }));
/** Tests: use this keyring (any object shaped like createKeyring's result). Pass null to restore. */
export function _setKeyringForTests(k) { override = k; ring = null; }
