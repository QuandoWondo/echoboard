// Launches the packaged app the way a user would and records what works and what breaks.
// Usage: node ci/diagnose.js <path to Echo Board executable> <output dir>
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const exe = process.argv[2];
const out = process.argv[3] || 'diag';
fs.mkdirSync(out, { recursive: true });
const report = { exe, platform: process.platform, steps: [], console: [], pageErrors: [], main: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log('STEP', name, JSON.stringify(data)); };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-user-'));
  const testVideo = path.join(os.tmpdir(), 'eb-video.wav');
  {
    const n = 48000 * 4, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 9000), 44 + i * 2);
    fs.writeFileSync(testVideo, b);
  }
  const app = await _electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`], timeout: 60000, env: { ...process.env, ECHO_TEST_VIDEO: testVideo } });
  app.process().stdout.on('data', (d) => report.main.push('OUT ' + d.toString().trim()));
  app.process().stderr.on('data', (d) => report.main.push('ERR ' + d.toString().trim()));
  const win = await app.firstWindow();
  win.on('console', (m) => report.console.push(`${m.type()}: ${m.text()}`));
  win.on('pageerror', (e) => report.pageErrors.push(String(e && e.stack || e)));
  await win.waitForTimeout(8000);
  await win.screenshot({ path: path.join(out, '1-start.png') });

  const ui = () => win.evaluate(() => ({
    hasEcho: typeof window.echo === 'object',
    echoKeys: window.echo ? Object.keys(window.echo) : [],
    chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent),
    voiceOptions: [...document.querySelectorAll('#tts-voice option')].map((o) => o.textContent),
    provider: document.querySelector('#tts-provider') && document.querySelector('#tts-provider').value,
    overlays: [...document.querySelectorAll('.overlay')].filter((o) => !o.classList.contains('hidden')).map((o) => o.id),
    pads: document.querySelectorAll('.pad').length,
    editorTitle: document.querySelector('#ed-title') && document.querySelector('#ed-title').textContent,
  }));
  step('after-load', await ui());

  // Close any first-run overlay, then poke the main controls.
  await win.keyboard.press('Escape');
  const tryClick = async (sel) => {
    try { await win.click(sel, { timeout: 3000 }); return 'clicked'; } catch (e) { return 'FAILED: ' + e.message.split('\n')[0]; }
  };
  step('click-pad', { r: await tryClick('.pad >> nth=5'), ui: await ui() });
  step('click-settings', { r: await tryClick('#btn-settings'), ui: await ui() });
  await win.screenshot({ path: path.join(out, '2-settings.png') });
  await win.keyboard.press('Escape');
  step('click-help', { r: await tryClick('#btn-help'), ui: await ui() });
  await win.keyboard.press('Escape');
  step('click-cable-chip', { r: await tryClick('#chip-out'), ui: await ui() });
  await win.keyboard.press('Escape');

  // IPC calls behind the buttons
  const call = async (name, fn, arg) => {
    const t0 = Date.now();
    try {
      const r = await win.evaluate(([f, a]) => Promise.race([
        window.echo[f](a),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 120s')), 120000)),
      ]), [fn, arg]);
      step(name, { ok: true, ms: Date.now() - t0, result: JSON.stringify(r).slice(0, 400) });
      return r;
    } catch (e) { step(name, { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 800) }); return null; }
  };
  await call('ipc-loadConfig', 'loadConfig');
  const wav = path.join(os.tmpdir(), 'eb-test.wav');
  {
    const n = 22050, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
    fs.writeFileSync(wav, b);
  }
  const imported = await call('ipc-importSound', 'importSound', wav);
  if (imported) {
    step('assign-and-play', await win.evaluate(async (p) => {
      try {
        await assignFile(selected, p);
        await press(selected);
        await new Promise((r) => setTimeout(r, 300));
        return { ok: true, playing: engine.isPlaying(vk(selected)), padName: state.pads[selected].name };
      } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
    }, imported));
  }
  await call('ipc-ttsVoices-kokoro', 'ttsVoices', 'kokoro');
  await call('ipc-ttsVoices-system', 'ttsVoices', 'system');
  await call('ipc-ttsSpeak-system', 'ttsSpeak', { provider: 'system', voice: '', text: 'System voice test.' });
  await call('ipc-ttsSpeak-kokoro', 'ttsSpeak', { provider: 'kokoro', voice: 'af_heart', text: 'Free voice test.' });

  // Text box end to end
  await win.fill('#tts-text', 'hello from the test');
  step('tts-speak-button', { r: await tryClick('#tts-speak') });
  await win.waitForTimeout(15000);
  step('after-speak', { ui: await ui(), status: await win.evaluate(() => [document.querySelector('#tts-status').textContent, document.querySelector('#toast').textContent, document.querySelector('#tts-history').children.length]) });
  await win.screenshot({ path: path.join(out, '3-after-speak.png') });

  // ---- v0.5 features ----
  step('privacy-window-fetch', await win.evaluate(async () => {
    try { await fetch('https://example.com', { cache: 'no-store' }); return { blocked: false }; } catch (e) { return { blocked: true, error: String(e) }; }
  }));
  await call('privacy-main', 'privacyCheck');
  await call('ptt-status', 'pttStatus');
  step('ptt-press-F24', await win.evaluate(async () => {
    try { await echo.pttPress('F24', true); await echo.pttPress('F24', false); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  }));
  await call('hotkey-register', 'setHotkeys', [{ id: 'test', accel: 'Ctrl+Alt+F12' }, { id: 'action:stopAll', accel: 'CommandOrControl+Shift+K' }]);
  step('engine-features', await win.evaluate(async () => {
    try {
      setFx({ on: true, effect: 'deep' });
      setFx({ effect: 'robot' });
      setFx({ on: false });
      switchPage(2); const p3 = profile().page; switchPage(0);
      return { ok: true, worklets: engine.worklets, fxReady: !!engine.fx, page3: p3, pages: document.querySelectorAll('.page-tab').length, actions: Object.keys(state.actions).length };
    } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
  }));
  step('replay', await win.evaluate(async () => {
    try {
      state.settings.replay.enabled = true;
      await startReplay();
      await press(selected);
      await new Promise((r) => setTimeout(r, 3000));
      return { ok: true, mode: replay.mode, chunks: replay.chunks.length, node: !!replay.node, status: document.querySelector('#set-replay-status').textContent };
    } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
  }));
  step('video-import', await win.evaluate(async () => {
    try {
      select(20);
      await openVideoImport();
      const v = document.querySelector('#vid');
      await new Promise((res, rej) => { if (v.readyState >= 1) res(); v.addEventListener('loadedmetadata', res, { once: true }); v.addEventListener('error', () => rej(new Error('video error ' + (v.error && v.error.code))), { once: true }); setTimeout(() => rej(new Error('metadata timeout')), 10000); });
      v.currentTime = 1;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      document.querySelector('#vid-start').click();
      v.currentTime = 2;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      document.querySelector('#vid-end').click();
      const range = document.querySelector('#vid-range').textContent;
      await saveVideoClip();
      return { ok: !!state.pads[20].file, range, padName: state.pads[20].name, status: document.querySelector('#vid-status').textContent, duration: v.duration };
    } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
  }));
  await win.screenshot({ path: path.join(out, '4-v05.png') });

  step('final', await ui());
  save();
  await app.close().catch(() => {});
})().catch((e) => { report.fatal = String(e && e.stack || e); save(); console.error(e); process.exit(0); });
