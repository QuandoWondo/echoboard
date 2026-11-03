'use strict';

/* ============================================================
   Echo Board — renderer
   - Engine: mixes mic + clips into the virtual cable, and clips
     into your headphones (two AudioContexts, one per device).
   - MIDI: Launchpad presses trigger pads; pad colors are sent
     back as LED messages (Programmer mode).
   ============================================================ */

const COLORS = [
  { id: 'red',    hex: '#ff453a', lp: 5 },
  { id: 'orange', hex: '#ff9f0a', lp: 9 },
  { id: 'yellow', hex: '#ffd60a', lp: 13 },
  { id: 'green',  hex: '#30d158', lp: 21 },
  { id: 'cyan',   hex: '#40c8e0', lp: 37 },
  { id: 'blue',   hex: '#1d9bf0', lp: 45 },
  { id: 'purple', hex: '#bf5af2', lp: 49 },
  { id: 'pink',   hex: '#ff375f', lp: 53 },
  { id: 'white',  hex: '#e5e5ea', lp: 3 },
];
const colorById = (id) => COLORS.find((c) => c.id === id) || COLORS[5];

const CABLE_OUT_RE = /cable input|blackhole|vb-audio|vb-cable|voicemeeter input/i; // devices we send INTO
const CABLE_MIC_RE = /cable output|blackhole|vb-cable|voicemeeter out/i;            // the cable's mic side (never use as your mic)
const LAUNCHPAD_RE = /launchpad|lpmini|lpx|lppro/i;

const DEFAULT_SETTINGS = {
  midiIn: '',        // port name ('' = auto, 'none' = off)
  midiOut: '',
  micDevice: '',     // '' = system default
  cableDevice: null, // null = not chosen yet (auto-detect), '' = none
  monitorDevice: '', // '' = system default
  micEnabled: true,
  micVolume: 1,
  masterVolume: 0.8,
  monitorVolume: 0.8,
  cableSetupShown: false,
  tts: { provider: 'kokoro', voice: { kokoro: 'af_heart', system: '', openai: 'alloy', elevenlabs: '' }, style: '', v: 2 },
};
const TTS_NAMES = { kokoro: 'Free AI', system: 'Built-in', openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const NEEDS_KEY = new Set(['openai', 'elevenlabs']);
const TTS_MAX = 1000;

const $ = (s) => document.querySelector(s);
// `echo` (the bridge to the desktop side) is provided globally by preload.js; don't redeclare it.

const state = { pads: [], settings: { ...DEFAULT_SETTINGS }, stopAllTrigger: null };
let selected = 0;
let learnTarget = null; // pad index or 'stopall'
const missing = new Set();
const padEls = [];
let triggerMap = new Map();
let audioDevices = { ins: [], outs: [] };

// Pads are indexed bottom-left = 0, top-right = 63, matching Launchpad Programmer mode
// where the note is (row+1)*10 + (col+1).
function defaultPad(i) {
  const r = Math.floor(i / 8), c = i % 8;
  return { name: '', file: null, volume: 0.8, color: 'blue', mode: 'oneshot', choke: false,
           trigger: { type: 'note', num: (r + 1) * 10 + (c + 1) } };
}
const padLabel = (i) => String.fromCharCode(65 + (7 - Math.floor(i / 8))) + ((i % 8) + 1);
const trigKey = (t) => (t ? t.type + ':' + t.num : '');
const trigText = (t) => (t ? (t.type === 'cc' ? 'CC ' : 'Note ') + t.num : 'Not set');

function rebuildTriggerMap() {
  triggerMap = new Map();
  state.pads.forEach((p, i) => { if (p.trigger) triggerMap.set(trigKey(p.trigger), i); });
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    echo.saveConfig({ version: 1, pads: state.pads, settings: state.settings, stopAllTrigger: state.stopAllTrigger })
      .catch((e) => console.error('save failed', e));
  }, 250);
}

const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- Audio engine ---------------- */

async function setSink(ctx, id) {
  if (!ctx.setSinkId) return !id;
  try { await ctx.setSinkId(id || ''); return true; }
  catch (e) { console.warn('setSinkId failed for', id, e); return false; }
}

class Engine {
  constructor() {
    this.main = null;   // -> virtual cable (what friends hear)
    this.mon = null;    // -> your headphones
    this.voices = new Map();
    this.buffers = new Map();
    this.mic = null;
    this.routeOk = false;
    this.micError = null;
    this.onVoiceEnd = () => {};
  }

  async start(s, dev = { mic: s.micDevice, monitor: s.monitorDevice }) {
    await this.shutdown();
    // Voice-chat mix: 48 kHz to match Discord and VB-CABLE, with a little more buffer than the
    // headphone mix so it doesn't crackle when the computer is busy (e.g. a game is running).
    this.main = new AudioContext({ latencyHint: 'balanced', sampleRate: 48000 });
    this.mon = new AudioContext({ latencyHint: 'interactive' });
    this.routeOk = !!s.cableDevice && (await setSink(this.main, s.cableDevice));
    await setSink(this.mon, dev.monitor);

    // Everything friends hear goes through one limiter, so voice + a loud sound never clip.
    this.mixBus = this.main.createGain();
    this.limiter = this.main.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    const ceiling = this.main.createGain();
    ceiling.gain.value = 0.9;
    this.meter = this.main.createAnalyser();
    this.meter.fftSize = 1024;
    this.mixBus.connect(this.limiter);
    this.limiter.connect(ceiling);
    ceiling.connect(this.main.destination);
    this.mixBus.connect(this.meter);
    this.mainOut = this.main.createGain();
    this.mainOut.connect(this.mixBus);
    this.monOut = this.mon.createGain();
    this.monOut.connect(this.mon.destination);
    this.micGain = this.main.createGain();
    this.micGain.connect(this.mixBus);

    this.micError = null;
    // Only pass the mic through when it's going into a cable — never to speakers (feedback).
    if (this.routeOk && s.micEnabled && dev.mic === null) {
      this.micError = 'No microphone found. Plug in your mic, then pick it in Settings.';
    } else if (this.routeOk && s.micEnabled) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: dev.mic ? { exact: dev.mic } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        this.main.createMediaStreamSource(this.mic).connect(this.micGain);
      } catch (e) {
        this.micError = e.message || String(e);
      }
    }
    this.setLevels(s);
    try { await this.main.resume(); await this.mon.resume(); } catch { /* ignore */ }
  }

  // Peak level of the voice-chat mix before the limiter (1.0 = full scale).
  mixPeak() {
    if (!this.meter) return 0;
    const buf = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
    return peak;
  }

  setLevels(s) {
    if (!this.main) return;
    this.mainOut.gain.value = this.routeOk ? s.masterVolume : 0;
    this.monOut.gain.value = s.monitorVolume;
    this.micGain.gain.value = s.micVolume;
  }

  async shutdown() {
    this.stopAll();
    if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
    for (const c of [this.main, this.mon]) { if (c) { try { await c.close(); } catch { /* ignore */ } } }
    this.main = this.mon = null;
  }

  load(file) {
    if (!file) return Promise.resolve(null);
    if (this.buffers.has(file)) return this.buffers.get(file);
    const p = (async () => {
      const bytes = await echo.readSound(file);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const ctx = this.main || new OfflineAudioContext(2, 1, 48000);
      return ctx.decodeAudioData(ab);
    })();
    this.buffers.set(file, p);
    p.catch(() => this.buffers.delete(file));
    return p;
  }

  async play(i, pad) {
    const buf = await this.load(pad.file);
    if (!buf || !this.main) return false;
    this.stop(i);
    const loop = pad.mode === 'loop';
    const mk = (ctx, out) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      const g = ctx.createGain();
      g.gain.value = pad.volume;
      src.connect(g);
      g.connect(out);
      src.start();
      return src;
    };
    const v = { a: mk(this.main, this.mainOut), b: mk(this.mon, this.monOut),
                t0: performance.now(), dur: buf.duration, loop };
    const ended = () => {
      if (this.voices.get(i) !== v) return;
      this.voices.delete(i);
      try { v.a.stop(); } catch { /* already stopped */ }
      try { v.b.stop(); } catch { /* already stopped */ }
      this.onVoiceEnd(i);
    };
    v.a.onended = ended;
    v.b.onended = ended;
    this.voices.set(i, v);
    return true;
  }

  stop(i) {
    const v = this.voices.get(i);
    if (!v) return;
    this.voices.delete(i);
    try { v.a.stop(); } catch { /* ignore */ }
    try { v.b.stop(); } catch { /* ignore */ }
    this.onVoiceEnd(i);
  }

  stopAll() { for (const i of [...this.voices.keys()]) this.stop(i); }
  isPlaying(i) { return this.voices.has(i); }

  progress(i) {
    const v = this.voices.get(i);
    if (!v || !v.dur) return 0;
    const t = (performance.now() - v.t0) / 1000;
    return v.loop ? (t % v.dur) / v.dur : Math.min(1, t / v.dur);
  }
}

const engine = new Engine();
engine.onVoiceEnd = (i) => {
  if (i === 'tts') { renderTts(); return; }
  renderPad(i);
  led(i);
};

/* ---------------- Pad actions ---------------- */

async function press(i) {
  const pad = state.pads[i];
  if (!pad || !pad.file) return;
  if ((pad.mode === 'toggle' || pad.mode === 'loop') && engine.isPlaying(i)) {
    engine.stop(i);
    return;
  }
  if (pad.choke) for (const j of [...engine.voices.keys()]) if (j !== i) engine.stop(j);
  try {
    if (await engine.play(i, pad)) {
      missing.delete(i);
      renderPad(i);
      led(i);
    }
  } catch (e) {
    console.error(e);
    missing.add(i);
    renderPad(i);
    toast(`Couldn't play "${pad.name || 'sound'}". The file may be missing or unsupported.`);
  }
}

function release(i) {
  const pad = state.pads[i];
  if (pad && pad.mode === 'hold') engine.stop(i);
}

function stopAll() {
  engine.stopAll();
  if (learnTarget !== null) cancelLearn();
}

async function assignFile(i, picked) {
  if (!picked) return;
  const pad = state.pads[i];
  engine.stop(i);
  pad.file = picked.path;
  pad.name = picked.name;
  missing.delete(i);
  engine.load(pad.file).catch(() => { missing.add(i); renderPad(i); toast('That file could not be decoded.'); });
  renderPad(i);
  if (i === selected) renderEditor();
  led(i);
  save();
}

function clearPad(i) {
  engine.stop(i);
  const trig = state.pads[i].trigger;
  state.pads[i] = { ...defaultPad(i), trigger: trig };
  missing.delete(i);
  renderPad(i);
  renderEditor();
  led(i);
  save();
}

/* ---------------- MIDI ---------------- */

/* Pads use the Launchpad "Programmer mode" numbering: bottom-left 11 ... top-right 88,
   right-hand column CC 19..89, top row CC 91..98. Older Launchpads (Mini MK1/MK2, S, original)
   use a different "X-Y" layout, so their messages are translated into this numbering. */

const midi = { access: null, inputs: [], output: null, sysex: false, busy: [], last: null };
const DAW_PORT_RE = /daw|midiin2|midiout2/i;

const isLegacyLaunchpad = (name) => /launchpad (mini|s\b)|^launchpad$|^launchpad[^a-z]*$/i.test(String(name || '').trim()) && !/mk3/i.test(name || '');
const cleanPortName = (name) => String(name || '').replace(/^MIDI(IN|OUT)\d+\s*\((.*)\)$/i, '$2').trim();

// Older Launchpad -> Programmer numbering
function fromLegacy(type, num) {
  if (type === 'note') {
    const row = Math.floor(num / 16), col = num % 16; // row 0 = top
    if (row > 7 || col > 8) return { type, num };
    const r = 7 - row;
    return col < 8 ? { type: 'note', num: (r + 1) * 10 + col + 1 } : { type: 'cc', num: (r + 1) * 10 + 9 };
  }
  if (type === 'cc' && num >= 104 && num <= 111) return { type: 'cc', num: 91 + (num - 104) };
  return { type, num };
}

// Programmer numbering -> older Launchpad (for its lights)
function toLegacy(trig) {
  if (!trig) return null;
  if (trig.type === 'cc' && trig.num >= 91 && trig.num <= 98) return { type: 'cc', num: 104 + (trig.num - 91) };
  const r = Math.floor(trig.num / 10) - 1, c = (trig.num % 10) - 1;
  if (r < 0 || r > 7) return null;
  if (trig.type === 'note' && c >= 0 && c <= 7) return { type: 'note', num: (7 - r) * 16 + c };
  if (trig.type === 'cc' && c === 8) return { type: 'note', num: (7 - r) * 16 + 8 };
  return null;
}

// Older Launchpads only have red/green LEDs: velocity = 16*green + red + 12, each 0..3.
const LEGACY_COLOR = { red: [3, 0], orange: [3, 1], yellow: [2, 3], green: [0, 3], cyan: [0, 3], blue: [3, 3], purple: [3, 1], pink: [3, 0], white: [3, 3] };
function legacyVelocity(colorId, bright) {
  const [r, g] = LEGACY_COLOR[colorId] || [3, 3];
  const k = bright ? 1 : 1 / 3;
  return 16 * Math.round(g * k) + Math.round(r * k) + 12;
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) { updateChips(); return; }
  try {
    midi.access = await navigator.requestMIDIAccess({ sysex: true });
    midi.sysex = true;
  } catch {
    try { midi.access = await navigator.requestMIDIAccess(); }
    catch (e) { console.warn('MIDI unavailable', e); updateChips(); return; }
  }
  midi.access.onstatechange = () => { refreshMidiLists(); connectMidi(); };
  refreshMidiLists();
  await connectMidi();
}

function livePorts(map) { return [...map.values()].filter((p) => p.state !== 'disconnected'); }

// Which inputs to listen to: the chosen one, or every Launchpad port (falls back to every input).
function pickInputs(ports, saved) {
  if (saved === 'none') return [];
  if (saved) { const p = ports.find((x) => x.name === saved); if (p) return [p]; }
  const lp = ports.filter((p) => LAUNCHPAD_RE.test(p.name));
  return lp.length ? lp : ports;
}

function pickOutput(ports, saved) {
  if (saved === 'none') return null;
  if (saved) { const p = ports.find((x) => x.name === saved); if (p) return p; }
  const lp = ports.filter((p) => LAUNCHPAD_RE.test(p.name));
  return lp.find((p) => !DAW_PORT_RE.test(p.name)) || lp[0] || null;
}

let connecting = Promise.resolve();
function connectMidi() {
  connecting = connecting.then(doConnectMidi).catch((e) => console.error('MIDI connect failed', e));
  return connecting;
}

async function doConnectMidi() {
  if (!midi.access) return;
  const wanted = pickInputs(livePorts(midi.access.inputs), state.settings.midiIn);
  const wantedIds = new Set(wanted.map((p) => p.id));

  for (const p of midi.inputs) if (!wantedIds.has(p.id)) { p.onmidimessage = null; try { await p.close(); } catch { /* ignore */ } }
  midi.inputs = midi.inputs.filter((p) => wantedIds.has(p.id));
  midi.busy = [];
  for (const p of wanted) {
    if (midi.inputs.some((x) => x.id === p.id)) continue;
    try {
      await p.open(); // fails if another app (Ableton, Novation Components, a DAW) is using it
      p.onmidimessage = (e) => onMidi(e, p);
      midi.inputs.push(p);
    } catch (e) {
      console.warn('MIDI input busy', p.name, e);
      midi.busy.push(cleanPortName(p.name));
    }
  }

  const out = pickOutput(livePorts(midi.access.outputs), state.settings.midiOut);
  if ((out && out.id) !== (midi.output && midi.output.id)) {
    midi.output = null;
    if (out) {
      try {
        await out.open();
        midi.output = out;
        enterProgrammerMode();
        setTimeout(ledAll, 250);
      } catch (e) {
        console.warn('MIDI output busy', out.name, e);
        if (!midi.busy.includes(cleanPortName(out.name))) midi.busy.push(cleanPortName(out.name));
      }
    }
  }
  updateChips();
}

const outputIsLegacy = () => !!midi.output && isLegacyLaunchpad(cleanPortName(midi.output.name));

function enterProgrammerMode() {
  if (!midi.output) return;
  if (outputIsLegacy()) {
    try { midi.output.send([0xb0, 0x00, 0x00]); } catch { /* ignore */ } // reset; X-Y layout is the default
    return;
  }
  if (!midi.sysex) return;
  // Launchpad X (0x0C), Mini MK3 (0x0D), Pro MK3 (0x0E). Devices ignore IDs that aren't theirs.
  for (const id of [0x0c, 0x0d, 0x0e]) {
    try { midi.output.send([0xf0, 0x00, 0x20, 0x29, 0x02, id, 0x0e, 0x01, 0xf7]); } catch { /* ignore */ }
  }
}

function leaveProgrammerMode() {
  if (!midi.output) return;
  if (outputIsLegacy()) {
    try { midi.output.send([0xb0, 0x00, 0x00]); } catch { /* ignore */ }
    return;
  }
  state.pads.forEach((p) => sendLed(p.trigger, 0, 0));
  if (state.stopAllTrigger) sendLed(state.stopAllTrigger, 0, 0);
  if (!midi.sysex) return;
  for (const id of [0x0c, 0x0d, 0x0e]) {
    try { midi.output.send([0xf0, 0x00, 0x20, 0x29, 0x02, id, 0x0e, 0x00, 0xf7]); } catch { /* ignore */ }
  }
}

let unlinkedHintAt = 0;
function onMidi(e, port) {
  const [st, d1, d2 = 0] = e.data;
  const kind = st & 0xf0;
  let type, down;
  if (kind === 0x90) { type = 'note'; down = d2 > 0; }
  else if (kind === 0xb0) { type = 'cc'; down = d2 > 0; }
  else if (kind === 0x80) { type = 'note'; down = false; }
  else return;

  let trig = { type, num: d1 };
  if (port && isLegacyLaunchpad(cleanPortName(port.name))) trig = fromLegacy(type, d1);
  if (down) {
    midi.last = { ...trig, port: cleanPortName(port && port.name) };
    flashMidiChip();
    renderMidiActivity();
  }

  if (down && learnTarget !== null) { finishLearn(trig); return; }

  const key = trigKey(trig);
  if (state.stopAllTrigger && key === trigKey(state.stopAllTrigger)) { if (down) stopAll(); return; }
  const i = triggerMap.get(key);
  if (i === undefined) {
    if (down && Date.now() - unlinkedHintAt > 8000) {
      unlinkedHintAt = Date.now();
      toast(`That button (${trigText(trig)}) isn't linked to a pad. Select a pad and click Learn button.`);
    }
    return;
  }
  if (down && !state.pads[i].file) {
    if (Date.now() - unlinkedHintAt > 4000) {
      unlinkedHintAt = Date.now();
      toast(`That's pad ${padLabel(i)}, which has no sound yet.`);
    }
    select(i);
    return;
  }
  if (down) press(i); else release(i);
}

let flashTimer = null;
function flashMidiChip() {
  const c = $('#chip-midi');
  c.classList.add('active');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => c.classList.remove('active'), 150);
}

function renderMidiActivity() {
  const el = $('#set-midi-last');
  if (!el) return;
  el.textContent = midi.last ? `${trigText(midi.last)} from ${midi.last.port}` : 'Press any button on your controller…';
}

// channel offset: 0 = static, 1 = flashing, 2 = pulsing (Launchpad Programmer mode)
function sendLed(trig, color, chan) {
  if (!midi.output || !trig) return;
  const st = (trig.type === 'cc' ? 0xb0 : 0x90) | chan;
  try { midi.output.send([st, trig.num, color]); } catch { /* ignore */ }
}

function led(i) {
  const pad = state.pads[i];
  if (!pad || !midi.output) return;
  if (outputIsLegacy()) {
    const t = toLegacy(pad.trigger);
    if (!t) return;
    const vel = pad.file ? legacyVelocity(pad.color, engine.isPlaying(i)) : 12;
    try { midi.output.send([t.type === 'cc' ? 0xb0 : 0x90, t.num, vel]); } catch { /* ignore */ }
    return;
  }
  const col = pad.file ? colorById(pad.color).lp : 0;
  if (engine.isPlaying(i) && col) {
    sendLed(pad.trigger, col, 0);
    sendLed(pad.trigger, col, 2);
  } else {
    sendLed(pad.trigger, col, 0);
  }
}

function ledAll() {
  state.pads.forEach((_, i) => led(i));
  if (!state.stopAllTrigger || !midi.output) return;
  if (outputIsLegacy()) {
    const t = toLegacy(state.stopAllTrigger);
    if (t) try { midi.output.send([t.type === 'cc' ? 0xb0 : 0x90, t.num, 15]); } catch { /* ignore */ }
  } else {
    sendLed(state.stopAllTrigger, 5, 0);
  }
}

/* ---------------- Learn ---------------- */

function startLearn(target) {
  learnTarget = target;
  renderEditor();
  renderSettingsLearn();
  if (!midi.inputs.length) toast(midi.busy.length ? 'Your Launchpad is being used by another app. Close it and try again.' : 'No MIDI controller connected. Plug in your Launchpad first.');
}

function cancelLearn() {
  learnTarget = null;
  renderEditor();
  renderSettingsLearn();
}

function finishLearn(trig) {
  const key = trigKey(trig);
  const target = learnTarget;
  learnTarget = null;

  // A button can only do one thing: release it from wherever it was.
  state.pads.forEach((p, i) => {
    if (trigKey(p.trigger) === key) { sendLed(p.trigger, 0, 0); p.trigger = null; renderPad(i); }
  });
  if (trigKey(state.stopAllTrigger) === key) state.stopAllTrigger = null;

  if (target === 'stopall') {
    if (state.stopAllTrigger) sendLed(state.stopAllTrigger, 0, 0);
    state.stopAllTrigger = trig;
    toast('Stop-all button set.');
  } else {
    const pad = state.pads[target];
    if (pad.trigger) sendLed(pad.trigger, 0, 0);
    pad.trigger = trig;
    renderPad(target);
    toast(`Pad ${padLabel(target)} → ${trigText(trig)}`);
  }
  rebuildTriggerMap();
  ledAll();
  renderEditor();
  renderSettingsLearn();
  save();
}

/* ---------------- Rendering ---------------- */

function buildGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  for (let r = 7; r >= 0; r--) {
    for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      const el = document.createElement('button');
      el.className = 'pad';
      el.innerHTML = '<span class="pad-name"></span><span class="pad-tag"></span><span class="pad-prog"></span>';
      el.addEventListener('click', () => select(i));
      el.addEventListener('dblclick', () => press(i));
      // Drag a pad onto another to move it (swaps if the spot is taken). Ctrl/Option-drag copies.
      el.addEventListener('dragstart', (e) => {
        if (!state.pads[i].file) { e.preventDefault(); return; }
        dragFrom = i;
        e.dataTransfer.setData(PAD_DRAG_TYPE, String(i));
        e.dataTransfer.effectAllowed = 'copyMove';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        dragFrom = null;
        el.classList.remove('dragging');
        padEls.forEach((p) => p.classList.remove('drop'));
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragFrom !== null) e.dataTransfer.dropEffect = (e.ctrlKey || e.altKey) ? 'copy' : 'move';
        if (dragFrom !== i) el.classList.add('drop');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        const from = e.dataTransfer.types.includes(PAD_DRAG_TYPE) ? Number(e.dataTransfer.getData(PAD_DRAG_TYPE)) : null;
        if (from !== null && !Number.isNaN(from)) {
          movePad(from, i, e.ctrlKey || e.altKey);
          return;
        }
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try {
          select(i);
          await assignFile(i, await echo.importSound(echo.pathForFile(file)));
        } catch (err) {
          toast(errMsg(err));
        }
      });
      grid.appendChild(el);
      padEls[i] = el;
    }
  }
  state.pads.forEach((_, i) => renderPad(i));
}

const PAD_DRAG_TYPE = 'application/x-echo-board-pad';
let dragFrom = null;

// What belongs to the sound (moves with it). The Launchpad button stays with the grid position.
const PAD_CONTENT_KEYS = ['name', 'file', 'volume', 'color', 'mode', 'choke'];
const padContent = (p) => Object.fromEntries(PAD_CONTENT_KEYS.map((k) => [k, p[k]]));

function movePad(from, to, copy) {
  if (from === to || !state.pads[from] || !state.pads[to]) return;
  const a = state.pads[from], b = state.pads[to];
  if (!a.file) return;
  engine.stop(from);
  engine.stop(to);
  const aContent = padContent(a), bContent = padContent(b);
  if (copy) {
    Object.assign(b, aContent);
  } else {
    Object.assign(b, aContent);
    if (bContent.file) Object.assign(a, bContent);            // swap
    else Object.assign(a, padContent({ ...defaultPad(from) }));  // move into an empty spot
  }
  const aMissing = missing.has(from), bMissing = missing.has(to);
  missing.delete(from); missing.delete(to);
  if (aMissing) missing.add(to);
  if (!copy && bMissing && bContent.file) missing.add(from);
  if (copy && aMissing) missing.add(from);
  [from, to].forEach((k) => { renderPad(k); led(k); });
  select(to);
  save();
  toast(copy ? `Copied to pad ${padLabel(to)}` : bContent.file ? `Swapped pads ${padLabel(from)} and ${padLabel(to)}` : `Moved to pad ${padLabel(to)}`);
}

function renderPad(i) {
  const el = padEls[i];
  const pad = state.pads[i];
  if (!el || !pad) return;
  el.style.setProperty('--pc', colorById(pad.color).hex);
  el.classList.toggle('assigned', !!pad.file);
  el.draggable = !!pad.file;
  el.classList.toggle('playing', engine.isPlaying(i));
  el.classList.toggle('selected', i === selected);
  el.classList.toggle('missing', missing.has(i));
  const nameText = pad.file ? pad.name || 'Untitled' : '';
  const nameEl = el.querySelector('.pad-name');
  nameEl.textContent = nameText;
  nameEl.classList.toggle('long', nameText.split(/\s+/).some((w) => w.length > 7)); // smaller text so long words don't split
  el.querySelector('.pad-tag').textContent = padLabel(i) + (pad.trigger ? '' : ' · no button');
  if (!engine.isPlaying(i)) el.style.setProperty('--p', 0);
}

function select(i) {
  const prev = selected;
  selected = i;
  if (learnTarget !== null && learnTarget !== 'stopall') cancelLearn();
  renderPad(prev);
  renderPad(i);
  renderEditor();
  renderTts();
}

function renderEditor() {
  const pad = state.pads[selected];
  $('#ed-title').textContent = 'Pad ' + padLabel(selected);
  $('#ed-trigger').textContent = trigText(pad.trigger);
  const fb = $('#ed-file');
  fb.textContent = pad.file ? pad.file.split(/[\\/]/).pop().replace(/^[0-9a-f]{8}-/, '') : 'No sound yet';
  fb.classList.toggle('has', !!pad.file);
  $('#ed-preview').disabled = !pad.file;
  $('#ed-name').value = pad.name;
  $('#ed-volume').value = Math.round(pad.volume * 100);
  $('#ed-volume-val').textContent = Math.round(pad.volume * 100) + '%';
  $('#ed-mode').value = pad.mode;
  $('#ed-choke').checked = !!pad.choke;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.id === pad.color));
  const learning = learnTarget === selected;
  const lb = $('#ed-learn');
  lb.textContent = learning ? 'Cancel' : 'Learn button';
  lb.classList.toggle('learning', learning);
  $('#ed-learn-msg').textContent = learning ? 'Press a button on your controller…' : '';
}

function renderSettingsLearn() {
  const learning = learnTarget === 'stopall';
  const b = $('#set-stop-learn');
  b.textContent = learning ? 'Cancel' : 'Learn button';
  b.classList.toggle('learning', learning);
  $('#set-stop-label').textContent = learning ? 'Press a button…' : trigText(state.stopAllTrigger);
}

function setChip(sel, cls, text, title) {
  const c = $(sel);
  c.className = 'chip ' + cls;
  c.textContent = text;
  c.title = title || text;
}

function deviceLabel(list, id) {
  const d = list.find((x) => x.deviceId === id);
  return d ? d.label : '';
}

function updateChips() {
  const lpNames = [...new Set(midi.inputs.map((p) => cleanPortName(p.name)).filter((n) => LAUNCHPAD_RE.test(n)))];
  if (lpNames.length) setChip('#chip-midi', 'ok', lpNames[0], 'Controller: ' + lpNames.join(', ') + ' (flashes when you press a button)');
  else if (midi.busy.length) setChip('#chip-midi', 'bad', 'Launchpad busy', 'Another app is using ' + midi.busy[0] + '. Close Ableton, FL Studio, Novation Components or other music apps, then unplug and replug the Launchpad.');
  else if (midi.inputs.length) setChip('#chip-midi', 'ok', 'MIDI: ' + cleanPortName(midi.inputs[0].name), 'Listening to: ' + midi.inputs.map((p) => cleanPortName(p.name)).join(', '));
  else setChip('#chip-midi', 'warn', 'No controller', 'Plug in your Launchpad');

  if (engine.routeOk) {
    const name = deviceLabel(audioDevices.outs, state.settings.cableDevice) || 'virtual cable';
    setChip('#chip-out', 'ok', 'Voice chat: ' + name);
  } else {
    setChip('#chip-out', 'warn', 'No virtual cable', 'Sounds only play in your headphones. Click for setup help.');
  }

  const s = state.settings;
  const micLabel = micInUseLabel();
  if (!engine.routeOk || !s.micEnabled) setChip('#chip-mic', '', 'Mic off');
  else if (engine.micError) setChip('#chip-mic', 'bad', 'Mic error', engine.micError);
  else if (!micLabel) setChip('#chip-mic', 'bad', 'No mic found', 'Plug in your microphone, then pick it in Settings.');
  else setChip('#chip-mic', 'ok', 'Mic: ' + micLabel.replace(/\s*\(.*\)\s*$/, ''), 'Friends hear this mic plus your sounds: ' + micLabel);
}

let meterHold = 0;
function renderMixMeter() {
  const bar = $('#mix-meter');
  if (!bar || $('#settings').classList.contains('hidden')) return;
  const peak = engine.mixPeak();
  meterHold = Math.max(peak, meterHold * 0.92);
  bar.style.width = Math.min(100, meterHold * 100) + '%';
  bar.classList.toggle('hot', meterHold > 0.5);   // limiter is working
  const note = $('#mix-meter-note');
  if (note) note.textContent = !engine.routeOk ? 'No virtual cable selected' : meterHold > 0.98 ? 'Very loud: lower Mic or Soundboard volume' : meterHold > 0.5 ? 'Loud (auto-limited, no distortion)' : meterHold > 0.02 ? 'Good' : 'Silent';
}

function progressLoop() {
  renderMixMeter();
  for (const i of engine.voices.keys()) padEls[i] && padEls[i].style.setProperty('--p', engine.progress(i));
  requestAnimationFrame(progressLoop);
}

/* ---------------- Settings ---------------- */

function fillSelect(sel, options, value) {
  const el = $(sel);
  el.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.v;
    opt.textContent = o.off ? o.t + ' (virtual cable, not usable here)' : o.t;
    if (o.off) opt.disabled = true;
    el.appendChild(opt);
  }
  if (value != null && options.some((o) => o.v === value)) el.value = value;
  else if (value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = '(not connected)';
    el.appendChild(opt);
    el.value = value;
  }
}

function refreshMidiLists() {
  if (!midi.access) {
    fillSelect('#set-midi-in', [{ v: '', t: 'MIDI unavailable' }], '');
    fillSelect('#set-midi-out', [{ v: '', t: 'MIDI unavailable' }], '');
    return;
  }
  const ins = livePorts(midi.access.inputs).map((p) => ({ v: p.name, t: p.name }));
  const outs = livePorts(midi.access.outputs).map((p) => ({ v: p.name, t: p.name }));
  fillSelect('#set-midi-in', [{ v: '', t: 'Auto (all Launchpad connections)' }, { v: 'none', t: 'None' }, ...ins], state.settings.midiIn);
  fillSelect('#set-midi-out', [{ v: '', t: 'Auto (find Launchpad)' }, { v: 'none', t: 'None (no lights)' }, ...outs], state.settings.midiOut);
}

/* Installing a virtual cable often makes Windows switch its *default* mic to "CABLE Output" and
   its default speakers to "CABLE Input". If Echo Board followed those defaults it would listen to
   its own output (a feedback loop: loud banging, your voice drowned out). So the mic and the
   headphones are never allowed to be a virtual cable. */
const isCableCapture = (label) => CABLE_MIC_RE.test(label || '');
const isCablePlayback = (label) => CABLE_OUT_RE.test(label || '');
const isLoopbackInput = (label) => /stereo mix|what u hear|wave out mix/i.test(label || '');

// '' = system default, a deviceId, or null = no usable mic
function resolveMic() {
  const s = state.settings, ins = audioDevices.ins;
  const chosen = ins.find((d) => d.deviceId === s.micDevice);
  if (chosen && !isCableCapture(chosen.label)) return chosen.deviceId;
  if (audioDevices.defaultInLabel && !isCableCapture(audioDevices.defaultInLabel)) return '';
  const realMic = ins.find((d) => !isCableCapture(d.label) && !isLoopbackInput(d.label));
  if (realMic) return realMic.deviceId;
  return ins.length && !audioDevices.defaultInLabel ? '' : null; // labels unknown: trust the default
}

function resolveMonitor() {
  const s = state.settings, outs = audioDevices.outs;
  const chosen = outs.find((d) => d.deviceId === s.monitorDevice);
  if (chosen && !isCablePlayback(chosen.label)) return chosen.deviceId;
  if (!audioDevices.defaultOutLabel || !isCablePlayback(audioDevices.defaultOutLabel)) return '';
  const real = outs.find((d) => !isCablePlayback(d.label));
  return real ? real.deviceId : '';
}

const resolveDevices = () => ({ mic: resolveMic(), monitor: resolveMonitor() });

function micInUseLabel() {
  const id = resolveMic();
  if (id === null) return '';
  if (id === '') return (audioDevices.defaultInLabel || 'System default mic').replace(/^Default - /, '');
  return deviceLabel(audioDevices.ins, id);
}

async function refreshAudioDevices() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (!devs.some((d) => d.label)) {
    // Labels only show up after mic permission is granted once.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch { /* no permission yet */ }
  }
  const real = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications';
  const defIn = devs.find((d) => d.kind === 'audioinput' && d.deviceId === 'default');
  const defOut = devs.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
  audioDevices = {
    ins: devs.filter((d) => d.kind === 'audioinput' && real(d)),
    outs: devs.filter((d) => d.kind === 'audiooutput' && real(d)),
    defaultInLabel: defIn ? defIn.label : '',
    defaultOutLabel: defOut ? defOut.label : '',
  };

  let changed = false;
  if (state.settings.cableDevice === null) {
    const c = audioDevices.outs.find((d) => CABLE_OUT_RE.test(d.label));
    if (c) { state.settings.cableDevice = c.deviceId; changed = true; save(); }
  }

  const lbl = (d, n) => d.label || n;
  fillSelect('#set-cable', [{ v: '', t: 'None (headphones only)' },
    ...audioDevices.outs.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Output ' + (n + 1)) }))], state.settings.cableDevice || '');
  // A virtual cable saved as mic/headphones (from before this was blocked) is cleared.
  const st = state.settings;
  const cableMic = audioDevices.ins.find((d) => d.deviceId === st.micDevice && isCableCapture(d.label));
  const cableMon = audioDevices.outs.find((d) => d.deviceId === st.monitorDevice && isCablePlayback(d.label));
  if (cableMic) st.micDevice = '';
  if (cableMon) st.monitorDevice = '';
  if (cableMic || cableMon) save();
  const usingMic = micInUseLabel();
  fillSelect('#set-mic', [{ v: '', t: 'Automatic' + (usingMic ? ' (' + usingMic + ')' : '') },
    ...audioDevices.ins.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Input ' + (n + 1)), off: isCableCapture(d.label) }))], state.settings.micDevice);
  const monId = resolveMonitor();
  const monName = monId ? deviceLabel(audioDevices.outs, monId) : (audioDevices.defaultOutLabel || '').replace(/^Default - /, '');
  fillSelect('#set-monitor', [{ v: '', t: 'Automatic' + (monName ? ' (' + monName + ')' : '') },
    ...audioDevices.outs.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Output ' + (n + 1)), off: isCablePlayback(d.label) }))], state.settings.monitorDevice);
  return changed;
}

function renderLevels() {
  const s = state.settings;
  $('#set-mic-on').checked = s.micEnabled;
  $('#set-mic-vol').value = Math.round(s.micVolume * 100);
  $('#set-mic-vol-val').textContent = Math.round(s.micVolume * 100) + '%';
  $('#set-master').value = Math.round(s.masterVolume * 100);
  $('#set-master-val').textContent = Math.round(s.masterVolume * 100) + '%';
  $('#set-monitor-vol').value = Math.round(s.monitorVolume * 100);
  $('#set-monitor-vol-val').textContent = Math.round(s.monitorVolume * 100) + '%';
}

let restartTimer = null;
function restartAudio() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await engine.start(state.settings, resolveDevices());
    state.pads.forEach((_, i) => renderPad(i));
    ledAll();
    updateChips();
  }, 50);
}

/* ---------------- Text to speech ---------------- */

const tts = { voices: {}, keys: {}, busy: false, last: null, history: [], playing: null, loadSeq: 0, download: null };
const ttsCfg = () => state.settings.tts;

function sortVoices(list) {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const rank = (v) => (v.detail && v.detail.toLowerCase().startsWith(lang) ? 0 : v.detail ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function loadTtsVoices(force) {
  const p = ttsCfg().provider;
  const seq = ++tts.loadSeq;
  if (NEEDS_KEY.has(p) && !tts.keys[p]) {
    fillSelect('#tts-voice', [{ v: '', t: 'Add API key in Settings' }], '');
    return;
  }
  if (!tts.voices[p] || force) {
    fillSelect('#tts-voice', [{ v: '', t: 'Loading voices…' }], '');
    try { tts.voices[p] = await echo.ttsVoices(p); }
    catch (e) {
      if (seq === tts.loadSeq) fillSelect('#tts-voice', [{ v: '', t: 'Voices unavailable' }], '');
      toast(errMsg(e));
      return;
    }
  }
  if (seq !== tts.loadSeq) return; // provider changed while loading
  const list = p === 'kokoro' ? tts.voices[p] : sortVoices(tts.voices[p]); // Kokoro list is already best-first
  const opts = list.map((v) => ({ v: v.id, t: v.detail ? `${v.name} · ${v.detail}` : v.name }));
  if (p === 'system') opts.unshift({ v: '', t: 'System default voice' });
  let cur = ttsCfg().voice[p] || '';
  if (!opts.some((o) => o.v === cur)) {
    cur = opts[0] ? opts[0].v : '';
    ttsCfg().voice[p] = cur;
    save();
  }
  fillSelect('#tts-voice', opts, cur);
}

function renderTts() {
  const s = ttsCfg();
  const text = $('#tts-text').value;
  $('#tts-provider').value = s.provider;
  $('#tts-style').classList.toggle('hidden', s.provider !== 'openai');
  const count = $('#tts-count');
  count.textContent = text.length > 0 ? `${text.length} / ${TTS_MAX}` : '';
  count.classList.toggle('near', text.length > TTS_MAX * 0.9);
  const speak = $('#tts-speak');
  speak.disabled = tts.busy || !text.trim();
  speak.textContent = !tts.busy ? 'Speak' : tts.download != null ? 'Downloading…' : 'Generating…';
  const status = $('#tts-status');
  status.textContent = tts.download != null ? `Getting voices… ${tts.download}%` : '';
  status.title = tts.download != null ? 'Downloading the free AI voices. This only happens once (about 90 MB).' : '';
  const saveBtn = $('#tts-save');
  saveBtn.disabled = tts.busy || (!text.trim() && !tts.last);
  saveBtn.textContent = 'Save to ' + padLabel(selected);
  saveBtn.title = text.trim() ? 'Save this line to pad ' + padLabel(selected)
    : tts.last ? `Save "${tts.last.text.slice(0, 40)}" to pad ${padLabel(selected)}` : 'Type a line first';
  const speaking = engine.isPlaying('tts');
  $('#tts').classList.toggle('speaking', speaking);
  document.querySelectorAll('.tts-chip').forEach((c) => c.classList.toggle('playing', speaking && c.dataset.file === tts.playing));
}

function renderHistory() {
  const box = $('#tts-history');
  box.innerHTML = '';
  for (const item of tts.history) {
    const b = document.createElement('button');
    b.className = 'tts-chip';
    b.textContent = item.text;
    b.title = `${item.text}\n${item.label} · click to replay`;
    b.dataset.file = item.file;
    b.addEventListener('click', () => { tts.last = item; playTts(item); });
    box.appendChild(b);
  }
  renderTts();
}

function addHistory(item) {
  tts.history = tts.history.filter((h) => h.key !== item.key);
  tts.history.unshift(item);
  for (const old of tts.history.splice(15)) engine.buffers.delete(old.file);
  renderHistory();
}

function ttsVoiceLabel(p, voice) {
  const v = (tts.voices[p] || []).find((x) => x.id === voice);
  return TTS_NAMES[p] + ' · ' + (v ? v.name : voice || 'default');
}

async function ttsGenerate(text) {
  const s = ttsCfg();
  text = (text || '').trim();
  if (!text || tts.busy) return null;
  const p = s.provider;
  if (NEEDS_KEY.has(p) && !tts.keys[p]) {
    openSettings();
    toast(`Add your ${TTS_NAMES[p]} API key to use those voices.`);
    return null;
  }
  const voice = s.voice[p] || '';
  const style = p === 'openai' ? (s.style || '').trim() : '';
  const key = [p, voice, style, text].join('\u0001');
  const cached = tts.history.find((h) => h.key === key);
  if (cached) return cached; // same line + voice: reuse it instead of paying for it again

  tts.busy = true;
  renderTts();
  try {
    const file = await echo.ttsSpeak({ provider: p, voice, text, style });
    const item = { key, text, file, label: ttsVoiceLabel(p, voice) };
    addHistory(item);
    return item;
  } catch (e) {
    toast(errMsg(e));
    return null;
  } finally {
    tts.busy = false;
    renderTts();
  }
}

async function playTts(item) {
  try {
    tts.playing = item.file;
    await engine.play('tts', { file: item.file, volume: 1, mode: 'oneshot' });
  } catch (e) {
    console.error(e);
    toast("Couldn't play that clip.");
  }
  renderTts();
}

async function ttsSpeak() {
  const box = $('#tts-text');
  const item = await ttsGenerate(box.value);
  if (!item) return;
  tts.last = item;
  if (box.value.trim() === item.text) box.value = ''; // clear like sending a chat message
  playTts(item);
}

async function ttsSaveToPad() {
  const i = selected;
  const box = $('#tts-text');
  const item = box.value.trim() ? await ttsGenerate(box.value) : tts.last;
  if (!item) return;
  try {
    const imported = await echo.importSound(item.file);
    await assignFile(i, { path: imported.path, name: item.text.slice(0, 40) });
    toast(`Saved to pad ${padLabel(i)}`);
  } catch (e) {
    toast(errMsg(e));
  }
}

async function refreshKeyStatus() {
  try { tts.keys = await echo.ttsKeyStatus(); } catch { tts.keys = {}; }
  for (const p of ['openai', 'elevenlabs']) {
    const has = !!tts.keys[p];
    $(`#key-${p}-status`).textContent = has ? '✓ saved' : '';
    $(`#key-${p}`).placeholder = has ? 'Saved. Paste a new key to replace it.' : (p === 'openai' ? 'sk-...' : 'Paste key');
    document.querySelector(`[data-removekey="${p}"]`).classList.toggle('hidden', !has);
  }
}

async function saveKey(p, value) {
  try {
    await echo.ttsSetKey(p, value);
    $(`#key-${p}`).value = '';
    tts.voices[p] = null;
    await refreshKeyStatus();
    toast(value ? `${TTS_NAMES[p]} key saved.` : `${TTS_NAMES[p]} key removed.`);
    if (ttsCfg().provider === p) loadTtsVoices(true);
  } catch (e) {
    toast(errMsg(e));
  }
}

function wireTts() {
  echo.onTtsProgress((pct) => { tts.download = pct; renderTts(); });
  const box = $('#tts-text');
  box.addEventListener('input', renderTts);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ttsSpeak(); }
  });
  $('#tts-speak').addEventListener('click', ttsSpeak);
  $('#tts-save').addEventListener('click', ttsSaveToPad);
  $('#tts-provider').addEventListener('change', (e) => {
    ttsCfg().provider = e.target.value;
    save();
    renderTts();
    loadTtsVoices();
  });
  $('#tts-voice').addEventListener('change', (e) => {
    const p = ttsCfg().provider;
    if (NEEDS_KEY.has(p) && !tts.keys[p]) { openSettings(); return; }
    ttsCfg().voice[p] = e.target.value;
    save();
  });
  $('#tts-style').value = ttsCfg().style || '';
  $('#tts-style').addEventListener('input', (e) => { ttsCfg().style = e.target.value; save(); });
  $('#tts-style').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ttsSpeak(); } });

  document.querySelectorAll('[data-savekey]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.savekey;
    const v = $(`#key-${p}`).value.trim();
    if (!v) { toast('Paste a key first.'); return; }
    saveKey(p, v);
  }));
  document.querySelectorAll('[data-removekey]').forEach((b) => b.addEventListener('click', () => saveKey(b.dataset.removekey, '')));
  ['openai', 'elevenlabs'].forEach((p) => $(`#key-${p}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.querySelector(`[data-savekey="${p}"]`).click();
  }));
}

/* ---------------- Virtual cable setup ---------------- */

const cable = { busy: false };

function setCableStatus(text, cls) {
  const el = $('#cable-status');
  el.textContent = text || '';
  el.className = 'cable-status' + (cls ? ' ' + cls : '');
}

function openCableSetup() {
  const isWin = echo.platform === 'win32';
  $('#cable-steps-win').classList.toggle('hidden', !isWin);
  $('#cable-steps-mac').classList.toggle('hidden', isWin);
  document.querySelectorAll('.cable-mic-name').forEach((e) => { e.textContent = isWin ? 'CABLE Output (VB-Audio Virtual Cable)' : 'VB-Cable'; });
  if (!cable.busy) setCableStatus(engine.routeOk ? 'A virtual cable is already set up.' : '', engine.routeOk ? 'ok' : '');
  $('#settings').classList.add('hidden');
  $('#cable').classList.remove('hidden');
}

async function installCable() {
  if (cable.busy) return;
  cable.busy = true;
  $('#cable-install').disabled = true;
  setCableStatus('Starting…');
  try {
    const r = await echo.installCable();
    if (r && r.cancelled) {
      setCableStatus('Cancelled. Click Install to try again.');
    } else {
      state.settings.cableDevice = null; // let Echo Board pick the new cable automatically
      save();
      await refreshAudioDevices();
      restartAudio();
      if (r && r.restart) {
        setCableStatus('Installed! Restart your PC to finish. Echo Board will use it automatically.', 'ok');
      } else {
        setCableStatus('Installed! Echo Board now sends to VB-Cable.', 'ok');
      }
      toast('Virtual cable installed.');
    }
  } catch (e) {
    setCableStatus(errMsg(e) + ' You can also install it from vb-cable.com.', 'bad');
  } finally {
    cable.busy = false;
    $('#cable-install').disabled = false;
  }
}

function wireCable() {
  $('#cable-install').addEventListener('click', installCable);
  $('#set-cable-install').addEventListener('click', openCableSetup);
  if (echo.onCableStatus) echo.onCableStatus((t) => { if (cable.busy) setCableStatus(t); });
}

function openSettings() {
  renderMidiActivity();
  refreshAudioDevices();
  refreshMidiLists();
  refreshKeyStatus();
  $('#settings').classList.remove('hidden');
}

/* ---------------- Wiring ---------------- */

function wireEditor() {
  const sw = $('#ed-colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.id = c.id;
    b.style.background = c.hex;
    b.title = c.id;
    b.addEventListener('click', () => {
      state.pads[selected].color = c.id;
      renderPad(selected); renderEditor(); led(selected); save();
    });
    sw.appendChild(b);
  }

  $('#ed-pick').addEventListener('click', async () => {
    const i = selected;
    try { await assignFile(i, await echo.pickSound()); }
    catch (e) { toast(String(e.message || e)); }
  });
  $('#ed-preview').addEventListener('click', () => press(selected));
  $('#ed-name').addEventListener('input', (e) => {
    state.pads[selected].name = e.target.value;
    renderPad(selected); save();
  });
  $('#ed-volume').addEventListener('input', (e) => {
    state.pads[selected].volume = Number(e.target.value) / 100;
    $('#ed-volume-val').textContent = e.target.value + '%';
    save();
  });
  $('#ed-mode').addEventListener('change', (e) => {
    engine.stop(selected);
    state.pads[selected].mode = e.target.value;
    save();
  });
  $('#ed-choke').addEventListener('change', (e) => { state.pads[selected].choke = e.target.checked; save(); });
  $('#ed-learn').addEventListener('click', () => (learnTarget === selected ? cancelLearn() : startLearn(selected)));
  $('#ed-clear').addEventListener('click', () => clearPad(selected));
}

function wireSettings() {
  const open = (id) => $('#' + id).classList.remove('hidden');
  const close = (id) => {
    $('#' + id).classList.add('hidden');
    if (id === 'settings' && learnTarget === 'stopall') cancelLearn();
  };
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-help').addEventListener('click', () => open('help'));
  $('#chip-out').addEventListener('click', () => (engine.routeOk ? openSettings() : openCableSetup()));
  $('#chip-mic').addEventListener('click', openSettings);
  $('#chip-midi').addEventListener('click', openSettings);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(b.dataset.close)));
  document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => { if (e.target === o) close(o.id); }));
  document.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); echo.openExternal(a.dataset.link); }));

  $('#btn-stopall').addEventListener('click', stopAll);

  const s = state.settings;
  $('#set-midi-in').addEventListener('change', (e) => { s.midiIn = e.target.value; save(); connectMidi(); });
  $('#set-midi-out').addEventListener('change', (e) => {
    if (midi.output) leaveProgrammerMode();
    midi.output = null;
    s.midiOut = e.target.value; save(); connectMidi();
  });
  $('#set-stop-learn').addEventListener('click', () => (learnTarget === 'stopall' ? cancelLearn() : startLearn('stopall')));

  $('#set-cable').addEventListener('change', (e) => { s.cableDevice = e.target.value; save(); restartAudio(); });
  $('#set-mic').addEventListener('change', (e) => { s.micDevice = e.target.value; save(); restartAudio(); });
  $('#set-monitor').addEventListener('change', (e) => { s.monitorDevice = e.target.value; save(); restartAudio(); });
  $('#set-mic-on').addEventListener('change', (e) => { s.micEnabled = e.target.checked; save(); restartAudio(); });

  const level = (sel, key, valSel) => $(sel).addEventListener('input', (e) => {
    s[key] = Number(e.target.value) / 100;
    $(valSel).textContent = e.target.value + '%';
    engine.setLevels(s);
    save();
  });
  level('#set-mic-vol', 'micVolume', '#set-mic-vol-val');
  level('#set-master', 'masterVolume', '#set-master-val');
  level('#set-monitor-vol', 'monitorVolume', '#set-monitor-vol-val');
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') {
      const openOverlay = document.querySelector('.overlay:not(.hidden)');
      if (openOverlay) { openOverlay.classList.add('hidden'); return; }
      stopAll();
      return;
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'Space') { e.preventDefault(); press(selected); }
  });
  // Don't let a file dropped outside a pad navigate the window away.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  echo.onStopAll(stopAll);
  window.addEventListener('beforeunload', leaveProgrammerMode);
}

async function boot() {
  const saved = await echo.loadConfig();
  state.pads = Array.from({ length: 64 }, (_, i) => {
    const p = saved && saved.pads && saved.pads[i];
    return p ? { ...defaultPad(i), ...p } : defaultPad(i);
  });
  if (saved && saved.settings) state.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  const savedTts = (saved && saved.settings && saved.settings.tts) || {};
  state.settings.tts = { ...DEFAULT_SETTINGS.tts, ...savedTts,
    voice: { ...DEFAULT_SETTINGS.tts.voice, ...(savedTts.voice || {}) } };
  if (!savedTts.v || savedTts.v < 2) { state.settings.tts.provider = 'kokoro'; state.settings.tts.v = 2; } // free AI voices are the new default
  if (saved && saved.stopAllTrigger) state.stopAllTrigger = saved.stopAllTrigger;
  rebuildTriggerMap();

  buildGrid();
  wireEditor();
  wireSettings();
  wireKeys();
  wireTts();
  wireCable();
  renderEditor();
  renderTts();
  renderLevels();
  renderSettingsLearn();
  updateChips();

  // Each startup step is independent: if one stalls or fails, the rest of the app still loads.
  const step = (name, p, ms = 10000) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(name + ' timed out')), ms)),
  ]).catch((e) => console.error('Startup step failed:', name, e));

  loadTtsVoices();
  await step('audio devices', refreshAudioDevices());
  await step('audio engine', engine.start(state.settings, resolveDevices()));
  updateChips();
  // First run with no virtual cable: offer to set one up (once).
  if (!engine.routeOk && !state.settings.cableSetupShown && (echo.platform === 'win32' || echo.platform === 'darwin')) {
    state.settings.cableSetupShown = true;
    save();
    openCableSetup();
  }
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const before = engine.routeOk;
    await refreshAudioDevices();
    if (!before && state.settings.cableDevice) restartAudio(); else updateChips();
  });

  // Warm up decoded audio so the first press is instant.
  state.pads.forEach((p, i) => {
    if (p.file) engine.load(p.file).catch(() => { missing.add(i); renderPad(i); });
  });

  requestAnimationFrame(progressLoop);
  await step('MIDI', initMidi(), 8000);
  await step('API keys', refreshKeyStatus());
  if (NEEDS_KEY.has(ttsCfg().provider)) loadTtsVoices(); // now that we know which keys are saved
  updateChips();
}

boot().catch((e) => { console.error(e); toast('Startup error: ' + (e.message || e)); });
