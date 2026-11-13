import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { world } from './_helpers.js';
import { draftArticle, splitArticles, htmlToText, pdfToText, parseTickets, draftTicket, mergeTicketDrafts, groundedStep, createModelDrafter, fileText } from '../server/knowledge-import.js';

const ARTICLE = `# Printer shows error E5 after a paper jam

## Symptoms
The printer stops and shows error E5 even after the jammed paper is removed.

## Applies to
LaserJet M400 series

## Warning
Do not open the fuser cover while the printer is hot.

## Resolution
1. Turn the printer off and unplug it for 30 seconds.
2. Open the rear access door and remove any torn paper.
3. Plug the printer in and turn it on.
`;

test('article drafting: sections become title, symptoms, steps, applicability and safety, all from the text', () => {
  const d = draftArticle(ARTICLE, { name: 'e5.md' });
  assert.equal(d.title, 'Printer shows error E5 after a paper jam');
  assert.match(d.symptoms, /error E5 even after/);
  assert.equal(d.steps.length, 3);
  assert.equal(d.steps[0], 'Turn the printer off and unplug it for 30 seconds.');
  assert.equal(d.appliesTo, 'LaserJet M400 series');
  assert.match(d.safety, /fuser cover/);
  assert.deepEqual(d.issues, []);
  assert.equal(d.method, 'rules');
});

test('article drafting: plain prose with no headings still yields steps, and missing parts are reported', () => {
  const d = draftArticle('Wi-Fi drops every few minutes\n\nThe laptop loses its wireless connection every few minutes while on battery.\n\nOpen Power settings and turn off "Allow the computer to turn off this device to save power" for the wireless adapter. Restart the laptop.');
  assert.equal(d.title, 'Wi-Fi drops every few minutes');
  assert.match(d.symptoms, /loses its wireless connection/);
  assert.ok(d.steps.length >= 1);
  const empty = draftArticle('Just a title');
  assert.ok(empty.issues.includes('no steps found'));
});

test('one file can hold several articles', () => {
  assert.equal(splitArticles('# A\ntext a\n# B\ntext b').length, 2);
  assert.equal(splitArticles('first\n---\nsecond\n---\nthird').length, 3);
  assert.equal(splitArticles('# Only one\n## Steps\n1. x').length, 1);
});

test('HTML help pages become text with headings and list items kept', () => {
  const t = htmlToText('<html><head><style>x{}</style></head><body><h1>Reset &amp; retry</h1><p>Screen stays black.</p><h2>Steps</h2><ol><li>Hold power 10&nbsp;s</li><li>Release</li></ol><script>alert(1)</script></body></html>');
  assert.match(t, /^# Reset & retry/);
  assert.match(t, /- Hold power 10 s/);
  assert.ok(!t.includes('alert'));
  const d = draftArticle(t);
  assert.deepEqual(d.steps, ['Hold power 10 s', 'Release']);
  assert.equal(fileText({ name: 'page.html', text: '<p>Hello there friend</p>' }).text, 'Hello there friend');
});

function pdf(content) {
  const stream = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /Font << /F1 2 0 R >> >> >>\nendobj\n3 0 obj\n<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n'),
    stream,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'),
  ]);
}

test('PDF text is read from compressed content streams, and unreadable PDFs are refused instead of returning garbage', () => {
  const text = pdfToText(pdf('BT /F1 12 Tf 72 720 Td (Router keeps rebooting) Tj 0 -14 Td (Steps:) Tj 0 -14 Td (1. Update the firmware to 2.4.1.) Tj T* [(2. Replace the ) -250 (power adapter.)] TJ ET'));
  assert.match(text, /Router keeps rebooting/);
  assert.match(text, /1\. Update the firmware to 2\.4\.1\./);
  assert.match(text, /2\. Replace the power adapter\./);
  const d = draftArticle(text);
  assert.deepEqual(d.steps, ['Update the firmware to 2.4.1.', 'Replace the power adapter.']);
  assert.throws(() => pdfToText(pdf('BT <0001000200030004> Tj ET')), (e) => e.status === 422);
  assert.throws(() => pdfToText(Buffer.from('not a pdf')), (e) => e.status === 400);
  const viaFile = fileText({ name: 'kb.pdf', base64: pdf('BT (Battery drains overnight while asleep) Tj ET').toString('base64') });
  assert.match(viaFile.text, /Battery drains overnight/);
});

const TICKETS = `Ticket ID,Subject,Description,Resolution,Status,Product
T-1,Laptop will not charge,"My laptop stopped charging, the light is off",Reset the battery controller: hold the power button for 30 seconds with the charger unplugged. Then reconnect the charger.,Solved,Model X
T-2,No charging,"Charger plugged in but battery stays at 0%",Reset the battery controller: hold the power button for 30 seconds with the charger unplugged. Then reconnect the charger.,Closed,Model X
T-3,Screen flicker,"Flickering display after update",fixed,Solved,Model X
T-4,Keyboard dead,"Keys do not respond",Waiting on the customer to reply with photos,Open,Model X
T-5,Fan noise,"Fan is very loud",Cleaned the vents with compressed air and set the power profile to Balanced.,Resolved,Model Y
`;

test('past tickets: real export headers are recognised, unsolved and useless resolutions are skipped, repeated fixes merge', () => {
  const { tickets, skipped, columns } = parseTickets(TICKETS);
  assert.equal(columns.ref, 'ticket_id');
  assert.equal(columns.resolution, 'resolution');
  assert.deepEqual(tickets.map((t) => t.ref), ['T-1', 'T-2', 'T-5']);
  assert.deepEqual(skipped.map((s) => s.ref), ['T-3', 'T-4']);
  const merged = mergeTicketDrafts(tickets.map(draftTicket));
  assert.equal(merged.length, 2);
  const charging = merged.find((d) => /charg/i.test(d.title));
  assert.equal(charging.seenInTickets, 2, 'two tickets were closed by the same fix');
  assert.match(charging.symptoms, /0%/, 'both customers’ wordings are kept for retrieval');
  assert.equal(charging.appliesTo, 'Model X');
  assert.ok(charging.steps.length >= 2);
  assert.throws(() => parseTickets('id,text\n1,hello'), /resolution column/);
  const json = parseTickets(JSON.stringify({ tickets: [{ id: 9, subject: 'VPN fails', description: 'VPN fails at login', resolution: 'Renew the VPN certificate from the company portal page.' }] }), 'json');
  assert.equal(json.tickets.length, 1);
});

test('grounding: a model step with an invented link, version or mostly new wording is rejected', () => {
  const src = 'Hold the power button for 30 seconds, then update the firmware to 2.4.1 from the Settings menu.';
  assert.equal(groundedStep('Hold the power button for 30 seconds.', src), true);
  assert.equal(groundedStep('Update the firmware to 2.4.1 from Settings.', src), true);
  assert.equal(groundedStep('Update the firmware to 3.0.', src), false, 'invented version');
  assert.equal(groundedStep('Download the tool from https://example.com/fix.', src), false, 'invented link');
  assert.equal(groundedStep('Reinstall the operating system and restore a backup.', src), false, 'invented procedure');
});

function fakeModel(reply, seen) {
  return async (url, options) => {
    seen.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
}

test('model drafting: personal data is removed before sending, credentials are never sent, ungrounded steps are dropped', async () => {
  const seen = [];
  const drafter = createModelDrafter({ OPENAI_API_KEY: 'test-key', KNOWLEDGE_DRAFTING: 'model' }, { fetchImpl: fakeModel({ title: 'Charging', symptoms: 'Does not charge', steps: ['Hold the power button for 30 seconds.', 'Visit https://evil.example/tool to download a fixer.'] }, seen) });
  const out = await drafter.draft('Customer jane.doe@example.com says it does not charge. Hold the power button for 30 seconds.', 'ticket');
  assert.ok(!JSON.stringify(seen[0]).includes('jane.doe@example.com'));
  assert.deepEqual(out.steps, ['Hold the power button for 30 seconds.']);
  assert.equal(out.dropped, 1);
  assert.equal(await drafter.draft('password=hunter2hunter2 api_key=sk-abcdefghijklmnopqrstuvwxyz123456', 'ticket'), null);
  assert.equal(seen.length, 1, 'credential-bearing text was not sent');
  assert.equal(createModelDrafter({}), null, 'rules only without a model');
  assert.equal(createModelDrafter({ OPENAI_API_KEY: 'k', KNOWLEDGE_DRAFTING: 'rules' }), null, 'operator can force rules');
});

test('end to end: drafts are previewed without saving, saved as waiting for approval, never recommended before approval, and idempotent', async (t) => {
  const w = await world(t);
  const bot = w.botOf(w.company);
  const count = () => w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE company_id=? AND origin_type='company_db_sync'").get(w.company).n;
  const cust = await w.customer('kia');
  assert.equal((await cust.api('company/knowledge-import/draft', { chatbotId: bot, kind: 'tickets', files: [{ name: 't.csv', text: TICKETS }] })).status, 403);
  assert.equal((await w.other.api('company/knowledge-import/draft', { chatbotId: bot, kind: 'tickets', files: [{ name: 't.csv', text: TICKETS }] })).status, 404, 'another company’s service');

  const preview = await w.owner.api('company/knowledge-import/draft', { chatbotId: bot, kind: 'tickets', files: [{ name: 'tickets.csv', text: TICKETS }] });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.drafts.length, 2);
  assert.equal(preview.data.skippedCount, 2);
  assert.equal(preview.data.drafting.method, 'rules');
  assert.equal(count(), 0, 'a preview saves nothing');

  assert.equal((await w.owner.api('company/knowledge-import/save', { chatbotId: bot, drafts: preview.data.drafts })).status, 400, 'needs confirmation');
  const saved = await w.owner.api('company/knowledge-import/save', { chatbotId: bot, confirmed: true, drafts: preview.data.drafts });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.saved, 2);
  const rows = w.db().prepare("SELECT * FROM memory_pool WHERE company_id=? AND origin_type='company_db_sync'").all(w.company);
  assert.ok(rows.every((r) => r.status === 'flagged_for_review' && !r.customer_confirmed));
  const charging = rows.find((r) => /charg/i.test(r.title));
  assert.match(JSON.parse(charging.verification_evidence_json).label, /2 past tickets/);

  const before = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text: 'My Model X laptop is not charging and the battery stays at 0%' });
  assert.ok(!before.eligible.some((e) => e.id === charging.id), 'not recommended before approval');

  const again = await w.owner.api('company/knowledge-import/save', { chatbotId: bot, confirmed: true, drafts: preview.data.drafts });
  assert.equal(again.data.saved, 0);
  assert.equal(again.data.alreadyImported, 2);
  const repeat = await w.owner.api('company/knowledge-import/draft', { chatbotId: bot, kind: 'tickets', files: [{ name: 'tickets.csv', text: TICKETS }] });
  assert.ok(repeat.data.drafts.every((d) => d.alreadyImported && !d.ready));

  const ok = await w.owner.api('operator/review-resolution', { id: charging.id, decision: 'keep', note: 'Checked against our runbook.', confirmed: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text: 'My Model X laptop is not charging and the battery stays at 0%', factsText: 'Model X' });
  assert.ok(after.eligible.some((e) => e.id === charging.id) || after.withheld.some((e) => e.id === charging.id), 'retrievable once approved');
});

test('save: personal data is scrubbed and secrets or incomplete drafts are refused', async (t) => {
  const w = await world(t);
  const bot = w.botOf(w.company);
  const r = await w.owner.api('company/knowledge-import/save', { chatbotId: bot, confirmed: true, drafts: [
    { title: 'Mail sync stops', symptoms: 'Mail stops syncing for bob.smith@example.com on +1 415 555 0100', steps: ['Remove and re-add the mail account.'] },
    { title: 'Bad', symptoms: 'x y z', steps: ['Use token sk-abcdefghijklmnopqrstuvwxyz1234567890 to log in.'] },
    { title: 'No steps', symptoms: 'Something broke', steps: [] },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.saved, 1);
  assert.equal(r.data.rejected.length, 2);
  const row = w.db().prepare("SELECT symptoms_text FROM memory_pool WHERE company_id=? AND title='Mail sync stops'").get(w.company);
  assert.ok(!row.symptoms_text.includes('bob.smith@example.com'));
  assert.ok(!row.symptoms_text.includes('555 0100'));
});

test('a large ticket export fits in one request (the general 16 KB body limit does not apply here)', async (t) => {
  const w = await world(t);
  const lines = ['id,subject,description,resolution'];
  for (let i = 0; i < 600; i++) lines.push(`${i},Problem ${i},Device ${i} shows code ${i} on boot,Clear the cache for device ${i} and restart it twice to apply.`);
  const big = lines.join('\n');
  assert.ok(big.length > 50000);
  const r = await w.owner.api('company/knowledge-import/draft', { chatbotId: w.botOf(w.company), kind: 'tickets', files: [{ name: 'big.csv', text: big }] });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.equal(r.data.drafts.length, 500, 'capped at 500 drafts per request');
});
