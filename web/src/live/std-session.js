// "Standard voice mode": a stand-in for the Gemini Live session once the Live daily quota is used up.
// It exposes the same small interface GeminiLiveSession uses (sendRealtimeInput / sendToolResponse / close) and emits Live-style messages
// through owner.onMessage, so the rest of the app (tools, approvals, HUD, playback) works unchanged.
//   mic chunks -> client-side VAD -> WAV -> /api/chat transcribe -> /api/chat chat (tool loop) -> /api/chat tts -> 24 kHz PCM -> owner.onMessage
const LOUD = 0.006;            // RMS (0..1) of a 16 kHz chunk that counts as voice (the capture worklet already gates noise)
const START_CHUNKS = 2;        // loud chunks in a row that start an utterance (~100 ms)
const END_SILENCE_MS = 900;    // pause that ends an utterance
const MIN_VOICE_MS = 400;
const MAX_UTTERANCE_MS = 25000;
const MAX_STEPS = 6;           // tool-loop iterations per turn
const MAX_HISTORY = 40;        // contents kept (trimmed at user-text boundaries)

export const QUOTA_RE = /quota|resource.?exhausted|rate.?limit|exceed|too many|429|usage limit|daily limit/i;

export function isQuotaClose(ev) {
  const text = `${ev?.reason || ''} ${ev?.message || ''} ${ev?.code === 1011 ? 'internal' : ''}`;
  return QUOTA_RE.test(text);
}

/** 16 kHz mono Int16 -> base64 WAV */
export function wavBase64(int16, rate = 16000) {
  const n = int16.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  new Int16Array(buf, 44, n).set(int16);
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Split a reply into speakable pieces (so the first sentence starts playing while the rest is still being synthesised). */
export function splitSentences(text, max = 160) {
  const t = String(text || '').replace(/[*_`#>]+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const raw = t.match(/[^。！？!?\n]+[。！？!?]?/g) || [t];
  const out = []; let cur = '';
  for (const s of raw) {
    if ((cur + s).length > max && cur) { out.push(cur); cur = s; } else cur += s;
  }
  if (cur.trim()) out.push(cur);
  // a single very long piece: cut at commas / hard limit
  return out.flatMap((p) => (p.length <= max * 1.6 ? [p] : p.match(new RegExp(`.{1,${max}}`, 'g')) || [p])).map((p) => p.trim()).filter(Boolean);
}

export class StdSession {
  /** @param owner object with onMessage(m), authHeaders(), and optionally hud */
  constructor(owner, { fetchImpl = (...a) => fetch(...a), tts = true } = {}) {
    this.owner = owner; this.fetch = fetchImpl; this.useTts = tts;
    this.isStd = true; this.floor = 0;
    this.history = [];                 // Gemini contents
    this.reset();
    this.closed = false;
    this.epoch = 0;                    // bumped to abort the in-flight turn
    this.waiters = new Map();          // tool call id -> resolve
    this.nextId = 1;
    this.busy = false; this.pendingTexts = [];
  }

  reset() { this.rec = null; this.pre = []; this.loudRun = 0; this.silentMs = 0; this.voiceMs = 0; }

  // ---- Live-session interface ----
  sendRealtimeInput(x) {
    if (this.closed) return;
    if (x?.audio?.data) return this.onAudio(x.audio.data);
    if (typeof x?.text === 'string' && x.text.trim()) return this.enqueueText(x.text.trim());
    // audioStreamEnd: flush the utterance in progress
    if (x?.audioStreamEnd && this.rec) this.finishUtterance();
  }

  sendToolResponse({ functionResponses = [] } = {}) {
    for (const fr of functionResponses) { const r = this.waiters.get(fr.id); if (r) { this.waiters.delete(fr.id); r(fr); } }
  }

  close() { this.closed = true; this.epoch++; for (const r of this.waiters.values()) r(null); this.waiters.clear(); try { speechSynthesis?.cancel(); } catch {} }

  // ---- audio in / VAD ----
  onAudio(b64) {
    const bin = atob(b64), n = bin.length >> 1, a = new Int16Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16; a[i] = v; sum += v * v; }
    const rms = Math.sqrt(sum / Math.max(1, n)) / 32768;
    const ms = (n / 16000) * 1000;
    const loud = rms > Math.max(LOUD, this.floor * 2.5);   // adapts to a noisy room where the capture gate lets everything through
    if (!this.rec && !loud) this.floor += (Math.min(rms, 0.05) - this.floor) * 0.02;
    if (!this.rec) {
      this.pre.push(a); if (this.pre.length > 8) this.pre.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_CHUNKS) {
        this.rec = { chunks: this.pre.slice(), ms: this.pre.length * ms }; this.pre = []; this.loudRun = 0; this.silentMs = 0; this.voiceMs = START_CHUNKS * ms;
        if (this.busy || this.speaking) { this.abort(); this.owner.onMessage({ serverContent: { interrupted: true } }); }   // the owner talks over the reply
      }
      return;
    }
    this.rec.chunks.push(a); this.rec.ms += ms;
    if (loud) { this.silentMs = 0; this.voiceMs += ms; } else this.silentMs += ms;
    if (this.silentMs >= END_SILENCE_MS || this.rec.ms >= MAX_UTTERANCE_MS) this.finishUtterance();
  }

  finishUtterance() {
    const rec = this.rec, voiced = this.voiceMs; this.reset();
    if (!rec || voiced < MIN_VOICE_MS) return;
    const total = rec.chunks.reduce((s, c) => s + c.length, 0), all = new Int16Array(total);
    let o = 0; for (const c of rec.chunks) { all.set(c, o); o += c.length; }
    this.runTurn({ audio: wavBase64(all) });
  }

  // ---- text in (typed text, system notes, greeting prompts) ----
  enqueueText(text) { this.abort(); this.runTurn({ text }); }

  /** Speak `text` exactly as written (no chat model in between): used for the wake-up greeting. */
  async say(text) {
    const my = ++this.epoch; this.busy = true;
    try { await this.speak(text, my, (m) => { if (!this.closed && this.epoch === my) this.owner.onMessage(m); }); }
    catch (e) { console.warn('[std] say failed', e?.message || e); }
    finally { if (this.epoch === my) this.busy = false; }
    if (!this.closed && this.epoch === my) this.owner.onMessage({ serverContent: { turnComplete: true } });
  }

  abort() { this.epoch++; this.busy = false; this.speaking = false; for (const r of this.waiters.values()) r(null); this.waiters.clear(); try { speechSynthesis?.cancel(); } catch {} }

  // ---- one conversational turn ----
  async api(body) {
    const r = await this.fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(this.owner.authHeaders?.() || {}) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `chat ${r.status}`), { quota: Boolean(j.quota), status: r.status });
    return j;
  }

  async runTurn({ audio, text }) {
    const my = ++this.epoch; const alive = () => !this.closed && this.epoch === my;
    this.busy = true;
    const emit = (m) => { if (alive()) this.owner.onMessage(m); };
    try {
      let userText = text;
      if (audio) {
        const { text: heard } = await this.api({ action: 'transcribe', audio });
        if (!alive()) return;
        userText = (heard || '').trim();
        if (!userText) { this.busy = false; return; }          // nothing intelligible: stay silent
        emit({ serverContent: { inputTranscription: { text: userText } } });
      }
      this.history.push({ role: 'user', parts: [{ text: userText }] });
      this.trim();
      let reply = '';
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await this.api({ action: 'chat', contents: this.history });
        if (!alive()) return;
        this.history.push({ role: 'model', parts: res.parts });
        const calls = res.parts.filter((p) => p.functionCall);
        const said = res.parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
        if (!calls.length) { reply = said; break; }
        const responses = await Promise.all(calls.map((p) => this.callTool(p.functionCall, emit, alive)));
        if (!alive()) return;
        this.history.push({ role: 'user', parts: responses.map((fr) => ({ functionResponse: { name: fr.name, response: fr.response } })) });
        if (step === MAX_STEPS - 1) reply = said || '処理が長くなりすぎたため、ここで止めました。';
      }
      if (reply.trim()) emit({ serverContent: { outputTranscription: { text: reply.trim() } } });   // text of the reply (conversation log)
      if (reply.trim()) await this.speak(reply, my, emit);
      emit({ serverContent: { turnComplete: true } });
    } catch (e) {
      console.error('[std] turn failed', e);
      if (alive()) {
        this.owner.onStdError?.(e);
        // drop the user turn that never got an answer so the history stays valid (last must be a user text we can retry from)
        if (this.history.at(-1)?.role === 'user' && !this.history.at(-1).parts.some((p) => p.functionResponse)) this.history.pop();
      }
    } finally { if (this.epoch === my) { this.busy = false; } }
  }

  callTool(fc, emit, alive) {
    const id = `std-${this.nextId++}`;
    return new Promise((resolve) => {
      this.waiters.set(id, (fr) => resolve(fr || { name: fc.name, response: { error: '中断されました' } }));
      emit({ toolCall: { functionCalls: [{ id, name: fc.name, args: fc.args || {} }] } });
      if (!alive()) { this.waiters.delete(id); resolve({ name: fc.name, response: { error: '中断されました' } }); }
    });
  }

  async speak(reply, my, emit) {
    const alive = () => !this.closed && this.epoch === my;
    const pieces = splitSentences(reply);
    this.speaking = true;
    // synthesise the next piece while the current one plays
    let next = pieces.length && this.useTts ? this.synth(pieces[0]) : null;
    for (let i = 0; i < pieces.length && alive(); i++) {
      const cur = next; next = this.useTts && pieces[i + 1] ? this.synth(pieces[i + 1]) : null;
      let got = null; try { got = cur ? await cur : null; } catch (e) { console.warn('[std] tts failed', e?.message || e); }
      if (!alive()) break;
      if (got?.pcm) {
        emit({ serverContent: { modelTurn: { parts: [{ inlineData: { data: got.pcm, mimeType: `audio/pcm;rate=${got.rate || 24000}` } }] } } });
      } else {
        await this.browserSpeak(pieces[i], alive);   // TTS quota / failure: the browser's own voice
      }
    }
    if (this.epoch === my) this.speaking = false;
  }

  synth(text) { return this.api({ action: 'tts', text }); }

  browserSpeak(text, alive) {
    return new Promise((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.15;
        this.owner.stretchActive = true;
        const done = () => { this.owner.stretchActive = false; resolve(); };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
        const t = setInterval(() => { if (!alive()) { clearInterval(t); try { speechSynthesis.cancel(); } catch {} done(); } }, 200);
        u.onend = () => { clearInterval(t); done(); };
      } catch { resolve(); }
    });
  }

  /** keep the history short, always starting at a plain user text turn */
  trim() {
    while (this.history.length > MAX_HISTORY) this.history.shift();
    while (this.history.length && !(this.history[0].role === 'user' && this.history[0].parts.every((p) => typeof p.text === 'string'))) this.history.shift();
  }
}
