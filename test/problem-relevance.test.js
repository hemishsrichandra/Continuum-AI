import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problemRelevance } from '../server/scoring.js';
import { createSession, getSession, runGuided, suggest, SCRIPT } from '../server/demo-learning.js';
import { DISPLAY_NEAR_MISSES } from '../evaluation/near-misses.js';
import { world } from './_helpers.js';

const symptoms = 'Display flickers after startup';
const positives = ['The monitor keeps blinking whenever it boots.', 'The screen flashes after startup.', 'The screen is flikering on boot.'];

test('component and timing do not substitute for the failure symptom, even with a high score', () => {
  for (const text of DISPLAY_NEAR_MISSES)
    assert.equal(problemRelevance({ text, symptoms, hybrid: 1 }).eligible, false, text);
  for (const text of positives)
    assert.equal(problemRelevance({ text, symptoms, hybrid: 0.8 }).eligible, true, text);
  assert.equal(problemRelevance({ text: positives[0], symptoms, hybrid: 0.49 }).eligible, false);
});

test('the isolated demo rejects same-device different-symptom matches and keeps valid paraphrases', () => {
  const state = getSession(createSession());
  runGuided(state);
  for (const description of DISPLAY_NEAR_MISSES)
    assert.equal(suggest(state, { description, device: SCRIPT.userB.device }).top, null, description);
  for (const description of positives)
    assert.ok(suggest(state, { description, device: SCRIPT.userB.device }).top, description);
});

test('main retrieval and the customer choice flow reject the same near misses', async (t) => {
  const w = await world(t, { choose: true });
  const bot = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.adapter === 'repair');
  await w.owner.api('company/chatbots', { ...bot, playbooks: [] });
  w.seed(w.company, { title: 'Display flicker', symptoms, steps: ['Disable Adaptive Refresh in Display Settings and restart.'] });
  const customer = await w.customer('probe');
  for (const message of DISPLAY_NEAR_MISSES) {
    const text = message + ' Model X firmware 4.';
    const found = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot.id, text });
    assert.equal(found.eligible.length, 0, message);
    const ticket = await w.ticket(customer, text, 'Model X firmware 4');
    const reply = (await w.ask(customer, ticket, message)).data;
    assert.notEqual(reply.decision.mode, 'recommend', message);
    assert.equal(reply.choices?.length || 0, 0, message);
  }
  for (const message of positives) {
    const found = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot.id, text: message + ' Model X firmware 4.' });
    assert.equal(found.eligible.length, 1, message);
  }
});
