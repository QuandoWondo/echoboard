#!/usr/bin/env node
'use strict';
/* Gathers everything the installer ships so Echo Chamber works offline on first launch:
   - the free AI voice model (Kokoro-82M, 8-bit) and all of its voices  -> bundled/voice-models
   - the official VB-CABLE driver pack for the target platform          -> bundled/vbcable/<win|mac>
   Usage: node scripts/fetch-bundled.js [win32|darwin]   (defaults to this computer) */

const path = require('path');
const fs = require('fs');
const { KOKORO_MODEL, KOKORO_FILES } = require('../tts');
const { createCableInstaller } = require('../cable');

const platform = process.argv[2] || process.platform;
if (platform !== 'win32' && platform !== 'darwin') {
  console.error('Pass win32 or darwin.');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..', 'bundled');

async function fetchWithRetry(url, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      console.warn(`  retry ${i}/${tries} for ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

async function fetchVoices() {
  const dir = path.join(ROOT, 'voice-models', ...KOKORO_MODEL.split('/'));
  let bytes = 0;
  for (const file of KOKORO_FILES) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { bytes += fs.statSync(dest).size; continue; }
    console.log('voice model:', file);
    const buf = await fetchWithRetry(`https://huggingface.co/${KOKORO_MODEL}/resolve/main/${file}`);
    if (file.endsWith('.onnx') && buf.length < 50e6) throw new Error(`${file} looks too small (${buf.length} bytes)`);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, buf);
    bytes += buf.length;
  }
  console.log(`voice model ready: ${KOKORO_FILES.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
}

async function fetchCable() {
  const dir = path.join(ROOT, 'vbcable', platform === 'win32' ? 'win' : 'mac');
  await fs.promises.mkdir(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.zip'));
  if (existing.length) { console.log('VB-CABLE ready:', existing.join(', ')); return; }
  const url = await createCableInstaller({ platform }).findDownloadUrl();
  console.log('VB-CABLE:', url);
  const buf = await fetchWithRetry(url);
  if (buf.toString('latin1', 0, 2) !== 'PK') throw new Error('VB-CABLE download is not a zip');
  await fs.promises.writeFile(path.join(dir, url.split('/').pop()), buf);
  console.log(`VB-CABLE ready: ${(buf.length / 1e6).toFixed(1)} MB`);
}

(async () => {
  await fetchVoices();
  await fetchCable();
})().catch((e) => {
  console.error('Could not gather bundled files:', e.message);
  process.exit(1);
});
