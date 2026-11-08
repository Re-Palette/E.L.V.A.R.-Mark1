// Gemini Live realtime voice session: mic → Gemini → speaker, driving the HUD.
// Keys never reach the browser: we fetch a short-lived, config-locked ephemeral token from /api/live-token.
import { GoogleGenAI } from '@google/genai';
import { AudioMeter } from './audio-meter.js';
import { getGreeting, putGreeting, concatPcm } from './greeting-cache.js';
import { greetingPrompt } from './greeting-gen.js';
import { StdSession, QUOTA_RE, isQuotaClose } from './std-session.js';

const OUT_RATE = 24000; // Gemini Live output: 24 kHz 16-bit PCM
const TOKEN_KEY = 'elvar_access_token';
const QUOTA_HOURS = 3;   // after the Live limit is hit, stay away from Live for this long (the limit is per day; we re-probe later)
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const flagActive = (k) => Number(lsGet(k)) > Date.now();

export class GeminiLiveSession {
  constructor(hud, { speechRate = 2 } = {}) {
    this.hud = hud;
    this.speechRate = speechRate;          // playback speed of the model's voice, pitch preserved (1 = as generated)
    this.player = null; this.stretchActive = false;
    this.cacheKey = null; try { this.cacheKey = localStorage.getItem('elvar_greet_key'); } catch {}
    this.recordTo = null; this.recordLine = '';
    this.session = null;
    this.connecting = null;
    this.micOn = false;
    this.lastModelAudioAt = 0;
    this.playUntil = 0;   // performance.now() when everything received from the model should have finished playing (independent of the player's own flags)
    this.inCtx = null; this.outCtx = null;
    this.micStream = null; this.worklet = null;
    this.inMeter = null; this.outMeter = null;
    this.sources = new Set(); this.nextStart = 0;
    this.userText = ''; this.modelText = '';
    this.userSpoke = false; this.lastVoiceAt = 0; this.modelSpeaking = false;
    this.raf = 0;
    this.onToolCall = null; this.onToolCancel = null; this.pendingTools = 0; this.cancelledTools = new Set();
    this.stats = { interrupted: 0, interruptedMicQuiet: 0, underruns: 0, closes: 0, goAway: 0, prebufferMs: 120, since: Date.now() };   // for the system check: why a reply got cut
    this.lastMicLoudAt = 0;
    this.onSessionOpen = null;   // HUD activity log: a conversation opened
    this.onIdle = null;      // called when the session closed / stopped (main.js re-arms standby)
    this.afterTurn = null;   // one-shot callback after the model finishes its current turn
    this.mode = 'live';      // 'live' | 'live2' (fallback Live model) | 'std' (standard voice: STT -> chat -> TTS)
    this.openedAt = 0; this.stopping = false; this.earlyCloses = [];
    this.onModeChange = null;
    this.turnLog = { user: '', model: '' }; this.onTurn = null;   // finished turns {user, model, at} for the conversation log
    this.onTranscript = null;   // (text so far of the owner's current utterance) — used to answer a voice-enabled confirmation card
  }

  /** 'auto' (default) | 'live' (never switch) | 'std' (always standard voice) */
  voicePref() { const v = lsGet('elvar_voice_mode'); return v === 'live' || v === 'std' ? v : 'auto'; }

  /** The Live limit was reached: remember it so the next connections go to the fallback model / standard voice. */
  markQuota(stage = this.mode) {
    const until = String(Date.now() + QUOTA_HOURS * 3600_000);
    lsSet(stage === 'live2' ? 'elvar_live_quota2_until' : 'elvar_live_quota_until', until);
  }
  quotaState() { return { main: flagActive('elvar_live_quota_until'), fallback: flagActive('elvar_live_quota2_until') }; }

  // ---- public ----
  async startMic() {
    await this.ensureConnected();
    if (this.micOn) return;
    await this.openMic();
    this.micOn = true;
    this.hud.setMicActive?.(true);
    this.refreshState();
  }

  stopMic() {
    if (!this.micOn) return;
    this.micOn = false;
    this.closeMic();
    this.hud.setMicActive?.(false);
    try { this.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
    this.refreshState();
  }

  /** Pitch-preserving fast playback (WSOLA worklet). Falls back to plain 1x playback if unavailable. */
  async setupPlayer() {
    if (this.speechRate <= 1.05) { this.player?.disconnect(); this.player = null; return; }
    try {
      if (!this.player) {
        await this.outCtx.audioWorklet.addModule(new URL('./stretch-player.worklet.js', import.meta.url));
        this.player = new AudioWorkletNode(this.outCtx, 'stretch-player', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate: this.speechRate },
        });
        this.player.port.onmessage = (e) => {
          if (e.data?.type === 'active') this.stretchActive = !!e.data.on;
          else if (e.data?.type === 'underrun') {   // playback ran dry: keep a bigger cushion for the next replies (up to 0.6 s)
            this.stats.underruns++; this.stats.prebufferMs = Math.min(600, this.stats.prebufferMs + 80);
            try { this.player.port.postMessage({ type: 'prebuffer', ms: this.stats.prebufferMs }); } catch {}
          }
        };
      }
      this.player.disconnect();
      this.player.connect(this.outAnalyser);
    } catch (e) {
      console.warn('[live] stretch player unavailable, using normal-speed playback', e);
      this.player = null;
    }
  }

  setSpeechRate(rate) {
    this.speechRate = Math.max(1, Math.min(3, +rate || 1));
    this.player?.port.postMessage({ type: 'rate', value: this.speechRate });
  }

  /** Create/resume the playback context while a user gesture is available, so a later wake (no gesture) can speak. */
  async prepareAudio() { return this.ensureOutput(); }

  /** Output chain (context -> analyser -> speakers, + stretch player). Idempotent; works before any connection. */
  async ensureOutput() {
    this.outCtx ??= new AudioContext({ sampleRate: OUT_RATE });
    await this.outCtx.resume().catch(() => {});
    if (!this.outAnalyser) {
      const a = this.outCtx.createAnalyser();
      a.fftSize = 1024; a.smoothingTimeConstant = 0.6;
      a.connect(this.outCtx.destination);
      this.outAnalyser = a; this.outMeter = new AudioMeter(a);
    }
    if (!this.player && this.speechRate > 1.05) await this.setupPlayer();
    return this.outCtx.state === 'running';
  }

  /** Instant local greeting: play the cached recording (no network). @returns {Promise<boolean>} true if it started */
  async playCachedGreeting(line) {
    const rec = await this.loadCachedGreeting(line);
    return rec ? this.playGreetingRecord(rec) : false;
  }

  /** The saved recording for `line`, or null if missing / stale (voice or persona changed). */
  async loadCachedGreeting(line) {
    const rec = await getGreeting(line);
    if (!rec || (this.cacheKey && rec.key && rec.key !== this.cacheKey)) return null;
    return rec;
  }

  async playGreetingRecord(rec) {
    if (!(await this.ensureOutput())) return false;
    this.startLoop();
    this.pushPcm(rec.pcm.slice());
    this.player?.port.postMessage({ type: 'drain' });
    return true;
  }

  /** Tiny instant "power-up" sound for when there is no cached greeting yet. */
  playChime() {
    const c = this.outCtx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    for (const [f, d] of [[660, 0], [990, 0.09]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.linearRampToValueAtTime(0.12, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + d + 0.22);
      o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.25);
    }
  }

  /** After a local greeting: make sure we are connected, let the greeting finish, then open the mic. */
  async listenAfterPlayback() {
    await this.ensureConnected();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 150));
    while ((this.player ? this.stretchActive : this.sources.size > 0) && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 60));
    return this.startMic();
  }

  /** Wake-up: connect, have the model read `line` verbatim, then open the mic when it has finished. */
  async greetThenListen(line, { record = false } = {}) {
    await this.ensureConnected();
    this.recordTo = record ? [] : null; this.recordLine = line;
    let started = false;
    const listen = async () => {
      if (started) return; started = true; this.afterTurn = null;
      // turnComplete = generation finished; the greeting may still be playing from the buffer: let it end before the mic opens
      const t0 = performance.now();
      while ((this.player ? this.stretchActive : this.sources.size > 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 60));
      this.startMic().catch((e) => console.error('[live] mic after greeting', e));
    };
    this.afterTurn = listen;
    setTimeout(listen, 15000); // safety net if turnComplete never arrives
    this.userSpoke = false; this.modelText = '';
    if (this.session.isStd) this.session.say(line);   // standard voice: speak the line exactly (TTS), no chat model in between
    else this.session.sendRealtimeInput({ text: greetingPrompt(line) });
  }

  async sendText(text) {
    if (!text.trim()) return;
    await this.ensureConnected();
    this.userText = text; this.hud.setTranscript(text, 'user');
    this.userSpoke = true; this.lastVoiceAt = performance.now();
    this.session.sendRealtimeInput({ text });
  }

  /** Send an instruction to the model that is not shown as the owner's speech (e.g. the scheduled briefing). */
  async sendSystemNote(text) {
    await this.ensureConnected();
    this.userSpoke = false; this.modelText = '';
    this.session.sendRealtimeInput({ text });
  }

  async stop() {
    this.stopping = true; this.flushTurn();
    this.stopMic();
    this.stopPlayback();
    try { this.session?.close(); } catch {}
    this.session = null;
    this.hud.setState('idle'); this.hud.setStatusLabel('OFFLINE');
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.onIdle?.();
    setTimeout(() => { this.stopping = false; }, 1500);
  }

  // ---- connection ----
  async ensureConnected() {
    if (this.session) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  /** Headers that authorise calls to our own /api (the access token saved in the browser or passed by the desktop app). */
  authHeaders() {
    let saved = ''; try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch {}
    saved = saved || window.elvarDesktop?.accessToken || '';
    return saved ? { 'x-elvar-token': saved } : {};
  }

  async fetchToken({ interactive = true, fallback = false, plain = flagActive('elvar_plain_asr') } = {}) {
    const url = '/api/live-token' + (fallback || plain ? '?' + [fallback && 'fallback=1', plain && 'plain=1'].filter(Boolean).join('&') : '');
    const headers = { 'content-type': 'application/json' };
    const saved = localStorage.getItem(TOKEN_KEY) || window.elvarDesktop?.accessToken || ''; // desktop app passes it at launch (no window.prompt there)
    if (saved) headers['x-elvar-token'] = saved;
    let r = await fetch(url, { method: 'POST', headers });
    if (r.status === 401 && !interactive) throw new Error('unauthorized');
    if (r.status === 401) {
      const entered = window.prompt('E.L.V.A.R. アクセストークンを入力してください');
      if (!entered) throw new Error('アクセストークンが必要です');
      localStorage.setItem(TOKEN_KEY, entered);
      headers['x-elvar-token'] = entered;
      r = await fetch(url, { method: 'POST', headers });
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) localStorage.removeItem(TOKEN_KEY);
      throw new Error(body.error || `token request failed (${r.status})`);
    }
    const data = await r.json();
    if (data.cacheKey) { this.cacheKey = data.cacheKey; try { localStorage.setItem('elvar_greet_key', data.cacheKey); } catch {} }
    return data;
  }

  /** Choose how to talk: the main Live model, the fallback Live model, or the standard voice mode (see std-session.js). */
  async connect() {
    const pref = this.voicePref();
    if (pref === 'std') return this.connectStd('設定で通常の音声モードにしています');
    const q = this.quotaState();
    if (pref === 'auto' && q.main) {
      if (!q.fallback) {
        try { return await this.connectLive({ fallback: true }); }
        catch (e) { if (e?.message === 'no_fallback' || QUOTA_RE.test(e?.message || '')) { if (e?.message !== 'no_fallback') this.markQuota('live2'); else lsSet('elvar_live_quota2_until', String(Date.now() + QUOTA_HOURS * 3600_000)); } else throw e; }
      }
      return this.connectStd('Liveの上限に達したため、通常の音声モードで続けます');
    }
    try { return await this.connectLive({}); }
    catch (e) {
      if (!flagActive('elvar_plain_asr') && !QUOTA_RE.test(e?.message || '') && !/unauthorized|アクセストークン/.test(e?.message || '')) {   // maybe the language hints were rejected: retry once without them
        lsSet('elvar_plain_asr', String(Date.now() + 6 * 3600_000));   // 6 h, then the language hints are tried again
        try { return await this.connectLive({}); } catch (e2) { lsSet('elvar_plain_asr', '0'); e = e2; }
      }
      if (pref === 'auto' && QUOTA_RE.test(e?.message || '')) { this.markQuota('live'); return this.connect(); }
      throw e;
    }
  }

  async connectStd(why) {
    this.hud.setState('connecting'); this.hud.setStatusLabel('CONNECTING');
    await this.ensureOutput();
    this.session = new StdSession(this);
    this.mode = 'std'; this.openedAt = performance.now();
    this.hud.setStatusLabel('STD');
    if (why) this.hud.setPlaceholder?.(why);
    this.startLoop(); this.refreshState();
    try { this.onModeChange?.('std'); this.onSessionOpen?.(); } catch {}
  }

  onStdError(e) {
    const msg = e?.quota ? '通常の音声モードも、今日の上限に達しました。' : `通常の音声モードでエラーです：${e?.message || e}`;
    this.hud.setPlaceholder?.(msg);
    try { this.hud.setStatusLabel('STD ERROR'); } catch {}
    // never silent: say it with the browser's own voice (at most once a minute)
    if (!this._stdErrAt || Date.now() - this._stdErrAt > 60000) {
      this._stdErrAt = Date.now();
      try { const u = new SpeechSynthesisUtterance(e?.quota ? '通常モードの上限に達しました。しばらくしてからお試しください。' : '通常モードで問題が起きました。画面のメッセージをご確認ください。'); u.lang = 'ja-JP'; speechSynthesis.speak(u); } catch {}
    }
  }

  async connectLive({ fallback = false } = {}) {
    this.hud.setState('connecting'); this.hud.setStatusLabel('CONNECTING');
    try {
      const { token, model } = await this.fetchToken({ fallback });
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
      await this.ensureOutput();
      const mode = fallback ? 'live2' : 'live';

      this.session = await ai.live.connect({
        model, // session config (persona, voice, transcription) is locked into the token server-side
        callbacks: {
          onopen: () => { this.hud.setStatusLabel('ONLINE'); },
          onmessage: (m) => this.onMessage(m),
          onerror: (e) => {
            console.error('[live] error', e);
            if (this.voicePref() === 'auto' && QUOTA_RE.test(String(e?.message || e || ''))) { this.markQuota(mode); return; }   // the close that follows switches over
            this.hud.setState('error'); this.hud.setStatusLabel('ERROR');
          },
          onclose: (ev) => this.onLiveClosed(ev, mode),
        },
      });
      this.mode = mode; this.openedAt = performance.now();
      this.hud.setStatusLabel(fallback ? 'LIVE-2' : 'ONLINE');
      this.startLoop();
      this.refreshState();
      try { this.onModeChange?.(mode); this.onSessionOpen?.(); } catch {}
    } catch (e) {
      console.error('[live] connect failed', e);
      this.session = null;
      if (!(this.voicePref() === 'auto' && (e?.message === 'no_fallback' || QUOTA_RE.test(e?.message || '')))) {
        this.hud.setState('error'); this.hud.setStatusLabel('ERROR');
        this.hud.setPlaceholder(`接続できませんでした：${e.message}`);
      }
      throw e;
    }
  }

  /** The Live socket closed. If it was the daily limit (or it keeps dying right after opening), carry on in the next mode with the mic still open. */
  onLiveClosed(ev, mode) {
    this.stats.closes++; this.flushTurn();
    const wasMic = this.micOn, now = performance.now();
    const auto = this.voicePref() === 'auto' && !this.stopping;
    const quota = auto && isQuotaClose(ev);   // only an explicit limit message switches modes (a guess from quick closes could wrongly push everything into standard voice)
    this.session = null; this.stopMic(); this.hud.setState('idle'); this.hud.setStatusLabel('OFFLINE');
    if (quota) {
      this.markQuota(mode);
      this.hud.setPlaceholder?.(mode === 'live' ? 'Liveの上限に達しました。切り替えて続けます' : '別のLiveも上限に達しました。通常の音声モードで続けます');
      if (wasMic) { setTimeout(() => { this.startMic().catch((e) => { console.error('[live] resume after quota failed', e); this.onIdle?.(); }); }, 700); return; }
    }
    this.onIdle?.();
  }

  // ---- incoming ----
  onMessage(m) {
    if (m.toolCall?.functionCalls?.length) for (const c of m.toolCall.functionCalls) this.runTool(c);
    if (m.toolCallCancellation?.ids?.length) { for (const id of m.toolCallCancellation.ids) this.cancelledTools.add(id); this.onToolCancel?.(m.toolCallCancellation.ids); }
    if (m.goAway) this.stats.goAway++;   // the server announced it will close this session soon
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      if (this.turnLog.model) { const keepUser = this.turnLog.user; this.turnLog.user = ''; this.flushTurn(); this.turnLog.user = keepUser; }   // the reply that was cut off: keep what was said

      this.stats.interrupted++; if (performance.now() - this.lastMicLoudAt > 700) this.stats.interruptedMicQuiet++;   // cut while the mic was quiet = echo / false trigger, not the owner
      this.stopPlayback(); this.modelText = '';
    }
    if (sc.outputTranscription?.text) this.turnLog.model += sc.outputTranscription.text;   // the assistant's speech as text (not shown on screen)
    if (sc.inputTranscription?.text) {
      if (this.turnLog.model && !this.turnLog.user) { /* assistant spoke first (greeting): keep as its own turn */ this.flushTurn(); }
      this.turnLog.user += sc.inputTranscription.text;
    }
    if (sc.inputTranscription?.text) {
      if (!this.userSpoke) { this.userText = ''; this.modelText = ''; }
      this.userSpoke = true;
      this.userText += sc.inputTranscription.text;
      this.hud.setTranscript(this.userText, 'user');
      try { this.onTranscript?.(this.userText); } catch {}
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) this.enqueueAudio(part.inlineData.data);
    }
    // The assistant's replies are voice only: no on-screen transcript of them (and none is requested from the server).
    if (sc.turnComplete) {
      this.flushTurn();
      this.player?.port.postMessage({ type: 'drain' });
      if (this.recordTo?.length && this.cacheKey) { putGreeting(this.recordLine, { key: this.cacheKey, sr: OUT_RATE, pcm: concatPcm(this.recordTo) }); }
      this.recordTo = null; this.userSpoke = false; this.userText = ''; const cb = this.afterTurn; this.afterTurn = null; cb?.(); }
  }

  /** A finished turn (the owner's words + the assistant's reply as text) goes to the conversation log. */
  flushTurn() {
    const t = this.turnLog; if (!(t.user.trim() || t.model.trim())) { this.turnLog = { user: '', model: '' }; return; }
    this.turnLog = { user: '', model: '' };
    try { this.onTurn?.({ user: t.user.trim(), model: t.model.trim(), at: Date.now() }); } catch (e) { console.warn('[live] onTurn', e?.message ?? e); }
  }

  /** The model asked for a tool (Google). Run it, then give the model the result (it may have to wait for the owner's approval). */
  async runTool(call) {
    this.pendingTools++; this.setState('thinking');
    let response;
    try { response = this.onToolCall ? await this.onToolCall(call) : { error: 'このツールは現在利用できません。' }; }
    catch (e) { response = { error: String(e?.message ?? e) }; }
    finally { this.pendingTools--; }
    if (this.cancelledTools.delete(call.id)) { this.refreshState(); return; }   // the model withdrew it: do not answer
    try { this.session?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response }] }); }
    catch (e) { console.error('[live] sendToolResponse failed', e); }
    this.refreshState();
  }

  enqueueAudio(b64) {
    this.lastModelAudioAt = performance.now();   // real model speech (not local fillers)
    const bin = atob(b64);
    const n = bin.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16; // int16 LE
      f32[i] = v / 32768;
    }
    if (this.recordTo) this.recordTo.push(f32.slice());
    this.pushPcm(f32);
    this.userSpoke = false;
  }

  /** Hand mono 24 kHz float PCM to the output (stretch player, or plain buffered playback as fallback). */
  pushPcm(f32) {
    const n = f32.length;
    { const now = performance.now(); this.playUntil = Math.max(this.playUntil, now) + (n / OUT_RATE) * 1000 / Math.max(1, this.player ? this.speechRate : 1); }
    if (this.player) {
      let pcm = f32;
      const sr = this.outCtx.sampleRate;
      if (sr !== OUT_RATE) { // browser ignored the requested 24 kHz context rate: resample linearly
        const m = Math.round(n * sr / OUT_RATE); pcm = new Float32Array(m);
        for (let i = 0; i < m; i++) { const x = i * OUT_RATE / sr, i0 = Math.floor(x), fr = x - i0; pcm[i] = f32[i0] * (1 - fr) + (f32[Math.min(n - 1, i0 + 1)]) * fr; }
      }
      this.stretchActive = true;
      this.player.port.postMessage({ type: 'pcm', data: pcm }, [pcm.buffer]);
      return;
    }
    const buf = this.outCtx.createBuffer(1, n, OUT_RATE);
    buf.copyToChannel(f32, 0);
    const src = this.outCtx.createBufferSource();
    src.buffer = buf; src.connect(this.outAnalyser);
    const t = Math.max(this.outCtx.currentTime + 0.02, this.nextStart);
    src.start(t); this.nextStart = t + buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); };
  }

  stopPlayback() {
    if (this.player) { this.player.port.postMessage({ type: 'clear' }); this.stretchActive = false; }
    this.playUntil = 0;
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch {} }
    this.sources.clear();
    this.nextStart = 0;
  }

  // ---- mic ----
  async openMic() {
    // Bluetooth glasses/earbuds: asking for echo cancellation puts Android into "call mode", which drops the whole Bluetooth link to
    // narrow-band phone quality (voice AND music). With elvar_mic_phone=1 we capture the phone's own mic plainly, so playback stays hi-fi.
    let phoneMic = false; try { phoneMic = localStorage.getItem('elvar_mic_phone') === '1'; } catch {}
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: phoneMic ? { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inCtx ??= new AudioContext();
    await this.inCtx.resume();
    await this.inCtx.audioWorklet.addModule(new URL('./pcm-capture.worklet.js', import.meta.url));
    const src = this.inCtx.createMediaStreamSource(this.micStream);
    const analyser = this.inCtx.createAnalyser();
    analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
    let gate = 2; try { const g = localStorage.getItem('elvar_gate'); if (g !== null && g !== '') gate = Math.max(0, Math.min(3, Number(g) | 0)); } catch {}
    this.worklet = new AudioWorkletNode(this.inCtx, 'pcm-capture', { processorOptions: { gate } });
    try { this.worklet.port.postMessage({ type: 'speaking', on: !!this.modelSpeaking }); } catch {}
    this.worklet.port.onmessage = (ev) => {
      if (!this.session || !this.micOn) return;
      try {
        this.session.sendRealtimeInput({ audio: { data: b64FromBuffer(ev.data), mimeType: 'audio/pcm;rate=16000' } });
      } catch (e) { console.error('[live] send audio failed', e); }
    };
    src.connect(analyser); src.connect(this.worklet); // worklet output is unused → no mic monitoring
    this.inMeter = new AudioMeter(analyser);
    this.micSrc = src;
  }

  closeMic() {
    try { this.worklet?.port && (this.worklet.port.onmessage = null); this.worklet?.disconnect(); } catch {}
    try { this.micSrc?.disconnect(); } catch {}
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.worklet = null; this.micSrc = null; this.micStream = null; this.inMeter = null;
  }

  // ---- HUD feed (every frame) ----
  startLoop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const rawSpeaking = this.player ? this.stretchActive : this.sources.size > 0;
      const nowT = performance.now();
      if (rawSpeaking) this._speakingSeenAt = nowT;
      const speaking = rawSpeaking || nowT - (this._speakingSeenAt || 0) < 450;   // hold through tiny gaps between chunks: no flip-flopping between the model's and the mic's level (that made the sphere twitch)
      if (speaking !== this.modelSpeaking) { this.modelSpeaking = speaking; this.refreshState(); try { this.worklet?.port.postMessage({ type: 'speaking', on: speaking }); } catch {} }
      if (this.inMeter && this.micOn && this.inMeter.read().level > 0.12) this.lastMicLoudAt = performance.now();
      if (speaking && this.outMeter) {
        const o = this.outMeter.read();
        this._outLvl = (this._outLvl || 0) + (o.level - (this._outLvl || 0)) * (o.level > (this._outLvl || 0) ? 0.5 : 0.18);   // quick up, gentle down
        this.hud.setAudio({ level: this._outLvl, pitch: o.pitch, source: 'model' });
      } else if (speaking) {
        this._outLvl *= 0.9;   // inside the hold window: let the level fade instead of jumping to the mic's
        this.hud.setAudio({ level: this._outLvl || 0, pitch: 0.5, source: 'model' });
      } else if (this.micOn && this.inMeter) {
        const a = this.inMeter.read();
        if (a.level > 0.12) this.lastVoiceAt = performance.now();
        this.hud.setAudio({ ...a, source: 'mic' });
        // Heuristic "thinking": user spoke, then went quiet, model hasn't started answering yet.
        if (this.userSpoke && performance.now() - this.lastVoiceAt > 700 && this.state !== 'thinking') this.setState('thinking');
        else if ((!this.userSpoke || performance.now() - this.lastVoiceAt <= 700) && this.state === 'thinking') this.refreshState();
      } else {
        this.hud.setAudio({ level: 0, pitch: 0.5, source: 'mic' });
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  setState(s) { this.state = s; this.hud.setState(s); }
  refreshState() {
    if (!this.session) { // local greeting before/without a connection
      if (this.modelSpeaking) this.setState('speaking'); else if (this.state === 'speaking') this.setState('idle');
      return;
    }
    this.setState(this.modelSpeaking ? 'speaking' : this.micOn ? 'listening' : 'idle');
  }
}

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
