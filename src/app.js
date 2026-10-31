'use strict';

/* ============================================================
   Echo Chamber — renderer
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

const CABLE_OUT_RE = /cable input|blackhole|vb-audio|voicemeeter input/i; // devices we send INTO
const CABLE_MIC_RE = /cable output|blackhole|voicemeeter out/i;            // the cable's mic side (never use as your mic)
const LAUNCHPAD_RE = /launchpad|lpmini|lpx|lppro/i;

const DEFAULT_SETTINGS = {
  midiIn: '',        // port name ('' = auto, 'none' = off)
  midiOut: '',
  micDevice: '',     // '' = system default
  cableDevice: null, // null = not chosen yet (auto-detect), '' = none
  monitorDevice: '', // '' = system default
  micEnabled: true,
  micVolume: 1,
  masterVolume: 1,
  monitorVolume: 0.8,
  tts: { provider: 'kokoro', voice: { kokoro: 'af_heart', system: '', openai: 'alloy', elevenlabs: '' }, style: '', v: 2 },
};
const TTS_NAMES = { kokoro: 'Free AI', system: 'Built-in', openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const NEEDS_KEY = new Set(['openai', 'elevenlabs']);
const TTS_MAX = 1000;

const $ = (s) => document.querySelector(s);
const echo = window.echo;

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

  async start(s) {
    await this.shutdown();
    this.main = new AudioContext({ latencyHint: 'interactive' });
    this.mon = new AudioContext({ latencyHint: 'interactive' });
    this.routeOk = !!s.cableDevice && (await setSink(this.main, s.cableDevice));
    await setSink(this.mon, s.monitorDevice);

    this.mainOut = this.main.createGain();
    this.mainOut.connect(this.main.destination);
    this.monOut = this.mon.createGain();
    this.monOut.connect(this.mon.destination);
    this.micGain = this.main.createGain();
    this.micGain.connect(this.main.destination);

    this.micError = null;
    // Only pass the mic through when it's going into a cable — never to speakers (feedback).
    if (this.routeOk && s.micEnabled) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: s.micDevice ? { exact: s.micDevice } : undefined,
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

const midi = { access: null, input: null, output: null, sysex: false };

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
  connectMidi();
}

function livePorts(map) { return [...map.values()].filter((p) => p.state !== 'disconnected'); }

function pickPort(ports, saved, allowFallback) {
  if (saved === 'none') return null;
  if (saved) { const p = ports.find((x) => x.name === saved); if (p) return p; }
  const lp = ports.filter((p) => LAUNCHPAD_RE.test(p.name));
  const best = lp.find((p) => !/daw/i.test(p.name)) || lp[0];
  if (best) return best;
  return allowFallback ? ports[0] || null : null;
}

function connectMidi() {
  if (!midi.access) return;
  const inp = pickPort(livePorts(midi.access.inputs), state.settings.midiIn, true);
  const out = pickPort(livePorts(midi.access.outputs), state.settings.midiOut, false);

  if ((inp && inp.id) !== (midi.input && midi.input.id)) {
    if (midi.input) midi.input.onmidimessage = null;
    midi.input = inp;
    if (inp) inp.onmidimessage = onMidi;
  }
  if ((out && out.id) !== (midi.output && midi.output.id)) {
    midi.output = out;
    if (out) {
      enterProgrammerMode();
      setTimeout(ledAll, 200);
    }
  }
  updateChips();
}

function enterProgrammerMode() {
  if (!midi.output || !midi.sysex) return;
  // Launchpad X (0x0C), Mini MK3 (0x0D), Pro MK3 (0x0E). Devices ignore IDs that aren't theirs.
  for (const id of [0x0c, 0x0d, 0x0e]) {
    try { midi.output.send([0xf0, 0x00, 0x20, 0x29, 0x02, id, 0x0e, 0x01, 0xf7]); } catch { /* ignore */ }
  }
}

function leaveProgrammerMode() {
  if (!midi.output) return;
  state.pads.forEach((p) => sendLed(p.trigger, 0, 0));
  if (state.stopAllTrigger) sendLed(state.stopAllTrigger, 0, 0);
  if (!midi.sysex) return;
  for (const id of [0x0c, 0x0d, 0x0e]) {
    try { midi.output.send([0xf0, 0x00, 0x20, 0x29, 0x02, id, 0x0e, 0x00, 0xf7]); } catch { /* ignore */ }
  }
}

function onMidi(e) {
  const [st, d1, d2 = 0] = e.data;
  const kind = st & 0xf0;
  let type, down;
  if (kind === 0x90) { type = 'note'; down = d2 > 0; }
  else if (kind === 0x80) { type = 'note'; down = false; }
  else if (kind === 0xb0) { type = 'cc'; down = d2 > 0; }
  else return;

  if (down && learnTarget !== null) { finishLearn({ type, num: d1 }); return; }

  const key = type + ':' + d1;
  if (state.stopAllTrigger && key === trigKey(state.stopAllTrigger)) { if (down) stopAll(); return; }
  const i = triggerMap.get(key);
  if (i === undefined) return;
  if (down) press(i); else release(i);
}

// channel offset: 0 = static, 1 = flashing, 2 = pulsing (Launchpad Programmer mode)
function sendLed(trig, color, chan) {
  if (!midi.output || !trig) return;
  const st = (trig.type === 'cc' ? 0xb0 : 0x90) | chan;
  try { midi.output.send([st, trig.num, color]); } catch { /* ignore */ }
}

function led(i) {
  const pad = state.pads[i];
  if (!pad) return;
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
  if (state.stopAllTrigger) sendLed(state.stopAllTrigger, 5, 0);
}

/* ---------------- Learn ---------------- */

function startLearn(target) {
  learnTarget = target;
  renderEditor();
  renderSettingsLearn();
  if (!midi.input) toast('No MIDI controller connected. Plug in your Launchpad first.');
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
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        el.classList.remove('drop');
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

function renderPad(i) {
  const el = padEls[i];
  const pad = state.pads[i];
  if (!el || !pad) return;
  el.style.setProperty('--pc', colorById(pad.color).hex);
  el.classList.toggle('assigned', !!pad.file);
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
  if (midi.input) setChip('#chip-midi', 'ok', midi.input.name, 'Controller: ' + midi.input.name);
  else setChip('#chip-midi', 'warn', 'No controller', 'Plug in your Launchpad');

  if (engine.routeOk) {
    const name = deviceLabel(audioDevices.outs, state.settings.cableDevice) || 'virtual cable';
    setChip('#chip-out', 'ok', 'Voice chat: ' + name);
  } else {
    setChip('#chip-out', 'warn', 'No virtual cable', 'Sounds only play in your headphones. Click for setup help.');
  }

  const s = state.settings;
  const micLabel = s.micDevice ? deviceLabel(audioDevices.ins, s.micDevice) : (audioDevices.defaultInLabel || '');
  if (!engine.routeOk || !s.micEnabled) setChip('#chip-mic', '', 'Mic off');
  else if (engine.micError) setChip('#chip-mic', 'bad', 'Mic error', engine.micError);
  else if (CABLE_MIC_RE.test(micLabel)) setChip('#chip-mic', 'bad', 'Mic is the cable!', 'Your mic is set to the virtual cable, which loops. Pick your real mic.');
  else setChip('#chip-mic', 'ok', 'Mic on', micLabel || 'System default mic');
}

function progressLoop() {
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
    opt.textContent = o.t;
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
  fillSelect('#set-midi-in', [{ v: '', t: 'Auto (find Launchpad)' }, { v: 'none', t: 'None' }, ...ins], state.settings.midiIn);
  fillSelect('#set-midi-out', [{ v: '', t: 'Auto (find Launchpad)' }, { v: 'none', t: 'None (no lights)' }, ...outs], state.settings.midiOut);
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
  audioDevices = {
    ins: devs.filter((d) => d.kind === 'audioinput' && real(d)),
    outs: devs.filter((d) => d.kind === 'audiooutput' && real(d)),
    defaultInLabel: defIn ? defIn.label : '',
  };

  let changed = false;
  if (state.settings.cableDevice === null) {
    const c = audioDevices.outs.find((d) => CABLE_OUT_RE.test(d.label));
    if (c) { state.settings.cableDevice = c.deviceId; changed = true; save(); }
  }

  const lbl = (d, n) => d.label || n;
  fillSelect('#set-cable', [{ v: '', t: 'None (headphones only)' },
    ...audioDevices.outs.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Output ' + (n + 1)) }))], state.settings.cableDevice || '');
  fillSelect('#set-mic', [{ v: '', t: 'System default' },
    ...audioDevices.ins.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Input ' + (n + 1)) }))], state.settings.micDevice);
  fillSelect('#set-monitor', [{ v: '', t: 'System default' },
    ...audioDevices.outs.map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Output ' + (n + 1)) }))], state.settings.monitorDevice);
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
    await engine.start(state.settings);
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

function openSettings() {
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
  $('#chip-out').addEventListener('click', () => open(engine.routeOk ? 'settings' : 'help'));
  $('#chip-mic').addEventListener('click', () => open('settings'));
  $('#chip-midi').addEventListener('click', () => open('settings'));
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
  renderEditor();
  renderTts();
  renderLevels();
  renderSettingsLearn();
  updateChips();

  await refreshAudioDevices();
  await engine.start(state.settings);
  updateChips();
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const before = engine.routeOk;
    await refreshAudioDevices();
    if (!before && state.settings.cableDevice) restartAudio(); else updateChips();
  });

  // Warm up decoded audio so the first press is instant.
  state.pads.forEach((p, i) => {
    if (p.file) engine.load(p.file).catch(() => { missing.add(i); renderPad(i); });
  });

  await initMidi();
  await refreshKeyStatus();
  loadTtsVoices();
  requestAnimationFrame(progressLoop);
}

boot().catch((e) => { console.error(e); toast('Startup error: ' + (e.message || e)); });
