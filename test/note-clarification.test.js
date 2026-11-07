import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide} from '../server/decisions.js';
test('ticket references cannot become note content; explicit content stays intact', async()=>{
  for (const message of ['Please add a note to this request.', 'Add a note on my ticket', 'Leave a comment for the current case.']) {
    const r=await decide({message,ticket:{id:'t',status:'Open'},facts:[],learned:{}});
    assert.equal(r.mode,'clarify',message);
    assert.equal(r.action,null);
  }
  const r=await decide({message:'Please add a note: the charger clicks.',ticket:{id:'t',status:'Open'},facts:[],learned:{}});
  assert.equal(r.action.note,'the charger clicks.');
});

test('hypothetical booking explains confirmation without promising email, arrival or creating an action', async()=>{
  const r = await decide({message:'What happens if I book an appointment?',ticket:{id:'t',status:'Open'},facts:[],learned:{}});
  assert.equal(r.mode,'inform');
  assert.equal(r.action,null);
  assert.match(r.question,/until you select a time and confirm/);
  assert.doesNotMatch(r.question,/email|arrival/i);
});
