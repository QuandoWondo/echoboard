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
  const app = await _electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`], timeout: 60000 });
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
        return { ok: true, playing: engine.isPlaying(selected), name: state.pads[selected].name };
      } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
    }, imported));
  }
  await call('ipc-ttsVoices-kokoro', 'ttsVoices', 'kokoro');
  await call('ipc-ttsVoices-system', 'ttsVoices', 'system');
  await call('ipc-ttsSpeak-system', 'ttsSpeak', { provider: 'system', voice: '', text: 'System voice test.' });
  await call('ipc-ttsSpeak-kokoro', 'ttsSpeak', { provider: 'kokoro', voice: 'af_heart', text: 'Free voice test.' });
  await call('ipc-keyStatus', 'ttsKeyStatus');

  // Text box end to end
  await win.fill('#tts-text', 'hello from the test');
  step('tts-speak-button', { r: await tryClick('#tts-speak') });
  await win.waitForTimeout(15000);
  step('after-speak', { ui: await ui(), status: await win.evaluate(() => [document.querySelector('#tts-status').textContent, document.querySelector('#toast').textContent, document.querySelector('#tts-history').children.length]) });
  await win.screenshot({ path: path.join(out, '3-after-speak.png') });

  step('final', await ui());
  save();
  await app.close().catch(() => {});
})().catch((e) => { report.fatal = String(e && e.stack || e); save(); console.error(e); process.exit(0); });
