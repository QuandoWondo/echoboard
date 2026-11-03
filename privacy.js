'use strict';
/* Echo Board never talks to the internet. This module enforces that for the whole app:
   - Node-side: fetch, http/https, net sockets to anything but this computer throw.
   - Window-side: every http(s)/ws(s) request is cancelled (see blockWindowRequests).
   Everything the app needs (voices, VB-CABLE installer) ships inside the installer. */

const BLOCKED = 'Echo Board is offline-only: network access is blocked.';

const isLocalHost = (host) => {
  host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '' || host === 'localhost' || host === '::1' || /^127\./.test(host);
};

let installed = false;
function lockDownNode() {
  if (installed) return;
  installed = true;

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
  for (const mod of ['http2', 'tls']) {
    try { const m = require(mod); m.connect = deny; } catch { /* not available */ }
  }

  // Raw sockets: allow only connections to this computer (some libraries use local pipes)
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const opts = args[0];
    const host = typeof opts === 'object' && opts ? (opts.path ? 'localhost' : opts.host) : args[1];
    if (typeof opts === 'object' && opts && opts.path) return origConnect.apply(this, args); // named pipe / unix socket
    if (!isLocalHost(host)) throw new Error(BLOCKED);
    return origConnect.apply(this, args);
  };
  net.connect = net.createConnection = function (...args) {
    const s = new net.Socket();
    return s.connect(...args);
  };

  try {
    const dns = require('dns');
    const denyCb = (...a) => { const cb = a.find((x) => typeof x === 'function'); if (cb) process.nextTick(cb, new Error(BLOCKED)); };
    dns.lookup = denyCb; dns.resolve = denyCb;
    if (dns.promises) { dns.promises.lookup = async () => { throw new Error(BLOCKED); }; dns.promises.resolve = dns.promises.lookup; }
  } catch { /* ignore */ }
}

// Cancel every web request from the app window (pages are loaded from local files only).
function blockWindowRequests(session) {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, cb) => cb({ cancel: true }),
  );
}

module.exports = { lockDownNode, blockWindowRequests, BLOCKED };
