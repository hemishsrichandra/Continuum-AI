import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, getSession, runGuided, compareSearch, SCRIPT } from '../server/demo-learning.js';
import { tourSteps } from '../web/tour.js';

const taught = () => { const s = getSession(createSession()); runGuided(s); return s; };

test('the same reworded problem is missed by keyword search and found by meaning search', () => {
  const s = taught();
  const { comparison: c } = compareSearch(s, { description: 'The monitor keeps blinking whenever it boots.', device: SCRIPT.userB.device });
  assert.equal(c.keyword.found, false, 'no problem word is shared with the stored fix');
  assert.equal(c.meaning.found, true);
  assert.match(c.meaning.title, /flicker/i);
  assert.ok(c.meaning.matchedConcepts.includes('flicker'), 'it names the concepts it matched on');
});

test('device words alone never count as a keyword match, and an unrelated problem is found by neither', () => {
  const s = taught();
  const { comparison: c } = compareSearch(s, { description: 'My keyboard has a sticky key.', device: SCRIPT.userB.device });
  assert.equal(c.keyword.found, false);
  assert.equal(c.meaning.found, false, 'no invented match for an unrelated problem');
  assert.ok(c.keyword.deviceWordsOnly.length > 0, 'the shared device name is shown but not counted');
});

test('the comparison needs something learned first, validates input and changes nothing', () => {
  const empty = getSession(createSession());
  assert.throws(() => compareSearch(empty, { description: 'screen flickers' }), (e) => e.status === 409);
  const s = taught();
  assert.throws(() => compareSearch(s, { description: '' }), (e) => e.status === 400);
  const before = JSON.stringify(s.learned.map((l) => [l.successes, l.failures]));
  compareSearch(s, { description: 'screen flickers on boot', device: SCRIPT.userB.device });
  assert.equal(JSON.stringify(s.learned.map((l) => [l.successes, l.failures])), before, 'a comparison is read-only');
});

test('every role has a short tour of one-sentence steps, and its script is served', () => {
  for (const role of ['customer', 'staff', 'owner']) {
    const steps = tourSteps[role];
    assert.ok(steps.length >= 4 && steps.length <= 5, role + ' tour is 4-5 steps (about 30 seconds)');
    for (const s of steps) assert.ok(s.title && s.body && s.target && s.body.length < 200, role + ': ' + s.title);
  }
  assert.match(readFileSync(new URL('../server/start.js', import.meta.url), 'utf8'), /'\/tour\.js'/);
});
