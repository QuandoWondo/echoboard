/* Real-time audio processors for Echo Board (run on the audio thread, all local). */

// Pitch shifter: two overlapping read heads sweep through a short delay line and are
// cross-faded, so the voice plays faster/slower without changing timing. ~20 ms of latency.
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.grain = 2048;            // samples per sweep (~43 ms at 48 kHz)
    this.size = 8192;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
  }

  read(delay) {
    let pos = this.w - delay;
    while (pos < 0) pos += this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i % this.size];
    const b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const inp = inputs[0] && inputs[0][0];
    const ratio = params.ratio[0];
    const N = this.grain;
    const o = out[0];
    for (let i = 0; i < o.length; i++) {
      this.buf[this.w] = inp ? inp[i] : 0;
      this.phase += 1 - ratio;
      if (this.phase >= N) this.phase -= N;
      if (this.phase < 0) this.phase += N;
      const d1 = this.phase + 2;
      const d2 = ((this.phase + N / 2) % N) + 2;
      const g1 = Math.sin(Math.PI * (d1 - 2) / N);
      const g2 = Math.sin(Math.PI * (d2 - 2) / N);
      o[i] = this.read(d1) * g1 + this.read(d2) * g2;
      this.w = (this.w + 1) % this.size;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    return true;
  }
}
registerProcessor('echo-pitch', PitchShifter);

// Replay tap: mixes its input to mono and hands it to the app in ~100 ms blocks.
// Nothing is stored here; the app keeps only the last few seconds, in memory.
class ReplayTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4800);
    this.n = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data && 'on' in e.data) this.on = !!e.data.on; };
  }

  process(inputs) {
    const inp = inputs[0];
    if (!this.on || !inp || !inp.length) return true;
    const ch = inp.length;
    const len = inp[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += inp[c][i];
      this.block[this.n++] = v / ch;
      if (this.n === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(4800);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('echo-replay-tap', ReplayTap);
