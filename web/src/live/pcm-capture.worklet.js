// AudioWorklet: capture mic, resample (linear) to 16 kHz mono, emit Int16 PCM chunks (~32 ms).
// Noise gate (optional, processorOptions.gate 0..3): background sounds / distant voices / TV are replaced by digital silence so the
// server's speech detector is not triggered by them. It adapts to the room (running noise floor), looks 160 ms AHEAD (a delay line) so the
// start of a sentence is never clipped, and stays open 600 ms after the last loud block so pauses and trailing words survive.
// Fail-open: if the room is always louder than the threshold, everything passes (nothing is ever cut by a stuck gate).
// While the assistant is speaking (main thread tells us), the gate is MUCH stricter: its own voice coming back through the speaker must not look
// like the owner talking (the server would cut the reply off mid-sentence). A deliberate interruption still works: speak clearly and keep going ~80 ms.
const SPEAKING = { abs: 0.05, mult: 6, sustainSec: 0.08, hangSec: 0.3 };
const GATE = [null, { abs: 0.010, mult: 2.5 }, { abs: 0.018, mult: 3.5 }, { abs: 0.030, mult: 4.5 }];
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.P = GATE[o.gate === undefined ? 2 : Math.max(0, Math.min(3, o.gate | 0))];
    this.floor = 0.003; this.hang = 0; this.q = []; this.speaking = false; this.sust = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'speaking') { this.speaking = !!e.data.on; this.sust = 0; } };
    this.hangBlocks = Math.ceil(0.6 * sampleRate / 128); this.laBlocks = Math.ceil(0.16 * sampleRate / 128);
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.pos = 0;                    // fractional read position into the carried buffer
    this.carry = new Float32Array(0);
    this.out = new Int16Array(512);
    this.outLen = 0;
  }
  gate(ch) {
    if (!this.P) return ch;
    let sum = 0; for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    const sp = this.speaking, T = sp ? { abs: Math.max(this.P.abs, SPEAKING.abs), mult: Math.max(this.P.mult, SPEAKING.mult) } : this.P;
    let loud = rms > Math.max(T.abs, this.floor * T.mult);
    if (sp) { this.sust = loud ? this.sust + 1 : 0; loud = loud && this.sust >= Math.ceil(SPEAKING.sustainSec * sampleRate / 128); }   // must stay loud for ~80 ms
    else this.sust = 0;
    if (!loud && this.hang === 0) { this.floor += (rms - this.floor) * (rms < this.floor ? 0.05 : 0.004); this.floor = Math.min(0.03, Math.max(0.0005, this.floor)); }
    const e = { x: ch.slice(0), pass: false };
    if (loud) { for (const b of this.q) b.pass = true; e.pass = true; this.hang = sp ? Math.ceil(SPEAKING.hangSec * sampleRate / 128) : this.hangBlocks; }
    else if (this.hang > 0) { e.pass = true; this.hang--; }
    this.q.push(e);
    if (this.q.length <= this.laBlocks) return new Float32Array(ch.length);   // filling the delay line
    const o = this.q.shift();
    return o.pass ? o.x : new Float32Array(o.x.length);
  }
  process(inputs) {
    const raw = inputs[0] && inputs[0][0];
    if (!raw) return true;
    const ch = this.gate(raw);
    const buf = new Float32Array(this.carry.length + ch.length);
    buf.set(this.carry); buf.set(ch, this.carry.length);
    let pos = this.pos;
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos), f = pos - i;
      const s = Math.max(-1, Math.min(1, buf[i] * (1 - f) + buf[i + 1] * f));
      this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.outLen === this.out.length) {
        const chunk = this.out.slice(0);
        this.port.postMessage(chunk.buffer, [chunk.buffer]);
        this.outLen = 0;
      }
      pos += this.ratio;
    }
    const keepFrom = Math.floor(pos);
    this.carry = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
