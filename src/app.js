'use strict';

/* ============================================================
   Echo Board — renderer (everything runs on this computer)
   - Engine: mixes mic (+ voice effects) and clips into the virtual cable,
     clips into your headphones, optional extra output for OBS.
   - Profiles > 8 pages > 64 pads. Launchpad buttons and keyboard
     shortcuts belong to grid positions (and to actions).
   - MIDI: Launchpad presses trigger pads/actions; lights follow pad colors.
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
const PAGES = 8;
const PADS = 64;
const TTS_MAX = 1000;
const IS_MAC = echo.platform === 'darwin';

const ACTIONS = [
  { id: 'replay', name: 'Save instant replay', trigger: { type: 'cc', num: 89 }, hotkey: null, lp: [5, 7] },
  { id: 'fxToggle', name: 'Voice effect on/off', trigger: { type: 'cc', num: 79 }, hotkey: null, lp: [49, 51] },
  { id: 'fxNext', name: 'Next voice effect', trigger: { type: 'cc', num: 69 }, hotkey: null, lp: [51, 51] },
  { id: 'pagePrev', name: 'Previous page', trigger: null, hotkey: null, lp: [1, 1] },
  { id: 'pageNext', name: 'Next page', trigger: null, hotkey: null, lp: [1, 1] },
  { id: 'stopAll', name: 'Stop all sounds', trigger: { type: 'cc', num: 19 }, hotkey: 'CommandOrControl+Shift+K', lp: [5, 5] },
];
const actionDef = (id) => ACTIONS.find((a) => a.id === id);

const DEFAULT_SETTINGS = {
  midiIn: '',        // port name ('' = auto, 'none' = off)
  midiOut: '',
  topRowPages: true,
  micDevice: '',     // '' = automatic
  cableDevice: null, // null = not chosen yet (auto-detect), '' = none
  monitorDevice: '', // '' = automatic
  micEnabled: true,
  micVolume: 1,
  masterVolume: 0.8,
  monitorVolume: 0.8,
  evenVolume: true,
  cableSetupShown: false,
  tts: { provider: 'kokoro', voice: { kokoro: 'af_heart', system: '', openai: 'alloy', elevenlabs: '' }, style: '', v: 3 },
  fx: { on: false, effect: 'deep', mix: 1, hearSelf: false },
  ptt: { enabled: false, code: null, tailMs: 300 },
  duck: { mic: false, micLevel: 0.35, sounds: false, soundsLevel: 0.4 },
  replay: { enabled: false, seconds: 30, includeMic: true },
  extra: { device: '', includeVoice: false },
};
const TTS_NAMES = { kokoro: 'Free AI', system: 'Built-in', openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const NEEDS_KEY = new Set(['openai', 'elevenlabs']); // online, optional: only with your own key

const $ = (s) => document.querySelector(s);
// `echo` (the bridge to the desktop side) is provided globally by preload.js; don't redeclare it.

const state = {
  profiles: [],
  profileId: null,
  slots: [],          // 64 grid positions: { trigger, hotkey }
  actions: {},        // id -> { trigger, hotkey }
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  pads: [],           // pads of the current page (a reference into the profile)
};
let selected = 0;
let learnTarget = null; // pad index or 'action:<id>'
const missing = new Set();
const padEls = [];
let triggerMap = new Map();
let audioDevices = { ins: [], outs: [] };

// Pads are indexed bottom-left = 0, top-right = 63, matching Launchpad Programmer mode
// where the note is (row+1)*10 + (col+1).
const emptyPad = () => ({ name: '', file: null, volume: 0.8, color: 'blue', mode: 'oneshot', choke: false, start: 0, end: null });
const defaultTrigger = (i) => ({ type: 'note', num: (Math.floor(i / 8) + 1) * 10 + (i % 8) + 1 });
const emptyPage = (n) => ({ name: '', pads: Array.from({ length: PADS }, emptyPad) });
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const newProfile = (name) => ({ id: newId(), name, page: 0, pages: Array.from({ length: PAGES }, (_, n) => emptyPage(n)) });

const profile = () => state.profiles.find((p) => p.id === state.profileId) || state.profiles[0];
const curPage = () => profile().pages[profile().page];
const pageName = (pg, n) => (pg.name || '').trim() || 'Page ' + (n + 1);
const vk = (i) => `${profile().id}:${profile().page}:${i}`; // key of a playing pad voice

const padLabel = (i) => String.fromCharCode(65 + (7 - Math.floor(i / 8))) + ((i % 8) + 1);
const trigKey = (t) => (t ? t.type + ':' + t.num : '');
const trigText = (t) => (t ? (t.type === 'cc' ? 'CC ' : 'Note ') + t.num : 'Not set');
const fmtTime = (s) => (s == null ? '' : (s < 10 ? s.toFixed(2) : s.toFixed(1)) + 's');

function rebuildTriggerMap() {
  triggerMap = new Map();
  state.slots.forEach((s, i) => { if (s.trigger) triggerMap.set(trigKey(s.trigger), { kind: 'pad', i }); });
  for (const a of ACTIONS) {
    const t = state.actions[a.id] && state.actions[a.id].trigger;
    if (t && !triggerMap.has(trigKey(t))) triggerMap.set(trigKey(t), { kind: 'action', id: a.id });
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    echo.saveConfig({
      version: 2, profiles: state.profiles, profileId: state.profileId,
      slots: state.slots, actions: state.actions, settings: state.settings,
    }).catch((e) => console.error('save failed', e));
  }, 250);
}

const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
    this.extra = null;  // -> optional extra output (OBS)
    this.voices = new Map();
    this.buffers = new Map();
    this.norm = new Map();
    this.mic = null;
    this.routeOk = false;
    this.micError = null;
    this.fx = null;
    this.talking = false;
    this.talkUntil = 0;
    this.onVoiceEnd = () => {};
    this.onVoicesChanged = () => {};
  }

  async start(s, dev = { mic: s.micDevice, monitor: s.monitorDevice }) {
    await this.shutdown();
    // Voice-chat mix: 48 kHz to match Discord and VB-CABLE, with a little more buffer than the
    // headphone mix so it doesn't crackle when the computer is busy (e.g. a game is running).
    this.main = new AudioContext({ latencyHint: 'balanced', sampleRate: 48000 });
    this.mon = new AudioContext({ latencyHint: 'interactive' });
    this.routeOk = !!s.cableDevice && (await setSink(this.main, s.cableDevice));
    await setSink(this.mon, dev.monitor);
    this.worklets = false;
    try { await this.main.audioWorklet.addModule('worklets.js'); this.worklets = true; }
    catch (e) { console.warn('Audio worklets unavailable', e); }
    this.monWorklets = false;
    try { await this.mon.audioWorklet.addModule('worklets.js'); this.monWorklets = true; } catch { /* playback pitch effects off */ }

    // Everything friends hear goes through one limiter, so voice + a loud sound never clip.
    const m = this.main;
    this.mixBus = m.createGain();
    this.limiter = m.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    const ceiling = m.createGain();
    ceiling.gain.value = 0.9;
    this.meter = m.createAnalyser();
    this.meter.fftSize = 1024;
    this.mixBus.connect(this.limiter);
    this.limiter.connect(ceiling);
    ceiling.connect(m.destination);
    this.mixBus.connect(this.meter);

    // Sounds: mainOut -> soundsDuck -> mix
    this.mainOut = m.createGain();
    this.soundsDuck = m.createGain();
    this.mainOut.connect(this.soundsDuck);
    this.soundsDuck.connect(this.mixBus);
    this.monOut = this.mon.createGain();
    this.monOut.connect(this.mon.destination);

    // Mic: source -> voice effects -> micDuck -> micGain -> mix
    this.fx = new VoiceFX(m, { pitchAvailable: this.worklets });
    this.micDuck = m.createGain();
    this.micGain = m.createGain();
    this.fx.output.connect(this.micDuck);
    this.micDuck.connect(this.micGain);
    this.micGain.connect(this.mixBus);
    this.micLevel = m.createAnalyser();
    this.micLevel.fftSize = 512;
    // Your processed voice as a stream, for "hear myself" and the extra output
    this.voiceStream = m.createMediaStreamDestination();
    this.micGain.connect(this.voiceStream);

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
        const src = m.createMediaStreamSource(this.mic);
        src.connect(this.fx.input);
        src.connect(this.micLevel);
      } catch (e) {
        this.micError = e.message || String(e);
      }
    }

    // Hear myself (headphones)
    this.selfGain = this.mon.createGain();
    this.selfGain.gain.value = 0;
    try { this.mon.createMediaStreamSource(this.voiceStream.stream).connect(this.selfGain); } catch { /* ignore */ }
    this.selfGain.connect(this.mon.destination);

    // Extra output (OBS / recording)
    if (s.extra && s.extra.device) {
      this.extra = new AudioContext({ latencyHint: 'balanced' });
      if (await setSink(this.extra, s.extra.device)) {
        this.extraOut = this.extra.createGain();
        this.extraOut.connect(this.extra.destination);
        this.extraVoice = this.extra.createGain();
        this.extraVoice.gain.value = s.extra.includeVoice ? 1 : 0;
        try { this.extra.createMediaStreamSource(this.voiceStream.stream).connect(this.extraVoice); } catch { /* ignore */ }
        this.extraVoice.connect(this.extra.destination);
      } else {
        try { await this.extra.close(); } catch { /* ignore */ }
        this.extra = null;
      }
    }

    this.applyFx(s.fx);
    this.setLevels(s);
    try { await m.resume(); await this.mon.resume(); if (this.extra) await this.extra.resume(); } catch { /* ignore */ }
  }

  applyFx(f) {
    if (!this.fx || !f) return;
    this.fx.setEffect(f.effect);
    this.fx.setMix(f.mix);
    this.fx.setEnabled(f.on);
    if (this.selfGain) this.selfGain.gain.setTargetAtTime(f.hearSelf ? 1 : 0, this.mon.currentTime, 0.02);
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

  // Ducking: lower the mic under sounds, or sounds under your voice.
  updateDucking(d) {
    if (!this.main || !d) return;
    let rms = 0;
    if (this.mic && this.micLevel) {
      const buf = new Float32Array(this.micLevel.fftSize);
      this.micLevel.getFloatTimeDomainData(buf);
      for (const v of buf) rms += v * v;
      rms = Math.sqrt(rms / buf.length);
    }
    const now = performance.now();
    if (rms > 0.025) this.talkUntil = now + 300;
    this.talking = now < this.talkUntil;
    const playing = this.voices.size > 0;
    const t = this.main.currentTime;
    this.micDuck.gain.setTargetAtTime(d.mic && playing ? d.micLevel : 1, t, 0.06);
    this.soundsDuck.gain.setTargetAtTime(d.sounds && this.talking ? d.soundsLevel : 1, t, 0.08);
  }

  setLevels(s) {
    if (!this.main) return;
    this.mainOut.gain.value = this.routeOk ? s.masterVolume : 0;
    this.monOut.gain.value = s.monitorVolume;
    this.micGain.gain.value = s.micVolume;
    if (this.extraOut) this.extraOut.gain.value = 1;
    if (this.extraVoice) this.extraVoice.gain.value = s.extra && s.extra.includeVoice ? 1 : 0;
  }

  async shutdown() {
    this.stopAll();
    if (typeof fxTest !== 'undefined' && fxTest.src) stopFxTest();
    if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
    for (const c of [this.main, this.mon, this.extra]) { if (c) { try { await c.close(); } catch { /* ignore */ } } }
    this.main = this.mon = this.extra = null;
    this.extraOut = this.extraVoice = null;
    this.fx = null;
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

  // Gain that brings a clip (its trimmed part) to a common loudness.
  normGain(file, buf, start, end) {
    const key = `${file}|${start}|${end}`;
    if (this.norm.has(key)) return this.norm.get(key);
    const a = Math.floor(start * buf.sampleRate), b = Math.min(buf.length, Math.floor(end * buf.sampleRate));
    let sum = 0, n = 0;
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
      const d = buf.getChannelData(c);
      for (let i = a; i < b; i += 4) { sum += d[i] * d[i]; n++; }
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    const g = rms > 1e-4 ? Math.max(0.35, Math.min(3, 0.12 / rms)) : 1;
    this.norm.set(key, g);
    return g;
  }

  async play(key, pad, { normalize = true } = {}) {
    const buf = await this.load(pad.file);
    if (!buf || !this.main) return false;
    this.stop(key);
    const loop = pad.mode === 'loop';
    const start = Math.max(0, Math.min(pad.start || 0, buf.duration - 0.01));
    const end = pad.end ? Math.max(start + 0.01, Math.min(pad.end, buf.duration)) : buf.duration;
    const dur = end - start;
    const level = (pad.volume == null ? 1 : pad.volume) * (normalize && state.settings.evenVolume ? this.normGain(pad.file, buf, start, end) : 1);
    const mk = (ctx, out) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = level;
      src.connect(g);
      g.connect(out);
      if (loop) { src.loop = true; src.loopStart = start; src.loopEnd = end; src.start(0, start); }
      else src.start(0, start, dur);
      return src;
    };
    const srcs = [mk(this.main, this.mainOut), mk(this.mon, this.monOut)];
    if (this.extra && this.extraOut) srcs.push(mk(this.extra, this.extraOut));
    const v = { srcs, t0: performance.now(), dur, loop };
    const ended = () => {
      if (this.voices.get(key) !== v) return;
      this.voices.delete(key);
      v.srcs.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
      this.onVoiceEnd(key);
      this.onVoicesChanged();
    };
    v.srcs[0].onended = ended;
    v.srcs[1].onended = ended;
    this.voices.set(key, v);
    this.onVoicesChanged();
    return true;
  }

  stop(key) {
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    v.srcs.forEach((s) => { try { s.stop(); } catch { /* ignore */ } });
    this.onVoiceEnd(key);
    this.onVoicesChanged();
  }

  stopAll() { for (const k of [...this.voices.keys()]) this.stop(k); }
  isPlaying(key) { return this.voices.has(key); }

  progress(key) {
    const v = this.voices.get(key);
    if (!v || !v.dur) return 0;
    const t = (performance.now() - v.t0) / 1000;
    return v.loop ? (t % v.dur) / v.dur : Math.min(1, t / v.dur);
  }
}

const engine = new Engine();
engine.onVoiceEnd = (key) => {
  if (key === 'tts') { renderTts(); return; }
  const i = padIndexOfKey(key);
  if (i !== null) { renderPad(i); led(i); }
};
engine.onVoicesChanged = () => updatePtt();

// Index of a playing voice if it belongs to the page on screen
function padIndexOfKey(key) {
  const parts = String(key).split(':');
  if (parts.length !== 3) return null;
  const [pid, pg, i] = parts;
  if (pid !== profile().id || Number(pg) !== profile().page) return null;
  return Number(i);
}

/* ---------------- Pad actions ---------------- */

async function press(i) {
  const pad = state.pads[i];
  if (!pad || !pad.file) return;
  const key = vk(i);
  if ((pad.mode === 'toggle' || pad.mode === 'loop') && engine.isPlaying(key)) {
    engine.stop(key);
    return;
  }
  if (pad.choke) for (const k of [...engine.voices.keys()]) if (k !== key) engine.stop(k);
  try {
    if (await engine.play(key, pad)) {
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
  if (pad && pad.mode === 'hold') engine.stop(vk(i));
}

function stopAll() {
  engine.stopAll();
  if (learnTarget !== null) cancelLearn();
}

async function assignFile(i, picked, opts = {}) {
  if (!picked) return;
  const pad = state.pads[i];
  engine.stop(vk(i));
  pad.file = picked.path;
  pad.name = picked.name;
  pad.start = 0;
  pad.end = null;
  if (opts.color) pad.color = opts.color;
  missing.delete(i);
  engine.load(pad.file).catch(() => { missing.add(i); renderPad(i); toast('That file could not be decoded.'); });
  renderPad(i);
  if (i === selected) renderEditor();
  led(i);
  renderPages();
  save();
}

function clearPad(i) {
  engine.stop(vk(i));
  state.pads[i] = emptyPad();
  missing.delete(i);
  renderPad(i);
  renderEditor();
  led(i);
  renderPages();
  save();
}

/* ---------------- Pages & profiles ---------------- */

function useCurrentPage() {
  state.pads = curPage().pads;
  missing.clear();
}

function rerenderBoard() {
  state.pads.forEach((_, i) => renderPad(i));
  renderEditor();
  renderPages();
  renderProfileButton();
  ledAll();
  renderTts();
}

function switchPage(n) {
  n = ((n % PAGES) + PAGES) % PAGES;
  if (n === profile().page) return;
  if (learnTarget !== null) cancelLearn();
  profile().page = n;
  useCurrentPage();
  rerenderBoard();
  warmPage();
  save();
}

function switchProfile(id) {
  if (!state.profiles.some((p) => p.id === id) || id === state.profileId) return;
  state.profileId = id;
  useCurrentPage();
  rerenderBoard();
  warmPage();
  renderProfiles();
  save();
  toast('Profile: ' + profile().name);
}

function warmPage() {
  state.pads.forEach((p, i) => { if (p.file) engine.load(p.file).catch(() => { missing.add(i); renderPad(i); }); });
}

function renderPages() {
  const nav = $('#pages');
  if (!nav) return;
  if (!nav.children.length) {
    for (let n = 0; n < PAGES; n++) {
      const b = document.createElement('button');
      b.className = 'page-tab';
      b.dataset.page = n;
      b.addEventListener('click', () => switchPage(n));
      b.addEventListener('dblclick', () => renamePage(n, b));
      b.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(PAD_DRAG_TYPE)) return;
        e.preventDefault();
        b.classList.add('drop');
      });
      b.addEventListener('dragleave', () => b.classList.remove('drop'));
      b.addEventListener('drop', (e) => {
        b.classList.remove('drop');
        if (!e.dataTransfer.types.includes(PAD_DRAG_TYPE)) return;
        e.preventDefault();
        movePadToPage(Number(e.dataTransfer.getData(PAD_DRAG_TYPE)), n, e.ctrlKey || e.altKey);
      });
      nav.appendChild(b);
    }
  }
  const pr = profile();
  [...nav.children].forEach((b, n) => {
    const pg = pr.pages[n];
    if (b.querySelector('input')) return;
    b.textContent = pageName(pg, n);
    b.title = pageName(pg, n) + ' (double-click to rename' + (state.settings.topRowPages ? `, Launchpad top button ${n + 1}` : '') + ')';
    b.classList.toggle('current', n === pr.page);
    b.classList.toggle('has', pg.pads.some((p) => p.file));
  });
}

function renamePage(n, tab) {
  const pg = profile().pages[n];
  const input = document.createElement('input');
  input.className = 'page-rename';
  input.value = pg.name || '';
  input.placeholder = 'Page ' + (n + 1);
  input.maxLength = 18;
  tab.textContent = '';
  tab.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    pg.name = input.value.trim();
    input.remove();
    renderPages();
    save();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { input.value = pg.name || ''; done(); } e.stopPropagation(); });
  input.addEventListener('blur', done);
}

function movePadToPage(from, n, copy) {
  if (Number.isNaN(from) || !state.pads[from] || !state.pads[from].file) return;
  if (n === profile().page) return;
  const dest = profile().pages[n].pads;
  let to = dest[from].file ? dest.findIndex((p) => !p.file) : from;
  if (to < 0) { toast(`${pageName(profile().pages[n], n)} is full.`); return; }
  dest[to] = { ...emptyPad(), ...padContent(state.pads[from]) };
  if (!copy) { engine.stop(vk(from)); state.pads[from] = emptyPad(); missing.delete(from); renderPad(from); led(from); }
  renderEditor();
  renderPages();
  ledPages();
  save();
  toast(`${copy ? 'Copied' : 'Moved'} to ${pageName(profile().pages[n], n)}, pad ${padLabel(to)}`);
}

function renderProfileButton() {
  $('#btn-profile').textContent = profile().name + ' ▾';
}

function renderProfiles() {
  const list = $('#profile-list');
  list.innerHTML = '';
  for (const p of state.profiles) {
    const b = document.createElement('button');
    b.className = 'profile-item' + (p.id === state.profileId ? ' current' : '');
    const count = p.pages.reduce((n, pg) => n + pg.pads.filter((x) => x.file).length, 0);
    b.innerHTML = '<span class="pi-name"></span><span class="pi-count muted"></span>';
    b.querySelector('.pi-name').textContent = p.name;
    b.querySelector('.pi-count').textContent = count + (count === 1 ? ' sound' : ' sounds');
    b.addEventListener('click', () => switchProfile(p.id));
    list.appendChild(b);
  }
  $('#profile-name').value = profile().name;
  $('#profile-del').disabled = state.profiles.length < 2;
}

function wireProfiles() {
  $('#btn-profile').addEventListener('click', () => { renderProfiles(); $('#profiles').classList.remove('hidden'); });
  $('#profile-name').addEventListener('input', (e) => {
    profile().name = e.target.value.trim().slice(0, 30) || 'Untitled';
    renderProfileButton();
    renderProfiles();
    save();
  });
  $('#profile-name').addEventListener('keydown', (e) => e.stopPropagation());
  $('#profile-new').addEventListener('click', () => {
    const p = newProfile('Profile ' + (state.profiles.length + 1));
    state.profiles.push(p);
    switchProfile(p.id);
    $('#profile-name').focus();
    $('#profile-name').select();
  });
  $('#profile-dup').addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(profile()));
    copy.id = newId();
    copy.name = (profile().name + ' copy').slice(0, 30);
    state.profiles.push(copy);
    switchProfile(copy.id);
  });
  $('#profile-del').addEventListener('click', () => {
    if (state.profiles.length < 2) return;
    const btn = $('#profile-del');
    if (!btn.dataset.confirm) { btn.dataset.confirm = '1'; btn.textContent = 'Click again to delete'; setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Delete'; }, 3000); return; }
    delete btn.dataset.confirm;
    btn.textContent = 'Delete';
    const gone = profile();
    state.profiles = state.profiles.filter((p) => p.id !== gone.id);
    for (const k of [...engine.voices.keys()]) if (String(k).startsWith(gone.id + ':')) engine.stop(k);
    state.profileId = state.profiles[0].id;
    useCurrentPage();
    rerenderBoard();
    renderProfiles();
    save();
    toast(`Deleted "${gone.name}"`);
  });
}

/* ---------------- Actions (buttons & shortcuts) ---------------- */

function runAction(id) {
  switch (id) {
    case 'stopAll': stopAll(); break;
    case 'replay': saveReplay(); break;
    case 'fxToggle': setFx({ on: !state.settings.fx.on }); toast('Voice effect ' + (state.settings.fx.on ? 'on: ' + fxName() : 'off')); break;
    case 'fxNext': {
      const i = VOICE_EFFECTS.findIndex((e) => e.id === state.settings.fx.effect);
      setFx({ effect: VOICE_EFFECTS[(i + 1) % VOICE_EFFECTS.length].id, on: true });
      toast('Voice effect: ' + fxName());
      break;
    }
    case 'pagePrev': switchPage(profile().page - 1); break;
    case 'pageNext': switchPage(profile().page + 1); break;
    default: break;
  }
}

function renderActions() {
  const list = $('#action-list');
  if (!list) return;
  if (!list.children.length) {
    for (const a of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'action-row';
      row.dataset.id = a.id;
      row.innerHTML = '<span class="action-name"></span><span class="action-trig muted"></span>' +
        '<button class="btn small" data-learn>Learn button</button><button class="btn small" data-key>Set shortcut</button>' +
        '<button class="btn ghost small icon-x" data-clear title="Remove button and shortcut">&times;</button>';
      row.querySelector('.action-name').textContent = a.name;
      row.querySelector('[data-learn]').addEventListener('click', () => {
        const t = 'action:' + a.id;
        if (learnTarget === t) cancelLearn(); else startLearn(t);
      });
      row.querySelector('[data-key]').addEventListener('click', () => captureShortcut((accel) => {
        state.actions[a.id].hotkey = accel;
        save(); syncHotkeys(); renderActions();
      }));
      row.querySelector('[data-clear]').addEventListener('click', () => {
        const t = state.actions[a.id].trigger;
        if (t) sendLedRaw(t, 0);
        state.actions[a.id] = { trigger: null, hotkey: null };
        rebuildTriggerMap(); save(); syncHotkeys(); renderActions();
      });
      list.appendChild(row);
    }
  }
  for (const row of list.children) {
    const id = row.dataset.id;
    const st = state.actions[id];
    const learning = learnTarget === 'action:' + id;
    const parts = [];
    if (st.trigger) parts.push(lpButtonName(st.trigger));
    if (st.hotkey) parts.push(accelLabel(st.hotkey));
    row.querySelector('.action-trig').textContent = learning ? 'Press a Launchpad button…' : parts.join(' · ') || 'Not set';
    const lb = row.querySelector('[data-learn]');
    lb.textContent = learning ? 'Cancel' : 'Learn button';
    lb.classList.toggle('learning', learning);
  }
}

// Friendly names for Launchpad buttons outside the grid
function lpButtonName(t) {
  if (!t) return 'Not set';
  if (t.type === 'cc' && t.num >= 91 && t.num <= 98) return 'Top button ' + (t.num - 90);
  if (t.type === 'cc' && t.num % 10 === 9 && t.num >= 19 && t.num <= 89) return 'Right button ' + (9 - Math.floor(t.num / 10) + 1);
  if (t.type === 'note') {
    const r = Math.floor(t.num / 10) - 1, c = (t.num % 10) - 1;
    if (r >= 0 && r < 8 && c >= 0 && c < 8) return 'Pad ' + padLabel(r * 8 + c);
  }
  return trigText(t);
}

/* ---------------- Keyboard shortcuts (global) ---------------- */

const ACCEL_KEYS = {
  Space: 'Space', Tab: 'Tab', Enter: 'Return', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Insert: 'Insert', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
function codeToAccelKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
  return ACCEL_KEYS[code] || null;
}
const accelLabel = (a) => String(a || '')
  .replace('CommandOrControl', IS_MAC ? 'Cmd' : 'Ctrl').replace('Command', 'Cmd')
  .replace(/num(\d)/, 'Num $1').replace('numadd', 'Num +').replace('numsub', 'Num -').replace('nummult', 'Num *').replace('numdiv', 'Num /').replace('numdec', 'Num .')
  .replace(/\+/g, ' + ').replace(/ \+  \+ /, ' + +');

let capturing = null;
function showCaptureHint(text) {
  const h = $('#capture-hint');
  h.textContent = text;
  h.classList.toggle('hidden', !text);
}

// Next key combo pressed becomes a global shortcut. Plain letters need a modifier so normal typing isn't hijacked.
function captureShortcut(onDone) {
  if (capturing) capturing.cancel();
  showCaptureHint('Press the shortcut (for example Ctrl+1 or F13)… Esc cancels');
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
    if (e.code === 'Escape') { finish(); return; }
    const key = codeToAccelKey(e.code);
    if (!key) { showCaptureHint("That key can't be used. Try another (Esc cancels)"); return; }
    const mods = [];
    if (e.ctrlKey || (IS_MAC && e.metaKey)) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const special = /^F\d+$/.test(key) || /^num/.test(key);
    if (!mods.length && !special) { showCaptureHint('Add Ctrl, Alt or Shift (or use F13–F24 / numpad keys) so normal typing still works'); return; }
    const accel = [...mods, key].join('+');
    const clash = findShortcutOwner(accel);
    if (clash) { showCaptureHint(`Already used by ${clash}. Pick another (Esc cancels)`); return; }
    finish();
    onDone(accel);
  };
  const finish = () => { window.removeEventListener('keydown', onKey, true); capturing = null; showCaptureHint(''); };
  window.addEventListener('keydown', onKey, true);
  capturing = { cancel: finish };
}

function findShortcutOwner(accel) {
  const i = state.slots.findIndex((s) => s.hotkey === accel);
  if (i >= 0) return 'pad ' + padLabel(i);
  const a = ACTIONS.find((x) => state.actions[x.id].hotkey === accel);
  return a ? a.name : null;
}

let hotkeyFailHint = '';
async function syncHotkeys() {
  const list = [];
  state.slots.forEach((s, i) => { if (s.hotkey) list.push({ id: 'pad:' + i, accel: s.hotkey }); });
  for (const a of ACTIONS) if (state.actions[a.id].hotkey) list.push({ id: 'action:' + a.id, accel: state.actions[a.id].hotkey });
  try {
    const r = await echo.setHotkeys(list);
    const failed = (r && r.failed) || [];
    const msg = failed.map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => accelLabel(x.accel)).join(', ');
    if (msg && msg !== hotkeyFailHint) toast(`Shortcut ${msg} is already used by another app. Pick a different one.`, 4000);
    hotkeyFailHint = msg;
  } catch (e) { console.warn('hotkeys', e); }
}

function onHotkey(id) {
  const [kind, rest] = String(id).split(':');
  if (kind === 'action') { runAction(rest); return; }
  if (kind === 'pad') {
    const i = Number(rest);
    if (state.pads[i] && state.pads[i].file) press(i);
    else toast(`Pad ${padLabel(i)} on ${pageName(curPage(), profile().page)} has no sound.`);
  }
}

/* ---------------- Auto push-to-talk ---------------- */

const ptt = { held: false, releaseTimer: null, errorShown: false };
const pttLabel = (code) => !code ? 'Not set'
  : code === 'Mouse4' ? 'Mouse button 4 (back)' : code === 'Mouse5' ? 'Mouse button 5 (forward)'
  : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad(\d)/, 'Num $1').replace(/(Left|Right)$/, ' ($1)').replace('Backquote', '` (backtick)');

async function pttSend(down) {
  const code = state.settings.ptt.code;
  try { await echo.pttPress(code, down); }
  catch (e) {
    if (!ptt.errorShown) { ptt.errorShown = true; toast('Auto push-to-talk: ' + errMsg(e), 5000); }
  }
}

function updatePtt() {
  const p = state.settings.ptt;
  const want = p.enabled && p.code && engine.routeOk && engine.voices.size > 0;
  if (want) {
    clearTimeout(ptt.releaseTimer);
    ptt.releaseTimer = null;
    if (!ptt.held) { ptt.held = true; pttSend(true); }
  } else if (ptt.held && !ptt.releaseTimer) {
    ptt.releaseTimer = setTimeout(() => { ptt.releaseTimer = null; if (ptt.held) { ptt.held = false; pttSend(false); } }, p.tailMs || 300);
  }
}

function capturePttKey(onDone) {
  if (capturing) capturing.cancel();
  showCaptureHint('Press your Discord push-to-talk key or mouse button… Esc cancels');
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') { finish(); return; }
    finish(); onDone(e.code);
  };
  const onMouse = (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault(); e.stopPropagation();
    finish(); onDone(e.button === 3 ? 'Mouse4' : 'Mouse5');
  };
  const finish = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    capturing = null; showCaptureHint('');
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  capturing = { cancel: finish };
}

/* ---------------- Voice changer ---------------- */

const fxName = () => (VOICE_EFFECTS.find((e) => e.id === state.settings.fx.effect) || {}).name || 'Effect';

function setFx(patch) {
  const before = { ...state.settings.fx };
  Object.assign(state.settings.fx, patch);
  engine.applyFx(state.settings.fx);
  const f = state.settings.fx;
  // Cabin "ding-dong" when you switch to Pilot (not when audio restarts)
  if (f.effect === 'pilot' && f.on && (before.effect !== 'pilot' || !before.on) && engine.fx) engine.fx.chime();
  if (fxTest.preview) {
    fxTest.preview.setEffect(f.effect);
    fxTest.preview.setMix(f.mix);
    if (f.effect === 'pilot' && before.effect !== 'pilot') fxTest.preview.chime();
  }
  renderFx();
  ledActions();
  save();
}

function renderFx() {
  const f = state.settings.fx;
  const chip = $('#chip-fx');
  chip.textContent = f.on ? 'Voice: ' + fxName() : 'Voice: Normal';
  chip.className = 'chip fx-chip' + (f.on ? ' on' : '');
  $('#fx-on').checked = f.on;
  $('#fx-state').textContent = f.on ? 'On: ' + fxName() : 'Off';
  $('#fx-mix').value = Math.round(f.mix * 100);
  $('#fx-mix-val').textContent = Math.round(f.mix * 100) + '%';
  $('#fx-hear').checked = f.hearSelf;
  const note = $('#fx-note');
  note.textContent = !engine.routeOk ? 'Set up the virtual cable first so friends hear it.' : !engine.mic ? 'No mic connected.' : engine.worklets ? '' : 'Pitch effects unavailable on this system.';
  document.querySelectorAll('.fx-tile').forEach((t) => t.classList.toggle('on', t.dataset.id === f.effect));
}

/* ---- Test & playback: record your voice, hear it back with effects (headphones only) ---- */
const fxTest = { samples: null, rate: 48000, recording: false, preview: null, src: null };

function renderFxTest(status) {
  const rec = $('#fx-rec'), play = $('#fx-play');
  rec.disabled = fxTest.recording;
  rec.textContent = fxTest.recording ? '● Recording…' : fxTest.samples ? '● Record again' : '● Record 5 seconds';
  play.disabled = !fxTest.samples || fxTest.recording;
  play.textContent = fxTest.src ? '■ Stop' : '▶ Play back';
  if (status != null) $('#fx-test-status').textContent = status;
}

async function recordFxTest(seconds = 5) {
  if (fxTest.recording) return;
  stopFxTest();
  fxTest.recording = true;
  renderFxTest('Getting your mic…');
  let ctx = null, stream = null;
  try {
    const mic = resolveMic();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: mic ? { exact: mic } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('worklets.js');
    const src = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, 'echo-replay-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain(); sink.gain.value = 0;
    const chunks = [];
    tap.port.onmessage = (e) => chunks.push(e.data);
    src.connect(tap); tap.connect(sink); sink.connect(ctx.destination);
    for (let t = seconds; t > 0; t--) {
      renderFxTest(`Talk now… ${t}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    let peak = 0;
    for (const x of out) { const a = Math.abs(x); if (a > peak) peak = a; }
    fxTest.samples = out;
    fxTest.rate = ctx.sampleRate;
    fxTest.recording = false;
    renderFxTest(peak < 0.003 ? "That was silent. Is the right mic picked in Settings?" : 'Got it. Press Play back.');
    if (peak >= 0.003) playFxTest();
  } catch (e) {
    fxTest.recording = false;
    renderFxTest("Couldn't record: " + errMsg(e));
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
  }
}

function stopFxTest() {
  if (fxTest.src) { try { fxTest.src.stop(); } catch { /* ignore */ } }
  fxTest.src = null;
  if (fxTest.preview) { try { fxTest.preview.output.disconnect(); fxTest.preview.setEnabled(false); } catch { /* ignore */ } }
  fxTest.preview = null;
  renderFxTest();
}

function playFxTest() {
  if (!fxTest.samples || !engine.mon) return;
  if (fxTest.src) { stopFxTest(); renderFxTest(''); return; }
  const mon = engine.mon;
  const buf = mon.createBuffer(1, fxTest.samples.length, fxTest.rate);
  buf.copyToChannel(fxTest.samples, 0);
  const f = state.settings.fx;
  const preview = new VoiceFX(mon, { pitchAvailable: engine.monWorklets });
  preview.setEffect(f.effect);
  preview.setMix(f.mix || 1);
  preview.setEnabled(true);
  const out = mon.createGain();
  out.gain.value = Math.max(0.3, state.settings.monitorVolume);
  preview.output.connect(out);
  out.connect(mon.destination);
  const src = mon.createBufferSource();
  src.buffer = buf;
  src.loop = $('#fx-loop').checked;
  src.connect(preview.input);
  src.onended = () => { if (fxTest.src === src) { fxTest.src = null; fxTest.preview = null; renderFxTest('Done. Pick another effect and play again.'); } };
  fxTest.preview = preview;
  fxTest.src = src;
  if (f.effect === 'pilot') preview.chime();
  src.start();
  renderFxTest('Playing with ' + fxName() + '. Click other effects to compare.');
}

function wireFx() {
  $('#fx-rec').addEventListener('click', () => recordFxTest(5));
  $('#fx-play').addEventListener('click', playFxTest);
  $('#fx-loop').addEventListener('change', (e) => { if (fxTest.src) fxTest.src.loop = e.target.checked; });
  const grid = $('#fx-grid');
  for (const e of VOICE_EFFECTS) {
    const b = document.createElement('button');
    b.className = 'fx-tile';
    b.dataset.id = e.id;
    b.innerHTML = '<span class="fx-icon"></span><span class="fx-name"></span>';
    b.querySelector('.fx-icon').textContent = e.icon;
    b.querySelector('.fx-name').textContent = e.name;
    b.addEventListener('click', () => setFx({ effect: e.id, on: true }));
    grid.appendChild(b);
  }
  $('#chip-fx').addEventListener('click', () => { renderFx(); $('#fx').classList.remove('hidden'); });
  $('#fx-on').addEventListener('change', (e) => setFx({ on: e.target.checked }));
  $('#fx-mix').addEventListener('input', (e) => setFx({ mix: Number(e.target.value) / 100 }));
  $('#fx-hear').addEventListener('change', (e) => setFx({ hearSelf: e.target.checked }));
}

/* ---------------- Instant replay (in memory only) ---------------- */

const replay = { chunks: [], node: null, stream: null, sink: null, sources: [], mode: '', error: '' };

function stopReplay() {
  if (replay.node) { try { replay.node.port.postMessage({ on: false }); replay.node.disconnect(); } catch { /* ignore */ } }
  replay.sources.forEach((s) => { try { s.disconnect(); } catch { /* ignore */ } });
  if (replay.stream) replay.stream.getTracks().forEach((t) => t.stop());
  if (replay.sink) { try { replay.sink.disconnect(); } catch { /* ignore */ } }
  replay.node = replay.stream = replay.sink = null;
  replay.sources = [];
  replay.chunks = [];
  replay.mode = '';
}

async function startReplay() {
  stopReplay();
  const r = state.settings.replay;
  if (!r.enabled || !engine.main || !engine.worklets) { renderReplayUi(); return; }
  const m = engine.main;
  const bus = m.createGain();
  replay.sources.push(bus);
  // Windows: capture what you hear (friends + your sounds) locally. Elsewhere: your sounds.
  if (echo.platform === 'win32') {
    let s = null;
    try {
      const id = await echo.replaySource();
      if (id) {
        s = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } },
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } },
        });
      }
    } catch (e) { console.warn('System audio capture unavailable', e); }
    if (s) {
      s.getVideoTracks().forEach((t) => t.stop());
      if (s.getAudioTracks().length) {
        replay.stream = s;
        const src = m.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
        src.connect(bus);
        replay.sources.push(src);
        replay.mode = 'system';
      }
    }
  }
  if (replay.mode !== 'system') { engine.soundsDuck.connect(bus); replay.mode = 'sounds'; }
  if (r.includeMic) engine.micGain.connect(bus);
  const node = new AudioWorkletNode(m, 'echo-replay-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const max = Math.ceil(r.seconds * 10) + 2;
  node.port.onmessage = (e) => {
    replay.chunks.push(e.data);
    if (replay.chunks.length > max) replay.chunks.splice(0, replay.chunks.length - max);
  };
  const sink = m.createGain();
  sink.gain.value = 0;
  bus.connect(node);
  node.connect(sink);
  sink.connect(m.destination);
  replay.node = node;
  replay.sink = sink;
  renderReplayUi();
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// Where a new clip should go: the selected pad if empty, else the first empty pad on this page, then other pages.
function findFreePad() {
  if (!state.pads[selected].file) return { page: profile().page, i: selected };
  let i = state.pads.findIndex((p) => !p.file);
  if (i >= 0) return { page: profile().page, i };
  for (let n = 0; n < PAGES; n++) {
    i = profile().pages[n].pads.findIndex((p) => !p.file);
    if (i >= 0) return { page: n, i };
  }
  return null;
}

async function saveReplay() {
  const r = state.settings.replay;
  if (!r.enabled) { toast('Turn on Instant replay in Settings first.'); openSettings('#set-replay-on'); return; }
  const rate = engine.main ? engine.main.sampleRate : 48000;
  const want = Math.floor(r.seconds * rate);
  let total = 0;
  for (const c of replay.chunks) total += c.length;
  if (total < rate * 0.5) { toast('Nothing recorded yet. Give it a moment.'); return; }
  const out = new Float32Array(Math.min(total, want));
  let pos = out.length;
  for (let k = replay.chunks.length - 1; k >= 0 && pos > 0; k--) {
    const c = replay.chunks[k];
    const n = Math.min(c.length, pos);
    out.set(c.subarray(c.length - n), pos - n);
    pos -= n;
  }
  let peak = 0;
  for (const x of out) { const a = Math.abs(x); if (a > peak) peak = a; }
  if (peak < 0.002) { toast('The replay is silent. Is anything playing through your speakers or headphones?'); return; }
  const g = peak > 0.98 ? 0.98 / peak : 1;
  if (g !== 1) for (let i = 0; i < out.length; i++) out[i] *= g;
  const target = findFreePad();
  if (!target) { toast('Every pad in this profile is full. Clear one first.'); return; }
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  try {
    const saved = await echo.saveSound(encodeWav(out, rate), 'Replay ' + time, 'wav');
    if (target.page === profile().page) {
      await assignFile(target.i, saved, { color: 'red' });
      select(target.i);
    } else {
      profile().pages[target.page].pads[target.i] = { ...emptyPad(), file: saved.path, name: saved.name, color: 'red' };
      renderPages(); save();
    }
    toast(`Replay saved to ${target.page === profile().page ? '' : pageName(profile().pages[target.page], target.page) + ', '}pad ${padLabel(target.i)}. Use Trim to cut it.`, 4000);
  } catch (e) { toast(errMsg(e)); }
}

function renderReplayUi() {
  const r = state.settings.replay;
  $('#btn-replay').classList.toggle('hidden', !r.enabled);
  $('#set-replay-src').textContent = echo.platform === 'win32'
    ? 'It records everything you hear (friends in Discord, your sounds) plus, if you want, your own voice.'
    : 'On Mac it records your soundboard sounds plus, if you want, your own voice.';
  const st = $('#set-replay-status');
  if (!r.enabled) st.textContent = 'Off. Nothing is being recorded.';
  else if (!engine.worklets) st.textContent = 'Replay is unavailable on this system.';
  else if (!replay.node) st.textContent = 'Starting…';
  else st.textContent = `On: keeping the last ${r.seconds} seconds in memory (${replay.mode === 'system' ? 'everything you hear' : 'your sounds'}${r.includeMic ? ' + your voice' : ''}).`;
  ledActions();
}

/* ---------------- Import from video ---------------- */

const vid = { ctx: null, src: null, preview: null, dest: null, start: 0, end: null, name: '', busy: false, stopAt: null };

async function openVideoImport() {
  let picked;
  try { picked = await echo.pickVideo(); } catch (e) { toast(errMsg(e)); return; }
  if (!picked) return;
  const old = $('#vid');
  const v = old.cloneNode(false); // a fresh element (an element can only be wired to audio once)
  old.replaceWith(v);
  if (vid.ctx) { try { await vid.ctx.close(); } catch { /* ignore */ } }
  vid.ctx = new AudioContext();
  vid.name = picked.name;
  vid.start = 0;
  vid.end = null;
  v.addEventListener('loadedmetadata', () => {
    if (vid.end == null) vid.end = Math.min(v.duration, vid.start + 10);
    renderVideoUi();
  });
  v.src = picked.url;
  vid.src = vid.ctx.createMediaElementSource(v);
  vid.preview = vid.ctx.createGain();
  vid.src.connect(vid.preview);
  vid.preview.connect(vid.ctx.destination);
  vid.dest = vid.ctx.createMediaStreamDestination();
  vid.src.connect(vid.dest);
  v.addEventListener('timeupdate', () => {
    if (vid.stopAt != null && v.currentTime >= vid.stopAt) { v.pause(); vid.stopAt = null; }
  });
  v.addEventListener('error', () => { $('#vid-status').textContent = "This video format can't be read here. MP4 and WebM work best."; });
  renderVideoUi();
  $('#vid-status').textContent = 'Play or scrub to the moment you want, then set the start and end (up to 60 seconds).';
  $('#video').classList.remove('hidden');
}

function renderVideoUi() {
  const len = vid.end != null ? vid.end - vid.start : null;
  $('#vid-range').textContent = vid.end != null ? `${fmtTime(vid.start)} → ${fmtTime(vid.end)} (${fmtTime(len)})` : '';
  $('#vid-save').disabled = vid.busy || vid.end == null || len <= 0.05 || len > 60;
  $('#vid-save').textContent = 'Save to ' + padLabel(selected);
}

async function saveVideoClip() {
  const v = $('#vid');
  const len = vid.end - vid.start;
  if (!(len > 0.05) || len > 60 || vid.busy) return;
  vid.busy = true;
  renderVideoUi();
  const status = $('#vid-status');
  try {
    await vid.ctx.resume();
    vid.preview.gain.value = 0; // record quietly
    const rec = new MediaRecorder(vid.dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    v.pause();
    v.currentTime = vid.start;
    await new Promise((res) => v.addEventListener('seeked', res, { once: true }));
    rec.start(250);
    await v.play();
    await new Promise((res) => {
      const tick = () => {
        const p = Math.min(1, (v.currentTime - vid.start) / len);
        status.textContent = `Grabbing the sound… ${Math.round(p * 100)}%`;
        if (v.currentTime >= vid.end || v.ended) res(); else requestAnimationFrame(tick);
      };
      tick();
    });
    v.pause();
    rec.stop();
    await done;
    const blob = new Blob(parts, { type: 'audio/webm' });
    const saved = await echo.saveSound(await blob.arrayBuffer(), vid.name, 'webm');
    await assignFile(selected, saved);
    status.textContent = `Saved to pad ${padLabel(selected)}.`;
    toast(`Saved to pad ${padLabel(selected)}`);
    $('#video').classList.add('hidden');
    v.removeAttribute('src');
    v.load();
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't grab the sound: " + errMsg(e);
  } finally {
    vid.preview.gain.value = 1;
    vid.busy = false;
    renderVideoUi();
  }
}

function wireVideo() {
  $('#ed-video').addEventListener('click', openVideoImport);
  $('#vid-start').addEventListener('click', () => {
    const v = $('#vid');
    vid.start = v.currentTime;
    if (vid.end == null || vid.end <= vid.start) vid.end = Math.min(v.duration || vid.start + 5, vid.start + 5);
    renderVideoUi();
  });
  $('#vid-end').addEventListener('click', () => {
    const v = $('#vid');
    if (v.currentTime > vid.start) vid.end = v.currentTime;
    renderVideoUi();
  });
  $('#vid-preview').addEventListener('click', async () => {
    const v = $('#vid');
    if (vid.end == null) return;
    if (vid.ctx) await vid.ctx.resume();
    v.currentTime = vid.start;
    vid.stopAt = vid.end;
    v.play();
  });
  $('#vid-save').addEventListener('click', saveVideoClip);
}

/* ---------------- Trim editor ---------------- */

const trim = { peaks: null, file: null, dur: 0, drag: null };

async function renderTrim() {
  const pad = state.pads[selected];
  const field = $('#ed-trim-field');
  field.classList.toggle('hidden', !pad.file);
  if (!pad.file) return;
  const canvas = $('#ed-wave');
  if (trim.file !== pad.file) {
    trim.file = pad.file;
    trim.peaks = null;
    try {
      const buf = await engine.load(pad.file);
      if (trim.file !== pad.file) return;
      trim.dur = buf.duration;
      const cols = canvas.width, d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / cols));
      const peaks = new Float32Array(cols);
      for (let x = 0; x < cols; x++) {
        let mx = 0;
        for (let i = x * step, e = Math.min(d.length, i + step); i < e; i += 8) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
        peaks[x] = mx;
      }
      const top = Math.max(0.05, ...peaks);
      trim.peaks = peaks.map((p) => p / top);
    } catch { trim.peaks = null; }
  }
  drawTrim();
}

function drawTrim() {
  const pad = state.pads[selected];
  const canvas = $('#ed-wave');
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const start = pad.start || 0, end = pad.end || trim.dur;
  $('#ed-trim-val').textContent = trim.dur ? `${fmtTime(start)} – ${fmtTime(end)} (${fmtTime(end - start)} of ${fmtTime(trim.dur)})` : '';
  if (!trim.peaks || !trim.dur) return;
  const x0 = (start / trim.dur) * W, x1 = (end / trim.dur) * W;
  const color = colorById(pad.color).hex;
  for (let x = 0; x < W; x++) {
    const h = Math.max(1, trim.peaks[x] * (H - 8));
    g.fillStyle = x >= x0 && x <= x1 ? color : '#3a3d42';
    g.fillRect(x, (H - h) / 2, 1, h);
  }
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, x0, H);
  g.fillRect(x1, 0, W - x1, H);
  g.fillStyle = '#e7e9ea';
  g.fillRect(Math.max(0, x0 - 2), 0, 4, H);
  g.fillRect(Math.min(W - 4, x1 - 2), 0, 4, H);
}

function wireTrim() {
  const canvas = $('#ed-wave');
  const toSec = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * trim.dur;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!trim.dur) return;
    const pad = state.pads[selected];
    const t = toSec(e), s = pad.start || 0, en = pad.end || trim.dur;
    trim.drag = Math.abs(t - s) <= Math.abs(t - en) ? 'start' : 'end';
    canvas.setPointerCapture(e.pointerId);
    moveTrim(t);
  });
  canvas.addEventListener('pointermove', (e) => { if (trim.drag) moveTrim(toSec(e)); });
  const end = () => { if (trim.drag) { trim.drag = null; engine.stop(vk(selected)); save(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  $('#ed-trim-reset').addEventListener('click', () => {
    const pad = state.pads[selected];
    pad.start = 0; pad.end = null;
    drawTrim(); save();
  });
}

function moveTrim(t) {
  const pad = state.pads[selected];
  const minLen = 0.05;
  if (trim.drag === 'start') pad.start = Math.max(0, Math.min(t, (pad.end || trim.dur) - minLen));
  else { const e = Math.max((pad.start || 0) + minLen, Math.min(t, trim.dur)); pad.end = e >= trim.dur - 0.005 ? null : e; }
  drawTrim();
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
// Map an RGB-palette color index to a legacy red/green velocity (rough)
const LEGACY_FROM_PALETTE = { 0: 12, 1: 13, 3: 63, 5: 15, 7: 13, 49: 47, 51: 29, 45: 60 };

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
  state.slots.forEach((s) => sendLed(s.trigger, 0, 0));
  for (const a of ACTIONS) sendLed(state.actions[a.id].trigger, 0, 0);
  for (let n = 0; n < PAGES; n++) sendLed({ type: 'cc', num: 91 + n }, 0, 0);
  if (!midi.sysex) return;
  for (const id of [0x0c, 0x0d, 0x0e]) {
    try { midi.output.send([0xf0, 0x00, 0x20, 0x29, 0x02, id, 0x0e, 0x00, 0xf7]); } catch { /* ignore */ }
  }
}

let unlinkedHintAt = 0;
const heldPads = new Map(); // trigger key -> pad index (so a release goes to the pad that was pressed)

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
  if (!down && heldPads.has(key)) { release(heldPads.get(key)); heldPads.delete(key); return; }
  const target = triggerMap.get(key);
  if (target && target.kind === 'action') { if (down) runAction(target.id); return; }
  if (!target && trig.type === 'cc' && trig.num >= 91 && trig.num <= 98 && state.settings.topRowPages) {
    if (down) { switchPage(trig.num - 91); toast(pageName(curPage(), profile().page)); }
    return;
  }
  if (!target) {
    if (down && Date.now() - unlinkedHintAt > 8000) {
      unlinkedHintAt = Date.now();
      toast(`That button (${lpButtonName(trig)}) isn't linked to anything. Select a pad and click Learn button.`);
    }
    return;
  }
  const i = target.i;
  if (down && !state.pads[i].file) {
    if (Date.now() - unlinkedHintAt > 4000) {
      unlinkedHintAt = Date.now();
      toast(`That's pad ${padLabel(i)}, which has no sound yet.`);
    }
    select(i);
    return;
  }
  if (down) { heldPads.set(key, i); press(i); } else release(i);
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
  el.textContent = midi.last ? `${lpButtonName(midi.last)} (${trigText(midi.last)}) from ${midi.last.port}` : 'Press any button on your controller…';
}

// channel offset: 0 = static, 1 = flashing, 2 = pulsing (Launchpad Programmer mode)
function sendLed(trig, color, chan) {
  if (!midi.output || !trig) return;
  const st = (trig.type === 'cc' ? 0xb0 : 0x90) | chan;
  try { midi.output.send([st, trig.num, color]); } catch { /* ignore */ }
}

// Static color for a non-pad button, translated for older Launchpads.
function sendLedRaw(trig, paletteColor) {
  if (!midi.output || !trig) return;
  if (outputIsLegacy()) {
    const t = toLegacy(trig);
    if (!t) return;
    const vel = LEGACY_FROM_PALETTE[paletteColor] != null ? LEGACY_FROM_PALETTE[paletteColor] : (paletteColor ? 63 : 12);
    try { midi.output.send([t.type === 'cc' ? 0xb0 : 0x90, t.num, vel]); } catch { /* ignore */ }
    return;
  }
  sendLed(trig, paletteColor, 0);
}

function led(i) {
  const pad = state.pads[i];
  const trig = state.slots[i] && state.slots[i].trigger;
  if (!pad || !midi.output || !trig) return;
  const playing = engine.isPlaying(vk(i));
  if (outputIsLegacy()) {
    const t = toLegacy(trig);
    if (!t) return;
    const vel = pad.file ? legacyVelocity(pad.color, playing) : 12;
    try { midi.output.send([t.type === 'cc' ? 0xb0 : 0x90, t.num, vel]); } catch { /* ignore */ }
    return;
  }
  const col = pad.file ? colorById(pad.color).lp : 0;
  if (playing && col) {
    sendLed(trig, col, 0);
    sendLed(trig, col, 2);
  } else {
    sendLed(trig, col, 0);
  }
}

function ledPages() {
  if (!midi.output || !state.settings.topRowPages) return;
  const pr = profile();
  for (let n = 0; n < PAGES; n++) {
    const t = { type: 'cc', num: 91 + n };
    if (triggerMap.has(trigKey(t))) continue; // used for something else
    const has = pr.pages[n].pads.some((p) => p.file);
    sendLedRaw(t, n === pr.page ? 3 : has ? 1 : 0);
  }
}

function ledActions() {
  if (!midi.output) return;
  for (const a of ACTIONS) {
    const t = state.actions[a.id] && state.actions[a.id].trigger;
    if (!t || (triggerMap.get(trigKey(t)) || {}).kind !== 'action') continue;
    const on = a.id === 'replay' ? state.settings.replay.enabled : a.id === 'fxToggle' ? state.settings.fx.on : true;
    sendLedRaw(t, on ? a.lp[0] : a.lp[1]);
  }
}

function ledAll() {
  state.pads.forEach((_, i) => led(i));
  ledPages();
  ledActions();
}

/* ---------------- Learn ---------------- */

function startLearn(target) {
  learnTarget = target;
  renderEditor();
  renderActions();
  if (!midi.inputs.length) toast(midi.busy.length ? 'Your Launchpad is being used by another app. Close it and try again.' : 'No MIDI controller connected. Plug in your Launchpad first.');
}

function cancelLearn() {
  learnTarget = null;
  renderEditor();
  renderActions();
}

function finishLearn(trig) {
  const key = trigKey(trig);
  const target = learnTarget;
  learnTarget = null;

  // A button can only do one thing: release it from wherever it was.
  state.slots.forEach((s, i) => { if (trigKey(s.trigger) === key) { s.trigger = null; renderPad(i); } });
  for (const a of ACTIONS) if (trigKey(state.actions[a.id].trigger) === key) state.actions[a.id].trigger = null;
  sendLedRaw(trig, 0);

  if (String(target).startsWith('action:')) {
    const id = target.slice(7);
    const old = state.actions[id].trigger;
    if (old) sendLedRaw(old, 0);
    state.actions[id].trigger = trig;
    toast(`${actionDef(id).name} → ${lpButtonName(trig)}`);
  } else {
    const slot = state.slots[target];
    if (slot.trigger) sendLedRaw(slot.trigger, 0);
    slot.trigger = trig;
    renderPad(target);
    toast(`Pad ${padLabel(target)} → ${lpButtonName(trig)}`);
  }
  rebuildTriggerMap();
  ledAll();
  renderEditor();
  renderActions();
  save();
}

/* ---------------- Grid rendering ---------------- */

const PAD_DRAG_TYPE = 'application/x-echo-board-pad';
let dragFrom = null;

// What belongs to the sound (moves with it). Launchpad buttons and shortcuts stay with the grid position.
const PAD_CONTENT_KEYS = ['name', 'file', 'volume', 'color', 'mode', 'choke', 'start', 'end'];
const padContent = (p) => Object.fromEntries(PAD_CONTENT_KEYS.map((k) => [k, p[k]]));

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

function movePad(from, to, copy) {
  if (from === to || !state.pads[from] || !state.pads[to]) return;
  const a = state.pads[from], b = state.pads[to];
  if (!a.file) return;
  engine.stop(vk(from));
  engine.stop(vk(to));
  const aContent = padContent(a), bContent = padContent(b);
  if (copy) {
    Object.assign(b, aContent);
  } else {
    Object.assign(b, aContent);
    if (bContent.file) Object.assign(a, bContent);   // swap
    else Object.assign(a, emptyPad());                // move into an empty spot
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
  const slot = state.slots[i];
  if (!el || !pad) return;
  el.style.setProperty('--pc', colorById(pad.color).hex);
  el.classList.toggle('assigned', !!pad.file);
  el.draggable = !!pad.file;
  const playing = engine.isPlaying(vk(i));
  el.classList.toggle('playing', playing);
  el.classList.toggle('selected', i === selected);
  el.classList.toggle('missing', missing.has(i));
  const nameText = pad.file ? pad.name || 'Untitled' : '';
  const nameEl = el.querySelector('.pad-name');
  nameEl.textContent = nameText;
  nameEl.classList.toggle('long', nameText.split(/\s+/).some((w) => w.length > 7)); // smaller text so long words don't split
  const tags = [padLabel(i)];
  if (slot && slot.hotkey) tags.push(accelLabel(slot.hotkey));
  if (slot && !slot.trigger) tags.push('no button');
  el.querySelector('.pad-tag').textContent = tags.join(' · ');
  if (!playing) el.style.setProperty('--p', 0);
}

function select(i) {
  const prev = selected;
  selected = i;
  if (learnTarget !== null && !String(learnTarget).startsWith('action:')) cancelLearn();
  renderPad(prev);
  renderPad(i);
  renderEditor();
  renderTts();
}

function renderEditor() {
  const pad = state.pads[selected];
  const slot = state.slots[selected];
  $('#ed-title').textContent = 'Pad ' + padLabel(selected);
  $('#ed-trigger').textContent = lpButtonName(slot.trigger) === 'Pad ' + padLabel(selected) ? '' : 'Button: ' + lpButtonName(slot.trigger);
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
  $('#ed-hotkey').textContent = slot.hotkey ? accelLabel(slot.hotkey) : 'Set shortcut';
  $('#ed-hotkey-clear').classList.toggle('hidden', !slot.hotkey);
  renderTrim();
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
  renderFx();
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
  engine.updateDucking(state.settings.duck);
  for (const key of engine.voices.keys()) {
    const i = padIndexOfKey(key);
    if (i !== null && padEls[i]) padEls[i].style.setProperty('--p', engine.progress(key));
  }
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
  const cableId = state.settings.cableDevice;
  fillSelect('#set-extra', [{ v: '', t: 'Off' },
    ...audioDevices.outs.filter((d) => d.deviceId !== cableId).map((d, n) => ({ v: d.deviceId, t: lbl(d, 'Output ' + (n + 1)) }))], state.settings.extra.device);
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
  $('#set-even').checked = s.evenVolume;
  $('#set-toprow').checked = s.topRowPages;
  $('#set-ptt-on').checked = s.ptt.enabled;
  $('#set-ptt-key').textContent = s.ptt.code ? pttLabel(s.ptt.code) : 'Set key';
  $('#set-duck-mic').checked = s.duck.mic;
  $('#set-duck-mic-lvl').value = Math.round(s.duck.micLevel * 100);
  $('#set-duck-mic-val').textContent = Math.round(s.duck.micLevel * 100) + '%';
  $('#set-duck-snd').checked = s.duck.sounds;
  $('#set-duck-snd-lvl').value = Math.round(s.duck.soundsLevel * 100);
  $('#set-duck-snd-val').textContent = Math.round(s.duck.soundsLevel * 100) + '%';
  $('#set-replay-on').checked = s.replay.enabled;
  $('#set-replay-len').value = String(s.replay.seconds);
  $('#set-replay-mic').checked = s.replay.includeMic;
  $('#set-extra-voice').checked = s.extra.includeVoice;
}

let restartTimer = null;
function restartAudio() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await engine.start(state.settings, resolveDevices());
    await startReplay();
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
  speak.textContent = !tts.busy ? 'Speak' : tts.download != null ? 'Loading voices…' : 'Generating…';
  const status = $('#tts-status');
  status.textContent = tts.download != null ? `Loading voices… ${tts.download}%` : NEEDS_KEY.has(s.provider) ? 'Online voice' : '';
  status.title = NEEDS_KEY.has(s.provider) ? `What you type for this voice is sent to ${TTS_NAMES[s.provider]}. Free AI and Built-in voices stay on your computer.` : '';
  status.classList.toggle('online', NEEDS_KEY.has(s.provider) && tts.download == null);
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
    openSettings('#key-' + p);
    toast(`Add your ${TTS_NAMES[p]} API key to use those voices.`);
    return null;
  }
  const voice = s.voice[p] || '';
  const style = p === 'openai' ? (s.style || '').trim() : '';
  const key = [p, voice, style, text].join('\u0001');
  const cached = tts.history.find((h) => h.key === key);
  if (cached) return cached;

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
    await engine.play('tts', { file: item.file, volume: 1, mode: 'oneshot' }, { normalize: false });
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
    if (NEEDS_KEY.has(p) && !tts.keys[p]) { openSettings('#key-' + p); return; }
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
    e.stopPropagation();
    if (e.key === 'Enter') document.querySelector(`[data-savekey="${p}"]`).click();
  }));
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
    toast(value ? `${TTS_NAMES[p]} key saved. Pick "${TTS_NAMES[p]} voices (online)" in the voice box.` : `${TTS_NAMES[p]} key removed.`);
    if (ttsCfg().provider === p) loadTtsVoices(true);
  } catch (e) {
    toast(errMsg(e));
  }
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

function openSettings(focusSel) {
  refreshKeyStatus();
  renderMidiActivity();
  refreshAudioDevices();
  refreshMidiLists();
  renderActions();
  renderLevels();
  renderReplayUi();
  renderPttNote();
  $('#settings').classList.remove('hidden');
  if (typeof focusSel === 'string') {
    const el = $(focusSel);
    if (el) el.scrollIntoView({ block: 'center' });
  }
}

async function renderPttNote() {
  const note = $('#set-ptt-note');
  try {
    const st = await echo.pttStatus();
    note.textContent = !st.available ? 'Not available on this computer.' : st.needsPermission ? 'Mac: needs Accessibility permission (asked the first time).' : '';
  } catch { note.textContent = ''; }
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
    catch (e) { toast(errMsg(e)); }
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
    engine.stop(vk(selected));
    state.pads[selected].mode = e.target.value;
    save();
  });
  $('#ed-choke').addEventListener('change', (e) => { state.pads[selected].choke = e.target.checked; save(); });
  $('#ed-learn').addEventListener('click', () => (learnTarget === selected ? cancelLearn() : startLearn(selected)));
  $('#ed-hotkey').addEventListener('click', () => {
    const i = selected;
    captureShortcut((accel) => { state.slots[i].hotkey = accel; save(); syncHotkeys(); renderPad(i); renderEditor(); toast(`Pad ${padLabel(i)} → ${accelLabel(accel)}`); });
  });
  $('#ed-hotkey-clear').addEventListener('click', () => {
    state.slots[selected].hotkey = null; save(); syncHotkeys(); renderPad(selected); renderEditor();
  });
  $('#ed-clear').addEventListener('click', () => clearPad(selected));
}

function wireSettings() {
  const open = (id) => $('#' + id).classList.remove('hidden');
  const close = (id) => {
    $('#' + id).classList.add('hidden');
    if (id === 'settings' && String(learnTarget).startsWith('action:')) cancelLearn();
    if (id === 'video') { const v = $('#vid'); v.pause(); }
    if (id === 'fx') stopFxTest();
  };
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-help').addEventListener('click', () => open('help'));
  $('#btn-replay').addEventListener('click', saveReplay);
  $('#chip-out').addEventListener('click', () => (engine.routeOk ? openSettings() : openCableSetup()));
  $('#chip-mic').addEventListener('click', () => openSettings());
  $('#chip-midi').addEventListener('click', () => openSettings());
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
  $('#set-toprow').addEventListener('change', (e) => {
    s.topRowPages = e.target.checked;
    if (!s.topRowPages) for (let n = 0; n < PAGES; n++) sendLedRaw({ type: 'cc', num: 91 + n }, 0);
    save(); ledAll(); renderPages();
  });

  $('#set-cable').addEventListener('change', (e) => { s.cableDevice = e.target.value; save(); restartAudio(); });
  $('#set-mic').addEventListener('change', (e) => { s.micDevice = e.target.value; save(); restartAudio(); });
  $('#set-monitor').addEventListener('change', (e) => { s.monitorDevice = e.target.value; save(); restartAudio(); });
  $('#set-mic-on').addEventListener('change', (e) => { s.micEnabled = e.target.checked; save(); restartAudio(); });
  $('#set-even').addEventListener('change', (e) => { s.evenVolume = e.target.checked; save(); });
  $('#set-extra').addEventListener('change', (e) => { s.extra.device = e.target.value; save(); restartAudio(); });
  $('#set-extra-voice').addEventListener('change', (e) => { s.extra.includeVoice = e.target.checked; engine.setLevels(s); save(); });

  const level = (sel, key, valSel) => $(sel).addEventListener('input', (e) => {
    s[key] = Number(e.target.value) / 100;
    $(valSel).textContent = e.target.value + '%';
    engine.setLevels(s);
    save();
  });
  level('#set-mic-vol', 'micVolume', '#set-mic-vol-val');
  level('#set-master', 'masterVolume', '#set-master-val');
  level('#set-monitor-vol', 'monitorVolume', '#set-monitor-vol-val');

  // Push-to-talk
  $('#set-ptt-on').addEventListener('change', (e) => {
    s.ptt.enabled = e.target.checked;
    ptt.errorShown = false;
    if (s.ptt.enabled && !s.ptt.code) toast('Now set your push-to-talk key below.');
    save(); updatePtt();
  });
  $('#set-ptt-key').addEventListener('click', () => capturePttKey((code) => {
    s.ptt.code = code; s.ptt.enabled = true; ptt.errorShown = false;
    save(); renderLevels(); toast('Push-to-talk key: ' + pttLabel(code));
  }));

  // Ducking
  $('#set-duck-mic').addEventListener('change', (e) => { s.duck.mic = e.target.checked; save(); });
  $('#set-duck-snd').addEventListener('change', (e) => { s.duck.sounds = e.target.checked; save(); });
  $('#set-duck-mic-lvl').addEventListener('input', (e) => { s.duck.micLevel = Number(e.target.value) / 100; $('#set-duck-mic-val').textContent = e.target.value + '%'; save(); });
  $('#set-duck-snd-lvl').addEventListener('input', (e) => { s.duck.soundsLevel = Number(e.target.value) / 100; $('#set-duck-snd-val').textContent = e.target.value + '%'; save(); });

  // Instant replay
  $('#set-replay-on').addEventListener('change', async (e) => { s.replay.enabled = e.target.checked; save(); await startReplay(); });
  $('#set-replay-len').addEventListener('change', async (e) => { s.replay.seconds = Number(e.target.value); save(); await startReplay(); });
  $('#set-replay-mic').addEventListener('change', async (e) => { s.replay.includeMic = e.target.checked; save(); await startReplay(); });

  // Privacy self-check
  $('#set-privacy-check').addEventListener('click', async () => {
    const out = $('#set-privacy-result');
    out.textContent = 'Checking…';
    let windowBlocked = false;
    try { await fetch('https://example.com', { cache: 'no-store' }); } catch { windowBlocked = true; }
    let r = {};
    try { r = await echo.privacyCheck(); } catch { /* ignore */ }
    const ok = windowBlocked && Object.values(r).every((v) => v === 'blocked');
    out.textContent = ok ? '✓ Internet access is blocked everywhere in Echo Board.' : 'Some network access was not blocked: ' + JSON.stringify({ window: windowBlocked ? 'blocked' : 'reachable', ...r });
    out.className = ok ? 'key-status' : 'muted';
  });
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (capturing) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') {
      const openOverlay = document.querySelector('.overlay:not(.hidden)');
      if (openOverlay) { openOverlay.classList.add('hidden'); if (openOverlay.id === 'video') $('#vid').pause(); if (openOverlay.id === 'fx') stopFxTest(); return; }
      stopAll();
      return;
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'video') return;
    if (e.code === 'Space') { e.preventDefault(); press(selected); }
    if (e.code === 'PageDown') { e.preventDefault(); switchPage(profile().page + 1); }
    if (e.code === 'PageUp') { e.preventDefault(); switchPage(profile().page - 1); }
  });
  // Don't let a file dropped outside a pad navigate the window away.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  echo.onHotkey(onHotkey);
  window.addEventListener('beforeunload', () => {
    leaveProgrammerMode();
    if (ptt.held) { ptt.held = false; pttSend(false); }
  });
}

/* ---------------- Loading saved data ---------------- */

function normalizePad(p) {
  const out = { ...emptyPad(), ...(p ? padContent({ ...emptyPad(), ...p }) : {}) };
  if (typeof out.start !== 'number' || out.start < 0) out.start = 0;
  if (out.end != null && !(out.end > out.start)) out.end = null;
  return out;
}

function loadState(saved) {
  const s = saved || {};
  // Settings (deep-merge the nested groups)
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const ss = s.settings || {};
  state.settings = { ...base, ...ss };
  for (const k of ['tts', 'fx', 'ptt', 'duck', 'replay', 'extra']) state.settings[k] = { ...base[k], ...(ss[k] || {}) };
  state.settings.tts.voice = { ...base.tts.voice, ...((ss.tts && ss.tts.voice) || {}) };
  if (!TTS_NAMES[state.settings.tts.provider]) state.settings.tts.provider = 'kokoro';

  if (s.version === 2 && Array.isArray(s.profiles) && s.profiles.length) {
    state.profiles = s.profiles.map((p) => ({
      id: p.id || newId(), name: p.name || 'Profile', page: Math.max(0, Math.min(PAGES - 1, p.page | 0)),
      pages: Array.from({ length: PAGES }, (_, n) => {
        const pg = (p.pages || [])[n] || {};
        return { name: pg.name || '', pads: Array.from({ length: PADS }, (_, i) => normalizePad((pg.pads || [])[i])) };
      }),
    }));
    state.profileId = state.profiles.some((p) => p.id === s.profileId) ? s.profileId : state.profiles[0].id;
    state.slots = Array.from({ length: PADS }, (_, i) => {
      const sl = (s.slots || [])[i];
      return sl ? { trigger: sl.trigger || null, hotkey: sl.hotkey || null } : { trigger: defaultTrigger(i), hotkey: null };
    });
    state.actions = {};
    for (const a of ACTIONS) {
      const st = (s.actions || {})[a.id];
      state.actions[a.id] = st ? { trigger: st.trigger || null, hotkey: st.hotkey || null } : { trigger: a.trigger, hotkey: a.hotkey };
    }
  } else {
    // First run, or an older layout (one page of pads): move it into profile 1, page 1.
    const p = newProfile('Default');
    const oldPads = Array.isArray(s.pads) ? s.pads : [];
    p.pages[0].pads = Array.from({ length: PADS }, (_, i) => normalizePad(oldPads[i]));
    state.profiles = [p];
    state.profileId = p.id;
    state.slots = Array.from({ length: PADS }, (_, i) => {
      const old = oldPads[i];
      return { trigger: old ? (old.trigger === undefined ? defaultTrigger(i) : old.trigger) : defaultTrigger(i), hotkey: null };
    });
    state.actions = {};
    for (const a of ACTIONS) state.actions[a.id] = { trigger: a.trigger, hotkey: a.hotkey };
    if (s.stopAllTrigger) state.actions.stopAll.trigger = s.stopAllTrigger;
    // Make sure default action buttons don't collide with buttons the user already learned
    const used = new Set(state.slots.map((sl) => trigKey(sl.trigger)));
    for (const a of ACTIONS) if (a.id !== 'stopAll' && used.has(trigKey(state.actions[a.id].trigger))) state.actions[a.id].trigger = null;
  }
  useCurrentPage();
  rebuildTriggerMap();
}

async function boot() {
  loadState(await echo.loadConfig());

  buildGrid();
  wireEditor();
  wireTrim();
  wireSettings();
  wireKeys();
  wireTts();
  wireCable();
  wireFx();
  wireProfiles();
  wireVideo();
  renderPages();
  renderProfileButton();
  renderEditor();
  renderTts();
  renderLevels();
  renderActions();
  renderFx();
  updateChips();
  save(); // writes the new layout format right away

  // Each startup step is independent: if one stalls or fails, the rest of the app still loads.
  const step = (name, p, ms = 10000) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(name + ' timed out')), ms)),
  ]).catch((e) => console.error('Startup step failed:', name, e));

  await step('API keys', refreshKeyStatus(), 4000);
  // An online voice without a saved key can't speak: start on the free voices instead.
  if (NEEDS_KEY.has(ttsCfg().provider) && !tts.keys[ttsCfg().provider]) { ttsCfg().provider = 'kokoro'; save(); renderTts(); }
  loadTtsVoices();
  syncHotkeys();
  await step('audio devices', refreshAudioDevices());
  await step('audio engine', engine.start(state.settings, resolveDevices()));
  updateChips();
  renderFx();
  await step('replay', startReplay());
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

  warmPage();
  requestAnimationFrame(progressLoop);
  await step('MIDI', initMidi(), 8000);
  updateChips();
}

boot().catch((e) => { console.error(e); toast('Startup error: ' + (e.message || e)); });
