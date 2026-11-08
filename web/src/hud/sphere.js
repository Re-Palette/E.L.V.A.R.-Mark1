// Center "core" sphere (ELVAR gold theme): dark glass globe with a golden constellation mesh, metal rings,
// and a tilted orbit ring with travelling flares. Canvas 2D.
// Design space is 760 units tall (centre 380,380); the desktop canvas is wider (GEOM.W) so the orbit ring fits.
// Audio-reactive (level/pitch with attack/release smoothing) and state-reactive.

const SIZE = 760;
const C = SIZE / 2;
// Per-layout geometry (design units; the canvas is always 760x760).
//  desktop: traced from the 1671x941 reference (unchanged).
//  mobile:  traced from the 852x1846 phone reference, 1 unit = 1 reference px (sphere centre = canvas centre).
const GEOM = {
  // orbit: tilted elliptical ring (rx/ry design units, rot degrees, band = ribbon width at the ends)
  desktop: { R: 172, MESH_MAX: 194, RIPPLE_MAX: 204, W: 1000, nodes: 600, mesh: { jitter: 0.18, k0: 4, extra: 0.35, chord: 0.03, seed: 7 }, orbit: { rx: 452, ry: 88, rot: -15, band: 15 } }, // inner thin ring r=207
  mobile: { R: 150, MESH_MAX: 176, RIPPLE_MAX: 184, W: SIZE, nodes: 560, mesh: { jitter: 0.2, k0: 4, extra: 0.6, chord: 0.05, seed: 11 },
    orbit: { rx: 352, ry: 66, rot: -14, band: 12 } }, // innermost thin ring r=188
};
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// Thick bright arcs (degrees, canvas convention: 0 = 3 o'clock, clockwise), traced from the reference.
const THICK_ARCS = [
  { s: 160, e: 303, w: 1.0 },
  { s: 311, e: 334, w: 0.75 },
  { s: 344, e: 372, w: 0.9 },
  { s: 28, e: 124, w: 1.0 },
];
const THIN_ARCS = [
  { s: 128, e: 152, r: 233, hi: true },
  { s: 200, e: 262, r: 233 },
  { s: 300, e: 318, r: 233 },
  { s: 20, e: 40, r: 233 },
];

// hue ~38 = ELVAR gold (#E8B96A family); error turns red-orange.
const STATE_PARAMS = {
  idle: { arcSpeed: 0.035, meshSpeed: 0.16, core: 1.0, hue: 35, sweep: 0, swirl: 0, orb: 0.2 },
  connecting: { arcSpeed: 1.5, meshSpeed: 0.3, core: 0.7, hue: 33, sweep: 1, swirl: 0, orb: 0.9 },
  listening: { arcSpeed: 0.06, meshSpeed: 0.18, core: 1.05, hue: 37, sweep: 0, swirl: 0, orb: 0.3 },
  thinking: { arcSpeed: 0.75, meshSpeed: 0.42, core: 1.0, hue: 39, sweep: 0, swirl: 1, orb: 0.65 },
  speaking: { arcSpeed: 0.1, meshSpeed: 0.2, core: 1.12, hue: 34, sweep: 0, swirl: 0, orb: 0.35 },
  error: { arcSpeed: 0.02, meshSpeed: 0.06, core: 0.75, hue: 6, sweep: 0, swirl: 0, orb: 0.06 },
};

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildMesh(n = 640, { jitter = 0.35, k0 = 3, extra = 0.35, chord = 0.12, seed = 7 } = {}) {
  const rnd = mulberry(seed);
  const pts = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = ga * i + (rnd() - 0.5) * jitter;
    let x = Math.cos(th) * rr, z = Math.sin(th) * rr, yy = y + (rnd() - 0.5) * 0.04;
    const l = Math.hypot(x, yy, z);
    pts.push({ x: x / l, y: yy / l, z: z / l, ph: rnd() * TAU, tw: rnd(), lat: Math.asin(yy / l) });
  }
  // connect each node to its 3 nearest neighbours (+ occasional longer chord)
  const edges = new Set();
  for (let i = 0; i < n; i++) {
    const d = [];
    for (let j = 0; j < n; j++) if (j !== i) {
      const a = pts[i], b = pts[j];
      d.push([(a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2, j]);
    }
    d.sort((p, q) => p[0] - q[0]);
    const k = k0 + (rnd() < extra ? 1 : 0);
    for (let m = 0; m < k; m++) { const j = d[m][1]; edges.add(i < j ? i * 1000 + j : j * 1000 + i); }
    if (rnd() < chord) { const j = d[6 + Math.floor(rnd() * 8)][1]; edges.add(i < j ? i * 1000 + j : j * 1000 + i); }
  }
  return { pts, edges: [...edges].map((e) => [Math.floor(e / 1000), e % 1000]) };
}

// tick-ring geometry (static, seeded)
function buildTicks() {
  const rnd = mulberry(21);
  const t = [];
  for (let a = 0; a < 360; a += 2.4) {
    const r = rnd();
    if (r < 0.18) continue;
    t.push({ a: a * DEG, len: 3 + rnd() * 8, alpha: 0.3 + rnd() * 0.6, bright: rnd() < 0.12 });
  }
  return t;
}

// Phone reference: 6 bright arcs on a slightly tall ellipse (rx 223 / ry 231), degrees in canvas convention.
const MOBILE_ARCS = [
  { s: 351, e: 386 }, // right
  { s: 55, e: 121 }, // bottom
  { s: 136, e: 152 }, // lower-left short
  { s: 166, e: 218 }, // left
  { s: 237, e: 302 }, // top
  { s: 318, e: 338 }, // upper-right short
];
const MOBILE_THIN_ARCS = [
  { s: 192, e: 216, r: 236 },
  { s: 22, e: 34, r: 236 },
];

function buildMobileTicks() {
  const rnd = mulberry(33);
  const dash = [], fine = [];
  for (let a = 0; a < 360; a += 2.45) {
    if (rnd() < 0.06) continue;
    dash.push({ a: a * DEG, alpha: 0.45 + rnd() * 0.55, len: 4.5 + rnd() * 2.5 });
  }
  for (let a = 0; a < 360; a += 1.2) {
    if (rnd() < 0.3) continue;
    fine.push({ a: a * DEG, alpha: 0.12 + rnd() * 0.3, len: 2 + rnd() * 6 });
  }
  return { dash, fine };
}

export class SphereRenderer {
  constructor(canvas, { reducedMotion = false, variant = 'desktop' } = {}) {
    this.cv = canvas;
    this.variant = variant === 'mobile' ? 'mobile' : 'desktop';
    this.g = GEOM[this.variant];
    this.ctx = canvas.getContext('2d');
    this.mesh = buildMesh(this.g.nodes || 640, this.g.mesh);
    this.ticks = buildTicks();
    if (this.variant === 'mobile') this.mticks = buildMobileTicks();
    this.proj = new Float32Array(this.mesh.pts.length * 4); // x, y, depth(0..1), brightness
    this.reduced = reducedMotion;
    this.state = 'idle';
    this.p = { ...STATE_PARAMS.idle };
    this.audio = { level: 0, pitch: 0.5, source: 'mic' };
    this.lvl1 = 0; this.lvl = 0; this.pitch = 0.5; this.modelMix = 0; this.prevLvl = 0;
    this.t = 0; this.orbPh = 2.2; this.arcRot = 0; this.dashRot = 0; this.meshRot = 0.6; this.sweepRot = -Math.PI / 2;
    this.ripples = []; this.lastRipple = 0;
    this.bw = 0; this.bh = 0; this.k = 1;
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._cost = 0; this._slow = 0; this._lite = false; this._q = 1; this._rzAt = 0;
    this._loop = this._loop.bind(this);
    this._onVis = () => (document.hidden ? this._pause() : this._resume());
    document.addEventListener('visibilitychange', this._onVis);
  }

  setState(s) { if (STATE_PARAMS[s]) this.state = s; }
  setAudio({ level = 0, pitch = 0.5, source = 'mic' } = {}) {
    this.audio.level = Math.max(0, Math.min(1, +level || 0));
    this.audio.pitch = Math.max(0, Math.min(1, pitch == null || Number.isNaN(+pitch) ? 0.5 : +pitch));
    this.audio.source = source === 'model' ? 'model' : 'mic';
  }
  get smoothedLevel() { return this.lvl; }

  start() { if (this.running) return; this.running = true; if (!document.hidden) this._resume(); }
  stop() { this.running = false; this._pause(); }
  destroy() { this.stop(); document.removeEventListener('visibilitychange', this._onVis); }
  _pause() { cancelAnimationFrame(this._raf); this._raf = 0; }
  _resume() { if (!this.running || this._raf) return; this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }

  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    // Nothing is being said: the slow idle drift looks identical at 30 fps and costs half as much.
    const quiet = this.state === 'idle' && this.lvl < 0.02 && this.audio.level < 0.02;
    if (quiet && now - this._last < 29) return;
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    const t0 = performance.now();
    this._update(dt);
    this._draw();
    // Auto lite mode: if drawing keeps costing >11 ms (older phone), render at 70 % resolution (CSS scales it back up).
    const cost = performance.now() - t0;
    this._cost = this._cost ? this._cost * 0.95 + cost * 0.05 : cost;
    if (this._cost > 11 && !this._lite) { if (++this._slow > 90) { this._lite = true; this._q = 0.7; this._rzAt = 0; } } else this._slow = 0;
  }

  /** Render a single frame immediately (used for first paint). */
  renderOnce() { this._update(0); this._draw(); }

  _resize() {
    // getBoundingClientRect forces a layout: do it a couple of times a second, not every frame.
    const now = performance.now();
    if (this.bw && now - (this._rzAt || 0) < 500) return this.k;
    this._rzAt = now;
    const rect = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * (this._q || 1);   // >2x is invisible on a glow HUD but costs 2x the pixels
    const W = this.g.W || SIZE;
    let w = Math.round(rect.width * dpr);
    w = Math.max(64, Math.min(w, Math.round(1400 * W / SIZE))); // cap backing store for perf
    const h = Math.round(w * SIZE / W);
    if (w !== this.bw || h !== this.bh) { this.bw = w; this.bh = h; this.cv.width = w; this.cv.height = h; }
    this.k = w / W;
    return this.k;
  }

  _update(dt) {
    const speed = this.reduced ? 0.35 : 1;
    // --- audio smoothing: fast attack, slower release ---
    // gate away mic noise floor, soft-compress peaks, then TWO low-pass stages so the
    // sphere follows the speech envelope (syllable rhythm), not per-frame loudness jitter.
    const gated = Math.max(0, (this.audio.level - 0.06) / 0.94);
    const tgt = (1 - Math.exp(-2.2 * gated)) / (1 - Math.exp(-2.2)); // 0..1, compresses mid/loud peaks
    // While the assistant speaks (modelMix -> 1) the response is calmer: the played-back voice has sharp, uneven syllable peaks (time-stretched)
    // that made the sphere twitch. Slower attack/release and a longer second stage give one smooth swell per phrase instead.
    const m = this.modelMix;
    const tau1 = tgt > this.lvl1 ? 0.07 + 0.09 * m : 0.32 + 0.30 * m;
    const e1 = dt ? 1 - Math.exp(-dt / tau1) : 0;
    this.lvl1 += (tgt - this.lvl1) * e1;
    this.prevLvl = this.lvl;
    this.lvl += (this.lvl1 - this.lvl) * (dt ? 1 - Math.exp(-dt / (0.12 + 0.12 * m)) : 0);
    this.pitch += (this.audio.pitch - this.pitch) * (dt ? 1 - Math.exp(-dt / 0.4) : 0);
    const mm = this.audio.source === 'model' ? 1 : 0;
    this.modelMix += (mm - this.modelMix) * (dt ? 1 - Math.exp(-dt / 0.25) : 0);

    // --- state params eased ---
    const sp = STATE_PARAMS[this.state];
    const k = dt ? 1 - Math.exp(-dt / 0.45) : 0;
    for (const key of Object.keys(sp)) {
      if (key === 'hue') {
        // hue: ease along shortest path
        let d = sp.hue - this.p.hue; if (d > 180) d -= 360; if (d < -180) d += 360;
        this.p.hue += d * k;
      } else this.p[key] += (sp[key] - this.p[key]) * k;
    }

    const L = this.lvl;
    this.t += dt * speed;
    // Phases are INTEGRATED (phase += dt * frequency). Using `t * frequency` with a frequency that follows the voice made the phase jump by
    // t * dFrequency every frame (more and more the longer the session ran): that was the violent jitter while speaking.
    this.wPhase = (this.wPhase || 0) + dt * speed * (0.9 + this.pitch * 1.6);
    this.breathPhase = (this.breathPhase || 0) + dt * speed * (this.state === 'connecting' ? 3.2 : 1.25);
    this.arcRot += dt * speed * (this.p.arcSpeed + L * 0.06 * this.modelMix);
    this.dashRot -= dt * speed * (0.025 + this.p.arcSpeed * 0.4);
    this.meshRot += dt * speed * (this.p.meshSpeed + this.pitch * L * 0.12);
    this.sweepRot += dt * speed * 3.2 * this.p.sweep;
    this.orbPh += dt * speed * (this.p.orb + L * (0.15 + 0.35 * this.modelMix));

    // speaking: outward pulse ripples on peaks
    if (!this.reduced && this.modelMix > 0.5 && L > 0.2) {
      const rising = L - this.prevLvl > 0.002;
      if ((rising && this.t - this.lastRipple > 0.45) || this.t - this.lastRipple > 0.9) {
        this.ripples.push({ t0: this.t, a: Math.min(0.8, L) });
        this.lastRipple = this.t;
      }
    }
    this.ripples = this.ripples.filter((r) => this.t - r.t0 < 1.4);
  }

  _col(h, s, l, a) { return `hsla(${h.toFixed(1)},${(s * 0.8).toFixed(0)}%,${l}%,${Math.max(0, a).toFixed(3)})`; }

  _draw() {
    const ctx = this.ctx;
    const k = this._resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.bw, this.bh);
    const ox = ((this.g.W || SIZE) - SIZE) / 2; // the 760 design square sits centred in a wider canvas
    ctx.setTransform(k, 0, 0, k, ox * k, 0);

    const L = this.lvl, P = this.pitch, M = this.modelMix, t = this.t;
    const hue = this.p.hue + (this.state === 'error' ? 0 : (P - 0.5) * 18 * Math.min(1, L * 2));
    const breath = 0.5 + 0.5 * Math.sin(this.breathPhase || 0);
    const errFlick = this.state === 'error' ? 0.85 + 0.15 * Math.sin(t * 7.0) : 1;
    const core = this.p.core * (0.92 + 0.08 * breath + L * (0.28 + 0.3 * M)) * errFlick;
    const scale = 1 + 0.008 * breath + L * (0.016 + 0.024 * M); // max ~1.04
    const ringA = Math.min(1.2, 0.88 + 0.1 * breath + L * (0.18 + 0.18 * M));

    if (this.variant === 'mobile') { this._drawMobile(ctx, L, P, M, hue, breath, core, scale, ringA); return; }

    // ---------- ambient halo (warm light in the ring band; the inside stays dark glass) ----------
    let g = ctx.createRadialGradient(C, C, 0, C, C, 380);
    g.addColorStop(0, this._col(hue, 100, 50, 0));
    g.addColorStop(0.58, this._col(hue + 2, 100, 48, 0.10 * core));
    g.addColorStop(0.8, this._col(hue, 100, 45, 0.05 * core));
    g.addColorStop(1, this._col(hue, 100, 45, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);

    // ---------- orbit ring, far half (then hidden behind the dark disc of the rings) ----------
    this._drawOrbit(ctx, false, L, hue);
    this._occlude(ctx, 322);

    // ---------- dark glass globe ----------
    const Rs = this.g.R * scale;
    this._drawBody(ctx, Rs, hue, core);

    // ---------- mesh ----------
    this._drawMesh(ctx, Rs, L, P, M, hue);

    // ---------- inner swirl (thinking) ----------
    if (this.p.swirl > 0.02) this._drawSwirl(ctx, Rs, hue);

    // ---------- core glow ----------
    this._drawCore(ctx, Rs, hue, core, L, M, 72);

    // ---------- rings ----------
    this._drawRings(ctx, hue, ringA, L, M, breath);

    // ---------- orbit ring, near half (in front of everything) ----------
    this._drawOrbit(ctx, true, L, hue);
  }

  /** Dark disc behind the rings: hides the far half of the orbit, keeps the inner band dark like the reference. */
  _occlude(ctx, r) {
    const g = ctx.createRadialGradient(C, C, 0, C, C, r);
    g.addColorStop(0, 'rgba(6,5,3,0.9)');
    g.addColorStop(0.9, 'rgba(6,5,3,0.9)');
    g.addColorStop(1, 'rgba(6,5,3,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, r, 0, TAU); ctx.fill();
  }

  /** Dark glass globe: warm inner light, smoky body, lit rim and an upper-left specular. */
  _drawBody(ctx, Rs, hue, core) {
    const c1 = Math.min(1, core);
    let g = ctx.createRadialGradient(C, C, 0, C, C, Rs * 1.02);
    g.addColorStop(0, this._col(hue + 4, 100, 52, 0.5 * c1));
    g.addColorStop(0.28, this._col(hue + 2, 90, 34, 0.42 * c1));
    g.addColorStop(0.58, 'rgba(24,17,10,0.62)');
    g.addColorStop(0.86, 'rgba(30,22,13,0.66)');
    g.addColorStop(0.965, this._col(hue, 70, 50, 0.32));
    g.addColorStop(1, this._col(hue, 70, 50, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, Rs * 1.02, 0, TAU); ctx.fill();
    const sx = C - Rs * 0.36, sy = C - Rs * 0.44;
    g = ctx.createRadialGradient(sx, sy, 0, sx, sy, Rs * 0.8);
    g.addColorStop(0, 'rgba(255,238,205,0.15)');
    g.addColorStop(0.5, 'rgba(255,238,205,0.04)');
    g.addColorStop(1, 'rgba(255,238,205,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, Rs, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = this._col(hue - 2, 90, 74, 0.42);
    ctx.beginPath(); ctx.arc(C, C, Rs * 1.005, 0, TAU); ctx.stroke();
  }

  /** Bright core: white-gold hot spot, warm bloom and a thin 8-ray star flare. */
  _drawCore(ctx, Rs, hue, core, L, M, size) {
    ctx.globalCompositeOperation = 'lighter';
    let g = ctx.createRadialGradient(C, C, 0, C, C, Rs * 0.9);
    g.addColorStop(0, this._col(hue + 2, 100, 56, 0.42 * core));
    g.addColorStop(0.45, this._col(hue, 100, 50, 0.14 * core));
    g.addColorStop(1, this._col(hue, 100, 45, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, Rs * 0.9, 0, TAU); ctx.fill();
    const cr = size * (0.92 + 0.14 * L * (0.6 + M)) * Math.min(1.2, core);
    g = ctx.createRadialGradient(C, C, 0, C, C, cr);
    g.addColorStop(0, `rgba(255,252,242,${Math.min(1, core).toFixed(3)})`);
    g.addColorStop(0.08, `rgba(255,240,210,${Math.min(1, 0.92 * core).toFixed(3)})`);
    g.addColorStop(0.24, this._col(hue - 2, 100, 70, 0.62 * Math.min(1, core)));
    g.addColorStop(0.5, this._col(hue + 2, 100, 55, 0.22 * core));
    g.addColorStop(1, this._col(hue + 2, 100, 50, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, cr, 0, TAU); ctx.fill();
    // star flare
    const a0 = this.meshRot * 0.08;
    for (let i = 0; i < 8; i++) {
      const a = a0 + (i * Math.PI) / 4, len = (i % 2 ? 0.5 : 1) * cr * 1.25;
      const x1 = C + Math.cos(a) * len, y1 = C + Math.sin(a) * len;
      const lg = ctx.createLinearGradient(C, C, x1, y1);
      lg.addColorStop(0, `rgba(255,246,226,${(0.75 * Math.min(1, core)).toFixed(3)})`);
      lg.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.strokeStyle = lg; ctx.lineWidth = i % 2 ? 1 : 1.5;
      ctx.beginPath(); ctx.moveTo(C, C); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Lens flare: hot centre, warm bloom and a short horizontal streak. */
  _flare(ctx, x, y, r, a, hue) {
    if (a <= 0.01) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,250,236,${Math.min(1, a).toFixed(3)})`);
    g.addColorStop(0.12, `rgba(255,226,170,${(0.75 * a).toFixed(3)})`);
    g.addColorStop(0.4, this._col(hue, 100, 55, 0.22 * a));
    g.addColorStop(1, this._col(hue, 100, 50, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    const lg = ctx.createLinearGradient(x - r * 2.2, y, x + r * 2.2, y);
    lg.addColorStop(0, 'rgba(255,220,160,0)');
    lg.addColorStop(0.5, `rgba(255,240,210,${(0.6 * a).toFixed(3)})`);
    lg.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(x - r * 2.2, y - 0.8, r * 4.4, 1.6);
  }

  /**
   * Tilted elliptical orbit ring (a thin flat ribbon seen at an angle). near=false draws the far half
   * (upper), near=true the half in front of the globe. Brightness peaks where the ribbon turns edge-on
   * (the two ends); two flares travel along it.
   */
  _drawOrbit(ctx, near, L, hue) {
    const o = this.g.orbit;
    if (!o) return;
    const rot = o.rot * DEG, t0 = near ? 0 : Math.PI, t1 = t0 + Math.PI;
    const A = Math.min(1.15, 0.9 + L * 0.35) * (near ? 1 : 0.8);
    // brightness by polar angle around the centre: ends bright, middle of each half dim
    const grad = (alpha, light) => {
      const cg = ctx.createConicGradient(rot, C, C);
      for (let i = 0; i <= 24; i++) {
        const f = i / 24, k = 0.16 + 0.84 * Math.abs(Math.cos(f * TAU)) ** 4;
        cg.addColorStop(f, light ? `rgba(255,240,214,${Math.min(1, alpha * k * A).toFixed(3)})` : this._col(hue, 100, 60, alpha * k * A));
      }
      return cg;
    };
    const ri = o.rx - o.band, rj = o.ry - o.band * 0.2;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // ribbon body
    ctx.fillStyle = grad(0.3, false);
    ctx.beginPath(); ctx.ellipse(C, C, o.rx, o.ry, rot, t0, t1); ctx.ellipse(C, C, ri, rj, rot, t1, t0, true); ctx.closePath(); ctx.fill();
    // glow, outer bright edge, inner edge
    ctx.strokeStyle = grad(0.12, false); ctx.lineWidth = 12;
    ctx.beginPath(); ctx.ellipse(C, C, o.rx, o.ry, rot, t0, t1); ctx.stroke();
    ctx.strokeStyle = grad(1, true); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(C, C, o.rx, o.ry, rot, t0, t1); ctx.stroke();
    ctx.strokeStyle = grad(0.8, true); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(C, C, ri, rj, rot, t0, t1); ctx.stroke();
    // a fainter companion line just outside (the reference shows a thin second orbit)
    ctx.strokeStyle = grad(0.35, false); ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.ellipse(C, C, o.rx + 10, o.ry + 14, rot + 0.03, t0, t1); ctx.stroke();

    const cr = Math.cos(rot), sr = Math.sin(rot);
    const at = (th, rx = o.rx, ry = o.ry) => { const x = Math.cos(th) * rx, y = Math.sin(th) * ry; return [C + x * cr - y * sr, C + x * sr + y * cr]; };
    const inHalf = (th) => { const u = ((th % TAU) + TAU) % TAU; return near ? u < Math.PI : u >= Math.PI; };
    // travelling flares with fading trails
    for (const ph of [this.orbPh, this.orbPh + Math.PI]) {
      for (let i = 0; i < 10; i++) {
        const a = ph - i * 0.045, b = ph - (i + 1) * 0.045;
        if (!inHalf(a)) continue;
        ctx.strokeStyle = this._col(hue - 4, 100, 78, (1 - i / 10) * 0.8 * A);
        ctx.lineWidth = 2.6 - i * 0.18;
        ctx.beginPath(); ctx.ellipse(C, C, o.rx, o.ry, rot, b, a); ctx.stroke();
      }
      if (inHalf(ph)) { const [x, y] = at(ph); this._flare(ctx, x, y, 26, 0.95 * A, hue); }
    }
    // fixed glints near the ends of the near half
    if (near) {
      for (const [th, r, a] of [[Math.PI * 0.955, 18, 0.75], [Math.PI * 0.86, 12, 0.5], [0.05, 16, 0.7]]) {
        const [x, y] = at(th); this._flare(ctx, x, y, r, a * A, hue);
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawMesh(ctx, Rs, L, P, M, hue) {
    const { pts, edges } = this.mesh;
    const pr = this.proj;
    const MESH_MAX = this.g.MESH_MAX;
    const mob = this.variant === 'mobile';
    const rotY = this.meshRot, tilt = -0.32 + Math.sin(this.t * 0.11) * 0.05;
    const cy = Math.cos(rotY), sy = Math.sin(rotY), ct = Math.cos(tilt), st = Math.sin(tilt);
    const t = this.t;
    const kFreq = 1.5 + P * 2.5; // ripple spatial frequency (intonation) — low = broad, calm swells
    const wPh = this.wPhase || 0;   // ripple temporal phase (integrated in _update)
    const ampOut = (this.reduced ? 0.5 : 1) * L * (0.018 + 0.04 * M); // max ~±3.5% radius
    const mic = 1 - M;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const wave = Math.sin(p.lat * kFreq + wPh + p.ph * 0.6);
      // model: outward travelling waves; mic: slight inward attentive pull + shimmer
      const disp = ampOut * (M * (0.6 + 0.6 * wave) + mic * (0.5 * wave - 0.35)) + 0.004 * Math.sin(t * 0.9 + p.ph);
      const rr = Rs * (1 + disp);
      // rotate Y then tilt X
      let x = p.x * cy + p.z * sy, z = -p.x * sy + p.z * cy, y = p.y;
      const y2 = y * ct - z * st; z = y * st + z * ct; y = y2;
      const persp = 900 / (900 - z * rr);
      const o = i * 4;
      let px = x * rr * persp, py = y * rr * persp;
      const dist = Math.hypot(px, py);
      if (dist > MESH_MAX) { const c = MESH_MAX / dist; px *= c; py *= c; } // never leave the frame (hard cap)
      pr[o] = C + px;
      pr[o + 1] = C + py;
      pr[o + 2] = (z + 1) * 0.5; // 0 back .. 1 front
      const shimmer = mic * L * 0.45 * (0.5 + 0.5 * Math.sin(t * (1.6 + p.tw * 2.4) + p.ph));
      const rp = Math.hypot(x, y); // 0 center .. 1 limb
      if (mob) { // phone reference: evenly bright nodes, rim stays visible
        pr[o + 3] = 0.6 + 0.4 * p.tw + shimmer;
      } else {
        const limb = rp > 0.78 ? Math.max(0.25, 1 - (rp - 0.78) * 3.2) : 1;
        pr[o + 3] = (0.55 + 0.45 * p.tw + shimmer) * limb;
        pr[o + 2] *= limb;
      }
    }
    // edges in 4 depth buckets
    ctx.lineWidth = 0.8;
    const buckets = [[], [], [], []];
    for (const [a, b] of edges) {
      const d = (pr[a * 4 + 2] + pr[b * 4 + 2]) * 0.5;
      buckets[Math.min(3, Math.floor(d * 4))].push(a, b);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let bi = 0; bi < 4; bi++) {
      const list = buckets[bi];
      ctx.strokeStyle = mob ? this._col(hue + 2, 95, 68, 0.12 + bi * 0.07 + L * 0.08)
        : this._col(hue + 2, 90, 70, 0.09 + bi * 0.15 + L * 0.08);
      ctx.beginPath();
      for (let j = 0; j < list.length; j += 2) {
        const a = list[j] * 4, b = list[j + 1] * 4;
        ctx.moveTo(pr[a], pr[a + 1]); ctx.lineTo(pr[b], pr[b + 1]);
      }
      ctx.stroke();
    }
    // star glow around the brightest front nodes (one path, one fill)
    ctx.fillStyle = this._col(hue, 100, 58, (mob ? 0.22 : 0.3) + L * 0.1);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const o = i * 4;
      if (pr[o + 2] < 0.38 || pts[i].tw < 0.3) continue;
      const r = 1.8 + pr[o + 2] * 2.8 * pr[o + 3];
      ctx.moveTo(pr[o] + r, pr[o + 1]); ctx.arc(pr[o], pr[o + 1], r, 0, TAU);
    }
    ctx.fill();
    // nodes
    for (let i = 0; i < pts.length; i++) {
      const o = i * 4;
      const d = pr[o + 2];
      if (mob) {
        const s = 1.2 + d * 1.1;
        ctx.fillStyle = `rgba(255,236,200,${Math.min(1, (0.45 + d * 0.55) * pr[o + 3]).toFixed(3)})`;
        ctx.fillRect(pr[o] - s * 0.5, pr[o + 1] - s * 0.5, s, s);
        continue;
      }
      const a = Math.min(1, (0.35 + d * 0.9) * pr[o + 3]);
      const s = 1 + d * 1.9;
      ctx.fillStyle = d > 0.45 ? `rgba(255,240,212,${a.toFixed(3)})` : this._col(hue, 100, 70, a * 0.8);
      ctx.fillRect(pr[o] - s * 0.5, pr[o + 1] - s * 0.5, s, s);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawSwirl(ctx, Rs, hue) {
    const a0 = this.t * 2.4;
    ctx.globalCompositeOperation = 'lighter';
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 26; i++) {
        const f = i / 26;
        const ang = a0 + arm * (TAU / 3) + f * 3.2;
        const r = Rs * (0.12 + f * 0.75);
        const al = this.p.swirl * (1 - f) * 0.7;
        ctx.fillStyle = this._col(hue - 6, 100, 80, al);
        ctx.beginPath(); ctx.arc(C + Math.cos(ang) * r, C + Math.sin(ang) * r, 1.6 + (1 - f) * 1.6, 0, TAU); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawRings(ctx, hue, ringA, L, M, breath) {
    const hiCol = (a) => this._col(hue - 6, 100, 86, a);
    const midCol = (a) => this._col(hue, 100, 60, a);
    ctx.lineCap = 'butt';

    // outer dotted ring r=300
    ctx.fillStyle = this._col(hue + 2, 100, 62, Math.min(1, ringA));
    const dr = this.dashRot * 0.5;
    for (let i = 0; i < 220; i++) {
      const a = (i / 220) * TAU + dr;
      ctx.beginPath(); ctx.arc(C + Math.cos(a) * 300, C + Math.sin(a) * 300, 1.6, 0, TAU); ctx.fill();
    }

    // tick ring
    ctx.lineWidth = 1.1;
    for (const tk of this.ticks) {
      const a = tk.a - this.dashRot * 0.3;
      const r0 = 288 - tk.len;
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.strokeStyle = tk.bright ? hiCol(0.9 * Math.min(1, ringA)) : midCol(tk.alpha * Math.min(1, ringA));
      ctx.beginPath(); ctx.moveTo(C + ca * r0, C + sa * r0); ctx.lineTo(C + ca * 288, C + sa * 288); ctx.stroke();
    }

    // dashed ring r=264
    ctx.save();
    ctx.translate(C, C); ctx.rotate(this.dashRot);
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = midCol(0.7 * Math.min(1.2, ringA));
    ctx.beginPath(); ctx.arc(0, 0, 258, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // inner thin rings
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = midCol(0.75 * ringA);
    ctx.beginPath(); ctx.arc(C, C, 207, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = midCol(0.4 * ringA);
    ctx.beginPath(); ctx.arc(C, C, 214, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = midCol(0.55 * ringA);
    for (const a of THIN_ARCS) {
      ctx.lineWidth = a.hi ? 2.6 : 1.4;
      ctx.strokeStyle = a.hi ? hiCol(0.85 * Math.min(1, ringA)) : midCol(0.55 * ringA);
      ctx.beginPath(); ctx.arc(C, C, a.r, a.s * DEG - this.arcRot * 0.6, a.e * DEG - this.arcRot * 0.6); ctx.stroke();
    }

    // speaking ripples
    ctx.globalCompositeOperation = 'lighter';
    for (const rp of this.ripples) {
      const f = (this.t - rp.t0) / 1.4;
      const ease = 1 - (1 - f) * (1 - f); // decelerate toward the inner ring
      const { R, RIPPLE_MAX } = this.g;
      const r = Math.min(RIPPLE_MAX, R * 1.04 + ease * (RIPPLE_MAX - R * 1.04));
      ctx.lineWidth = 1.8 * (1 - f) + 0.4;
      ctx.strokeStyle = midCol(rp.a * 0.4 * (1 - f) * (1 - f));
      ctx.beginPath(); ctx.arc(C, C, r, 0, TAU); ctx.stroke();
    }

    // metal band under the bright arcs (dark ring with fine gold edges)
    ctx.lineWidth = 17; ctx.strokeStyle = 'rgba(30,22,12,0.9)';
    ctx.beginPath(); ctx.arc(C, C, 245, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = midCol(0.42 * Math.min(1, ringA));
    ctx.beginPath(); ctx.arc(C, C, 236.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(C, C, 253.5, 0, TAU); ctx.stroke();
    // continuous metal ring: champagne reflections sliding round a bronze band
    const cg = ctx.createConicGradient(this.arcRot * 0.5 - 0.6, C, C);
    for (let i = 0; i <= 16; i++) {
      const f = i / 16, k = 0.5 + 0.5 * Math.cos(f * TAU * 2) * Math.cos(f * TAU * 3 + 0.8);
      cg.addColorStop(f, `rgba(${Math.round(150 + 105 * k)},${Math.round(104 + 128 * k)},${Math.round(52 + 150 * k)},${(0.35 + 0.5 * k) * Math.min(1, ringA)})`);
    }
    ctx.lineWidth = 3.2; ctx.strokeStyle = cg;
    ctx.beginPath(); ctx.arc(C, C, 245, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = cg;
    ctx.beginPath(); ctx.arc(C, C, 226, 0, TAU); ctx.stroke();

    // outer thin ring r=314 with a bright arc that ends in a flare (upper right in the reference)
    ctx.lineWidth = 1; ctx.strokeStyle = midCol(0.3 * Math.min(1, ringA));
    ctx.beginPath(); ctx.arc(C, C, 314, 0, TAU); ctx.stroke();
    const fa = -61 * DEG + this.arcRot * 0.3;
    ctx.lineWidth = 1.8; ctx.strokeStyle = hiCol(0.75 * Math.min(1, ringA));
    ctx.beginPath(); ctx.arc(C, C, 314, fa - 0.75, fa); ctx.stroke();
    ctx.beginPath(); ctx.arc(C, C, 314, fa + Math.PI * 0.72, fa + Math.PI * 0.95); ctx.stroke();
    this._flare(ctx, C + Math.cos(fa) * 314, C + Math.sin(fa) * 314, 22, 0.9 * Math.min(1, ringA), hue);

    // thick bright arcs r=245 (wide glow, blurred halo, warm white core)
    const w = 6 + L * (0.8 + 1.4 * M); // max ~8.2
    const rot = this.arcRot;
    for (const pass of [0, 1, 2]) {
      if (pass === 1) { ctx.shadowColor = this._col(hue - 4, 100, 52, 0.9); ctx.shadowBlur = 22 * this.k; }
      for (const a of THICK_ARCS) {
        const s = a.s * DEG + rot, e = a.e * DEG + rot;
        ctx.beginPath(); ctx.arc(C, C, 245, s, e);
        if (pass === 0) { ctx.lineWidth = w * a.w * 4; ctx.strokeStyle = this._col(hue - 4, 100, 55, 0.08 * ringA); }
        else if (pass === 1) { ctx.lineWidth = w * a.w * 1.15; ctx.strokeStyle = this._col(hue - 2, 85, 64, 0.7 * Math.min(1, ringA)); }
        else { ctx.lineWidth = w * a.w * 0.5; ctx.strokeStyle = `rgba(255,245,226,${Math.min(1, 0.95 * ringA).toFixed(3)})`; }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // connecting sweep comet
    if (this.p.sweep > 0.02) {
      const s = this.sweepRot;
      for (let i = 0; i < 18; i++) {
        const f = i / 18;
        ctx.lineWidth = 3;
        ctx.strokeStyle = hiCol(this.p.sweep * (1 - f) * 0.8);
        ctx.beginPath(); ctx.arc(C, C, 264, s - (f + 1 / 18) * 1.4, s - f * 1.4); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // ---------------------------------------------------------------- phone variant
  // Traced from the 852x1846 phone reference: 1 unit = 1 reference px, centre (425.5, 869).
  _drawMobile(ctx, L, P, M, hue, breath, core, scale, ringA) {
    const bh = hue + 2;
    // ambient halo
    let g = ctx.createRadialGradient(C, C, 0, C, C, 370);
    g.addColorStop(0, this._col(bh, 100, 50, 0));
    g.addColorStop(0.6, this._col(bh, 100, 46, 0.10 * core));
    g.addColorStop(1, this._col(bh, 100, 40, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);

    this._drawOrbit(ctx, false, L, hue);
    this._occlude(ctx, 296);

    const Rs = this.g.R * scale;
    this._drawBody(ctx, Rs, hue, core);
    this._drawMesh(ctx, Rs, L, P, M, bh);
    if (this.p.swirl > 0.02) this._drawSwirl(ctx, Rs, hue);
    this._drawCore(ctx, Rs, hue, core, L, M, 62);

    this._drawMobileRings(ctx, hue, ringA, L, M);
    this._drawOrbit(ctx, true, L, hue);
  }

  _drawMobileRings(ctx, hue, ringA, L, M) {
    const A = Math.min(1, ringA);
    const hiCol = (a) => this._col(hue - 6, 100, 84, a);
    const midCol = (a) => this._col(hue, 100, 58, a);
    const dimCol = (a) => this._col(hue + 6, 90, 50, a);
    const ring = (r, w, col, rx = r, ry = r, dy = 0) => {
      ctx.lineWidth = w; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.ellipse(C, C + dy, rx, ry, 0, 0, TAU); ctx.stroke();
    };
    ctx.lineCap = 'butt';

    // blue haze in the ring band
    let hz = ctx.createRadialGradient(C, C, 232, C, C, 300);
    hz.addColorStop(0, this._col(hue + 8, 100, 45, 0));
    hz.addColorStop(0.5, this._col(hue + 8, 100, 45, 0.07 * A));
    hz.addColorStop(1, this._col(hue + 8, 100, 45, 0));
    ctx.fillStyle = hz; ctx.beginPath(); ctx.arc(C, C, 300, 0, TAU); ctx.arc(C, C, 232, 0, TAU, true); ctx.fill();

    // faint outer rings
    ring(348, 1, dimCol(0.10 * A));
    ring(316, 1, dimCol(0.14 * A));
    ring(300, 1, dimCol(0.2 * A));
    ring(290, 1, dimCol(0.16 * A));

    // fine faint ticks outside the bright ring
    const rot = this.dashRot * 0.3;
    ctx.lineWidth = 1;
    for (const tk of this.mticks.fine) {
      const a = tk.a - rot, ca = Math.cos(a), sa = Math.sin(a);
      ctx.strokeStyle = midCol(tk.alpha * A);
      ctx.beginPath(); ctx.moveTo(C + ca * 278, C + sa * 278); ctx.lineTo(C + ca * (278 + tk.len), C + sa * (278 + tk.len)); ctx.stroke();
    }
    // bright thin ring
    ring(277, 1.6, this._col(hue - 2, 100, 64, A));
    // dash band (short radial dashes)
    ctx.lineWidth = 2;
    for (const tk of this.mticks.dash) {
      const a = tk.a - rot * 1.6, ca = Math.cos(a), sa = Math.sin(a);
      const r0 = 258.5;
      ctx.strokeStyle = this._col(hue - 2, 100, 62, tk.alpha * 0.85 * A);
      ctx.beginPath(); ctx.moveTo(C + ca * r0, C + sa * r0); ctx.lineTo(C + ca * (r0 + tk.len), C + sa * (r0 + tk.len)); ctx.stroke();
    }
    ring(246, 1, midCol(0.42 * A), 248, 244.5);

    // inner thin rings (just outside the mesh)
    ring(190, 1.2, dimCol(0.4 * A));
    ring(201, 1.5, midCol(0.95 * A), 201.3, 205.5, 2.5);
    ring(208, 1, midCol(0.35 * A));

    // speaking ripples (capped inside the inner ring)
    ctx.globalCompositeOperation = 'lighter';
    const { R, RIPPLE_MAX } = this.g;
    for (const rp of this.ripples) {
      const f = (this.t - rp.t0) / 1.4;
      const ease = 1 - (1 - f) * (1 - f);
      const r = Math.min(RIPPLE_MAX, R * 1.04 + ease * (RIPPLE_MAX - R * 1.04));
      ctx.lineWidth = 1.6 * (1 - f) + 0.4;
      ctx.strokeStyle = midCol(rp.a * 0.4 * (1 - f) * (1 - f));
      ctx.beginPath(); ctx.arc(C, C, r, 0, TAU); ctx.stroke();
    }

    // thin highlight arcs beside the big ones
    const arot = this.arcRot;
    ctx.lineWidth = 1.4;
    for (const a of MOBILE_THIN_ARCS) {
      ctx.strokeStyle = hiCol(0.6 * A);
      ctx.beginPath(); ctx.ellipse(C, C, a.r, a.r + 6, 0, a.s * DEG + arot, a.e * DEG + arot); ctx.stroke();
    }

    // bright arcs: soft wide glow, blurred halo, white-cyan core, round ends
    const w = 5.2 + L * (0.7 + 1.2 * M);
    ctx.lineCap = 'round';
    for (const pass of [0, 1, 2]) {
      if (pass === 1) { ctx.shadowColor = midCol(1); ctx.shadowBlur = 22 * this.k; }
      for (const a of MOBILE_ARCS) {
        ctx.beginPath(); ctx.ellipse(C, C, 223.5, 231, 0, a.s * DEG + arot, a.e * DEG + arot);
        if (pass === 0) { ctx.lineWidth = w * 4.4; ctx.strokeStyle = midCol(0.1 * ringA); }
        else if (pass === 1) { ctx.lineWidth = w * 1.2; ctx.strokeStyle = this._col(hue - 2, 85, 62, 0.75 * A); }
        else { ctx.lineWidth = w * 0.6; ctx.strokeStyle = `rgba(255,245,226,${Math.min(1, ringA).toFixed(3)})`; }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
    ctx.lineCap = 'butt';

    if (this.p.sweep > 0.02) {
      const s = this.sweepRot;
      for (let i = 0; i < 18; i++) {
        const f = i / 18;
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = hiCol(this.p.sweep * (1 - f) * 0.8);
        ctx.beginPath(); ctx.arc(C, C, 262, s - (f + 1 / 18) * 1.4, s - f * 1.4); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
