let csrfToken = null;
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function readSession(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
export function saveSession(key, value) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* The current page remains usable if browser storage is unavailable. */ } }
export async function request(route, { body, method, key, timeout = 55000 } = {}) {
  let response;
  try {
    const verb = method || (body ? 'POST' : 'GET');
    if (!['GET', 'HEAD'].includes(verb) && !csrfToken) {
      const session = await fetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (session.ok) csrfToken = (await session.json()).csrfToken;
    }
    response = await fetch('/api/' + route, {
      method: verb, credentials: 'same-origin', signal: AbortSignal.timeout(timeout),
      headers: { ...(csrfToken && { 'X-CSRF-Token': csrfToken }), ...(body && { 'Content-Type': 'application/json' }), ...(key && { 'Idempotency-Key': key }) },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'This is taking longer than expected. Retry to check your submission safely.' : 'Unable to connect. Check your connection and try again.');
  }
  const result = await response.json().catch(() => ({ error: 'The server sent an unexpected response. Please try again.' }));
  if (response.status === 401) csrfToken = null;
  if (!response.ok) throw Object.assign(new Error(result.error || 'Something went wrong. Try again.'), { status: response.status, requestId: result.requestId, retryAfter: result.retryAfter });
  if (result.csrfToken) csrfToken = result.csrfToken;
  if (route === 'session' && method === 'DELETE' || route === 'auth/logout-all' || route === 'auth/change-password' || route === 'auth/reset') csrfToken = null;
  return result;
}
export function calendarLink(booking, title = 'Continuum session') {
  const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(booking.datetime);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Continuum//Appointments//EN', 'BEGIN:VEVENT', `UID:${booking.id}@supportly.local`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(+start + 1800000))}`, 'SUMMARY:' + title, 'DESCRIPTION:Manage this appointment in your Continuum workspace.', 'END:VEVENT', 'END:VCALENDAR'];
  return URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar' }));
}
export const formatDate = (date, full = false) => date ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', ...(full && { hour: 'numeric', minute: '2-digit', year: 'numeric' }), timeZone: 'Asia/Kolkata' }).format(new Date(date)) : 'Not set';
