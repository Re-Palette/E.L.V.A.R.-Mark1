import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoCloseController } from '../web/src/auto-close.js';

const mk = () => { const live = { modelSpeaking: false, stretchActive: false, state: 'idle', pendingTools: 0, userSpoke: false, lastModelAudioAt: 0 }; let t = 100000; const clock = { t: () => t, adv: (ms) => { t += ms; } }; const closed = []; const ctl = createAutoCloseController({ live, now: clock.t, delayMs: 5000, maxWaitMs: 25000 }); return { live, clock, closed, ctl, arm: () => ctl.arm(() => closed.push(clock.t())) }; };

test('auto-close: waits while ELVAR is explaining, then closes ~5 s after the explanation ended', () => {
  const { live, clock, closed, ctl, arm } = mk(); arm();
  assert.equal(ctl.tick(), 'wait', 'the explanation has not started yet'); clock.adv(2000);          // the model starts speaking 2 s after the screen opened
  live.modelSpeaking = true; live.lastModelAudioAt = clock.t(); assert.equal(ctl.tick(), 'wait');
  for (let i = 0; i < 20; i++) { clock.adv(500); live.lastModelAudioAt = clock.t(); assert.equal(ctl.tick(), 'wait'); }   // 10 s of speech: the screen stays
  assert.equal(closed.length, 0);
  live.modelSpeaking = false;                                  // explanation over
  clock.adv(600); assert.equal(ctl.tick(), 'wait', 'a short grace after the last audio');
  clock.adv(1000); const r = ctl.tick(); assert.equal(typeof r, 'number'); assert.ok(r >= 4 && r <= 5, 'countdown started: ' + r);
  clock.adv(3000); assert.equal(typeof ctl.tick(), 'number'); assert.equal(closed.length, 0);
  clock.adv(2100); assert.equal(ctl.tick(), 'closed'); assert.equal(closed.length, 1); assert.equal(ctl.tick(), 'idle', 'closed once');
});

test('auto-close: any touch of the screen keeps it open', () => {
  const { live, clock, closed, ctl, arm } = mk(); arm(); live.lastModelAudioAt = clock.t() + 1; clock.adv(3000);
  assert.equal(typeof ctl.tick(), 'number'); ctl.engage(); clock.adv(10000); assert.equal(ctl.tick(), 'idle'); assert.equal(closed.length, 0, 'the owner is using it');
});

test('auto-close: a follow-up question (the owner speaks) or a tool call restarts the wait; thinking / pending tools block it; it gives up waiting for a silent explanation after 25 s', () => {
  const { live, clock, closed, ctl, arm } = mk(); arm(); clock.adv(1000); live.lastModelAudioAt = clock.t(); clock.adv(3000);
  live.userSpoke = true; assert.equal(ctl.tick(), 'wait'); live.userSpoke = false; clock.adv(6000); assert.equal(ctl.tick(), 'wait', 'new explanation expected after the question');
  live.lastModelAudioAt = clock.t(); clock.adv(2000); live.pendingTools = 1; assert.equal(ctl.tick(), 'wait'); live.pendingTools = 0; live.state = 'thinking'; assert.equal(ctl.tick(), 'wait'); live.state = 'listening';
  clock.adv(1500); assert.equal(typeof ctl.tick(), 'number'); clock.adv(5100); assert.equal(ctl.tick(), 'closed');
  const b = mk(); b.arm(); b.clock.adv(24000); assert.equal(b.ctl.tick(), 'wait'); b.clock.adv(2000); assert.equal(typeof b.ctl.tick(), 'number', 'no speech came: after 25 s the 5 s countdown starts'); b.clock.adv(5200); assert.equal(b.ctl.tick(), 'closed');
});

test('auto-close: a newer screen replaces the older arming; disarm cancels', () => {
  const { live, clock, closed, ctl } = mk(); const log = [];
  ctl.arm(() => log.push('A')); ctl.arm(() => log.push('B')); live.lastModelAudioAt = clock.t() + 1; clock.adv(3000); ctl.tick(); clock.adv(5200); assert.equal(ctl.tick(), 'closed'); assert.deepEqual(log, ['B']);
  ctl.arm(() => log.push('C')); ctl.disarm(); clock.adv(40000); assert.equal(ctl.tick(), 'idle'); assert.deepEqual(log, ['B']);
});
