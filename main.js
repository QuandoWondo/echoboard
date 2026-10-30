'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, globalShortcut, systemPreferences, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createTts } = require('./tts');

// MIDI presses aren't "user gestures", so let audio start without one.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];
const configPath = () => path.join(app.getPath('userData'), 'echo-chamber.json');
const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
const keysPath = () => path.join(app.getPath('userData'), 'echo-chamber-keys.json');
const TTS_PROVIDERS = ['openai', 'elevenlabs'];

/* ---- API keys: encrypted with the OS keychain when available, never sent to the window ---- */
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
  if (!TTS_PROVIDERS.includes(provider)) throw new Error('Unknown provider');
  const store = await loadKeys();
  key = String(key || '').trim();
  if (!key) delete store[provider];
  else if (safeStorage.isEncryptionAvailable()) store[provider] = { enc: true, data: safeStorage.encryptString(key).toString('base64') };
  else store[provider] = { enc: false, data: key };
  await fs.promises.writeFile(keysPath(), JSON.stringify(store), { mode: 0o600 });
}

let tts = null;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 940,
    minHeight: 700,
    backgroundColor: '#000000',
    title: 'Echo Chamber',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep MIDI + audio responsive while a game has focus.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('closed', () => { win = null; });
}

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

ipcMain.handle('tts:voices', async (_e, provider) => tts.voices(provider));
ipcMain.handle('tts:speak', async (_e, opts) => tts.speak(opts));
ipcMain.handle('tts:key-status', async () => {
  const out = {};
  for (const p of TTS_PROVIDERS) out[p] = !!(await getKey(p));
  return out;
});
ipcMain.handle('tts:set-key', async (_e, provider, key) => setKey(provider, key));

ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url);
});

app.whenReady().then(async () => {
  const allowed = new Set(['midi', 'midiSysex', 'media', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* user can grant later */ }
  }

  tts = createTts({
    dir: path.join(app.getPath('userData'), 'tts-cache'),
    modelsDir: path.join(app.getPath('userData'), 'voice-models'),
    getKey,
    onProgress: (pct) => { if (win) win.webContents.send('tts:progress', pct); },
  });
  await tts.clearCache(); // spoken clips are temporary; "Save to pad" copies them into the library

  createWindow();

  // Panic button that works even while a game is focused.
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (win) win.webContents.send('stop-all');
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
