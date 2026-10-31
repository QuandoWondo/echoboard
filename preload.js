'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('echo', {
  platform: process.platform,
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  pickSound: () => ipcRenderer.invoke('sound:pick'),
  importSound: (p) => ipcRenderer.invoke('sound:import', p),
  readSound: (p) => ipcRenderer.invoke('sound:read', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  ttsVoices: (provider) => ipcRenderer.invoke('tts:voices', provider),
  ttsSpeak: (opts) => ipcRenderer.invoke('tts:speak', opts),
  ttsKeyStatus: () => ipcRenderer.invoke('tts:key-status'),
  ttsSetKey: (provider, key) => ipcRenderer.invoke('tts:set-key', provider, key),
  onTtsProgress: (cb) => ipcRenderer.on('tts:progress', (_e, pct) => cb(pct)),
  installCable: () => ipcRenderer.invoke('cable:install'),
  onCableStatus: (cb) => ipcRenderer.on('cable:status', (_e, t) => cb(t)),
  onStopAll: (cb) => ipcRenderer.on('stop-all', () => cb()),
});
