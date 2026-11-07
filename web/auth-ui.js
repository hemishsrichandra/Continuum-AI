import { request, escapeHtml as q, formatDate } from './client.js';

export async function renderAuth(app, { onSession, error = '', initialMode = 'login', link = null } = {}) {
  const settings = await request('auth/config').catch(() => ({ demoEnabled: false, emailConfigured: false }));
  let mode = initialMode,
    email = '',
    busy = false;
  function render(notice = '', failed = false) {
    const register = mode === 'register' || mode === 'company',
      recovery = mode === 'forgot' || mode === 'resend',
      reset = mode === 'reset',
      verify = mode === 'verify',
      demo = mode === 'demo';
    const companyFields = register
      ? mode === 'company'
        ? '<label>Company name<input name="companyName" required maxlength="100" autocomplete="organization"></label>'
        : link?.invitation
          ? '<p>Your company, role, and service category are fixed by this invitation.</p>'
          : '<label>Company signup code<input name="companyCode" required maxlength="200" value="' +
            q(link?.companyCode || '') +
            '"></label>'
      : '';
    const title = register
      ? 'A fresh start.'
      : recovery
        ? mode === 'forgot'
          ? 'Reset your password.'
          : 'Verify your email.'
        : reset
          ? 'Choose a new password.'
          : verify
            ? 'Confirm your email.'
            : demo
              ? 'Explore a demo.'
              : 'Welcome back.';
    app.innerHTML = `<section class="wrap login-page"><div class="login-intro"><div class="eyebrow">YOUR CONTINUUM WORKSPACE</div><h1>Good support<br>starts with you.</h1><p class="lead">Your requests, conversations, and next steps.<br>A little context. A lot less chasing.</p><p class="login-assurance"><span class="status-dot"></span> Your account. Your service history.</p></div><section class="panel login-panel" aria-labelledby="auth-title"><h2 id="auth-title" tabindex="-1">${title}</h2><p class="muted">${register ? 'Create your own account and keep your service history together.' : demo ? 'Fictional records in a separate demo workspace.' : recovery ? (settings.emailConfigured ? 'We’ll send a private, time-limited link if the account needs it.' : 'Email recovery is not enabled yet. Ask the site owner to configure email delivery.') : verify ? 'Confirm that this email address belongs to you.' : reset ? 'Your other sessions will be signed out after this change.' : 'Sign in to pick up where you left off.'}</p><p id="auth-result" class="notice ${failed ? 'error' : 'success'}" role="${failed ? 'alert' : 'status'}" ${notice ? '' : 'hidden'}>${q(notice)}</p><form id="account-auth-form">${register ? '<label>Your name<input name="name" autocomplete="name" required maxlength="100" placeholder="Alex Morgan"></label>' : ''}${!reset && !verify && !demo ? `<label>Email address<input name="email" type="email" autocomplete="username" required maxlength="254" value="${q(email)}" placeholder="you@example.com"></label>` : ''}${demo ? '<label>Demo workspace<select name="profileId"><option value="alice">Alice · Device Repair</option><option value="bob">Bob · Failed fix recovery</option><option value="carol">Carol · IT Support</option></select></label><label>Demo access code<input name="pin" value="246810" autocomplete="off" required></label>' : ''}${register || reset || (!recovery && !verify && !demo) ? `<label for="auth-password">${reset ? 'New password' : 'Password'}</label><span class="password-input"><input id="auth-password" name="password" type="password" autocomplete="${register || reset ? 'new-password' : 'current-password'}" required ${register || reset ? 'minlength="15" aria-describedby="password-guidance"' : ''} maxlength="128"><button type="button" class="password-reveal" aria-controls="auth-password" aria-label="Show password">Show</button></span>${register || reset ? '<p class="fine-print" id="password-guidance">Use 15–128 characters. A memorable passphrase works well. You can paste from a password manager.</p>' : ''}` : ''}${companyFields}${register && !link?.invitation ? '<label>Schema adapter<select name="provider"><option value="repair">Standard service requests</option><option value="it">IT Support</option></select></label>' : ''}<button class="button primary full" type="submit" ${recovery && !settings.emailConfigured ? 'disabled' : ''}>${register ? 'Create account' : recovery ? 'Send private link' : reset ? 'Update password' : verify ? 'Verify email' : demo ? 'Open demo' : 'Sign in'} →</button></form><div class="auth-links">${mode !== 'login' ? '<button class="text-button" data-auth-mode="login">Back to sign in</button>' : '<button class="text-button" data-auth-mode="forgot">Forgot password?</button><button class="text-button" data-auth-mode="register">Join your service provider</button><button class="text-button" data-auth-mode="company">Create a company</button><button class="text-button" data-auth-mode="resend">Resend verification email</button>'}${settings.demoEnabled && mode !== 'demo' ? '<button class="text-button" data-auth-mode="demo">Explore the demo</button>' : ''}</div></section></section>`;
    const form = document.querySelector('#account-auth-form');
    app.querySelectorAll('[data-auth-mode]').forEach((button) =>
      button.addEventListener('click', () => {
        email = form.elements.email?.value || email;
        mode = button.dataset.authMode;
        render();
        document.querySelector('#auth-title').focus({ preventScroll: true });
      }),
    );
    app.querySelector('.password-reveal')?.addEventListener('click', (event) => {
      const input = document.querySelector('#auth-password'),
        show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      event.currentTarget.textContent = show ? 'Hide' : 'Show';
      event.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const button = form.querySelector('[type=submit]'),
        label = button.textContent;
      button.disabled = true;
      button.textContent = 'Please wait…';
      form.setAttribute('aria-busy', 'true');
      const body = Object.fromEntries(new FormData(form));
      if (mode === 'company') body.createCompany = true;
      if (register && link?.invitation) body.invitation = link.invitation;
      if (body.email) email = body.email;
      const route = register
        ? 'auth/register'
        : demo
          ? 'session'
          : recovery
            ? mode === 'forgot'
              ? 'auth/forgot'
              : 'auth/resend-verification'
            : reset
              ? 'auth/reset'
              : verify
                ? 'auth/verify'
                : 'auth/login';
      try {
        const result = await request(route, {
          body: { ...body, ...(link && (reset || verify) && { token: link.token }) },
        });
        if (verify) {
          const current = await request('auth/session').catch(() => null);
          if (current) {
            await onSession(current);
            return;
          }
        }
        if (result.profile) {
          if(!register && !demo && (link?.invitation || link?.companyCode)) {
            const joined=await request('auth/join',{body:link});
            const selected=await request('auth/workspace',{body:{companyId:joined.companyId}});
            result.profile=selected.profile;
          }
          await onSession(result);
        }
        else {
          mode = 'login';
          link = null;
          render(result.message || 'Check your email for a private verification link.');
        }
      } catch (e) {
        const result = document.querySelector('#auth-result');
        if (result) {
          result.textContent = e.message;
          result.className = 'notice error';
          result.setAttribute('role', 'alert');
          result.hidden = false;
        }
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = label;
        form.removeAttribute('aria-busy');
      }
    });
  }
  render(error, Boolean(error));
}

export async function openAccount(dialog, profile, onSignOut) {
  dialog.innerHTML = '<div role="status">Loading your account…</div>';
  dialog.showModal();
  let [status, sessions] = await Promise.all([
    request('integrations/status'),
    request('auth/sessions'),
  ]).catch((e) => [{ error: e.message }, { sessions: [] }]);
  dialog.innerHTML = `<div class="dialog-header"><span class="eyebrow">YOUR CONTINUUM ACCOUNT</span><button class="icon-button" id="close-account" aria-label="Close account settings">×</button></div><h2 id="dialog-title">Account & connections</h2><p><b>${q(profile.name)}</b><br>${q(profile.email)}<br>Role: ${q(profile.role === 'staff' ? 'Specialist' : profile.role || 'Customer')} · ${q(profile.companyName || 'Demo')}</p><p class="notice" id="account-result" role="status" hidden></p>${status.error ? `<p class="notice error" role="alert">${q(status.error)}</p>` : ''}<section class="settings-section"><h3>Email verification</h3><p>${profile.verified ? 'Your email is verified.' : 'Your email has not been verified yet.'}</p>${!profile.verified ? `<button class="button small" id="send-verification" ${!status.email?.configured ? 'disabled aria-describedby="email-setup-note"' : ''}>Send verification email</button>` : ''}${!status.email?.configured ? '<p id="email-setup-note" class="fine-print">Email delivery requires server setup. Ask your administrator to enable it.</p>' : ''}</section><section class="settings-section"><h3>Google Calendar</h3><p>${status.google?.connected ? 'Your calendar is connected. Availability is checked before visits are booked. Updates sync in the background.' : 'Connect your calendar to check availability and sync bookings and cancellations.'}</p><button class="button small" id="google-connection" ${!status.google?.configured ? 'disabled aria-describedby="calendar-setup-note"' : ''}>${status.google?.connected ? 'Disconnect calendar' : 'Connect Google Calendar'}</button>${!status.google?.configured ? '<p id="calendar-setup-note" class="fine-print">Google Calendar requires server setup before you can connect it.</p>' : ''}</section><section class="settings-section"><h3>Delivery activity</h3>${status.deliveries?.length ? `<ul class="delivery-list">${status.deliveries.map((job) => `<li><b>${job.type === 'email' ? 'Email' : 'Calendar update'}</b><span class="pill ${job.status === 'delivered' ? 'green' : ''}">${job.status === 'delivered' ? (job.type === 'email' ? 'Sent to provider' : 'Synced') : q(job.status)}</span>${job.lastError ? `<p>${q(job.lastError)}</p>` : ''}</li>`).join('')}</ul>` : '<p>No deliveries yet. Confirmation emails are sent to verified addresses.</p>'}<button class="text-button" id="retry-deliveries">Retry eligible failed deliveries</button></section><section class="settings-section"><h3>Signed-in devices</h3><p>${sessions.sessions.length} active session${sessions.sessions.length === 1 ? '' : 's'}.</p><ul class="session-list">${sessions.sessions.map((session) => `<li>${session.current ? 'This session' : 'Another session'}<small>Last active ${formatDate(session.last_seen, true)}</small></li>`).join('')}</ul><button class="button small" id="signout-all">Sign out all devices</button></section><section class="settings-section"><h3>Change password</h3><form id="password-change"><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>New password<input name="password" type="password" autocomplete="new-password" required minlength="15" maxlength="128" aria-describedby="new-password-guidance"></label><p class="fine-print" id="new-password-guidance">Use 15–128 characters. All devices will be signed out.</p><button class="button small" type="submit">Change password</button></form></section>`;
  const notice = (text, error = false) => {
    const el = dialog.querySelector('#account-result');
    el.hidden = false;
    el.className = 'notice ' + (error ? 'error' : 'success');
    el.setAttribute('role', error ? 'alert' : 'status');
    el.textContent = text;
  };
  dialog.querySelector('#close-account').focus({ preventScroll: true });
  dialog.querySelector('#close-account').addEventListener('click', () => dialog.close());
  const action = (selector, work) =>
    dialog.querySelector(selector)?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        await work();
      } catch (e) {
        notice(e.message, true);
      } finally {
        event.target.disabled = false;
      }
    });
  action('#send-verification', async () =>
    notice((await request('auth/resend-verification', { body: { email: profile.email } })).message),
  );
  action('#google-connection', async () => {
    if (status.google?.connected) {
      const result = await request('integrations/google', { method: 'DELETE' });
      notice(result.message);
      status.google.connected = false;
      dialog.querySelector('#google-connection').textContent = 'Connect Google Calendar';
    } else {
      const result = await request('integrations/google/connect', { body: {} });
      location.assign(result.url);
    }
  });
  action('#retry-deliveries', async () =>
    notice((await request('integrations/retry', { body: {} })).message),
  );
  action('#signout-all', async () => {
    await request('auth/logout-all', { body: {} });
    dialog.close();
    await onSignOut();
  });
  dialog.querySelector('#password-change').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await request('auth/change-password', { body: Object.fromEntries(new FormData(event.target)) });
      dialog.close();
      await onSignOut('Password changed. Sign in again with your new password.');
    } catch (e) {
      notice(e.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
