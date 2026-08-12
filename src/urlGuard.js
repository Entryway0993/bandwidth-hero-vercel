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
  
  // 🛑 SURGICAL FIX: Node's URL parser RETAINS brackets for IPv6 (e.g., "[::1]").
  // net.isIP("[::1]") returns false, bypassing the IP check. We must strip them manually.
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  
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
  const family = options?.family;

  // 🛑 SURGICAL FIX: Use dns.resolve (c-ares) instead of dns.lookup (libc).
  // This is non-blocking, prevents event loop starvation, and ignores /etc/hosts poisoning.
  const resolver = new dns.Resolver();

  const resolvePromises = [];
  if (!family || family === 4) resolvePromises.push(resolver.resolve4(hostname).catch(() => []));
  if (!family || family === 6) resolvePromises.push(resolver.resolve6(hostname).catch(() => []));

  Promise.all(resolvePromises).then(([v4 = [], v6 = []]) => {
    const addresses = [
      ...v4.map(addr => ({ address: addr, family: 4 })),
      ...v6.map(addr => ({ address: addr, family: 6 }))
    ];

    const publicAddresses = addresses.filter(
      entry => entry && entry.address && isPublicIP(entry.address)
    );

    if (!publicAddresses.length) {
      const error = new Error('SSRF_BLOCKED_DNS');
      error.code = 'SSRF_BLOCKED_DNS';
      return callback(error);
    }

    // Sort IPv4 first (matches verbatim: false behavior)
    publicAddresses.sort((a, b) => a.family === 4 ? -1 : 1);

    if (wantsAll) {
      return callback(null, publicAddresses);
    }

    const chosen = publicAddresses[0];
    callback(null, chosen.address, chosen.family);
  }).catch(err => {
    callback(err);
  });
}
