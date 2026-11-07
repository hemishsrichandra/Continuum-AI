import {test} from 'node:test';
import assert from 'node:assert/strict';
import {customerAdvice} from '../server/customer-advice.js';

test('customer advice hides attribution while preserving prerequisites, warnings and technical steps',()=>{
  const approved='Specialist solution: install the specialist-provided driver version 4.2 on Model X only. Contact a specialist to obtain the signed package. Stop if the device becomes unusually hot.';
  const reply=customerAdvice(approved);
  assert.equal(reply,'Install the approved driver version 4.2 on Model X only. Contact a specialist to obtain the signed package. Stop if the device becomes unusually hot.');
  assert.equal(customerAdvice(reply),reply);
});
