'use strict';
// Privacy first: lock down all network access before anything else loads.
const { lockDownNode, blockWindowRequests, onlineVoiceFetch, BLOCKED } = require('./privacy');
lockDownNode();

const { app, BrowserWindow, ipcMain, dialog, session, globalShortcut, systemPreferences, shell, protocol, desktopCapturer, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createTts } = require('./tts');
const { createCableInstaller } = require('./cable');
const { createKeySender } = require('./keys');

// MIDI presses aren't "user gestures", so let audio start without one.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// No background network activity from the browser engine either.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');

// Local-only scheme for playing video files you pick (used by "Import from video").
protocol.registerSchemesAsPrivileged([{
  scheme: 'echo-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}]);

const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const configPath = () => path.join(app.getPath('userData'), 'echo-board.json');
const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
// Voices and VB-CABLE shipped inside the installer (see scripts/fetch-bundled.js).
const bundledDir = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, 'bundled'));

const keysPath = () => path.join(app.getPath('userData'), 'echo-board-keys.json');
const TTS_ONLINE = ['openai', 'elevenlabs'];

/* ---- Optional online-voice API keys: encrypted with the OS keychain, never sent to the window ---- */
let keyStore = null;
async function loadKeys() {
  if (keyStore) return keyStore;
  try { keyStore = JSON.parse(await fs.promises.readFile(keysPath(), 'utf8')); } catch { keyStore = {}; }
  return keyStore;
}
async function getKey(provider) {
  const v = (await loadKeys())[provider];
  if (!v) return '';
  try { return v.enc ? safeStorage.decryptString(Buffer.from(v.data, 'base64')) : v.data; } catch { return ''; }
}
async function setKey(provider, key) {
  if (!TTS_ONLINE.includes(provider)) throw new Error('Unknown provider');
  const store = await loadKeys();
  key = String(key || '').trim();
  if (!key) delete store[provider];
  else if (safeStorage.isEncryptionAvailable()) store[provider] = { enc: true, data: safeStorage.encryptString(key).toString('base64') };
  else store[provider] = { enc: false, data: key };
  await fs.promises.writeFile(keysPath(), JSON.stringify(store), { mode: 0o600 });
}

let tts = null;
let win = null;
const keys = createKeySender({ systemPreferences });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1000,
    minHeight: 720,
    backgroundColor: '#000000',
    title: 'Echo Board',
    icon: path.join(__dirname, 'src', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false, // no dictionary downloads
      // Keep MIDI + audio responsive while a game has focus.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Keep a local log of interface errors so problems can be diagnosed (never sent anywhere).
  const logFile = path.join(app.getPath('userData'), 'echo-board.log');
  const log = (line) => fs.promises.appendFile(logFile, new Date().toISOString() + ' ' + line + '\n').catch(() => {});
  win.webContents.on('console-message', (_e, level, message, lineNo, source) => {
    if (level >= 2) log(`[renderer] ${message} (${path.basename(String(source || ''))}:${lineNo})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('[renderer crashed] ' + JSON.stringify(d)));
  // Never navigate away from the app or open other windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('closed', () => { win = null; });
}

const send = (channel, ...args) => { if (win) win.webContents.send(channel, ...args); };

// Copy a sound into the app's own library so moving/deleting the original doesn't break a pad.
async function importSound(src) {
  const dir = soundsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(src).slice(1).toLowerCase();
  if (!AUDIO_EXT.includes(ext)) throw new Error('Unsupported file type: .' + ext);
  const base = path.basename(src);
  const name = path.basename(src, path.extname(src));
  if (path.dirname(path.resolve(src)) === path.resolve(dir)) return { path: src, name };
  const dest = path.join(dir, crypto.randomBytes(4).toString('hex') + '-' + base);
  await fs.promises.copyFile(src, dest);
  return { path: dest, name };
}

const safeName = (n) => String(n || 'clip').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'clip';

ipcMain.handle('config:load', async () => {
  try { return JSON.parse(await fs.promises.readFile(configPath(), 'utf8')); }
  catch { return null; }
});

ipcMain.handle('config:save', async (_e, data) => {
  const p = configPath();
  const tmp = p + '.tmp';
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, p);
  return true;
});

ipcMain.handle('sound:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXT }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return importSound(res.filePaths[0]);
});

ipcMain.handle('sound:import', async (_e, src) => importSound(src));
ipcMain.handle('sound:read', async (_e, p) => fs.promises.readFile(p));

// Save audio recorded inside the app (instant replay, clips from videos) into the sound library.
ipcMain.handle('sound:save', async (_e, bytes, name, ext) => {
  ext = ['wav', 'webm'].includes(ext) ? ext : 'wav';
  const dir = soundsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, crypto.randomBytes(4).toString('hex') + '-' + safeName(name) + '.' + ext);
  await fs.promises.writeFile(dest, Buffer.from(bytes));
  return { path: dest, name: String(name || 'clip').slice(0, 40) };
});

/* ---- Video files for "Import from video": only files you picked can be read ---- */
const allowedVideos = new Map(); // token -> absolute path
ipcMain.handle('video:pick', async () => {
  let file = process.env.ECHO_TEST_VIDEO; // automated tests only (no file dialog on the test machine)
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'Audio', extensions: AUDIO_EXT }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    file = res.filePaths[0];
  }
  const token = crypto.randomBytes(12).toString('hex');
  allowedVideos.set(token, file);
  return { url: `echo-media://local/${token}${path.extname(file).toLowerCase()}`, name: path.basename(file, path.extname(file)) };
});

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg' };

async function serveMedia(request) {
  const url = new URL(request.url);
  const token = url.pathname.replace(/^\//, '').replace(/\.[^.]+$/, '');
  const file = allowedVideos.get(token);
  if (!file) return new Response('Not found', { status: 404 });
  const stat = await fs.promises.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : stat.size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, stat.size - Number(range[2])); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } });
}

/* ---- Voices ---- */
ipcMain.handle('tts:voices', async (_e, provider) => tts.voices(provider));
ipcMain.handle('tts:speak', async (_e, opts) => tts.speak(opts));
ipcMain.handle('tts:key-status', async () => {
  const out = {};
  for (const p of TTS_ONLINE) out[p] = !!(await getKey(p));
  return out;
});
ipcMain.handle('tts:set-key', async (_e, provider, key) => setKey(provider, key));

/* ---- Virtual cable ---- */
let cableJob = null;
ipcMain.handle('cable:install', async () => {
  if (!cableJob) {
    const installer = createCableInstaller({
      bundledDir: path.join(bundledDir(), 'vbcable'),
      onStatus: (t) => send('cable:status', t),
    });
    cableJob = installer.install().finally(() => { cableJob = null; });
  }
  return cableJob;
});

/* ---- Global keyboard shortcuts (only the exact combos you assign) ---- */
ipcMain.handle('hotkeys:set', async (_e, list) => {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const { id, accel } of Array.isArray(list) ? list : []) {
    if (!accel || typeof accel !== 'string') continue;
    try {
      const ok = globalShortcut.register(accel, () => send('hotkey', id));
      if (!ok) failed.push(id);
    } catch { failed.push(id); }
  }
  return { failed };
});

/* ---- Instant replay (Windows): id of the screen whose sound we capture, locally ---- */
ipcMain.handle('replay:source', async () => {
  if (process.platform !== 'win32') return null;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.length ? sources[0].id : null;
});

/* ---- Auto push-to-talk: press/release one key you chose ---- */
ipcMain.handle('ptt:status', async () => keys.status());
ipcMain.handle('ptt:press', async (_e, code, down) => keys.press(code, down));

/* ---- Privacy self-check (also used by the automated tests) ---- */
ipcMain.handle('privacy:check', async () => {
  const results = {};
  try { await fetch('https://example.com'); results.fetch = 'reachable'; } catch (e) { results.fetch = e.message.includes('offline-only') ? 'blocked' : 'error: ' + e.message; }
  try { require('https').get('https://example.com'); results.https = 'reachable'; } catch (e) { results.https = e.message.includes('offline-only') ? 'blocked' : 'error: ' + e.message; }
  try { require('net').connect(443, 'example.com'); results.socket = 'reachable'; } catch (e) { results.socket = e.message.includes('offline-only') ? 'blocked' : 'error: ' + e.message; }
  try { await onlineVoiceFetch('https://example.com'); results.voiceAllowListOther = 'reachable'; } catch (e) { results.voiceAllowListOther = e.message.includes('offline-only') ? 'blocked' : 'error: ' + e.message; }
  return results;
});
// Automated tests only: confirm the optional online voices can actually reach their services.
ipcMain.handle('privacy:online-voices', async () => {
  const out = {};
  for (const [name, url] of [['openai', 'https://api.openai.com/v1/models'], ['elevenlabs', 'https://api.elevenlabs.io/v1/models']]) {
    try { const r = await onlineVoiceFetch(url, { signal: AbortSignal.timeout(15000) }); out[name] = 'reachable (' + r.status + ')'; }
    catch (e) { out[name] = 'error: ' + (e.cause ? (e.cause.code || e.cause.message) : e.message); }
  }
  return out;
});

ipcMain.handle('open-external', async (_e, url) => {
  // Opens a link in your own web browser (only when you click one). The app itself stays offline.
  if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url);
});

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  blockWindowRequests(ses);
  const allowed = new Set(['midi', 'midiSysex', 'media', 'speaker-selection', 'display-capture']);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));

  // Instant replay on Windows: capture "what you hear" (system audio) locally, in memory only.
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => cb(sources.length ? { video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined } : {}))
      .catch(() => cb({}));
  });

  protocol.handle('echo-media', (req) => serveMedia(req).catch((e) => new Response(String(e.message || e), { status: 500 })));

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* user can grant later */ }
  }

  tts = createTts({
    dir: path.join(app.getPath('userData'), 'tts-cache'),
    modelsDir: path.join(app.getPath('userData'), 'voice-models'),
    bundledModelsDir: path.join(bundledDir(), 'voice-models'),
    getKey,
    fetchImpl: onlineVoiceFetch, // only reaches OpenAI / ElevenLabs, only if you added a key
    onProgress: (pct) => send('tts:progress', pct),
  });
  await tts.clearCache(); // spoken clips are temporary; "Save to pad" copies them into the library

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

module.exports = { BLOCKED };
