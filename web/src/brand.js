// Brand and owner-address strings for the UI and for text that is sent to the voice model.
// Defaults are neutral; the profile (saved by the setup flow as `elvar_profile_cache`) overrides them.
const DEFAULTS = { name: 'E.L.V.A.R.', spokenName: 'エルヴァー', ownerAddress: 'ご主人様' };

const PROFILE_KEY = 'elvar_profile_cache';
let mem = null;   // the profile of this page load (also when localStorage is not available)

/** Save the server profile (GET /api/elvar/session). Read live by brand() / ownerAddress() / timeZone(): no reload needed. */
export function setProfileCache(p) {
  mem = p && typeof p === 'object' ? p : null;
  try { if (mem) localStorage.setItem(PROFILE_KEY, JSON.stringify(mem)); else localStorage.removeItem(PROFILE_KEY); } catch {}
}
export const profileCache = () => cached();
/** HTML-escaped, for text that goes into innerHTML. */
export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ownerAddressHtml = () => escHtml(ownerAddress());

function cached() {
  if (mem) return mem;
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

export function brand() {
  const a = cached()?.assistant || {};
  return { name: a.displayName || DEFAULTS.name, spokenName: a.spokenName || DEFAULTS.spokenName, ownerAddress: ownerAddress() };
}

/** The owner's IANA time zone (profile cache), 'Asia/Tokyo' before setup. */
export function timeZone() {
  const z = cached()?.locale?.timeZone;
  try { if (z) { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } } catch { /* fall through */ }
  return 'Asia/Tokyo';
}

export function ownerAddress() {
  return cached()?.owner?.address || DEFAULTS.ownerAddress;
}

/** profile.features (finance, shift, courses, build, humanProtocol, notifications); before setup: the defaults. */
export function features() {
  return { finance: true, shift: false, courses: false, build: false, humanProtocol: true, notifications: true, ...(cached()?.features || {}) };
}
