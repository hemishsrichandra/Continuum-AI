import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = { ...process.env, ENABLE_DEMO_MODE: 'true' };
// Keep the CLI comparison separate from the workspace's existing demo records.
if (config.HINDSIGHT_BASE_URL) config.HINDSIGHT_BANK_PREFIX = (config.HINDSIGHT_BANK_PREFIX || 'continuum') + '-cli';
const handler = createHandler({ config });

async function api(route, options) {
  const { status, data } = await invoke(handler, route, options);
  if (status >= 400) throw new Error(data.error);
  return data;
}

const { profiles } = await api('profiles');
for (const profile of profiles) {
  const { token } = await api('session', { body: { profileId: profile.id, pin: config.DEMO_PIN || '246810' } });
  console.log('\n' + profile.name + ' · ' + profile.label + '\n' + profile.prompt);
  for (const memory of [false, true]) {
    const { reply, trace, action, model } = await api('chat', {
      token, body: { ticketId: profile.ticketId, message: profile.prompt, memory, retain: false },
    });
    console.log('\nMemory ' + (memory ? 'ON' : 'OFF') + ' · ' + trace.memory + ' · ' + trace.recalled + ' recalled · ' + model);
    console.log(reply);
    if (action) console.log('Prepared action: ' + action.kind);
  }
}
