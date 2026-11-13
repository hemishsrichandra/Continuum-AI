// Instructions that must never be auto-published or silently imported as active, including simple obfuscation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dangerousInstructions, deobfuscate } from '../server/privacy.js';

const flagged = (text) => dangerousInstructions(text);

test('piercing or cutting a lithium pouch cell is flagged, however the sentence is phrased', () => {
  for (const text of [
    'Pierce the swollen lithium pouch with a pin to release the pressure.',
    'Puncture the battery cell to let the gas out, then dispose of it.',
    'Carefully cut into the pouch of the swollen battery.',
    'Stab the swollen cell with a screwdriver.',
    'Lance the battery pack where it is bulging.',
  ]) assert.ok(flagged(text).includes('battery puncture'), text);
});

test('soldering or welding a battery, cell or terminal is flagged', () => {
  for (const text of ['Solder the wire directly to the battery terminal.', 'Weld a new tab onto the cell.', 'Then solder a bridge across the terminal pads.'])
    assert.ok(flagged(text).includes('battery soldering'), text);
});

test('punctuation between letters does not hide a hazard (p.r.y, b-a-t-t-e-r-y, s*o*l*d*e*r)', () => {
  assert.equal(deobfuscate('p.r.y the b.a.t.t.e.r.y open'), 'pry the battery open');
  assert.ok(flagged('Use a knife to p.r.y the b.a.t.t.e.r.y cover off.').includes('battery disassembly'));
  assert.ok(flagged('s*o*l*d*e*r the b-a-t-t-e-r-y terminal').includes('battery soldering'));
  assert.ok(flagged('P.u.n.c.t.u.r.e the lithium cell').includes('battery puncture'));
  assert.ok(flagged('pi​erce the lithium pouch').includes('battery puncture'), 'zero-width characters are ignored');
});

test('ordinary, safe text is not flagged and existing patterns still work', () => {
  for (const text of [
    'Open Display settings, choose the Standard profile and restart.',
    'Press Ctrl+Alt+Del, e.g. to open Task Manager, then end the task.',
    'Version 4.2.1 of the driver fixes the issue. Visit support.example.com/a.b.c for details.',
    'Charge the battery to 80% and restart the laptop.',
    'Cut a new ticket for the cell phone repair.',
  ]) assert.deepEqual(flagged(text).filter((x) => /battery (?:puncture|soldering|disassembly)/.test(x)), [], text);
  assert.ok(flagged('Disable the thermal fuse').includes('safety bypass'));
  assert.ok(flagged('Run rm -rf / to reset').includes('destructive command'));
  assert.deepEqual(flagged(''), []);
  assert.deepEqual(flagged(undefined), []);
});
