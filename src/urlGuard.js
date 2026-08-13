import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  '::'
]);

const BLOCKED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.invalid',
  '.home.arpa',
  '.arpa',
  '.onion',
  '.i2p',
  '.exit'
];

function ssrfError() {
  const error = new Error('SSRF_BLOCKED_DNS');
  error.code = 'SSRF_BLOCKED_DNS';
  return error;
}

function normalizeHost(hostname) {
  let host = String(hostname || '').toLowerCase().trim();

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  return host;
}

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
    } catch {
      return null;
    }
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;

  const host = normalizeHost(url.hostname);

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
  const family = Number(options?.family) || 0;

  const host = normalizeHost(hostname);

  if (!host) {
    return callback(ssrfError());
  }

  if (BLOCKED_HOSTS.has(host)) {
    return callback(ssrfError());
  }

  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return callback(ssrfError());
  }

  // Fast path for direct IP literals.
  if (net.isIP(host)) {
    if (!isPublicIP(host)) {
      return callback(ssrfError());
    }

    const ipFamily = net.isIPv6(host) ? 6 : 4;

    if (family && family !== 0 && family !== ipFamily) {
      return callback(ssrfError());
    }

    if (wantsAll) {
      return callback(null, [{ address: host, family: ipFamily }]);
    }

    return callback(null, host, ipFamily);
  }

  // Non-blocking DNS resolution.
  const tasks = [];

  if (!family || family === 0 || family === 4) {
    tasks.push(dns.promises.resolve4(host).catch(() => []));
  }

  if (!family || family === 0 || family === 6) {
    tasks.push(dns.promises.resolve6(host).catch(() => []));
  }

  Promise.all(tasks)
    .then(([v4 = [], v6 = []]) => {
      const addresses = [];

      for (const address of v4) {
        if (isPublicIP(address)) {
          addresses.push({ address, family: 4 });
        }
      }

      for (const address of v6) {
        if (isPublicIP(address)) {
          addresses.push({ address, family: 6 });
        }
      }

      if (!addresses.length) {
        return callback(ssrfError());
      }

      // Prefer IPv4, similar to verbatim:false behavior.
      addresses.sort((a, b) => {
        if (a.family === b.family) return 0;
        return a.family === 4 ? -1 : 1;
      });

      if (wantsAll) {
        return callback(null, addresses);
      }

      const chosen = addresses[0];
      return callback(null, chosen.address, chosen.family);
    })
    .catch(err => {
      callback(err);
    });
}
