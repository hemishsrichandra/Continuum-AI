import {request} from './client.js';
import {openAccount} from './auth-ui.js';

export const staffAccountControls = '<button class="button" id="staff-account">Account & security</button><button class="button" id="staff-signout">Sign out</button>';

export function bindStaffAccount(app) {
  const dialog = document.createElement('dialog');
  dialog.id = 'staff-account-dialog';
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  app.append(dialog);
  const signedOut = () => location.replace('/desk');
  app.querySelector('#staff-signout').addEventListener('click', async event => {
    event.target.disabled = true;
    try { await request('session', {method:'DELETE'}); signedOut(); }
    catch (e) { event.target.disabled = false; app.querySelector('#team-result, #operator-result').textContent = e.message; }
  });
  app.querySelector('#staff-account').addEventListener('click', async event => {
    event.target.disabled = true;
    try {
      const session = await request('auth/session');
      await openAccount(dialog, session.profile, signedOut);
      // These settings concern personal customer visits, not company case work.
      for (const section of dialog.querySelectorAll('.settings-section')) {
        const title = section.querySelector('h3')?.textContent;
        if (['Google Calendar','Delivery activity'].includes(title)) section.remove();
      }
      dialog.querySelector('#dialog-title').textContent = 'Account & security';
    } catch (e) { app.querySelector('#team-result, #operator-result').textContent = e.message; }
    finally { event.target.disabled = false; }
  });
}
