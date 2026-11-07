'use strict';
/* Echo Board never talks to the internet. This module enforces that for the whole app:
   - Node-side: fetch, http/https, net sockets to anything but this computer throw.
   - Window-side: every http(s)/ws(s) request is cancelled (see blockWindowRequests).
   Everything the app needs (voices, VB-CABLE installer) ships inside the installer.
   Exception: optional online voices (OpenAI / ElevenLabs), only if you add your own key. */

const BLOCKED = 'Echo Board is offline-only: network access is blocked.';

const isLocalHost = (host) => {
  host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '' || host === 'localhost' || host === '::1' || /^127\./.test(host);
};

// The ONE exception: optional online text-to-speech you turn on by adding your own API key.
// Only these two services, only over HTTPS, and only for the voice requests in tts.js.
const ONLINE_VOICE_HOSTS = new Set(['api.openai.com', 'api.elevenlabs.io']);
let realFetch = null;
async function onlineVoiceFetch(url, init) {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' || !ONLINE_VOICE_HOSTS.has(u.hostname)) throw new Error(BLOCKED + ' (' + u.hostname + ')');
  if (!realFetch) throw new Error(BLOCKED);
  return realFetch(u.href, init);
}

let installed = false;
function lockDownNode() {
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch; // kept private; only onlineVoiceFetch can use it

  const deny = () => { throw new Error(BLOCKED); };

  // fetch(): only data:, blob: and file: URLs
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : (input && (input.href || input.url)) || '');
    if (/^(data|blob|file):/i.test(url)) throw new Error('Local fetch is not used by Echo Board.');
    throw new Error(BLOCKED + ' (' + url.slice(0, 80) + ')');
  };

  for (const mod of ['http', 'https']) {
    const m = require(mod);
    m.request = deny;
    m.get = deny;
  }
  try { require('http2').connect = deny; } catch { /* not available */ }

  // TLS + raw sockets: only this computer, or the two optional online-voice services
  const allowedHost = (h) => isLocalHost(h) || ONLINE_VOICE_HOSTS.has(String(h || '').toLowerCase());
  const tls = require('tls');
  const origTls = tls.connect;
  tls.connect = function (...args) {
    const o = typeof args[0] === 'object' && args[0] ? args[0] : (typeof args[2] === 'object' ? args[2] : {});
    const host = o.servername || o.host || (typeof args[1] === 'string' ? args[1] : '');
    if (!allowedHost(host)) throw new Error(BLOCKED);
    return origTls.apply(this, args);
  };

  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const opts = args[0];
    if (typeof opts === 'object' && opts && opts.path) return origConnect.apply(this, args); // named pipe / unix socket
    if (Array.isArray(opts) && opts[0] && opts[0].path) return origConnect.apply(this, args);
    const host = typeof opts === 'object' && opts ? opts.host : args[1];
    if (!allowedHost(host)) throw new Error(BLOCKED);
    return origConnect.apply(this, args);
  };
  net.connect = net.createConnection = function (...args) {
    const s = new net.Socket();
    return s.connect(...args);
  };

  try {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = function (hostname, ...rest) {
      if (allowedHost(hostname)) return origLookup.call(this, hostname, ...rest);
      const cb = rest.find((x) => typeof x === 'function');
      if (cb) process.nextTick(cb, new Error(BLOCKED));
    };
    const denyCb = (...a) => { const cb = a.find((x) => typeof x === 'function'); if (cb) process.nextTick(cb, new Error(BLOCKED)); };
    dns.resolve = denyCb;
    if (dns.promises) {
      const origP = dns.promises.lookup;
      dns.promises.lookup = async (h, ...r) => { if (allowedHost(h)) return origP(h, ...r); throw new Error(BLOCKED); };
      dns.promises.resolve = async () => { throw new Error(BLOCKED); };
    }
  } catch { /* ignore */ }
}

// Cancel every web request from the app window (pages are loaded from local files only).
function blockWindowRequests(session) {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, cb) => cb({ cancel: true }),
  );
}

module.exports = { lockDownNode, blockWindowRequests, onlineVoiceFetch, ONLINE_VOICE_HOSTS, BLOCKED };
