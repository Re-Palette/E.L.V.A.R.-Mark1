// AudioWorklet: plays streamed mono PCM FASTER (or 1x) WITHOUT raising the pitch (WSOLA time-scale modification).
//
// Main thread messages -> { type:'pcm', data:Float32Array } (already at the context sample rate)
//                          { type:'drain' }  turn finished: flush the tail then go idle
//                          { type:'clear' }  barge-in: drop everything immediately
//                          { type:'rate', value:number }  target speed (1 = normal, 2 = twice as fast)
// Worklet -> main        -> { type:'active', on:boolean }  true while audio is queued/playing (drives the HUD "speaking" state)
//
// WSOLA: 30 ms Hann frames, 50 % synthesis overlap; each frame is taken from the input near the ideal (rate-scaled)
// position, choosing the offset (+-10 ms) whose start best continues the previous frame (normalised cross-correlation),
// so waveforms stay phase-aligned. The effective speed eases down to 1x when little audio is buffered (so a
// real-time stream does not stutter) and goes up to the target when a backlog exists.
class StretchPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.rate = Math.max(1, Math.min(3, +o.rate || 2));
    this.N = Math.round(0.030 * sampleRate) & ~1;   // frame length (even)
    this.HS = this.N / 2;                            // synthesis hop
    this.D = Math.round(0.010 * sampleRate);         // search radius
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N); // periodic Hann: 50 % overlap sums to 1
    this.cap = Math.round(sampleRate * 40);
    this.inBuf = new Float32Array(this.cap + this.N * 2);
    this.fifo = new Float32Array(Math.max(8192, this.N * 8)); this.fHead = 0; this.fLen = 0;
    this.ola = new Float32Array(this.N);
    this.rEff = 1;
    this.prebuffer = Math.round(0.12 * sampleRate);
    this.resetStream();
    this.activeSent = false;
    this.idleFrames = 0; this.starved = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  resetStream() {
    this.inBuf.fill(0); this.inLen = 0; this.pos = 0; this.prevS = 0;
    this.started = false; this.draining = false;
    this.ola.fill(0);
  }

  onMessage(m) {
    if (!m) return;
    if (m.type === 'pcm') {
      const d = m.data;
      if (this.inLen + d.length > this.cap) return;       // 40 s guard
      this.inBuf.set(d, this.inLen); this.inLen += d.length;
      this.draining = false; this.idleFrames = 0;
    } else if (m.type === 'drain') this.draining = true;
    else if (m.type === 'clear') { this.resetStream(); this.fHead = 0; this.fLen = 0; }
    else if (m.type === 'prebuffer') this.prebuffer = Math.round(Math.max(0.05, Math.min(0.8, (+m.ms || 120) / 1000)) * sampleRate);
    else if (m.type === 'rate') this.rate = Math.max(1, Math.min(3, +m.value || 1));
  }

  fifoPush(src, from, to) {
    const cap = this.fifo.length;
    for (let i = from; i < to; i++) { this.fifo[(this.fHead + this.fLen) % cap] = src[i]; this.fLen++; }
  }

  /** Build one synthesis frame. Returns false when it must wait for more input (or there is nothing to do). */
  produceFrame() {
    const { N, HS, D, win, ola, inBuf } = this;
    if (!this.started) {
      if (this.inLen < this.prebuffer && !this.draining) return false;     // initial cushion
      if (this.inLen === 0) { this.draining = false; return false; }
    }
    const ahead = this.inLen - Math.max(0, Math.floor(this.pos));
    const target = 1 + (this.rate - 1) * Math.min(1, ahead / (0.2 * sampleRate));
    this.rEff += (target - this.rEff) * 0.1;

    const a = Math.round(this.pos);
    if (this.draining && a >= this.inLen - 1) {                              // nothing left: flush the overlap tail and stop
      if (this.started) this.fifoPush(ola, 0, HS);
      this.resetStream();
      return true;
    }
    if (!this.draining && this.inLen < a + D + N) return false;              // wait for look-ahead data

    let s;
    if (!this.started) { s = 0; this.started = true; }
    else {
      const tgt = this.prevS + HS;                                           // where the previous frame would naturally continue
      let best = -Infinity; s = Math.max(0, a);
      const lo = Math.max(0, a - D), hi = a + D;
      for (let c = lo; c <= hi; c += 1) {
        let cc = 0, ee = 1e-9;
        for (let i = 0; i < HS; i += 2) { const v = inBuf[c + i]; cc += v * inBuf[tgt + i]; ee += v * v; }
        const score = cc / Math.sqrt(ee);
        if (score > best) { best = score; s = c; }
      }
    }
    for (let i = 0; i < N; i++) ola[i] += win[i] * inBuf[s + i];
    this.fifoPush(ola, 0, HS);
    ola.copyWithin(0, HS, N); ola.fill(0, HS, N);
    this.prevS = s;
    this.pos += this.rEff * HS;

    // drop consumed input now and then
    const cut = Math.min(Math.floor(this.pos) - D - 2 * N, this.prevS - 1);
    if (cut > sampleRate * 2) {
      this.inBuf.copyWithin(0, cut, this.inLen); this.inBuf.fill(0, this.inLen - cut, this.inLen);
      this.inLen -= cut; this.pos -= cut; this.prevS -= cut;
    }
    return true;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    // no new audio for ~1 s while idle-ish: treat as end of turn (in case 'drain' was never sent)
    if (this.started && this.fLen < n) { if (++this.idleFrames > (sampleRate / n) * 1.0) this.draining = true; } else this.idleFrames = 0;

    while (this.fLen < n + this.HS && this.produceFrame()) { /* fill */ }
    // starved while a reply is playing (network jitter / a busy main thread): tell the page once per episode so it can raise the cushion
    if (this.started && !this.draining && this.fLen < n) { if (++this.starved === 12) this.port.postMessage({ type: 'underrun' }); } else this.starved = 0;
    const cap = this.fifo.length;
    const take = Math.min(n, this.fLen);
    for (let i = 0; i < take; i++) ch0[i] = this.fifo[(this.fHead + i) % cap];
    for (let i = take; i < n; i++) ch0[i] = 0;
    this.fHead = (this.fHead + take) % cap; this.fLen -= take;
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

    const on = this.started || this.fLen > 0 || this.inLen > 0;
    if (on !== this.activeSent) { this.activeSent = on; this.port.postMessage({ type: 'active', on }); }
    return true;
  }
}
registerProcessor('stretch-player', StretchPlayer);
