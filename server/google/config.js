// Google integration config. Secrets only from the environment (never in Git, never sent to the browser).
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN   (see docs/GOOGLE_INTEGRATION.md)
//   GOOGLE_TIMEZONE   default Asia/Tokyo
//   GOOGLE_API_MOCK_ORIGIN  (tests only) send every Google call to this origin instead
import { cfgEnv } from '../config/resolve.js';
export function googleConfig(env = cfgEnv) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: env.GOOGLE_REFRESH_TOKEN || '',
    timeZone: env.GOOGLE_TIMEZONE || 'Asia/Tokyo',
    mock: env.GOOGLE_API_MOCK_ORIGIN || '',
  };
}
export const googleConfigured = (cfg = googleConfig()) => Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
/** Enough to start the in-browser login (no refresh token yet). */
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
};
export function base(name, cfg = googleConfig()) {
  return cfg.mock ? `${cfg.mock}/${name}` : REAL[name];
}

/** OAuth scopes the helper script asks for (least privilege that still allows the approved write actions). */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',          // events: read / create / change / delete
  'https://www.googleapis.com/auth/gmail.modify',      // mail: read, drafts, send, trash (NOT permanent delete)
  'https://www.googleapis.com/auth/drive',             // Drive: search/read/create/trash/share
  'https://www.googleapis.com/auth/documents',         // Docs: append text
  'https://www.googleapis.com/auth/spreadsheets',      // Sheets: read/update/append
  'https://www.googleapis.com/auth/tasks',             // Tasks
  'https://www.googleapis.com/auth/contacts.readonly', // Contacts: read only
];
