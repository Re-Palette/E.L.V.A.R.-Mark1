// Prompt placeholders. Prompt text carries {{U}} / {{A}} ... and is filled from the profile at the point of use.
import { DEFAULT_PROFILE } from './defaults.js';

import { tzLabel, offsetLabel } from '../../shared/tz.js';

const safeOffset = (tz, now) => { try { return offsetLabel(tz, now); } catch { return '+00:00'; } };

/** -> { A, AS, AX, U, UN, UR, TZ, TZ_LABEL, TZ_OFFSET, CITY, TODAY } */
export function promptVars(profile = DEFAULT_PROFILE, now = Date.now()) {
  const a = profile.assistant || DEFAULT_PROFILE.assistant;
  const o = profile.owner || DEFAULT_PROFILE.owner;
  const l = profile.locale || DEFAULT_PROFILE.locale;
  const h = profile.home || DEFAULT_PROFILE.home;
  let today = '';
  try { today = new Intl.DateTimeFormat('sv-SE', { timeZone: l.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); } catch { today = new Date(now).toISOString().slice(0, 10); }
  return {
    A: a.displayName, AS: a.spokenName, AX: a.expansion || '',
    U: o.address, UN: o.name, UR: o.addressReading || o.address,
    TZ: l.timeZone, TZ_LABEL: tzLabel(l.timeZone), TZ_OFFSET: safeOffset(l.timeZone, now), CITY: h.city, TODAY: today,
  };
}

/** Replace {{KEY}}. Unknown keys are left as they are (a test scans for leftovers). */
export function fill(text, vars) {
  return String(text ?? '').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
