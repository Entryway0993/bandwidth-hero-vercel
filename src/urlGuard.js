import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1'
]);

const BLOCKED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.invalid',
  '.home.arpa',
  '.arpa'
];

export function isPublicIP(ip) {
  try {
    let addr = ipaddr.parse(ip);

    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }

    return addr.range() === 'unicast';
  } catch {
    return false;
  }
}

export function parseSafeUrl(input) {
  let raw = String(input || '').trim();

  if (!raw) return null;

  if (/^https?%3A/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;

  const host = url.hostname.replace(/^[|]$/g, '').toLowerCase();

  if (!host) return null;
  if (BLOCKED_HOSTS.has(host)) return null;

  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return null;
  }

  if (net.isIP(host) && !isPublicIP(host)) {
    return null;
  }

  return url;
}

export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const wantsAll = Boolean(options?.all);

  const lookupOptions = {
    all: true,
    verbatim: false
  };

  if (options?.family === 4 || options?.family === 6) {
    lookupOptions.family = options.family;
  }

  dns.lookup(hostname, lookupOptions, (err, addresses) => {
    if (err) return callback(err);

    const publicAddresses = (addresses || []).filter(
      entry => entry && entry.address && isPublicIP(entry.address)
    );

    if (!publicAddresses.length) {
      const error = new Error('SSRF_BLOCKED_DNS');
      error.code = 'SSRF_BLOCKED_DNS';
      return callback(error);
    }

    publicAddresses.sort((a, b) => {
      if (a.family === b.family) return 0;
      return a.family === 4 ? -1 : 1;
    });

    if (wantsAll) {
      return callback(null, publicAddresses);
    }

    const chosen = publicAddresses[0];

    callback(null, chosen.address, chosen.family);
  });
}
