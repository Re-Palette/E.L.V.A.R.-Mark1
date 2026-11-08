import test from 'node:test';
import assert from 'node:assert/strict';
import { StdSession, isQuotaClose, splitSentences, wavBase64, QUOTA_RE } from '../web/src/live/std-session.js';
import { sanitizeContents, handleChat } from '../server/chat-api.js';
import { handleLiveToken } from '../server/live-token-core.js';

const b64 = (i16) => Buffer.from(new Uint8Array(i16.buffer)).toString('base64');
const chunk = (amp) => { const a = new Int16Array(512); for (let i = 0; i < 512; i++) a[i] = amp * Math.sin(i / 5); return b64(a); };
const feed = (s, amp, n) => { for (let i = 0; i < n; i++) s.sendRealtimeInput({ audio: { data: chunk(amp), mimeType: 'audio/pcm;rate=16000' } }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('quota detection: close reasons that mean the daily limit', () => {
  for (const r of ['Quota exceeded for this model', 'RESOURCE_EXHAUSTED', 'rate limit', 'You exceeded your current quota', '429 too many requests']) assert.ok(isQuotaClose({ reason: r }), r);
  assert.ok(!isQuotaClose({ reason: 'Deadline expired' })); assert.ok(!isQuotaClose({}));
  assert.ok(QUOTA_RE.test('Error: Gemini quota'));
});

test('splitSentences / wav', () => {
  assert.deepEqual(splitSentences('はい。承知しました！少々お待ちください？'), ['はい。承知しました！少々お待ちください？']);
  assert.deepEqual(splitSentences('あ'.repeat(100) + '。' + 'い'.repeat(100) + '。'), ['あ'.repeat(100) + '。', 'い'.repeat(100) + '。']);
  assert.ok(splitSentences('a'.repeat(500)).every((p) => p.length <= 160));
  assert.deepEqual(splitSentences('  **  https://x.y  '), []);
  const w = Buffer.from(wavBase64(new Int16Array(100)), 'base64'); assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.length, 244);
});

test('StdSession: speech -> transcript -> tool call -> spoken reply, history stays valid', async () => {
  const calls = []; const msgs = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b.action);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (b.action === 'transcribe') return ok({ text: '今日の予定は？' });
    if (b.action === 'chat') {
      const last = b.contents.at(-1);
      if (last.parts[0].functionResponse) return ok({ parts: [{ text: '本日は会議が一件です。' }] });
      return ok({ parts: [{ functionCall: { name: 'calendar_list', args: {} } }] });
    }
    if (b.action === 'tts') return ok({ pcm: b64(new Int16Array(240)), rate: 24000 });
    throw new Error('?');
  };
  const owner = { authHeaders: () => ({}), onMessage(m) { msgs.push(m); if (m.toolCall) setTimeout(() => s.sendToolResponse({ functionResponses: [{ id: m.toolCall.functionCalls[0].id, name: 'calendar_list', response: { events: [] } }] }), 5); } };
  const s = new StdSession(owner, { fetchImpl });
  feed(s, 8000, 40);      // ~1.3 s of voice
  feed(s, 0, 40);         // silence -> utterance ends
  for (let i = 0; i < 60 && !msgs.some((m) => m.serverContent?.turnComplete); i++) await sleep(20);
  assert.deepEqual(calls, ['transcribe', 'chat', 'chat', 'tts']);
  assert.equal(msgs[0].serverContent.inputTranscription.text, '今日の予定は？');
  assert.ok(msgs.some((m) => m.toolCall?.functionCalls[0].name === 'calendar_list'));
  assert.ok(msgs.some((m) => m.serverContent?.modelTurn?.parts[0].inlineData.data));
  assert.equal(s.history.map((h) => h.role).join(), 'user,model,user,model');
  sanitizeContents(s.history.slice(0, 3));   // what the server accepts
});

test('StdSession: noise too short is ignored; talking over the reply interrupts it', async () => {
  const calls = []; const msgs = [];
  const fetchImpl = async (u, init) => { const b = JSON.parse(init.body); calls.push(b.action); await sleep(30); return { ok: true, status: 200, json: async () => (b.action === 'tts' ? { pcm: b64(new Int16Array(240)) } : b.action === 'chat' ? { parts: [{ text: 'はい。' }] } : { text: 'こんにちは' }) }; };
  const s = new StdSession({ authHeaders: () => ({}), onMessage: (m) => msgs.push(m) }, { fetchImpl });
  feed(s, 8000, 4); feed(s, 0, 40); await sleep(50);
  assert.deepEqual(calls, [], 'a blip is not an utterance');
  s.sendRealtimeInput({ text: 'テスト' }); await sleep(10);
  feed(s, 8000, 5);                       // owner starts talking while the turn is in flight
  assert.ok(msgs.some((m) => m.serverContent?.interrupted));
});

test('chat-api: handleChat transcribe/chat/tts via stubbed Gemini; quota -> {quota:true}', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const real = globalThis.fetch; let mode = 'ok';
  globalThis.fetch = async (url) => {
    if (mode === 'quota') return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
    if (String(url).includes('tts')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }] }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'やあ' }] } }] }) };
  };
  try {
    const wav = wavBase64(new Int16Array(400));
    assert.equal((await handleChat({ method: 'POST', body: { action: 'transcribe', audio: wav } })).body.text, 'やあ');
    assert.equal((await handleChat({ method: 'POST', body: { action: 'chat', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } })).body.parts[0].text, 'やあ');
    const t = await handleChat({ method: 'POST', body: { action: 'tts', text: 'こんにちは' } }); assert.equal(t.body.rate, 24000);
    assert.equal((await handleChat({ method: 'POST', body: { action: 'chat', contents: [{ role: 'model', parts: [{ text: 'x' }] }] } })).status, 400);
    assert.equal((await handleChat({ method: 'POST', body: { action: 'transcribe', audio: '<bad>' } })).status, 400);
    mode = 'quota'; const q = await handleChat({ method: 'POST', body: { action: 'tts', text: 'a' } }); assert.equal(q.status, 429); assert.equal(q.body.quota, true);
  } finally { globalThis.fetch = real; }
});

test('live-token: ?fallback=1 without a fallback model -> no_fallback (404)', async () => {
  const cfg = { apiKey: 'k', accessToken: 't', onVercel: true, model: 'm', fallbackModel: '' };
  const r = await handleLiveToken({ method: 'POST', url: '/api/live-token?fallback=1', headers: { 'x-elvar-token': 't' } }, cfg);
  assert.equal(r.status, 404); assert.equal(r.body.error, 'no_fallback');
});

test('chat-api: a retired / unknown model is skipped (404 -> next model), quota is NOT retried', async () => {
  process.env.GEMINI_API_KEY = 'k'; delete process.env.STD_CHAT_MODEL;
  const real = globalThis.fetch; const tried = [];
  globalThis.fetch = async (url) => {
    const m = decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]); tried.push(m);
    if (m === 'gemini-flash-latest') return { ok: false, status: 404, json: async () => ({ error: { message: 'models/x is not found' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  };
  try {
    const r = await handleChat({ method: 'POST', body: { action: 'chat', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
    assert.equal(r.status, 200); assert.deepEqual(tried, ['gemini-flash-latest', 'gemini-2.5-flash']);
    tried.length = 0; globalThis.fetch = async (url) => { tried.push(1); return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }; };
    const q = await handleChat({ method: 'POST', body: { action: 'chat', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
    assert.equal(q.status, 429); assert.equal(tried.length, 1);
  } finally { globalThis.fetch = real; }
});

test('live token config: speech recognition limited to Japanese + English with a vocabulary hint (env can change it)', async () => {
  const { readConfig, VOCAB } = await import('../server/live-token-core.js');
  assert.deepEqual(readConfig({}).inputLangs, ['ja-JP', 'en-US']);
  assert.deepEqual(readConfig({ GEMINI_LIVE_INPUT_LANGS: '' }).inputLangs, []);
  assert.deepEqual(readConfig({ GEMINI_LIVE_INPUT_LANGS: 'ja-JP' }).inputLangs, ['ja-JP']);
  assert.ok(VOCAB.includes('ご主人様') && VOCAB.includes('エルヴァー'));
});

test('gemini-models: a retired model name (404) is skipped and remembered; quota errors are not retried', async () => {
  const { withGeminiModel, geminiModels, _resetGone, modelIsGone } = await import('../server/gemini-models.js');
  _resetGone();
  const tried = [];
  const r = await withGeminiModel(undefined, async (m) => { tried.push(m); if (m === 'gemini-flash-latest') throw Object.assign(new Error('x'), { status: 404 }); return m; });
  assert.equal(r, 'gemini-2.5-flash'); assert.deepEqual(tried, ['gemini-flash-latest', 'gemini-2.5-flash']);
  assert.equal(geminiModels()[0], 'gemini-2.5-flash', 'remembered');
  await assert.rejects(() => withGeminiModel(undefined, async () => { throw Object.assign(new Error('quota'), { status: 429 }); }), /quota/);
  assert.ok(modelIsGone(404) && modelIsGone(400, 'model is not found') && !modelIsGone(429) && !modelIsGone(400, 'bad json'));
  _resetGone();
});
