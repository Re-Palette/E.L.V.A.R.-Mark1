import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeSpeech, detectProtocolCommand, createTranscriptWatcher, TIMING, easeInOutCubic, easeOutCubic, easeInCubic, seeds,
  formProgress, exitProgress, figureProgress, flightPoint, fitFigure, coverFit, particleBudget, encodeHumanData, parseHumanData, FLAG_DUST, FLAG_LINE,
  flightEase, easeOutBack, snapScale, snapFlash, nextQuality,
} from '../web/src/human-protocol.js';
import { buildCurves } from '../web/src/human/renderer.js';
import { TOOLS, declarations } from '../server/google/tools.js';
import { buildInstruction } from '../server/persona.js';

test('human protocol: start phrases in every spelling ASR produces', () => {
  for (const t of ['ヒューマンプロトコル', 'フューマンプロトコル', 'ヒュウマンプロトコル', 'ヒューマン・プロトコル', 'ヒューマン プロトコル発動', 'ひゅーまんぷろとこる',
    'ﾋｭｰﾏﾝﾌﾟﾛﾄｺﾙ', 'Human Protocol', 'ＨＵＭＡＮ　ＰＲＯＴＯＣＯＬ', 'human protocol, please', 'ヒューマンプロトコール', 'ねえ、ヒューマンプロトコルを起動して'])
    assert.equal(detectProtocolCommand(t), 'start', t);
  assert.equal(normalizeSpeech('ヒューマン・プロトコル！'), 'ヒュマンプロトコル');
});

test('human protocol: stop phrases only while active; no false positives', () => {
  for (const t of ['プロトコル解除', '通常に戻して', '通常モードに戻して', 'ヒューマンプロトコル終了', 'ヒューマンプロトコルを解除して', '元に戻して', 'プロトコルをやめて', 'human protocol off'])
    assert.equal(detectProtocolCommand(t, { active: true }), 'stop', t);
  for (const t of ['プロトコル解除', '通常に戻して', 'ヒューマンプロトコル終了', '元に戻して']) assert.equal(detectProtocolCommand(t, { active: false }), null, t);
  for (const t of ['', '今日の天気は？', 'プロトコル', 'ヒューマン', 'ヒューマンリソースの資料', 'プロトコルの意味を教えて', 'もとに戻る道を教えて'])
    assert.equal(detectProtocolCommand(t, { active: true }), null, t);
  assert.equal(detectProtocolCommand('ヒューマンプロトコル', { active: true }), 'start', 'a start phrase stays a start (the caller ignores it while active)');
});

test('human protocol: a growing transcript fires each command once', () => {
  const w = createTranscriptWatcher(); let active = false; const out = [];
  const say = (t) => { const c = w.feed(t, { active }); if (c === 'start') active = true; if (c === 'stop') active = false; out.push(c); };
  ['ヒュー', 'ヒューマンプロ', 'ヒューマンプロトコル', 'ヒューマンプロトコル起動', 'ヒューマンプロトコル起動して'].forEach(say);
  assert.deepEqual(out, [null, null, 'start', null, null]);
  out.length = 0;
  ['プロトコル', 'プロトコル解除', 'プロトコル解除して'].forEach(say);   // next utterance
  assert.deepEqual(out, [null, 'stop', null]); assert.equal(active, false);
  out.length = 0;
  ['ヒューマンプロトコル'].forEach(say);
  assert.deepEqual(out, ['start'], 'the same phrase again (a new utterance) starts again');
  out.length = 0;
  ['ヒューマンプロトコル', 'ヒューマンプロトコル解除'].forEach(say);   // one utterance: its tail is the stop
  assert.deepEqual(out, [null, 'stop']);
});

test('human protocol: easing and formation timing', () => {
  for (const e of [easeInOutCubic, easeOutCubic, easeInCubic]) { assert.equal(e(0), 0); assert.equal(e(1), 1); assert.equal(e(-1), 0); assert.equal(e(2), 1); for (let p = 0; p < 1; p += 0.05) assert.ok(e(p + 0.05) >= e(p) - 1e-12); }
  assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-12);
  assert.ok(TIMING.emitDelay + TIMING.stagger + TIMING.flightMin + TIMING.flightSpread <= TIMING.formTotal + 1e-9, 'every particle lands within formTotal');
  assert.ok(TIMING.formTotal >= 2.5 && TIMING.formTotal <= 3.5 && TIMING.exitTotal >= 1.5 && TIMING.exitTotal <= 2);
  assert.ok(TIMING.exitStagger + TIMING.exitFlight + TIMING.exitFlightSpread <= TIMING.exitTotal + 1e-9);
  let sum30 = 0, n = 2000;
  for (let i = 0; i < n; i++) {
    const s = seeds(i); assert.ok(s.every((x) => x >= 0 && x < 1));
    assert.equal(formProgress(0, s), 0); assert.equal(formProgress(TIMING.formTotal, s), 1);
    assert.equal(exitProgress(0, s), 0); assert.ok(Math.abs(exitProgress(TIMING.exitTotal, s) - 1) < 1e-12);
    sum30 += formProgress(TIMING.formTotal * 0.3, s);
  }
  assert.deepEqual(seeds(5), seeds(5)); assert.notDeepEqual(seeds(5), seeds(6));
  assert.ok(sum30 / n > 0.01 && sum30 / n < 0.5, 'staggered: at 30 % of the time only part of the cloud has arrived');
  assert.equal(figureProgress(0), 0); assert.equal(figureProgress(TIMING.formTotal), 1);
  const a = [100, 500], b = [900, 120], s = seeds(3);
  assert.deepEqual(flightPoint(a, b, 0, s), a); assert.deepEqual(flightPoint(a, b, 1, s).map((v) => Math.round(v * 1e6) / 1e6), b);
  let dev = 0; for (let i = 0; i < 50; i++) { const ss = seeds(i), m = flightPoint(a, b, 0.5, ss); dev += Math.abs((m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]); }
  assert.ok(dev / 50 > 50, 'the paths curve away from the straight line');
  // the flight bursts out (speed at the start) and lands softly (no speed at the end); nothing jumps
  assert.equal(flightEase(0), 0); assert.equal(flightEase(1), 1);
  assert.ok(flightEase(0.02) > 0.02 * 0.9, 'leaves the core with speed');
  assert.ok((1 - flightEase(0.999)) / 0.001 < 0.05, 'lands with ~zero speed');
  let prev = flightPoint(a, b, 0, s);
  for (let e = 0.01; e <= 1.0001; e += 0.01) { const p = flightPoint(a, b, Math.min(1, e), s); assert.ok(Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 60, 'a smooth path, no jumps'); prev = p; }
  const early = flightPoint([500, 500], [500, 100], 0.15, [0.5, 0.5, 0, 0.5]);
  assert.ok(early[0] > 520, 'first the burst goes out radially (its seeded direction), not straight to the target');
  // the settling snap: a touch larger, tightening (slight overshoot) to exactly 1, continuous
  assert.ok(Math.abs(snapScale(0) - 1.03) < 1e-9); assert.equal(snapScale(TIMING.formTotal), 1); assert.equal(snapScale(100), 1);
  let minS = 2; for (let t = 0; t <= TIMING.formTotal; t += 0.01) { const v = snapScale(t); minS = Math.min(minS, v); assert.ok(Math.abs(v - snapScale(t + 0.01)) < 0.003, 'no jump'); }
  assert.ok(minS < 1 && minS > 0.995, 'tightens with a slight overshoot');
  assert.ok(Math.abs(easeOutBack(0)) < 1e-12 && easeOutBack(1) === 1);
  assert.ok(snapFlash(TIMING.formTotal - 0.15) > 0.99 && snapFlash(0) < 1e-6 && snapFlash(TIMING.formTotal + 2) < 1e-6);
  // adaptive quality: slow frames lower it quickly, fast frames raise it slowly, bounded
  assert.equal(nextQuality(1, 40), 0.9); assert.equal(nextQuality(1, 100), 0.75, 'very slow: one bigger step (each change resizes the canvas)'); assert.equal(nextQuality(0.5, 60), 0.5); assert.equal(nextQuality(0.8, 10), 0.85); assert.equal(nextQuality(1, 8), 1); assert.equal(nextQuality(0.7, 20), 0.7);
});

test('human protocol: the figure fits every aspect ratio (cover, head never cut, bust on the bottom edge)', () => {
  const W = 1672, H = 941;
  for (const [vw, vh] of [[1280, 720], [1920, 1080], [1671, 941], [2560, 1080], [3440, 1440], [412, 915], [390, 844], [768, 1024], [1024, 600]]) {
    const { s, ox, oy } = fitFigure(vw, vh, W, H);
    const head = oy + 0.035 * H * s, bottom = oy + H * s, coreX = ox + 0.51 * W * s, coreY = oy + 0.76 * H * s;
    assert.ok(head >= -0.5, `${vw}x${vh} head visible`); assert.ok(Math.abs(bottom - vh) < 0.5, `${vw}x${vh} bust on the bottom edge`);
    assert.ok(coreX > 0 && coreX < vw && coreY > 0 && coreY < vh, `${vw}x${vh} chest core on screen`);
    const headX = ox + 0.505 * W * s; assert.ok(Math.abs(headX - vw / 2) < vw * 0.02 + 1, `${vw}x${vh} centred on the figure`);
    if (vw / vh < W / H) assert.ok(W * s >= vw - 0.5, 'portrait: crops the sides like object-fit: cover');
    const bg = coverFit(vw, vh, W, H); assert.ok(W * bg.s >= vw - 0.5 && H * bg.s >= vh - 0.5 && bg.ox <= 0 && bg.oy <= 0.5);
  }
  const p = fitFigure(412, 915, W, H); assert.ok(Math.abs(p.s - 915 / 941) < 1e-9, 'phone portrait: full height');
  assert.equal(particleBudget(13000, { cores: 8 }), 13000); assert.ok(particleBudget(13000, { mobile: true, cores: 4, dpr: 3 }) < 8000); assert.ok(particleBudget(13000, { cores: 2, mobile: true }) >= 2000);
});

test('human protocol: data format round trip and validation', () => {
  const particles = [{ x: 0.1, y: 0.2, r: 10, g: 200, b: 255, bright: 180, size: 90, heat: 0, flags: FLAG_DUST }, { x: 0.9, y: 0.8, r: 255, g: 160, b: 60, bright: 250, size: 200, heat: 230, flags: 0 }, { x: 0.5, y: 0.5, r: 1, g: 2, b: 3, bright: 4, size: 5, heat: 6, flags: 2 }];
  const bin = encodeHumanData({ W: 1672, H: 941, particles, lines: [{ a: 0, b: 1, strength: 100 }, { a: 2, b: 1, strength: 7 }], nodes: [{ x: 0.51, y: 0.76, strength: 255, radius: 30 }], stars: [{ x: 0.3, y: 0.3, r: 100, g: 150, b: 255, size: 64 }] });
  const d = parseHumanData(bin);
  assert.equal(d.count, 3); assert.equal(d.lineCount, 2); assert.equal(d.nodeCount, 1); assert.equal(d.starCount, 1); assert.equal(d.W, 1672);
  assert.ok(Math.abs(d.pos[2] - 0.9) < 1e-4); assert.deepEqual([...d.col.subarray(4, 8)], [255, 160, 60, 250]); assert.deepEqual([...d.attr.subarray(4, 7)], [200, 230, 0]);
  assert.ok(Math.abs(d.attr[3] - 127.5) <= 1, 'no depth given: z = 0');
  assert.deepEqual([...d.lines], [0, 1, 2, 1]); assert.deepEqual([...d.lineStrength], [100, 7]); assert.ok(Math.abs(d.nodes[1] - 0.76) < 1e-4); assert.equal(d.nodes[3], 60); assert.equal(d.stars[2], 2);
  assert.throws(() => parseHumanData(bin.slice(0, bin.length - 1)), /size/);
  const bad = bin.slice(); bad[0] = 0; assert.throws(() => parseHumanData(bad), /magic/);
  assert.throws(() => parseHumanData(encodeHumanData({ W: 10, H: 10, particles: particles.slice(0, 2), lines: [{ a: 0, b: 5, strength: 1 }], nodes: [], stars: [] })), /bad line/);
});

test('human protocol: the committed particle asset is complete and faithful to the reference layout', async () => {
  const raw = readFileSync(new URL('../web/src/human/human-data.bin', import.meta.url));
  assert.ok(raw.byteLength < 400 * 1024, 'asset stays small');
  const d = parseHumanData(raw);
  assert.equal(d.W, 1672); assert.equal(d.H, 941);
  assert.ok(d.count >= 9000 && d.count <= 32000, `particles ${d.count}`);
  assert.ok(d.lineCount >= 2000, `lines ${d.lineCount}`);
  assert.ok(raw.byteLength + readFileSync(new URL('../web/src/human/human-bg.webp', import.meta.url)).byteLength < 1024 * 1024, 'first load stays under 1 MB');
  // the wires are long smooth curves (Catmull-Rom resampled): many segments per curve, short steps, gentle turns
  const curves = buildCurves(d.lines, d.lineCount, d.pos, () => true);
  const nCurves = new Set(curves.map((c) => c.seed)).size;
  assert.ok(d.lineCount / nCurves > 12, `segments per curve ${(d.lineCount / nCurves).toFixed(1)}`);
  let sharp = 0;
  for (let i = 1; i < d.lineCount; i++) {
    const a = d.lines[i * 2 - 2], b = d.lines[i * 2 - 1], c = d.lines[i * 2 + 1]; if (d.lines[i * 2] !== b) continue;
    const v1 = [(d.pos[b * 2] - d.pos[a * 2]) * d.W, (d.pos[b * 2 + 1] - d.pos[a * 2 + 1]) * d.H], v2 = [(d.pos[c * 2] - d.pos[b * 2]) * d.W, (d.pos[c * 2 + 1] - d.pos[b * 2 + 1]) * d.H];
    assert.ok(Math.hypot(...v1) < 8, 'short steps');
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1); if (cos < 0.7) sharp++;
  }
  assert.ok(sharp / d.lineCount < 0.02, `jagged corners ${sharp}`);
  for (const c of curves) assert.ok(c.t0 >= 0 && c.t1 <= 1 + 1e-9 && c.t1 >= c.t0);
  // 3D: every particle has a depth; there is a front and a back surface, the head is deeper than it is flat, wire curves lie on one surface
  const { zOf, Z_MAX } = await import('../web/src/human-protocol.js');
  let front = 0, back = 0, headMax = 0, chestMax = 0;
  for (let i = 0; i < d.count; i++) { const z = zOf(d.attr[i * 4 + 3]); assert.ok(Math.abs(z) <= Z_MAX + 1); if (z > 40) front++; if (z < -40) back++; if (d.pos[i * 2 + 1] < 0.4) headMax = Math.max(headMax, Math.abs(z)); else chestMax = Math.max(chestMax, Math.abs(z)); }
  assert.ok(front > d.count * 0.3 && back > d.count * 0.2 && front > back, `front ${front} back ${back}`);
  assert.ok(headMax > 160 && chestMax > 220, `deep: head ${headMax} chest ${chestMax}`);
  const { depthRatio } = await import('../web/src/human-protocol.js');
  assert.ok(depthRatio(0.25) > 1 && Math.abs(depthRatio(0.52) - 1) < 0.15 && depthRatio(0.8) > 0.55 && depthRatio(0.8) < 0.75, 'head deeper than wide, round neck, torso ~2/3');
  let mixed = 0; for (const c of new Set(curves.map((x) => x.seed))) { const zs = curves.filter((x) => x.seed === c).map((x) => Math.sign(zOf(d.attr[d.lines[x.i * 2] * 4 + 3]))).filter(Boolean); if (zs.length && Math.min(...zs) !== Math.max(...zs)) mixed++; }
  assert.ok(mixed / nCurves < 0.05, 'each wire curve lies on one surface');
  let onLine = 0; for (let i = 0; i < d.count; i++) if (d.attr[i * 4 + 2] & FLAG_LINE) onLine++;
  assert.ok(onLine >= d.lineCount * 0.9, 'every wire vertex is a particle (they move together)'); assert.ok(d.nodeCount >= 8 && d.nodeCount <= 64); assert.ok(d.starCount >= 300);
  for (let i = 0; i < d.count * 2; i++) assert.ok(d.pos[i] >= 0 && d.pos[i] <= 1);
  let minY = 1, cx = 0;
  for (let i = 0; i < d.count; i++) { minY = Math.min(minY, d.pos[i * 2 + 1]); cx += d.pos[i * 2]; }
  cx /= d.count;
  assert.ok(minY < 0.08, 'the head reaches the top'); assert.ok(Math.abs(cx - 0.5) < 0.05, 'the bust is centred');
  // the brightest orange node is the chest core (≈ x 51 %, y 76 % of the image); one sits on the forehead / brain
  let best = 0; for (let i = 1; i < d.nodeCount; i++) if (d.nodes[i * 4 + 2] > d.nodes[best * 4 + 2]) best = i;
  assert.ok(Math.abs(d.nodes[best * 4] - 0.51) < 0.04 && Math.abs(d.nodes[best * 4 + 1] - 0.76) < 0.04, 'chest core');
  let head = false; for (let i = 0; i < d.nodeCount; i++) if (d.nodes[i * 4 + 1] < 0.35 && Math.abs(d.nodes[i * 4] - 0.53) < 0.06) head = true;
  assert.ok(head, 'forehead node');
  const bg = readFileSync(new URL('../web/src/human/human-bg.webp', import.meta.url)); assert.equal(bg.toString('ascii', 8, 12), 'WEBP'); assert.ok(bg.byteLength < 120 * 1024);
});

test('human protocol: the voice model can call it (read tool, offered without Google) and the persona explains it', () => {
  const t = TOOLS.find((x) => x.name === 'human_protocol');
  assert.equal(t.kind, 'read'); assert.ok(t.alwaysOn); assert.deepEqual(t.schema.properties.action.enum, ['start', 'stop', 'camera_on', 'camera_off']);
  assert.ok(declarations({ alwaysOnly: true }).some((d) => d.name === 'human_protocol'));
  for (const google of [false, true]) { const p = buildInstruction({ google }); assert.match(p, /human_protocol/); assert.match(p, /ヒューマンプロトコル、起動します/); assert.match(p, /プロトコル解除/); }
});

test('human protocol: the rig lives — irregular breathing, heartbeat by state, gestures, smooth at any frame rate', async () => {
  const { createRig, noise1, beatEnv, HEART_BPM, GESTURES } = await import('../web/src/human-rig.js');
  for (let x = 0; x < 20; x += 0.01) { const a = noise1(x, 3), b = noise1(x + 0.01, 3); assert.ok(a >= -1 && a <= 1 && Math.abs(a - b) < 0.03, 'noise is smooth'); }
  assert.ok(beatEnv(0.035) > 0.95 && beatEnv(0.275) > 0.55 && beatEnv(0.15) < 0.3 && beatEnv(-1) === 0 && beatEnv(2) === 0, 'lub-dub');
  const KEYS = ['breath', 'shL', 'shR', 'sway', 'tilt', 'yaw', 'nod', 'lean', 'bob', 'beat', 'outlinePulse'];
  const run = (dt, secs, input) => { const r = createRig(42), out = []; for (let t = 0; t < secs; t += dt) out.push(r.update(dt, typeof input === 'function' ? input(t) : input)); return out; };
  // time based: 60 fps and 15 fps follow the same course (same values at the same time)
  const a = run(1 / 60, 20, { state: 'idle' }), b = run(1 / 15, 20, { state: 'idle' });
  for (const k of ['breath', 'yaw', 'tilt', 'sway']) assert.ok(Math.abs(a[a.length - 1][k] - b[b.length - 1][k]) < 0.12 * (Math.max(...a.map((o) => Math.abs(o[k]))) || 1), `${k} independent of the frame rate`);
  // smooth: no jumps between frames (bounded change per 1/60 s), even through gestures
  for (const k of KEYS.filter((x) => x !== 'beat')) { let mx = 0, rg = 0; for (let i = 1; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i][k] - a[i - 1][k])); for (const o of a) rg = Math.max(rg, Math.abs(o[k])); assert.ok(mx <= Math.max(0.02, rg * 0.06), `${k} jumps ${mx} (range ${rg})`); }
  // not mechanical: breath periods vary
  const ups = []; for (let i = 1; i < a.length; i++) if (a[i - 1].breath < 0 && a[i].breath >= 0) ups.push(i / 60);
  const per = ups.slice(1).map((x, i) => x - ups[i]); assert.ok(per.length >= 2 && Math.max(...per) - Math.min(...per) > 0.15, `breath periods ${per.map((p) => p.toFixed(2))}`);
  // gestures every few seconds, of several kinds
  const long = run(1 / 30, 90, { state: 'idle' }), kinds = new Set(long.map((o) => o.gesture).filter(Boolean));
  assert.ok(long.at(-1).gestures >= 5 && long.at(-1).gestures <= 25 && kinds.size >= 3, `gestures ${long.at(-1).gestures} ${[...kinds]}`);
  assert.ok(Object.keys(GESTURES).length >= 5);
  // heart: slow while idle, fast while thinking; while speaking it follows the voice onsets
  const beats = (o) => o.filter((x, i) => i && x.beat > 0.9 * 0.6 && o[i - 1].beat <= x.beat && (o[i + 1]?.beat ?? 0) < x.beat).length;
  const idle = run(1 / 60, 30, { state: 'idle' }), think = run(1 / 60, 30, { state: 'thinking' });
  assert.ok(beats(think) > beats(idle) * 1.3, `beats idle ${beats(idle)} thinking ${beats(think)}`);
  assert.ok(HEART_BPM.thinking > HEART_BPM.listening && HEART_BPM.listening > HEART_BPM.idle);
  assert.ok(think.some((o) => o.waves.some((w) => w.y < 0.3)), 'thinking sends waves from the forehead');
  const voice = (t) => ({ state: 'speaking', level: Math.max(0, Math.sin(t * 9)) });   // syllables ~1.4 per second
  const sp = run(1 / 60, 10, voice);
  assert.ok(sp.some((o) => Math.abs(o.bob) > 0.2), 'the head moves with the voice');
  assert.ok(sp.filter((o, i) => i && o.waves.length > sp[i - 1].waves.length).length > 10, 'beats follow the voice');
  // listening leans in; the pointer turns the head towards it and pushes particles there
  assert.ok(run(1 / 60, 4, { state: 'listening' }).at(-1).lean > 0.8);
  const right = run(1 / 60, 3, { state: 'idle', pointer: { x: 1600, y: 200 } }).at(-1), left = run(1 / 60, 3, { state: 'idle', pointer: { x: 100, y: 200 } }).at(-1);
  assert.ok(right.yaw > left.yaw + 0.15 && !('push' in right) && right.clicks.length === 0, 'follows the pointer with the face only: moving it never pushes particles');
  // a click is what makes the particles move aside: a smooth push that is gone after about a second; several clicks stay bounded
  const { clickEnv } = await import('../web/src/human-rig.js');
  assert.equal(clickEnv(0), 0); assert.ok(clickEnv(0.15) > 0.5 && clickEnv(1.3) < 0.02, 'pushes, then returns');
  for (let a = 0; a < 2; a += 0.01) assert.ok(Math.abs(clickEnv(a + 0.01) - clickEnv(a)) < 0.16, 'smooth (a quick rise, a slow return)');
  const rc = createRig(1); for (let i = 0; i < 10; i++) { rc.click(800, 600, 1); rc.update(0.05, { state: 'idle' }); }
  let o = rc.update(0.05, { state: 'idle' }); assert.ok(o.clicks.length <= 3, 'at most 3 at a time');
  for (let i = 0; i < 60; i++) o = rc.update(0.05, { state: 'idle' }); assert.equal(o.clicks.length, 0, 'gone after ~2.5 s');
  // the body turns slowly on its own (and a little with the gaze); the camera drifts
  const turns = run(1 / 30, 60, { state: 'idle' }); const by = turns.map((x) => x.bodyYaw), cy = turns.map((x) => x.camYaw);
  assert.ok(Math.max(...by) - Math.min(...by) > 0.5 && Math.max(...by.map(Math.abs)) < 0.6, `the body swings ±20-30° (${Math.min(...by).toFixed(2)}..${Math.max(...by).toFixed(2)})`);
  assert.ok(Math.max(...cy) - Math.min(...cy) > 0.35 && Math.max(...cy.map(Math.abs)) < 0.4, 'the camera orbits ±15-20°');
  const cp = turns.map((x) => x.camPitch); assert.ok(Math.max(...cp.map(Math.abs)) < 0.16 && Math.max(...cp) - Math.min(...cp) > 0.08, 'and up / down ±6-8°');
  for (let i = 1; i < turns.length; i++) assert.ok(Math.abs(turns[i].bodyYaw - turns[i - 1].bodyYaw) < 0.02 && Math.abs(turns[i].camYaw - turns[i - 1].camYaw) < 0.02, 'smoothly');
});

test('human protocol: face and eyes follow the pointer — eyes first, the head on a soft spring, limited, front again after a rest; blinks', async () => {
  const { createRig, springStep, LOOK } = await import('../web/src/human-rig.js');
  const sim = (secs, input, dt = 1 / 60, r = createRig(5)) => { const out = []; for (let t = 0; t < secs; t += dt) out.push(r.update(dt, typeof input === 'function' ? input(t) : input)); return { out, r }; };
  // the spring: lags, then catches up with at most a slight overshoot, no jumps; stable at 10 fps too
  const s = { x: 0, v: 0 }; let peak = 0, prev = 0, maxStep = 0;
  for (let i = 0; i < 180; i++) { const x = springStep(s, 1, 5.2, 0.82, 1 / 60); peak = Math.max(peak, x); maxStep = Math.max(maxStep, x - prev); prev = x; }
  assert.ok(peak > 1 && peak < 1.06, `slight overshoot ${peak}`); assert.ok(Math.abs(s.x - 1) < 0.01 && maxStep < 0.06);
  const s10 = { x: 0, v: 0 }; for (let i = 0; i < 30; i++) springStep(s10, 1, 22, 0.9, 0.1); assert.ok(Math.abs(s10.x - 1) < 0.01, 'stable with big steps');
  // follow: right / left / up / down within the natural range; the eyes lead the head
  const at = (x, y, secs = 3) => sim(secs, { state: 'idle', pointer: { x, y, idle: 0 } }).out;
  const right = at(1660, 230).at(-1), left = at(10, 230).at(-1), up = at(845, 0).at(-1), down = at(845, 941).at(-1);
  assert.ok(right.yaw > 0.35 && left.yaw < -0.35, 'turns left / right');
  for (const o of [right, left, up, down]) { assert.ok(Math.abs(o.yaw) <= LOOK.maxYaw + 0.12 && Math.abs(o.pitch) <= LOOK.maxPitch + 0.001, 'natural range'); }
  assert.ok(up.pitch < -0.1 && down.pitch > 0.1 && down.pitch <= LOOK.maxPitch + 1e-3, 'looks up / down (down is limited: the input bar does not make it look at its feet)');
  const jump = at(1660, 230, 0.25), eyeFirst = jump[8], headLate = jump[8];
  assert.ok(eyeFirst.gazeX > 0.5 && headLate.yaw < right.yaw * 0.5, 'after ~0.13 s the eyes are already there, the head is still on its way');
  assert.ok(right.gazeX > 0 && Math.abs(right.gazeX) < 0.5, 'once the head has arrived the eyes rest near the centre (a little towards the target)');
  // a still pointer keeps being followed; after a long rest (or none on the page) it looks ahead again, slowly
  const still = sim(6, (t) => ({ state: 'idle', pointer: { x: 1660, y: 230, idle: t } })).out.at(-1);
  assert.ok(still.yaw > 0.35, 'a pointer that rests on the page is still watched');
  const rest = sim(16, (t) => ({ state: 'idle', pointer: { x: 1660, y: 230, idle: t } })).out;
  assert.ok(rest.at(-1).eng < 0.1 && Math.abs(rest.at(-1).yaw) < 0.2 && rest[Math.round(9.5 * 60)].yaw > rest.at(-1).yaw, 'after ~8 s of rest it slowly turns back to the front');
  // near the face: the eyes glow / grow and it leans in; reduced motion follows less
  const near = at(860, 300).at(-1); assert.ok(near.near > 0.8 && near.eyeSize > 1.2 && near.eyeGlow > right.eyeGlow && near.lean > 0.3);
  const red = sim(3, { state: 'idle', reduced: true, pointer: { x: 1660, y: 230, idle: 0 } }).out.at(-1); assert.ok(red.yaw < right.yaw * 0.6 && red.yaw > 0.05);
  // blinking every few seconds (3-7 s, sometimes twice), quickly
  const bl = sim(40, { state: 'idle' }).out; const n = bl.at(-1).blinks; assert.ok(n >= 6 && n <= 18, `blinks ${n}`);
  let closedFrames = 0; for (const o of bl) if (o.eyeOpen < 0.5) closedFrames++; assert.ok(closedFrames / n < 10, 'a blink lasts a few frames only');
});

import { detectHandCommand, createTranscriptWatcher as _ctw, detectProtocolCommand as _dpc } from '../web/src/human-protocol.js';
test('camera follow switch: spoken / typed off & on phrases are understood, other talk is not', () => {
  for (const t of ['カメラの追従をオフにして', 'カメラ追従オフ', '手の認識を切って', 'カメラを止めて', 'トラッキングをオフ', 'camera tracking off']) assert.equal(detectHandCommand(t), t === 'camera tracking off' ? null : 'off', t);
  for (const t of ['カメラの追従をオンにして', 'カメラ追従オン', '手の追従を入れて', 'カメラをつけて']) assert.equal(detectHandCommand(t), 'on', t);
  for (const t of ['今日の天気は', 'カメラの画質が気になる', '手を洗ってきます', 'ヒューマンプロトコル']) assert.equal(detectHandCommand(t), null, t);
  const w = _ctw(detectHandCommand); assert.equal(w.feed('カメラの追従'), null); assert.equal(w.feed('カメラの追従をオフに'), 'off'); assert.equal(w.feed('カメラの追従をオフにして'), null, 'the same growing utterance fires once');
  assert.equal(_dpc('ヒューマンプロトコル'), 'start');
});
