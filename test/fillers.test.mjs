import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFiller, kindFor, PHRASES } from '../web/src/live/fillers.js';

const T = (o = {}) => ({ n: 0, lastAt: 0, spoke: false, last: '', ...o });

test('filler timing: nothing for quick answers, an acknowledgement after ~1.1 s, at most three, never repeated back to back', () => {
  assert.equal(nextFiller({ turn: T(), now: 1000, silentMs: 600, userText: '天気は？' }), null);
  const first = nextFiller({ turn: T(), now: 2000, silentMs: 1200, userText: '天気は？' });
  assert.ok(PHRASES.ack.includes(first), first);
  assert.notEqual(nextFiller({ turn: T({ last: first }), now: 2000, silentMs: 1200, userText: '', rnd: () => 0 }), first);
  assert.equal(nextFiller({ turn: T({ spoke: true }), now: 2000, silentMs: 5000, userText: '' }), null, 'the model already answered: no first-type filler');
  assert.equal(nextFiller({ turn: T({ n: 1, lastAt: 2000 }), now: 5000, silentMs: 4000, userText: '' }), null, 'not yet');
  assert.equal(nextFiller({ turn: T({ n: 1, lastAt: 2000 }), now: 12000, silentMs: 10000, userText: '' }), '少々お待ちください。');
  assert.equal(nextFiller({ turn: T({ n: 3, lastAt: 2000 }), now: 99000, silentMs: 90000, userText: '' }), null, 'never more than three');
});

test('filler wording follows the request: documents get 作成いたします → 作成中です', () => {
  assert.equal(kindFor('スマートグラスの企画書をPDFで作って'), 'doc'); assert.equal(kindFor('資料にまとめて'), 'doc'); assert.equal(kindFor('今日の天気は？'), 'ack');
  assert.equal(nextFiller({ turn: T(), now: 2000, silentMs: 1200, userText: '企画書を作って' }), '作成いたします。');
  assert.equal(nextFiller({ turn: T({ n: 1, lastAt: 2000, last: '作成いたします。' }), now: 12000, silentMs: 10000, userText: '企画書を作って' }), '作成中です。');
});

test('filler tick: plays the clip once after ~1.1 s of thinking, not when the model starts answering, not for system notes', async () => {
  const { initFillers, ALL_PHRASES } = await import('../web/src/live/fillers.js');
  const played = [];
  const live = { session: true, userSpoke: true, state: 'thinking', pendingTools: 0, lastModelAudioAt: 0, userText: 'PDFで資料を作って', speechRate: 1.2, playGreetingRecord: async (r) => { played.push(r); return true; } };
  const f = initFillers({ live, store: { get: () => null } });
  for (const p of ALL_PHRASES) f._inject(p, { sr: 24000, pcm: new Float32Array(24000 * 0.9) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  f.tick(); await sleep(300); f.tick(); assert.equal(played.length, 0, 'too early');
  await sleep(900); f.tick(); assert.equal(played.length, 1, 'filler due'); f.tick(); assert.equal(played.length, 1, 'only once while its own clip plays');
  // a different turn where the model answers first
  played.length = 0; live.session = true; live.userSpoke = false; f.tick(); live.userSpoke = true;
  f.tick(); live.lastModelAudioAt = performance.now() + 5; await sleep(1300); f.tick(); assert.equal(played.length, 0, 'the real answer began: no filler');
  // system note (userSpoke false) never triggers a filler
  live.userSpoke = false; live.lastModelAudioAt = 0; f.tick(); await sleep(1300); f.tick(); assert.equal(played.length, 0);
});
