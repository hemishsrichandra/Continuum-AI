import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilotReplay } from '../scripts/pilot-replay.js';

// Mechanism test only: synthetic tickets prove the replay works and never peeks at the future. It is not an accuracy claim.
const FAMILIES = [
  [['Laptop will not charge', 'Charger connected but the battery stays at 0%', 'Laptop not charging at all'], 'Hold the power button for 30 seconds with the charger unplugged to reset the battery controller, then reconnect the charger.'],
  [['Screen flickers', 'Display keeps flickering after startup', 'Flickering monitor when the laptop boots'], 'Turn off adaptive refresh in Display settings and restart the laptop.'],
  [['Wi-Fi keeps dropping', 'Wireless disconnects every few minutes', 'Lose Wi-Fi connection on battery'], 'Disable power saving for the wireless adapter in Device Manager and restart.'],
  [['Fan is very loud', 'Loud fan noise at idle', 'Fan runs at full speed all the time'], 'Clean the vents with compressed air and set the power profile to Balanced.'],
];
const tickets = [];
for (let i = 0; i < 40; i++) {
  const [problems, fix] = FAMILIES[i % 4];
  tickets.push({ ref: 'T' + i, subject: '', problem: problems[i % 3] + ' on my Model X', resolution: fix, environment: '', date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
}

test('pilot replay: time-ordered, read-only replay reports top-1/top-3 match against what specialists actually did', async () => {
  const { summary, rows, csv } = await pilotReplay({ tickets, warmup: 8 });
  assert.equal(summary.replayed, 32);
  assert.ok(summary.top3Rate >= 0.5, JSON.stringify(summary));
  assert.ok(summary.top1Match <= summary.top3Match);
  assert.equal(summary.ceiling.rate, 1, 'every family had been solved before the replayed ticket');
  assert.match(csv.split('\n')[0], /human_match$/);
  assert.equal(csv.split('\n').length, 33);
  // No peeking: the first replayed ticket could only use the 8 warm-up tickets.
  assert.equal(rows[0].knowledge, 8);
});

test('pilot replay: a problem never solved before cannot be matched and is counted honestly', async () => {
  const novel = [...tickets.slice(0, 10), { ref: 'NEW', subject: '', problem: 'The printer prints blank pages', resolution: 'Replace the toner cartridge and run a cleaning page.', environment: '', date: '2026-03-01T00:00:00Z' }, ...tickets.slice(10, 14).map((t) => ({ ...t, date: '2026-03-02T00:00:00Z' }))];
  const { rows } = await pilotReplay({ tickets: novel, warmup: 10 });
  const r = rows.find((x) => x.ref === 'NEW');
  assert.ok(!r.top.some((x) => x.sim >= 0.5));
  await assert.rejects(pilotReplay({ tickets: tickets.slice(0, 10), warmup: 20 }), /at least/);
});
