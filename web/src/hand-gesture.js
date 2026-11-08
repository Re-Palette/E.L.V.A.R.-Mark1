// ヒューマンプロトコル: hand gestures from hand landmarks (MediaPipe HandLandmarker layout: 21 points, x / y in 0..1 of the camera image).
// Pure (no DOM, no camera): the camera / detector lives in hand-source.js and feeds update() with what it sees; node:test feeds synthetic hands.
// Robust against noise: One-Euro smoothing, hysteresis on every pose, cooldowns on every event.

/** Thresholds and strengths (all in one place, to tune). Distances are relative to the hand's own size (wrist → middle-finger knuckle). */
export const HAND = {
  margin: 0.1,             // the outer 10 % of the camera image maps past the screen edge (so the edges are reachable)
  minCutoff: 1.4, beta: 2.5, dCutoff: 1.0,   // One-Euro filter (normalized units)
  lostAfter: 0.25,         // s without a hand before it counts as gone
  fadeOut: 1.0,            // s over which the gaze returns to the cursor / the front after the hand is gone
  pinchOn: 0.33, pinchOff: 0.5,               // thumb tip ↔ index tip
  fistOn: 0.12, fistMaxExtended: 1, fistOffExtended: 3,   // s held, extended fingers to count as a fist / to release it
  tapCooldown: 0.6,        // s between two pinch / fist "taps"
  swipeWindow: 0.18, swipeSpeed: 1.5, swipeMinDx: 0.16, swipeCooldown: 0.9,   // fast sideways move (screen widths / s, travelled)
  holdSpeed: 0.12, holdTime: 0.4,             // an open palm held still
  waveWindow: 1.6, waveReversals: 3, waveMinAmp: 0.035, waveCooldown: 2.5,   // an open palm moved left-right a few times
  nearScale: 0.24, farScale: 0.1,             // hand size (of the image height) for "near" (+1) / "far" (-1)
};

const TIP = [4, 8, 12, 16, 20], PIP = [3, 6, 10, 14, 18], PALM = [0, 5, 9, 13, 17];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const dist = (a, b, ax = 1) => Math.hypot((a.x - b.x) * ax, a.y - b.y);

/** Palm centre (wrist and the four knuckles). */
export function palmCenter(lm) { let x = 0, y = 0; for (const i of PALM) { x += lm[i].x; y += lm[i].y; } return { x: x / PALM.length, y: y / PALM.length }; }
/** The hand's size in the image (wrist → middle-finger knuckle), in units of the image height. */
export const handScale = (lm, aspect = 4 / 3) => dist(lm[0], lm[9], aspect);
/** How many of the four long fingers are stretched out (tip farther from the wrist than its middle joint). */
export function extendedFingers(lm, aspect = 4 / 3) { let n = 0; for (let f = 1; f < 5; f++) if (dist(lm[0], lm[TIP[f]], aspect) > dist(lm[0], lm[PIP[f]], aspect) * 1.12) n++; return n; }
export const pinchRatio = (lm, aspect = 4 / 3) => dist(lm[4], lm[8], aspect) / Math.max(1e-4, handScale(lm, aspect));
/** Camera image (0..1, as the camera sees it) → screen px, mirrored (move the hand right, the point moves right). */
export function toScreen(p, vw, vh, margin = HAND.margin) {
  const u = clamp((1 - p.x - margin) / (1 - 2 * margin), 0, 1), v = clamp((p.y - margin) / (1 - 2 * margin), 0, 1);
  return { x: u * vw, y: v * vh };
}

/** One-Euro filter (smooths jitter when slow, follows quickly when fast). */
export function oneEuro({ minCutoff = HAND.minCutoff, beta = HAND.beta, dCutoff = HAND.dCutoff } = {}) {
  let x = null, dx = 0, tPrev = 0;
  const alpha = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
  return {
    filter(v, t) {
      if (x === null) { x = v; tPrev = t; return v; }
      const dt = Math.max(1e-3, t - tPrev); tPrev = t;
      const d = (v - x) / dt; dx += alpha(dCutoff, dt) * (d - dx);
      x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
      return x;
    },
    reset() { x = null; dx = 0; },
  };
}

function handState() {
  return { fx: oneEuro(), fy: oneEuro(), hist: [], pinched: false, fist: false, fistSince: -1, lastTap: -9, lastSwipe: -9, lastWave: -9, still: -1, holding: false, rev: [], lastDir: 0, lastExt: null, seen: -9 };
}

/**
 * update(hands, t, { vw, vh, aspect }) with hands = [ [21 × {x, y, z}], … ] (0, 1 or 2 hands), t in seconds.
 * Returns { present, weight (1 while seen, fading to 0 over HAND.fadeOut after), target {x, y} (screen px; the midpoint of two hands),
 *           near (-1 far .. +1 near), open, holding, events: [{ type: 'pinch' | 'fist' | 'swipe' | 'wave' | 'hold', x, y, dir? }] }.
 */
export function createGestureTracker(opts = {}) {
  const C = { ...HAND, ...opts };
  const slots = [handState(), handState()];
  let lastSeen = -9, lastTarget = null, nearS = 0;
  function update(hands, t, { vw = 1, vh = 1, aspect = 4 / 3 } = {}) {
    const events = [];
    const list = (hands || []).filter((h) => h && h.length >= 21).slice(0, 2);
    // keep each hand in its slot: sorted by (mirrored) x
    const sorted = list.map((lm) => ({ lm, c: palmCenter(lm) })).sort((a, b) => (1 - a.c.x) - (1 - b.c.x));
    const pts = [];
    let open = false, holding = false, scaleSum = 0;
    sorted.forEach(({ lm, c }, k) => {
      const s = slots[k];
      if (t - s.seen > C.lostAfter) { s.fx.reset(); s.fy.reset(); s.hist = []; s.rev = []; s.still = -1; s.holding = false; }
      s.seen = t;
      const sx = s.fx.filter(1 - c.x, t), sy = s.fy.filter(c.y, t);     // mirrored, smoothed (0..1)
      const scr = toScreen({ x: 1 - sx, y: sy }, vw, vh, C.margin);
      pts.push(scr);
      const scale = handScale(lm, aspect); scaleSum += scale;
      const ext = extendedFingers(lm, aspect), isOpen = ext >= 4;
      open ||= isOpen;
      s.hist.push({ t, x: sx, y: sy }); while (s.hist.length && t - s.hist[0].t > C.waveWindow) s.hist.shift();
      // pinch (hysteresis) → a tap at the fingertips
      const pr = pinchRatio(lm, aspect);
      // (a fist also brings thumb and index together: that is not a pinch)
      if (!s.pinched && pr < C.pinchOn && ext >= 2) { s.pinched = true; if (t - s.lastTap > C.tapCooldown) { s.lastTap = t; const m = toScreen({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }, vw, vh, C.margin); events.push({ type: 'pinch', x: m.x, y: m.y }); } }
      else if (s.pinched && pr > C.pinchOff) s.pinched = false;
      // fist (held briefly; hysteresis on the number of stretched fingers) → a tap at the palm
      if (!s.fist && ext <= C.fistMaxExtended && !s.pinched) { if (s.fistSince < 0) s.fistSince = t; if (t - s.fistSince >= C.fistOn) { s.fist = true; if (t - s.lastTap > C.tapCooldown) { s.lastTap = t; events.push({ type: 'fist', x: scr.x, y: scr.y }); } } }
      else if (ext > C.fistMaxExtended) s.fistSince = -1;
      if (s.fist && ext >= C.fistOffExtended) s.fist = false;
      // swipe: a fast sideways move over a short window
      const w = s.hist.filter((h) => t - h.t <= C.swipeWindow);
      if (w.length >= 2) {
        const dx = w.at(-1).x - w[0].x, dt = Math.max(1e-3, w.at(-1).t - w[0].t);
        if (Math.abs(dx) >= C.swipeMinDx && Math.abs(dx / dt) >= C.swipeSpeed && t - s.lastSwipe > C.swipeCooldown && t - s.lastWave > 0.5) { s.lastSwipe = t; events.push({ type: 'swipe', dir: Math.sign(dx), x: scr.x, y: scr.y }); s.rev = []; }
      }
      // wave: an open palm reversing direction a few times, each leg large enough
      if (isOpen && s.hist.length >= 2) {
        const a = s.hist.at(-2), b = s.hist.at(-1), d = Math.sign(b.x - a.x);
        if (d && d !== s.lastDir) { if (s.lastExt !== null && Math.abs(b.x - s.lastExt) >= C.waveMinAmp) s.rev.push(t); s.lastExt = a.x; s.lastDir = d; }
        s.rev = s.rev.filter((r) => t - r <= C.waveWindow);
        if (s.rev.length >= C.waveReversals && t - s.lastWave > C.waveCooldown && t - s.lastSwipe > 0.4) { s.lastWave = t; s.rev = []; events.push({ type: 'wave', x: scr.x, y: scr.y }); }
      } else if (!isOpen) { s.rev = []; s.lastExt = null; }
      // hold: an open palm kept still
      const sp = w.length >= 2 ? Math.hypot(w.at(-1).x - w[0].x, w.at(-1).y - w[0].y) / Math.max(1e-3, w.at(-1).t - w[0].t) : 0;
      if (isOpen && sp < C.holdSpeed) { if (s.still < 0) s.still = t; if (!s.holding && t - s.still >= C.holdTime) { s.holding = true; events.push({ type: 'hold', x: scr.x, y: scr.y }); } }
      else { s.still = -1; if (s.holding && (!isOpen || sp > C.holdSpeed * 2)) s.holding = false; }
      holding ||= s.holding;
    });
    for (let k = sorted.length; k < 2; k++) if (t - slots[k].seen > C.lostAfter) { slots[k].holding = false; slots[k].pinched = false; slots[k].fist = false; }
    if (pts.length) { lastSeen = t; lastTarget = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0]; }
    const gone = t - lastSeen;
    const present = gone <= C.lostAfter;
    const weight = present ? 1 : clamp(1 - (gone - C.lostAfter) / C.fadeOut, 0, 1);
    if (pts.length) { const sc = scaleSum / pts.length; const nT = clamp(((sc - C.farScale) / (C.nearScale - C.farScale)) * 2 - 1, -1, 1); nearS += (nT - nearS) * 0.25; }
    else nearS *= 0.9;
    return { present, weight, target: weight > 0 ? lastTarget : null, near: nearS, open, holding, events, count: pts.length };
  }
  return { update, reset() { slots[0] = handState(); slots[1] = handState(); lastSeen = -9; lastTarget = null; nearS = 0; } };
}

// ---------------------------------------------------------------- synthetic hands (tests, debug injection)
/** A synthetic hand at palm centre (cx, cy) in camera coordinates (0..1, as the camera sees it), size s (wrist → knuckle, of the image height).
 *  pose: 'open' | 'fist' | 'pinch'. */
export function syntheticHand(cx, cy, { s = 0.16, pose = 'open', aspect = 4 / 3 } = {}) {
  const P = (dx, dy) => ({ x: cx + (dx * s) / aspect, y: cy + dy * s, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0.55);                                   // wrist (below the palm)
  const knuckles = [[-0.45, -0.3], [-0.2, -0.45], [0.05, -0.48], [0.28, -0.44], [0.48, -0.36]];   // thumb CMC-ish, index..pinky MCP
  lm[5] = P(...knuckles[1]); lm[9] = P(...knuckles[2]); lm[13] = P(...knuckles[3]); lm[17] = P(...knuckles[4]);
  lm[1] = P(-0.42, 0.25); lm[2] = P(-0.6, 0.05);
  const fingers = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  fingers.forEach(([m, p1, p2, tip], f) => {
    const [kx, ky] = knuckles[f + 1];
    if (pose === 'fist') { lm[p1] = P(kx, ky - 0.15); lm[p2] = P(kx, ky + 0.05); lm[tip] = P(kx * 0.8, ky + 0.25); }
    else { lm[p1] = P(kx * 1.1, ky - 0.35); lm[p2] = P(kx * 1.15, ky - 0.58); lm[tip] = P(kx * 1.2, ky - 0.8); }
  });
  if (pose === 'pinch') { lm[3] = P(-0.45, -0.55); lm[4] = P(-0.3, -1.05); lm[8] = P(-0.27, -1.08); lm[6] = P(-0.25, -0.75); lm[7] = P(-0.27, -0.95); }
  else if (pose === 'fist') { lm[3] = P(-0.5, -0.1); lm[4] = P(-0.2, -0.1); }
  else { lm[3] = P(-0.8, -0.15); lm[4] = P(-0.95, -0.35); }
  return lm;
}
