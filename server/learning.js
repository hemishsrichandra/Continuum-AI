import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { field } from './requests.js';

export function createLearning(store, memory) {
  const scope = (provider) => 'knowledge:' + provider;
  const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !['the','and','for','with','that','this','please','what','have','from','request','issue','still'].includes(w)) || []);
  return {
    async recall(provider, message) {
      const result = await memory.recall(scope(provider), 'knowledge', message);
      const query = words(message);
      const active = store.data.resolutions.filter((r) => r.provider === provider && !r.retiredAt);
      const facts = result.facts.filter((f) => active.some((r) => r.memoryId === f.id)).map((f) => {
        const r = active.find((r) => r.memoryId === f.id);
        const overlap = [...words(r.symptoms + ' ' + r.environment + ' ' + r.title)].filter((w) => query.has(w)).length;
        return { ...f, kind: 'verified_resolution', score: overlap, resolutionId: r.id };
      }).filter((f) => f.score >= 2).sort((a,b) => b.score-a.score).slice(0,3);
      return { source: result.source, facts };
    },
    list(provider) { return store.data.resolutions.filter((r) => r.provider === provider).map(({ authorId, ...r }) => r); },
    async resolve(account, body) {
      if (body.confirmed !== true || body.reviewedForPrivacy !== true) throw fault(400, 'Confirm the resolution and review reusable content for customer-identifying information.');
      const id = field(body.handoffId, 'handoff ID', 100);
      const title = field(body.title, 'resolution title', 100), symptoms = field(body.symptoms, 'matching symptoms', 1000);
      const environment = field(body.environment, 'applicable environment', 500), solution = field(body.solution, 'verified solution steps', 2000);
      const reusable = [title,symptoms,environment,solution].join('\n');
      if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{10,}\b|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]/i.test(reusable)) throw fault(400, 'Remove email addresses, phone numbers, and credentials from reusable knowledge.');
      const item = store.update((data) => {
        const h = data.handoffs.find((h) => h.id === id && h.scope.startsWith(account.provider + ':'));
        if (!h) throw fault(404, 'Handoff was not found in your service workspace.');
        if (h.resolutionId) throw fault(409, 'This handoff already has a verified resolution.');
        const resolution = { id: randomUUID(), provider: account.provider, title, symptoms, environment, solution, authorId: account.id, handoffId: id, createdAt: new Date().toISOString(), sync: 'pending' };
        resolution.memoryId = 'resolution-' + resolution.id;
        h.status = 'Resolved'; h.resolutionId = resolution.id; h.resolvedAt = resolution.createdAt;
        const row = data[account.provider].find((r) => (r.ticket_id || r.id) === h.ticketId);
        if (row) { if (account.provider === 'repair') row.status = 'Resolved'; else row.state = 'Resolved'; }
        data.resolutions.push(resolution);
        data.conversations.push({ id: randomUUID(), scope: h.scope, ticketId: h.ticketId, system: true, message: '[Specialist resolution]', createdAt: resolution.createdAt, response: { human: true, reply: solution, model: 'Human specialist', evidence: [], trace: { memory: 'Human verified', recalled: 0 } } });
        data.audit.push({ id: randomUUID(), scope: h.scope, ticketId: h.ticketId, kind: 'human_resolution', note: 'A specialist verified the resolution: ' + title, createdAt: resolution.createdAt });
        return resolution;
      });
      let sync = 'pending';
      try { sync = await memory.remember({ id: item.memoryId, scope: scope(account.provider), ticketId: 'knowledge', kind: 'verified_resolution', text: `Human-verified resolution: ${title}\nApplicable environment: ${environment}\nMatching symptoms: ${symptoms}\nVerified steps: ${solution}\nUse only when the environment and symptoms match. Ask clarifying questions otherwise.`, createdAt: item.createdAt }); } catch { /* The verified resolution remains durable for retry. */ }
      store.update((data) => { data.resolutions.find((r) => r.id === item.id).sync = sync; });
      return { ...item, sync };
    },
    async retire(account, body) {
      const item = store.data.resolutions.find((r) => r.id === body.id && r.provider === account.provider);
      if (!item) throw fault(404, 'Resolution not found.');
      if (body.confirmed !== true) throw fault(400, 'Confirm retiring this resolution.');
      if (!item.retiredAt) {
        await memory.invalidate(scope(account.provider), 'knowledge', item.memoryId);
        store.update((data) => { data.resolutions.find((r) => r.id === item.id).retiredAt = new Date().toISOString(); });
      }
      return { success: true };
    },
  };
}
