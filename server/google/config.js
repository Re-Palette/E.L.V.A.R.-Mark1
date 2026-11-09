// Google integration config. Secrets only from the environment (never in Git, never sent to the browser).
// On the platform (decision O2) there is NO shared Google OAuth client: every user enters their OWN client id (a setting) and secret (an encrypted secret)
// in Settings, connects, and the refresh token is kept in their own row of app.oauth_tokens (cfg.google, loaded by server/auth/load-user-config.js).
// Outside a request (scripts, tests) the environment variables still work:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN   (see docs/GOOGLE_INTEGRATION.md)
//   GOOGLE_TIMEZONE   default: the profile's time zone
//   GOOGLE_API_MOCK_ORIGIN  (tests and the local dev stack only) send every Google call to this origin instead
import { cfgEnv, currentConfig } from '../config/resolve.js';
import { TZ } from '../profile/index.js';

// Where the login comes from, in order: the vault (connected in the app: `cfg.google`, bound to the client id it was issued for), then the
// GOOGLE_REFRESH_TOKEN environment variable (self-hosters; scopes unknown = every tool is offered).
export function googleConfig(env = cfgEnv, tokOverride) {
  const clientId = env.GOOGLE_CLIENT_ID || '', clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const tok = tokOverride !== undefined ? tokOverride : env === cfgEnv ? currentConfig().google : null;
  const mine = Boolean(tok?.refreshToken) && tok.clientId === clientId;            // a login issued for a different client id cannot be used
  const envToken = env.GOOGLE_REFRESH_TOKEN || '';
  const refreshToken = mine ? tok.refreshToken : envToken;
  const reauth = mine ? tok.status === 'reauth_required' : Boolean(tok?.refreshToken) && !envToken;   // client id changed after connecting = connect again
  return {
    clientId, clientSecret, refreshToken,
    scopes: mine ? new Set(tok.scopes || []) : null,                                // null = unknown: nothing is filtered
    fromVault: mine, reauth, reauthReason: mine ? tok.reason || '' : reauth ? 'client_changed' : '',
    timeZone: env.GOOGLE_TIMEZONE || TZ(),
    mock: env.GOOGLE_API_MOCK_ORIGIN || devMock(),
  };
}
/** The local dev stack (ELVAR_DEV_AUTH=1, never on Vercel / in production) may point Google calls at a mock; a user's request never reads the platform environment otherwise. */
const devMock = (e = process.env) => (e.ELVAR_DEV_AUTH === '1' && !e.VERCEL && e.NODE_ENV !== 'production' ? e.GOOGLE_API_MOCK_ORIGIN || '' : '');
export const googleConfigured = (cfg = googleConfig()) => Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
/** The saved login was refused by Google (revoked, expired, a 7-day "Testing" token) or belongs to another client id: the owner must connect again. */
export const googleReauthRequired = (cfg = googleConfig()) => Boolean(cfg.reauth);
/** 'unconfigured' (no client id/secret) | 'client_only' (ready to connect) | 'connected' | 'reauth_required' (connect again) */
export const googleState = (cfg = googleConfig()) => (!cfg.clientId || !cfg.clientSecret ? 'unconfigured' : !cfg.refreshToken && !cfg.reauth ? 'client_only' : cfg.reauth ? 'reauth_required' : 'connected');
/** Enough to start the in-app login (no refresh token yet). */
export const googleClientConfigured = (cfg = googleConfig()) => Boolean(cfg.clientId && cfg.clientSecret);

const REAL = {
  oauth: 'https://oauth2.googleapis.com/token',
  calendar: 'https://www.googleapis.com/calendar/v3',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  drive: 'https://www.googleapis.com/drive/v3',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3',
  sheets: 'https://sheets.googleapis.com/v4',
  docs: 'https://docs.googleapis.com/v1',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
  people: 'https://people.googleapis.com/v1',
  revoke: 'https://oauth2.googleapis.com/revoke',
};
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export function base(name, cfg = googleConfig()) {
  return cfg.mock ? `${cfg.mock}/${name}` : REAL[name];
}

/**
 * The products the owner can switch on in Settings, and the OAuth scope each one needs (least privilege that still allows the approved write actions).
 * `write` is the full scope, `read` the read-only one (the "読み取りのみ" choice). Contacts are read-only anyway.
 */
export const SERVICES = [
  { id: 'calendar', label: 'カレンダー', write: 'https://www.googleapis.com/auth/calendar', read: 'https://www.googleapis.com/auth/calendar.readonly' },            // events: read / create / change / delete
  { id: 'gmail', label: 'Gmail', write: 'https://www.googleapis.com/auth/gmail.modify', read: 'https://www.googleapis.com/auth/gmail.readonly' },                 // mail: read, drafts, send, trash (NOT permanent delete)
  { id: 'drive', label: 'ドライブ', write: 'https://www.googleapis.com/auth/drive', read: 'https://www.googleapis.com/auth/drive.readonly' },                   // Drive: search/read/create/trash/share
  { id: 'docs', label: 'ドキュメント', write: 'https://www.googleapis.com/auth/documents', read: 'https://www.googleapis.com/auth/documents.readonly' },        // Docs: append text
  { id: 'sheets', label: 'スプレッドシート', write: 'https://www.googleapis.com/auth/spreadsheets', read: 'https://www.googleapis.com/auth/spreadsheets.readonly' }, // Sheets: read/update/append
  { id: 'tasks', label: 'タスク', write: 'https://www.googleapis.com/auth/tasks', read: 'https://www.googleapis.com/auth/tasks.readonly' },                      // Tasks
  { id: 'contacts', label: '連絡先', write: 'https://www.googleapis.com/auth/contacts.readonly', read: 'https://www.googleapis.com/auth/contacts.readonly' },     // Contacts: read only
];
export const SERVICE_IDS = SERVICES.map((s) => s.id);
/** Every full scope (what the old helper script asked for). */
export const SCOPES = SERVICES.map((s) => s.write);

/** "calendar,gmail" -> ['calendar','gmail'] (known ids only, in catalogue order). Empty / missing = every product. */
export function parseServices(v) {
  const want = new Set(String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const list = SERVICE_IDS.filter((id) => want.has(id));
  return want.size ? list : [...SERVICE_IDS];
}
export const scopesFor = ({ services, readonly = false } = {}) => parseServices(Array.isArray(services) ? services.join(',') : services).map((id) => { const s = SERVICES.find((x) => x.id === id); return readonly ? s.read : s.write; });
export const serviceOfTool = (name) => /^(calendar|gmail|drive|sheets|docs|tasks|contacts)_/.exec(String(name))?.[1] || null;

/**
 * Is this tool allowed by the scopes Google actually granted? A write tool needs the full scope; a read tool is fine with the read-only one.
 * Tools of other things (notes, finance ...) and an unknown scope list (environment-variable login) are never filtered.
 */
export function googleToolAllowed(tool, granted = googleConfig().scopes) {
  const id = serviceOfTool(tool.name); if (!id || !granted) return true;
  const s = SERVICES.find((x) => x.id === id);
  return granted.has(s.write) || (tool.kind === 'read' && granted.has(s.read));
}
export const serviceLabel = (name) => SERVICES.find((x) => x.id === serviceOfTool(name))?.label || 'Google';
