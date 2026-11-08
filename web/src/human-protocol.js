// ヒューマンプロトコル (Human Protocol): the pure parts — command detection, timing / easing math, viewport fit and the particle data format.
// No DOM here (the renderer lives in ./human/), so main.js can import this statically and node:test can test it.

// ---------------------------------------------------------------- command detection
/** Speech / typed text → a comparable form: NFKC (full/half width), hiragana → katakana, lower case, no spaces / dots / long vowels / punctuation. */
export function normalizeSpeech(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))   // ひらがな → カタカナ
    .replace(/[\s　・･.,、。!！?？「」『』"'`~〜ー\-–—_:;()（）［］\[\]]/g, '');
}

// ASR writes the phrase in many ways: ヒューマン／フューマン／ヒュウマン、プロトコル／プロトコール／ブロトコル, ・ or spaces, or in English.
// (Matched after normalizeSpeech: long vowels and spaces are gone and hiragana is katakana, so particles read ニ／ヘ／ヲ／ノ.)
const START_RE = /(?:[ヒフ]ュウ?マン|human|hyuman|fuman)[プブ]ロトコ(?:ル|オル)|humanprotocol|humanprotcol/;
const STOP_WORDS = /^(?:ヲ|ハ)?(?:解除|終了|停止|オフ|off|ヤメ|止メ|トメ|終ワ|オワ|オシマイ|キャンセル|ストップ|stop|end)/;
const STOP_RE = new RegExp([
  'プロトコル(?:ヲ|ハ)?(?:解除|終了|停止|オフ|ヤメ|止メ|トメ|終ワ|オワ|オシマイ|キャンセル|ストップ)',
  '(?:通常|ノマル|イツモ|元|モト)(?:ノ)?(?:モド|画面|表示|姿|状態)?(?:ニ|ヘ)(?:戻|モド)(?:シテ|シテクダサイ|ス|セ|ソウ|ッテ|ロウ|レ|リタイ)',
  'protocol(?:off|stop|end)',
].join('|'));

/**
 * What the owner asked for: 'start' | 'stop' | null.
 * Stop phrases count only while the protocol is active (「元に戻して」 means many things otherwise); a start phrase that is itself followed by
 * a stop word (「ヒューマンプロトコル解除」) is never a start.
 */
export function detectProtocolCommand(text, { active = false } = {}) {
  const n = normalizeSpeech(text);
  if (!n) return null;
  const m = n.match(START_RE);
  const stopAfterName = m ? STOP_WORDS.test(n.slice(m.index + m[0].length)) : false;
  if (active && (STOP_RE.test(n) || stopAfterName)) return 'stop';
  if (m && !stopAfterName) return 'start';
  return null;
}

/** 「カメラの追従をオフ」「手の認識を切って」「カメラ追従オン」 → 'off' | 'on' | null (only meaningful while the protocol is showing). */
export function detectHandCommand(text) {
  const n = normalizeSpeech(text);
  if (!n) return null;
  const subject = /(?:カメラ|手)(?:ノ)?(?:追従|認識|トラッキング|感知|検出|追イカケ|追跡)|(?:追従|トラッキング)(?:ヲ)?(?:オン|オフ|切|止|入レ|付ケ|ツケ)|カメラ(?:ヲ|ハ)?(?:オン|オフ|切|止メ|入レ|ツケ|付ケ)/;
  const m = n.match(subject); if (!m) return null;
  const whole = n.slice(m.index);
  if (/(?:オフ|off|切|止メ|ヤメ|無効|イラナイ|ストップ|stop)/i.test(whole)) return 'off';
  if (/(?:オン|on|入レ|ツケ|付ケ|有効|再開|開始)/i.test(whole)) return 'on';
  return null;
}

/**
 * The owner's transcript grows while they speak (the same utterance is reported again and again). Fire each command once:
 * after a command, only text spoken after it is looked at; a transcript that is not a continuation is a new utterance.
 */
export function createTranscriptWatcher(detect = detectProtocolCommand) {
  let last = '', consumed = 0;
  return {
    feed(text, { active = false } = {}) {
      const t = String(text ?? '');
      // Within one utterance the text only grows; anything else is the next utterance.
      if (t.length <= last.length || !t.startsWith(last.slice(0, consumed))) consumed = 0;
      last = t;
      const cmd = detect(t.slice(consumed), { active });
      if (cmd === 'start' && active) return null;
      if (cmd) consumed = t.length;
      return cmd;
    },
    reset() { last = ''; consumed = 0; },
  };
}

// ---------------------------------------------------------------- timing / easing
export const TIMING = Object.freeze({
  hudFade: 1.1,        // s, HUD fades out / in
  emitDelay: 0.15,     // s, first particle leaves the core
  stagger: 0.95,       // s, spread of the departures
  flightMin: 1.45, flightSpread: 0.9,   // s, flight time of one particle
  formTotal: 3.5,      // s, every particle has settled by then (emitDelay + stagger + flightMin + flightSpread ≤ formTotal)
  exitStagger: 0.45, exitFlight: 1.05, exitFlightSpread: 0.35, exitTotal: 1.9,
});
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeInOutCubic = (p) => { p = clamp01(p); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
export const easeOutCubic = (p) => { p = clamp01(p); return 1 - Math.pow(1 - p, 3); };
export const easeInCubic = (p) => { p = clamp01(p); return p * p * p; };

/** Deterministic per-particle random numbers in [0,1) (the renderer and the tests agree on them). */
export function seeds(i) {
  const h = (k) => { let x = Math.imul((i + 1) ^ (k * 0x9e3779b1), 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  return [h(1), h(2), h(3), h(4)];
}

/** The flight's time curve: leaves the core with speed (a burst), lands softly (zero speed at the end — nothing stops abruptly). */
export const flightEase = (p) => 0.35 * easeOutCubic(p) + 0.65 * easeInOutCubic(p);
export const easeOutBack = (p, c1 = 1.4) => { p = clamp01(p); const c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };

/** Formation progress (0..1, eased) of a particle with seeds s at t seconds after the start. */
export function formProgress(t, s) {
  const delay = TIMING.emitDelay + s[0] * TIMING.stagger;
  const dur = TIMING.flightMin + s[1] * TIMING.flightSpread;
  return flightEase((t - delay) / dur);
}
/** Exit progress (0 = still in the figure, 1 = back in the core) at t seconds after stop() began (smooth start, drawn into the core). */
export function exitProgress(t, s) {
  const delay = s[1] * TIMING.exitStagger;
  const dur = TIMING.exitFlight + s[0] * TIMING.exitFlightSpread;
  const p = clamp01((t - delay) / dur);
  return 0.6 * easeInCubic(p) + 0.4 * easeInOutCubic(p);
}
/** Overall formedness of the whole figure (for the background / lines / glow fades). */
export const figureProgress = (t) => easeInOutCubic((t - TIMING.emitDelay) / (TIMING.formTotal - TIMING.emitDelay));
/** The figure settles with a small "snap": a touch larger while the cloud arrives, then it tightens (slight overshoot) to its true size. */
export function snapScale(t) {
  const a = TIMING.formTotal - 0.8, b = TIMING.formTotal - 0.05;
  return 1 + 0.03 * (1 - easeOutBack((t - a) / (b - a)));
}
/** The outline flares briefly at the moment the figure snaps into place. */
export const snapFlash = (t) => Math.exp(-(((t - (TIMING.formTotal - 0.15)) / 0.22) ** 2));

/**
 * Flight from a (the core) to b (the figure): a cubic Bézier that first bursts out radially (seeded direction, partly towards the target),
 * then swings in from the side and is drawn into its place; a curl-like wobble rides on it (zero at both ends).
 */
export function flightPoint(a, b, e, s) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const ang = s[2] * Math.PI * 2;
  let rx = Math.cos(ang) * 0.65 + ux * 0.35, ry = Math.sin(ang) * 0.65 + uy * 0.35; const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
  const burst = len * (0.22 + 0.25 * s[3]);
  const p1x = a[0] + rx * burst, p1y = a[1] + ry * burst;
  const side = (s[0] - 0.5) * 0.7 * len;
  const p2x = b[0] - ux * len * 0.25 - uy * side, p2y = b[1] - uy * len * 0.25 + ux * side - len * 0.12 * s[1];
  const u = 1 - e, k0 = u * u * u, k1 = 3 * u * u * e, k2 = 3 * u * e * e, k3 = e * e * e;
  const w = Math.sin(Math.PI * e) * len * 0.06;
  return [k0 * a[0] + k1 * p1x + k2 * p2x + k3 * b[0] + Math.sin(e * 9.4 + s[0] * 20) * w, k0 * a[1] + k1 * p1y + k2 * p2y + k3 * b[1] + Math.cos(e * 7.5 + s[1] * 20) * w];
}

/** Adaptive render quality (0.5..1): drops quickly when frames are slow, recovers slowly when they are fast. */
export function nextQuality(q, avgDtMs, { min = 0.5, slowMs = 24, fastMs = 17.5 } = {}) {
  // every change resizes the canvas (a hitch of its own): very slow frames go down in one bigger step instead of several small ones
  if (avgDtMs > slowMs * 2) return Math.max(min, Math.round((q - 0.25) * 100) / 100);
  if (avgDtMs > slowMs) return Math.max(min, Math.round((q - 0.1) * 100) / 100);
  if (avgDtMs < fastMs) return Math.min(1, Math.round((q + 0.05) * 100) / 100);
  return q;
}

// ---------------------------------------------------------------- viewport fit
/**
 * Where the W×H reference box goes on a vw×vh screen. Like object-fit: cover, centred on the figure (focusX),
 * but never so tall that the head is cut: the region roiTop..1 (of the height) always fits, and the bottom of the bust sits on the screen bottom.
 * Returns { s, ox, oy }: screen = ox + x*s, oy + y*s (x,y in reference px).
 */
export function fitFigure(vw, vh, W, H, { focusX = 0.505, roiTop = 0.035 } = {}) {
  let s = Math.max(vw / W, vh / H);
  const roiH = (1 - roiTop) * H;
  if (roiH * s > vh) s = vh / roiH;
  const w = W * s, h = H * s;
  let ox = vw / 2 - focusX * w;
  if (w >= vw) ox = Math.min(0, Math.max(vw - w, ox)); else ox = (vw - w) / 2;
  const oy = vh - h;   // the bust is cut by the screen bottom; the scale cap above keeps the head (roiTop) on screen
  return { s, ox, oy };
}
/** Plain cover fit (the background). */
export function coverFit(vw, vh, W, H, focusX = 0.5) {
  const s = Math.max(vw / W, vh / H), w = W * s, h = H * s;
  return { s, ox: Math.min(0, Math.max(vw - w, vw / 2 - focusX * w)), oy: (vh - h) / 2 };
}

/** How many particles this device draws (of the n in the data). */
export function particleBudget(n, { dpr = 1, cores = 4, mobile = false, reduced = false } = {}) {
  let k = 1;
  if (mobile) k *= 0.7;
  if (cores <= 4) k *= 0.8;
  if (cores <= 2) k *= 0.7;
  if (dpr >= 3) k *= 0.85;
  if (reduced) k *= 0.8;
  return Math.max(Math.min(n, 2000), Math.round(n * k));
}

// ---------------------------------------------------------------- particle data format (.bin, little endian)
//   header 32 B: 'VHP1', u16 version, u16 W, u16 H, u16 0, u32 particles, u32 lines, u32 nodes, u32 stars, u32 0
//   particles 12 B: u16 x, u16 y (0..65535 of W/H), u8 r g b, u8 bright, u8 size, u8 heat, u8 flags, u8 depth (0..255 = -Z_MAX..Z_MAX)
//   lines 4 B: u16 a, u16 b (particle indices) — then 1 B strength per line, padded to 4. Consecutive segments (b of one = a of the next) form one curve.
//   nodes 6 B: u16 x, u16 y, u8 strength, u8 radius (reference px / 2) — padded to 4
//   stars 8 B: u16 x, u16 y, u8 r g b, u8 size
export const Z_MAX = 300;   // reference px: the depth of a particle is stored in one byte, -Z_MAX..Z_MAX (towards the viewer = +)
/** The body's depth / width ratio by height (normalized y): the head a bit deeper than wide, the neck round, the torso ~2/3 as deep as wide. */
export const DEPTH = { head: 1.15, neck: 1.0, torso: 0.64 };
export function depthRatio(yN) {
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return DEPTH.head + (DEPTH.neck - DEPTH.head) * sm(0.44, 0.5, yN) + (DEPTH.torso - DEPTH.neck) * sm(0.54, 0.66, yN);
}
export const FLAG_DUST = 1, FLAG_OUTLINE = 2, FLAG_LINE = 4;   // dust around the outline / on the outline / a vertex of a traced wire curve
const MAGIC = 0x31504856;   // 'VHP1'
const pad4 = (n) => (n + 3) & ~3;

export function encodeHumanData({ W, H, particles, lines, nodes, stars }) {
  const nP = particles.length, nL = lines.length, nN = nodes.length, nS = stars.length;
  const size = 32 + nP * 12 + nL * 4 + pad4(nL) + pad4(nN * 6) + nS * 8;
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  const q16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
  const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  dv.setUint32(0, MAGIC, true); dv.setUint16(4, 1, true); dv.setUint16(6, W, true); dv.setUint16(8, H, true);
  dv.setUint32(12, nP, true); dv.setUint32(16, nL, true); dv.setUint32(20, nN, true); dv.setUint32(24, nS, true);
  let o = 32;
  for (const p of particles) {
    dv.setUint16(o, q16(p.x), true); dv.setUint16(o + 2, q16(p.y), true);
    dv.setUint8(o + 4, u8(p.r)); dv.setUint8(o + 5, u8(p.g)); dv.setUint8(o + 6, u8(p.b)); dv.setUint8(o + 7, u8(p.bright));
    dv.setUint8(o + 8, u8(p.size)); dv.setUint8(o + 9, u8(p.heat)); dv.setUint8(o + 10, u8(p.flags)); dv.setUint8(o + 11, u8(((p.z || 0) / Z_MAX * 0.5 + 0.5) * 255)); o += 12;
  }
  for (const l of lines) { dv.setUint16(o, l.a, true); dv.setUint16(o + 2, l.b, true); o += 4; }
  for (const l of lines) dv.setUint8(o++, u8(l.strength));
  o = pad4(o);
  const n0 = o;
  for (const n of nodes) { dv.setUint16(o, q16(n.x), true); dv.setUint16(o + 2, q16(n.y), true); dv.setUint8(o + 4, u8(n.strength)); dv.setUint8(o + 5, u8(n.radius)); o += 6; }
  o = n0 + pad4(nN * 6);
  for (const s of stars) { dv.setUint16(o, q16(s.x), true); dv.setUint16(o + 2, q16(s.y), true); dv.setUint8(o + 4, u8(s.r)); dv.setUint8(o + 5, u8(s.g)); dv.setUint8(o + 6, u8(s.b)); dv.setUint8(o + 7, u8(s.size)); o += 8; }
  return new Uint8Array(buf);
}

/**
 * Parse + validate the particle data. Throws on anything malformed (wrong magic / version, truncated, an index out of range).
 * Returns typed arrays: pos Float32 [x,y]* (0..1), col Uint8 [r,g,b,bright]*, attr Uint8 [size,heat,flags,depth]* (depth: zOf()), lines Uint16 [a,b]*, lineStrength Uint8,
 * nodes Float32 [x,y,strength(0..1),radius(ref px)]*, stars Float32 [x,y,size]* + starCol Uint8 [r,g,b,255]*.
 */
/** The depth (reference px, + towards the viewer) of a particle from its stored byte. */
export const zOf = (b) => (b / 255 * 2 - 1) * Z_MAX;

export function parseHumanData(input) {
  const u8a = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8a.byteLength < 32) throw new Error('human data: too short');
  const dv = new DataView(u8a.buffer, u8a.byteOffset, u8a.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('human data: bad magic');
  if (dv.getUint16(4, true) !== 1) throw new Error('human data: unsupported version');
  const W = dv.getUint16(6, true), H = dv.getUint16(8, true);
  const nP = dv.getUint32(12, true), nL = dv.getUint32(16, true), nN = dv.getUint32(20, true), nS = dv.getUint32(24, true);
  if (!W || !H || nP > 65535) throw new Error('human data: bad header');
  const need = 32 + nP * 12 + nL * 4 + pad4(nL) + pad4(nN * 6) + nS * 8;
  if (u8a.byteLength !== need) throw new Error(`human data: size ${u8a.byteLength} != ${need}`);
  const pos = new Float32Array(nP * 2), col = new Uint8Array(nP * 4), attr = new Uint8Array(nP * 4);
  let o = 32;
  for (let i = 0; i < nP; i++, o += 12) {
    pos[i * 2] = dv.getUint16(o, true) / 65535; pos[i * 2 + 1] = dv.getUint16(o + 2, true) / 65535;
    col[i * 4] = u8a[o + 4]; col[i * 4 + 1] = u8a[o + 5]; col[i * 4 + 2] = u8a[o + 6]; col[i * 4 + 3] = u8a[o + 7];
    attr[i * 4] = u8a[o + 8]; attr[i * 4 + 1] = u8a[o + 9]; attr[i * 4 + 2] = u8a[o + 10]; attr[i * 4 + 3] = u8a[o + 11];
  }
  const lines = new Uint16Array(nL * 2);
  for (let i = 0; i < nL; i++, o += 4) {
    const a = dv.getUint16(o, true), b = dv.getUint16(o + 2, true);
    if (a >= nP || b >= nP || a === b) throw new Error(`human data: bad line ${i}`);
    lines[i * 2] = a; lines[i * 2 + 1] = b;
  }
  const lineStrength = u8a.slice(o, o + nL); o = pad4(o + nL);
  const nodes = new Float32Array(nN * 4), n0 = o;
  for (let i = 0; i < nN; i++, o += 6) { nodes[i * 4] = dv.getUint16(o, true) / 65535; nodes[i * 4 + 1] = dv.getUint16(o + 2, true) / 65535; nodes[i * 4 + 2] = u8a[o + 4] / 255; nodes[i * 4 + 3] = u8a[o + 5] * 2; }
  o = n0 + pad4(nN * 6);
  const stars = new Float32Array(nS * 3), starCol = new Uint8Array(nS * 4);
  for (let i = 0; i < nS; i++, o += 8) {
    stars[i * 3] = dv.getUint16(o, true) / 65535; stars[i * 3 + 1] = dv.getUint16(o + 2, true) / 65535; stars[i * 3 + 2] = u8a[o + 7] / 32;
    starCol[i * 4] = u8a[o + 4]; starCol[i * 4 + 1] = u8a[o + 5]; starCol[i * 4 + 2] = u8a[o + 6]; starCol[i * 4 + 3] = 255;
  }
  return { W, H, count: nP, pos, col, attr, lines, lineStrength, lineCount: nL, nodes, nodeCount: nN, stars, starCol, starCount: nS };
}
