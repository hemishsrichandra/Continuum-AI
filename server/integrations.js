import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fault } from './providers.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const googleApi = 'https://www.googleapis.com/calendar/v3';
export function createIntegrations(store, config) {
  const sql = store.db;
  const emailConfigured = Boolean(config.RESEND_API_KEY && config.EMAIL_FROM);
  const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.APP_URL);
  let key, timer, running = false, stopped = true;
  const workerId = randomUUID();
  function encryptionKey() {
    if (key) return key;
    if (config.INTEGRATION_ENCRYPTION_KEY) key = Buffer.from(config.INTEGRATION_ENCRYPTION_KEY, 'base64');
    else {
      if (config.NODE_ENV === 'production') throw fault(503, 'Integration encryption needs server configuration.');
      const path = store.file === ':memory:' ? null : store.file + '.key';
      if (path && existsSync(path)) key = readFileSync(path);
      else { key = randomBytes(32); if (path) { try { writeFileSync(path, key, { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') key = readFileSync(path); else throw e; } } }
    }
    if (key.length !== 32) throw fault(503, 'Integration encryption needs a valid 32-byte key.');
    return key;
  }
  function seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
  }
  function unseal(value, context) {
    const [iv, tag, data] = value.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
  }
  async function remote(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) }); }
    catch { throw fault(503, 'The external service could not be reached.'); }
    if (!response.ok) throw Object.assign(fault(503, 'The external service returned HTTP ' + response.status + '.'), { remoteStatus: response.status });
    return response.status === 204 ? {} : response.json();
  }
  function queue(job) {
    const item = { ...job, payload: seal(job.payload, job.id), status: 'pending', attempts: 0, nextAttemptAt: Date.now(), createdAt: new Date().toISOString() };
    store.update((data) => { if (!data.outbox.some((j) => j.id === item.id)) data.outbox.push(item); });
    kick(); return item.id;
  }
  function queueEmail({ id, scope, to, subject, text, expiresAt, bookingId, bookingSource, cancellation }) {
    if (!emailConfigured) return null;
    return queue({ id, scope, type: 'email', expiresAt, bookingId, bookingSource, cancellation, payload: { to, subject, text } });
  }
  async function accessToken(accountId) {
    const row = sql.prepare('SELECT * FROM connections WHERE account_id=?').get(accountId);
    if (!row) throw fault(409, 'Connect your Google Calendar first.');
    const stored = unseal(row.encrypted_token, accountId);
    const fresh = await remote('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, refresh_token: stored.refreshToken, grant_type: 'refresh_token' }).toString() });
    if (!fresh.access_token) throw fault(503, 'Google Calendar needs to be reconnected.');
    return { token: fresh.access_token, calendarId: row.calendar_id };
  }
  const eventId = (accountId, bookingId) => digest(accountId + ':' + bookingId);
  async function calendarRequest(accountId, method, route, body) {
    const { token, calendarId } = await accessToken(accountId);
    return remote(googleApi + '/calendars/' + encodeURIComponent(calendarId) + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
  }
  async function available(accountId, slots) {
    if (!accountId || !sql.prepare('SELECT 1 FROM connections WHERE account_id=?').get(accountId) || !slots.length) return slots;
    const start = new Date(slots[0].id).toISOString(), end = new Date(new Date(slots.at(-1).id).getTime() + 1800000).toISOString();
    const { token, calendarId } = await accessToken(accountId);
    const response = await remote(googleApi + '/freeBusy', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMin: start, timeMax: end, timeZone: 'Asia/Kolkata', items: [{ id: calendarId }] }) });
    const calendars = response.calendars || {};
    const calendar = calendars[calendarId] || (Object.keys(calendars).length === 1 ? Object.values(calendars)[0] : null);
    if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw fault(503, 'Google Calendar availability could not be confirmed. Please retry before booking.');
    const intervals = calendar.busy.map((busy) => ({ start: +new Date(busy.start), end: +new Date(busy.end) }));
    if (intervals.some((busy) => !Number.isFinite(busy.start) || !Number.isFinite(busy.end) || busy.end < busy.start)) throw fault(503, 'Google Calendar returned invalid availability. Please retry.');
    return slots.filter((slot) => !intervals.some((busy) => busy.start < +new Date(slot.id) + 1800000 && busy.end > +new Date(slot.id)));
  }
  function queueBooking(account, booking, cancel = false, source = 'service') {
    const scope = account ? 'account:' + account.id : 'reservation:' + booking.id;
    const time = new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(booking.datetime));
    // Only verified account addresses receive service notifications. Public session forms explicitly request a receipt.
    const recipient = source === 'session' ? booking.email : account?.email_verified ? account.email : null;
    if (recipient) queueEmail({ id: `${source}-${booking.id}-${cancel ? 'cancel' : 'book'}-email`, scope, to: recipient, bookingId: booking.id, bookingSource: source, cancellation: cancel, subject: cancel ? 'Your Continuum appointment was cancelled' : 'Your Continuum appointment is reserved', text: `${cancel ? 'Cancelled' : 'Reserved'}: ${time} IST\nDuration: 30 minutes\nReference: ${booking.id}\n\n${source === 'session' ? 'Your session reservation is recorded in Continuum.' : 'You can manage this visit in your Continuum workspace.'}` });
    if (account && sql.prepare('SELECT 1 FROM connections WHERE account_id=?').get(account.id)) queue({ id: `${source}-${booking.id}-${cancel ? 'cancel' : 'book'}-calendar`, type: cancel ? 'calendar-delete' : 'calendar-create', scope, payload: { accountId: account.id, bookingId: booking.id, datetime: booking.datetime, source } });
  }
  async function perform(job) {
    const payload = unseal(job.payload, job.id);
    if (job.type === 'email') {
      if (job.bookingId && !job.cancellation && store.data[job.bookingSource === 'session' ? 'demoBookings' : 'bookings'].find((b) => b.id === job.bookingId)?.cancelledAt) return { skipped: true };
      if (job.id.startsWith('auth-') && !sql.prepare('SELECT 1 FROM auth_tokens WHERE token_hash=? AND expires_at>?').get(job.id.slice(5), Date.now())) return { skipped: true };
      if (!emailConfigured) throw fault(503, 'Email delivery needs server configuration.');
      if (+new Date(job.createdAt) < Date.now() - 23 * 3600000) throw fault(422, 'Delivery needs manual review after the provider retry window.');
      const sent = await remote('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + config.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': job.id }, body: JSON.stringify({ from: config.EMAIL_FROM, to: [payload.to], subject: payload.subject, text: payload.text }) });
      if (!sent.id) throw fault(503, 'Email provider did not acknowledge delivery.');
      return { providerId: sent.id };
    }
    const id = eventId(payload.accountId, payload.bookingId);
    if (job.type === 'calendar-delete') {
      try {
        const existing = await calendarRequest(payload.accountId, 'GET', '/events/' + id);
        if (existing.extendedProperties?.private?.continuumBookingId !== payload.bookingId) return { skipped: true };
        await calendarRequest(payload.accountId, 'DELETE', '/events/' + id + '?sendUpdates=none');
      }
      catch (e) { if (![404, 410].includes(e.remoteStatus)) throw e; }
      return { providerId: id };
    }
    const latest = store.data[payload.source === 'session' ? 'demoBookings' : 'bookings'].find((b) => b.id === payload.bookingId);
    if (!latest || latest.cancelledAt) return { skipped: true };
    const event = { id, summary: payload.source === 'session' ? 'Continuum session' : 'Continuum service visit', description: 'Manage this appointment in Continuum.', start: { dateTime: payload.datetime, timeZone: 'Asia/Kolkata' }, end: { dateTime: new Date(+new Date(payload.datetime) + 1800000).toISOString(), timeZone: 'Asia/Kolkata' }, extendedProperties: { private: { continuumBookingId: payload.bookingId } } };
    try { await calendarRequest(payload.accountId, 'POST', '/events?sendUpdates=none', event); }
    catch (e) {
      if (e.remoteStatus !== 409) throw e;
      const found = await calendarRequest(payload.accountId, 'GET', '/events/' + id);
      if (found.extendedProperties?.private?.continuumBookingId !== payload.bookingId) throw fault(409, 'Calendar event conflicts with this appointment.');
    }
    return { providerId: id };
  }
  // Additional periodic work (e.g. follow-through deadlines) runs on this same
  // worker tick, never per web request.
  const tickTasks = [];
  function register(task) { tickTasks.push(task); }
  async function flush() {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      for (const task of tickTasks) {
        try { await task(); } catch (e) { console.warn('Worker task failed:', e.message); }
      }
      for (let count = 0; count < 10; count++) {
        const job = store.update((data) => {
          const next = data.outbox.find((j) => {
            const eligible = j.status === 'pending' && j.nextAttemptAt <= Date.now() || j.status === 'processing' && j.leaseUntil < Date.now();
            if (!eligible) return false;
            if (j.id.includes('-cancel-')) {
              const creation = data.outbox.find((item) => item.id === j.id.replace('-cancel-', '-book-'));
              if (creation && !['delivered', 'skipped', 'failed'].includes(creation.status)) return false;
            }
            return true;
          });
          if (!next) return null;
          next.status = 'processing'; next.leaseUntil = Date.now() + 60000; next.worker = workerId; next.attempts++;
          return structuredClone(next);
        });
        if (!job) break;
        try {
          if (job.expiresAt && job.expiresAt <= Date.now()) throw fault(422, 'This private link expired before delivery. Request a new email.');
          const result = await perform(job);
          store.update((data) => { const entry = data.outbox.find((j) => j.id === job.id); if (entry.worker === workerId) Object.assign(entry, { status: result.skipped ? 'skipped' : 'delivered', providerId: result.providerId || null, deliveredAt: new Date().toISOString(), lastError: null, payload: null }); });
        } catch (e) {
          store.update((data) => { const entry = data.outbox.find((j) => j.id === job.id); if (entry.worker === workerId) Object.assign(entry, { status: job.attempts >= 8 || [409, 422].includes(e.status) || [400, 401, 403, 404, 422].includes(e.remoteStatus) ? 'failed' : 'pending', nextAttemptAt: Date.now() + Math.min(3600000, 30000 * 2 ** (job.attempts - 1)), lastError: e.status ? e.message : 'Delivery could not complete. Please reconnect or retry.' }); });
        }
      }
    }).finally(() => { running = false; });
    return running;
  }
  function kick() { if (!stopped) setTimeout(() => flush().catch(() => {}), 0).unref(); }
  function start() { stopped = false; timer = setInterval(() => flush().catch(() => {}), 10000); timer.unref(); kick(); }
  function close() { stopped = true; clearInterval(timer); }
  function status(accountId) {
    const connected = accountId && sql.prepare('SELECT connected_at FROM connections WHERE account_id=?').get(accountId);
    return { email: { configured: emailConfigured }, google: { configured: googleConfigured, connected: Boolean(connected), connectedAt: connected?.connected_at || null }, deliveries: accountId ? store.data.outbox.filter((j) => j.scope === 'account:' + accountId).slice(-20).reverse().map(({ id, type, status, attempts, lastError, createdAt }) => ({ id, type, status, attempts, lastError, createdAt })) : [] };
  }
  async function handle(req, endpoint, session, auth, send) {
    if (!endpoint.includes('/api/integrations/')) return false;
    if (!session?.account_id) throw fault(403, 'Sign in with a personal account to manage integrations.');
    const accountId = session.account_id;
    if (endpoint === 'GET /api/integrations/status') { send(200, status(accountId)); return true; }
    if (endpoint === 'POST /api/integrations/google/connect') {
      if (!googleConfigured) throw fault(503, 'Google Calendar needs server setup. Ask the site owner to configure it.');
      encryptionKey();
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      sql.prepare('DELETE FROM oauth_states WHERE expires_at<=?').run(Date.now());
      sql.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?)').run(digest(state), accountId, session.token_hash, verifier, Date.now() + 600000);
      const params = new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, redirect_uri: config.APP_URL.replace(/\/+$/, '') + '/api/integrations/google/callback', response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      send(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params }); return true;
    }
    if (endpoint === 'GET /api/integrations/google/callback') {
      const params = new URL(req.url, 'http://localhost').searchParams, supplied = params.get('state');
      if (!supplied) throw fault(400, 'Google consent could not be verified. Try connecting again.');
      const state = sql.prepare('DELETE FROM oauth_states WHERE state_hash=? AND account_id=? AND session_hash=? AND expires_at>? RETURNING *').get(digest(supplied), accountId, session.token_hash, Date.now());
      if (!state) throw fault(400, 'Google consent expired or belongs to another session. Try connecting again.');
      if (params.has('error') || !params.get('code')) { send(303, {}, { Location: '/desk?calendar=cancelled' }); return true; }
      const tokens = await remote('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: params.get('code'), client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: config.APP_URL.replace(/\/+$/, '') + '/api/integrations/google/callback', grant_type: 'authorization_code', code_verifier: state.verifier }).toString() });
      if (!tokens.refresh_token) throw fault(503, 'Google did not grant offline access. Reconnect and allow calendar access.');
      sql.prepare("INSERT INTO connections VALUES(?,?,'primary',?) ON CONFLICT(account_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,connected_at=excluded.connected_at").run(accountId, seal({ refreshToken: tokens.refresh_token }, accountId), Date.now());
      send(303, {}, { Location: '/desk?calendar=connected' }); return true;
    }
    if (endpoint === 'DELETE /api/integrations/google') {
      const row = sql.prepare('SELECT encrypted_token FROM connections WHERE account_id=?').get(accountId); let revoked = true;
      if (row) {
        const { refreshToken } = unseal(row.encrypted_token, accountId);
        try { const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString() }); revoked = response.ok || response.status === 400; } catch { revoked = false; }
        sql.prepare('DELETE FROM connections WHERE account_id=?').run(accountId);
      }
      send(200, { success: true, message: revoked ? 'Google Calendar disconnected.' : 'Disconnected locally. Remove Continuum access in your Google account to revoke it remotely.' }); return true;
    }
    if (endpoint === 'POST /api/integrations/retry') {
      auth.rate('delivery-retry:' + accountId, 3);
      store.update((data) => { for (const job of data.outbox) if (job.scope === 'account:' + accountId && job.status === 'failed' && job.payload && (!job.expiresAt || job.expiresAt > Date.now()) && +new Date(job.createdAt) > Date.now() - 23 * 3600000) { job.status = 'pending'; job.attempts = 0; job.nextAttemptAt = Date.now(); } });
      kick(); send(200, { message: 'Eligible deliveries have been queued for another attempt.' }); return true;
    }
    return false;
  }
  if (emailConfigured || googleConfigured) encryptionKey();
  return { register, emailConfigured, googleConfigured, queueEmail, queueBooking, available, flush, start, close, status, handle, seal, unseal };
}
