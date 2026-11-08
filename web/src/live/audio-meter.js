// Turns an AnalyserNode into { level 0..1, pitch 0..1 } for the sphere.
// level = loudness (RMS, softly companded); pitch = normalized spectral centroid (brightness/intonation proxy).
export class AudioMeter {
  constructor(analyser) {
    this.analyser = analyser;
    this.time = new Float32Array(analyser.fftSize);
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.pitchSmooth = 0.5;
  }
  read() {
    const a = this.analyser;
    a.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);
    const level = Math.min(1, Math.pow(rms * 5, 0.7)); // ~-30 dBFS speech ≈ 0.5

    let num = 0, den = 0;
    a.getByteFrequencyData(this.freq);
    const hzPerBin = a.context.sampleRate / a.fftSize;
    for (let i = 1; i < this.freq.length; i++) {
      const hz = i * hzPerBin;
      if (hz > 4000) break;
      num += hz * this.freq[i]; den += this.freq[i];
    }
    if (den > 400 && level > 0.04) {
      const centroid = num / den;                       // ~300–3000 Hz for voice
      const p = Math.min(1, Math.max(0, (centroid - 300) / 2200));
      this.pitchSmooth += (p - this.pitchSmooth) * 0.25;
    } else {
      this.pitchSmooth += (0.5 - this.pitchSmooth) * 0.05; // relax to neutral in silence
    }
    return { level, pitch: this.pitchSmooth };
  }
}
