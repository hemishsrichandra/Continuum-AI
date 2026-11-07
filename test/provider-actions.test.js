import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';

async function setup(t, { wrongReceipt = false } = {}) {
  const receipts = new Map(),
    effects = [];
  let dropOnce = !wrongReceipt;
  const gateway = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer provider-test-secret') {
      res.writeHead(401);
      res.end();
      return;
    }
    const send = (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (req.url === '/capabilities')
      return send({
        version: 1,
        idempotency: true,
        actions: ['request', 'requirement', 'handoff', 'outcome', 'progress'],
      });
    if (req.method === 'GET')
      return send(
        effects
          .filter((e) => e.kind === 'request')
          .map((e) => ({
            id: e.ticketId,
            customerId: 'customer-1',
            title: e.details.title,
            issue: e.details.issueDesc,
            status: 'Received',
            eta: null,
          })),
      );
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw),
      key = req.headers['idempotency-key'];
    if (receipts.has(key)) return send(receipts.get(key));
    assert.equal(req.url, '/customers/customer-1/actions');
    assert.equal(body.customerId, 'customer-1');
    assert.ok(key);
    const ticketId = body.kind === 'request' ? 'provider-ticket-1' : body.ticketId;
    effects.push({ ...body, ticketId });
    const receipt = {
      id: 'receipt-' + effects.length,
      status: 'confirmed',
      actionId: body.actionId,
      kind: body.kind,
      customerId: wrongReceipt ? 'another-customer' : 'customer-1',
      ticketId,
    };
    receipts.set(key, receipt);
    if (dropOnce) {
      dropOnce = false;
      req.socket.destroy();
      return;
    }
    send(receipt);
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + gateway.address().port,
    dir = await mkdtemp(join(tmpdir(), 'continuum-provider-')),
    file = join(dir, 'app.sqlite');
  const config = { PROVIDER_ALLOWED_ORIGINS: base, ENABLE_OUTBOX_WORKER: 'false' };
  let h = createHandler({ file, config });
  t.after(async () => {
    h.close();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  function client() {
    let cookie = '',
      csrf = '';
    return {
      async api(route, body, extra = {}) {
        const r = await invoke(h, route, {
          body,
          ...extra,
          headers: { cookie, 'x-csrf-token': csrf, ...extra.headers },
        });
        if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
        if (r.data.csrfToken) csrf = r.data.csrfToken;
        return r;
      },
    };
  }
  const owner = client(),
    customer = client(),
    password = 'provider integration passphrase 2026';
  await owner.api('auth/register', {
    createCompany: true,
    companyName: 'Provider fixture',
    name: 'Owner',
    email: 'owner@example.test',
    password,
    provider: 'repair',
  });
  const companyCode = (await owner.api('company/customer-code', { confirmed: true })).data.code;
  const registered = await customer.api('auth/register', {
    companyCode,
    name: 'Customer',
    email: 'customer@example.test',
    password,
    provider: 'repair',
  });
  assert.equal(
    (
      await owner.api('company/connector', {
        baseUrl: base,
        apiToken: 'provider-test-secret',
        writesEnabled: true,
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.api('company/connector/customer', {
        accountId: registered.data.profile.id,
        externalId: 'customer-1',
      })
    ).status,
    200,
  );
  return {
    owner,
    customer,
    effects,
    handler: () => h,
    restart() {
      h.close();
      h = createHandler({ file, config });
      return h;
    },
  };
}

test('provider writes survive lost acknowledgements and restart, preserve ordering, and avoid duplicate remote actions', async (t) => {
  const f = await setup(t);
  const body = { title: 'Laptop', issueDesc: 'Broken keyboard', confirmed: true },
    options = { headers: { 'idempotency-key': 'create-provider-request' } };
  const request = await f.customer.api('request', body, options);
  assert.equal(request.status, 201);
  assert.equal(request.data.providerDelivery.status, 'pending');
  assert.equal((await f.customer.api('request', body, options)).data.ticketId, request.data.ticketId);
  await f.customer.api('requirement', {
    ticketId: request.data.ticketId,
    note: 'Please call before parts are ordered.',
    confirmed: true,
  });
  await f.handler().providerActions.flush();
  assert.equal(f.effects.length, 1);
  assert.equal(
    f.handler().store.db.prepare("SELECT status FROM provider_jobs WHERE kind='request'").get().status,
    'pending',
  );
  const restarted = f.restart();
  restarted.store.db.prepare("UPDATE provider_jobs SET next_attempt=0 WHERE status='pending'").run();
  await restarted.providerActions.flush();
  assert.equal(f.effects.length, 2);
  assert.deepEqual(
    f.effects.map((e) => e.kind),
    ['request', 'requirement'],
  );
  assert.equal(f.effects[1].ticketId, 'provider-ticket-1');
  const workspace = (await f.customer.api('workspace')).data;
  assert.ok(workspace.providerDeliveries.every((j) => j.status === 'confirmed'));
  const handoff = await f.customer.api('handoff', {
    ticketId: request.data.ticketId,
    summary: 'Need specialist help.',
    confirmed: true,
  });
  assert.equal(handoff.data.providerDelivery.status, 'pending');
  await restarted.providerActions.flush();
  assert.equal(f.effects.at(-1).kind, 'handoff');
  await f.customer.api('outcome', {
    ticketId: request.data.ticketId,
    outcome: 'resolved',
    note: 'The keyboard works now.',
    confirmed: true,
  });
  await restarted.providerActions.flush();
  assert.equal(f.effects.at(-1).kind, 'outcome');
  assert.equal((await f.customer.api('connector/sync', {})).data.imported, 1);
  assert.equal(
    (await f.customer.api('workspace')).data.tickets.length,
    1,
    'Import must preserve the locally created ticket rather than duplicate it',
  );
});

test('a provider receipt for another customer cannot mark a local action confirmed', async (t) => {
  const f = await setup(t, { wrongReceipt: true });
  await f.customer.api('request', { title: 'Printer', issueDesc: 'Paper jam', confirmed: true });
  await f.handler().providerActions.flush();
  const jobs = (await f.customer.api('workspace')).data.providerDeliveries;
  assert.equal(jobs[0].status, 'failed');
  assert.match(jobs[0].error, /exact action/);
  assert.ok(!JSON.stringify(jobs).includes('provider-test-secret'));
});
