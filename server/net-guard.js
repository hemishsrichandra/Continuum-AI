// Outbound network protection for company data connectors (REST and PostgreSQL).
//
// Checking a URL's text is not enough: a hostname can resolve to a public address when it is validated and to a
// private one when the connection is made (DNS rebinding). Here the destination is resolved ONCE, every address is
// validated, and the connection is then made to that exact address ("address pinning"). TLS still verifies the
// original hostname, redirects are never followed (so credentials cannot be forwarded elsewhere), and responses
// are bounded in time and size.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

// ---- address classification -------------------------------------------------------------------------------
// Addresses are parsed to bytes and classified numerically, never by string prefix: the same destination can be written
// many ways (compressed or expanded IPv6, dotted or hexadecimal IPv4-mapped IPv6, NAT64, 6to4), and a string check that
// misses one spelling is an SSRF bypass. Anything that cannot be parsed is treated as unsafe.
function parseV4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.some((n) => n > 255) ? null : octets;
}
function parseV6(input) {
  let text = String(input).toLowerCase();
  if (text.includes('%')) return null; // zone identifiers are never valid destinations
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const v4 = colon < 0 ? null : parseV4(text.slice(colon + 1));
    if (!v4) return null;
    text = text.slice(0, colon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { const n = parseInt(g, 16); bytes[2 * i] = n >> 8; bytes[2 * i + 1] = n & 255; });
  return bytes;
}
function privateV4([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-network, private, loopback, multicast, reserved and broadcast
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments and documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // documentation
  );
}
function privateV6(x) {
  const zero = (from, to) => x.slice(from, to).every((v) => v === 0);
  const v4 = (at) => privateV4([x[at], x[at + 1], x[at + 2], x[at + 3]]);
  if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) return v4(12); // IPv4-mapped (any spelling): judge the IPv4 address inside
  if (zero(0, 12)) return true; // ::, ::1 and the deprecated IPv4-compatible block
  if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return zero(4, 12) ? v4(12) : true; // NAT64 64:ff9b::/96 and the local-use block
  if ((x[0] & 0xe0) !== 0x20) return true; // only global unicast 2000::/3 may be contacted; this excludes fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 and more
  if (x[0] === 0x20 && x[1] === 0x02) return v4(2); // 6to4: judge the embedded IPv4 address
  if (x[0] === 0x20 && x[1] === 0x01) {
    if (x[2] === 0 && x[3] === 0) return true; // Teredo
    if (x[2] === 0x0d && x[3] === 0xb8) return true; // documentation
    if (x[2] === 0 && (x[3] & 0xf0) === 0x10) return true; // ORCHID
    if (x[2] === 0 && x[3] === 0x02 && x[4] === 0 && x[5] === 0) return true; // benchmarking
  }
  return false;
}
export function isPrivateAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '');
  const kind = isIP(text);
  if (kind === 4) {
    const octets = parseV4(text);
    return octets ? privateV4(octets) : true;
  }
  if (kind === 6) {
    const bytes = parseV6(text);
    return bytes ? privateV6(bytes) : true;
  }
  return true; // not an IP address: unknown, treat as unsafe
}
export const isLoopbackName = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
const bare = (host) => host.replace(/^\[|\]$/g, '');
const deny = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Resolve a hostname once and return the addresses that may be connected to. Every resolved address must be public
 * (loopback is allowed only for an explicitly permitted development host). Throws a user-safe error otherwise.
 */
export async function resolveAllowed(hostname, { allowLoopback = false, resolver = dnsLookup } = {}) {
  const host = bare(hostname);
  if (isIP(host)) {
    if (isPrivateAddress(host) && !(allowLoopback && isLoopbackName(hostname))) throw deny('Private and loopback addresses are not allowed.');
    return [{ address: host, family: isIP(host) }];
  }
  if (isLoopbackName(hostname)) {
    if (!allowLoopback) throw deny('Private and loopback addresses are not allowed.');
    return [{ address: '127.0.0.1', family: 4 }];
  }
  let addresses;
  try {
    addresses = await resolver(host, { all: true });
  } catch {
    throw deny('The host could not be resolved.');
  }
  if (!addresses?.length || addresses.some((a) => isPrivateAddress(a.address))) throw deny('Private and loopback addresses are not allowed.');
  return addresses.map((a) => ({ address: a.address, family: a.family || isIP(a.address) }));
}

/**
 * One GET to a pre-validated destination. The socket is opened to `address` (never re-resolved), `Host`/SNI and
 * certificate checks use the original hostname, redirects are rejected, and time and size are capped.
 */
export function pinnedGet({ url, address, family, headers = {}, timeoutMs = 12000, maxBytes = 4 * 1048576, requestImpl = null }) {
  const secure = url.protocol === 'https:';
  const options = {
    method: 'GET',
    hostname: bare(url.hostname),
    port: url.port || (secure ? 443 : 80),
    path: url.pathname + url.search,
    headers: { ...headers, Host: url.host },
    timeout: timeoutMs,
    // The only place a name becomes an address: always the pinned one.
    lookup: (host, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (opts && typeof opts === 'object' && opts.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
    ...(secure && { servername: bare(url.hostname) }),
  };
  return new Promise((resolve, reject) => {
    const req = (requestImpl || (secure ? https : http).request)(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(deny('The source redirected the request; redirects are not followed.', 502));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(deny('The response is too large.', 413));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => reject(deny('The source could not be read.', 503)));
    });
    req.on('timeout', () => req.destroy(deny('The source timed out.', 503)));
    req.on('error', (e) => reject(e.status ? e : deny('The source could not be reached.', 503)));
    req.end();
  });
}

/**
 * Validate a PostgreSQL destination. Connection strings are never passed to the driver as-is: they are parsed, only a
 * short list of parameters is accepted, and host/port are checked against the server owner's allowlists. A unix-socket
 * path, an unlisted host or port, or a name that resolves to a private address is refused.
 */
export async function resolvePostgresDestination(uri, { allowedHosts, allowedPorts, allowLoopback = false, resolver = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(String(uri));
  } catch {
    throw deny('Enter a valid PostgreSQL connection string.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw deny('Enter a postgres:// connection string.');
  const allowedParams = new Set(['sslmode']);
  for (const key of url.searchParams.keys()) if (!allowedParams.has(key)) throw deny(`The connection option “${key}” is not allowed.`);
  const host = decodeURIComponent(url.hostname);
  if (!host || host.startsWith('/') || host.includes('\0')) throw deny('A database host name is required.');
  const port = Number(url.port) || 5432;
  if (!allowedHosts.has(host.toLowerCase())) throw deny('The server owner must allow this database host in DATA_SOURCE_POSTGRES_HOSTS before it can be used.');
  if (!allowedPorts.has(port)) throw deny('The server owner must allow this database port in DATA_SOURCE_POSTGRES_PORTS before it can be used.');
  const addresses = await resolveAllowed(url.hostname, { allowLoopback, resolver });
  const sslmode = url.searchParams.get('sslmode') || 'require';
  if (!['require', 'verify-full', 'disable'].includes(sslmode)) throw deny('sslmode must be require or verify-full.');
  if (sslmode === 'disable' && !allowLoopback) throw deny('Encrypted (TLS) connections are required.');
  return {
    host,
    address: addresses[0].address,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    tls: sslmode !== 'disable',
  };
}
