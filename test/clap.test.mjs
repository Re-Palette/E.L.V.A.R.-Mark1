import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Run the real worklet source against synthetic audio (48 kHz).
function makeDetector(sr = 48000) {
  const g = { currentTime: 0, sampleRate: sr, events: [] };
  class AWP { constructor() { this.port = { postMessage: (m) => g.events.push(m) }; } }
  const src = fs.readFileSync(new URL('../web/src/live/clap-detector.worklet.js', import.meta.url), 'utf8');
  let Cls;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'currentTime', 'sampleRate', `${src}`).call(null, AWP, (n, c) => { Cls = c; }, 0, sr);
  // currentTime is read as a free variable -> rebuild with a getter via with-less trick: wrap process
  const code = src.replace(/currentTime/g, 'G.currentTime').replace(/sampleRate/g, 'G.sampleRate');
  let C2;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'G', code)(AWP, (n, c) => { C2 = c; }, g);
  return { det: new C2({ processorOptions: {} }), g };
}
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

function run(events, secs = 5, sr = 48000) {
  const { det, g } = makeDetector(sr);
  const N = Math.round(secs * sr), x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = rnd() * 0.002;                   // room noise
  for (const { at, amp, tau } of events) {
    const s = Math.round(at * sr);
    for (let i = 0; i < sr * 0.15 && s + i < N; i++) x[s + i] += rnd() * amp * Math.exp(-i / sr / tau);
  }
  for (let o = 0; o + 128 <= N; o += 128) { g.currentTime = o / sr; det.process([[x.subarray(o, o + 128)]]); }
  return g.events.map((e) => e.type + (e.reason ? ':' + e.reason : ''));
}
const clap = (at, amp = 0.5) => ({ at, amp, tau: 0.012 });   // ~25 ms noisy burst
const key = (at, amp = 0.5) => ({ at, amp, tau: 0.0012 });   // ~3 ms click

test('a double clap is detected', () => {
  assert.ok(run([clap(1.0), clap(1.3)]).includes('double-clap'));
});
test('two key clicks are NOT a double clap', () => {
  const ev = run([key(1.0), key(1.3)]);
  assert.ok(!ev.includes('double-clap') && !ev.includes('pending'), ev.join());
});
test('a loud key then a soft clap-like tap is not a double clap', () => {
  const ev = run([clap(1.0, 0.8), clap(1.3, 0.05)]);
  assert.ok(!ev.includes('double-clap'), ev.join());
});

// ---- live-mic noise gate (pcm-capture worklet): must pass speech incl. its start, silence steady background, never touch the clap path
function makeGate(gate, sr = 48000) {
  const src = fs.readFileSync(new URL('../web/src/live/pcm-capture.worklet.js', import.meta.url), 'utf8');
  const out = []; let Cls;
  class AWP { constructor() { this.port = { postMessage: (b) => out.push(new Int16Array(b)) }; } }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(AWP, (n, c) => { Cls = c; }, sr);
  return { p: new Cls({ processorOptions: { gate } }), out };
}
function feed(gate, fn, secs, sr = 48000) {
  const { p, out } = makeGate(gate, sr); const N = Math.round(secs * sr);
  for (let o = 0; o + 128 <= N; o += 128) { const b = new Float32Array(128); for (let i = 0; i < 128; i++) b[i] = fn((o + i) / sr); p.process([[b]]); }
  const all = out.flatMap((a) => Array.from(a)); return { all, rate: 16000 };
}
const peakIn = (r, a, b) => { let m = 0; for (let i = Math.floor(a * r.rate); i < Math.floor(b * r.rate) && i < r.all.length; i++) m = Math.max(m, Math.abs(r.all[i])); return m / 32768; };
const speech = (t) => (t > 2.0 && t < 3.0 ? 0.15 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0);

test('gate: steady room/TV-level background is silenced', () => {
  seed = 7; const r = feed(2, (t) => rnd() * 0.012 + 0.006 * Math.sin(2 * Math.PI * 300 * t), 6);
  assert.ok(peakIn(r, 2, 6) < 0.001, 'background must be gated: ' + peakIn(r, 2, 6));
});
test('gate: speech passes, including its first 100 ms, and pauses inside a sentence', () => {
  seed = 7; const bg = () => rnd() * 0.004;
  const r = feed(2, (t) => bg() + speech(t), 6);
  assert.ok(peakIn(r, 2.17, 2.27) > 0.05, 'start of speech clipped');   // output is the input delayed by 160 ms (look-ahead)
  assert.ok(peakIn(r, 2.4, 3.0) > 0.05, 'speech lost');
  const withPause = feed(2, (t) => bg() + (t > 2 && t < 2.5 ? 0.15 * Math.sin(2 * Math.PI * 220 * t) : t > 3.0 && t < 3.5 ? 0.15 * Math.sin(2 * Math.PI * 220 * t) : 0), 6);
  assert.ok(peakIn(withPause, 3.2, 3.6) > 0.05, 'second phrase after a 0.5 s pause was lost');
});
test('gate: off (0) is a transparent pass-through; sound is delayed, not lost', () => {
  const r = feed(0, (t) => 0.2 * Math.sin(2 * Math.PI * 440 * t), 1);
  assert.ok(peakIn(r, 0.2, 0.9) > 0.15);
});

// ---- while the assistant speaks, its own echo must not pass the capture gate (it would make the server cut the reply off); real interruptions still do
function feedSpeaking(fn, secs, speakingFrom, sr = 48000) {
  const { p, out } = makeGate(2, sr); const N = Math.round(secs * sr); let spoke = false;
  for (let o = 0; o + 128 <= N; o += 128) { if (!spoke && o / sr >= speakingFrom) { p.port.onmessage?.({ data: { type: 'speaking', on: true } }); spoke = true; } const b = new Float32Array(128); for (let i = 0; i < 128; i++) b[i] = fn((o + i) / sr); p.process([[b]]); }
  return { all: out.flatMap((a) => Array.from(a)), rate: 16000 };
}
test('gate while speaking: faint echo of the reply is blocked, a clear sustained interruption still gets through, normal speech outside a reply is unchanged', () => {
  seed = 11; const echo = (t) => (t > 1 ? 0.03 * Math.sin(2 * Math.PI * 300 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t)) + rnd() * 0.003 : rnd() * 0.003);
  const e = feedSpeaking(echo, 5, 0.5);
  assert.ok(peakIn(e, 1.5, 5) < 0.001, 'echo while the assistant speaks must be gated: ' + peakIn(e, 1.5, 5));
  // the same moderate-level sound is NOT blocked when the assistant is silent (normal speech at that level)
  seed = 11; const n = feed(2, (t) => (t > 1 ? 0.03 * Math.sin(2 * Math.PI * 300 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t)) + rnd() * 0.003 : rnd() * 0.003), 5);
  assert.ok(peakIn(n, 1.5, 5) > 0.01, 'outside a reply, speech at this level passes: ' + peakIn(n, 1.5, 5));
  // a deliberate, loud, sustained interruption passes even during a reply
  seed = 11; const talk = (t) => (t > 2 && t < 3.2 ? 0.2 * Math.sin(2 * Math.PI * 220 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t)) : rnd() * 0.003);
  const i = feedSpeaking(talk, 5, 0.5);
  assert.ok(peakIn(i, 2.4, 3.3) > 0.1, 'a clear interruption must still be heard: ' + peakIn(i, 2.4, 3.3));
  // a short loud bump (a cough / door, < 80 ms) during a reply is not enough
  seed = 11; const bump = (t) => (t > 2 && t < 2.04 ? 0.3 * Math.sin(2 * Math.PI * 500 * t) : rnd() * 0.003);
  assert.ok(peakIn(feedSpeaking(bump, 5, 0.5), 2, 3.5) < 0.001, 'a 40 ms bump must not interrupt the reply');
});

test('stretch player: reports an underrun once when a playing reply runs dry (not at a normal end), and accepts a bigger cushion', () => {
  const sr = 48000, src = fs.readFileSync(new URL('../web/src/live/stretch-player.worklet.js', import.meta.url), 'utf8');
  const msgs = []; let Cls;
  class AWP { constructor() { this.port = { postMessage: (m) => msgs.push(m), onmessage: null }; } }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(AWP, (n, c) => { Cls = c; }, sr);
  const mk = () => new Cls({ processorOptions: { rate: 1.2 } });
  const run = (p, blocks) => { for (let i = 0; i < blocks; i++) p.process([[]], [[new Float32Array(128)]]); };
  const tone = (sec) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / sr));

  const p = mk(); p.onMessage({ type: 'pcm', data: tone(0.4) }); run(p, 400);          // plays the 0.4 s, then nothing more arrives (starved mid-reply)
  assert.equal(msgs.filter((m) => m.type === 'underrun').length, 1, 'exactly one report per starvation episode');
  msgs.length = 0; const q = mk(); q.onMessage({ type: 'pcm', data: tone(0.4) }); q.onMessage({ type: 'drain' }); run(q, 600);
  assert.equal(msgs.filter((m) => m.type === 'underrun').length, 0, 'a reply that ends normally (drain) is not an underrun');
  const r = mk(); assert.equal(r.prebuffer, Math.round(0.12 * sr)); r.onMessage({ type: 'prebuffer', ms: 400 }); assert.equal(r.prebuffer, Math.round(0.4 * sr)); r.onMessage({ type: 'prebuffer', ms: 5000 }); assert.equal(r.prebuffer, Math.round(0.8 * sr), 'capped at 0.8 s');
});

test('quieter claps (distant / laptop mic) are detected too, and the detector sends a heartbeat so the page can restart a dead listener', () => {
  const ev = run([{ at: 1.0, amp: 0.1, tau: 0.012 }, { at: 1.3, amp: 0.09, tau: 0.012 }], 4);
  assert.ok(ev.includes('double-clap'), ev.join());
  const ev2 = run([{ at: 1.0, amp: 0.2, tau: 0.025 }, { at: 1.35, amp: 0.2, tau: 0.025 }], 4);   // a slightly ringing room
  assert.ok(ev2.includes('double-clap'), ev2.join());
  assert.ok(run([], 5).filter((e) => e === 'alive').length >= 2, 'heartbeat every ~2 s');
});
test('still no false double claps: typing, a single clap, speech-like bursts', () => {
  assert.ok(!run([key(1.0, 0.3), key(1.18), key(1.4), key(1.6)]).includes('double-clap'));
  assert.ok(!run([clap(1.0)]).includes('double-clap'));
  // fricative-like sustained noise (speech "s"): long, does not decay quickly
  const speech = [0, 0.09, 0.18, 0.27].map((d) => ({ at: 1 + d, amp: 0.12, tau: 0.2 }));
  assert.ok(!run(speech).includes('double-clap'), run(speech).join());
});

test('self-tuning: when the 2nd clap keeps being too quiet to register, repeated failed attempts make the detector more tolerant (and say so)', () => {
  const evs = []; for (let k = 0; k < 14; k++) evs.push({ at: 1 + k * 4, amp: 0.02, tau: 0.012 }, { at: 1.3 + k * 4, amp: 0.014, tau: 0.012 });
  const ev = run(evs, 60);
  assert.ok(ev.includes('adapt'), 'adapted: ' + [...new Set(ev)].join());
  const first = ev.indexOf('adapt'), later = ev.slice(first).filter((e) => e === 'double-clap').length;
  assert.ok(!ev.slice(0, first).includes('double-clap') && later >= 1, `before: none, after: ${later}`);
  // quiet room, nobody clapping: no drift, no phantom double claps
  const idle = run([key(2), key(9), clap(15), key(21)], 30); assert.ok(!idle.includes('adapt') && !idle.includes('double-clap'), idle.join());
  // level handed in by the page works from the first attempt
  const { det } = makeDetector(); const det2 = new (det.constructor)({ processorOptions: { level: 2 } }); assert.equal(det2.level, 2); assert.ok(det2.absThresh < det.absThresh);
});

test('a muted / taken-over mic (exact digital silence) is reported after ~4 s so the page can re-open it; a normal quiet room is not', () => {
  const { det, g } = makeDetector(); const z = new Float32Array(128);
  for (let o = 0; o < 48000 * 6; o += 128) { g.currentTime = o / 48000; det.process([[z]]); }
  assert.ok(g.events.some((e) => e.type === 'silent'), 'silent reported');
  const q = run([], 8); assert.ok(!q.includes('silent'), 'a room with a little noise is not silent');
});

test('typing, mouse double-clicks and a slow keystroke rhythm are NOT double claps (press + release clicks, spaced keys), while a deliberate clap pair still is', () => {
  // slow typing: a keystroke every ~0.35 s for 4 s, each with a quieter release click ~0.1 s later
  const typed = []; for (let t = 1; t < 5; t += 0.35) typed.push({ at: t, amp: 0.25, tau: 0.006 }, { at: t + 0.1, amp: 0.1, tau: 0.004 });
  assert.ok(!run(typed, 7).includes('double-clap'), 'steady typing');
  // two spaced keystrokes then silence (the classic false trigger): the key presses are 0.3 s apart and nothing follows for 0.5 s
  const two = [{ at: 1, amp: 0.25, tau: 0.006 }, { at: 1.3, amp: 0.22, tau: 0.006 }, { at: 2.0, amp: 0.25, tau: 0.006 }];
  assert.ok(!run(two, 5).includes('double-clap'), 'two keys + a third 0.7 s later');
  assert.ok(!run([key(1.0, 0.3), key(1.2, 0.3)], 4).includes('double-clap'), 'mouse double click');
  assert.ok(run([{ at: 1, amp: 0.3, tau: 0.012 }, { at: 1.3, amp: 0.28, tau: 0.012 }], 4).includes('double-clap'), 'a real clap pair');
});

test('a real double clap still launches when something SOFT follows (room echo, a rustle, "OK!"), but a LOUD third sound still cancels it', () => {
  const pair = [{ at: 1, amp: 0.3, tau: 0.012 }, { at: 1.3, amp: 0.28, tau: 0.012 }];
  for (const [d, a] of [[0.25, 0.04], [0.4, 0.06], [0.55, 0.08]]) assert.ok(run([...pair, { at: 1.3 + d, amp: a, tau: 0.03 }], 5).includes('double-clap'), `soft sound ${d}s after: launches`);
  const loud = run([...pair, { at: 1.8, amp: 0.3, tau: 0.012 }], 5); assert.ok(!loud.includes('double-clap') && loud.includes('rejected:too-many'), 'a third clap = applause: no launch: ' + loud.join());
});

// Signals with a low-frequency "thud" part (desk knock, key thump) vs a bright clap.
function runMix(events, secs = 5, sr = 48000) {
  const { det, g } = makeDetector(sr); const N = Math.round(secs * sr), x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = rnd() * 0.002;
  for (const { at, amp, tau, lf } of events) { const s0 = Math.round(at * sr); let y = 0; for (let i = 0; i < sr * 0.3 && s0 + i < N; i++) { const w = rnd(); y += (w - y) * 0.015; x[s0 + i] += amp * Math.exp(-i / sr / tau) * ((1 - lf) * w + lf * y * 12); } }
  for (let o = 0; o + 128 <= N; o += 128) { g.currentTime = o / sr; det.process([[x.subarray(o, o + 128)]]); }
  return g.events.map((e) => e.type + (e.reason ? ':' + e.reason : ''));
}
test('a desk knock (low thud) is NOT a double clap, a bright hand clap is (the low/high band ratio decides)', () => {
  const knock = runMix([{ at: 1, amp: 0.4, tau: 0.02, lf: 0.95 }, { at: 1.35, amp: 0.4, tau: 0.02, lf: 0.95 }]);
  assert.ok(!knock.includes('double-clap') && knock.includes('rejected:thud'), 'knock: ' + knock.join());
  const clapMix = runMix([{ at: 1, amp: 0.3, tau: 0.012, lf: 0.2 }, { at: 1.35, amp: 0.28, tau: 0.012, lf: 0.2 }]);
  assert.ok(clapMix.includes('double-clap'), 'clap: ' + clapMix.join());
});

test('more sensitive by default: a distant / soft clap pair and a slower pair (0.85 s apart) are heard without any self-tuning; typing and knocks are still not claps', () => {
  assert.ok(run([{ at: 1.0, amp: 0.05, tau: 0.012 }, { at: 1.3, amp: 0.045, tau: 0.012 }], 4).includes('double-clap'), 'soft pair');
  assert.ok(run([{ at: 1.0, amp: 0.3, tau: 0.012 }, { at: 1.82, amp: 0.28, tau: 0.012 }], 4).includes('double-clap'), 'slow pair');
  assert.ok(run([{ at: 1.0, amp: 0.3, tau: 0.012 }, { at: 1.3, amp: 0.14, tau: 0.012 }], 4).includes('double-clap'), 'second clap a bit softer');
  const typed = []; for (let t = 1; t < 5; t += 0.2) typed.push({ at: t, amp: 0.25, tau: 0.0015 });
  assert.ok(!run(typed, 6).includes('double-clap'), 'typing');
});

test('quick claps: a fast double clap (0.10-0.14 s apart) is heard too; fast typing, press/release clicks and a fast key roll still are not', () => {
  for (const gap of [0.1, 0.12, 0.14, 0.18]) assert.ok(run([{ at: 1.0, amp: 0.3, tau: 0.012 }, { at: 1 + gap, amp: 0.28, tau: 0.012 }], 4).includes('double-clap'), `fast pair ${gap}`);
  const roll = []; for (let t = 1; t < 5; t += 0.09) roll.push({ at: t, amp: 0.25, tau: 0.0015 });
  assert.ok(!run(roll, 6).includes('double-clap'), 'fast key roll');
  const clicks = []; for (let t = 1; t < 5; t += 0.3) clicks.push({ at: t, amp: 0.25, tau: 0.006 }, { at: t + 0.1, amp: 0.2, tau: 0.004 });
  assert.ok(!run(clicks, 6).includes('double-clap'), 'press + release');
});
