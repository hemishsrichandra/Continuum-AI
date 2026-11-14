import { isIP } from 'node:net';

// Request-local identity is set by the internal proxy adapter, never by an HTTP property/header directly.
const addressKey = Symbol('clientAddress');
export function normalizeAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.startsWith('::ffff:') && isIP(text.slice(7)) === 4) return text.slice(7);
  if (!isIP(text) || text.includes('%')) return null;
  if (isIP(text) === 4) return text;
  const canonical = new URL('http://[' + text + ']').hostname.slice(1, -1);
  const mapped = canonical.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (!mapped) return canonical;
  const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}
export const clientAddress = (req) => req[addressKey] || normalizeAddress(req.socket?.remoteAddress) || 'unknown';
export function setClientAddress(req, address) {
  const valid = normalizeAddress(address);
  if (valid) req[addressKey] = valid;
}
export function trustedProxies(value = '') {
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const addresses = list.map(normalizeAddress);
  if (addresses.some((a) => !a)) throw new Error('TRUSTED_PROXY_IPS must contain only literal IP addresses.');
  return new Set(addresses);
}
export function publicClientAddress(req, trusted = new Set()) {
  const peer = normalizeAddress(req.socket?.remoteAddress);
  if (!peer || !trusted.has(peer)) return peer || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 2048) return peer;
  const chain = forwarded.split(',').map(normalizeAddress);
  if (!chain.length || chain.length > 32 || chain.some((a) => !a)) return peer;
  // Walk from the socket backwards. A client-supplied prefix cannot override the first untrusted hop.
  let address = peer;
  for (let i = chain.length - 1; i >= 0 && trusted.has(address); i--) address = chain[i];
  return address;
}
