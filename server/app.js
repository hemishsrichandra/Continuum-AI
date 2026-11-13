import { botId, getBot } from './chatbots.js';
import { createTroubleshooting } from './troubleshooting.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Store, fault, provider } from './providers.js';
import { createMemory } from './memory.js';
import { json, submission } from './requests.js';
import { createLearning } from './learning.js';
import { createAuth } from './auth.js';
import { createIntegrations } from './integrations.js';
import { createCompanies } from './companies.js';
import { createConnector } from './connector.js';
import { createReuse } from './reuse.js';
import { createProviderActions } from './provider-actions.js';
import { createMemoryPool } from './memory-pool.js';
import { createFollowThrough } from './follow-through.js';
import { handleDemo, isDemoPath } from './demo-learning.js';
import { createDataSources } from './data-sources.js';
import { createShadow } from './shadow.js';
import { createKnowledgeImport } from './knowledge-import.js';
import { createPrivacyControls } from './privacy-controls.js';
import { createEmbeddingService } from './embedding-service.js';
import { createVectorStore } from './vector-store.js';
import { createVectorIndex } from './vector-index.js';
import { createSystemHealth } from './system-health.js';
import { createFixExplainer } from './fix-explainer.js';
import { createPublicRoutes } from './routes/public.js';
import { createCompanyRoutes } from './routes/company.js';
import { createCustomerRoutes } from './routes/customer.js';
import { createActionRoutes } from './routes/actions.js';

export function createHandler({ file, config = process.env, service, vectorClient } = {}) {
  config = { APP_URL: 'http://localhost:3000', ...config };
  const appUrl = new URL(config.APP_URL);
  if (
    !['http:', 'https:'].includes(appUrl.protocol) ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== '/' ||
    (config.NODE_ENV === 'production' && appUrl.protocol !== 'https:')
  )
    throw new Error('APP_URL must be a site origin; production requires HTTPS.');
  config.APP_URL = appUrl.origin;
  const store = new Store(file);
  const delivery = createIntegrations(store, config);
  const companies = createCompanies(store, config, delivery);
  const connector = createConnector(store, delivery, config);
  const auth = createAuth(store, config, delivery, companies);
  if (config.ENABLE_OUTBOX_WORKER === 'true') delivery.start();
  const memory = service || createMemory(store, config);
  const providerActions = createProviderActions(store, delivery, config);
  const embedding = createEmbeddingService(config);
  const vectors = createVectorStore(config, { client: vectorClient });
  const memoryPool = createMemoryPool(store, config, { embedding, vectors });
  const vectorIndex = createVectorIndex(store, { vectors, embedding });
  const dataSources = createDataSources(store, delivery, config);
  const shadow = createShadow(store, memoryPool, config);
  const knowledgeImport = createKnowledgeImport(store, config, { fetchImpl: config.__knowledgeDraftFetch || null });
  const followThrough = createFollowThrough(store, { delivery, config });
  const reuse = createReuse(store, memory, providerActions, memoryPool);
  const learning = createLearning(store, memory, companies, config, reuse, providerActions, { memoryPool, followThrough, shadow });
  const troubleshooting = createTroubleshooting(store, learning, reuse, providerActions, { memoryPool, followThrough, suggestionMode: config.SUGGESTION_MODE ?? process.env.SUGGESTION_MODE, shadow, explainer: createFixExplainer(config, { fetchImpl: config.__explainFetch || null }) });
  // Follow-through deadlines run on the integrations worker tick, not per web request.
  // Each task is an independent worker lane (own timeout, backoff and status): a slow database sync cannot block email, indexing or follow-through.
  delivery.register(() => followThrough.tick(), { name: 'follow-through', timeoutMs: 30000 });
  delivery.register(() => dataSources.runDue(), { name: 'data-sources', timeoutMs: 120000 });
  let lastReconcile = 0;
  delivery.register(async () => {
    await vectorIndex.drain();
    if (vectors.enabled && Date.now() - lastReconcile > 3600000) { lastReconcile = Date.now(); vectorIndex.markStale(); await vectorIndex.reconcileVectorIndex().catch(() => {}); }
  }, { name: 'knowledge-indexing', timeoutMs: 60000 });
  const privacy = createPrivacyControls(store, memory, config);
  const systemHealth = createSystemHealth({ store, vectorIndex, privacy, delivery, dataSources });
  delivery.register(() => privacy.sweep(), { name: 'retention', timeoutMs: 30000 });
  delivery.register(() => privacy.processTasks(), { name: 'erasure', timeoutMs: 60000 });
  if (config.ENABLE_OUTBOX_WORKER === 'true') providerActions.start();
  if (config.ENABLE_OUTBOX_WORKER === 'true') memory.start?.();
  const pending = new Map();
  const limit = (key, count) => auth.rate(key, count);
  async function once(scope, operation, work) {
    const cached = store.operation(scope, operation.key, operation.fingerprint);
    if (cached) return cached;
    if (!operation.key) return work();
    const key = scope + ':' + operation.key;
    const inflight = pending.get(key);
    if (inflight) {
      if (inflight.fingerprint !== operation.fingerprint)
        throw fault(409, 'This submission is already processing different details.');
      return inflight.promise;
    }
    const promise = Promise.resolve().then(
      () => store.operation(scope, operation.key, operation.fingerprint) || work(),
    );
    pending.set(key, { fingerprint: operation.fingerprint, promise });
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  }
  async function retain(item) {
    try {
      return await memory.remember(item);
    } catch (error) {
      console.warn('Memory retention deferred:', error.message);
      return 'pending';
    }
  }
  const services = { store, delivery, companies, connector, auth, memory, providerActions, embedding, vectors, memoryPool, vectorIndex, dataSources, knowledgeImport, followThrough, reuse, learning, troubleshooting, privacy, systemHealth, config, limit, once, retain };
  const routes = {
    public: [createPublicRoutes(services)],
    company: [createCompanyRoutes(services)],
    customer: [createCustomerRoutes(services)],
    actions: [createActionRoutes(services)],
  };
  const handler = async (req, res) => {
    const requestId = randomUUID();
    const write = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-ID': requestId,
        ...headers,
        ...(data.retryAfter && { 'Retry-After': String(data.retryAfter) }),
      });
      res.end(JSON.stringify(data));
      return true;
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const endpoint = req.method + ' ' + url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site')
          throw fault(403, 'Cross-site submissions are not allowed.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          throw fault(403, 'Submit this request from the app.');
      }
      // The Interactive Learning Demo is fully isolated: it is answered before any session,
      // company, database or integration code runs, and never receives the store.
      if (isDemoPath(url.pathname)) {
        await handleDemo(req, url, write);
        return;
      }
      const session = auth.authenticate(req);
      const context = { req, res, url, endpoint, write, requestId, session };
      auth.csrf(req, session);
      if (await auth.handle(req, endpoint, write, session)) return;
      for (const route of routes.public) if (await route(context)) return;
      if (!session) throw fault(401, 'Sign in to your Continuum account to continue.');
      limit(session.token_hash, 120);
      const { profile } = session;
      const selectedBot = getBot(store.db, profile.companyId, botId(profile));
      Object.assign(context, { profile, selectedBot });
      if (!selectedBot.active && !(profile.role === 'owner' && url.pathname.startsWith('/api/company')))
        throw fault(403, 'This service is inactive. Select another workspace.');
      if (req.headers['x-workspace'] && req.headers['x-workspace'] !== profile.companyId + '|' + botId(profile))
        throw fault(409, 'Your workspace changed. Reload before submitting.');
      const customerRoutes = new Set([
        '/api/workspace', '/api/status', '/api/analytics', '/api/conversation',
        '/api/conversation/archive', '/api/feedback', '/api/slots', '/api/memory',
        '/api/reflect', '/api/chat', '/api/request', '/api/requirement', '/api/book',
        '/api/cancel', '/api/book/cancel', '/api/handoff', '/api/outcome', '/api/resolutions/confirm',
        '/api/resolutions/defer', '/api/troubleshooting/choose', '/api/resolutions/outcome', '/api/connector/sync', '/api/troubleshooting/outcome', '/api/privacy/export', '/api/privacy/erase',
      ]);
      if (['owner', 'staff'].includes(profile.role) && customerRoutes.has(url.pathname))
        throw fault(403, 'Customer accounts handle personal requests and confirmations. Use the company dashboard or specialist console.');
      if (endpoint.includes('/connector')) {
        limit(session.token_hash + ':connector', 10);
        if (await connector.handle(req, endpoint, session, write)) return;
      }
      if (endpoint.includes('/api/company/shadow')) {
        limit(session.token_hash + ':shadow', 30);
        if (await shadow.handle(req, endpoint, session, write, { json })) return;
      }
      if (endpoint.includes('/api/company/knowledge-lifecycle')) {
        limit(session.token_hash + ':lifecycle', 60);
        if (await dataSources.lifecycle.handle(req, endpoint, session, write, { json })) return;
      }
      if (endpoint.includes('/api/company/data-sources')) {
        limit(session.token_hash + ':datasource', 30);
        if (await dataSources.handle(req, endpoint, session, write)) return;
      }
      if (endpoint.includes('/api/company/knowledge-import')) {
        limit(session.token_hash + ':knowledge-import', 20);
        if (await knowledgeImport.handle(req, endpoint, session, write)) return;
      }
      if (await companies.handle(req, endpoint, session, write)) return;
      const staff = companies.staff(profile);
      context.staff = staff;
      for (const route of routes.company) if (await route(context)) return;
      const db = provider(store, profile);
      profile.ticketId ||= db.list()[0]?.id || null;
      if (await delivery.handle(req, endpoint, session, auth, write)) return;
      const requested = url.searchParams.get('ticketId') || profile.ticketId;
      const integration = {
        hindsight: memory.configured,
        model: Boolean(config.OPENAI_API_KEY),
        mode: profile.demo ? 'demo' : 'standard',
      };
      Object.assign(context, { db, requested, integration });
      for (const route of routes.customer) if (await route(context)) return;
      for (const route of routes.actions) if (await route(context)) return;
      throw fault(404, 'API route not found.');
    } catch (e) {
      if (!e.status) console.error('Request failed', requestId, e.message);
      if (!res.headersSent)
        write(e.status || 500, {
          error: e.status ? e.message : 'We couldn’t complete that request. Please try again.',
          code:
            e.status === 409
              ? 'CONFLICT'
              : e.status === 429
                ? 'RATE_LIMITED'
                : e.status === 401
                  ? 'SESSION_EXPIRED'
                  : 'REQUEST_FAILED',
          requestId,
          ...(e.retryAfter && { retryAfter: e.retryAfter }),
        });
    }
  };
  handler.store = store;
  handler.memory = memory;
  handler.memoryPool = memoryPool;
  handler.vectorIndex = vectorIndex;
  handler.vectors = vectors;
  handler.embedding = embedding;
  handler.dataSources = dataSources;
  handler.shadow = shadow;
  handler.privacy = privacy;
  handler.followThrough = followThrough;
  handler.troubleshooting = troubleshooting;
  handler.delivery = delivery;
  handler.providerActions = providerActions;
  handler.close = () => {
    memory.close?.();
    providerActions.close();
    delivery.close();
    store.close();
  };
  return handler;
}
export function createApi(options) {
  const handler = createHandler(options);
  const server = createServer(handler);
  server.on('close', handler.close);
  return server;
}
