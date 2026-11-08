// Wake-up music: the owner's own audio file (kept ONLY in this browser's IndexedDB), played from the 2nd clap — once by default, optional loop.
// Streams from a Blob through a media element (no full decode in memory) -> GainNode for smooth fades / ducking under the voice.
const DB = 'elvar-bgm', STORE = 'bgm', KEY = 'track';
export const SETTINGS_KEY = 'elvar_bgm';           // JSON {enabled, volume, duck}
export const REV_KEY = 'elvar_bgm_rev';            // bumped by the settings page whenever the track changes
export const DEFAULTS = { enabled: true, volume: 0.8, duck: 0.3, loop: false };   // loop:false = play once at wake-up, then end

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function getTrack() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => { const q = db.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => resolve(q.result || null); q.onerror = () => resolve(null); });
  } catch { return null; }
}

/** @returns {Promise<{name:string,size:number}|null>} */
export async function getTrackInfo() {
  const rec = await getTrack();
  return rec && rec.blob ? { name: rec.name || 'track', size: rec.blob.size } : null;
}
export async function getTrackBlob() { const r = await getTrack(); return r && r.blob ? r : null; }
const bumpRev = () => { try { localStorage.setItem(REV_KEY, String(Date.now())); } catch {} };
export async function saveTrack(file) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name: file.name, type: file.type || 'audio/mpeg', blob: file, savedAt: Date.now() }, KEY);
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
  });
  bumpRev();
}
export async function deleteTrack() {
  const db = await openDb();
  await new Promise((resolve) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); tx.oncomplete = tx.onerror = resolve; });
  bumpRev();
}
export function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }

export class Bgm {
  constructor() {
    this.el = null; this.ctx = null; this.gain = null; this.url = null;
    this.playing = false; this.ducked = false; this.name = ''; this.onchange = null;
    this.rev = null;
    addEventListener('storage', (e) => { if (e.key === REV_KEY || e.key === SETTINGS_KEY) { if (e.key === REV_KEY) this.dispose(); else if (this.playing) { this.applyGain(0.2); if (this.el) this.el.loop = !!loadSettings().loop; } } });
  }

  /** Called after the track/settings changed in THIS tab (the `storage` event only fires in other tabs). */
  refresh(trackChanged) {
    if (trackChanged) this.dispose();
    else if (this.playing) { this.applyGain(0.2); if (this.el) this.el.loop = !!loadSettings().loop; }
  }

  dispose() {
    this.stop({ fade: 0.1 });
    try { this.el?.pause(); } catch {}
    try { this.ctx?.close(); } catch {}
    if (this.url) URL.revokeObjectURL(this.url);
    this.el = this.ctx = this.gain = this.url = null;
  }

  async hasTrack() { return !!(await getTrack()); }

  /** Load the saved track and build the audio graph. Call while audio is allowed (standby armed) so a later wake can play. */
  async prepare() {
    if (this.el) { await this.ctx.resume().catch(() => {}); return true; }
    const rec = await getTrack();
    if (!rec || !rec.blob) return false;
    this.name = rec.name || 'track';
    this.url = URL.createObjectURL(rec.blob);
    const el = new Audio();
    el.src = this.url; el.loop = false; el.preload = 'auto';
    el.addEventListener('ended', () => { if (this.playing) { this.playing = false; this.onchange?.(false); } });   // finished on its own
    this.el = el;
    this.ctx = new AudioContext();                         // default sample rate (music quality), separate from the 24 kHz voice context
    const src = this.ctx.createMediaElementSource(el);
    this.gain = this.ctx.createGain(); this.gain.gain.value = 0;
    src.connect(this.gain); this.gain.connect(this.ctx.destination);
    await this.ctx.resume().catch(() => {});
    return true;
  }

  /** Start (or keep) looping. @returns {Promise<boolean>} true if audio is playing */
  async start() {
    const s = loadSettings();
    if (!s.enabled) return false;
    if (this.playing) return true;
    try {
      if (!(await this.prepare())) return false;
      await this.ctx.resume();
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.applyGain(0.15);
      this.el.loop = !!s.loop;
      this.el.currentTime = 0;
      await this.el.play();
      this.playing = true; this.onchange?.(true);
      return true;
    } catch (e) {
      console.warn('[bgm] could not start (browser blocked audio or no track)', e?.message ?? e);
      return false;
    }
  }

  stop({ fade = 0.4 } = {}) {
    if (!this.playing) return;
    this.playing = false; this.onchange?.(false);
    try {
      const t = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(this.gain.gain.value, t);
      this.gain.gain.linearRampToValueAtTime(0, t + fade);
    } catch {}
    const el = this.el;
    setTimeout(() => { if (!this.playing && el) { try { el.pause(); el.currentTime = 0; } catch {} } }, fade * 1000 + 80);
  }

  /** Lower the music while the voice/mic is active. */
  setDuck(on) {
    on = !!on;
    if (this.ducked === on) return;
    this.ducked = on;
    if (this.playing) this.applyGain(0.25);
  }

  applyGain(ramp) {
    if (!this.gain) return;
    const s = loadSettings();
    const v = Math.max(0, Math.min(1, s.volume)) * (this.ducked ? Math.max(0, Math.min(1, s.duck)) : 1);
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(v, t + Math.max(ramp, 0.6));   // slow, smooth moves (no pumping)
  }
}
