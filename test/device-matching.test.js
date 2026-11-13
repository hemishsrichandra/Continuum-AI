import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './_helpers.js';
import { customerFacts, extractMentions } from '../server/applicability.js';
import { compatibilityGate, THRESHOLDS } from '../server/scoring.js';
import { normalizeApplicability } from '../server/passports.js';

const model = (text) => customerFacts(text).model?.values ?? [];

test('natural device names are recognised without a literal "model" prefix', () => {
  const cases = {
    'my MacBook Pro 16 M2 flickers': 'macbook pro 16 m2', 'MacBook Air M1 is slow': 'macbook air m1', 'a MacBook display problem': 'macbook',
    'Dell XPS 13 will not wake': 'dell xps 13', 'my ThinkPad X1 Carbon': 'thinkpad x1 carbon', 'iPhone 14 Pro battery': 'iphone 14 pro',
    'iPad Air is frozen': 'ipad air', 'Surface Pro 9 screen': 'surface pro 9', 'Pixel 8 offline': 'pixel 8', 'Galaxy S24 Ultra drains': 'galaxy s24 ultra',
    'HP Pavilion x360 fan': 'hp pavilion x360', 'Lenovo Yoga hinge': 'lenovo yoga',
  };
  for (const [text, expected] of Object.entries(cases)) assert.deepEqual(model(text), [expected], text);
  // Literal phrases still work, and OS families are still separate facts.
  assert.deepEqual(model('Model X firmware 4'), ['x']);
  assert.deepEqual(customerFacts('Windows 11 on a Dell XPS 13').windows.values, ['11']);
  assert.deepEqual(customerFacts('Ubuntu 22.04').ubuntu.values, ['22.04']);
  assert.deepEqual(customerFacts('Android 14 on a Pixel 8').android.values, ['14']);
});

test('denied and historical devices are not treated as the customer’s device', () => {
  assert.deepEqual(model('it is not a MacBook Pro, it is a Dell XPS 13'), ['dell xps 13']);
  assert.equal(extractMentions('it is not a MacBook Pro').mentions[0].negated, true);
  assert.deepEqual(model('I used to have a ThinkPad but now use a Surface Laptop'), ['surface laptop']);
});

const passport = (environmentText, extra = {}) => ({ applicability: normalizeApplicability({ environmentText }), safety: { restrictions: [], noneIdentified: true, reviewed: true }, ...extra });
const gate = (environmentText, customerText, extra) => compatibilityGate({ ...passport(environmentText, extra), facts: customerFacts(customerText), text: customerText });

test('generic partial match: a family-level mention keeps a "verified on" fix in play, with S_compat 0.5 and the exact advisory', () => {
  const g = gate('MacBook Pro 16 M2', 'My MacBook display flickers after startup');
  assert.equal(g.eligible, true);
  assert.equal(g.partial, true);
  assert.equal(g.compat, 0.5);
  assert.equal(g.advisory, 'Note: This solution was verified on MacBook Pro 16 M2. Steps may vary slightly for your setup.');
  assert.equal(THRESHOLDS.partialHybrid, 0.65);
  assert.equal(gate('MacBook Pro 16 M2', 'MacBook Pro 16 M2 display flickers').partial, undefined, 'a confirmed match is a normal compatible match');
  assert.equal(gate('MacBook Pro 16 M2', 'MacBook Pro 16 M2 display flickers').compat, 1);
});

test('explicit mismatches, mandatory versions and safety restrictions are never softened', () => {
  assert.equal(gate('MacBook Pro 16 M2', 'My Dell XPS 13 display flickers').eligible, false, 'a different named device blocks');
  assert.equal(gate('MacBook Pro 16 M2', 'My MacBook Air M1 display flickers').status, 'conflict');
  assert.equal(gate('MacBook Pro 16 M2', 'it is not a MacBook Pro, the display flickers').eligible, false, 'denied ownership blocks');
  // A mandatory firmware/version is asked for, never guessed, however relevant the text.
  const mandatory = gate('MacBook Pro 16 M2 firmware 4', 'My MacBook display flickers after startup');
  assert.equal(mandatory.eligible, false);
  assert.equal(mandatory.status, 'unknown');
  assert.equal(gate('Model X firmware 4', 'The display flickers').status, 'unknown');
  assert.equal(gate('Windows 11', 'My MacBook display flickers').eligible, false, 'a different operating system conflicts');
  // A hazard restriction still blocks a generic fix.
  const wet = gate('MacBook Pro 16 M2', 'My MacBook got wet and the display flickers', { safety: { restrictions: [{ text: 'Do not use if the device is wet', keywords: ['wet'] }] } });
  assert.equal(wet.eligible, false);
  assert.equal(wet.status, 'safety_conflict');
  // Leftover words in the environment that nobody parsed are still mandatory.
  assert.equal(gate('MacBook Pro 16 M2 with the docking station', 'My MacBook display flickers').eligible, false);
});

test('end to end: a strong generic match reaches the customer list with the advisory; a mandatory one asks instead', async (t) => {
  const w = await world(t);
  const bot = w.botOf(w.company);
  const ask = (text) => w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text });
  w.seed(w.company, { title: 'Display flickers after startup', symptoms: 'The display flickers after startup', steps: ['Open Display settings, choose the Standard profile and restart.'], environment: 'MacBook Pro 16 M2', sourceKey: 'g:1' });
  const generic = await ask('The display flickers after startup on my MacBook');
  assert.equal(generic.eligible.length, 1, JSON.stringify(generic.rejected));
  assert.equal(generic.eligible[0].gate.partial, true);
  assert.match(generic.eligible[0].gate.advisory, /^Note: This solution was verified on MacBook Pro 16 M2\. Steps may vary slightly for your setup\.$/);
  assert.equal((await ask('The display flickers after startup on my Dell XPS 13')).eligible.length, 0, 'a different device is blocked');
  w.seed(w.company, { title: 'Display driver rollback', symptoms: 'The display driver crashes after update', steps: ['Roll back the display driver to the previous version from Device Manager.'], environment: 'Windows 11 build 22631', sourceKey: 'g:2' });
  const mand = await ask('The display driver crashes after update on my laptop');
  assert.equal(mand.eligible.length, 0, 'unknown mandatory facts are never guessed');
  assert.ok(mand.withheld.some((x) => /display driver/i.test(x.title)), 'the customer is asked for the missing fact');
});

test('Linux is a family-level fact: Ubuntu implies it, other operating systems conflict with it, and a generic "Linux" does not contradict an Ubuntu fix', () => {
  assert.deepEqual(customerFacts('I run Ubuntu 22.04 on this machine').linux.values, ['any']);
  assert.deepEqual(customerFacts('it is a Linux box').linux.values, ['any']);
  assert.equal(gate('Linux', 'Ubuntu 22.04 shows a black screen').status, 'compatible');
  assert.equal(gate('Linux', 'Windows 11 shows a black screen').eligible, false, 'a different operating system conflicts');
  const generic = gate('Ubuntu 22.04', 'My Linux machine shows a black screen');
  assert.notEqual(generic.status, 'conflict', 'Linux does not contradict Ubuntu');
  assert.equal(generic.eligible, false, 'but the version is still unknown, so it asks first');
  assert.equal(gate('Ubuntu 22.04', 'Windows 11 black screen').status, 'conflict');
});
