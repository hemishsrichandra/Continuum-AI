import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world } from './_helpers.js';
import { parseCsv } from '../server/data-sources.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} };

test('CSV headers from real exports are accepted; plain identifiers are kept exactly so saved mappings still work', () => {
  const rows = parseCsv('Ticket ID,Subject Line,steps,2nd note\n1,a,b,c');
  assert.deepEqual(Object.keys(rows[0]), ['Ticket_ID', 'Subject_Line', 'steps', 'c_2nd_note']);
  assert.throws(() => parseCsv('a b,a-b\n1,2'), /unique/);
});

test('an uploaded CSV larger than the old 16 KB request limit saves and syncs; the configured size limit is enforced', async (t) => {
  const w = await world(t, { config: { DATA_SOURCE_CSV_MAX_BYTES: String(200 * 1024) } });
  const lines = ['Record ID,Title,Symptoms,Steps'];
  for (let i = 0; i < 400; i++) lines.push(`k${i},Fix ${i},"Gadget ${i} shows error E${i} on start",Open the gadget ${i} menu and choose reset ${i} then restart it.`);
  const csv = lines.join('\n');
  assert.ok(csv.length > 30000);
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'Export', fieldMapping: { fields: { externalId: 'Record_ID', title: 'Title', symptoms: 'Symptoms', steps: 'Steps' }, diagnostics: {} }, connection: { csv } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sync = await w.owner.api(`company/data-sources/${created.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.result.inserted, 400);
  const tooBig = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'Huge', fieldMapping: MAPPING, connection: { csv: 'id,title,symptoms,steps\n' + 'x'.repeat(300 * 1024) } });
  assert.equal(tooBig.status, 413);
  assert.equal((await w.owner.api('company/data-sources')).data.csvMaxBytes, 200 * 1024);
});

async function kbServer() {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'a1', title: 'Fan noise', symptoms: 'The fan is very loud at idle', steps: 'Clean the vents and set the power profile to Balanced.' }]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

test('an owner can approve a website in the app and connect a REST source without operator variables; it stays company-scoped', async (t) => {
  const { server, origin } = await kbServer();
  t.after(() => new Promise((r) => server.close(r)));
  const w = await world(t, { config: { DATA_SOURCE_ALLOW_LOOPBACK: 'true' } });
  const save = (c) => c.api('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: w.botOf(c === w.owner ? w.company : w.companyB), name: 'KB', fieldMapping: MAPPING, connection: { url: origin + '/kb' }, declaredVerified: true });
  const listed = await w.owner.api('company/data-sources');
  assert.equal(listed.data.availability.rest_api.available, true);
  assert.equal(listed.data.allowedWebsites.ownerManaged, true);

  const before = await save(w.owner);
  assert.equal(before.status, 400);
  assert.match(before.data.error, /Allowed websites/);

  const cust = await w.customer('pat');
  assert.equal((await cust.api('company/data-sources/origins', { confirmed: true, origin })).status, 403);
  assert.equal((await w.owner.api('company/data-sources/origins', { origin })).status, 400, 'needs confirmation');
  assert.equal((await w.owner.api('company/data-sources/origins', { confirmed: true, origin: origin + '/kb' })).status, 400, 'origin only, no path');
  const approved = await w.owner.api('company/data-sources/origins', { confirmed: true, origin });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(approved.data.company.map((o) => o.origin), [origin]);

  const created = await save(w.owner);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sync = await w.owner.api(`company/data-sources/${created.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.result.inserted, 1);

  assert.equal((await save(w.other)).status, 400, 'another company’s approval does not carry over');

  await w.owner.api('company/data-sources/origins/remove', { confirmed: true, origin });
  assert.ok((await w.owner.api(`company/data-sources/${created.data.source.id}/sync`, { confirmed: true })).status >= 400, 'removing the website stops the source');
});

test('approving a website never allows private addresses, and the operator can turn owner approval off', async (t) => {
  const w = await world(t);
  for (const origin of ['https://10.0.0.5', 'https://192.168.1.10', 'https://169.254.169.254', 'http://example.com', 'https://localhost'])
    assert.equal((await w.owner.api('company/data-sources/origins', { confirmed: true, origin })).status >= 400, true, origin);
  const off = await world(t, { config: { DATA_SOURCE_OWNER_ORIGINS: 'false' } });
  assert.equal((await off.owner.api('company/data-sources/origins', { confirmed: true, origin: 'https://example.com' })).status, 403);
  const listed = await off.owner.api('company/data-sources');
  assert.equal(listed.data.availability.rest_api.available, false);
});
