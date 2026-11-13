// Owner console in a real browser: source setup, validation failures, editing with masked credentials, a large import that pauses and resumes,
// and the permission boundary for customers. Run with: npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { launchBrowser, startApp, signUp, asUser } from './support.mjs';

const CSV = 'id,title,symptoms,steps\nK-1,Router drops wifi,Router drops the wifi connection every few minutes,Update the router firmware then restart the router.\nK-2,Printer jams,Printer jams paper on every page,Open the tray and clear the paper path then reprint.\n';
let app, browser, owner, customer, dbDir, restServer, restOrigin;

before(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'continuum-e2e-src-'));
  const db = new Database(join(dbDir, 'kb.sqlite'));
  db.exec('CREATE TABLE solutions(id TEXT PRIMARY KEY, title TEXT, symptoms TEXT, steps TEXT)');
  const insert = db.prepare('INSERT INTO solutions VALUES(?,?,?,?)');
  db.transaction(() => { for (let i = 1; i <= 250; i++) insert.run('S-' + String(i).padStart(4, '0'), `Fix ${i} for device ${i}`, `Symptom ${i} appears after update ${i}`, `Open settings page ${i} then restart the device and check again.`); })();
  db.close();
  restServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [] })); });
  await new Promise((r) => restServer.listen(0, '127.0.0.1', r));
  restOrigin = `http://127.0.0.1:${restServer.address().port}`;
  app = await startApp({ DATA_SOURCE_SQLITE_DIRS: dbDir, DATA_SOURCE_ALLOWED_ORIGINS: restOrigin, DATA_SOURCE_BATCH_SIZE: '50', DATA_SOURCE_MAX_RECORDS: '100' });
  browser = await launchBrowser();
  owner = await signUp(app, { createCompany: true, companyName: 'E2E Company', name: 'Olive Owner', email: 'olive@example.test' });
  const code = (await owner.call('company/customer-code', { confirmed: true })).data.code;
  customer = await signUp(app, { companyCode: code, name: 'Casey Customer', email: 'casey@example.test' });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (restServer ? restServer.close(r) : r()));
  await app?.stop();
  await rm(dbDir, { recursive: true, force: true }).catch(() => {});
});

const openKnowledge = async (user = owner) => {
  const { page, context } = await asUser(browser, app, user);
  await page.goto(app.base + '/team#knowledge');
  await page.waitForSelector('#data-sources');
  return { page, context };
};
const nextStep = (page) => page.click('.wiz-nav button:has-text("Next")');
const stepTitle = (page) => page.locator('.wiz-step:not([hidden]) .wiz-title').innerText();

test('a source can be set up in the browser; incomplete or wrong mappings are refused or reported, never swallowed', async () => {
  const { page, context } = await openKnowledge();
  await page.click('[data-add-source]');
  await page.fill('#source-form [name=name]', 'Wifi knowledge');
  await nextStep(page);
  await page.click('summary:has-text("Or paste the CSV")');
  await page.fill('#source-form [name=csv]', CSV);
  await nextStep(page);
  assert.equal(await stepTitle(page), 'Match your columns');
  await nextStep(page); // required mapping fields are empty: the form refuses to move on
  assert.equal(await stepTitle(page), 'Match your columns', 'validation failure keeps the owner on the mapping step');
  for (const [k, v] of [['externalId', 'id'], ['title', 'title'], ['symptoms', 'symptoms'], ['steps', 'no_such_column']]) await page.fill(`#source-form [name=map_${k}]`, v);
  await nextStep(page);
  await page.click('.wiz-nav button:has-text("Save data source")');
  await page.waitForSelector('article[data-source]');
  assert.match(await page.locator('article[data-source] h3').innerText(), /Wifi knowledge/);
  assert.equal(await page.locator('article[data-source] [data-freshness]').getAttribute('data-freshness'), 'never');
  await page.click('[data-sync-source]');
  await page.waitForFunction(() => /Columns not found in the CSV: no_such_column/.test(document.querySelector('[data-source-result]').textContent));
  const list = await owner.call('company/data-sources');
  assert.equal(list.data.sources[0].status, 'error', 'the failure is recorded on the source, not shown as success');
  assert.equal(list.data.sources[0].freshness.state, 'error');
  await context.close();
});

test('editing fixes the mapping without resending the data, then the sync completes and the card says so', async () => {
  const { page, context } = await openKnowledge();
  await page.click('[data-edit-source]');
  assert.match(await page.locator('#source-title').innerText(), /Edit “Wifi knowledge”/);
  assert.equal(await page.locator('#source-form [name=sourceType]').isDisabled(), true, 'the type of a saved source cannot change');
  await nextStep(page);
  await nextStep(page);
  assert.equal(await page.inputValue('#source-form [name=map_steps]'), 'no_such_column');
  await page.fill('#source-form [name=map_steps]', 'steps');
  await nextStep(page);
  await page.click('.wiz-nav button:has-text("Save data source")');
  await page.waitForSelector('article[data-source]');
  await page.click('[data-sync-source]');
  await page.waitForFunction(() => /Sync finished \(full\)/.test(document.querySelector('[data-source-result]').textContent));
  const view = (await owner.call('company/data-sources')).data.sources[0];
  assert.equal(view.freshness.state, 'fresh');
  assert.equal(view.lastSyncResult.inserted, 2);
  assert.equal(view.recentRuns[0].status, 'completed');
  await page.reload();
  await page.waitForSelector('[data-freshness="fresh"]');
  await context.close();
});

test('a large import pauses at its per-run limit, shows saved progress, and resumes until every record has arrived', async () => {
  const created = await owner.call('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: owner.profile.chatbotId, name: 'Big database', declaredVerified: true, fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} }, connection: { path: join(dbDir, 'kb.sqlite'), table: 'solutions' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.source.id;
  const { page, context } = await openKnowledge();
  const card = page.locator(`article[data-source="${id}"]`);
  await card.locator('[data-sync-source]').click();
  await page.waitForFunction((sid) => /Paused part-way\. Nothing was dropped/.test(document.querySelector(`article[data-source="${sid}"] [data-source-result]`).textContent), id);
  await page.reload();
  await page.waitForSelector(`article[data-source="${id}"]`);
  assert.match(await card.innerText(), /progress saved: 100 records read/);
  assert.match(await card.locator('[data-sync-source]').innerText(), /Resume sync/);
  assert.ok(await card.locator('[data-cancel-source]').count(), 'a paused import can be cancelled');
  for (let i = 0; i < 4; i++) {
    await page.locator(`article[data-source="${id}"] [data-sync-source]`).click();
    await page.waitForFunction((sid) => /Sync finished|Paused part-way/.test(document.querySelector(`article[data-source="${sid}"] [data-source-result]`).textContent), id);
    if (/Sync finished/.test(await page.locator(`article[data-source="${id}"] [data-source-result]`).innerText())) break;
    await page.reload();
    await page.waitForSelector(`article[data-source="${id}"]`);
  }
  const done = (await owner.call('company/data-sources')).data.sources.find((s) => s.id === id);
  assert.equal(done.status, 'ok');
  assert.equal(done.recentRuns.length, 3, 'three bounded runs');
  assert.equal(done.recentRuns.filter((r) => r.resumed).length, 2);
  const reader = new Database(join(app.dir, 'e2e.sqlite'), { readonly: true });
  const counted = reader.prepare('SELECT COUNT(DISTINCT external_record_id) n FROM memory_pool WHERE source_id=?').get(id).n;
  reader.close();
  assert.equal(counted, 250, 'every one of the 250 records is accounted for exactly once');
  await context.close();
});

test('stored credentials are never shown: the edit form says one is stored and a blank field keeps it', async () => {
  const token = 'dummy-token-e2e-98765';
  const made = await owner.call('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: owner.profile.chatbotId, name: 'Help desk API', fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} }, connection: { url: restOrigin + '/kb', token, recordsPath: 'data' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const { page, context } = await openKnowledge();
  const card = page.locator(`article[data-source="${made.data.source.id}"]`);
  assert.match(await card.innerText(), /credentials stored and hidden/);
  await card.locator('[data-edit-source]').click();
  await nextStep(page);
  assert.equal(await page.inputValue('#source-form [name=c_rest_api_token]'), '', 'the token field is empty');
  assert.equal(await page.getAttribute('#source-form [name=c_rest_api_token]', 'placeholder'), 'Stored. Leave blank to keep it.');
  assert.equal(await page.inputValue('#source-form [name=c_rest_api_url]'), '', 'even the URL field is blank: it may carry a secret');
  assert.equal(await page.inputValue('#source-form [name=c_rest_api_recordsPath]'), 'data', 'non-secret settings are shown');
  assert.ok(!(await page.content()).includes(token), 'the token appears nowhere in the page');
  assert.ok(!JSON.stringify((await owner.call('company/data-sources')).data).includes(token));
  await context.close();
});

test('permission boundary: a customer cannot see or use the owner console or its APIs', async () => {
  const own = await asUser(browser, app, customer);
  await own.page.goto(app.base + '/team#knowledge');
  await own.page.waitForSelector('#app');
  await own.page.waitForTimeout(800);
  assert.equal(await own.page.locator('[data-add-source]').count(), 0, 'no owner controls are rendered for a customer');
  for (const [route, body] of [['company/data-sources', undefined], ['company/data-sources', { confirmed: true }], ['company/knowledge-lifecycle/overview', undefined], ['company/shadow', undefined]]) {
    const r = await customer.call(route, body);
    assert.ok([403, 404].includes(r.status), `${route} -> ${r.status}`);
  }
  await own.context.close();
});
