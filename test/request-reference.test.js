import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestReference } from '../server/request-reference.js';

const tickets=[{id:'SR-111',title:'QA screen flicker'},{id:'SR-222',title:'QA battery drain'}];
test('request references recognize owned titles and IDs, and clarify ambiguous titles',()=>{
  assert.deepEqual(requestReference('what about battery drain request',tickets,'SR-111').choices,[tickets[1]]);
  assert.deepEqual(requestReference('status of SR-222',tickets,'SR-111').choices,[tickets[1]]);
  assert.equal(requestReference('what about screen flicker request',tickets,'SR-111'),null);
  assert.equal(requestReference('What is the status of my request?',tickets,'SR-111'),null);
  const duplicate={id:'SR-333',title:'Battery drain'};
  assert.equal(requestReference('check battery drain request',[...tickets,duplicate],'SR-111').choices.length,2);
});
test('request navigation does not interpret note contents, new-ticket creation or negated switches as navigation',()=>{
  for(const message of ['Add a note: ask about battery drain request.', 'Please create a ticket for battery drain request.', 'Do not switch to battery drain request.'])
    assert.equal(requestReference(message,tickets,'SR-111'),null,message);
});
test('unknown IDs never disclose another customer record or fall back to the selected case',()=>{
  const result=requestReference('what about SR-999',tickets,'SR-111');
  assert.deepEqual(result.choices,[]);
  assert.doesNotMatch(result.question,/battery|screen|exists/i);
});
