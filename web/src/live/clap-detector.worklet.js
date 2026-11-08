// AudioWorklet: detects a DOUBLE CLAP entirely on the audio thread (no network, no recording).
// Runs fine while the tab is in the background (not subject to main-thread timer throttling).
//
// A clap = short broadband transient: 2nd-order high-pass (~1.2 kHz) block-RMS jumps above max(absolute, ratio*noise floor)
// and then DECAYS fast (within 50 ms it must fall below 30 % of its peak) -> rejects speech, music, knocks.
// Double clap = two claps 0.12-0.75 s apart, preceded by >=0.5 s and followed by 0.4 s with no other onset
// (rejects the tail of speech, applause and typing bursts).
class ClapDetector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    const sens = o.sensitivity > 0 ? o.sensitivity : 1;
    this.baseAbs = 0.0055 / sens; this.absThresh = this.baseAbs;   // high-passed block RMS needed for an onset
    this.ratio = 3.4;                     // ...and this multiple of the running noise floor
    this.debug = !!o.debug; this.dbgBlocks = 0; this.dbgMax = 0;
    const rc = 1 / (2 * Math.PI * 1200);
    this.a = rc / (rc + 1 / sampleRate);  // 1st-order high-pass coefficient
    this.px = 0; this.py = 0; this.qx = 0; this.qy = 0; // two cascaded high-pass sections
    this.lpA = 1 - Math.exp(-2 * Math.PI * 600 / sampleRate); this.lpB = 1 - Math.exp(-2 * Math.PI * 40 / sampleRate); this.l1 = 0; this.l2 = 0;   // low band (40-600 Hz): thuds
    this.lastOnsetT = -10;
    this.blockSec = 128 / sampleRate;
    this.checkBlocks = Math.round(0.04 / this.blockSec);
    this.refractoryBlocks = Math.round(0.04 / this.blockSec);
    this.floor = 0.002; this.lastAlive = -10; this.zeroSince = -1; this.lastSilentMsg = -10;
    this.env = 0;                         // decaying peak envelope: a NEW onset must jump above it (ignores reverb tails)
    this.envDecay = Math.exp(-(128 / sampleRate) / 0.06);
    this.verify = null;                   // { onsetT, peak, blocks, late: [] }
    this.refractory = 0;
    this.lastClapT = -10;
    this.pendingT = -1;                   // second clap waiting for its quiet period
    this.cooldownUntil = 0;
    this.minWidth = 0.009; this.lastPeak = 0;
    this.gapMin = 0.09; this.gapMax = 0.85; this.quiet = 0.72; this.cooldown = 3; this.pairPeak = 0;
    this.thudMax = 2.8; this.lateMax = 0.4; this.simLo = 0.4; this.simHi = 2.5; this.calmBefore = 0.9;
    // Self-tuning: if the owner keeps trying and failing (claps seen, no double clap), the detector gets more tolerant step by step (levels 0..2),
    // and relaxes again one step per 15 minutes without a failed attempt. Failures are rare when nobody is clapping, so it does not drift on its own.
    this.level = 0; this.failTimes = []; this.levelAt = 0; this.expectEnd = -1;
    if (o.level > 0) this.setLevel(Math.min(2, o.level | 0), 0, true);   // the page remembers the learned level across conversations
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const t = currentTime;
    const n = ch.length;
    // A muted / taken-over microphone delivers exact zeros (a live mic always has some noise): tell the page, which re-opens it.
    let nz = 0; for (let i = 0; i < n; i += 8) if (ch[i] !== 0) { nz = 1; break; }
    if (nz) this.zeroSince = -1; else if (this.zeroSince < 0) this.zeroSince = t;
    if (this.zeroSince >= 0 && t - this.zeroSince > 4 && t - this.lastSilentMsg > 4) { this.lastSilentMsg = t; this.port.postMessage({ type: 'silent' }); }
    if (t - this.lastAlive > 2) { this.lastAlive = t; this.port.postMessage({ type: 'alive' }); }   // heartbeat: the page restarts the listener if this stops
    let sum = 0, lsum = 0, px = this.px, py = this.py, qx = this.qx, qy = this.qy, l1 = this.l1, l2 = this.l2;
    const a = this.a;
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      const y = a * (py + x - px); px = x; py = y;     // section 1
      const z = a * (qy + y - qx); qx = y; qy = z;      // section 2 (12 dB/oct: low thumps/knocks vanish)
      sum += z * z;
      l1 += (x - l1) * this.lpA; l2 += (x - l2) * this.lpB; const lo = l1 - l2; lsum += lo * lo;
    }
    this.px = px; this.py = py; this.qx = qx; this.qy = qy; this.l1 = l1; this.l2 = l2;
    const rms = Math.sqrt(sum / n), lrms = Math.sqrt(lsum / n);

    // fire a pending double clap once the quiet window has passed
    if (this.pendingT > 0 && t - this.pendingT >= this.quiet) {
      this.pendingT = -1; this.lastClapT = -10; this.cooldownUntil = t + this.cooldown;
      this.port.postMessage({ type: 'double-clap' });
      this.failTimes = [];
    }

    if (this.refractory > 0) this.refractory--;
    if (this.lastClapT > 0 && this.pendingT < 0 && t - this.lastClapT > this.gapMax + 0.15) { this.lastClapT = -10; this.fail(t); }   // a single clap that never got its partner
    if (this.level > 0 && t - this.levelAt > 300) this.setLevel(this.level - 1, t);                                              // 15 minutes without a failed attempt: one step back toward normal

    if (this.debug) { // live meter for ?clapdebug=1 (~4 messages/s)
      this.dbgMax = Math.max(this.dbgMax, rms);
      if (++this.dbgBlocks >= Math.round(0.25 / this.blockSec)) {
        this.port.postMessage({ type: 'level', rms: this.dbgMax, floor: this.floor, thr: Math.max(this.absThresh, this.floor * this.ratio) });
        this.dbgBlocks = 0; this.dbgMax = 0;
      }
    }

    if (!this.verify) {
      // noise floor: fall fast, rise slowly, only while nothing is happening
      if (this.refractory <= 0) {
        this.floor += (rms - this.floor) * (rms < this.floor ? 0.05 : 0.003);
        this.floor = Math.min(0.02, Math.max(0.0005, this.floor));
      }
      const thr = Math.max(this.absThresh, this.floor * this.ratio);
      if (this.refractory <= 0 && rms > thr && rms > this.env * 2) {
        if (this.pendingT > 0) {
          // a 3rd sound after a double clap -> applause / speech / typing: cancel. But only a LOUD one: the room's echo of the claps, a rustle,
          // an "OK!" or a laugh right after clapping are much softer than the claps themselves and must not cancel the wake-up.
          if (rms < this.pairPeak * 0.4) { this.env = Math.max(this.env, rms); this.lastOnsetT = t; this.floor = this.floor; }
          else {
            this.pendingT = -1; this.lastClapT = -10; this.cooldownUntil = t + 1;
            this.port.postMessage({ type: 'rejected', reason: 'too-many' });
          }
        } else if (t >= this.cooldownUntil) {
          this.verify = { onsetT: t, peak: rms, lf: lrms, blocks: 0, late: [], env: [rms], since: t - this.lastOnsetT };
        }
        this.lastOnsetT = t;
      }
    } else {
      const v = this.verify;
      v.blocks++; v.env.push(rms);
      if (v.blocks <= 4) { v.peak = Math.max(v.peak, rms); v.lf = Math.max(v.lf, lrms); }
      if (v.blocks > this.checkBlocks - 3) v.late.push(rms);
      if (v.blocks >= this.checkBlocks) {
        const late = Math.max(...v.late);
        this.verify = null;
        this.refractory = this.refractoryBlocks;
        // Key clicks are very short (a few ms) and sharp; a hand clap keeps ringing for ~10-30 ms. Measure how long it stays loud.
        const wide = v.env.filter((x) => x >= v.peak * 0.18).length * this.blockSec >= this.minWidth;
        const ratio = v.lf / Math.max(1e-9, v.peak);   // low band / high band at the onset: a hand clap is bright (small), a desk knock / key thump / door is dull (large)
        if (ratio > this.thudMax) { this.port.postMessage({ type: 'rejected', reason: 'thud', ratio }); }
        else if (late >= v.peak * this.lateMax) { this.port.postMessage({ type: 'rejected', reason: 'sustained', peak: v.peak }); if (this.lastClapT > 0) this.fail(t); }
        else if (!wide) this.port.postMessage({ type: 'rejected', reason: 'too-short', peak: v.peak });   // keyboard / tick
        else this.onClap(v.onsetT, v.since, v.peak, ratio);
      }
    }
    this.env = Math.max(rms, this.env * this.envDecay);
    return true;
  }

  fail(t) {
    this.failTimes = this.failTimes.filter((x) => t - x < 60); this.failTimes.push(t); this.levelAt = t;
    if (this.failTimes.length >= 4 && this.level < 2) { this.failTimes = []; this.setLevel(this.level + 1, t); }
  }
  setLevel(n, t, silent = false) {
    this.level = n; this.levelAt = t;
    // Levels only make the detector hear QUIETER claps. The structure checks (calm before/after, pair similarity, gap) never loosen:
    // those are what keep typing, mouse clicks and room noise from looking like a double clap.
    const L = [[1, 3.4, 0.4], [0.65, 2.9, 0.46], [0.45, 2.5, 0.52]][Math.min(n, 2)];
    this.absThresh = this.baseAbs * L[0]; this.ratio = L[1]; this.lateMax = L[2];
    if (!silent) this.port.postMessage({ type: 'adapt', level: n });
  }

  onClap(t, since, peak, ratio) {
    this.port.postMessage({ type: 'clap', ratio });
    const gap = t - this.lastClapT;
    const similar = this.lastPeak > 0 && peak / this.lastPeak > this.simLo && peak / this.lastPeak < this.simHi;   // two claps are about equally loud; a loud key + a soft one is not
    if (gap >= this.gapMin && gap <= this.gapMax && similar) { this.pendingT = t; this.pairPeak = Math.max(peak, this.lastPeak); this.port.postMessage({ type: 'pending' }); } // 2nd clap: lets the app warm up while the quiet window runs
    else if (since >= this.calmBefore) { this.lastClapT = t; this.lastPeak = peak; }                                 // 1st clap: must follow >=0.5 s of calm
    else { this.lastClapT = -10; this.lastPeak = 0; }                          // part of a busy stretch (speech/applause)
  }
}
registerProcessor('clap-detector', ClapDetector);
