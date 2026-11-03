import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

const repoRoot = path.resolve(process.cwd(), '..');
dotenv.config({ path: path.join(repoRoot, 'backend', '.env') });
if (process.env.RUN_INVITATION_BROWSER_E2E !== 'true') {
  throw new Error('Set RUN_INVITATION_BROWSER_E2E=true to run the live browser test against PostgreSQL.');
}

const { buildApp } = await import('../backend/src/app.js');
const { createPrismaClient } = await import('../backend/src/database/prisma.js');
const { loadConfig } = await import('../backend/src/shared/config.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await Promise.race([
    once(socket, 'open'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome DevTools connection timed out')), 10000)),
  ]);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  return {
    socket,
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command timed out: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { socket.close(); },
  };
}

async function attachPage(browser, url = 'about:blank', browserContextId) {
  const { targetId } = await browser.send('Target.createTarget', { url, ...(browserContextId ? { browserContextId } : {}) });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  return {
    async navigate(nextUrl) {
      await browser.send('Page.navigate', { url: nextUrl }, sessionId);
    },
    async evaluate(expression) {
      const response = await browser.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, sessionId);
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result?.value;
    },
  };
}

const chromeCandidates = [
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
let chromePath;
for (const candidate of chromeCandidates) {
  try { await fs.access(candidate); chromePath = candidate; break; } catch { /* try next installed browser */ }
}
if (!chromePath) throw new Error('Install Chrome or Edge, or set CHROME_BIN to its executable path.');

const prisma = createPrismaClient(loadConfig(process.env));
let app;
let vite;
let chrome;
let browser;
let organizationId;
let profileDir;
let browserContextId;

try {
  const vitePort = await availablePort();
  const dashboardOrigin = `http://127.0.0.1:${vitePort}`;
  process.env.CORS_ORIGINS = dashboardOrigin;
  process.env.INVITATION_ACCEPT_URL = `${dashboardOrigin}/accept-invitation`;
  process.env.DP_DASHBOARD_HOST = '127.0.0.1';

  const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
  app = await buildApp({ config, prisma, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const backendPort = app.server.address().port;
  process.env.DP_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
  vite = await createViteServer({
    root: path.join(repoRoot, 'apps', 'dashboard'),
    configFile: path.join(repoRoot, 'apps', 'dashboard', 'vite.config.js'),
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
  });
  await vite.listen();

  const organization = await prisma.organization.create({
    data: { name: 'Browser Invitation E2E', slug: `browser-invite-e2e-${crypto.randomUUID()}` },
  });
  organizationId = organization.id;
  const admin = await app.authService.createTestSession({
    organizationId,
    email: `browser-admin-${crypto.randomUUID()}@example.test`,
  });
  app.authService.emailService = {
    configured: true,
    async sendInvitationEmail() { throw new Error('simulated SMTP outage'); },
  };

  const browserContextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'digitalpulse-invitation-e2e-'));
  profileDir = path.resolve(browserContextDir);
  const chromeEnv = { ...process.env };
  for (const key of ['DATABASE_URL', 'DATABASE', 'DIRECT_URL', 'TEST_DATABASE_URL', 'SMTP_USER', 'SMTP_PASSWORD', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'google_email', 'google_password']) delete chromeEnv[key];
  const chromeProcess = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { env: chromeEnv, windowsHide: true, stdio: 'ignore' });
  chrome = chromeProcess;
  const activePortFile = path.join(profileDir, 'DevToolsActivePort');
  const activePort = await waitFor(async () => {
    try { return Number((await fs.readFile(activePortFile, 'utf8')).split(/\r?\n/)[0]); } catch { return false; }
  }, 'headless Chrome to start', 15000);
  const browserVersion = await fetch(`http://127.0.0.1:${activePort}/json/version`).then((response) => response.json());
  browser = await connectCdp(browserVersion.webSocketDebuggerUrl);

  const adminPage = await attachPage(browser, `${dashboardOrigin}/login`);
  await waitFor(() => adminPage.evaluate('document.readyState === "complete"'), 'admin dashboard page');
  await adminPage.evaluate(`localStorage.setItem('dp_auth_token', ${JSON.stringify(admin.token)})`);
  await adminPage.navigate(`${dashboardOrigin}/employees`);
  await waitFor(() => adminPage.evaluate('document.body.innerText.includes("Employee Directory & Monitoring Governance")'), 'admin employee directory');
  await adminPage.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === '+ Invite Employee')?.click()`);
  await waitFor(() => adminPage.evaluate('Boolean(document.querySelector("input[placeholder=\\\"Employee name\\\"]"))'), 'invitation form');
  await adminPage.evaluate(`(() => {
    const setValue = (selector, value) => {
      const input = document.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('input[placeholder="Employee name"]', 'Browser Employee');
    setValue('input[placeholder="employee@company.com"]', 'browser-employee-${crypto.randomUUID()}@example.test');
    setValue('input[placeholder="Department"]', 'Engineering');
    Array.from(document.querySelectorAll('form button[type="submit"]')).find((button) => button.textContent.includes('Create Invitation'))?.click();
  })()`);
  await waitFor(() => adminPage.evaluate('document.body.innerText.includes("Invitation created successfully")'), 'invitation success state');

  const displayedLink = await adminPage.evaluate('document.querySelector("[role=dialog] code")?.textContent');
  if (!displayedLink) throw new Error('The success state did not display the backend invitation URL.');
  await browser.send('Browser.grantPermissions', {
    origin: dashboardOrigin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  await adminPage.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Copy Invitation Link')?.click()`);
  await waitFor(() => adminPage.evaluate('document.body.innerText.includes("Invitation link copied.")'), 'copy confirmation');
  const copiedLink = await adminPage.evaluate('navigator.clipboard.readText()');
  if (copiedLink !== displayedLink) throw new Error('The copy button did not copy the backend invitation URL.');

  const context = await browser.send('Target.createBrowserContext', { disposeOnDetach: true });
  browserContextId = context.browserContextId;
  const employeePage = await attachPage(browser, copiedLink, browserContextId);
  await waitFor(() => employeePage.evaluate('document.body.innerText.includes("Browser Invitation E2E invited you to DigitalPulse")'), 'invitation details in a separate browser context');
  await employeePage.evaluate(`(() => {
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const passwords = Array.from(document.querySelectorAll('input[autocomplete="new-password"]'));
    setValue(passwords[0], 'StrongPassword123!');
    setValue(passwords[1], 'StrongPassword123!');
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Accept invitation'))?.click();
  })()`);
  await waitFor(() => employeePage.evaluate('document.body.innerText.includes("Set up DigitalPulse on your device")'), 'employee device setup redirect', 25000);

  const acceptedUser = await prisma.user.findFirst({ where: { organizationId, email: { startsWith: 'browser-employee-' } } });
  if (!acceptedUser || acceptedUser.role !== 'EMPLOYEE') throw new Error('The employee account was not activated with the employee role.');
  const activeInvitation = await prisma.invitation.findFirst({ where: { organizationId, email: acceptedUser.email } });
  if (!activeInvitation?.acceptedAt) throw new Error('The invitation was not consumed in PostgreSQL.');
  await waitFor(() => adminPage.evaluate('document.body.innerText.toLowerCase().includes("accepted")'), 'directory to display accepted status', 20000);

  console.log('Browser invitation E2E passed: admin created and copied the link; a separate browser context accepted it and reached employee setup; PostgreSQL and the directory show acceptance.');
} finally {
  if (browserContextId && browser) await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  if (browser) await browser.send('Browser.close').catch(() => {});
  browser?.close();
  if (chrome && !chrome.killed) chrome.kill();
  if (vite) await vite.close().catch(() => {});
  if (organizationId) await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
  if (app) await app.close().catch(() => {});
  await prisma[String.fromCharCode(36) + 'disconnect']().catch(() => {});
  if (profileDir) {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (profileDir.startsWith(tempRoot)) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
