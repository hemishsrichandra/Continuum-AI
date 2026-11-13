import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { field, json } from './requests.js';
import { fault } from './providers.js';
import { ensureBots, botId, getBot, validateBot, normalizeBot } from './chatbots.js';
import { syncPlaybooks } from './passports.js';

export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
export function createCompanies(store, config) {
  const sql = store.db;
  function registration(body, email) {
    if (body.invitation) {
      const hash = tokenHash(field(body.invitation, 'invitation', 200));
      const invite = sql
        .prepare('SELECT * FROM invitations WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
        .get(hash, Date.now());
      if (!invite || invite.email !== email)
        throw fault(400, 'This invitation is invalid, expired, or belongs to another email address.');
      const consumed = sql
        .prepare(
          'UPDATE invitations SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?',
        )
        .run(Date.now(), hash, Date.now());
      if (!consumed.changes) throw fault(409, 'This invitation was already used.');
      return { companyId: invite.company_id, role: invite.role, provider: invite.provider };
    }
    if (body.companyCode) {
      const company = sql
        .prepare('SELECT id FROM companies WHERE join_hash=?')
        .get(tokenHash(field(body.companyCode, 'company code', 200)));
      if (!company)
        throw fault(400, 'Company code was not found. Ask your service provider for a registration link.');
      return { companyId: company.id, role: 'customer', provider: body.provider };
    }
    if (body.createCompany !== true)
      throw fault(400, 'Use your company registration link, an invitation, or choose Create a company.');
    const companyId = randomUUID(),
      name = field(body.companyName, 'company name', 100);
    sql.prepare('INSERT INTO companies VALUES(?,?,NULL,?)').run(companyId, name, Date.now());
    ensureBots(sql, companyId);
    return { companyId, role: 'owner', provider: body.provider };
  }
  function staff(profile) {
    if (!profile || profile.demo) return null;
    const account = sql
      .prepare("SELECT account_id AS id,company_id,role,provider FROM company_memberships WHERE account_id=? AND company_id=? AND status='active'")
      .get(profile.id, profile.companyId);
    if (!account || !['owner', 'staff'].includes(account.role)) return null;
    return {
      id: account.id,
      provider: profile.provider,
      chatbotId: botId(profile),
      companyId: account.company_id,
      role: account.role,
    };
  }
  /**
   * May this membership use this service? Owners always; staff only for services of their adapter and,
   * when the owner has restricted them to specific services, only those. No restriction rows = every
   * service of their adapter (the behaviour before per-service access existed).
   */
  function mayUseBot(member, bot) {
    const role = member.role;
    if (role === 'owner') return true;
    if (role !== 'staff') return true;
    const provider = member.provider;
    if (bot.adapter !== provider) return false;
    const companyId = member.company_id || member.companyId, accountId = member.account_id || member.id;
    const rows = sql.prepare('SELECT chatbot_id FROM staff_chatbot_access WHERE company_id=? AND account_id=?').all(companyId, accountId);
    return !rows.length || rows.some((r) => r.chatbot_id === bot.id);
  }
  function roster(operator) {
    return sql
      .prepare(
        "SELECT a.id,a.name,m.provider,m.role FROM accounts a JOIN company_memberships m ON a.id=m.account_id WHERE m.company_id=? AND m.status='active' AND m.role IN ('owner','staff') ORDER BY name",
      )
      .all(operator.companyId)
      .filter(
        (a) =>
          a.role === 'owner' ||
          (a.provider === operator.provider &&
            // Staff restricted to other services cannot be assigned to this one.
            mayUseBot({ role: 'staff', provider: a.provider, company_id: operator.companyId, account_id: a.id }, { id: operator.chatbotId, adapter: operator.provider })),
      );
  }
  async function handle(req, endpoint, session, send) {
    if (!endpoint.includes('/api/company')) return false;
    if (!session?.account_id || session.profile.role !== 'owner')
      throw fault(403, 'Only a company owner can manage the team.');
    const companyId = session.profile.companyId;
    if (endpoint === 'GET /api/company/chatbots') {
      send(200, { chatbots: sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(companyId).map(r=>normalizeBot(JSON.parse(r.config))) });
      return true;
    }
    if (endpoint === 'POST /api/company/chatbots') {
      const body = await json(req);
      const previous = body.id ? getBot(sql,companyId,body.id) : null;
      const b = validateBot({...body,id:previous?.id || randomUUID()},companyId,previous);
      sql.transaction(()=>{
        sql.prepare('INSERT INTO chatbots VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(b.id,companyId,b.adapter,JSON.stringify(b));
        syncPlaybooks(sql,b);
        store.update(data=>data.audit.push({id:randomUUID(),scope:`company:${companyId}`,kind:'chatbot_config',chatbotId:b.id,authorId:session.account_id,revision:b.revision,createdAt:new Date().toISOString()}));
      }).immediate();
      send(200,{chatbot:b}); return true;
    }
    if (endpoint === 'GET /api/company/staff-access') {
      const bots = sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(companyId).map((r) => normalizeBot(JSON.parse(r.config)));
      send(200, {
        chatbots: bots.map((b) => ({ id: b.id, name: b.name, adapter: b.adapter, active: b.active })),
        staff: sql.prepare("SELECT a.id,a.name,a.email,m.provider FROM accounts a JOIN company_memberships m ON m.account_id=a.id WHERE m.company_id=? AND m.role='staff' AND m.status='active' ORDER BY a.name").all(companyId).map((a) => {
          const rows = sql.prepare('SELECT chatbot_id FROM staff_chatbot_access WHERE company_id=? AND account_id=?').all(companyId, a.id);
          return { ...a, chatbotIds: rows.length ? rows.map((r) => r.chatbot_id) : null };
        }),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/staff-access') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm changing this specialist’s service access.');
      const member = sql.prepare("SELECT m.*,a.name FROM company_memberships m JOIN accounts a ON a.id=m.account_id WHERE m.company_id=? AND m.account_id=? AND m.role='staff' AND m.status='active'").get(companyId, field(body.accountId, 'account', 100));
      if (!member) throw fault(404, 'Specialist not found in this company.');
      let ids = null;
      if (body.chatbotIds !== null) {
        if (!Array.isArray(body.chatbotIds) || !body.chatbotIds.length || body.chatbotIds.length > 50 || body.chatbotIds.some((x) => typeof x !== 'string'))
          throw fault(400, 'Choose at least one service, or send null to allow every service of their adapter.');
        ids = [...new Set(body.chatbotIds)];
        for (const id of ids) {
          const bot = getBot(sql, companyId, id);
          if (bot.adapter !== member.provider) throw fault(400, 'A specialist can only be given services of their own adapter.');
        }
      }
      const released = [];
      sql.transaction(() => {
        sql.prepare('DELETE FROM staff_chatbot_access WHERE company_id=? AND account_id=?').run(companyId, member.account_id);
        for (const id of ids || []) sql.prepare('INSERT INTO staff_chatbot_access(company_id,account_id,chatbot_id,granted_by,created_at) VALUES(?,?,?,?,?)').run(companyId, member.account_id, id, session.account_id, new Date().toISOString());
        // Work they hold in a service they can no longer reach goes back to the queue for the owner.
        store.update((data) => {
          for (const h of data.handoffs) {
            if (h.companyId !== companyId || h.assignedTo !== member.account_id || ['Resolved', 'Closed'].includes(h.status)) continue;
            if (ids && ids.includes(h.chatbotId)) continue;
            h.assignedTo = null;
            if (h.status !== 'Awaiting confirmation') h.status = 'Queued';
            h.revision = (h.revision || 0) + 1;
            released.push(h.id);
          }
          data.audit.push({ id: randomUUID(), scope: `company:${companyId}`, kind: 'staff_service_access_changed', accountId: member.account_id, authorId: session.account_id, chatbotIds: ids, releasedCases: released.length, createdAt: new Date().toISOString() });
        });
      }).immediate();
      send(200, { success: true, chatbotIds: ids, releasedCases: released.length });
      return true;
    }
    if (endpoint === 'POST /api/company/revoke-membership') {
      const body = await json(req);
      if (body.confirmed !== true || body.id === session.account_id) throw fault(400,'Confirm revoking another member.');
      sql.transaction(()=>{
        const result = sql.prepare("UPDATE company_memberships SET status='revoked' WHERE company_id=? AND account_id=? AND role<>'owner'").run(companyId,body.id);
        if (!result.changes) throw fault(404,'Member not found or owner cannot be revoked.');
        store.update(data=>{
          data.audit.push({id:randomUUID(),scope:`company:${companyId}`,kind:'membership_revoked',accountId:body.id,authorId:session.account_id,createdAt:new Date().toISOString()});
          for(const h of data.handoffs) if(h.companyId===companyId && h.assignedTo===body.id && !['Resolved','Closed'].includes(h.status)) {
            h.assignedTo=null;h.revision=(h.revision||0)+1;
            if(h.status!=='Awaiting confirmation') h.status='Queued';
            const row=data[h.provider]?.find(r=>r.companyId===companyId && r.chatbotId===h.chatbotId && (r.ticket_id||r.id)===h.ticketId);
            if(row) row[h.provider==='it'?'owner':'assigned_to']=h.provider==='it'?'IT service desk':'Device repair team';
          }
        });
      }).immediate();
      send(200,{success:true});return true;
    }
    if (endpoint === 'POST /api/company/reinstate-membership') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm bringing this member back.');
      const id = field(body.id, 'account', 100);
      const member = sql.prepare("SELECT role FROM company_memberships WHERE company_id=? AND account_id=? AND status='revoked' AND role<>'owner'").get(companyId, id);
      if (!member) throw fault(404, 'No revoked member found with that account.');
      // Coming back is never an upgrade: a customer stays a customer, and a former specialist may return as either.
      const role = body.role === undefined ? 'customer' : body.role;
      if (!['customer', 'staff'].includes(role) || (role === 'staff' && member.role !== 'staff'))
        throw fault(400, 'A member can return as a customer, or as a specialist only if they were one before.');
      sql.transaction(() => {
        sql.prepare("UPDATE company_memberships SET status='active', role=? WHERE company_id=? AND account_id=? AND status='revoked'").run(role, companyId, id);
        store.update((data) => data.audit.push({ id: randomUUID(), scope: `company:${companyId}`, kind: 'membership_reinstated', accountId: id, role, authorId: session.account_id, createdAt: new Date().toISOString() }));
      }).immediate();
      send(200, { success: true, role });
      return true;
    }
    if (endpoint === 'POST /api/company/invitations/resend') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm sending a new invitation. The previous link stops working.');
      const email = field(body.email, 'email', 254).toLowerCase();
      const previous = sql.prepare('SELECT role,provider FROM invitations WHERE company_id=? AND email=? AND consumed_at IS NULL ORDER BY expires_at DESC LIMIT 1').get(companyId, email);
      if (!previous) throw fault(404, 'There is no unused invitation for that email address. Create a new one instead.');
      const token = secret(), now = Date.now(), expiresAt = now + 48 * 3600000;
      sql.transaction(() => {
        // Only one live link per person: the old one is removed the moment the new one exists.
        sql.prepare('DELETE FROM invitations WHERE company_id=? AND email=? AND consumed_at IS NULL').run(companyId, email);
        sql.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,NULL)').run(tokenHash(token), companyId, email, previous.provider, previous.role, expiresAt);
        store.update((data) => data.audit.push({ id: randomUUID(), scope: `company:${companyId}`, kind: 'invitation_resent', email, authorId: session.account_id, createdAt: new Date().toISOString() }));
      }).immediate();
      send(201, { url: config.APP_URL + '/desk#invite=' + token, expiresAt });
      return true;
    }
    if (endpoint === 'GET /api/company') {
      send(200, {
        company: sql.prepare('SELECT id,name FROM companies WHERE id=?').get(companyId),
        members: sql
          .prepare('SELECT a.id,a.name,a.email,m.role,m.provider,m.status FROM accounts a JOIN company_memberships m ON m.account_id=a.id WHERE m.company_id=? ORDER BY a.name')
          .all(companyId),
        invitations: sql
          .prepare(
            'SELECT email,role,provider,expires_at,consumed_at FROM invitations WHERE company_id=? ORDER BY expires_at DESC LIMIT 50',
          )
          .all(companyId),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/customer-code') {
      const body = await json(req);
      if (body.confirmed !== true)
        throw fault(
          400,
          'Confirm generating a new customer signup link. Existing signup links will stop working.',
        );
      const code = secret();
      sql.prepare('UPDATE companies SET join_hash=? WHERE id=?').run(tokenHash(code), companyId);
      send(200, { code, url: config.APP_URL + '/desk#company=' + code });
      return true;
    }
    if (endpoint === 'POST /api/company/invitations') {
      const body = await json(req),
        email = field(body.email, 'email', 254).toLowerCase();
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !['staff', 'customer'].includes(body.role) ||
        !['repair', 'it'].includes(body.provider)
      )
        throw fault(400, 'Choose a valid email, role, and schema adapter.');
      const token = secret(),
        expiresAt = Date.now() + 48 * 3600000;
      sql
        .prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,NULL)')
        .run(tokenHash(token), companyId, email, body.provider, body.role, expiresAt);
      send(201, { url: config.APP_URL + '/desk#invite=' + token, expiresAt });
      return true;
    }
    if (endpoint === 'POST /api/company/revoke-staff') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm removing specialist access.');
      sql
        .transaction(() => {
          const result = sql
            .prepare("UPDATE company_memberships SET role='customer' WHERE account_id=? AND company_id=? AND role='staff'")
            .run(field(body.id, 'staff account', 100), companyId);
          if (!result.changes) throw fault(404, 'Staff account not found.');
          store.update((data) => {
            data.audit.push({id:randomUUID(),scope:`company:${companyId}`,kind:'staff_access_removed',accountId:body.id,authorId:session.account_id,createdAt:new Date().toISOString()});
            for (const h of data.handoffs) {
              if (h.companyId !== companyId || h.assignedTo !== body.id ||
                  ['Resolved', 'Closed'].includes(h.status)) continue;
              h.assignedTo = null;
              const row = data[h.provider]?.find((r) =>
                r.companyId === companyId && (r.ticket_id || r.id) === h.ticketId);
              if (row) row[h.provider === 'it' ? 'owner' : 'assigned_to'] =
                h.provider === 'it' ? 'IT service desk' : 'Device repair team';
              data.audit.push({
                id: randomUUID(), scope: h.scope, ticketId: h.ticketId,
                kind: 'assignment', createdAt: new Date().toISOString(),
                note: 'Specialist access was removed. Assignment released for owner review.',
              });
              if (h.status !== 'Awaiting confirmation') h.status = 'Queued';
              h.revision = (h.revision || 0) + 1;
            }
          });
          sql.prepare('DELETE FROM staff_access WHERE account_id=?').run(body.id);

        })
        .immediate();
      send(200, { success: true });
      return true;
    }
    return false;
  }
  return { registration, staff, roster, handle, mayUseBot };
}
