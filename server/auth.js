import { ensureBots, defaultBotId, getBot, normalizeBot } from './chatbots.js';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fault, profiles } from './providers.js';
import { field, json } from './requests.js';

const scrypt = promisify(scryptCallback);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const passwordOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
let hashing = 0;
async function derive(password, salt) {
  if (hashing >= 2) throw fault(503, 'Sign-in is busy. Please try again in a moment.');
  hashing++;
  try {
    return await scrypt(password, salt, 64, passwordOptions);
  } finally {
    hashing--;
  }
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 128)
    throw fault(400, 'Use a password between 15 and 128 characters. Spaces and passphrases are welcome.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:131072:8:1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const parts = (encoded || '').split(':');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const salt = valid ? parts[4] : '00000000000000000000000000000000';
  const actual = await derive(typeof password === 'string' ? password.slice(0, 128) : '', salt);
  const expected = valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64);
  return actual.length === expected.length && timingSafeEqual(actual, expected) && valid;
}
export function emailAddress(value) {
  const email = field(value, 'email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fault(400, 'Enter a valid email address.');
  return email;
}
export function createAuth(store, config, delivery, companies) {
  const sql = store.db;
  const secure = config.NODE_ENV === 'production' || config.COOKIE_SECURE === 'true';
  const cookieName = secure ? '__Host-continuum' : 'continuum_session';
  const demoEnabled = config.ENABLE_DEMO_MODE === 'true' && config.NODE_ENV !== 'production';
  const verificationRequired =
    config.NODE_ENV === 'production' || config.REQUIRE_EMAIL_VERIFICATION === 'true';
  const lifetime = 7 * 86400000;
  const cookie = (token, clear = false) =>
    `${cookieName}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : lifetime / 1000}${secure ? '; Secure' : ''}`;
  function rate(key, maximum, window = 60000) {
    const now = Date.now();
    const bucket = sql
      .transaction(() => {
        sql.prepare('DELETE FROM rate_limits WHERE reset_at<=?').run(now);
        sql
          .prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET used=used+1')
          .run(key, now + window);
        return sql.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
      })
      .immediate();
    if (bucket.used > maximum)
      throw Object.assign(fault(429, 'Too many attempts. Please wait before trying again.'), {
        retryAfter: Math.max(1, Math.ceil((bucket.reset_at - now) / 1000)),
      });
  }
  function profileFor(account, companyId, chatbotId, recover = false) {
    const memberships = sql.prepare("SELECT m.*,c.name AS company_name FROM company_memberships m JOIN companies c ON c.id=m.company_id WHERE account_id=? AND status='active' ORDER BY m.created_at,c.id").all(account.id);
    const membership = (companyId ? memberships.find(m => m.company_id === companyId) : memberships[0]) || (recover ? memberships[0] : null);
    if (!membership) {
      if(recover) return {id:account.id,name:account.name,email:account.email,verified:Boolean(account.email_verified),demo:false,companyId:null,chatbotId:null,role:null,memberships:[],initials:account.name.slice(0,2).toUpperCase()};
      throw fault(403, 'Your company membership is no longer active. Select an authorized workspace.');
    }
    ensureBots(sql, membership.company_id);
    let bot;
    try { bot = getBot(sql, membership.company_id, chatbotId || defaultBotId(membership.company_id, membership.provider)); } catch(e) { if(!recover) throw e; }
    if(recover && (!bot?.active || (membership.role === 'staff' && bot.adapter !== membership.provider))) bot=sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(membership.company_id).map(r=>JSON.parse(r.config)).find(b=>b.active && (membership.role !== 'staff' || b.adapter===membership.provider));
    if(!bot && (membership.role==='owner' || recover)) bot=getBot(sql,membership.company_id,defaultBotId(membership.company_id,membership.provider));
    if(!bot) throw fault(403,'No active service is available in this company.');
    if ((!bot.active && membership.role !== 'owner' && !recover) || (membership.role === 'staff' && bot.adapter !== membership.provider)) throw fault(403, 'This service is not available to your membership.');
    return {
      id: account.id,
      companyId: membership.company_id,
      companyName: membership.company_name,
      memberships: memberships.map(m => ({companyId:m.company_id, name:m.company_name,role:m.role})),
      chatbotId: bot.id, chatbotName: bot.name,
      role: membership.role,
      name: account.name,
      email: account.email,
      initials: account.name
        .split(/\s+/)
        .map((s) => s[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      provider: bot.adapter,
      label: bot.name,
      ticketId: null,
      verified: Boolean(account.email_verified),
      demo: false,
      prompt: 'What is the status of my service request?',
    };
  }
  function startSession(account, demoProfile) {
    const token = secret(),
      now = Date.now(),
      csrfToken = secret();
    sql.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    sql
      .prepare('INSERT INTO sessions(token_hash,account_id,demo_profile,csrf_token,expires_at,last_seen,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(
        hashToken(token),
        account?.id || null,
        demoProfile?.id || null,
        csrfToken,
        now + lifetime,
        now,
        now,
      );
    if (account) {
      const p = profileFor(account,undefined,undefined,true);
      sql.prepare('UPDATE sessions SET active_company_id=?,active_chatbot_id=? WHERE token_hash=?').run(p.companyId,p.chatbotId,hashToken(token));
    }
    return {
      token,
      csrfToken,
      profile: account ? profileFor(account,undefined,undefined,true) : { ...demoProfile, demo: true },
      expiresAt: new Date(now + lifetime).toISOString(),
    };
  }
  function authenticate(req) {
    const match = (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(cookieName + '='));
    const browserToken = match?.slice(cookieName.length + 1);
    const bearer = demoEnabled ? req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] : null;
    const token = browserToken || bearer;
    if (!token || token.length > 200) return null;
    const session = sql
      .prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?')
      .get(hashToken(token), Date.now());
    if (!session || (!browserToken && session.account_id)) return null;
    const account = session.account_id
      ? sql.prepare('SELECT * FROM accounts WHERE id=?').get(session.account_id)
      : null;
    const demo = demoEnabled && profiles.find((p) => p.id === session.demo_profile);
    if (!account && !demo) return null;
    if (Date.now() - session.last_seen > 60000)
      sql.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), session.token_hash);
    return {
      ...session,
      account,
      profile: account ? profileFor(account, session.active_company_id, session.active_chatbot_id, req.url.startsWith('/api/auth/')) : { ...demo, demo: true },
      cookie: Boolean(browserToken),
      csrfToken: session.csrf_token,
    };
  }
  function csrf(req, session) {
    if (session?.cookie && !['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.headers['x-csrf-token'];
      if (
        typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(session.csrfToken) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))
      )
        throw fault(403, 'Your form expired. Refresh the page and try again.');
    }
  }
  function actionToken(account, purpose) {
    const token = secret(),
      now = Date.now();
    sql.prepare('DELETE FROM auth_tokens WHERE expires_at<=?').run(now);
    sql
      .prepare('INSERT INTO auth_tokens VALUES(?,?,?,?,?)')
      .run(hashToken(token), account.id, purpose, now + (purpose === 'reset' ? 1800000 : 86400000), now);
    return token;
  }
  function queueLink(account, purpose) {
    const token = actionToken(account, purpose);
    const link = config.APP_URL.replace(/\/+$/, '') + '/desk#' + purpose + '=' + token;
    delivery.queueEmail({
      id: 'auth-' + hashToken(token),
      scope: 'account:' + account.id,
      to: account.email,
      subject: purpose === 'reset' ? 'Reset your Continuum password' : 'Verify your Continuum email',
      expiresAt: Date.now() + (purpose === 'reset' ? 1800000 : 86400000),
      text: `${purpose === 'reset' ? 'Reset your password' : 'Verify your email address'} using this private link:\n\n${link}\n\n${purpose === 'reset' ? 'This link expires in 30 minutes.' : 'This link expires in 24 hours.'} If you did not request this, you can ignore this email.`,
    });
  }
  const publicAccount = (session) => ({
    profile: session.profile,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expires_at).toISOString(),
  });
  async function handle(req, endpoint, send, session) {
    const ip = req.socket.remoteAddress;
    if (endpoint === 'GET /api/auth/config') {
      send(200, { demoEnabled, emailConfigured: delivery.emailConfigured, verificationRequired });
      return true;
    }
    if (endpoint === 'GET /api/auth/workspaces') {
      if (!session?.account_id) throw fault(401, 'Sign in to select a workspace.');
      const memberships = sql.prepare("SELECT m.company_id AS companyId,c.name,m.role FROM company_memberships m JOIN companies c ON c.id=m.company_id WHERE account_id=? AND status='active'").all(session.account_id);
      send(200, { memberships, companyId: session.profile.companyId, chatbotId: session.profile.chatbotId,
        chatbots: sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(session.profile.companyId).map(r=>normalizeBot(JSON.parse(r.config))).filter(b=>b.active && (session.profile.role !== 'staff' || b.adapter === session.profile.provider)) });
      return true;
    }
    if (endpoint === 'POST /api/auth/workspace') {
      if (!session?.account_id) throw fault(401, 'Sign in to select a workspace.');
      const body = await json(req);
      const profile = profileFor(session.account, field(body.companyId, 'company', 100), body.chatbotId);
      sql.prepare('UPDATE sessions SET active_company_id=?,active_chatbot_id=? WHERE token_hash=?').run(profile.companyId,profile.chatbotId,session.token_hash);
      send(200, {profile,csrfToken:session.csrfToken});
      return true;
    }
    if (endpoint === 'POST /api/auth/join') {
      if (!session?.account_id) throw fault(401, 'Sign in before joining another company.');
      const body = await json(req);
      const joined = sql.transaction(() => {
        if (!body.invitation && !body.companyCode) throw fault(400, 'Use a company signup code or invitation.');
        const m = companies.registration({...body,createCompany:false,provider:['repair','it'].includes(body.provider)?body.provider:'repair'},session.account.email);
        ensureBots(sql,m.companyId);
        const existing = sql.prepare('SELECT * FROM company_memberships WHERE company_id=? AND account_id=?').get(m.companyId,session.account_id);
        if (existing?.status === 'revoked' && !body.invitation) throw fault(403, 'This membership was revoked. Ask the company owner for a new invitation.');
        if(existing?.status === 'revoked' && body.invitation)
          sql.prepare("UPDATE company_memberships SET status='active',role=?,provider=? WHERE company_id=? AND account_id=?").run(m.role,m.provider,m.companyId,session.account_id);
        sql.prepare("INSERT INTO company_memberships VALUES(?,?,?,'active',?,?) ON CONFLICT(company_id,account_id) DO NOTHING").run(m.companyId,session.account_id,m.role,m.provider,Date.now());
        if(existing?.role==='customer' && body.invitation && m.role==='staff')
          sql.prepare("UPDATE company_memberships SET role='staff',provider=? WHERE company_id=? AND account_id=? AND status='active'").run(m.provider,m.companyId,session.account_id);
        store.update(data=>data.audit.push({id:randomUUID(),scope:`company:${m.companyId}`,kind:'membership_join',authorId:session.account_id,createdAt:new Date().toISOString()}));
        return m;
      }).immediate();
      send(200, {success:true,companyId:joined.companyId});
      return true;
    }
    if (endpoint === 'GET /api/auth/session') {
      if (!session) throw fault(401, 'Sign in to continue.');
      send(200, publicAccount(session));
      return true;
    }
    if (endpoint === 'POST /api/auth/register') {
      rate('register:' + ip, 5, 3600000);
      const body = await json(req),
        email = emailAddress(body.email),
        name = field(body.name, 'name', 100);
      if (!body.invitation && !['repair', 'it'].includes(body.provider)) throw fault(400, 'Choose a service workspace.');
      if (verificationRequired && !delivery.emailConfigured)
        throw fault(503, 'Email verification is not configured. Please contact the site owner.');
      const passwordHash = await hashPassword(body.password);
      const existing = sql.prepare('SELECT id FROM accounts WHERE email=?').get(email);
      if (existing) {
        if (verificationRequired) {
          send(202, {
            verificationRequired: true,
            message:
              'If this address can be registered, a verification email will be sent. Check your inbox or try signing in.',
          });
          return true;
        }
        throw fault(409, 'We couldn’t create this account. Try signing in or resetting your password.');
      }
      const account = {
        id: randomUUID(),
        email,
        name,
        provider: body.provider,
        email_verified: 0,
        password_hash: passwordHash,
      };
      sql
        .transaction(() => {
          const membership = companies.registration(body, email);
          account.company_id = membership.companyId;
          account.role = membership.role;
          account.provider = membership.provider;
          sql
            .prepare(
              'INSERT INTO accounts(id,email,name,password_hash,provider,email_verified,created_at,company_id,role) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(
              account.id,
              email,
              name,
              passwordHash,
              account.provider,
              0,
              Date.now(),
              account.company_id,
              account.role,
            );
          ensureBots(sql, account.company_id);
          sql.prepare("INSERT INTO company_memberships VALUES(?,?,?,'active',?,?)").run(account.company_id,account.id,account.role,account.provider,Date.now());
          if (account.role === 'staff')
            sql.prepare('INSERT INTO staff_access VALUES(?,?)').run(account.id, account.provider);
          if (delivery.emailConfigured) queueLink(account, 'verify');
        })
        .immediate();
      if (verificationRequired)
        send(202, {
          verificationRequired: true,
          message:
            'If this address can be registered, a verification email will be sent. Check your inbox or try signing in.',
        });
      else {
        const created = startSession(account);
        send(
          201,
          { profile: created.profile, csrfToken: created.csrfToken, expiresAt: created.expiresAt },
          { 'Set-Cookie': cookie(created.token) },
        );
      }
      return true;
    }
    if (endpoint === 'POST /api/auth/login') {
      const body = await json(req),
        email = emailAddress(body.email);
      rate('login-ip:' + ip, 15, 900000);
      rate('login-account:' + hashToken(email), 8, 900000);
      if (typeof body.password !== 'string' || body.password.length > 128)
        throw fault(400, 'Enter your password.');
      const account = sql.prepare('SELECT * FROM accounts WHERE email=?').get(email);
      if (!(await verifyPassword(body.password, account?.password_hash)))
        throw fault(401, 'Email or password is incorrect.');
      if (verificationRequired && !account.email_verified)
        throw fault(
          403,
          'Verify your email before signing in. You can request another verification email below.',
        );
      const created = startSession(account);
      send(
        200,
        { profile: created.profile, csrfToken: created.csrfToken, expiresAt: created.expiresAt },
        { 'Set-Cookie': cookie(created.token) },
      );
      return true;
    }
    if (endpoint === 'POST /api/auth/forgot' || endpoint === 'POST /api/auth/resend-verification') {
      rate('recovery-ip:' + ip, 5, 900000);
      const email = emailAddress((await json(req)).email);
      rate('recovery-account:' + hashToken(email), 3, 3600000);
      if (!delivery.emailConfigured)
        throw fault(503, 'Email delivery is not configured. Please contact the site owner.');
      const account = sql.prepare('SELECT * FROM accounts WHERE email=?').get(email);
      const purpose = endpoint.endsWith('/forgot') ? 'reset' : 'verify';
      if (account && (purpose === 'reset' || !account.email_verified)) queueLink(account, purpose);
      send(202, { message: 'If this account needs that email, a private link will be sent shortly.' });
      return true;
    }
    if (endpoint === 'POST /api/auth/reset' || endpoint === 'POST /api/auth/verify') {
      rate('token:' + ip, 10, 900000);
      const body = await json(req),
        purpose = endpoint.endsWith('/reset') ? 'reset' : 'verify';
      const tokenHash = hashToken(field(body.token, 'private link', 200));
      const record = sql
        .prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=? AND expires_at>?')
        .get(tokenHash, purpose, Date.now());
      if (!record) throw fault(400, 'This link has expired or was already used. Request another one.');
      const passwordHash = purpose === 'reset' ? await hashPassword(body.password) : null;
      sql
        .transaction(() => {
          const consumed = sql
            .prepare('DELETE FROM auth_tokens WHERE token_hash=? AND expires_at>?')
            .run(tokenHash, Date.now());
          if (!consumed.changes) throw fault(400, 'This link has expired or was already used.');
          if (purpose === 'reset') {
            sql
              .prepare('UPDATE accounts SET password_hash=? WHERE id=?')
              .run(passwordHash, record.account_id);
            sql.prepare('DELETE FROM sessions WHERE account_id=?').run(record.account_id);
            sql
              .prepare("DELETE FROM auth_tokens WHERE account_id=? AND purpose='reset'")
              .run(record.account_id);
          } else sql.prepare('UPDATE accounts SET email_verified=1 WHERE id=?').run(record.account_id);
        })
        .immediate();
      send(
        200,
        {
          message:
            purpose === 'reset'
              ? 'Password updated. Sign in with your new password.'
              : 'Email verified. You can now sign in.',
        },
        purpose === 'reset' ? { 'Set-Cookie': cookie('', true) } : {},
      );
      return true;
    }
    if (endpoint === 'POST /api/session') {
      if (!demoEnabled) throw fault(404, 'Demo access is disabled. Sign in with your own account.');
      rate('demo:' + ip, 30);
      const body = await json(req),
        profile = profiles.find((p) => p.id === body.profileId);
      if (!profile || body.pin !== (config.DEMO_PIN || '246810'))
        throw fault(401, 'Check the demo workspace and access code.');
      const created = startSession(null, profile);
      send(200, created, { 'Set-Cookie': cookie(created.token) });
      return true;
    }
    if (endpoint === 'DELETE /api/session' || endpoint === 'POST /api/auth/logout-all') {
      if (!session) throw fault(401, 'Sign in to continue.');
      csrf(req, session);
      if (endpoint.endsWith('logout-all') && session.account_id)
        sql.prepare('DELETE FROM sessions WHERE account_id=?').run(session.account_id);
      else sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
      send(200, { success: true }, { 'Set-Cookie': cookie('', true) });
      return true;
    }
    if (endpoint === 'GET /api/auth/sessions') {
      if (!session?.account_id) throw fault(401, 'Sign in to manage your sessions.');
      send(200, {
        sessions: sql
          .prepare(
            'SELECT created_at,last_seen,expires_at,token_hash FROM sessions WHERE account_id=? AND expires_at>? ORDER BY created_at DESC',
          )
          .all(session.account_id, Date.now())
          .map(({ token_hash, ...s }) => ({ ...s, current: token_hash === session.token_hash })),
      });
      return true;
    }
    if (endpoint === 'POST /api/auth/change-password') {
      if (!session?.account) throw fault(401, 'Sign in to continue.');
      csrf(req, session);
      rate('password:' + session.account_id, 5, 900000);
      const body = await json(req);
      if (!(await verifyPassword(body.currentPassword, session.account.password_hash)))
        throw fault(400, 'Your current password is incorrect.');
      const passwordHash = await hashPassword(body.password);
      sql
        .transaction(() => {
          sql.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(passwordHash, session.account_id);
          sql.prepare('DELETE FROM sessions WHERE account_id=?').run(session.account_id);
          sql
            .prepare("DELETE FROM auth_tokens WHERE account_id=? AND purpose='reset'")
            .run(session.account_id);
        })
        .immediate();
      send(
        200,
        { message: 'Password changed. Sign in again on your devices.' },
        { 'Set-Cookie': cookie('', true) },
      );
      return true;
    }
    return false;
  }
  return { authenticate, csrf, handle, rate, demoEnabled, hashToken };
}
