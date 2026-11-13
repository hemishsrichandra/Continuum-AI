// Browser end-to-end support: starts the real server on a temporary database, finds a Chromium-based browser, and signs people in by API
// so the tests exercise the real console screens. Everything is local; passwords and tokens here are dummy test values.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export const PASSWORD = 'a long isolated e2e passphrase 2026';
const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);

/** Fails loudly (never skips) when no browser can be found: set BROWSER_PATH to a Chrome, Chromium or Edge executable. */
export async function launchBrowser() {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('Browser tests need a Chromium-based browser. Install Chrome, Chromium or Edge, or set BROWSER_PATH to its executable. Looked in: ' + CANDIDATES.join(', '));
  return chromium.launch({ executablePath, headless: true });
}

export async function startApp(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-e2e-'));
  const child = spawn(process.execPath, ['server/start.js'], {
    env: {
      ...process.env, NODE_ENV: 'test', APP_URL: 'http://localhost:3000', REQUIRE_EMAIL_VERIFICATION: 'false', ENABLE_OUTBOX_WORKER: 'false', RESEND_API_KEY: '', EMAIL_FROM: '',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', INTEGRATION_ENCRYPTION_KEY: '', DATABASE_FILE: join(dir, 'e2e.sqlite'), DATA_FILE: join(dir, 'e2e.json'), ENABLE_DEMO_MODE: 'false',
      FRONTEND_PORT: '0', API_PORT: '0', HINDSIGHT_BASE_URL: '', OPENAI_API_KEY: '', REQUIRE_LIVE_INTEGRATIONS: 'false', SUGGESTION_MODE: '', DATA_SOURCE_ALLOW_LOOPBACK: 'true', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server did not start within 20 s. Output: ' + output)), 20000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('The server exited with ' + code + '. Output: ' + output)); });
    child.stderr.on('data', (c) => { output += c; });
    child.stdout.on('data', (c) => { output += c; const m = String(c).match(/Continuum: (http:\/\/localhost:\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const stop = async () => { child.kill(); await new Promise((r) => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  return { base, dir, stop };
}

/** A signed-in API client (cookie + CSRF), used both to set a scene up and to give the browser its session. */
export async function signUp(app, body) {
  const r = await fetch(app.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, provider: 'repair', ...body }) });
  if (r.status !== 201) throw new Error('sign-up failed: ' + r.status + ' ' + (await r.text()));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const data = await r.json();
  const call = async (route, payload, method = payload === undefined ? 'GET' : 'POST') => {
    const res = await fetch(app.base + '/api/' + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': data.csrfToken }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { cookie, profile: data.profile, call, csrf: data.csrfToken };
}
export const asUser = async (browser, app, user) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, ...rest] = user.cookie.split('=');
  await context.addCookies([{ name, value: rest.join('='), url: app.base }]);
  return { context, page: await context.newPage() };
};
