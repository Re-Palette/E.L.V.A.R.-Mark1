// Brand and owner-address strings for the UI and for text that is sent to the voice model.
// Defaults are neutral; the profile (saved by the setup flow as `elvar_profile_cache`) overrides them.
const DEFAULTS = { name: 'E.L.V.A.R.', spokenName: 'エルヴァー', ownerAddress: 'ご主人様' };

function cached() {
  try {
    const p = JSON.parse(localStorage.getItem('elvar_profile_cache') || 'null');
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

export function brand() {
  const a = cached()?.assistant || {};
  return { name: a.displayName || DEFAULTS.name, spokenName: a.spokenName || DEFAULTS.spokenName, ownerAddress: ownerAddress() };
}

export function ownerAddress() {
  return cached()?.owner?.address || DEFAULTS.ownerAddress;
}
