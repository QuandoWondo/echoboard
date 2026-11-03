'use strict';
/* Voice changer: classic real-time effects built from Web Audio nodes, all on this computer.
   Usage: const fx = new VoiceFX(ctx); source.connect(fx.input); fx.output.connect(dest);
          fx.setEffect('robot'); fx.setMix(0.8); fx.setEnabled(true); */

const VOICE_EFFECTS = [
  { id: 'deep', name: 'Deep', icon: '▼' },
  { id: 'demon', name: 'Demon', icon: '☠' },
  { id: 'chipmunk', name: 'Chipmunk', icon: '▲' },
  { id: 'robot', name: 'Robot', icon: '⚙' },
  { id: 'radio', name: 'Radio', icon: '📻' },
  { id: 'megaphone', name: 'Megaphone', icon: '📣' },
  { id: 'cave', name: 'Cave', icon: '⛰' },
  { id: 'echo', name: 'Echo', icon: '◎' },
  { id: 'alien', name: 'Alien', icon: '👽' },
  { id: 'underwater', name: 'Underwater', icon: '〰' },
];

class VoiceFX {
  constructor(ctx, { pitchAvailable = true } = {}) {
    this.ctx = ctx;
    this.pitchAvailable = pitchAvailable;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.nodes = [];
    this.effect = 'deep';
    this.mix = 1;
    this.enabled = false;
    this.apply();
  }

  setEffect(id) { if (VOICE_EFFECTS.some((e) => e.id === id)) { this.effect = id; this.build(); this.apply(); } }
  setMix(m) { this.mix = Math.max(0, Math.min(1, Number(m) || 0)); this.apply(); }
  setEnabled(on) {
    const was = this.enabled;
    this.enabled = !!on;
    if (this.enabled && !was) this.build();
    if (!this.enabled) this.teardown();
    this.apply();
  }

  apply() {
    const t = this.ctx.currentTime;
    const wet = this.enabled ? this.mix : 0;
    // Pitch effects sound strange with the original voice underneath, so they replace it fully.
    const dry = this.enabled ? (this.isPitchEffect() ? 1 - this.mix : 1 - this.mix * 0.85) : 1;
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(Math.max(0, dry), t, 0.02);
  }

  isPitchEffect() { return ['deep', 'demon', 'chipmunk', 'alien'].includes(this.effect); }

  teardown() {
    for (const n of this.nodes) {
      try { if (n.stop) n.stop(); } catch { /* ignore */ }
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.nodes = [];
    try { this.input.disconnect(); } catch { /* ignore */ }
    this.input.connect(this.dry);
  }

  /* ---- building blocks ---- */
  keep(n) { this.nodes.push(n); return n; }
  gain(v) { const g = this.keep(this.ctx.createGain()); g.gain.value = v; return g; }
  filter(type, freq, q = 0.7, gainDb = 0) {
    const f = this.keep(this.ctx.createBiquadFilter());
    f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gainDb;
    return f;
  }
  osc(freq, type = 'sine') { const o = this.keep(this.ctx.createOscillator()); o.type = type; o.frequency.value = freq; o.start(); return o; }
  shaper(amount) {
    const s = this.keep(this.ctx.createWaveShaper());
    const n = 2048, curve = new Float32Array(n), k = amount;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    s.curve = curve; s.oversample = '2x';
    return s;
  }
  pitch(ratio) {
    if (!this.pitchAvailable) return this.gain(1);
    const p = this.keep(new AudioWorkletNode(this.ctx, 'echo-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }));
    p.parameters.get('ratio').value = ratio;
    return p;
  }
  delay(sec, max = 1) { const d = this.keep(this.ctx.createDelay(max)); d.delayTime.value = sec; return d; }
  reverb(seconds, decay) {
    const c = this.keep(this.ctx.createConvolver());
    const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
    const ir = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    c.buffer = ir;
    return c;
  }
  chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes; }
  // Vibrato: modulate a short delay with an LFO
  vibrato(rateHz, depthSec) {
    const d = this.delay(0.01, 0.1);
    const lfo = this.osc(rateHz);
    const depth = this.gain(depthSec);
    lfo.connect(depth); depth.connect(d.delayTime);
    return d;
  }

  build() {
    this.teardown();
    if (!this.enabled) return;
    const i = this.input, w = this.wet;
    switch (this.effect) {
      case 'deep':
        this.chain(i, this.pitch(0.74), this.filter('lowshelf', 220, 0.7, 4), w);
        break;
      case 'demon': {
        this.chain(i, this.pitch(0.6), this.shaper(6), this.filter('lowshelf', 180, 0.7, 7), this.filter('lowpass', 4200), this.gain(0.7), w);
        break;
      }
      case 'chipmunk':
        this.chain(i, this.pitch(1.7), this.filter('highpass', 180), w);
        break;
      case 'robot': {
        // Ring modulation + a short metallic comb
        const ring = this.gain(0);
        const carrier = this.osc(55, 'sine');
        carrier.connect(ring.gain);
        const comb = this.delay(0.008, 0.05), fb = this.gain(0.55);
        this.chain(i, this.filter('highpass', 150), ring, comb, fb, comb);
        comb.connect(this.gain(1.4)).connect(w);
        break;
      }
      case 'radio':
        this.chain(i, this.filter('highpass', 650, 0.9), this.filter('lowpass', 2800, 0.9), this.shaper(25), this.gain(0.55), w);
        break;
      case 'megaphone':
        this.chain(i, this.filter('bandpass', 1700, 0.9), this.shaper(60), this.filter('highpass', 450), this.gain(0.6), w);
        break;
      case 'cave': {
        const rev = this.reverb(3.2, 2.2);
        this.chain(i, rev, this.gain(1.6), w);
        i.connect(this.gain(0.6)).connect(w);
        break;
      }
      case 'echo': {
        const d = this.delay(0.3), fb = this.gain(0.45), tone = this.filter('lowpass', 3000);
        this.chain(i, d, tone, fb, d);
        tone.connect(w);
        i.connect(this.gain(0.9)).connect(w);
        break;
      }
      case 'alien':
        this.chain(i, this.pitch(1.25), this.vibrato(7, 0.0025), this.filter('peaking', 2500, 1.5, 5), w);
        break;
      case 'underwater': {
        const lp = this.filter('lowpass', 650, 3);
        const lfo = this.osc(0.6), depth = this.gain(350);
        lfo.connect(depth); depth.connect(lp.frequency);
        this.chain(i, this.vibrato(3, 0.003), lp, this.gain(1.3), w);
        break;
      }
      default:
        i.connect(w);
    }
  }
}

if (typeof module !== 'undefined') module.exports = { VoiceFX, VOICE_EFFECTS };
