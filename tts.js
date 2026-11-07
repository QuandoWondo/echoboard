'use strict';
/* Text-to-speech for Echo Board (runs in the main process).
   Every provider renders to an audio file; the renderer then plays that file
   through the same engine as the pads, so it reaches the virtual cable.
   - kokoro:     Kokoro-82M neural voices running locally (free, no account;
                 ~92 MB model downloaded once, then works offline).
   - system:     macOS `say` / Windows SAPI voices. Free, offline.
   - openai:     OpenAI speech API (optional, your API key). ONLINE: sends the typed text to OpenAI.
   - elevenlabs: ElevenLabs API (optional, your API key). ONLINE: sends the typed text to ElevenLabs.
   Online providers only work through the narrow allow-list in privacy.js (onlineVoiceFetch). */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_CHARS = 1000;
const OPENAI_MODEL = 'gpt-4o-mini-tts';
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const ELEVEN_MODEL = 'eleven_flash_v2_5';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];
const KOKORO_KIND = { af: 'US female', am: 'US male', bf: 'UK female', bm: 'UK male' };

// Files the free voices need. The installer ships these, so nothing is downloaded at runtime.
const KOKORO_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx',
  ...KOKORO_VOICES.map((v) => `voices/${v}.bin`)];

/* Answer Hugging Face downloads from a folder of files bundled with the app.
   The voice library asks for https://huggingface.co/<org>/<repo>/resolve/<rev>/<file>;
   if we ship that file, we hand it back from disk instead of going online. */
function installLocalHub(bundleDir) {
  if (!bundleDir || !fs.existsSync(bundleDir)) return false;
  if (globalThis.__echoLocalHub === bundleDir) return true;
  const realFetch = globalThis.__echoRealFetch || globalThis.fetch;
  globalThis.__echoRealFetch = realFetch;
  globalThis.__echoLocalHub = bundleDir;
  const root = path.resolve(bundleDir);
  const kokoroDir = path.join(root, ...KOKORO_MODEL.split('/'));
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || '';
    const m = String(url).match(/^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/[^/]+\/([^?#]+)/);
    if (m) {
      const rel = decodeURIComponent(m[3]);
      const repoDir = path.join(root, m[1], m[2]);
      let file = path.resolve(repoDir, rel);
      if (!fs.existsSync(repoDir) && rel.startsWith('voices/')) file = path.resolve(kokoroDir, rel);
      const inside = file.startsWith(root + path.sep);
      if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const data = await fs.promises.readFile(file);
        return new Response(data, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } });
      }
      if (inside && fs.existsSync(repoDir)) return new Response('Not found', { status: 404 }); // bundled repo, optional file
    }
    return realFetch(input, init);
  };
  return true;
}

// Split long text into sentence-sized pieces the model handles well.
function splitText(text, max = 300) {
  const pieces = [];
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/);
  let cur = '';
  const push = () => { if (cur.trim()) pieces.push(cur.trim()); cur = ''; };
  for (const sentence of sentences) {
    let s = sentence;
    while (s.length > max) { // one very long sentence: break at a comma or space
      let cut = s.lastIndexOf(', ', max);
      if (cut < max / 3) cut = s.lastIndexOf(' ', max);
      if (cut < max / 3) cut = max;
      push();
      pieces.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if ((cur + ' ' + s).trim().length > max) push();
    cur = (cur + ' ' + s).trim();
  }
  push();
  return pieces;
}

// 16-bit mono PCM WAV
function encodeWav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
} // fast + cheap; 'eleven_multilingual_v2' is higher quality but slower

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim() || 'Command failed'));
      else resolve(String(stdout));
    });
  });
}

function powershell(script, env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: { ...process.env, ...env } });
}

// Parses `say -v '?'` lines like: "Eddy (English (US))  en_US    # Hello! My name is Eddy."
function parseMacVoices(out) {
  const seen = new Set();
  const voices = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/);
    if (!m) continue;
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    voices.push({ id: name, name, detail: m[2].replace('-', '_') });
  }
  return voices;
}

function parseWinVoices(out) {
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, culture = ''] = l.split('|');
    return { id, name: id.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, ''), detail: culture.replace('-', '_') };
  });
}

async function apiError(res) {
  let msg = res.status + ' ' + res.statusText;
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || (j.detail && (j.detail.message || j.detail)) || j.message || msg;
    } catch { if (body) msg = body.slice(0, 200); }
  } catch { /* ignore */ }
  if (res.status === 401) msg = 'API key was rejected. Check it in Settings. (' + msg + ')';
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}

function createTts({
  dir, platform = process.platform, getKey = async () => '', fetchImpl = globalThis.fetch,
  modelsDir = null, bundledModelsDir = null, onProgress = () => {},
  importKokoro = () => import('kokoro-js'),
  importTransformers = () => import('@huggingface/transformers'),
}) {
  /* ---- Kokoro (free local AI voices) ---- */
  let kokoro = null;
  function loadKokoro() {
    if (kokoro) return kokoro;
    kokoro = (async () => {
      // Voices shipped with the installer are read straight from disk; otherwise they download
      // once into the app's data folder (the app bundle itself is read-only).
      const bundled = installLocalHub(bundledModelsDir);
      try {
        const tf = await importTransformers();
        if (tf && tf.env) {
          if (modelsDir) tf.env.cacheDir = modelsDir;
          if (bundled) tf.env.useFSCache = false; // no need to copy 100 MB we already ship
        }
      } catch { /* fall back to the library defaults */ }
      const { KokoroTTS } = await importKokoro();
      const files = {};
      let lastSent = -1;
      const model = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: (e) => {
          if (!e || e.status !== 'progress' || !e.file || !e.total) return;
          files[e.file] = { loaded: e.loaded || 0, total: e.total };
          let loaded = 0, total = 0;
          for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
          const pct = Math.min(99, Math.floor((loaded / total) * 100));
          if (pct > lastSent && !bundled) { lastSent = pct; onProgress(pct); }
        },
      });
      onProgress(null);
      return model;
    })();
    kokoro.catch((e) => {
      kokoro = null;
      onProgress(null);
      console.error('Kokoro failed to load', e);
    });
    return kokoro;
  }

  async function speakKokoro(text, voice) {
    let model;
    try { model = await loadKokoro(); }
    catch (e) {
      throw new Error("Couldn't load the free AI voices (" + (e.message || e) + '). Reinstall Echo Board to restore them.');
    }
    voice = KOKORO_VOICES.includes(voice) ? voice : 'af_heart';
    const out = newPath('wav');
    const chunks = splitText(text);
    const parts = [];
    let rate = 24000;
    for (const chunk of chunks) {
      const audio = await model.generate(chunk, { voice });
      if (!audio || !(audio.audio instanceof Float32Array)) {
        if (chunks.length === 1 && audio && typeof audio.save === 'function') { await audio.save(out); return out; }
        throw new Error('Unexpected audio from the voice model.');
      }
      if (audio.sampling_rate) rate = audio.sampling_rate;
      parts.push(audio.audio);
    }
    const gap = Math.round(rate * 0.12); // short pause between sentences
    const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1);
    const samples = new Float32Array(total);
    let off = 0;
    parts.forEach((p, i) => { samples.set(p, off); off += p.length + (i < parts.length - 1 ? gap : 0); });
    await fs.promises.writeFile(out, encodeWav(samples, rate));
    return out;
  }

  const newPath = (ext) => path.join(dir, Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext);

  async function requireKey(provider, label) {
    const key = await getKey(provider);
    if (!key) throw new Error(`Add your ${label} API key in Settings first.`);
    return key;
  }

  async function voices(provider) {
    if (provider === 'kokoro') {
      loadKokoro().catch(() => {}); // warm up the bundled voice model in the background
      return KOKORO_VOICES.map((id) => {
        const [kind, name] = id.split('_');
        return { id, name: name[0].toUpperCase() + name.slice(1), detail: KOKORO_KIND[kind] || '' };
      });
    }
    if (provider === 'system') {
      if (platform === 'darwin') return parseMacVoices(await run('say', ['-v', '?']));
      if (platform === 'win32') {
        return parseWinVoices(await powershell(
          "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
          "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }; $s.Dispose()"));
      }
      throw new Error('Built-in voices work on Windows and Mac.');
    }
    if (provider === 'openai') {
      return OPENAI_VOICES.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), detail: '' }));
    }
    if (provider === 'elevenlabs') {
      const key = await requireKey('elevenlabs', 'ElevenLabs');
      const res = await fetchImpl('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('ElevenLabs: ' + await apiError(res));
      const data = await res.json();
      return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name, detail: v.category || '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    throw new Error('Unknown voice provider: ' + provider);
  }

  async function speakSystem(text, voice) {
    const txt = newPath('txt');
    const out = newPath('wav');
    await fs.promises.writeFile(txt, text, 'utf8');
    try {
      if (platform === 'darwin') {
        const args = ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, '-f', txt];
        if (voice) args.unshift('-v', voice);
        await run('say', args);
      } else if (platform === 'win32') {
        await powershell(
          'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
          'if ($env:EC_VOICE) { $s.SelectVoice($env:EC_VOICE) }; $s.SetOutputToWaveFile($env:EC_OUT); ' +
          '$s.Speak([System.IO.File]::ReadAllText($env:EC_TXT, [System.Text.Encoding]::UTF8)); $s.Dispose()',
          { EC_VOICE: voice || '', EC_OUT: out, EC_TXT: txt });
      } else {
        throw new Error('Built-in voices work on Windows and Mac.');
      }
    } finally {
      fs.promises.unlink(txt).catch(() => {});
    }
    const st = await fs.promises.stat(out).catch(() => null);
    if (!st || st.size < 100) throw new Error('That voice could not render audio. Try another voice.');
    return out;
  }

  async function saveResponse(res, ext) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('The voice service returned no audio.');
    const out = newPath(ext);
    await fs.promises.writeFile(out, buf);
    return out;
  }

  async function speakOpenAI(text, voice, style) {
    const key = await requireKey('openai', 'OpenAI');
    const body = { model: OPENAI_MODEL, voice: OPENAI_VOICES.includes(voice) ? voice : 'alloy', input: text, response_format: 'mp3' };
    if (style) body.instructions = style.slice(0, 500);
    const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('OpenAI: ' + await apiError(res));
    return saveResponse(res, 'mp3');
  }

  async function speakEleven(text, voice) {
    const key = await requireKey('elevenlabs', 'ElevenLabs');
    if (!voice) throw new Error('Pick an ElevenLabs voice first.');
    const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('ElevenLabs: ' + await apiError(res));
    return saveResponse(res, 'mp3');
  }

  async function speak({ provider, voice, text, style } = {}) {
    text = String(text || '').trim().slice(0, MAX_CHARS);
    if (!text) throw new Error('Type something first.');
    await fs.promises.mkdir(dir, { recursive: true });
    if (provider === 'kokoro') return speakKokoro(text, voice);
    if (provider === 'system') return speakSystem(text, voice);
    if (provider === 'openai') return speakOpenAI(text, voice, String(style || '').trim());
    if (provider === 'elevenlabs') return speakEleven(text, voice);
    throw new Error('Unknown voice provider: ' + provider);
  }

  async function clearCache() {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return { voices, speak, clearCache };
}

module.exports = {
  createTts, parseMacVoices, parseWinVoices, splitText, encodeWav, installLocalHub,
  MAX_CHARS, KOKORO_MODEL, KOKORO_VOICES, KOKORO_FILES,
};
