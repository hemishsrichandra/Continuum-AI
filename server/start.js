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
  '/desk': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
};
const backend = createApi({ file: process.env.DATA_FILE || fileURLToPath(new URL('../data/demo.json', import.meta.url)) });
const frontend = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    const proxy = request({ host, port: backend.address().port, path: req.url, method: req.method, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Continuum API is unavailable.' }));
    });
    req.pipe(proxy);
    return;
  }
  const route = routes[path];
  if (!route || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404); res.end('Page not found'); return;
  }
  try {
    const body = await readFile(new URL('../web/' + route[0], import.meta.url));
    res.writeHead(200, {
      'Content-Type': route[1],
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
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
