import { fault } from './providers.js';

export const defaultBotId = (companyId, adapter) => `${companyId}:${adapter}`;
export const botId = (profile) => profile.chatbotId || defaultBotId(profile.companyId, profile.provider);
// Default bots preserve existing private bank names; additional bots get new banks.
export const privateScope = (p) => `${p.companyId}:${botId(p) === defaultBotId(p.companyId, p.provider) ? p.provider : botId(p)}:${p.id}`;
export const knowledgeScope = (companyId, id) => `knowledge:${companyId}:chatbot:${id}`;
export function defaults(companyId, adapter) {
  return {
    id: defaultBotId(companyId, adapter), companyId, adapter,
    name: adapter === 'repair' ? 'Device repair' : 'IT support',
    purpose: adapter === 'repair' ? 'Diagnose device problems and arrange repairs.' : 'Diagnose IT connectivity and access issues.',
    supportedTopics: adapter === 'repair' ? ['display', 'screen', 'battery', 'phone', 'device', 'laptop', 'offline', 'network', 'wifi', 'wireless', 'vpn', 'printer', 'audio', 'sound', 'camera', 'webcam', 'storage', 'disk', 'application', 'email'] : ['vpn', 'network', 'wifi', 'login', 'email', 'computer'],
    requiredContext: ['environment'],
    playbooks: [{ id: 'connectivity-check', version: 1, topics: ['offline', 'vpn', 'network', 'wifi'],
      steps: 'Check that airplane mode is off and the network cable or Wi-Fi connection is enabled. Reconnect once and test the connection.' },
      ...(adapter === 'repair' ? [{id:'charging-connection-check',version:1,topics:['charging','charger','battery','charge'],
        steps:'Check that the manufacturer-approved charger is firmly connected to the laptop and a working wall outlet. Check the charging indicator, then see whether the battery percentage increases while the laptop is idle. Do not use a damaged charger or a swollen or unusually hot battery; request a specialist instead.'}] : [])],
    allowedActions: ['request', 'requirement', 'book', 'cancel', 'handoff', 'outcome'],
    escalationRules: { immediateTopics: ['smoke', 'burning', 'security breach'], supportRoute: 'Request a company specialist using Human help.' },
    knowledgeScope: 'company_chatbot', active: true, revision: 1,
  };
}
export function ensureBots(sql, companyId) {
  for (const adapter of ['repair', 'it']) {
    const b = defaults(companyId, adapter);
    sql.prepare('INSERT OR IGNORE INTO chatbots(id,company_id,adapter,config) VALUES(?,?,?,?)')
      .run(b.id, companyId, adapter, JSON.stringify(b));
  }
}
export function getBot(sql, companyId, id) {
  const row = sql.prepare('SELECT config FROM chatbots WHERE id=? AND company_id=?').get(id, companyId);
  if (!row) throw fault(404, 'Service not found in this company.');
  return JSON.parse(row.config);
}
export function validateBot(input, companyId, previous) {
  if (!input || !['repair', 'it'].includes(input.adapter)) throw fault(400, 'Choose the repair or IT adapter.');
  const text = (v, max = 1000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const strings = (v, max = 30) => Array.isArray(v) && v.length <= max && v.every(x => text(x, 200));
  if (!text(input.name, 100) || !text(input.purpose) || !strings(input.supportedTopics) ||
      !strings(input.requiredContext) || !strings(input.allowedActions) ||
      input.requiredContext.some(k=>! /^[a-z][a-z0-9_]{0,49}$/.test(k) || ['constructor','prototype'].includes(k)) ||
      input.allowedActions.some(a => !['request','requirement','book','cancel','handoff','outcome'].includes(a)) ||
      !Array.isArray(input.playbooks) || input.playbooks.length > 30 ||
      input.playbooks.some(p => !text(p.id, 100) || !Number.isInteger(p.version) || p.version < 1 || !strings(p.topics) || !text(p.steps, 3000) || (p.environment !== undefined && (typeof p.environment !== 'string' || p.environment.length>500))) ||
      new Set(input.playbooks.map(p => p.id)).size !== input.playbooks.length ||
      !strings(input.escalationRules?.immediateTopics) || !text(input.escalationRules?.supportRoute) ||
      typeof input.active !== 'boolean' || input.knowledgeScope !== 'company_chatbot')
    throw fault(400, 'Invalid service configuration. Use lists of topics, context fields, actions and versioned playbooks.');
  if (previous && (input.adapter !== previous.adapter || input.revision !== previous.revision))
    throw fault(409, 'Service changed or adapter cannot be changed. Refresh before saving.');
  return { id: previous?.id || input.id, companyId, adapter: input.adapter, name: input.name.trim(),
    purpose: input.purpose.trim(), supportedTopics: input.supportedTopics, requiredContext: input.requiredContext,
    allowedActions: input.allowedActions, playbooks: input.playbooks.map(p => ({id:p.id,version:p.version,topics:p.topics,steps:p.steps,...(p.environment && {environment:p.environment})})),
    escalationRules: input.escalationRules, active: input.active, knowledgeScope: 'company_chatbot', revision: (previous?.revision || 0) + 1 };
}
