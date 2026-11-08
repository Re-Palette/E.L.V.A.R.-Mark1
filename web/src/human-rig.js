// ヒューマンプロトコル: the "life" of the figure — a small rig (chest, shoulders, neck, head) driven by irregular breathing, a heartbeat,
// occasional gestures, the assistant's state and voice, and the pointer. Pure JS (no DOM): the renderer turns its output into uniforms.
// Everything is time based (dt) and smoothed, so a slow frame never makes it jump.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashI = (i, seed) => { let x = Math.imul((i | 0) ^ Math.imul(seed + 1, 0x27d4eb2d), 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

/** Smooth 1D value noise in [-1, 1] (C1-continuous). */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hashI(i, seed) * (1 - u) + hashI(i + 1, seed) * u) * 2 - 1;
}
/** A few octaves: irregular, never periodic-looking. */
export const fbm = (x, seed = 0) => 0.6 * noise1(x, seed) + 0.3 * noise1(x * 2.13 + 5.3, seed + 101) + 0.1 * noise1(x * 4.37 + 1.7, seed + 202);

/** "Lub-dub": the strong beat, then a softer second one 0.24 s later. */
export const beatEnv = (a) => (a < 0 || a > 1.2 ? 0 : Math.exp(-(((a - 0.035) / 0.07) ** 2)) + 0.6 * Math.exp(-(((a - 0.275) / 0.08) ** 2)));

/** How far a click pushes the particles over time (0 → peak at ~0.15 s → back to ~0 after ~1.2 s, smoothly). */
export const clickEnv = (age) => (age <= 0 ? 0 : (1 - Math.exp(-age * 14)) * Math.exp(-age * 3.2));
export const CLICK = { radius: 110, push: 26, ringSpeed: 620 };   // reference px

export const CHEST = [0.515, 0.765], FOREHEAD = [0.531, 0.26], HEAD = [0.505, 0.24];
/** Where the (hollow) face would have its eyes: centre-upper face of the reference head, ±EYE_DX apart (normalized). */
export const EYES = [0.505, 0.305], EYE_DX = 0.021;
export const LOOK = { distance: 950, maxYaw: 0.5, maxPitch: 0.26, idleSec: 8, touchSec: 4 };   // ±~28° left/right, ±15° up/down

/** One step of a damped spring (x, v) towards target; stable for any dt (sub-stepped). ζ < 1 overshoots a little. */
export function springStep(s, target, omega, zeta, dt) {
  const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
  for (let i = 0; i < n; i++) { const a = omega * omega * (target - s.x) - 2 * zeta * omega * s.v; s.v += a * h; s.x += s.v * h; }
  return s.x;
}
const bump = (p) => Math.sin(Math.PI * clamp(p, 0, 1)) ** 2;
const plateau = (p) => { const s = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }; return s(0, 0.3, p) * (1 - s(0.7, 1, p)); };

export const GESTURES = {
  breath: { dur: 4.4, shape: (p) => ({ breathAmp: 1.3 * bump(p), shL: 0.5 * bump(p), shR: 0.5 * bump(p) }) },          // a deep breath
  tilt: { dur: 3.0, shape: (p, d) => ({ tilt: 0.06 * d * plateau(p) }) },                                               // tilts the head
  greet: { dur: 1.9, shape: (p, d) => ({ nod: 0.7 * bump(p) * (0.5 - 0.5 * Math.cos(4 * Math.PI * p)), tilt: 0.07 * d * plateau(p) }) },   // answers a wave: a nod with a tilt
  nod: { dur: 1.7, shape: (p) => ({ nod: 0.9 * bump(p) * (0.5 - 0.5 * Math.cos(4 * Math.PI * p)) }) },                  // a light double nod
  look: { dur: 3.4, shape: (p, d) => ({ yaw: 0.17 * d * plateau(p), tilt: 0.015 * d * plateau(p) }) },                   // looks aside and back
  shrug: { dur: 1.7, shape: (p) => ({ shL: 1.1 * bump(p), shR: 0.95 * bump(p), nod: -0.2 * bump(p) }) },                 // shrugs the shoulders
};
const GESTURE_WEIGHTS = {
  idle: { breath: 3, tilt: 2, nod: 1, look: 3, shrug: 1 }, listening: { breath: 1, tilt: 3, nod: 3, look: 1, shrug: 0.3 },
  thinking: { breath: 1, tilt: 4, nod: 0.5, look: 2, shrug: 1 }, speaking: { breath: 1, tilt: 1.5, nod: 2.5, look: 1, shrug: 1 },
};
export const HEART_BPM = { idle: 56, listening: 66, thinking: 92, speaking: 74 };
/** How strongly the figure answers hand gestures. */
export const HANDFX = { swipeTurn: 0.5, offerLean: 0.55, nearLean: 0.45 };

/**
 * @param {number} [seed]
 * update(dt, { state, level, pointer: {x, y, idle}|null (ref px; null = no pointer on screen), reduced, refW, refH }) → rig values (see the bottom of update()).
 */
export function createRig(seed = 7) {
  const rand = rng(seed);
  let t = 0, breathPh = rand(), heartPh = rand(), lastBeat = -9, beatStr = 0.6, thinkWaveAt = 0;
  let gesture = null, nextGestureAt = 2.5 + rand() * 5;
  const waves = [];   // { x, y (normalized), age, str, speed }
  const sp = {};      // two-stage smoothing (continuous value and slope)
  const smooth = (k, target, tau, dt) => { const s = (sp[k] ||= { a: target, b: target }); const f = 1 - Math.exp(-dt / tau); s.a += (target - s.a) * f; s.b += (s.a - s.b) * f; return s.b; };
  let lvlFast = 0, lvlSlow = 0, lvlPrev = 0, gestures = 0;
  const head = { yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 } }, eye = { yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 } };
  let blinkAt = 3 + rand() * 4, blinkT0 = -9, blinks = 0;
  let bodyPh = rand() * 6.28, camPh = rand() * 6.28, camPh2 = rand() * 6.28;
  const clicks = [];
  const kick = { x: 0, v: 0 }; let kickT = 0, kickAt = -9;   // a hand swipe turns the body that way for a moment   // click / tap impulses: { x, y (ref px), age, str } (str 0: outside the figure, light only)

  function beat(str) { lastBeat = t; beatStr = str; heartPh = 0; waves.push({ x: CHEST[0], y: CHEST[1], age: 0, str, speed: 640 }); }

  function update(dt, { state = 'idle', level = 0, pointer = null, reduced = false, refW = 1672, refH = 941, hand = null } = {}) {
    dt = clamp(+dt || 0, 0, 0.1);
    t += dt;
    const st = HEART_BPM[state] ? state : 'idle';
    const speaking = st === 'speaking', thinking = st === 'thinking', listening = st === 'listening';
    // voice envelope: fast and slow followers; their difference is the syllable rhythm
    lvlFast += (level - lvlFast) * (1 - Math.exp(-dt / 0.05));
    lvlSlow += (level - lvlSlow) * (1 - Math.exp(-dt / 0.45));
    const voice = speaking ? clamp(lvlFast, 0, 1) : 0;

    // ---- gestures (every few seconds to ~15 s, never two at once)
    if (!gesture && t >= nextGestureAt) {
      const w = GESTURE_WEIGHTS[st]; const keys = Object.keys(w); let r = rand() * keys.reduce((s, k) => s + w[k], 0);
      const type = keys.find((k) => (r -= w[k]) <= 0) || 'breath';
      gesture = { type, t0: t, dur: GESTURES[type].dur * (0.85 + 0.3 * rand()), dir: rand() < 0.5 ? -1 : 1 }; gestures++;
    }
    let g = {};
    if (gesture) {
      const p = (t - gesture.t0) / gesture.dur;
      if (p >= 1) { gesture = null; nextGestureAt = t + (speaking ? 7 : 3.5) + rand() * (speaking ? 9 : 10); } else g = GESTURES[gesture.type].shape(p, gesture.dir);
    }

    // ---- breathing: irregular rate and depth; inhale a little quicker than exhale
    const bHz = (speaking ? 0.27 : thinking ? 0.25 : 0.2) * (1 + 0.2 * fbm(t * 0.07, seed + 1));
    breathPh += bHz * dt * (g.breathAmp ? 0.65 : 1);
    const ph = breathPh * Math.PI * 2;
    const depth = (0.8 + 0.25 * fbm(t * 0.11, seed + 2)) * (1 + (g.breathAmp || 0));
    const breath = (Math.sin(ph) + 0.22 * Math.sin(2 * ph - 0.6)) * depth;

    // ---- heart: rate by state (with variability); while speaking it also beats on the voice's onsets
    const bpm = (HEART_BPM[st] + (speaking ? 22 * lvlSlow : 0)) * (1 + 0.05 * fbm(t * 0.3, seed + 3));
    heartPh += (bpm / 60) * dt;
    const strBase = speaking ? 0.55 + 0.6 * lvlSlow : thinking ? 0.8 : listening ? 0.7 : 0.6;
    if (heartPh >= 1) beat(strBase);
    if (speaking && lvlFast > 0.3 && lvlPrev <= 0.3 && t - lastBeat > 0.32) beat(0.55 + 0.6 * lvlFast);
    lvlPrev = lvlFast;
    if (thinking && t >= thinkWaveAt) { thinkWaveAt = t + 0.7 + rand() * 0.6; waves.push({ x: FOREHEAD[0], y: FOREHEAD[1], age: 0, str: 0.75, speed: 520 }); }
    for (const w of waves) w.age += dt;
    while (waves.length && (waves[0].age > 2.4 || waves.length > 4)) waves.shift();

    // ---- the gaze: face and eyes follow the pointer (eyes first, the head a moment later on a soft spring); front again after a long rest
    const headX = HEAD[0] * refW, eyeY = EYES[1] * refH;
    const engaged = !!pointer && (pointer.idle ?? 0) < LOOK.idleSec;
    const eng = smooth('eng', engaged ? 1 : 0, engaged ? 0.25 : 0.9, dt);
    const k = reduced ? 0.4 : 1;
    const yawT = engaged ? clamp(Math.atan2(pointer.x - headX, LOOK.distance), -LOOK.maxYaw, LOOK.maxYaw) * k : 0;
    const pitchT = engaged ? clamp(Math.atan2(pointer.y - eyeY, LOOK.distance * 1.1), -LOOK.maxPitch, LOOK.maxPitch) * k : 0;
    springStep(head.yaw, yawT, engaged ? 5.2 : 1.8, 0.82, dt); springStep(head.pitch, pitchT, engaged ? 5.2 : 1.8, 0.82, dt);
    springStep(eye.yaw, yawT, 22, 0.9, dt); springStep(eye.pitch, pitchT, 22, 0.9, dt);
    const near = engaged ? clamp((380 - Math.hypot(pointer.x - headX, pointer.y - eyeY)) / 300, 0, 1) * eng : 0;
    // the body swings slowly left and right (irregular speed and reach); the camera orbits on its own, longer, irregular course
    bodyPh += dt * 0.16 * (1 + 0.35 * fbm(t * 0.05, seed + 22)); camPh += dt * 0.105 * (1 + 0.4 * fbm(t * 0.04, seed + 23)); camPh2 += dt * 0.07 * (1 + 0.4 * fbm(t * 0.03, seed + 24));
    for (const c of clicks) c.age += dt;
    while (clicks.length && (clicks[0].age > 2.5 || clicks.length > 3)) clicks.shift();
    // blinking: every 3-7 s (now and then twice), the eye light closes for ~0.16 s
    if (t >= blinkAt) { blinkT0 = t; blinks++; blinkAt = t + (rand() < 0.15 ? 0.32 : 3 + rand() * 4); }
    const eyeOpen = 1 - bump((t - blinkT0) / 0.16) * 0.92;

    // a hand held up open (offer) draws it in; the hand's distance (near +1 .. far -1) makes it lean in / draw back and the eyes glow more / less
    const offer = smooth('offer', hand?.offer ? 1 : 0, 0.45, dt), hNear = smooth('hnear', hand ? hand.near || 0 : 0, 0.4, dt);
    const lean = smooth('lean', Math.min(1.4, (listening ? 1 : speaking ? 0.35 : 0) + 0.6 * near + HANDFX.offerLean * offer + HANDFX.nearLean * hNear), 0.6, dt);
    springStep(kick, t - kickAt < 1.2 ? kickT : 0, 3.2, 0.75, dt);
    const think = smooth('think', thinking ? 1 : 0, 0.5, dt);
    const out = {
      t, breath, chestExp: breath,
      shL: 0.32 * breath + 0.28 * fbm(t * 0.15, seed + 11) + (g.shL || 0) + 0.25 * voice * fbm(t * 1.7, seed + 12),
      shR: 0.3 * breath + 0.28 * fbm(t * 0.13, seed + 13) + (g.shR || 0) + 0.25 * voice * fbm(t * 1.9, seed + 14),
      sway: 0.0045 * fbm(t * 0.055, seed + 4),                                              // the weight shifts slowly
      tilt: (0.022 * fbm(t * 0.09, seed + 5) + (g.tilt || 0)) * (1 - 0.6 * eng) + 0.045 * think + 0.1 * head.yaw.x + 0.012 * voice * fbm(t * 2.3, seed + 6),
      yaw: (0.06 * fbm(t * 0.05, seed + 7) + (g.yaw || 0)) * (1 - 0.75 * eng) + head.yaw.x + 0.02 * voice * fbm(t * 1.3, seed + 8),
      pitch: head.pitch.x,
      // where the eyes look inside the face (-1..1): ahead of the head while it is still turning, and a little towards the target
      gazeX: clamp((eye.yaw.x - head.yaw.x) * 2.4 + eye.yaw.x * 0.5, -1, 1), gazeY: clamp((eye.pitch.x - head.pitch.x) * 2.4 + eye.pitch.x * 0.6, -1, 1),
      eyeOpen, eyeSize: (1 + 0.35 * near) * (1 + 0.25 * Math.max(0, hNear) + 0.15 * offer) * (1 - 0.15 * Math.max(0, -hNear)), eyeGlow: (1 + 0.7 * near + 0.45 * voice + 0.15 * (listening ? 1 : 0) + 0.5 * offer + 0.4 * hNear) * (1 - 0.25 * think + 0.2 * think * Math.sin(t * 3)),
      eng, near, blinks,
      nod: 0.22 * fbm(t * 0.11, seed + 9) + 0.35 * lean + (g.nod || 0),
      lean,
      bob: speaking ? clamp((lvlFast - lvlSlow) * 3, -1, 1) : 0,                           // the head and throat move with the voice's rhythm
      voice,
      beat: beatEnv(t - lastBeat) * beatStr * (1 + 0.5 * offer),
      offer, handNear: hNear,
      outlinePulse: 0.5 + 0.5 * Math.sin(t * 0.75 + 1.3 * fbm(t * 0.1, seed + 10)),
      clicks: clicks.map((c) => ({ ...c })),
      // the body turns slowly on its own and a little with the gaze; the camera drifts around it (parallax)
      bodyYaw: (0.36 + 0.1 * fbm(t * 0.03, seed + 20)) * Math.sin(bodyPh) + 0.3 * head.yaw.x + kick.x,     // ±~20-26° (+ a swipe's turn)
      torsoPitch: 0.045 * fbm(t * 0.04, seed + 25) + 0.02 * breath,
      camYaw: (0.27 + 0.06 * fbm(t * 0.02, seed + 21)) * Math.sin(camPh) + 0.03 * fbm(t * 0.05, seed + 26),   // ±~15-19°
      camPitch: 0.11 * Math.sin(camPh2) + 0.02 * fbm(t * 0.06, seed + 27),                         // ±~6-7°
      waves: waves.map((w) => ({ ...w })),
      bpm, gesture: gesture?.type || null, gestures,
    };
    return out;
  }
  /** A click / tap at (x, y) in reference px: a shock ring, and (str > 0, on the figure) the particles there are pushed aside for about a second. */
  function click(x, y, str = 1) { clicks.push({ x, y, age: 0, str: clamp(str, 0, 1) }); while (clicks.length > 3) clicks.shift(); }
  /** A hand swipe: the body turns that way (dir -1 / +1) and comes back. */
  function swipe(dir, reduced = false) { kickT = Math.sign(dir) * HANDFX.swipeTurn * (reduced ? 0.4 : 1); kickAt = t; }
  /** A gesture right now (e.g. 'greet' to answer a wave), replacing whatever gesture was running. */
  function gestureNow(type, dir = rand() < 0.5 ? -1 : 1) { if (!GESTURES[type]) return; gesture = { type, t0: t, dur: GESTURES[type].dur, dir }; gestures++; }
  return { update, click, swipe, gestureNow, get time() { return t; } };
}
