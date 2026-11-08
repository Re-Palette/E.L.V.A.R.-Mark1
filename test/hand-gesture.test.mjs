import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGestureTracker, syntheticHand, toScreen, oneEuro, extendedFingers, pinchRatio, HAND } from '../web/src/hand-gesture.js';
import { createRig, HANDFX } from '../web/src/human-rig.js';

const VW = 1280, VH = 720;
/** Run the tracker over `secs` at 24 fps; frame(t) returns the hands at time t. Collects all events. */
function run(tr, frame, secs, t0 = 0) {
  const events = []; let last;
  for (let t = t0; t < t0 + secs - 1e-9; t += 1 / 24) { last = tr.update(frame(t), t, { vw: VW, vh: VH }); events.push(...last.events.map((e) => ({ ...e, t }))); }
  return { events, last };
}

test('hand: poses from landmarks; the camera image is mirrored onto the screen', () => {
  assert.equal(extendedFingers(syntheticHand(0.5, 0.5, { pose: 'open' })), 4);
  assert.ok(extendedFingers(syntheticHand(0.5, 0.5, { pose: 'fist' })) <= 1);
  assert.ok(pinchRatio(syntheticHand(0.5, 0.5, { pose: 'pinch' })) < HAND.pinchOn && pinchRatio(syntheticHand(0.5, 0.5)) > HAND.pinchOff);
  // the camera sees you mirrored: your hand on the camera's left (x small) is on your right → the screen's right
  assert.ok(toScreen({ x: 0.2, y: 0.5 }, VW, VH).x > VW * 0.7 && toScreen({ x: 0.8, y: 0.5 }, VW, VH).x < VW * 0.3);
  assert.equal(toScreen({ x: 0.99, y: 0.01 }, VW, VH).x, 0); assert.equal(toScreen({ x: 0.99, y: 0.01 }, VW, VH).y, 0);
  // One-Euro: jitter is smoothed, a real move is followed
  const f = oneEuro(); let mx = 0; for (let i = 0; i < 48; i++) { const v = f.filter(0.5 + (i % 2 ? 0.01 : -0.01), i / 24); if (i > 10) mx = Math.max(mx, Math.abs(v - 0.5)); }
  assert.ok(mx < 0.006, `jitter ${mx}`);
  let v = 0; for (let i = 0; i < 24; i++) v = f.filter(0.8, 2 + i / 24); assert.ok(v > 0.77, 'follows a move within ~1 s');
});

test('hand: an open palm moving right is followed (mirrored), held still it is an "offer"; gone, the gaze fades back over ~1 s', () => {
  const tr = createGestureTracker();
  const first = tr.update([syntheticHand(0.7, 0.5)], 0, { vw: VW, vh: VH });
  const { last: a } = run(tr, (t) => [syntheticHand(0.7 - t * 0.2, 0.5)], 1, 1 / 24);   // the hand moves to its right = towards the camera image's left
  const { last: b, events } = run(tr, () => [syntheticHand(0.5, 0.5)], 1, 1);
  assert.ok(a.present && a.target.x > first.target.x + VW * 0.2, `mirrored follow ${first.target.x.toFixed(0)} → ${a.target.x.toFixed(0)}`);
  assert.ok(b.holding && events.filter((e) => e.type === 'hold').length === 1, 'held still: one "hold"');
  const gone = []; for (let t = 2; t < 3.6; t += 1 / 24) gone.push(tr.update([], t, { vw: VW, vh: VH }));
  assert.ok(gone[3].present && gone[3].weight === 1, 'a short drop-out is ignored');
  const mid = gone.find((g, i) => i && g.weight < 0.8 && g.weight > 0.2); assert.ok(mid && mid.target, 'fading');
  assert.equal(gone.at(-1).weight, 0); assert.equal(gone.at(-1).target, null); assert.equal(gone.at(-1).holding, false);
});

test('hand: pinch and fist tap once each (hysteresis + cooldown), a held pinch does not repeat', () => {
  const tr = createGestureTracker();
  run(tr, () => [syntheticHand(0.4, 0.45)], 0.5);
  const p = run(tr, () => [syntheticHand(0.4, 0.45, { pose: 'pinch' })], 1.5, 0.5).events.filter((e) => e.type === 'pinch');
  assert.equal(p.length, 1, 'one pinch for a held pinch');
  assert.ok(p[0].x > VW * 0.5 && p[0].y > 0 && p[0].y < VH, 'at the fingertips, mirrored');
  run(tr, () => [syntheticHand(0.4, 0.45)], 0.5, 2);
  const f = run(tr, () => [syntheticHand(0.4, 0.45, { pose: 'fist' })], 1, 2.5).events;
  assert.deepEqual(f.map((e) => e.type), ['fist'], 'a fist taps once and is not taken for a pinch');
  // rapid flicker between open and pinch: the cooldown keeps it to a tap per 0.6 s at most
  const flick = run(tr, (t) => [syntheticHand(0.4, 0.45, { pose: Math.floor(t * 12) % 2 ? 'pinch' : 'open' })], 2, 4).events.filter((e) => e.type === 'pinch');
  assert.ok(flick.length >= 2 && flick.length <= Math.ceil(2 / HAND.tapCooldown) + 1, `flicker taps ${flick.length}`);
});

test('hand: a fast sideways swipe fires once with its direction; a slow move does not; waving fires a "wave" (not swipes)', () => {
  const tr = createGestureTracker();
  run(tr, () => [syntheticHand(0.8, 0.5)], 0.4);
  const sw = run(tr, (t) => [syntheticHand(0.8 - (t - 0.4) * 2.6, 0.5)], 0.25, 0.4).events.filter((e) => e.type === 'swipe');
  assert.equal(sw.length, 1); assert.equal(sw[0].dir, 1, 'the hand moved to the screen\'s right');
  const slow = run(tr, (t) => [syntheticHand(0.15 + (t - 1) * 0.15, 0.5)], 2, 1).events.filter((e) => e.type === 'swipe');
  assert.equal(slow.length, 0, 'slow moves are just followed');
  const wave = run(tr, (t) => [syntheticHand(0.5 + 0.07 * Math.sin((t - 4) * 14), 0.5)], 2, 4).events;
  assert.equal(wave.filter((e) => e.type === 'wave').length, 1, 'one wave');
  assert.equal(wave.filter((e) => e.type === 'swipe').length, 0, 'a wave is not a swipe');
});

test('hand: two hands → look between them; near / far from the hand size; noise does not trigger gestures', () => {
  const tr = createGestureTracker();
  const two = run(tr, () => [syntheticHand(0.25, 0.5), syntheticHand(0.75, 0.5)], 1).last;
  assert.ok(Math.abs(two.target.x - VW / 2) < VW * 0.06 && two.count === 2, 'midpoint');
  const near = run(createGestureTracker(), () => [syntheticHand(0.5, 0.5, { s: 0.3 })], 1).last.near, far = run(createGestureTracker(), () => [syntheticHand(0.5, 0.5, { s: 0.08 })], 1).last.near;
  assert.ok(near > 0.8 && far < -0.8);
  // a still hand with landmark jitter (±0.6 % of the image): no swipe / wave / pinch / fist
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.012;
  const noisy = run(createGestureTracker(), () => [syntheticHand(0.5, 0.5).map((p) => ({ x: p.x + rnd(), y: p.y + rnd(), z: 0 }))], 5).events;
  assert.deepEqual([...new Set(noisy.map((e) => e.type))].filter((x) => x !== 'hold'), []);
});

test('hand: the figure answers — a swipe turns the body, a held palm draws it in, a near hand makes it lean in; the camera code sends nothing anywhere', () => {
  const r = createRig(4); let o;
  for (let i = 0; i < 60; i++) o = r.update(1 / 60, { state: 'idle' });
  const base = o.bodyYaw; r.swipe(1); let peak = -9; for (let i = 0; i < 60; i++) { o = r.update(1 / 60, { state: 'idle' }); peak = Math.max(peak, o.bodyYaw - base); }
  assert.ok(peak > HANDFX.swipeTurn * 0.6, `turns with the swipe ${peak}`);
  for (let i = 0; i < 180; i++) o = r.update(1 / 60, { state: 'idle' }); assert.ok(Math.abs(o.bodyYaw - base) < 0.3, 'and comes back');
  const offer = createRig(4); let lo; for (let i = 0; i < 120; i++) lo = offer.update(1 / 60, { state: 'idle', hand: { offer: true, near: 0 } });
  assert.ok(lo.offer > 0.9 && lo.lean > 0.4 && lo.eyeGlow > 1.3);
  const nearR = createRig(4), farR = createRig(4); let n1, f1; for (let i = 0; i < 120; i++) { n1 = nearR.update(1 / 60, { state: 'idle', hand: { near: 1 } }); f1 = farR.update(1 / 60, { state: 'idle', hand: { near: -1 } }); }
  assert.ok(n1.lean > f1.lean + 0.5 && n1.eyeSize > f1.eyeSize);
  const g = createRig(4); g.gestureNow('greet'); assert.equal(g.update(1 / 60, { state: 'idle' }).gesture, 'greet');
  // privacy: the camera module makes no request carrying frames or landmarks (only the detector's own files are fetched)
  const src = readFileSync(new URL('../web/src/hand-source.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/WebSocket|sendBeacon|XMLHttpRequest|MediaRecorder|toDataURL|localStorage|indexedDB/.test(src), 'no upload / recording / storage');
  assert.equal((src.match(/fetch\(/g) || []).length, 1, 'one fetch: the HEAD check for a self-hosted model file');
  assert.match(src, /tr\.stop\(\)/, 'tracks are stopped');
  // the detector Worker: frames in (ImageBitmaps, closed after use), landmarks out — no network / storage of its own
  const wsrc = readFileSync(new URL('../web/src/hand-worker.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/fetch\(|WebSocket|sendBeacon|XMLHttpRequest|MediaRecorder|localStorage|indexedDB|caches\./.test(wsrc), 'the worker uploads / stores nothing');
  assert.match(wsrc, /bitmap\.close\(\)/, 'frames are released');
});
