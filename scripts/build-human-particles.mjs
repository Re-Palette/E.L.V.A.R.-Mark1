#!/usr/bin/env node
// Builds the ヒューマンプロトコル assets from the reference artwork (scripts/assets/human-protocol-ref.webp, 1672x941):
//   web/src/human/human-data.bin  particle targets (position, colour, brightness, size, heat), wire lines, orange hot nodes, stars
//   web/src/human/human-bg.webp   the deep-space background with the figure removed (nebula band, vignette), downscaled
// Offline only (not part of `npm run build`). Needs Playwright + Chromium to decode / encode WebP:
//   NODE_PATH=$(npm root -g) node scripts/build-human-particles.mjs [ref.webp] [--debug <dir>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeHumanData, parseHumanData, FLAG_DUST, FLAG_OUTLINE, FLAG_LINE, Z_MAX, depthRatio } from '../web/src/human-protocol.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dbgIdx = args.indexOf('--debug');
const DEBUG = dbgIdx >= 0 ? args.splice(dbgIdx, 2)[1] : null;
const SRC = args[0] || join(ROOT, 'scripts/assets/human-protocol-ref.webp');
const OUT_BIN = join(ROOT, 'web/src/human/human-data.bin');
const OUT_BG = join(ROOT, 'web/src/human/human-bg.webp');

const N_RIM = 3800, N_PARTICLES = 26000, N_LINE_VERTS = 9000, N_MESH = 0, N_NODES = 26, N_STARS = 1400;
const BG_W = 1024, BG_H = 576;
const LINE_SPACING = 3.2;   // px between the Catmull-Rom resampled vertices of a wire curve

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch {}
  return req(req.resolve('playwright', { paths: (process.env.NODE_PATH || '').split(':').filter(Boolean) }));
}

// ---------------------------------------------------------------- deterministic random
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(20261105);

// ---------------------------------------------------------------- silhouette (traced by hand on the reference, reference px)
// Generous outline of head (with ears), neck, shoulders and upper arms / chest; the bust is cut by the image bottom.
const SILHOUETTE = [
  [842, 40], [895, 47], [942, 74], [978, 115], [997, 165], [1001, 222], [1012, 238], [1020, 268], [1016, 305], [1000, 330], [984, 338],
  [968, 378], [944, 410], [936, 440], [936, 490], [944, 520], [985, 556], [1060, 578], [1150, 598], [1215, 625], [1252, 665], [1268, 720],
  [1276, 800], [1290, 880], [1300, 941], [392, 941], [398, 860], [404, 780], [414, 715], [440, 655], [500, 615], [600, 588], [690, 566],
  [740, 535], [752, 490], [752, 440], [742, 410], [716, 378], [702, 340], [684, 332], [668, 305], [666, 266], [674, 240], [688, 232],
  [686, 180], [702, 125], [738, 78], [788, 50],
];

/** Centripetal-ish Catmull-Rom through the control points, resampled every `step` px (smooth curves instead of a jagged polyline). */
function catmullRom(c, step) {
  if (c.length < 3) return c.slice();
  const P = [[2 * c[0][0] - c[1][0], 2 * c[0][1] - c[1][1]], ...c, [2 * c.at(-1)[0] - c.at(-2)[0], 2 * c.at(-1)[1] - c.at(-2)[1]]];
  const out = [c[0]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Two-pass chamfer distance (px) to the nearest pixel where mask==1 (0 inside). */
function distanceTo(mask, W, H) {
  const INF = 1e9, d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + a);
    if (y > 0) { v = Math.min(v, d[i - W] + a); if (x > 0) v = Math.min(v, d[i - W - 1] + b); if (x < W - 1) v = Math.min(v, d[i - W + 1] + b); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + a);
    if (y < H - 1) { v = Math.min(v, d[i + W] + a); if (x < W - 1) v = Math.min(v, d[i + W + 1] + b); if (x > 0) v = Math.min(v, d[i + W - 1] + b); }
    d[i] = v;
  }
  return d;
}

/** Separable box blur of a Float32 plane (radius r, 2 passes ≈ gaussian-ish). */
function blur(src, W, H, r, passes = 2) {
  let a = Float32Array.from(src), t = new Float32Array(W * H);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      let acc = 0; const row = y * W;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) { t[row + x] = acc / (2 * r + 1); acc += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += t[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) { a[y * W + x] = acc / (2 * r + 1); acc += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; }
    }
  }
  return a;
}
/** Separable min (erode) or max (dilate) filter with radius r. */
function morph(src, W, H, r, isMax) {
  const f = isMax ? Math.max : Math.min, t = new Float32Array(W * H), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = src[y * W + x]; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) v = f(v, src[y * W + xx]); } t[y * W + x] = v; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = t[y * W + x]; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) v = f(v, t[yy * W + x]); } o[y * W + x] = v; }
  return o;
}

// ---------------------------------------------------------------- main
const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const page = await browser.newPage();
const srcB64 = readFileSync(SRC).toString('base64');
const decoded = await page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/webp;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
  return { w: c.width, h: c.height, b64: btoa(s) };
}, srcB64);
const W = decoded.w, H = decoded.h, rgba = Buffer.from(decoded.b64, 'base64');
console.log(`reference ${W}x${H}`);
const N = W * H;
const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), V = new Float32Array(N);
for (let i = 0; i < N; i++) { R[i] = rgba[i * 4]; G[i] = rgba[i * 4 + 1]; B[i] = rgba[i * 4 + 2]; V[i] = Math.max(R[i], G[i], B[i]); }

// figure mask + distance fields
const inside = new Uint8Array(N);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) inside[y * W + x] = pointInPoly(x + 0.5, y + 0.5, SILHOUETTE) ? 1 : 0;
const distOut = distanceTo(inside, W, H);                                // 0 inside, px outside
const outsideMask = new Uint8Array(N); for (let i = 0; i < N; i++) outsideMask[i] = inside[i] ? 0 : 1;
const distIn = distanceTo(outsideMask, W, H);                             // 0 outside, px inside (depth into the figure)
const MARGIN = 26;                                                        // the halo of speckles around the outline belongs to the figure

// brightness + local contrast (ridges = the wire lines and the outline)
const Vb = blur(V, W, H, 7);
const Vs = blur(V, W, H, 1, 1);
const ridge = new Float32Array(N); for (let i = 0; i < N; i++) ridge[i] = Math.max(0, Vs[i] - Vb[i]);
const bgLevel = blur(morph(V, W, H, 6, false), W, H, 20);                 // the nebula / haze level under everything

// colour of the 3x3 neighbourhood (hue kept, brightness separate), flags and size of a particle at (x, y)
function makeParticle(x, y, extra = 0) {
  const ix = Math.min(W - 1, Math.max(0, Math.floor(x))), iy = Math.min(H - 1, Math.max(0, Math.floor(y))), i = iy * W + ix;
  let r = 0, g = 0, b = 0, c = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = Math.min(H - 1, Math.max(0, iy + dy)) * W + Math.min(W - 1, Math.max(0, ix + dx)); r += R[j]; g += G[j]; b += B[j]; c++; }
  r /= c; g /= c; b /= c;
  const m = Math.max(r, g, b, 1);
  const bright = Math.min(255, Math.max(Vs[i], m));
  const d = distOut[i];
  let flags = 0;
  if (d > 0) flags |= FLAG_DUST;
  if (d === 0 && distIn[i] < 9 && ridge[i] > 12) flags |= FLAG_OUTLINE;
  const size = Math.min(255, 40 + bright * 0.55 + Math.min(60, ridge[i]) * 0.9 + extra + (rand() < 0.04 ? 60 : 0));
  return { x, y, r: (r / m) * 255, g: (g / m) * 255, b: (b / m) * 255, bright, size, heat: 0, flags };
}

// ---- wire lines, part 1: trace the glowing curves of the artwork (ridges of brightness) into long polylines.
// Orientation from the structure tensor; each step is re-centred on the ridge; traced paths block their neighbourhood.
const Vg = blur(V, W, H, 1, 2);
const GX = new Float32Array(N), GY = new Float32Array(N);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; GX[i] = (Vg[i + 1] - Vg[i - 1]) / 2; GY[i] = (Vg[i + W] - Vg[i - W]) / 2; }
const Jxx = blur(Float32Array.from(GX, (g) => g * g), W, H, 4), Jyy = blur(Float32Array.from(GY, (g) => g * g), W, H, 4), Jxy = blur(Float32Array.from(GX, (g, i) => g * GY[i]), W, H, 4);
const ridgeS = blur(ridge, W, H, 1, 1);
{ const a3 = blur(V, W, H, 3), a14 = blur(V, W, H, 14); for (let i = 0; i < N; i++) ridgeS[i] = Math.max(ridgeS[i], (a3[i] - a14[i]) * 0.9); }   // + the wide bright bands (outline)
const at = (A, x, y) => A[Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))];
function dirAt(x, y) { const th = 0.5 * Math.atan2(2 * at(Jxy, x, y), at(Jxx, x, y) - at(Jyy, x, y)) + Math.PI / 2; return [Math.cos(th), Math.sin(th)]; }
const occ = new Uint8Array(N);
const STEP = 2.5, RG_START = 24, RG_KEEP = 5;
const ok = (x, y) => x >= 2 && y >= 2 && x < W - 2 && y < H - 2 && at(distOut, x, y) <= 6;
function walk(x0, y0, d0) {
  const pts = []; let x = x0, y = y0, [dx, dy] = d0;
  for (let n = 0; n < 220; n++) {
    let nx = x + dx * STEP, ny = y + dy * STEP;
    // re-centre across the line on the brightest ridge pixel
    let best = -1, bo = 0; for (let o = -2; o <= 2; o += 0.5) { const v = at(ridgeS, nx - dy * o, ny + dx * o); if (v > best) { best = v; bo = o; } }
    nx -= dy * bo * 0.7; ny += dx * bo * 0.7;
    if (!ok(nx, ny) || at(ridgeS, nx, ny) < RG_KEEP || at(Vs, nx, ny) < 75 || at(occ, nx, ny)) break;
    let [tx, ty] = dirAt(nx, ny); if (tx * dx + ty * dy < 0) { tx = -tx; ty = -ty; }
    if (tx * dx + ty * dy < 0.5) break;                                    // a sharp turn: another line crosses here
    const ndx = dx * 0.55 + tx * 0.45, ndy = dy * 0.55 + ty * 0.45, l = Math.hypot(ndx, ndy); dx = ndx / l; dy = ndy / l;
    x = nx; y = ny; pts.push([x, y]);
  }
  return pts;
}
function mark(pts, r) { for (const [x, y] of pts) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const xx = Math.round(x + dx), yy = Math.round(y + dy); if (xx >= 0 && yy >= 0 && xx < W && yy < H) occ[yy * W + xx] = 1; } }
const seedsPx = [];
for (let i = 0; i < N; i++) if (distOut[i] <= 4 && ridgeS[i] >= RG_START && Vs[i] >= 85) seedsPx.push(i);
seedsPx.sort((a, b) => ridgeS[b] * Vs[b] - ridgeS[a] * Vs[a]);
const polylines = [];
let lineVerts = 0;
for (const i of seedsPx) {
  if (lineVerts >= N_LINE_VERTS) break;
  if (occ[i]) continue;
  const x0 = i % W, y0 = Math.floor(i / W), d = dirAt(x0, y0);
  const fwd = walk(x0, y0, d), back = walk(x0, y0, [-d[0], -d[1]]);
  const pts = [...back.reverse(), [x0, y0], ...fwd];
  if (pts.length * STEP < 34) { occ[i] = 1; continue; }   // short scraps read as confetti, not as wires
  mark(pts, 1.5);
  // smooth, then resample every ~7 px (the vertices are particles: they move, and the segments follow them)
  const sm = pts.map((p, k) => { let sx = 0, sy = 0, c = 0; for (let j = Math.max(0, k - 4); j <= Math.min(pts.length - 1, k + 4); j++) { sx += pts[j][0]; sy += pts[j][1]; c++; } return [sx / c, sy / c]; });
  const ctrl = [sm[0]]; let acc = 0;
  for (let k = 1; k < sm.length; k++) { acc += Math.hypot(sm[k][0] - sm[k - 1][0], sm[k][1] - sm[k - 1][1]); if (acc >= 9 || k === sm.length - 1) { ctrl.push(sm[k]); acc = 0; } }
  const out = catmullRom(ctrl, LINE_SPACING);
  polylines.push(out); lineVerts += out.length;
}
const particles = [], lines = [];
for (const pl of polylines) {
  const base = particles.length;
  pl.forEach(([x, y]) => { const p = makeParticle(x, y, -10); p.flags |= FLAG_LINE; particles.push(p); });
  for (let k = 1; k < pl.length; k++) {
    const [x, y] = [(pl[k][0] + pl[k - 1][0]) / 2, (pl[k][1] + pl[k - 1][1]) / 2];
    lines.push({ a: base + k - 1, b: base + k, strength: Math.min(255, 60 + at(ridgeS, x, y) * 2.4 + Math.max(0, at(Vs, x, y) - 90) * 0.6) });
  }
}
const nTraced = particles.length;
console.log(`traced ${polylines.length} curves, ${nTraced} vertices, ${lines.length} segments (longest ${Math.max(...polylines.map((p) => p.length)) * 7} px)`);

// ---- particle sampling: weight bright pixels and ridges, inside the figure (+ margin) only
const weight = new Float32Array(N);
let wsum = 0;
for (let i = 0; i < N; i++) {
  const d = distOut[i];
  if (d > MARGIN) continue;
  const lift = Math.max(0, Vs[i] - (d > 0 ? bgLevel[i] * 0.85 : Math.min(bgLevel[i], 55)));   // above the local haze (inside the figure: above the dark body)
  let w = Math.pow(Math.min(lift, 200) / 200, 1.35) * (1 + 2.2 * Math.min(1, ridge[i] / 50));
  if (d === 0) w += 0.035;                                               // the translucent body: a fine faint dust everywhere inside
  if (d > 0) w *= 0.55 * (1 - d / MARGIN);                                // dust around the outline: thinner
  weight[i] = w; wsum += w;
}
const cdf = new Float64Array(N); { let acc = 0; for (let i = 0; i < N; i++) { acc += weight[i]; cdf[i] = acc; } }
function pick() { const r = rand() * wsum; let lo = 0, hi = N - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; } return lo; }
const taken = new Uint8Array(N);
const scattered = [];
let guard = 0;
while (nTraced + scattered.length < N_PARTICLES && guard++ < N_PARTICLES * 20) {
  const i = pick();
  if (taken[i] >= 1 && rand() < 0.85) continue;                           // keep the cloud from piling up on saturated pixels
  taken[i]++;
  scattered.push(makeParticle((i % W) + rand() * 0.9 + 0.05, Math.floor(i / W) + rand() * 0.9 + 0.05));
}
// shuffle the cloud (a prefix is a fair subsample for weaker devices); the traced vertices come first so the curves survive any budget
for (let i = scattered.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [scattered[i], scattered[j]] = [scattered[j], scattered[i]]; }
particles.push(...scattered);
console.log(`particles ${particles.length}`);

// ---- hot orange nodes: local maxima of "orange-ness" (red over blue, bright) inside the figure
const orange = new Float32Array(N);
for (let i = 0; i < N; i++) if (distOut[i] === 0) orange[i] = Math.max(0, R[i] - B[i] * 0.75) * (Math.min(255, R[i] + G[i]) / 510) * (G[i] > 60 ? 1 : 0.3);
const orangeB = blur(orange, W, H, 5);
const nodes = [];
{
  const cand = [];
  for (let y = 6; y < H - 6; y += 2) for (let x = 6; x < W - 6; x += 2) {
    const v = orangeB[y * W + x]; if (v < 6) continue;
    let isMax = true;
    for (let dy = -6; dy <= 6 && isMax; dy += 2) for (let dx = -6; dx <= 6; dx += 2) if (orangeB[(y + dy) * W + x + dx] > v) { isMax = false; break; }
    if (isMax) cand.push({ x, y, v });
  }
  cand.sort((a, b) => b.v - a.v);
  for (const c of cand) {
    if (nodes.length >= N_NODES) break;
    if (nodes.some((n) => Math.hypot(n.x - c.x, n.y - c.y) < 38)) continue;
    nodes.push(c);
  }
  const vmax = nodes[0]?.v || 1;
  for (const n of nodes) {
    // radius: how far the orange glow reaches (half maximum)
    let rad = 4; while (rad < 120 && orangeB[Math.min(H - 1, Math.round(n.y)) * W + Math.min(W - 1, Math.round(n.x + rad))] > n.v * 0.4) rad += 2;
    n.strength = Math.max(18, (n.v / vmax) * 255); n.radius = Math.min(255, rad / 2 + 4);
  }
}
console.log(`nodes ${nodes.length}: ` + nodes.slice(0, 6).map((n) => `(${(n.x / W).toFixed(3)},${(n.y / H).toFixed(3)} s${Math.round(n.strength)})`).join(' '));
// heat of each particle: closeness to the hot nodes (they pulse with the voice)
for (const p of particles) {
  let h = 0;
  for (const n of nodes) { const rr = n.radius * 2 * 2.2; const d2 = (p.x - n.x) ** 2 + (p.y - n.y) ** 2; h += (n.strength / 255) * Math.exp(-d2 / (rr * rr)); }
  const i = Math.floor(p.y) * W + Math.floor(p.x);
  const warm = Math.max(0, R[i] - B[i]) / 255;
  p.heat = Math.min(255, (h * 0.8 + warm * 0.9) * 255);
}

// ---- wire lines, part 2: a finer mesh between near particles of the cloud where the artwork is bright all along the segment
const CELL = 20, gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), grid = Array.from({ length: gw * gh }, () => []);
particles.forEach((p, k) => grid[Math.floor(p.y / CELL) * gw + Math.floor(p.x / CELL)].push(k));
const cand = [];
for (let k = nTraced; N_MESH > 0 && k < particles.length; k++) {   // (off by default: the traced curves read better)
  const p = particles[k];
  if (p.flags & FLAG_DUST) continue;
  const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
  for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) {
    if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
    for (const j of grid[yy * gw + xx]) {
      if (j <= k || j < nTraced) continue;
      const q = particles[j]; if (q.flags & FLAG_DUST) continue;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 6 || len > 19) continue;
      let mn = 1e9, sum = 0; const S = 8;
      for (let s = 1; s < S; s++) { const x = p.x + (q.x - p.x) * (s / S), y = p.y + (q.y - p.y) * (s / S); const v = Vs[Math.floor(y) * W + Math.floor(x)] - 50; mn = Math.min(mn, v); sum += v; }
      if (mn < 45) continue;
      cand.push({ a: k, b: j, score: mn * 0.7 + (sum / (S - 1)) * 0.3, len });
    }
  }
}
// spread the network over the whole figure: every particle offers its best few links, then a weighted random pick (no clumping on the brightest spots)
const best = new Map();
for (const c of cand) for (const k of [c.a, c.b]) { const l = best.get(k) || []; l.push(c); best.set(k, l); }
const offered = new Set();
for (const l of best.values()) { l.sort((x, y) => y.score - x.score); l.slice(0, 2).forEach((c) => offered.add(c)); }
const pool = [...offered].map((c) => ({ ...c, key: Math.pow(rand(), 1 / Math.max(1, c.score * Math.sqrt(c.len))) }));   // weighted reservoir key
pool.sort((x, y) => y.key - x.key);
const degree = new Uint8Array(particles.length), nMesh0 = lines.length;
for (const c of pool) {
  if (lines.length - nMesh0 >= N_MESH) break;
  if (degree[c.a] >= 3 || degree[c.b] >= 3) continue;
  degree[c.a]++; degree[c.b]++;
  lines.push({ a: c.a, b: c.b, strength: Math.min(255, c.score * 0.7) });
}
console.log(`lines ${lines.length} (mesh ${lines.length - nMesh0} of ${cand.length} candidates)`);

// ---- stars: small bright points outside the figure
const stars = [];
{
  const Vm = blur(V, W, H, 3, 1);
  const cand = [];
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x; if (distOut[i] < MARGIN + 4) continue;
    const v = V[i]; if (v < 85 || v - Vm[i] < 28) continue;
    let isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && V[i + dy * W + dx] > v) { isMax = false; break; }
    if (!isMax) continue;
    let area = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (V[i + dy * W + dx] > (v + bgLevel[i]) / 2) area++;
    cand.push({ x: x + 0.5, y: y + 0.5, v, area, i });
  }
  cand.sort((a, b) => b.v * Math.sqrt(b.area) - a.v * Math.sqrt(a.area));
  for (const c of cand.slice(0, N_STARS)) {
    const k = Math.min(1, (c.v - bgLevel[c.i] * 0.6) / 200);
    stars.push({ x: c.x, y: c.y, r: R[c.i] * k + 0, g: G[c.i] * k, b: B[c.i] * k, size: Math.min(255, (0.7 + Math.sqrt(c.area) * 0.55) * 32) });
  }
}
console.log(`stars ${stars.length}`);

// ---- background: stars removed (grey opening), the figure filled in from its surroundings (normalized convolution), downscaled
const bgPlanes = [R, G, B].map((P) => morph(morph(P, W, H, 2, false), W, H, 2, true));
{
  const KEEP = 34, KEEP_HEAD = 44;   // the haze right outside the outline stays (only the figure itself is painted over)
  // around the head the halo is painted out too (the head turns to follow the pointer: a fixed halo would stay behind as a ghost)
  const keepAt = (i) => (Math.floor(i / W) < H * 0.56 ? KEEP_HEAD : KEEP);
  const known = new Float32Array(N); for (let i = 0; i < N; i++) known[i] = distOut[i] > keepAt(i) ? 1 : 0;
  const kb = blur(known, W, H, 110, 3);
  const NAVY = [4, 14, 42];   // the reference's own body tint (its dark inside is this navy, not black)
  bgPlanes.forEach((P, ch) => {
    const filled = blur(Float32Array.from(P, (x, i) => x * known[i]), W, H, 110, 3);
    for (let i = 0; i < N; i++) {
      const k = kb[i], f = k > 1e-3 ? filled[i] / k : 0;
      const est = f * Math.min(1, k * 2.2) + NAVY[ch] * (1 - Math.min(1, k * 2.2));   // far from any background: deep navy
      const t = Math.min(1, Math.max(0, (keepAt(i) - distOut[i]) / 10));            // 0 outside .. 1 on / inside the outline
      P[i] = P[i] * (1 - t) + est * t;
    }
  });
}
// downscale (box) to BG_W x BG_H
const bgSmall = new Uint8ClampedArray(BG_W * BG_H * 4);
for (let y = 0; y < BG_H; y++) for (let x = 0; x < BG_W; x++) {
  const x0 = Math.floor((x * W) / BG_W), x1 = Math.floor(((x + 1) * W) / BG_W), y0 = Math.floor((y * H) / BG_H), y1 = Math.floor(((y + 1) * H) / BG_H);
  const acc = [0, 0, 0]; let c = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = yy * W + xx; acc[0] += bgPlanes[0][i]; acc[1] += bgPlanes[1][i]; acc[2] += bgPlanes[2][i]; c++; }
  const o = (y * BG_W + x) * 4; bgSmall[o] = acc[0] / c; bgSmall[o + 1] = acc[1] / c; bgSmall[o + 2] = acc[2] / c; bgSmall[o + 3] = 255;
}
const bgWebp = await page.evaluate(async ({ b64, w, h }) => {
  const bin = atob(b64), d = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(d, w, h), 0, 0);
  return c.toDataURL('image/webp', 0.82).split(',')[1];
}, { b64: Buffer.from(bgSmall.buffer).toString('base64'), w: BG_W, h: BG_H });

// ---- depth (the figure becomes a volume): every row of the silhouette is an elliptical cross-section —
// the head nearly as deep as it is wide, the neck round, the torso about half as deep as wide (rounded shoulders come from the ellipse).
// Particles keep their x, y; z puts them on the front surface, the back surface or inside. Each wire curve lies on one surface.
const rowSpans = [];
for (let y = 0; y < H; y++) { const spans = []; let x0 = -1; for (let x = 0; x <= W; x++) { const v = x < W && inside[y * W + x]; if (v && x0 < 0) x0 = x; if (!v && x0 >= 0) { spans.push([x0, x - 1]); x0 = -1; } } rowSpans.push(spans); }
/** Half depth of the body at (x, y) (0 outside / at the outline), and the row's span (centre c, half width a). */
function halfDepth(x, y) {
  const row = rowSpans[Math.min(H - 1, Math.max(0, Math.round(y)))] || [];
  let best = null; for (const [l, r] of row) { const d = x < l ? l - x : x > r ? x - r : 0; if (!best || d < best.d) best = { l, r, d }; }
  if (!best) return { h: 0, c: x, a: 1 };
  const c = (best.l + best.r) / 2, a = Math.max(1, (best.r - best.l) / 2), u = Math.min(1, Math.abs(x - c) / a);
  return { h: Math.min(Z_MAX, depthRatio(y / H) * a * Math.sqrt(Math.max(0, 1 - u * u))), c, a };
}
{
  let k = 0;
  for (const pl of polylines) { const side = rand() < 0.68 ? 1 : -1; for (let j = 0; j < pl.length; j++, k++) { const p = particles[k]; p.z = side * halfDepth(p.x, p.y).h * (0.9 + 0.08 * rand()); } }
  for (; k < particles.length; k++) {
    const p = particles[k], { h } = halfDepth(p.x, p.y), r = rand();
    if (p.flags & FLAG_DUST) p.z = (rand() - 0.5) * 70;
    else if (p.flags & FLAG_OUTLINE) p.z = h * (rand() * 2 - 1) * 0.35;
    else if (p.heat > 120) p.z = h * (0.15 + 0.55 * rand());                       // the orange cores glow inside, towards the front
    else if (r < 0.46) p.z = h * (0.86 + 0.14 * rand());                           // front surface
    else if (r < 0.8) p.z = -h * (0.86 + 0.14 * rand());                           // back surface (seen through the translucent body)
    else p.z = h * (rand() * 2 - 1) * 0.75;                                         // inside, sparse
  }
  // the sides: extra surface particles around the rim of each cross-section, so a turned head or body still has a skin there
  const rimSrc = particles.filter((p) => !(p.flags & (FLAG_DUST | FLAG_LINE)) && distIn[Math.floor(p.y) * W + Math.floor(p.x)] < 30 && distIn[Math.floor(p.y) * W + Math.floor(p.x)] > 0);
  for (let i = 0; i < N_RIM && rimSrc.length; i++) {
    const src = rimSrc[Math.floor(rand() * rimSrc.length)], { c, a } = halfDepth(src.x, src.y), side = src.x < c ? -1 : 1;
    const th = (0.2 + 1.15 * rand()) * (rand() < 0.5 ? 1 : -1);                     // angle around the cross-section (front side to nearly the back)
    const x = c + side * a * Math.cos(th), z = depthRatio(src.y / H) * a * Math.sin(th);
    particles.push({ ...src, x, z: Math.max(-Z_MAX, Math.min(Z_MAX, z)), bright: src.bright * 0.55, size: src.size * 0.85, flags: src.flags & ~FLAG_OUTLINE });
  }
  for (let i = particles.length - 1; i > nTraced; i--) { const j = nTraced + Math.floor(rand() * (i - nTraced + 1)); [particles[i], particles[j]] = [particles[j], particles[i]]; }   // a prefix stays a fair subsample (wire vertices first)
  const zs = particles.map((p) => p.z); console.log(`depth: z ${Math.min(...zs).toFixed(0)}..${Math.max(...zs).toFixed(0)} px, ${N_RIM} rim particles`);
}

// ---- write + verify
const bin = encodeHumanData({ W, H, particles: particles.map((p) => ({ ...p, x: p.x / W, y: p.y / H })), lines, nodes: nodes.map((n) => ({ ...n, x: n.x / W, y: n.y / H })), stars: stars.map((s) => ({ ...s, x: s.x / W, y: s.y / H })) });
const check = parseHumanData(bin);
mkdirSync(dirname(OUT_BIN), { recursive: true });
writeFileSync(OUT_BIN, bin);
writeFileSync(OUT_BG, Buffer.from(bgWebp, 'base64'));
console.log(`wrote ${OUT_BIN} (${(bin.byteLength / 1024).toFixed(1)} KB, ${check.count} particles / ${check.lineCount} lines / ${check.nodeCount} nodes / ${check.starCount} stars)`);
console.log(`wrote ${OUT_BG} (${(Buffer.from(bgWebp, 'base64').length / 1024).toFixed(1)} KB)`);

// ---- debug previews: the mask over the artwork, and the particles rendered flat
if (DEBUG) {
  mkdirSync(DEBUG, { recursive: true });
  const png = await page.evaluate(async ({ src, poly, pts, ln, nd, st, W, H }) => {
    const img = new Image(); img.src = 'data:image/webp;base64,' + src; await img.decode();
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const a = mk(), g = a.getContext('2d'); g.drawImage(img, 0, 0); g.strokeStyle = '#f0f'; g.lineWidth = 2; g.beginPath(); poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
    for (const n of nd) { g.strokeStyle = '#ff0'; g.beginPath(); g.arc(n.x, n.y, n.radius * 2, 0, 7); g.stroke(); }
    const b = mk(), h = b.getContext('2d'); h.fillStyle = '#020615'; h.fillRect(0, 0, W, H); h.globalCompositeOperation = 'lighter';
    for (const s of st) { h.fillStyle = `rgb(${s.r},${s.g},${s.b})`; h.fillRect(s.x - 0.7, s.y - 0.7, 1.4, 1.4); }
    h.lineWidth = 0.8; for (const l of ln) { const p = pts[l.a], q = pts[l.b]; h.strokeStyle = `rgba(${p.r},${p.g},${p.b},${(l.strength / 255) * 0.35})`; h.beginPath(); h.moveTo(p.x, p.y); h.lineTo(q.x, q.y); h.stroke(); }
    for (const p of pts) { const r = (p.size / 255) * 2.2; h.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${p.bright / 255})`; h.fillRect(p.x - r / 2, p.y - r / 2, r, r); }
    return [a.toDataURL('image/png').split(',')[1], b.toDataURL('image/png').split(',')[1]];
  }, { src: srcB64, poly: SILHOUETTE, pts: particles, ln: lines, nd: nodes, st: stars, W, H });
  writeFileSync(join(DEBUG, 'mask.png'), Buffer.from(png[0], 'base64'));
  writeFileSync(join(DEBUG, 'particles.png'), Buffer.from(png[1], 'base64'));
  writeFileSync(join(DEBUG, 'bg.webp'), Buffer.from(bgWebp, 'base64'));
  console.log(`debug previews in ${DEBUG}`);
}
await browser.close();
