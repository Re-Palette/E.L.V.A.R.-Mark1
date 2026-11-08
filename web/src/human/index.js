// ヒューマンプロトコル controller: loads the particle data on first use, takes over the screen (only the input bar stays),
// runs the stream-out → living figure → stream-back sequence and follows the assistant's state / voice level.
// Loaded with import() from main.js the first time the protocol starts, so normal startup carries none of this.
import { TIMING, parseHumanData, fitFigure, coverFit, particleBudget, easeInOutCubic, figureProgress, clamp01, snapScale, snapFlash, nextQuality } from '../human-protocol.js';
import { createRenderer, rigUniforms, TUNE, CAM_D } from './renderer.js';
import { createRig, LOOK } from '../human-rig.js';
import { createGestureTracker } from '../hand-gesture.js';
import dataUrl from './human-data.bin?url';
import bgUrl from './human-bg.webp?url';

const CSS = `
#elvar-human{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
/* the HUD fades with opacity only, on compositor layers (will-change only while a fade runs): no repaint of the HUD's filtered SVG per frame */
.vh-root.vh-human-fade .vh-stage>*,.vh-root.vh-human-fade .vm-stage>*,.vh-root.vh-human-fade .vm-bottom>*,.vh-root.vh-human-fade .vm-botfx>*{transition:opacity ${TIMING.hudFade}s ease-in-out!important}
.vh-root.vh-human-anim .vh-stage>*,.vh-root.vh-human-anim .vm-top,.vh-root.vh-human-anim .vm-mid,.vh-root.vh-human-anim .vm-bottom>*{will-change:opacity}
.vh-root.vh-human .vh-stage>:not(.vh-input),
.vh-root.vh-human .vm-top,.vh-root.vh-human .vm-mid,.vh-root.vh-human .vm-botchrome,
.vh-root.vh-human .vm-weather,.vh-root.vh-human .vm-assist,
.vh-root.vh-human .vm-botfx>:not(.vm-inframe):not(defs){opacity:0!important;pointer-events:none!important}
.vh-root.vh-human .vh-input,.vh-root.vh-human .vm-input{opacity:1!important;filter:none!important}
.vh-root.vh-human .vh-flash{display:none}
html.vhp-on body>:not(#hud-root):not(.va-back){opacity:0!important;pointer-events:none!important;transition:opacity .6s ease}
.vhp-cam{position:absolute;right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));z-index:6;display:flex;align-items:center;gap:5px;padding:3px 7px;border-radius:10px;background:rgba(2,14,30,.55);color:#8fe3ff;font:11px/1 'Barlow Semi Condensed',sans-serif;opacity:.8;pointer-events:auto;cursor:pointer;border:1px solid rgba(70,224,255,.35)}
.vhp-cam:hover{opacity:1;background:rgba(2,28,52,.8)}.vhp-cam.off{opacity:.55;color:#7f9bb0}.vhp-cam.off i{background:#5a7285;box-shadow:none}.vhp-cam.off svg{opacity:.6}.vhp-cam b{font-weight:500;letter-spacing:.5px}
.vhp-cam i{width:6px;height:6px;border-radius:50%;background:#46e0ff;box-shadow:0 0 6px #46e0ff}
.vhp-cam .vhp-prev{width:120px;height:90px;border-radius:4px;overflow:hidden;border:1px solid rgba(70,224,255,.4)}
`;

let dataPromise = null;
/** The renderer kept between uses (prepared by preloadHuman() while the app is idle, or left over from the last show): { R, count }. */
let kept = null, keptP = null;
const mobileQ = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };
const reducedQ = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
function budget(data) { return particleBudget(data.count, { dpr: window.devicePixelRatio || 1, cores: navigator.hardwareConcurrency || 4, mobile: mobileQ(), reduced: reducedQ() }); }
/** What the canvas will measure when the show starts (the same formula as resize()), so the prepared buffers already have their final size. */
function screenSize(quality) {
  const vw = innerWidth, vh = innerHeight, d = Math.min(window.devicePixelRatio || 1, 2.5, Math.sqrt(5.5e6 / Math.max(1, vw * vh))) * (0.55 + 0.45 * quality);
  const f = fitFigure(vw, vh, 1672, 941);
  return { W: Math.max(1, Math.round(vw * d)), H: Math.max(1, Math.round(vh * d)), fit: { s: f.s * d, ox: f.ox * d, oy: f.oy * d } };
}
async function prepareRenderer(data, bg, quality) {
  if (kept) return kept;
  keptP ||= (async () => {
    const canvas = document.createElement('canvas'); canvas.id = 'elvar-human'; canvas.setAttribute('aria-hidden', 'true');
    const { W, H, fit } = screenSize(quality); canvas.width = W; canvas.height = H;
    const count = budget(data);
    const R = await createRenderer(canvas, data, bg, { count, force2d: new URLSearchParams(location.search).get('human2d') === '1' });
    if (R.warm) {   // draw off screen once so every pipeline (and the full-size bloom buffers) exist before the show
      const rig = rigUniforms(createRig(1).update(1 / 60, { state: 'idle' }));
      await R.warm({ w: W, h: H, t: 0, formT: 0, exitT: 0, exiting: false, fig: 1, bgA: 1, motion: 1, core: [W / 2, H / 2], coreR: 40, level: 0, listen: 0, think: 0, speak: 0, fit, bgFit: fit, alpha: 1, snap: 1, flash: 0, wave: 0, par: [0, 0], share: 1, rig: { ...rig, headLocal: 0 } });
    }
    kept = { R, count }; return kept;
  })().finally(() => { keptP = null; });
  return keptP;
}
/**
 * Prepare the Human Protocol in the background (the app calls this when it is idle): fetch + decode the data and the background,
 * compile the shaders, upload the buffers and draw once off screen. The first show then starts on its first frame.
 */
export async function preloadHuman() {
  const [data, bg] = await loadAssets();
  await prepareRenderer(data, bg, mobileQ() ? 0.85 : 1);
  return true;
}
function loadAssets() {
  dataPromise ||= Promise.all([
    fetch(dataUrl).then((r) => { if (!r.ok) throw new Error(`human data: HTTP ${r.status}`); return r.arrayBuffer(); }).then(parseHumanData),
    new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = bgUrl; }),
  ]).catch((e) => { dataPromise = null; throw e; });
  return dataPromise;
}

/**
 * @param {{ hud: object, rootEl: HTMLElement, onChange?: (active: boolean) => void }} o
 */
export function createHumanProtocol({ hud, rootEl, onChange = () => {} }) {
  const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const mobile = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  if (!document.getElementById('elvar-human-css')) { const s = document.createElement('style'); s.id = 'elvar-human-css'; s.textContent = CSS; document.head.appendChild(s); }

  let phase = 'off';            // off | forming | formed | exiting
  let canvas = null, R = null, raf = 0, mo = null, ro = null;
  let t = 0, formT = 0, exitT = 0, lastNow = 0, hudBackAt = 0;
  let core = [0, 0], coreR = 40, W = 0, H = 0, dpr = 1, fit = null, bgFit = null;
  let restartAfterExit = false, startSeq = 0, frozen = false;
  // render quality 0.5..1 (resolution, share of the particles): adapts to the measured frame time unless locked (?humanq=0.5..1 locks it)
  const qLock = Number(new URLSearchParams(location.search).get('humanq')) || 0;
  let quality = qLock || (mobile ? 0.85 : 1), qLocked = !!qLock, qWin = 0, qN = 0, qAt = -9;
  const ease = { listen: 0, think: 0, speak: 0, level: 0 };
  const seedQ = Number(new URLSearchParams(location.search).get('humanseed')) || 0;   // debug: a fixed seed makes two runs identical (A/B captures)
  let rig = createRig(seedQ || ((Math.random() * 1e9) | 0)), rigOut = null, figPts = null, poseOverride = null;
  const ptr = { x: 0, y: 0, at: -1e9, atT: -1e9, on: false, touch: false };   // the pointer / last touch (CSS px), when it last moved, whether it is on the page
  const stats = { frames: 0, sumDt: 0, maxDt: 0, renderer: '', particles: 0, lines: 0, draws: 0, quality: 1 };

  function readCore() {
    const el = rootEl.querySelector('.vh-sphere');
    const r = el?.getBoundingClientRect();
    if (r && r.width > 0) { core = [(r.left + r.width / 2) * dpr, (r.top + r.height / 2) * dpr]; coreR = r.width * 0.3 * dpr; }
    else { core = [W / 2, H * 0.45]; coreR = 40 * dpr; }
  }
  function placeCanvas() {
    if (!canvas) return;
    // just above the HUD's own background, under the HUD stage (so the input bar stays on top and the panels fade out over the particles)
    const vp = rootEl.querySelector('.vh-viewport');
    const parent = vp || rootEl, before = vp ? vp.querySelector('.vh-stage') : rootEl.querySelector('.vm-stage');
    if (canvas.parentNode !== parent || canvas.nextSibling !== before) parent.insertBefore(canvas, before || null);
  }
  function resize() {
    if (!canvas) return;
    const vw = rootEl.clientWidth || innerWidth, vh = rootEl.clientHeight || innerHeight;
    // sharp: up to 2.5x device pixels (about 5.5 M pixels at most), scaled down with the adaptive quality
    dpr = Math.min(window.devicePixelRatio || 1, 2.5, Math.sqrt(5.5e6 / Math.max(1, vw * vh))) * (0.55 + 0.45 * quality);
    W = Math.max(1, Math.round(vw * dpr)); H = Math.max(1, Math.round(vh * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const f = fitFigure(vw, vh, 1672, 941), b = coverFit(vw, vh, 1672, 941, 0.5);
    fit = { s: f.s * dpr, ox: f.ox * dpr, oy: f.oy * dpr };
    // the background is the same artwork box as the figure (so the painted-out body lines up); only the 2D fallback uses a plain cover fit
    bgFit = R?.kind === '2d' ? { s: b.s * dpr, ox: b.ox * dpr, oy: b.oy * dpr } : fit;
  }

  function smooth(dt) {
    const state = hud.state || 'idle', a = hud.audio || { level: 0, source: 'mic' };
    const k = 1 - Math.exp(-dt / 0.35);
    ease.listen += ((state === 'listening' ? 1 : 0) - ease.listen) * k;
    ease.think += ((state === 'thinking' || state === 'connecting' ? 1 : 0) - ease.think) * k;
    const speaking = state === 'speaking' || a.source === 'model';
    ease.speak += ((speaking ? 1 : 0) - ease.speak) * k;
    const target = Math.max(0, ((speaking ? a.level : a.level * 0.35) - 0.04) / 0.96);
    const tau = target > ease.level ? 0.06 : 0.22;
    ease.level += (Math.min(1, target * 1.4) - ease.level) * (1 - Math.exp(-dt / tau));
  }

  /** Advance the sequence, the state easing and the rig by dt seconds. Returns false when the exit has finished (torn down). */
  function step(dt, now) {
    t += dt;
    if (phase === 'forming' || phase === 'formed') { formT += dt; if (phase === 'forming' && formT >= TIMING.formTotal) { phase = 'formed'; scheduleHands(); } }
    if (phase === 'exiting') {
      exitT += dt;
      if (!hudBackAt && exitT >= 0.35) { hudBackAt = now; fadeLayers(); rootEl.classList.remove('vh-human'); document.documentElement.classList.remove('vhp-on'); }
      if (exitT >= TIMING.exitTotal) { teardown(); return false; }
    }
    smooth(Math.max(dt, 1e-3));
    // the rig: breathing, heartbeat, gestures, state, voice, pointer (only a pointer that moved in the last 3 s, and only once the figure stands)
    const st0 = hud.state || 'idle', speakingNow = st0 === 'speaking' || (hud.audio?.source === 'model' && ease.level > 0.02);
    const rigState = speakingNow ? 'speaking' : st0 === 'thinking' || st0 === 'connecting' ? 'thinking' : st0 === 'listening' ? 'listening' : 'idle';
    // the face follows the pointer while it is on the page (still or moving; after ~8 s of rest it looks ahead again), a touch for a few seconds
    const idle = t - ptr.atT;   // in animation time (a frozen / stepped capture stays consistent)
    const usePtr = phase === 'formed' && fit && ptr.on && (!ptr.touch || idle < LOOK.touchSec);
    let pointer = usePtr ? { x: (ptr.x * dpr - fit.ox) / fit.s, y: (ptr.y * dpr - fit.oy) / fit.s, idle: ptr.touch ? 0 : idle } : null;
    if (window.__elvarDeviceLocked && hand.source?.active) stopHands();   // the phone locked: the camera goes off at once
    // a hand in front of the camera is watched first (while it is the most recent input); its gestures answer
    const hs = hand.state, handOn = phase === 'formed' && fit && hs && hs.weight > 0 && hs.target && hand.lastAt >= ptr.at - 50;
    if (handOn) pointer = { x: (hs.target.x * dpr - fit.ox) / fit.s, y: (hs.target.y * dpr - fit.oy) / fit.s, idle: 0 };
    if (phase === 'formed') for (const ev of hand.events.splice(0)) {
      if (ev.type === 'pinch' || ev.type === 'fist') impulseAt(ev.x, ev.y, null);
      else if (ev.type === 'swipe') rig.swipe(ev.dir, reduced);
      else if (ev.type === 'wave') rig.gestureNow('greet');
    } else hand.events.length = 0;
    rigOut = rigUniforms(rig.update(dt, { state: rigState, level: ease.level, reduced, pointer, hand: handOn && hs.present ? { offer: hs.holding, near: hs.near } : null }));
    // strength of the 3D motion (TUNE.turn: the body's swing, TUNE.orbit: the camera's orbit); the head's own turn is relative to the body,
    // except while it watches the pointer (then it compensates the swing and keeps looking at it)
    rigOut.bodyYaw *= TUNE.turn; rigOut.torsoPitch *= TUNE.turn; rigOut.camYaw *= TUNE.orbit; rigOut.camPitch *= TUNE.orbit;
    if (poseOverride) Object.assign(rigOut, poseOverride);   // debug: a forced pose (captures)
    rigOut.headLocal = poseOverride && 'headLocal' in poseOverride ? poseOverride.headLocal : rigOut.yaw - rigOut.eng * rigOut.bodyYaw;
    return true;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dtRaw = lastNow ? (now - lastNow) / 1000 : 1 / 60;
    lastNow = now;
    if (stats.frames > 0) { stats.sumDt += dtRaw; stats.maxDt = Math.max(stats.maxDt, dtRaw); }
    stats.frames++;
    const c0 = performance.now();
    if (!frozen && !step(Math.min(0.1, dtRaw), now)) return;   // (a hidden tab resets lastNow, so a long gap never jumps the sequence)
    if (frozen && !rigOut) step(0, now);
    placeCanvas();
    if (reduced && phase !== 'exiting') formT = Math.max(formT, TIMING.formTotal);
    const fig = phase === 'exiting' ? figureProgress(formT) * (1 - clamp01(exitT / (TIMING.exitTotal * 0.55))) : figureProgress(formT);
    let bgA = phase === 'exiting' ? (1 - easeInOutCubic((exitT - 0.25) / 1.3)) * easeInOutCubic(formT / 1.4) : easeInOutCubic(t / 1.4);
    let alpha = 1;
    if (reduced) { alpha = phase === 'exiting' ? 1 - clamp01(exitT / 0.8) : clamp01(t / 0.8); bgA *= 1; }
    const motion = reduced ? 0.3 : 1;
    stats.draws = R.frame({ w: W, h: H, t, formT, exitT, exiting: phase === 'exiting' && !reduced, fig: fig * alpha, bgA, motion, core, coreR, level: ease.level, listen: ease.listen, think: ease.think, speak: ease.speak, fit, bgFit, alpha,
      snap: reduced ? 1 : snapScale(formT), flash: reduced ? 0 : snapFlash(formT), wave: 1.15 - ((t * 0.085) % 1) * 1.5,
      par: [-rigOut.camYaw * 520 * TUNE.bgPar * motion * dpr, rigOut.camPitch * 420 * TUNE.bgPar * motion * dpr], share: 0.6 + 0.4 * quality, rig: rigOut });   // the far background shifts against the camera drift
    stats.cpuMs = (stats.cpuMs || 0) * 0.95 + (performance.now() - c0) * 0.05;
    // adaptive quality: average over ~1.5 s of frames
    if (!qLocked && !frozen && dtRaw < 0.25 && t > 2) {   // (the first 2 s are ignored: warming up is not slowness)
 qWin += dtRaw; qN++; if (qWin > 2.5) { const q2 = nextQuality(quality, (qWin / qN) * 1000); qWin = 0; qN = 0; if (q2 !== quality && t - qAt > 4) { qAt = t; quality = q2; const r0 = performance.now(); resize(); stats.resizeMs = Math.round(performance.now() - r0); } } }   // (at most one change per 4 s)
    stats.quality = quality;
    if (reduced && alpha < 1) canvas.style.opacity = String(Math.max(alpha, bgA));
  }

  function onKey(e) { if (e.key === 'Escape' && (phase === 'forming' || phase === 'formed')) stop(); }
  function onVis() { lastNow = 0; if (document.hidden) stopHands(); else if (phase === 'formed') startHands(); }
  function onPtr(e) { ptr.x = e.clientX; ptr.y = e.clientY; ptr.at = performance.now(); ptr.atT = t; ptr.on = true; ptr.touch = e.pointerType === 'touch'; }
  function onLeave(e) { if (!e.relatedTarget) ptr.on = false; }   // the mouse left the window
  // a click / tap (never mere movement): a shock ring there; on the figure the particles make way and come back. Not on the input bar / mic.
  function onDown(e) {
    onPtr(e);
    if (phase !== 'formed' || !fit || (e.button ?? 0) > 0) return;
    impulseAt(e.clientX, e.clientY, e.target);
  }
  /** A shock ring at (cx, cy) CSS px — from a click / tap, or a pinch / fist of a hand; on the figure it also pushes the particles aside. Never on the input bar / mic. */
  function impulseAt(cx, cy, target) {
    if (!fit) return;
    const el = target ?? document.elementFromPoint(cx, cy);
    if (el?.closest?.('.vh-input, .vm-input, button, input, textarea, a, .va-back')) return;
    const x = (cx * dpr - fit.ox) / fit.s, y = (cy * dpr - fit.oy) / fit.s;
    let near = Infinity; if (figPts) for (let i = 0; i < figPts.length; i += 2) near = Math.min(near, (figPts[i] - x) ** 2 + (figPts[i + 1] - y) ** 2);
    rig.click(x, y, near < 34 * 34 ? 1 : 0);
  }

  // ---- hand tracking (front camera): only while the protocol is on and the page is visible; off with localStorage elvar_handtrack = '0'
  const hand = { tracker: createGestureTracker(), state: null, lastAt: -1e9, events: [], source: null, starting: false, el: null };
  const handWanted = () => { try { if (localStorage.getItem('elvar_handtrack') === '0') return false; } catch {} return !!navigator.mediaDevices?.getUserMedia && !window.__elvarDeviceLocked; };
  function onHands(hands, tSec) {
    const r = hand.tracker.update(hands, tSec, { vw: rootEl.clientWidth || innerWidth, vh: rootEl.clientHeight || innerHeight });
    hand.state = r; if (r.count > 0) hand.lastAt = performance.now();
    hand.events.push(...r.events);
  }
  async function startHands() {
    if (hand.source?.active || hand.starting || !handWanted() || document.hidden) return;
    hand.starting = true;
    try {
      const { createMediaPipeHandSource } = await import('../hand-source.js');
      if (phase !== 'forming' && phase !== 'formed') return;
      const debugPrev = new URLSearchParams(location.search).get('handcam') === '1';
      renderBadge(debugPrev);
      hand.source = createMediaPipeHandSource({ preview: debugPrev ? hand.el?.querySelector('.vhp-prev') : null });
      hand.source.onFrame(onHands);
      const ok = await hand.source.start();
      if (!(ok && (phase === 'forming' || phase === 'formed') && !document.hidden)) hand.source.stop();
    } catch (e) { console.warn('[hand] hand tracking unavailable:', e?.message ?? e); }
    finally { hand.starting = false; }
  }
  let handTimer = 0;
  /** Start the camera / detector after the formation, in an idle moment (asks for the camera the first time; refused / missing: nothing happens). */
  function scheduleHands() {
    clearTimeout(handTimer);
    handTimer = setTimeout(() => {
      const go = () => { if (phase === 'formed') startHands(); };
      if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 }); else go();
    }, 400);
  }
  function stopHands() { try { hand.source?.stop(); } catch {} hand.state = null; hand.events.length = 0; }
  // the little camera badge is also the on/off switch for the hand tracking (the choice is kept: localStorage elvar_handtrack = '0' = off)
  const handsOn = () => { try { return localStorage.getItem('elvar_handtrack') !== '0'; } catch { return true; } };
  function renderBadge(debugPrev = new URLSearchParams(location.search).get('handcam') === '1') {
    if (!navigator.mediaDevices?.getUserMedia) return;
    if (!hand.el) {
      hand.el = Object.assign(document.createElement('button'), { className: 'vhp-cam', type: 'button' });
      hand.el.addEventListener('click', (e) => { e.stopPropagation(); setHands(!handsOn()); });
    }
    const on = handsOn();
    hand.el.classList.toggle('off', !on); hand.el.setAttribute('aria-pressed', String(on));
    hand.el.title = on ? 'カメラで手を追っています（映像は端末の外に送りません）。押すとオフ' : 'カメラの追従はオフです。押すとオン';
    hand.el.setAttribute('aria-label', hand.el.title);
    hand.el.innerHTML = `<i></i><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13M8 11.5a1.5 1.5 0 0 0-3 0V14a7 7 0 0 0 14 0v-1"/></svg><b>${on ? 'ON' : 'OFF'}</b>${debugPrev && on ? '<div class="vhp-prev"></div>' : ''}`;
    if (!hand.el.isConnected && (phase === 'forming' || phase === 'formed')) rootEl.appendChild(hand.el);
  }
  /** Turn the camera follow on / off (the camera is released at once when off; the choice is remembered). */
  function setHands(on) {
    try { localStorage.setItem('elvar_handtrack', on ? '1' : '0'); } catch {}
    if (on) { if (phase === 'formed') startHands(); else scheduleHands(); } else stopHands();
    renderBadge();
    return on;
  }

  async function start() {
    if (phase === 'forming' || phase === 'formed') return true;
    if (phase === 'exiting') { restartAfterExit = true; return true; }
    const seq = ++startSeq;
    const T0 = performance.now();
    const [data, bg] = await loadAssets();
    const T1 = performance.now();
    const prep = await prepareRenderer(data, bg, quality);   // instant when preloaded / kept from the last show; otherwise built without blocking
    if (seq !== startSeq || phase !== 'off') return phase !== 'off';
    R = prep.R; canvas = R.canvas; kept = null;
    placeCanvas(); resize();
    stats.startup = { assetsMs: Math.round(T1 - T0), rendererMs: Math.round(performance.now() - T1), preloaded: performance.now() - T1 < 30, ...(R.timing || {}) };
    { const n = Math.min(3000, data.count); figPts = new Float32Array(n * 2); for (let i = 0; i < n; i++) { const j = Math.floor((i * data.count) / n); figPts[i * 2] = data.pos[j * 2] * 1672; figPts[i * 2 + 1] = data.pos[j * 2 + 1] * 941; } }   // where the figure is (for clicks)
    Object.assign(stats, { frames: 0, sumDt: 0, maxDt: 0, renderer: R.kind, particles: R.count, lines: R.lines });
    readCore();
    t = 0; formT = 0; exitT = 0; lastNow = 0; hudBackAt = 0;
    phase = 'forming';
    fadeLayers(); rootEl.classList.add('vh-human-fade');
    requestAnimationFrame(() => { if (phase === 'forming' || phase === 'formed') { rootEl.classList.add('vh-human'); document.documentElement.classList.add('vhp-on'); } });   // one frame later: the layers exist before the fade starts
    mo = new MutationObserver(() => placeCanvas()); mo.observe(rootEl, { childList: true, subtree: false });
    ro = new ResizeObserver(() => { resize(); }); ro.observe(rootEl);
    addEventListener('keydown', onKey); document.addEventListener('visibilitychange', onVis);
    addEventListener('pointermove', onPtr, { passive: true }); addEventListener('pointerdown', onDown, { passive: true }); document.addEventListener('mouseout', onLeave);
    setTimeout(() => { if (phase === 'forming' || phase === 'formed') hud.setSphereRunning?.(false); }, TIMING.hudFade * 1000 + 200);   // hidden: stop drawing it
    raf = requestAnimationFrame(loop);
    renderBadge();
    // the camera / hand detector start once the figure stands (not during the formation: getUserMedia and the detector's WASM / model are heavy)
    onChange(true);
    return true;
  }

  /** Promote the HUD's parts to compositor layers for the duration of a fade (then release them: no lasting memory cost). */
  let fadeTimer = 0;
  function fadeLayers() { rootEl.classList.add('vh-human-anim'); clearTimeout(fadeTimer); fadeTimer = setTimeout(() => rootEl.classList.remove('vh-human-anim'), TIMING.hudFade * 1000 + 400); }

  function stop() {
    restartAfterExit = false;
    if (phase === 'off' || phase === 'exiting') { startSeq++; return false; }
    hud.setSphereRunning?.(true);
    readCore();
    phase = 'exiting'; exitT = 0;
    if (reduced) { rootEl.classList.remove('vh-human'); document.documentElement.classList.remove('vhp-on'); hudBackAt = performance.now(); }
    stopHands(); hand.el?.remove();
    onChange(false);
    return true;
  }

  function teardown() {
    cancelAnimationFrame(raf); raf = 0;
    mo?.disconnect(); ro?.disconnect(); mo = ro = null;
    removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pointermove', onPtr); removeEventListener('pointerdown', onDown); document.removeEventListener('mouseout', onLeave);
    canvas?.remove(); if (R && !kept) kept = { R, count: R.count }; else R?.destroy();   // kept for the next show (no rebuild, no recompile)
    R = null; canvas = null;
    rootEl.classList.remove('vh-human'); document.documentElement.classList.remove('vhp-on');
    setTimeout(() => { if (phase === 'off') rootEl.classList.remove('vh-human-fade'); }, TIMING.hudFade * 1000 + 100);
    stopHands(); hand.el?.remove();
    phase = 'off';
    if (restartAfterExit) { restartAfterExit = false; start(); }
  }

  return {
    start, stop, setHands, get handsOn() { return handsOn(); },
    /** true while the figure is showing (forming or formed); false once stop() began. */
    get active() { return phase === 'forming' || phase === 'formed'; },
    get phase() { return phase; },
    /** Debug: jump the clock (seconds since start) to look at a moment of the formation. */
    seek(sec) { formT = sec; t = Math.max(t, sec); if (phase === 'formed' && sec < TIMING.formTotal) phase = 'forming'; },
    /** Debug (with freeze): advance the animation by exactly `sec` seconds, in small steps (deterministic captures). */
    advance(sec) { for (let left = +sec || 0; left > 1e-9 && R; left -= 0.05) step(Math.min(0.05, left), performance.now()); },
    /** Debug: force rig values (e.g. { yaw, pitch, bodyYaw, camYaw, camPitch }); null releases. Applies from the next step. */
    pose(o) { poseOverride = o || null; if (R) step(0, performance.now()); },
    /** Debug: put the clock at exactly `sec` and restart the rig (with ?humanseed two runs then match frame for frame). */
    syncTime(sec) { t = formT = sec; rig = createRig(seedQ || 7); if (R) step(0, performance.now()); },
    /** Debug: feed hand landmarks as a HandSource would (tests / captures without a real hand). */
    feedHands(hands, tSec = performance.now() / 1000) { onHands(hands, tSec); },
    /** Debug: the camera / hand-tracking state. */
    hands() { return { cameraOn: !!hand.source?.active, detector: hand.source?.detector || '', tracks: hand.source?.stream?.getTracks?.().map((x) => x.readyState) || [], state: hand.state && { present: hand.state.present, weight: hand.state.weight, target: hand.state.target, near: hand.state.near, holding: hand.state.holding }, indicator: !!hand.el?.isConnected }; },
    /** Debug: freeze / unfreeze time (screenshots). */
    freeze(on = true) { frozen = !!on; },
    /** Debug: set (and optionally lock) the render quality 0.5..1. */
    quality(q, lock = true) { quality = Math.max(0.5, Math.min(1, +q || 1)); qLocked = !!lock; resize(); return quality; },
    /** Debug: adjust the look constants live. */
    tune(patch) { return Object.assign(TUNE, patch || {}); },
    /** Debug: the rig's current values (gesture, heart rate, …). */
    rig() { return rigOut && { gesture: rigOut.gesture, bpm: rigOut.bpm, beat: rigOut.beat, waves: rigOut.waves.length, gestures: rigOut.gestures, yaw: rigOut.yaw, tilt: rigOut.tilt, nod: rigOut.nod, pitch: rigOut.pitch, gazeX: rigOut.gazeX, gazeY: rigOut.gazeY, eyeOpen: rigOut.eyeOpen, eng: rigOut.eng, near: rigOut.near, offer: rigOut.offer, handNear: rigOut.handNear, gestureNow: rigOut.gesture, blinks: rigOut.blinks, clicks: rigOut.clicks.length, bodyYaw: rigOut.bodyYaw, camYaw: rigOut.camYaw, camPitch: rigOut.camPitch, headLocal: rigOut.headLocal, breath: rigOut.breath }; },
    /** Debug: where the eye lights are on the screen now (CSS px), as the shader places them (approximately: rig yaw/pitch + gaze). */
    /** Debug: where points of the volume land on the screen (CSS px) under the current pose — the chest's front / back surface and the head's
     *  front / back — mirroring the shader's rig rotation (head, body) and camera (breathing / small offsets left out). */
    probe() {
      if (!rigOut || !fit) return null;
      const W = 1672, H = 941, rY = (q, a) => [q[0] * Math.cos(a) + q[2] * Math.sin(a), q[1], -q[0] * Math.sin(a) + q[2] * Math.cos(a)], rX = (q, a) => [q[0], q[1] * Math.cos(a) + q[2] * Math.sin(a), -q[1] * Math.sin(a) + q[2] * Math.cos(a)];
      const proj = (x, y, z, head) => {
        let P = [x, y, z];
        if (head) { const pn = [W * 0.505, H * 0.5]; let q = rY([P[0] - pn[0], P[1] - pn[1], P[2]], rigOut.headLocal); q = rX(q, rigOut.pitch); P = [pn[0] + q[0], pn[1] + q[1], q[2]]; }
        const b = rY([P[0] - W * 0.505, P[1], P[2]], rigOut.bodyYaw); P = [b[0] + W * 0.505, b[1], b[2]];
        const Q = rX(rY([P[0] - W * 0.505, P[1] - H * 0.62, P[2]], rigOut.camYaw), rigOut.camPitch), k = CAM_D / (CAM_D - Q[2]);
        return [+((fit.ox + (W * 0.505 + Q[0] * k) * fit.s) / dpr).toFixed(1), +((fit.oy + (H * 0.62 + Q[1] * k) * fit.s) / dpr).toFixed(1)];
      };
      return { chestFront: proj(W * 0.505, H * 0.76, 250), chestBack: proj(W * 0.505, H * 0.76, -250), headFront: proj(W * 0.505, H * 0.27, 180), headBack: proj(W * 0.505, H * 0.27, -180), shoulderL: proj(W * 0.27, H * 0.7, 0), shoulderR: proj(W * 0.74, H * 0.7, 0) };
    },
    eyes() {
      if (!rigOut || !fit) return null;
      const W = 1672, H = 941, rY = (q, a) => [q[0] * Math.cos(a) + q[2] * Math.sin(a), q[1], -q[0] * Math.sin(a) + q[2] * Math.cos(a)], rX = (q, a) => [q[0], q[1] * Math.cos(a) + q[2] * Math.sin(a), -q[1] * Math.sin(a) + q[2] * Math.cos(a)];
      return [-1, 1].map((sd) => {
        const pn = [W * 0.505, H * 0.5, 0]; let q = [W * (0.505 + sd * 0.021) + rigOut.gazeX * 9 - pn[0], H * 0.305 + rigOut.gazeY * 6 - pn[1], R.eyeZ || 0];
        q = rY(q, rigOut.headLocal); q = rX(q, rigOut.pitch);
        const c = Math.cos(rigOut.tilt), si = Math.sin(rigOut.tilt); q = [q[0] * c - q[1] * si, q[0] * si + q[1] * c, q[2]];
        let P = [pn[0] + q[0], pn[1] + q[1], q[2]];
        const b = rY([P[0] - W * 0.505, P[1], P[2]], rigOut.bodyYaw); P = [b[0] + W * 0.505, b[1], b[2]];
        let Q = rX(rY([P[0] - W * 0.505, P[1] - H * 0.62, P[2]], rigOut.camYaw), rigOut.camPitch); const k = CAM_D / (CAM_D - Q[2]);
        return [(fit.ox + (W * 0.505 + Q[0] * k) * fit.s) / dpr, (fit.oy + (H * 0.62 + Q[1] * k) * fit.s) / dpr];
      });
    },
    stats() { return { ...stats, avgDtMs: stats.frames > 1 ? (stats.sumDt / (stats.frames - 1)) * 1000 : 0, maxDtMs: stats.maxDt * 1000, phase, formT, exitT, level: ease.level }; },
  };
}
