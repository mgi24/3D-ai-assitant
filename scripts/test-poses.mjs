import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : process.env.PYTHON || 'python3';
const token = `pose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const probe = createServer();
await new Promise((resolveListen, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolveListen);
});
const port = probe.address().port;
await new Promise(resolveClose => probe.close(resolveClose));
const base = `http://127.0.0.1:${port}`;
const server = spawn(python, [join(root, 'server.py')], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, PORT: String(port), AICHAT_DESKTOP_TOKEN: token }
});
let browser;

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${base}/api/desktop-ready`, {
        headers: { 'X-AICHAT-Desktop-Token': token }
      });
      if (response.ok) return;
    } catch { }
    await new Promise(resolveWait => setTimeout(resolveWait, 120));
  }
  throw new Error('Test server did not become ready within 30 seconds.');
}

try {
  await mkdir('test-results', { recursive: true });
  await waitForServer();

  // A normal browser session must see only the desktop notice and no app/API access.
  const untrusted = await chromium.launch({ headless: true, executablePath: browserPath() });
  const untrustedPage = await untrusted.newPage();
  const blocked = await untrustedPage.goto(`${base}/app/`);
  assert.equal(blocked.status(), 404, 'The desktop UI must reject a browser without a session.');
  const notice = await untrustedPage.goto(`${base}/`);
  assert.match(await notice.text(), /hanya tersedia di aplikasi Windows/i);
  await untrusted.close();

  browser = await chromium.launch({ headless: true, executablePath: browserPath(),
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 440, height: 700 }, deviceScaleFactor: 1 });
  const session = await context.request.post(`${base}/api/desktop-session`, {
    headers: { 'X-AICHAT-Desktop-Token': token }
  });
  assert.equal(session.status(), 200, 'The native test bridge must establish a desktop session.');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.route('**/api/chat', route => route.fulfill({ json: {
    text: 'Wave pose verification.', emotion: 'happy', gesture: 'wave'
  } }));
  await page.route('**/api/tts', route => route.fulfill({ status: 503, body: 'skip TTS during pose capture' }));
  await page.goto(`${base}/app/`);
  await page.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });
  await page.waitForFunction(() => document.body.dataset.pose === 'idle', null, { timeout: 5000 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('background', '#667080', 'important');
    document.body.style.setProperty('background', '#667080', 'important');
  });
  assert.equal(await page.evaluate(() => document.body.dataset.pose), 'idle');

  await page.evaluate(() => {
    document.querySelector('#chat-input').value = 'wave pose verification';
    document.querySelector('#chat-form').requestSubmit();
  });
  await page.waitForFunction(() => document.body.dataset.pose?.includes('wave'), null, { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelector('#conversation-drawer')?.classList.add('desktop-closed');
    document.querySelector('#desktop-chat-toggle')?.classList.remove('active');
  });
  for (let frame = 0; frame <= 10; frame++) {
    const elapsed = (frame / 2).toFixed(1);
    await page.screenshot({ path: `test-results/pose-wave-${elapsed}s.png` });
    if (frame < 10) await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => !document.body.dataset.pose?.includes('wave'), null, { timeout: 2000 });
  console.log('Pose capture state:', JSON.stringify(await page.evaluate(() => ({
    pose: document.body.dataset.pose,
    poseError: document.body.dataset.poseError,
    appState: document.body.dataset.state
  }))));
  assert.equal(await page.evaluate(() => document.body.dataset.pose), 'idle', 'Wave must transition back to idle.');
  assert.deepEqual(errors, [], 'Pose transitions must not introduce browser exceptions.');
  console.log(JSON.stringify({ passed: true, frames: 11, intervalSeconds: 0.5,
    poseAfterReturn: 'idle', errors }));
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    await new Promise(resolveExit => {
      server.once('exit', resolveExit);
      server.kill();
      setTimeout(resolveExit, 1500);
    });
  }
}
