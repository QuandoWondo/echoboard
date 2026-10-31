'use strict';
/* One-click virtual cable setup (runs in the main process).
   Downloads the official VB-CABLE driver pack from VB-Audio and runs its installer with the
   system's own admin prompt. VB-CABLE is made by VB-Audio (vb-cable.com) and is donationware;
   VB-Audio allows apps to install it as long as users can see what it is and where it comes from. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const PAGE = 'https://vb-audio.com/Cable/';
const FALLBACK_URL = {
  win32: 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
  darwin: 'https://download.vb-audio.com/Download_MAC/VBCable_MACDriver_Pack108.zip',
};
const LINK_RE = {
  win32: /https?:\/\/download\.vb-audio\.com\/Download_CABLE\/VBCABLE_Driver_Pack(\d+)\.zip/gi,
  darwin: /https?:\/\/download\.vb-audio\.com\/Download_MAC\/VBCable_MACDriver_Pack(\d+)\.zip/gi,
};

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim() || 'Command failed'));
      else resolve(String(stdout));
    });
  });
}

// Every file under dir (plus .pkg bundles, which are folders on macOS).
async function walk(dir) {
  const out = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !/\.pkg$/i.test(e.name)) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

function createCableInstaller({
  platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch,
  run = defaultRun, tmpRoot = os.tmpdir(), onStatus = () => {},
} = {}) {
  const ps = (script, env, opts = {}) => run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { ...opts, env: { ...process.env, ...env } });

  // Newest driver pack linked from VB-Audio's page, or a known-good version.
  async function findDownloadUrl() {
    try {
      const res = await fetchImpl(PAGE, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const html = await res.text();
        let best = null;
        for (const m of html.matchAll(LINK_RE[platform])) {
          if (!best || Number(m[1]) > best.n) best = { n: Number(m[1]), url: m[0] };
        }
        if (best) return best.url;
      }
    } catch { /* fall through */ }
    return FALLBACK_URL[platform];
  }

  async function download(url, dest) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000 || buf.toString('latin1', 0, 2) !== 'PK') throw new Error('The download was not a valid zip file.');
    await fs.promises.writeFile(dest, buf);
  }

  async function installWindows(files) {
    const exes = files.filter((f) => /setup.*\.exe$/i.test(path.basename(f)));
    const name = (f) => path.basename(f);
    const pick = (arch === 'arm64' && exes.find((f) => /arm64/i.test(name(f))))
      || exes.find((f) => /x64/i.test(name(f)))
      || exes.find((f) => !/arm/i.test(name(f)));
    if (!pick) throw new Error("Couldn't find the VB-CABLE setup program in the download.");
    onStatus('Waiting for your approval: click Yes, then Install…');
    try {
      // -i = install, -h = no setup window (Windows still shows its own driver prompt).
      await ps(
        "$p = Start-Process -FilePath $env:EC_EXE -ArgumentList '-i','-h' -WorkingDirectory (Split-Path -Parent $env:EC_EXE) -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode",
        { EC_EXE: pick }, { timeout: 15 * 60 * 1000 });
    } catch (e) {
      if (/cancel/i.test(e.message)) return { cancelled: true };
      throw e;
    }
    return { ok: true, restart: true };
  }

  async function installMac(files, work) {
    const isPkg = (f) => /\.pkg$/i.test(f) && !/uninstall/i.test(path.basename(f));
    let pkgs = files.filter(isPkg);
    let mount = null;
    try {
      if (!pkgs.length) {
        const dmg = files.find((f) => /\.dmg$/i.test(f));
        if (!dmg) throw new Error("Couldn't find the VB-CABLE installer in the download.");
        mount = path.join(work, 'mnt');
        await fs.promises.mkdir(mount, { recursive: true });
        await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
        pkgs = (await walk(mount)).filter(isPkg);
      }
      if (!pkgs.length) throw new Error("Couldn't find the VB-CABLE installer in the download.");
      const pkg = pkgs.find((f) => /cable/i.test(path.basename(f))) || pkgs[0];
      onStatus('Waiting for your Mac password…');
      try {
        await run('osascript', ['-e',
          'do shell script "/usr/sbin/installer -pkg " & quoted form of (system attribute "EC_PKG") & ' +
          '" -target / && (/usr/bin/killall coreaudiod || true)" with administrator privileges ' +
          'with prompt "Echo Chamber wants to install the VB-CABLE virtual microphone."'],
        { env: { ...process.env, EC_PKG: pkg }, timeout: 15 * 60 * 1000 });
      } catch (e) {
        if (/-128|cancel/i.test(e.message)) return { cancelled: true };
        throw e;
      }
      return { ok: true, restart: false };
    } finally {
      if (mount) await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
    }
  }

  async function install() {
    if (platform !== 'win32' && platform !== 'darwin') throw new Error('Automatic setup works on Windows and Mac.');
    const work = await fs.promises.mkdtemp(path.join(tmpRoot, 'echo-cable-'));
    try {
      onStatus('Downloading VB-CABLE from vb-audio.com…');
      const zip = path.join(work, 'cable.zip');
      await download(await findDownloadUrl(), zip);
      onStatus('Unpacking…');
      const out = path.join(work, 'files');
      await fs.promises.mkdir(out);
      if (platform === 'win32') {
        await ps('Expand-Archive -LiteralPath $env:EC_ZIP -DestinationPath $env:EC_OUT -Force', { EC_ZIP: zip, EC_OUT: out });
      } else {
        await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      }
      const files = await walk(out);
      return platform === 'win32' ? await installWindows(files) : await installMac(files, work);
    } finally {
      fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { install, findDownloadUrl };
}

module.exports = { createCableInstaller, walk };
