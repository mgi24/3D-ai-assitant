import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `space-verify-${Date.now()}`;
const probe = createServer();
await new Promise(ok => { probe.listen(0, '127.0.0.1', ok); });
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
const base = `http://127.0.0.1:${port}`;

const server = spawn(python, [join(root, 'server.py')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PORT: String(port), AICHAT_DESKTOP_TOKEN: token }
});

try {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/api/desktop-ready`, { headers: { 'X-AICHAT-Desktop-Token': token } });
      if (res.ok) break;
    } catch {}
    await new Promise(ok => setTimeout(ok, 200));
  }

  const browser = await chromium.launch({ headless: true, executablePath: browserPath() });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.request.post(`${base}/api/desktop-session`, { headers: { 'X-AICHAT-Desktop-Token': token } });

  console.log('=== Testing Pose Window (?poseBrowser=1) ===');
  const page = await context.newPage();
  await page.goto(`${base}/app/?poseBrowser=1`);
  await page.waitForFunction(() => document.body.classList.contains('pose-window'));
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping', null, { timeout: 10000 });

  // 1. Initial state: Looping, button says ⏸ Pause
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  assert.equal(await page.locator('#pose-timeline-state').textContent(), 'Looping');

  // 2. Press Space right after opening window -> Paused
  console.log('Test 1: Initial state, press Space -> Paused');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Paused successfully on initial Space');

  // 3. Press Space again -> Looping
  console.log('Test 2: Press Space again -> Looping');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  console.log('  PASS: Resumed successfully on Space');

  // 4. Focus canvas and press Space -> Paused
  console.log('Test 3: Focus canvas, press Space -> Paused');
  await page.locator('#pose-preview-stage canvas').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Paused successfully when canvas focused');

  // 5. Press Space again on canvas -> Looping
  console.log('Test 4: Press Space again on canvas -> Looping');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  console.log('  PASS: Resumed successfully on canvas Space');

  // 6. Click a pose card (wave)
  console.log('Test 5: Click pose card "wave", then press Space -> Paused');
  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Paused after pose card selection');

  // 7. Focus on #pose-preview-btn, press Space -> Looping
  console.log('Test 6: Focus #pose-preview-btn, press Space -> Looping');
  await page.locator('#pose-preview-btn').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  console.log('  PASS: Resumed from focused button');

  // 8. Focus on #pose-duration (number input), click preview stage, press Space -> Paused
  console.log('Test 7: Focus duration input, click preview stage, press Space -> Paused');
  await page.locator('#pose-duration').focus();
  await page.locator('#pose-preview-stage').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Stage click cleared input focus and paused on Space');

  // 9. Focus on #pose-timeline-range slider, press Space -> Looping
  console.log('Test 8: Focus timeline range slider, press Space -> Looping');
  await page.locator('#pose-timeline-range').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  console.log('  PASS: Space toggles preview from timeline slider');

  console.log('\n=== Testing Modal Dialog Mode in Main Page ===');
  const mainPage = await context.newPage();
  await mainPage.goto(`${base}/app/`);
  await mainPage.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });
  await mainPage.locator('#desktop-pose-btn').click();
  await mainPage.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true);
  await mainPage.waitForFunction(() => /siap/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });
  await mainPage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');

  console.log('Test 9: Modal dialog press Space -> Paused');
  await mainPage.keyboard.press('Space');
  await mainPage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await mainPage.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Modal dialog paused on Space');

  console.log('Test 10: Modal dialog press Space again -> Looping');
  await mainPage.keyboard.press('Space');
  await mainPage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await mainPage.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  console.log('  PASS: Modal dialog resumed on Space');

  // Click on stage outside avatar bone in modal dialog
  console.log('Test 11: Modal dialog click preview stage corner, press Space -> Paused');
  await mainPage.locator('#pose-preview-stage').click({ position: { x: 10, y: 10 } });
  await mainPage.keyboard.press('Space');
  await mainPage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await mainPage.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Modal dialog preview stage space toggle works');

  await browser.close();
  console.log('\n*** ALL SPACE PAUSE/RESUME TESTS PASSED! ***');
} finally {
  server.kill();
}
