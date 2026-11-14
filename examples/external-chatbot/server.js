// Separate fictional company's backend adapter. No .env files are loaded or modified.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { json } from '../../server/requests.js';

export function createExampleServer({ apiUrl = process.env.CONTINUUM_API_URL || 'http://127.0.0.1:3000', key = process.env.CONTINUUM_INTEGRATION_KEY, fetchImpl = fetch } = {}) {
  if (!key || !/^ctm_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Set CONTINUUM_INTEGRATION_KEY in the company backend environment.');
  const origin = new URL(apiUrl);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('CONTINUUM_API_URL must be an HTTPS origin (HTTP allowed for loopback development).');
  const buckets = new Map();
  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(body)); };
    try {
      if (req.url === '/chat' && req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, {error:'Use this company chatbot page.'});
        const now = Date.now();
        for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
        const id = req.socket.remoteAddress;
        const bucket = buckets.get(id) || {used:0, until: now + 60000}; buckets.set(id, bucket);
        if (++bucket.used > 30) return send(429, {error:'Too many requests. Wait one minute.'});
        const body = await json(req, 8192);
        if (Object.keys(body).some(k => !['question','conversationId','environment'].includes(k))) return send(400,{error:'Unexpected request field.'});
        const upstream = await fetchImpl(new URL('/api/v1/external/suggestions', origin), {
          method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
          headers:{'Content-Type':'application/json', Authorization:'Bearer ' + key}, body:JSON.stringify(body),
        });
        if (!upstream.ok) return send(upstream.status >= 500 ? 502 : upstream.status, {error: upstream.status === 401 ? 'Company integration credential is invalid or revoked. Ask the company administrator.' : upstream.status === 429 ? 'Continuum rate limit reached. Wait one minute.' : 'Continuum could not accept this question. Check the question and environment fields.'});
        const data = await upstream.json();
        // Forward only the documented preview schema, never upstream headers, diagnostics or configuration.
        const result = {conversationRef:data.conversationRef,status:data.status,preview:data.preview,suggestions:data.suggestions,clarification:data.clarification,...(data.message && {message:data.message})};
        // Defense in depth against an upstream accidentally echoing the credential.
        if (JSON.stringify(result).includes(key)) return send(502,{error:'Invalid response from Continuum.'});
        return send(200,result);
      }
      const files = {'/':'index.html','/chat.js':'chat.js'};
      if (req.method !== 'GET' || !files[req.url]) return send(404,{error:'Not found.'});
      const body = await readFile(new URL(files[req.url], import.meta.url));
      res.writeHead(200,{'Content-Type':req.url === '/' ? 'text/html; charset=utf-8':'text/javascript; charset=utf-8',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
      res.end(body);
    } catch (error) { send(error.status || 502,{error:error.status ? error.message : 'Company backend could not reach Continuum.'}); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createExampleServer();
  server.requestTimeout = 20000;
  server.listen(Number(process.env.CHATBOT_PORT || 3400),'127.0.0.1',() => console.log('Synthetic company chatbot: http://127.0.0.1:' + server.address().port));
}
