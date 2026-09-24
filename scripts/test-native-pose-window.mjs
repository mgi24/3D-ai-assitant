import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const root = resolve('.');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const debugPort = 9333;
const appProcess = spawn(electron, [`--remote-debugging-port=${debugPort}`, 'desktop-main.cjs'], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore'
});
let browser;
async function waitFor(fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { }
    await new Promise(ok => setTimeout(ok, 250));
  }
  throw new Error('Timed out while waiting for native Pose Browser window.');
}

try {
  await mkdir('test-results', { recursive: true });
  browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`), 60000);
  const context = browser.contexts()[0];
  const mainPage = await waitFor(() => context.pages().find(page => page.url().includes('/app/')), 60000);
  const errors = [];
  mainPage.on('pageerror', error => errors.push(error.stack || error.message));
  await mainPage.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 60000 });
  await mainPage.locator('#desktop-pose-btn').click();
  const posePage = await waitFor(() => context.pages().find(page => page.url().includes('poseBrowser=1')), 60000);
  const poseErrors = [];
  posePage.on('pageerror', error => poseErrors.push(error.stack || error.message));
  await posePage.waitForFunction(() => document.body.classList.contains('pose-window'), null, { timeout: 60000 });
  await posePage.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 60000 });
  await posePage.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 60000 });
  assert.ok(await posePage.evaluate(() => document.querySelector('#pose-browser-dialog').getBoundingClientRect().width > 900));
  assert.equal(await posePage.locator('#pose-stop-preview-btn').count(), 0, 'Native Pose Browser must use one playback toggle');
  assert.equal(await posePage.locator('#pose-move-tool').count(), 0);
  assert.equal(await posePage.locator('.pose-timeline #pose-keyframe-track').count(), 1);
  assert.equal(await posePage.locator('#pose-preview-stage').evaluate(element => getComputedStyle(element).resize), 'vertical');
  await posePage.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await posePage.waitForFunction(() => document.body.dataset.pose?.includes('wave'), null, { timeout: 5000 });
  assert.equal(await posePage.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  await posePage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  await posePage.locator('.pose-keyframe-marker').first().focus();
  await posePage.keyboard.press('Space');
  await posePage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await posePage.locator('#pose-preview-btn').textContent(), '▶ Resume');
  await posePage.keyboard.press('Space');
  await posePage.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await posePage.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  assert.equal(await posePage.evaluate(() => window.aichatPoseDiagnostics().armature?.visible), true);
  assert.equal(await posePage.locator('#pose-reset-bone-btn').isVisible(), true);
  assert.equal(await posePage.locator('#pose-reset-bone-btn').isDisabled(), false);
  await posePage.locator('.pose-keyframe-marker').first().click();
  assert.equal(await posePage.locator('#pose-preview-delete-keyframe-btn').isDisabled(), false);
  await posePage.locator('#pose-reset-bone-btn').click();
  await posePage.screenshot({ path: 'test-results/pose-window-native.png', fullPage: false });
  await posePage.locator('#pose-cards .pose-card[data-pose="talk"]').click();
  await posePage.waitForFunction(() => document.body.dataset.pose?.includes('talk'), null, { timeout: 5000 });
  await posePage.locator('#pose-timeline-range').evaluate((element) => {
    element.value = '0.20';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await posePage.waitForFunction(() => {
    const diagnostics = window.aichatPoseDiagnostics();
    return Number(diagnostics.mouth?.pose?.aa || 0) > 0.6
      && Number(diagnostics.mouth?.expressions?.aa || 0) > 0.6;
  }, null, { timeout: 5000 });
  const nativePreviewBox = await posePage.locator('#pose-preview-stage canvas').boundingBox();
  await posePage.mouse.move(nativePreviewBox.x + nativePreviewBox.width / 2, nativePreviewBox.y + nativePreviewBox.height / 2);
  await posePage.mouse.wheel(0, -700);
  await posePage.waitForTimeout(250);
  await posePage.screenshot({ path: 'test-results/pose-window-native-talk-mouth.png', fullPage: false });
  await execFileAsync(process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3', [join(root, 'scripts', 'capture_screen.py'), 'test-results/pose-window-native-fullscreen.png'], { cwd: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(poseErrors, []);
  console.log(JSON.stringify({ passed: true, nativePoseWindow: true, poseWindowPages: context.pages().length, errors, poseErrors }));
  await posePage.locator('#pose-browser-close').click();
  await waitFor(() => !context.pages().some(page => page.url().includes('poseBrowser=1')), 10000);
  await mainPage.locator('#desktop-close-btn').click();
} finally {
  await browser?.close().catch(() => {});
  await new Promise(ok => setTimeout(ok, 1200));
  if (appProcess.exitCode === null) appProcess.kill();
}
