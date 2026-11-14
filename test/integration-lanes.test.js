import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function flushInChild(task, timeoutMs) {
  const moduleUrl = new URL('../server/integrations.js', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { createIntegrations } from ${JSON.stringify(moduleUrl)};
    const store = { db: {}, update: (fn) => fn({ outbox: [] }) };
    const delivery = createIntegrations(store, {});
    delivery.register(${task}, { name: 'test-lane', timeoutMs: ${timeoutMs} });
    await delivery.flush();
    console.log('flushed', delivery.lanes()[1].running);
  `], { encoding: 'utf8', timeout: 5000 });
}

test('an explicit flush reaches its deadline even when a stuck lane is the only pending work', () => {
  const result = flushInChild('() => new Promise(() => {})', 30);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'flushed true', 'the wait ends while the lane remains running');
});

test('a completed lane releases its long deadline so the process can exit', () => {
  const result = flushInChild('() => {}', 60000);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'flushed false');
});

test('a failed lane releases its deadline without an unhandled rejection', () => {
  const result = flushInChild('() => { throw new Error("test failure"); }', 60000);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'flushed false');
  assert.match(result.stderr, /Worker task "test-lane" failed: test failure/);
});
