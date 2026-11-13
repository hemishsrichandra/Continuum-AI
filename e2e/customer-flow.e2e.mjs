// Customer desk in a real browser: up to three suggestions are shown, nothing is "tried" until one is chosen, every outcome is recorded
// distinctly, and a person is brought in when the customer asks. Run with: npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { launchBrowser, startApp, signUp, asUser } from './support.mjs';

const ISSUE = 'The display flickers after startup on Model X firmware 4.';
const CSV = [
  'id,title,symptoms,steps',
  'F-1,Display flicker: adaptive refresh,Display flickers after startup,Disable adaptive refresh in Display settings and restart the laptop.',
  'F-2,Display flicker: driver update,Display flickers after startup and flashes,Install the approved display driver 4.2 from the vendor support site.',
  'F-3,Display flicker: power profile,Screen flickers after startup when on battery,Switch the power profile to Balanced in Power settings and test again.',
  'F-4,Display flicker: external monitor test,Display flicker on startup and flashing screen,Connect an external monitor to check whether the flicker also appears there.',
].join('\n') + '\n';
let app, browser, owner, code;
const db = () => new Database(join(app.dir, 'e2e.sqlite'), { readonly: true });
const query = (sql, ...args) => { const d = db(); try { return d.prepare(sql).all(...args); } finally { d.close(); } };

before(async () => {
  app = await startApp({});
  browser = await launchBrowser();
  owner = await signUp(app, { createCompany: true, companyName: 'E2E Support Co', name: 'Olive Owner', email: 'olive@example.test' });
  code = (await owner.call('company/customer-code', { confirmed: true })).data.code;
  const source = await owner.call('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: owner.profile.chatbotId, name: 'Verified fixes', declaredVerified: true, fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} }, connection: { csv: CSV } });
  assert.equal(source.status, 201, JSON.stringify(source.data));
  const sync = await owner.call(`company/data-sources/${source.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.data.result.inserted, 4);
});
after(async () => { await browser?.close(); await app?.stop(); });

/** One customer (sign-ups are rate limited per address), and a new open request for each scene, opened on their desk. */
let customer, scene = 0;
async function deskFor(label) {
  customer ??= await signUp(app, { companyCode: code, name: 'Casey Customer', email: 'casey@example.test' });
  const title = `Model X device ${label} ${++scene}`;
  const made = await customer.call('request', { title, issueDesc: ISSUE, confirmed: true });
  assert.equal(made.status, 201);
  const { page, context } = await asUser(browser, app, customer);
  await page.goto(app.base + '/desk');
  await page.waitForSelector('#message');
  await page.locator('.ticket-list, [role=list], body').first().locator(`text=${title}`).first().click();
  await page.waitForSelector('#message');
  return { user: customer, page, context, ticketId: made.data.ticketId };
}
const ask = async (page, text) => { await page.fill('#message', text); await page.click('#chat-form button[type=submit]'); };
const until = async (fn, what, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 150)); } };
const attempts = () => query("SELECT outcome,outcome_detail,memory_id FROM troubleshooting_attempts WHERE source='learned' ORDER BY created_at");
const failures = () => query('SELECT COALESCE(SUM(reuse_failure_count),0) n FROM memory_pool')[0].n;

test('up to three suggestions are shown with reasons; nothing is recorded as tried until the customer chooses one', async () => {
  const { page, context } = await deskFor('Alice');
  await ask(page, ISSUE);
  await page.waitForSelector('.alt-choice');
  assert.equal(await page.locator('.alt-choice').count(), 3, 'four fixes qualify, three are shown');
  const first = page.locator('.alt-choice').first();
  assert.match(await first.innerText(), /Matched your description|Imported|Not yet confirmed by a customer/);
  assert.match(await page.locator('.alt-choices').innerText(), /Nothing is counted as tried or failed until you choose/);
  assert.equal(await page.locator('[data-attempt]').count(), 0, 'no outcome buttons yet: nothing has been chosen');
  assert.equal(attempts().length, 0, 'displaying the suggestions created no attempt');
  assert.equal(failures(), 0);
  await context.close();
});

test('choosing one suggestion records exactly that one; "It worked" resolves the request and counts one success', async () => {
  const { page, context, user, ticketId } = await deskFor('Bella');
  await ask(page, ISSUE);
  await page.waitForSelector('.alt-choice');
  const title = await page.locator('.alt-choice b').nth(1).innerText();
  await page.locator('.alt-choice').nth(1).locator('[data-choose]').click();
  await page.waitForSelector('[data-attempt][data-worked="true"]');
  const rows = attempts().filter((a) => a.outcome === 'pending');
  assert.equal(rows.length, 1);
  assert.equal(query('SELECT title FROM memory_pool WHERE id=?', rows[0].memory_id)[0].title, title, 'the chosen suggestion, not the first one, is the attempt');
  await page.click('[data-attempt][data-worked="true"]');
  const done = await until(() => attempts().find((a) => a.memory_id === rows[0].memory_id && a.outcome === 'succeeded'), 'the success to be recorded');
  assert.equal(done.outcome, 'succeeded');
  assert.equal(query('SELECT reuse_success_count n FROM memory_pool WHERE id=?', rows[0].memory_id)[0].n, 1);
  const status = await user.call('status?ticketId=' + ticketId);
  assert.match(JSON.stringify(status.data), /Resolved/);
  await context.close();
});

test('"Doesn’t apply" and "I can’t try this" are recorded as their own outcomes and never count as a failed fix', async () => {
  const before = failures();
  for (const [name, outcome] of [['Cara', 'not_applicable'], ['Dev', 'unable_to_try']]) {
    const { page, context } = await deskFor(name);
    await ask(page, ISSUE);
    await page.waitForSelector('.alt-choice');
    await page.locator('.alt-choice').first().locator('[data-choose]').click();
    await page.waitForSelector('.more-outcomes');
    await page.click('.more-outcomes summary');
    await page.click(`[data-outcome="${outcome}"]`);
    await page.waitForFunction((o) => document.querySelector('.thread') && !document.querySelector(`[data-outcome="${o}"]`), outcome);
    const mine = attempts().filter((a) => a.outcome_detail === outcome);
    assert.equal(mine.length, 1, outcome + ' was recorded once');
    assert.equal(mine[0].outcome, 'skipped');
    await context.close();
  }
  assert.equal(failures(), before, 'neither answer was counted against any fix');
  assert.equal(query("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE outcome='failed'")[0].n, 0);
});

test('"Still need help" counts one failure for the chosen fix only, and offers the remaining suggestions', async () => {
  const { page, context } = await deskFor('Eli');
  await ask(page, ISSUE);
  await page.waitForSelector('.alt-choice');
  await page.locator('.alt-choice').first().locator('[data-choose]').click();
  await page.waitForSelector('[data-attempt][data-worked="false"]');
  const before = failures();
  await page.click('[data-attempt][data-worked="false"]');
  await page.waitForFunction(() => !document.querySelector('[data-attempt][data-worked="false"]'));
  assert.equal(failures(), before + 1, 'exactly one failure, on the chosen fix');
  assert.equal(attempts().filter((a) => a.outcome === 'failed').length, 1);
  await context.close();
});

test('asking for a person opens one specialist case with a brief of what was tried, and the customer sees the handoff state', async () => {
  const { page, context } = await deskFor('Fay');
  await ask(page, ISSUE);
  await page.waitForSelector('.alt-choice');
  await page.locator('.alt-choice').first().locator('[data-choose]').click();
  await page.waitForSelector('[data-attempt]');
  const handoffs = () => query("SELECT payload FROM records WHERE collection='handoffs'").map((r) => JSON.parse(r.payload));
  const before = handoffs().length;
  await page.click('.conversation-header [data-prompt="I need human help"]');
  await page.waitForSelector('[data-proposal]', { timeout: 15000 });
  await page.click('[data-proposal]');
  await page.waitForSelector('#action-form');
  await page.click('#action-form button[type=submit]');
  await until(() => handoffs().length === before + 1, 'the specialist case to be opened');
  const now = handoffs();
  assert.equal(now.length, before + 1, 'one case');
  const mine = now.at(-1);
  assert.ok(mine.brief, 'the specialist gets a brief');
  assert.equal(mine.brief.tried.length >= 1, true);
  assert.equal(mine.brief.tried[0].provenance.origin, 'company_db_sync');
  assert.equal(mine.brief.tried[0].provenance.customerConfirmed, false);
  await context.close();
});
