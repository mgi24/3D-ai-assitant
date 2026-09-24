import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : process.env.PYTHON || 'python3';
const token = `pose-browser-test-${Date.now()}`;
const probe = createServer();
await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
const base = `http://127.0.0.1:${port}`;
const server = spawn(python, [join(root, 'server.py')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PORT: String(port), AICHAT_DESKTOP_TOKEN: token }
});
let browser;
async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${base}/api/desktop-ready`, { headers: { 'X-AICHAT-Desktop-Token': token } });
      if (response.ok) return;
    } catch { }
    await new Promise(ok => setTimeout(ok, 120));
  }
  throw new Error('Test server did not become ready.');
}

try {
  await mkdir('test-results', { recursive: true });
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: browserPath(), args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const session = await context.request.post(`${base}/api/desktop-session`, { headers: { 'X-AICHAT-Desktop-Token': token } });
  assert.equal(session.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(`${base}/app/`);
  await page.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });

  assert.equal(await page.locator('#settings-dialog #pose-cards').count(), 0, 'Pose library must be outside Settings');
  await page.locator('#desktop-pose-btn').click();
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true);
  await page.waitForFunction(() => document.querySelectorAll('#pose-cards .pose-card').length >= 8, null, { timeout: 30000 });
  assert.equal(await page.locator('#pose-browser-dialog #pose-cards .pose-card').count(), 8);
  assert.equal(await page.locator('#pose-keyframe-editor').count(), 0, 'Legacy per-bone numeric editor must be removed');
  assert.equal(await page.locator('#pose-rotate-tool').isVisible(), true);
  assert.equal(await page.locator('#pose-move-tool').count(), 0, 'Move tool is intentionally not exposed yet');
  assert.equal(await page.locator('.pose-timeline #pose-keyframe-track').count(), 1, 'Playback and keyframe timelines must be combined');
  await page.waitForFunction(() => /siap/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });
  await page.screenshot({ path: 'test-results/pose-browser-ready.png', fullPage: false });
  await page.screenshot({ path: 'test-results/pose-browser.png', fullPage: false });

  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForFunction(() => document.querySelectorAll('#pose-preview-stage canvas').length === 1, null, { timeout: 30000 });
  await page.waitForFunction(() => document.body.dataset.pose?.includes('wave'), null, { timeout: 5000 });
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  assert.equal(await page.locator('#pose-preview-btn').isDisabled(), false);
  assert.equal(await page.locator('#pose-stop-preview-btn').count(), 0, 'Playback must use one toggle button');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  await page.locator('.pose-keyframe-marker').first().focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  const panBefore = await page.evaluate(() => window.aichatPoseDiagnostics());
  const previewBox = await page.locator('#pose-preview-stage canvas').boundingBox();
  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(previewBox.x + previewBox.width / 2 + 44, previewBox.y + previewBox.height / 2 - 38, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const panAfter = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.notDeepEqual(panBefore.target, panAfter.target, 'Right drag must pan the preview target');
  for (let frame = 0; frame < 4; frame++) {
    await page.screenshot({ path: `test-results/pose-browser-wave-${frame}.png`, fullPage: false });
    await page.waitForTimeout(300);
  }
  await page.locator('#pose-preview-btn').click();
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  const pausedTime = await page.locator('#pose-timeline-time').textContent();
  // Give the renderer one frame to snap the armature to the selected paused sample.
  await page.waitForTimeout(200);
  const pausedRotations = await page.evaluate(() => window.aichatPoseDiagnostics().boneRotations);
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#pose-timeline-time').textContent(), pausedTime);
  const resumedRotations = await page.evaluate(() => window.aichatPoseDiagnostics().boneRotations);
  const rotationDelta = Object.keys(pausedRotations).reduce((largest, name) => {
    const before = pausedRotations[name] || [];
    const after = resumedRotations[name] || [];
    return Math.max(largest, ...before.map((value, index) => Math.abs(value - (after[index] ?? value))));
  }, 0);
  assert.ok(rotationDelta < 0.003, `Paused preview still changed armature (delta ${rotationDelta})`);
  await page.locator('#pose-preview-btn').click();
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  await page.locator('#pose-timeline-range').evaluate((element) => {
    element.value = '0.70';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#pose-timeline-time')?.textContent.startsWith('0.70s'));
  await page.waitForTimeout(600);

  await page.locator('#pose-cards .pose-card[data-pose="talk"]').click();
  await page.waitForFunction(() => document.body.dataset.pose?.includes('talk'), null, { timeout: 5000 });
  await page.locator('#pose-timeline-range').evaluate((element) => {
    element.value = '0.20';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const diagnostics = window.aichatPoseDiagnostics();
    return diagnostics.preview?.name === 'talk'
      && Number(diagnostics.mouth?.pose?.aa || 0) > 0.6
      && Number(diagnostics.mouth?.expressions?.aa || 0) > 0.6;
  }, null, { timeout: 5000 });
  await page.screenshot({ path: 'test-results/pose-browser-talk-mouth.png', fullPage: false });

  // Use idle for the editor check because it has several head keyframes with
  // different rotations, which makes one-shot Apply all propagation visible.
  await page.locator('#pose-cards .pose-card[data-pose="idle"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'idle');
  await page.locator('#pose-add-btn').click();
  await page.locator('#pose-name').fill('verify_pose_browser');
  assert.equal(await page.locator('#pose-armature-toolbar').isVisible(), true);
  const armature = await page.evaluate(() => window.aichatPoseDiagnostics().armature);
  assert.equal(armature.visible, true);
  assert.ok(armature.boneCount >= 8);
  assert.equal(await page.locator('#pose-reset-bone-btn').isVisible(), true);
  assert.equal(await page.locator('#pose-reset-bone-btn').isDisabled(), false);
  assert.equal(await page.locator('#pose-undo-btn').isDisabled(), true);
  assert.equal(await page.locator('#pose-redo-btn').isDisabled(), true);
  await page.locator('#pose-preview-btn').click();
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  await page.locator('#pose-timeline-range').evaluate((element) => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#pose-timeline-time')?.textContent.startsWith('0.00s'));
  const beforeApplyReset = await page.evaluate(() => window.aichatPoseDiagnostics().poseEditor.selectedBoneTrack);
  assert.ok(new Set(beforeApplyReset.map(frame => JSON.stringify(frame.rotation))).size > 1, 'Editor fixture must have differing following keyframes');
  await page.locator('#pose-reset-bone-btn').click();
  const beforeApply = await page.evaluate(() => window.aichatPoseDiagnostics().poseEditor.selectedBoneTrack);
  assert.ok(new Set(beforeApply.map(frame => JSON.stringify(frame.rotation))).size > 1, 'Reset must affect only the active keyframe before Apply all');
  assert.equal(await page.locator('#pose-apply-all-keyframes-btn').getAttribute('aria-pressed'), null);
  await page.locator('#pose-apply-all-keyframes-btn').click();
  const appliedTrack = await page.evaluate(() => window.aichatPoseDiagnostics().poseEditor.selectedBoneTrack);
  assert.equal(new Set(appliedTrack.map(frame => JSON.stringify(frame.rotation))).size, 1, 'One-shot Apply all must update following keyframes for the selected bone');
  assert.equal(await page.locator('#pose-apply-all-keyframes-btn').textContent(), '⇢ Apply all');
  await page.waitForFunction(() => window.aichatPoseDiagnostics().poseEditor.undoDepth >= 1);
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(() => window.aichatPoseDiagnostics().poseEditor.redoDepth >= 1);
  await page.keyboard.press('Control+Y');
  await page.waitForFunction(() => window.aichatPoseDiagnostics().poseEditor.redoDepth === 0);
  await page.locator('#pose-rotate-tool').click();
  assert.equal(await page.locator('#pose-rotate-tool').evaluate(element => element.classList.contains('active')), true);
  const markerCountBeforeDelete = await page.locator('.pose-keyframe-marker').count();
  await page.locator('.pose-keyframe-marker').first().click();
  assert.equal(await page.locator('#pose-preview-delete-keyframe-btn').isDisabled(), false);
  await page.locator('#pose-preview-delete-keyframe-btn').click();
  await page.waitForFunction((count) => document.querySelectorAll('.pose-keyframe-marker').length < count, markerCountBeforeDelete);
  await page.locator('#pose-insert-keyframe').click();
  assert.ok(await page.locator('.pose-keyframe-marker').count() >= 1);
  assert.equal(await page.evaluate(() => Object.prototype.hasOwnProperty.call(JSON.parse(localStorage.getItem('aichat-pose-overrides') || '{}'), 'verify_pose_browser')), false);
  await page.locator('#pose-save-btn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#pose-cards .pose-card')].some(card => card.dataset.pose === 'verify_pose_browser'));
  assert.equal(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('aichat-pose-overrides') || '{}').verify_pose_browser?.tracks || {}).some(frames => frames.length > 0)), true);
  await page.screenshot({ path: 'test-results/pose-browser-editor.png', fullPage: false });

  const poseWindowPage = await context.newPage();
  const poseWindowErrors = [];
  poseWindowPage.on('pageerror', error => poseWindowErrors.push(error.stack || error.message));
  await poseWindowPage.goto(`${base}/app/?poseBrowser=1`);
  await poseWindowPage.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });
  await poseWindowPage.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await poseWindowPage.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await poseWindowPage.evaluate(() => document.body.classList.contains('pose-window')), true);
  assert.equal(await poseWindowPage.evaluate(() => getComputedStyle(document.querySelector('#app')).display), 'none');
  assert.ok(await poseWindowPage.evaluate(() => document.querySelector('#pose-browser-dialog').getBoundingClientRect().width > 900));
  await poseWindowPage.screenshot({ path: 'test-results/pose-browser-window.png', fullPage: false });
  assert.deepEqual(poseWindowErrors, [], 'Pose Browser window route must not introduce browser errors');

  assert.deepEqual(errors, [], 'Pose Browser must not introduce browser errors');
  console.log(JSON.stringify({ passed: true, cards: await page.locator('#pose-cards .pose-card').count(), preview: 'talk', mouth: 'expressionTracks', customSaved: true, errors }));
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    await new Promise(ok => { server.once('exit', ok); server.kill(); setTimeout(ok, 1500); });
  }
}
