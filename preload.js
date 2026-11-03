'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('echo', {
  platform: process.platform,
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  pickSound: () => ipcRenderer.invoke('sound:pick'),
  importSound: (p) => ipcRenderer.invoke('sound:import', p),
  readSound: (p) => ipcRenderer.invoke('sound:read', p),
  saveSound: (bytes, name, ext) => ipcRenderer.invoke('sound:save', bytes, name, ext),
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  ttsVoices: (provider) => ipcRenderer.invoke('tts:voices', provider),
  ttsSpeak: (opts) => ipcRenderer.invoke('tts:speak', opts),
  onTtsProgress: (cb) => ipcRenderer.on('tts:progress', (_e, pct) => cb(pct)),
  installCable: () => ipcRenderer.invoke('cable:install'),
  onCableStatus: (cb) => ipcRenderer.on('cable:status', (_e, t) => cb(t)),
  setHotkeys: (list) => ipcRenderer.invoke('hotkeys:set', list),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, id) => cb(id)),
  replaySource: () => ipcRenderer.invoke('replay:source'),
  pttStatus: () => ipcRenderer.invoke('ptt:status'),
  pttPress: (code, down) => ipcRenderer.invoke('ptt:press', code, down),
  privacyCheck: () => ipcRenderer.invoke('privacy:check'),
});
