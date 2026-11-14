// External preview API. Browser sessions manage credentials; credentials never impersonate customers.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { field, json } from './requests.js';
import { getBot, botId } from './chatbots.js';
import { sanitizeText, isPersonalKey } from './privacy-sanitizer.js';
import { sendKeyPage, createdKeyContent, managementContent } from './integration-key-page.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const eligibleKnowledge = row => row.status === 'active' && row.source_status === 'present' && !row.source_ticket_id &&
  (row.origin_type === 'standard_playbook' || row.origin_type === 'company_db_sync' && row.locally_reviewed === 1);
const safe = value => sanitizeText(String(value)).text;

export function createExternalChat({ store, auth, memoryPool }) {
  const sql = store.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS external_chat_credentials (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, chatbot_id TEXT NOT NULL,
    name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS external_chat_audience (
    credential_id TEXT NOT NULL REFERENCES external_chat_credentials(id), memory_id TEXT NOT NULL,
    content_hash TEXT NOT NULL, PRIMARY KEY(credential_id,memory_id));`);

  function owner(session) {
    if (!session?.account_id || session.profile.role !== 'owner' || session.profile.demo)
      throw fault(403, 'Sign in as the company owner to manage integration keys.');
    return session.profile;
  }
  const records = p => sql.prepare(`SELECT id,name,prefix,chatbot_id AS chatbotId,created_at AS createdAt,revoked_at AS revokedAt
    FROM external_chat_credentials WHERE company_id=? ORDER BY created_at DESC`).all(p.companyId);
  const knowledge = (companyId, chatbotId) => sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND chatbot_id=?').all(companyId, chatbotId).filter(eligibleKnowledge);
  function create(p, body) {
    const bot = getBot(sql, p.companyId, field(body.chatbotId, 'service', 100));
    if (!bot.active) throw fault(403, 'This service is inactive.');
    const name = field(body.name, 'integration name', 80);
    if (sanitizeText(name).secret) throw fault(400, 'Do not include secrets in the integration name.');
    if (body.confirmed !== true || !Array.isArray(body.memoryIds) || !body.memoryIds.length || body.memoryIds.length > 100 || body.memoryIds.some(id => typeof id !== 'string' || id.length > 100))
      throw fault(400, 'Select 1–100 reviewed records and confirm they are safe for the external audience.');
    if (records(p).filter(r => !r.revokedAt).length >= 20) throw fault(400, 'Revoke an unused key before creating another (maximum 20 active).');
    const id = randomUUID(), prefix = 'ctm_' + randomBytes(8).toString('hex');
    const key = prefix + '_' + randomBytes(32).toString('base64url');
    sql.transaction(() => {
      const allowed = new Map(knowledge(p.companyId, bot.id).map(r => [r.id, r]));
      for (const mid of body.memoryIds) if (!allowed.has(mid)) throw fault(400, 'Only current reviewed company knowledge in this service can be approved.');
      sql.prepare('INSERT INTO external_chat_credentials VALUES(?,?,?,?,?,?,?,?,NULL)')
        .run(id, p.companyId, bot.id, safe(name), prefix, hash(key), p.id, new Date().toISOString());
      const add = sql.prepare('INSERT INTO external_chat_audience VALUES(?,?,?)');
      for (const mid of new Set(body.memoryIds)) add.run(id, mid, allowed.get(mid).content_hash);
    }).immediate();
    return key;
  }
  function revoke(p, id) {
    const r = sql.prepare('UPDATE external_chat_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND company_id=?').run(new Date().toISOString(), id, p.companyId);
    if (!r.changes) throw fault(404, 'Integration key not found in this company.');
  }
  async function manage({ req, res, url, session, write }) {
    if (!url.pathname.startsWith('/api/company/integration-keys')) return false;
    const p = owner(session);
    auth.rate(session.token_hash + ':integration-keys', 30);
    const root = '/api/company/integration-keys';
    if (url.pathname === root && req.method === 'GET') return write(200, { credentials: records(p) });
    if (url.pathname === root + '/manage') {
      let notice = '';
      if (req.method === 'POST') {
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) throw fault(415, 'Submit the account form.');
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fault(413, 'Request is too large.'); chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        // This route alone accepts the existing session CSRF token in a native form body.
        auth.csrf({ method: req.method, headers: { 'x-csrf-token': form.get('csrf') } }, session);
        if (form.get('action') === 'revoke') { revoke(p, field(form.get('id'), 'key identifier', 100)); notice = 'revoked'; }
        else if (form.get('action') === 'create') {
          const key = create(p, { name: form.get('name'), chatbotId: form.get('chatbotId'), memoryIds: form.getAll('memoryIds'), confirmed: form.get('confirmed') === 'yes' });
          return sendKeyPage(res, createdKeyContent(key), 201);
        } else throw fault(400, 'Choose create or revoke.');
      } else if (req.method !== 'GET') throw fault(405, 'Use GET or POST.');
      const bots = sql.prepare('SELECT id FROM chatbots WHERE company_id=?').all(p.companyId).map(r => getBot(sql, p.companyId, r.id)).filter(b => b.active);
      const selected = url.searchParams.get('chatbotId') || botId(p);
      getBot(sql, p.companyId, selected);
      return sendKeyPage(res, managementContent({ bots, selected, csrfToken: session.csrfToken,
        knowledge: knowledge(p.companyId, selected), credentials: records(p), notice }));
    }
    // JSON revocation for server-side tooling, protected by the normal session CSRF check.
    auth.csrf(req, session);
    const match = url.pathname.match(/^\/api\/company\/integration-keys\/([^/]+)$/);
    if (match && req.method === 'DELETE') { revoke(p, match[1]); return write(200, { revoked: true }); }
    throw fault(404, 'Integration management route not found.');
  }
  async function external({ req, url, write }) {
    if (!url.pathname.startsWith('/api/v1/external/')) return false;
    // No cookies, customer IDs, company IDs or service IDs contribute to this identity.
    const bearer = req.headers.authorization;
    if (typeof bearer !== 'string' || !/^Bearer ctm_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(bearer)) throw fault(401, 'Invalid integration credential.');
    const key = bearer.slice(7);
    const credential = sql.prepare('SELECT * FROM external_chat_credentials WHERE key_hash=? AND revoked_at IS NULL').get(hash(key));
    if (!credential) throw fault(401, 'Invalid integration credential.');
    auth.rate('external-chat:' + credential.id, 30);
    const bot = getBot(sql, credential.company_id, credential.chatbot_id);
    if (!bot.active) throw fault(403, 'This service is inactive.');
    if (url.pathname !== '/api/v1/external/suggestions') throw fault(404, 'External API route not found.');
    if (req.method !== 'POST') throw fault(405, 'Use POST.');
    if (url.search) throw fault(400, 'Send question data in the JSON body, without URL parameters.');
    const body = await json(req, 8192);
    if (Object.keys(body).some(k => !['question','conversationId','environment'].includes(k))) throw fault(400, 'Only question, conversationId and environment are accepted.');
    const question = field(body.question, 'question', 1400);
    const conversationId = field(body.conversationId, 'external conversation ID', 120);
    if (!/^[A-Za-z0-9_.:-]+$/.test(conversationId)) throw fault(400, 'Use an opaque conversation identifier (letters, digits, _, ., : or -).');
    const environment = body.environment ?? {};
    const schemaKeys = new Set(['environment', ...bot.diagnosticSchema.map(f => f.key)]);
    if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.keys(environment).length > 12 ||
      Object.entries(environment).some(([k,v]) => isPersonalKey(k) || !schemaKeys.has(k) || typeof v !== 'string' || !v.trim() || v.length > 300)) throw fault(400, 'Environment must contain service diagnostic fields with short string values.');
    if (sanitizeText(question + '\n' + Object.values(environment).join('\n')).secret) throw fault(400, 'Remove credentials and secrets from the question and environment.');
    // Stable opaque reference keyed by this credential: identical external IDs cannot share identity across keys.
    // We persist no conversation text, facts, customer identity, attempts, outcomes or reuse events.
    const conversationRef = createHmac('sha256', credential.key_hash).update(conversationId).digest('hex');
    const permitted = () => new Set(sql.prepare(`SELECT m.* FROM memory_pool m JOIN external_chat_audience a ON a.memory_id=m.id AND a.content_hash=m.content_hash
      WHERE a.credential_id=? AND m.company_id=? AND m.chatbot_id=?`).all(credential.id, credential.company_id, credential.chatbot_id).filter(eligibleKnowledge).map(r => r.id));
    const cleanQuestion = safe(question);
    const cleanEnvironment = Object.fromEntries(Object.entries(environment).map(([k,v]) => [k, safe(v)]));
    const factsText = [cleanQuestion, ...Object.entries(cleanEnvironment).map(([k,v]) => k + ': ' + v)].join('\n');
    const result = await memoryPool.retrieve({ companyId: credential.company_id, chatbotId: credential.chatbot_id,
      text: cleanQuestion, factsText, fields: cleanEnvironment, permittedIds: permitted(), allowedOrigins: ['company_db_sync','standard_playbook'], limit: 3 });
    // Recheck after asynchronous retrieval: revocation, source withdrawal and review changes take effect before delivery.
    if (!sql.prepare('SELECT 1 FROM external_chat_credentials WHERE id=? AND revoked_at IS NULL').get(credential.id)) throw fault(401, 'Invalid integration credential.');
    if (!getBot(sql, credential.company_id, credential.chatbot_id).active) throw fault(403, 'This service is inactive.');
    const current = permitted();
    const suggestions = result.eligible.filter(c => current.has(c.id)).flatMap(c => {
      const r = memoryPool.get(credential.company_id, credential.chatbot_id, c.id);
      const steps = JSON.parse(r.steps_json);
      if (sanitizeText([r.title, ...steps].join('\n')).secret) return [];
      return [{ id: r.id, title: safe(r.title), steps: steps.map(safe), advisory: c.gate.advisory ? safe(c.gate.advisory) : null,
        provenance: { source: r.origin_type === 'company_db_sync' ? 'Reviewed company knowledge import' : 'Owner configured playbook', origin: r.origin_type, version: r.version_number, reviewed: true, customerConfirmed: Boolean(r.customer_confirmed) },
        unconfirmedEvidence: r.customer_confirmed ? null : 'Not customer-confirmed; reviewed instructions are not evidence of success in this conversation.' }];
    });
    const clarification = [...new Set(result.withheld.filter(c => current.has(c.id)).flatMap(c => c.missing).map(safe))];
    return write(200, { conversationRef, status: suggestions.length ? 'suggestions' : clarification.length ? 'clarification_required' : 'no_match',
      preview: true, suggestions, clarification, ...(suggestions.length || clarification.length ? {} : { message: 'No eligible approved knowledge matched. Contact company support.' }) });
  }
  return { manage, external };
}
