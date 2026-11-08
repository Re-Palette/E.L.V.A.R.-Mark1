import { mountHud } from './hud/index.js';
import { GeminiLiveSession } from './live/gemini-live.js';
import { ClapStandby, greetingLine } from './live/clap-standby.js';
import { getGreeting, putGreeting } from './live/greeting-cache.js';
import { generateGreeting } from './live/greeting-gen.js';
import { Bgm } from './live/bgm.js';
import { usage } from './usage.js';
import { initAgents } from './agents.js';
import { initBuilds } from './builds.js';
import { initPredict } from './predict.js';
import { initConvLog } from './conv-log.js';
import { initSystemCheck } from './system-check.js';
import { initFillers } from './live/fillers.js';
import { initHudLive, neutralData } from './hud-live.js';
import { initNotifications } from './notifications.js';
import { initInbox } from './inbox.js';
import { briefingPrepDue, learningDue, securityDue, reviewDue } from './briefing-prep.js';
import { initSettingsPanel } from './settings-panel.js';
import { createApproval } from './approval.js';
import { initGoogleTools } from './google-tools.js';
import { initBrainViewer } from './brain-viewer.js';
import { detectProtocolCommand, detectHandCommand, createTranscriptWatcher } from './human-protocol.js';
import { ownerAddress, brand, features, profileCache, timeZone } from './brand.js';
import { bootAuth, currentSession } from './elvar/auth.js';
import { initGoogleWatch } from './google-watch.js';
import { localDate, localMinutes } from '../../shared/tz.js';

const STANDBY_KEY = 'elvar_standby'; // '1' = on, '0' = opted out, unset = on automatically once the mic permission is granted
const SENS_KEY = 'elvar_clap_sensitivity';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// ?standby=0 turns the clap standby off for good; ?standby=1 turns it on.
const qs = new URLSearchParams(location.search);
if (qs.get('standby') === '0') store.set(STANDBY_KEY, '0');
if (qs.get('standby') === '1') store.set(STANDBY_KEY, '1');

// Opened from the Android lock screen (?locked=1): personal tools stay off until the phone is unlocked (the apk calls __elvarLocked(false)).
window.__elvarDeviceLocked = qs.get('locked') === '1';
window.__elvarLocked = (v) => { window.__elvarDeviceLocked = !!v; if (!v) maybeBrief?.(); };

// Before anything talks to the server: setup wizard (first run), or the sign-in screen (new device / revoked token). Loads the profile (brand, time zone,
// greeting, features) into the cache that brand.js reads. ?mockhud=1 (design review) skips it.
const session = qs.get('mockhud') === '1' ? null : await bootAuth();

// The cards show real data (hud-live.js). ?mockhud=1 keeps the design-review sample content.
const hud = mountHud(document.getElementById('hud-root'), qs.get('mockhud') === '1' ? {} : { data: neutralData() });
// Voice speed (pitch preserved): default 1.2x. Override with ?speed=1.5 (saved) or localStorage.elvar_speech_rate; 1 = as generated.
const DEFAULT_SPEECH_RATE = 1.2;
if (qs.get('speed')) store.set('elvar_speech_rate', String(Number(qs.get('speed')) || DEFAULT_SPEECH_RATE));
hud.setBrand?.(brand());          // the HUD's own contract (§8): optional until the HUD implements it
hud.setFeatures?.(features());
if (session?.missing?.length) hud.setSetupRequired?.({ missing: session.missing });
const live = new GeminiLiveSession(hud, { speechRate: Number(store.get('elvar_speech_rate')) || DEFAULT_SPEECH_RATE });
const DEBUG = qs.get('clapdebug') === '1';
const bgm = new Bgm();
if (DEBUG) window.__elvar = { live, hud, bgm };   // (systemCheck is attached below)

// ---------------------------------------------------------------- ヒューマンプロトコル: E.L.V.A.R. as a humanoid made of particles
// The renderer + its particle data are loaded only the first time it is used (dynamic import).
const humanProtocol = (() => {
  let ctl = null, loading = null;
  const load = () => (loading ||= import('./human/index.js').then((m) => (ctl = m.createHumanProtocol({ hud, rootEl: document.getElementById('hud-root') }))).catch((e) => { loading = null; throw e; }));
  return {
    async start() { try { return await (await load()).start(); } catch (e) { console.error('[human protocol]', e); return false; } },
    stop() { return ctl ? ctl.stop() : false; },
    setHands(on) { return ctl ? ctl.setHands(on) : false; },
    get handsOn() { return ctl ? ctl.handsOn : true; },
    get active() { return !!ctl?.active; },
    get controller() { return ctl; },
  };
})();
if (DEBUG) window.__elvar.humanProtocol = humanProtocol;
// Prepare it while the app is idle (a few seconds after start, low priority): module, data, background, compiled shaders, uploaded buffers,
// so saying 「ヒューマンプロトコル」 starts the show on its first frame. Not on a locked phone or with data saver / 2G. ?humanpreload=0 turns it off.
if (qs.get('humanpreload') !== '0') {
  const conn = navigator.connection;
  const okNow = () => !window.__elvarDeviceLocked && document.visibilityState === 'visible' && !(conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')));
  const go = () => { if (okNow() && !humanProtocol.active) import('./human/index.js').then((m) => m.preloadHuman()).catch((e) => console.warn('[human protocol] preload:', e?.message ?? e)); };
  setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 8000 }) : go()), 4000);
}


// ---------------------------------------------------------------- standby (double clap → wake)
let waking = false, closing = false, prewarmed = false, greetPromise = null, prewarmSeq = 0;

// The screen answers at the 2nd clap; the voice waits one beat (default 700 ms). ?greetdelay=500 changes it (saved).
if (qs.get('greetdelay') !== null) store.set('elvar_greet_delay_ms', String(Math.max(0, Number(qs.get('greetdelay')) || 0)));
const IS_PHONE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
// PC: the voice follows the screen by one beat (700 ms). Phone: no beat at all, the greeting starts the instant the app opens.
const greetDelayMs = () => (store.get('elvar_greet_delay_ms') !== null ? Number(store.get('elvar_greet_delay_ms')) : IS_PHONE ? 0 : 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ?clapdebug=1 shows a live meter in the input bar (level / threshold / claps heard) to tune sensitivity.
// Typing guard: a key press in this window within the last 1.2 s means the "clap" was most likely the keyboard.
let lastKeyAt = 0;
addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);
const typing = () => Date.now() - lastKeyAt < 1200;
const dbg = { rms: 0, thr: 0, claps: 0, rejected: 0, last: '' };
let flashTimer = 0;
const standby = new ClapStandby({
  sensitivity: Number(store.get(SENS_KEY)) || Number(qs.get('clapsens')) || 1,
  debug: DEBUG,
  level: Number(store.get('elvar_clap_level')) || 0,
  onDoubleClap: () => { if (typing()) { cancelPrewarm(); return; } wake(); },
  onChange: (s) => { if (s === 'lost') armStandby(); },
  onEvent: (m) => {
    if (m.type === 'adapt') { store.set('elvar_clap_level', String(m.level)); if (m.level > 0) { hud.setPlaceholder('拍手が届きにくいようなので、感度を自動で上げました'); setTimeout(() => hud.setPlaceholder(''), 6000); } return; }
    if (m.type === 'level') {
      dbg.rms = m.rms; dbg.thr = m.thr;
      hud.setPlaceholder(`拍手メーター 音量 ${m.rms.toFixed(3)} / 反応しきい値 ${m.thr.toFixed(3)} / 拍手 ${dbg.claps}回 / 却下 ${dbg.rejected}回 ${dbg.last}`);
    } else if (m.type === 'clap') {
      dbg.claps++; if (m.ratio !== undefined) dbg.last = `(直前の拍手: 低音/高音比 ${m.ratio.toFixed(2)})`;
      hud.setStatusLabel('CLAP ✓'); clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { if (standby.active) hud.setStatusLabel('STANDBY'); }, 700);
    } else if (m.type === 'pending') {
      if (!typing()) { prewarm(); wakeUpScreen(); hud.setStatusLabel('WAKING'); }   // 2nd clap heard: the screen lights up and the window comes forward AT ONCE (confirmed 0.4 s later)
    } else if (m.type === 'rejected') {
      dbg.rejected++; dbg.last = `(却下:${m.reason}${m.ratio !== undefined ? ' 低音/高音比 ' + m.ratio.toFixed(2) : ''})`;
      if (m.reason === 'too-many') cancelPrewarm();
    }
  },
});

async function standbyEnabled() {
  const v = store.get(STANDBY_KEY);
  if (v === '1') return true;
  if (v === '0') return false;
  try { // never asked → on if the browser already has mic permission for this site
    return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted';
  } catch { return !!window.ElvarAndroid; }   // Android app WebView cannot answer this question: the app asks for the mic itself, so try
}

let gestureHooked = false;
const armState = { last: null, at: 0 };   // for the system check: why the clap standby is (not) running
async function armStandby() {
  if (closing || waking || standby.active || live.session) return;
  if (!(await standbyEnabled())) { armState.last = 'not-enabled'; armState.at = Date.now(); return; }
  const r = await standby.start();
  armState.last = r; armState.at = Date.now();
  if (r === 'on') {
    hud.setStatusLabel('STANDBY'); hud.setState('idle');
    hintIfNoExtension();
    bgm.prepare().catch(() => {}); // load the owner's wake-up music while audio is allowed
    live.prepareAudio(); // playback context is created while allowed, so the wake greeting can be heard
    ensureGreetingCached();
    setTimeout(() => fillers.ensureCached(), 4000);   // after the greeting recording
  } else if (r === 'needs-gesture') {
    hud.setStatusLabel('TAP TO ARM'); // browsers only start audio after a click/key once per page load
    if (gestureHooked) return;
    gestureHooked = true;
    const once = () => { gestureHooked = false; removeEventListener('pointerdown', once); removeEventListener('keydown', once); armStandby(); };
    addEventListener('pointerdown', once); addEventListener('keydown', once);
  } else if (r === 'denied') {
    hud.setStatusLabel('MIC BLOCKED'); // permission refused/revoked: allow the mic for this site in the browser
  } else {
    hud.setStatusLabel('MIC ERROR');
  }
}

// Browser users: without the extension a double clap can only make sound; say so once (input bar text), with the fix.
let hinted = false;
function hintIfNoExtension() {
  if (hinted || window.elvarDesktop || qs.get('clapdebug') === '1') return;
  setTimeout(() => {
    if (document.documentElement.dataset.elvarExtension === '1') return;
    hinted = true;
    const original = document.querySelector('.vh-text')?.placeholder ?? '';
    hud.setPlaceholder('拍手でウィンドウを前面に出すには拡張機能が必要です → /extension/ を開いてください');
    setTimeout(() => hud.setPlaceholder(original), 12000);
  }, 2500);
}

function nudgeUser() {
  // A web page cannot raise a hidden window; do what the browser allows.
  try { window.focus(); } catch {}
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('E.L.V.A.R.', { body: 'All systems online.', silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch {}
}

function speakFallback(line) { // only if Gemini cannot be reached: local, free, robotic
  try {
    const u = new SpeechSynthesisUtterance(line); u.lang = 'en-US'; u.rate = 1.05;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch {}
}

// 2nd clap heard (the double clap is confirmed ~0.8 s later): only prepare SILENTLY. Nothing visible, audible or costly happens until the confirmation, so a
// false pair (typing, a knock, a laugh) can never raise the window, start the music or open a Gemini session on its own.
function prewarm() {
  if (waking || live.session || prewarmed) return;
  prewarmed = true;
  live.loadCachedGreeting(greetingLine(new Date())).catch(() => null);   // warms the saved greeting recording (IndexedDB read) for the confirmed wake
}
function cancelPrewarm() { // it was applause / speech, not a double clap
  if (!prewarmed || waking) return;
  prewarmed = false; prewarmSeq++;
}

// ---- keep a recording of today's greeting on this device so the wake answer is instant ----
let genBusy = false, genRetryAt = 0;
async function ensureGreetingCached() {
  if (genBusy || waking || live.session || Date.now() < genRetryAt || store.get('elvar_pregreet') === '0') return;
  const line = greetingLine(new Date());
  const rec = await getGreeting(line);
  if (rec && (!live.cacheKey || !rec.key || rec.key === live.cacheKey)) return; // already have a current one
  genBusy = true;
  try {
    const { cacheKey, pcm } = await generateGreeting(line, () => live.fetchToken({ interactive: false }));
    await putGreeting(line, { key: cacheKey, sr: 24000, pcm });
  } catch (e) {
    console.warn('[greeting-cache] could not prepare the greeting recording:', e?.message ?? e);
    genRetryAt = Date.now() + 10 * 60_000;
  } finally { genBusy = false; }
}
if (qs.get('pregreet')) store.set('elvar_pregreet', qs.get('pregreet') === '0' ? '0' : '1');
// Safety net: if the clap listener is off although it should be on (a failed restart, a mic that was busy, a hiccup), try to arm it again.
setInterval(() => { if (!standby.active && !standby.starting && !waking && !closing && !live.session && !prewarmed && armState.last !== 'denied' && armState.last !== 'not-enabled' && armState.last !== 'needs-gesture') armStandby(); }, 15_000);
setInterval(() => { if (standby.active) ensureGreetingCached(); }, 5 * 60_000); // also covers the part of day changing

// ---- acknowledgements while thinking ("かしこまりました。" / "作成いたします。" / "作成中です。"): recorded once, played locally
const fillers = initFillers({ live, store });
setInterval(() => fillers.tick(), 200);
setInterval(() => { if (standby.active) fillers.ensureCached(); }, 60_000);

// ---- ambient look: when idle in standby the HUD dims; any activity or a wake snaps it back
let lastActivity = Date.now();
const AMBIENT_AFTER_MS = (Number(qs.get('ambient')) || 45) * 1000;
function wakeUpScreen() {
  lastActivity = Date.now(); hud.flash(); nudgeUser();
  try { window.elvarDesktop?.bringToFront?.(); } catch {} // desktop app only: the OS raises the window to the very front
  try { window.postMessage({ source: 'elvar-hud', type: 'bring-to-front' }, location.origin); } catch {} // browser extension (if installed) restores/raises this window
}
function touch() { lastActivity = Date.now(); hud.setAmbient(false); }
['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, touch, { passive: true }));
setInterval(() => {
  const idle = Date.now() - lastActivity > AMBIENT_AFTER_MS;
  hud.setAmbient(idle && standby.active && !live.session && !waking && !humanProtocol.active);
}, 1000);

// ---- scheduled briefings: the first conversation in the profile's morning window (default 05:30-08:00) or evening window (18:00-24:00), once per period
function jstNow() {
  const now = Date.now(), tz = timeZone();
  return { date: localDate(now, tz), min: localMinutes(now, tz) };
}
const hmMin = (s, d) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
function briefingWindows() {
  const b = profileCache()?.briefing || {};
  const w = (x, f, t) => ({ on: x?.enabled !== false, from: hmMin(x?.from, f), to: hmMin(x?.to, t) });
  return { morning: w(b.morning, 330, 480), evening: w(b.evening, 1080, 1440) };
}
function briefingDue() {
  const forced = qs.get('briefing');                                       // ?briefing=morning|evening forces one (for testing)
  const { date, min } = jstNow();
  const W = briefingWindows(), inW = (x) => x.on && min >= x.from && min <= (x.to >= 1439 ? 1440 : x.to);
  const kind = forced === 'morning' || forced === 'evening' ? forced : inW(W.morning) ? 'morning' : inW(W.evening) ? 'evening' : null;
  if (!kind) return null;
  const mark = `${date}-${kind}`;
  if (!forced && store.get('elvar_briefed') === mark) return null;
  return { kind, mark };
}
let briefingBusy = false;
async function maybeBrief() {
  if (window.__elvarDeviceLocked) return;   // the briefing reads calendar / mail: wait for unlock
  if (briefingBusy || !live.session) return;
  const due = briefingDue();
  if (!due) return;
  briefingBusy = true;
  store.set('elvar_briefed', due.mark);
  try {
    const dataP = googleTools.runServerTool('briefing_data', { kind: due.kind }).catch(() => null);   // fetched in parallel while the greeting finishes
    for (let i = 0; i < 150 && live.session && !live.micOn; i++) await sleep(100);   // let the greeting finish and the mic open first
    if (!live.session) { store.set('elvar_briefed', ''); return; }
    const data = await Promise.race([dataP, sleep(4000).then(() => null)]);
    const head = due.kind === 'morning' ? '[システム] 朝のブリーフィングを開始してください。挨拶は済んでいます。' : '[システム] イブニングリキャップを開始してください。挨拶は済んでいます。';
    await live.sendSystemNote(data ? `${head}\n【ブリーフィング用データ（システムが取得済み。ツールを呼ばずに、すぐにこれをもとに話し始める。取得できなかった項目は errors）】\n${JSON.stringify(data).slice(0, 14000)}` : head);
  } catch (e) { console.warn('[briefing]', e?.message ?? e); store.set('elvar_briefed', ''); }
  finally { briefingBusy = false; }
}

async function wake() {
  if (waking || (live.session && !prewarmed && !announcing)) return;
  const wasPrewarmed = prewarmed;
  waking = true; prewarmed = false; announcing = false;
  standby.stop(); // release the raw mic; the conversation opens its own (with echo cancellation)
  wakeUpScreen(); bgm.start();   // the confirmed double clap (or an assistant launch / tap): light the screen, raise the window, start the music
  const line = greetingLine(new Date());
  hud.setStatusLabel('WAKING');
  if (!greetPromise) {   // play the saved greeting from the device right now (connecting to Gemini runs in parallel)
    live.ensureConnected().catch(() => {});
    greetPromise = (async () => {
      const rec = await live.loadCachedGreeting(line);
      if (!rec) return false;                                   // none saved yet: Gemini speaks it (and we keep a copy)
      if (greetDelayMs() > 0) await sleep(greetDelayMs());
      return live.playGreetingRecord(rec);
    })().catch(() => false);
  }
  let localHit = false;
  const wakeAt = performance.now();
  // Safety net: the greeting must always be heard. If, a few seconds after the wake, nothing has played (no saved recording, Gemini silent / over its limit),
  // the browser's own voice says it.
  setTimeout(() => {
    if (localHit || live.stretchActive || live.sources.size > 0 || live.lastModelAudioAt > wakeAt || live.userSpoke || live.stats.greetSpoken) return;
    if (!live.session && !live.connecting && !waking && !prewarmed) return;   // the conversation was already closed
    live.stats.greetSpoken = true; speakFallback(line);
  }, 5000 + greetDelayMs());
  live.stats.greetSpoken = false;
  try {
    localHit = greetPromise ? await greetPromise : false; // greeting already playing from the device?
    greetPromise = null;
    if (localHit) await live.listenAfterPlayback();             // let it finish, then open the mic
    else await live.greetThenListen(line, { record: true });    // first time today: Gemini speaks it and we keep a copy
  } catch (e) {
    console.error('[wake] could not reach Gemini Live', e);
    if (!localHit) speakFallback(line);
    hud.setPlaceholder(`接続できませんでした：${e?.message ?? e}`);
  } finally {
    waking = false;
  }
  if (live.micOn && store.get(STANDBY_KEY) === null) store.set(STANDBY_KEY, '1');   // the mic works here: clap standby is on from now on (assistant-launch users never use the mic button)
  if (!live.session) armStandby(); else maybeBrief();
}

live.onIdle = () => { hud.setMicActive?.(false); bgm.stop({ fade: 0.4 }); armStandby(); };

// Mic auto-off: when nobody has spoken (neither the owner nor the assistant) and nothing is pending for a while, end the
// conversation and go back to clap standby. ?micidle=SECONDS (or localStorage elvar_micidle) changes it; 0 turns it off.
const MIC_IDLE_S = Number(qs.get('micidle') ?? store.get('elvar_micidle') ?? 15);
let micIdleSince = 0;
setInterval(() => {
  if (!(MIC_IDLE_S > 0) || waking || !live.session || !live.micOn) { micIdleSince = 0; return; }
  const busy = live.stretchActive || live.sources.size > 0 || live.pendingTools > 0 || live.state === 'thinking' || approval.open
    || performance.now() - live.lastVoiceAt < 2500 || briefingBusy
    || performance.now() < live.playUntil + 3000
    || (live.userSpoke && performance.now() - live.lastVoiceAt < 30000);   // a reply is still being prepared (spoke, no turnComplete yet)   // the model's audio is still arriving / playing (or just ended): never cut it off
  if (busy) { micIdleSince = 0; return; }
  micIdleSince ||= Date.now();
  if (Date.now() - micIdleSince > MIC_IDLE_S * 1000) {
    micIdleSince = 0;
    hud.setMicActive?.(false);
    live.stop();                                   // closes the mic + session; onIdle returns to clap standby
  }
}, 500);

// Music only while a conversation is open (mic on / session live). Once it has ended, fade it out.
let bgmIdleSince = 0;
setInterval(() => {
  // A live session counts as a conversation even before the mic opens: the greeting spoken by Gemini (no saved recording yet) plays first, then the mic opens.
  const inConversation = waking || prewarmed || Boolean(live.session || live.connecting);
  if (inConversation || !bgm.playing) { bgmIdleSince = 0; return; }
  bgmIdleSince ||= Date.now();
  if (Date.now() - bgmIdleSince > 1500) { bgmIdleSince = 0; bgm.stop({ fade: 0.4 }); }
}, 500);

// ---------------------------------------------------------------- normal controls
hud.onMicToggle(async (on) => {
  try {
    if (on) {
      standby.stop();
      if (!live.session) bgm.start();   // starting a conversation by tap (phone): the wake-up music plays here too
      await live.startMic();
      maybeBrief();
      if (store.get(STANDBY_KEY) === null) store.set(STANDBY_KEY, '1'); // mic permission is now granted → clap standby on
    } else {
      await live.stop(); // back to standby (live.onIdle re-arms it)
    }
  } catch (e) {
    console.error(e);
    live.stopMic();
    hud.setMicActive(false);
    hud.setPlaceholder(e?.name === 'NotAllowedError' ? 'マイクの使用が許可されていません' : `エラー：${e?.message ?? e}`);
    armStandby();
  }
});

hud.onSend(async (text) => {
  const cmd = detectProtocolCommand(text, { active: humanProtocol.active });   // typed 「ヒューマンプロトコル」 works the same as spoken
  if (cmd === 'start') humanProtocol.start(); else if (cmd === 'stop') humanProtocol.stop();
  else if (humanProtocol.active) { const hc = detectHandCommand(text); if (hc) humanProtocol.setHands(hc === 'on'); }
  try { standby.stop(); await live.sendText(text); } catch (e) { console.error(e); }
});

// On load: if the owner has used the mic before, go straight to standby (needs one click if the browser requires it).
armStandby();

window.addEventListener('pagehide', () => { closing = true; standby.stop(); live.stop(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) { closing = false; armStandby(); } });

// ---------------------------------------------------------------- wake-up music: stop control + ducking
// Small "■ STOP" pill, visible only while the music plays (kept outside the HUD artwork). Esc also stops it.
{
  const css = document.createElement('style');
  css.textContent = `#elvar-bgm-stop{position:fixed;left:50%;bottom:max(8px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;
    display:none;align-items:center;gap:10px;padding:5px 16px;border:1px solid rgba(25,211,255,.65);border-radius:3px;background:rgba(2,18,38,.82);
    color:#8fe3ff;font:600 11px/1 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:1.6px;cursor:pointer;
    box-shadow:0 0 8px rgba(25,190,255,.45)}#elvar-bgm-stop.on{display:flex}#elvar-bgm-stop:hover{background:rgba(6,50,92,.9);color:#fff}`;
  document.head.appendChild(css);
  const pill = document.createElement('button');
  pill.id = 'elvar-bgm-stop'; pill.type = 'button'; pill.setAttribute('aria-label', '音楽を停止');
  pill.innerHTML = '<span>♪ BGM</span><span>■ STOP</span>';
  pill.onclick = () => bgm.stop();
  document.body.appendChild(pill);
  bgm.onchange = (on) => pill.classList.toggle('on', on);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && bgm.playing) bgm.stop(); });
  window.__elvarBgmStop = () => bgm.stop();   // used by the desktop app's tray menu
  // Duck the music while a voice (greeting / reply) is playing or the mic is open.
  // Hysteresis: duck at once, but only release after the voice has been quiet for 1.5 s (the player's "active" flag flickers between
  // audio chunks, which made the music pump up and down).
  let lastVoiceBusy = 0;
  setInterval(() => {
    const busy = Boolean(live.stretchActive || live.sources.size > 0 || (live.session && live.micOn) || performance.now() < live.playUntil + 400);
    if (busy) lastVoiceBusy = performance.now();
    bgm.setDuck(busy || performance.now() - lastVoiceBusy < 1500);
  }, 250);
}

// Gemini Live time ledger (this device): +5 s every 5 s while a session is open.
{ let was = false; setInterval(() => { const on = Boolean(live.session); usage.liveTick(on ? 5 : 0, on && !was); was = on; }, 5000); }

// ---------------------------------------------------------------- Google tools (calendar / mail / Drive / tasks / contacts)
const approval = createApproval();
const protocolWatch = createTranscriptWatcher(), handWatch = createTranscriptWatcher(detectHandCommand);
live.onTranscript = (t) => {
  const modelBusy = live.modelSpeaking || live.stretchActive || performance.now() - live.lastModelAudioAt < 1500;
  approval.hear(t, { modelBusy });   // a spoken 「はい」 answers the build-request card
  googleTools?.hearFiles?.(t, { modelBusy });   // ... and 「印刷できましたか？」
  // 「ヒューマンプロトコル」 / 「プロトコル解除」 in the owner's own words: switch at once, without waiting for the model (it may also call human_protocol; both are idempotent).
  // While the assistant's voice is playing the transcript can be its echo, so only an explicit stop is honoured then.
  const cmd = protocolWatch.feed(t, { active: humanProtocol.active });
  if (cmd === 'start' && !modelBusy) humanProtocol.start();
  else if (cmd === 'stop') humanProtocol.stop();
  else if (!cmd && humanProtocol.active && !modelBusy) { const hc = handWatch.feed(t); if (hc) humanProtocol.setHands(hc === 'on'); }
};
const hudLive = qs.get('mockhud') === '1' ? null : initHudLive({ hud, live, authHeaders: () => live.authHeaders(), usage });
// A new payment notification on the phone (PayPay, card apps …) is turned into a ledger entry: only amount + merchant are kept (the text is not). Off with elvar_finance_capture=0.
const payHint = /(支払い|お支払い|ご利用|決済|チャージ|引き落とし|ご請求)/;
const notifications = initNotifications({ live, hudLive, store, onNew: (n) => {
  if (store.get('elvar_finance_capture') === '0' || window.__elvarDeviceLocked || !payHint.test(`${n.from} ${n.text}`)) return;
  fetch('/api/google/execute', { method: 'POST', headers: { 'content-type': 'application/json', ...live.authHeaders() }, body: JSON.stringify({ tool: 'finance_capture', args: { app: n.app, from: n.from, text: n.text } }) })
    .then((r) => r.json()).then((j) => { if (j?.ok && j.result?.entry) hudLive?.logActivity({ icon: 'gear', title: `家計に記録：${j.result.entry.description}`.slice(0, 40), sub: `¥${Math.abs(j.result.entry.amount).toLocaleString('ja-JP')}／${j.result.entry.category}` }); }).catch(() => {});
} });
const systemCheck = initSystemCheck({ live, bgm, standby, store, keys: { STANDBY_KEY }, authHeaders: () => live.authHeaders(), standbyInfo: () => armState, notifications });
if (DEBUG) window.__elvar.systemCheck = systemCheck;
// 通知欄 + proactive reports: when E.L.V.A.R. is open (the page is visible, the device unlocked) and a report / finished work arrives, it speaks up by itself.
// With no conversation running it opens a voice-only session (the mic stays OFF), reports, and closes again; the clap standby keeps working. Off with elvar_proactive=0.
const inbox = initInbox({ openNote: (p) => brainViewer.open({ path: p }) });
let announcing = false;
async function announceReady() {
  if (live.session) return true;
  if (store.get('elvar_proactive') === '0' || window.__elvarDeviceLocked || document.visibilityState !== 'visible' || waking || closing || live.connecting) return false;
  announcing = true;
  try { await live.ensureConnected(); } catch { announcing = false; return false; }
  if (!live.session) { announcing = false; return false; }
  hud.setStatusLabel?.('REPORT');
  return true;
}
setInterval(() => {   // the report is done and nobody started a conversation: close the voice-only session so the clap standby returns
  if (!announcing || !live.session || live.micOn || waking) { if (announcing && !live.session) announcing = false; return; }
  const busy = live.stretchActive || live.sources.size > 0 || live.pendingTools > 0 || live.state === 'thinking' || approval.open || agents.pending() > 0 || performance.now() < live.playUntil + 9000 || (live.userSpoke && performance.now() - live.lastVoiceAt < 30000);
  if (busy) return;
  announcing = false; live.stop();
}, 1000);
const agents = initAgents({ live, authHeaders: () => live.authHeaders(), hudLive, inbox, announceReady });
if (DEBUG) { window.__elvar.inbox = inbox; window.__elvar.agents = agents; }
const googleTools = initGoogleTools({ live, approval, authHeaders: () => live.authHeaders(), agents, systemCheck, hudLive, notifications, store, humanProtocol, openNote: (p) => brainViewer.open({ path: p }) });
// Load the notes into the server's cache the moment a conversation opens, so the first "what did I say about…" is fast.
{ const prevOpen = live.onSessionOpen; live.onSessionOpen = () => { try { prevOpen?.(); } catch {} if (!window.__elvarDeviceLocked && hudLive?.getServer()?.agentsAvailable?.memory) fetch('/api/google/execute', { method: 'POST', headers: { 'content-type': 'application/json', ...live.authHeaders() }, body: JSON.stringify({ tool: 'brain_warm', args: {} }) }).catch(() => {}); }; }
agents.setArtifactHandler((path) => googleTools.presentArtifact(path));
// Prepare the day's briefing in the background (silent), so the spoken briefing is instant. Once per day and kind.
function maybePrepBriefing() {
  const due = briefingPrepDue({ done: store.get('elvar_briefprep') || '', available: !!hudLive?.getServer()?.agentsAvailable?.briefing, locked: !!window.__elvarDeviceLocked });
  if (!due) return;
  store.set('elvar_briefprep', due.mark);
  agents.start({ agent: 'briefing', task: due.task, silent: true });
}
// Refresh the learned profile about once a week (silent).
function maybeLearn() {
  if (!learningDue({ last: store.get('elvar_learned_at') || 0, available: !!hudLive?.getServer()?.agentsAvailable?.learning, locked: !!window.__elvarDeviceLocked })) return;
  store.set('elvar_learned_at', String(Date.now()));
  agents.start({ agent: 'learning', task: 'ノートを読んで、' + ownerAddress() + 'のプロフィールを更新してください。', silent: true });
}
// Weekly security scan of the notes (silent unless it finds something: then it is reported).
function maybeSecurityScan() {
  if (!securityDue({ last: store.get('elvar_secscan_at') || 0, available: !!hudLive?.getServer()?.agentsAvailable?.security, locked: !!window.__elvarDeviceLocked })) return;
  store.set('elvar_secscan_at', String(Date.now()));
  agents.start({ agent: 'security', task: '第二の脳のノートの秘密の点検をしてください。', silent: true });
}
// Weekly review: Sunday evening (or Monday morning if missed). It is reported by voice at the next conversation.
function maybeReview() {
  const due = reviewDue({ done: store.get('elvar_review_week') || '', available: !!hudLive?.getServer()?.agentsAvailable?.review, locked: !!window.__elvarDeviceLocked });
  if (!due) return;
  store.set('elvar_review_week', due.mark);
  agents.start({ agent: 'review', task: due.task });
}
if (hudLive) { setTimeout(maybeReview, 55000); setInterval(maybeReview, 30 * 60e3); }
if (hudLive) { setTimeout(maybeSecurityScan, 40000); setInterval(maybeSecurityScan, 6 * 3600e3); }
if (hudLive) { setTimeout(maybeLearn, 25000); setInterval(maybeLearn, 6 * 3600e3); }
if (hudLive) { setTimeout(maybePrepBriefing, 8000); setInterval(maybePrepBriefing, 15 * 60e3); }
if (DEBUG) { window.__elvar.agents = agents; window.__elvar.hudLive = hudLive; }
setInterval(() => { if (live.session && !window.__elvarDeviceLocked) agents.deliver(); }, 5000);   // reports that finished while no session was open
initBuilds({ inbox, run: (t, a) => googleTools.runServerTool(t, a).catch(() => null), hudLive, queueNote: (t) => agents.queueNote(t) });   // progress of the builds handed to Claude Code
initPredict({ inbox, run: (t, a) => googleTools.runServerTool(t, a).catch(() => null), hudLive, queueNote: (t) => agents.queueNote(t), agents, store, available: () => !!hudLive?.getServer()?.agentsAvailable?.predict, availableAgent: (id) => !!hudLive?.getServer()?.agentsAvailable?.[id] });   // looks ahead: deadlines at risk, overloaded days, tomorrow's preparation
initConvLog({ live, run: (t, a) => googleTools.runServerTool(t, a).catch(() => null), hudLive });   // every conversation turn is kept in the second brain (会話/日付.md)
if (DEBUG) { window.__elvar.approval = approval; window.__elvar.files = googleTools.files; window.__elvar.handleTool = googleTools.handleTool; }

// ---------------------------------------------------------------- in-app settings panel (gear icon / Ctrl+,)
const brainViewer = initBrainViewer({ authHeaders: () => live.authHeaders() });
initSettingsPanel({
  hud, live, bgm, standby, store, qs,
  openBrain: () => brainViewer.open(),
  openCheck: () => systemCheck.run(false),
  notifications,
  keys: { STANDBY_KEY, SENS_KEY },
  defaults: { speechRate: DEFAULT_SPEECH_RATE },
  armStandby, greetDelayMs,
});

initGoogleWatch({ inbox, hudLive, session: currentSession });   // claims the Google login when the consent screen (another browser / Custom Tab) is done; asks to reconnect when Google refuses

// Launched from the Android assistant gesture (apk wrapper opens ?assistant=1): start the conversation right away.
if (qs.get('assistant') === '1') {
  try { history.replaceState(null, '', location.pathname); } catch {}
  setTimeout(() => { wake().catch((e) => console.warn('[assistant]', e?.message ?? e)); }, 400);
}
