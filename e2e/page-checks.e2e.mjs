// Page-level checks in a real browser: the Content-Security-Policy lets Google Fonts load, and the landing and sign-in pages have no nested
// complementary landmarks (axe rule landmark-complementary-is-top-level). Run with: npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { launchBrowser, startApp } from './support.mjs';

let app, browser, axeSource;
before(async () => {
  app = await startApp({});
  browser = await launchBrowser();
  axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('the Content-Security-Policy permits Google Fonts stylesheets, font files and their connections, and nothing broader', async () => {
  const csp = (await fetch(app.base + '/')).headers.get('content-security-policy');
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /connect-src 'self' https:\/\/fonts\.googleapis\.com https:\/\/fonts\.gstatic\.com;/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com data:;/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval|script-src[^;]*https?:/.test(csp), 'scripts are still limited to this site');
});

for (const path of ['/', '/desk']) {
  test(`axe finds no nested complementary landmark on ${path}`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(app.base + path);
    await page.waitForTimeout(1200);
    await page.evaluate(axeSource);
    const result = await page.evaluate(() => axe.run(document, { runOnly: { type: 'rule', values: ['landmark-complementary-is-top-level', 'landmark-unique', 'region'] } }));
    const nested = result.violations.filter((v) => v.id === 'landmark-complementary-is-top-level');
    assert.deepEqual(nested.map((v) => v.nodes.map((n) => n.target.join(' '))), [], 'no complementary landmark is nested inside another landmark');
    await context.close();
  });
}
