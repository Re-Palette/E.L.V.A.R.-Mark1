// Convenience for server code: fill placeholders from the profile of the current request (or the default profile).
import { currentConfig } from '../config/resolve.js';
import { promptVars, fill } from './vars.js';

export const currentProfile = () => currentConfig().profile;
export const currentVars = (now) => promptVars(currentProfile(), now);
/** Fill {{U}} / {{A}} ... in text with the current profile. */
export const P = (text) => fill(text, currentVars());
export const U = () => currentVars().U;
export const UR = () => currentVars().UR;
export const A = () => currentVars().A;
export const AS = () => currentVars().AS;
/** The owner's time zone (IANA id) for the current request. */
export const TZ = () => currentProfile().locale?.timeZone || 'Asia/Tokyo';
