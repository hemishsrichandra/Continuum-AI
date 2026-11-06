import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const requestedApiPort = Number(process.env.API_PORT || 5000);
const frontendPort = Number(process.env.FRONTEND_PORT || 3000);
const host = '127.0.0.1';
const routes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/about': ['index.html', 'text/html; charset=utf-8'],
  '/services': ['index.html', 'text/html; charset=utf-8'],
  '/pricing': ['index.html', 'text/html; charset=utf-8'],
  '/book-a-session': ['index.html', 'text/html; charset=utf-8'],
  '/style-guide': ['index.html', 'text/html; charset=utf-8'],
  '/pages.js': ['pages.js', 'text/javascript; charset=utf-8'],
  '/operator': ['index.html', 'text/html; charset=utf-8'],
  '/operator.js': ['operator.js', 'text/javascript; charset=utf-8'],
  '/desk': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/auth-ui.js': ['auth-ui.js', 'text/javascript; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
};
process.env.APP_URL ||= 'http://localhost:' + frontendPort;
process.env.ENABLE_OUTBOX_WORKER ||= 'true';
const auditEnabled = process.env.A11Y_AUDIT === 'true' && process.env.NODE_ENV !== 'production';
if (auditEnabled) {
  routes['/audit.js'] = ['audit.js', 'text/javascript; charset=utf-8'];
  routes['/axe.min.js'] = ['../node_modules/axe-core/axe.min.js', 'text/javascript; charset=utf-8'];
}
const backend = createApi({ file: process.env.DATABASE_FILE || process.env.DATA_FILE || fileURLToPath(new URL('../data/demo.json', import.meta.url)) });
const frontend = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path.startsWith('/api/')) {
    const proxy = request({ host, port: backend.address().port, path: req.url, method: req.method, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Continuum API is unavailable.' }));
    });
    proxy.setTimeout(60000, () => proxy.destroy(new Error('Upstream timeout')));
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
    req.pipe(proxy);
    return;
  }
  const route = routes[path] || ['404.html', 'text/html; charset=utf-8'];
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
  }
  try {
    let body = await readFile(new URL('../web/' + route[0], import.meta.url));
    if (auditEnabled && route[0] === 'index.html') body = Buffer.from(body.toString().replace('</head>', '<script type="module" src="/audit.js"></script></head>'));
    res.writeHead(routes[path] ? 200 : 404, {
      'Content-Type': route[1],
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-cache',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500); res.end('Could not load Continuum.');
  }
});
const fatal = (error) => {
  console.error(error.message);
  process.exit(1);
};
frontend.on('error', fatal);
backend.on('error', (error) => {
  if (!process.env.API_PORT && error.code === 'EADDRINUSE' && error.port === requestedApiPort) {
    backend.listen(0, host);
    return;
  }
  fatal(error);
});
backend.once('listening', () => {
  frontend.listen(frontendPort, host, () => console.log('Continuum: http://localhost:' + frontend.address().port + ' | API: http://localhost:' + backend.address().port));
});
backend.listen(requestedApiPort, host);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  frontend.close(); backend.close();
  setTimeout(() => process.exit(0), 1500).unref();
});
frontend.requestTimeout = 60000;
backend.requestTimeout = 60000;
