// Standby listener: keeps the mic open LOCALLY and fires onDoubleClap() when a double clap is heard.
// Privacy: audio is analysed on the audio thread only — nothing is recorded, stored or sent anywhere.
// Browser processing (echo cancel / noise suppression / AGC) is turned OFF because it would erase claps.
export class ClapStandby {
  constructor({ onDoubleClap, onChange, onEvent, sensitivity = 1, debug = false, level = 0 } = {}) {
    this.level = level;
    this.onDoubleClap = onDoubleClap; this.onChange = onChange; this.onEvent = onEvent; this.sensitivity = sensitivity; this.debug = debug;
    this.active = false; this.starting = null;
    this.ctx = null; this.stream = null; this.node = null;
    this.aliveAt = 0; this.watch = 0; this.restarts = 0; this.startedAt = 0; this.lastClapAt = 0;
    this._onVisible = () => { if (this.active && document.visibilityState === 'visible') { if (this.ctx?.state !== 'running') this.ctx?.resume().catch(() => {}); if (Date.now() - this.aliveAt > 4000) this._restart('wake-from-background'); } };
    this._onDevice = () => { if (this.active) this._restart('device-change'); };
  }

  /** @returns {Promise<'on'|'needs-gesture'|'denied'|'error'>} */
  start() {
    if (this.active) return Promise.resolve('on');
    this.starting ??= this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.resume().catch(() => {});
      if (this.ctx.state !== 'running') { this._cleanup(); return 'needs-gesture'; } // autoplay policy: needs a click/key first
      await this.ctx.audioWorklet.addModule(new URL('./clap-detector.worklet.js', import.meta.url));
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'clap-detector', { processorOptions: { sensitivity: this.sensitivity, debug: this.debug, level: this.level } });
      this.node.port.onmessage = (e) => { const m = e.data; if (!m) return; if (m.type === 'alive') { this.aliveAt = Date.now(); return; } if (m.type === 'silent') { this._restart('mic-silent'); return; } if (m.type === 'adapt') this.level = m.level; if (m.type === 'clap') this.lastClapAt = Date.now(); this.onEvent?.(m); if (m.type === 'double-clap') this.onDoubleClap?.(); };
      const mute = this.ctx.createGain(); mute.gain.value = 0; // keep the graph pulling audio without any output
      src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
      const track = this.stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => { this.stop(); this.onChange?.('lost'); });
      track?.addEventListener('mute', () => { clearTimeout(this.muteT); this.muteT = setTimeout(() => { if (this.active) this._restart('track-muted'); }, 3000); });   // another app took the mic / OS muted it
      track?.addEventListener('unmute', () => { clearTimeout(this.muteT); if (this.active) this._restart('track-unmuted'); });
      this.active = true; this.aliveAt = Date.now(); this.startedAt = Date.now(); this.onChange?.('on');
      // Self-healing: the mic can go silent without the browser saying so (Bluetooth glasses connecting, device switch, sleep/resume, suspended audio context).
      this.ctx.onstatechange = () => { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
      navigator.mediaDevices?.addEventListener?.('devicechange', this._onDevice);
      document.addEventListener('visibilitychange', this._onVisible); addEventListener('focus', this._onVisible); addEventListener('online', this._onVisible);
      clearInterval(this.watch);
      this.watch = setInterval(() => {
        if (!this.active) return;
        if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
        if (Date.now() - this.aliveAt > 7000) return this._restart('no-audio');
        const tr = this.stream?.getAudioTracks?.()[0];
        if (tr && tr.readyState !== 'live') return this._restart('track-ended');
        if (Date.now() - this.startedAt > 20 * 60_000 && Date.now() - this.lastClapAt > 10_000) this._restart('refresh');   // a fresh mic + detector every 20 min: nothing can quietly go stale
      }, 3000);
      return 'on';
    } catch (e) {
      this._cleanup();
      return e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'error';
    }
  }

  /** Re-open the mic and the detector (keeps `active` semantics: onChange 'off' is not fired for an internal restart). */
  async _restart(why) {
    if (this.restarting || !this.active) return;
    this.restarting = true; this.restarts++;
    try { this.onEvent?.({ type: 'restart', why, n: this.restarts }); this._cleanup(); this.active = false; const r = await this.start(); if (r !== 'on') this.onChange?.('lost'); }
    finally { this.restarting = false; }
  }

  stop() {
    const was = this.active;
    this.active = false;
    clearInterval(this.watch); clearTimeout(this.muteT); navigator.mediaDevices?.removeEventListener?.('devicechange', this._onDevice); document.removeEventListener('visibilitychange', this._onVisible); removeEventListener('focus', this._onVisible); removeEventListener('online', this._onVisible);
    this._cleanup();
    if (was) this.onChange?.('off');
  }

  _cleanup() {
    try { this.node?.port && (this.node.port.onmessage = null); this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.ctx?.close(); } catch {}
    this.node = null; this.stream = null; this.ctx = null;
  }
}

/** "All systems online. Good Morning, sir." with the part of day from the local clock. */
export function greetingLine(now = new Date()) {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? 'Morning' : h >= 12 && h < 18 ? 'Afternoon' : 'Evening';
  return `All systems online. Good ${part}, sir.`;
}
