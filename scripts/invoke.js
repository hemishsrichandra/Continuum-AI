import { Readable } from 'node:stream';

// Exercise the same request handler without opening a listening socket.
export async function invoke(handler, route, { token, body, method } = {}) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method: method || (body ? 'POST' : 'GET'),
    url: '/api/' + route,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...(token && { authorization: 'Bearer ' + token }), ...(body && { 'content-type': 'application/json' }) },
  });
  let status;
  let data;
  const res = {
    get headersSent() { return status !== undefined; },
    writeHead(code) { status = code; },
    end(payload) { data = JSON.parse(payload); },
  };
  await handler(req, res);
  return { status, data };
}
