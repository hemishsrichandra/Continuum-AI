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

export function isPrivateAddress(address) {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('ff')) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true; // not an IP: unknown, treat as unsafe
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
