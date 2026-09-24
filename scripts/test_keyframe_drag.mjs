import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `keyframe-drag-${Date.now()}`;
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

  console.log('=== Testing Keyframe Drag in Pose Window (?poseBrowser=1) ===');
  const page = await context.newPage();
  await page.goto(`${base}/app/?poseBrowser=1`);
  await page.waitForFunction(() => document.body.classList.contains('pose-window'));
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });

  // 1. Select pose "wave"
  console.log('Test 1: Select pose "wave"');
  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForFunction(() => document.querySelectorAll('#pose-keyframe-track .pose-keyframe-marker').length >= 5);

  const markersCount = await page.locator('#pose-keyframe-track .pose-keyframe-marker').count();
  assert.equal(markersCount, 5, 'Wave pose should have 5 keyframe markers (0, 0.3, 0.6, 0.9, 1.2)');
  console.log('  PASS: Wave pose has 5 markers');

  // 2. Normal click on the 0.3s marker (index 1) without drag
  console.log('Test 2: Normal click on 0.3s keyframe marker');
  const marker03 = page.locator('#pose-keyframe-track .pose-keyframe-marker').nth(1);
  assert.equal(await marker03.getAttribute('data-time'), '0.300');
  await marker03.click();
  await page.waitForFunction(() => document.querySelector('#pose-timeline-time')?.textContent?.startsWith('0.30s'));
  assert.ok((await page.locator('#pose-keyframe-info').textContent()).includes('0.30s'));
  console.log('  PASS: Normal click selected 0.30s without moving');

  // 3. Drag the 0.3s marker forward along the timeline
  console.log('Test 3: Drag keyframe marker from 0.30s to new position (~0.50s)');
  const markerBox = await marker03.boundingBox();
  assert.ok(markerBox, 'Marker bounding box must be available');

  const startX = markerBox.x + markerBox.width / 2;
  const startY = markerBox.y + markerBox.height / 2;

  // Move mouse down
  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Move mouse incrementally by +50px
  await page.mouse.move(startX + 30, startY, { steps: 5 });
  await page.waitForTimeout(100);

  // Verify that live dragging shows dragging class and tooltip
  const isDraggingActive = await page.evaluate(() => {
    const draggingEl = document.querySelector('.pose-keyframe-marker.dragging');
    const trackDragging = document.querySelector('#pose-keyframe-track.dragging-keyframe');
    return Boolean(draggingEl && trackDragging);
  });
  assert.ok(isDraggingActive, 'Marker and track should have dragging classes active during drag');

  // Move mouse further to ~0.50s
  await page.mouse.move(startX + 60, startY, { steps: 5 });
  await page.waitForTimeout(100);

  const liveTime = await page.locator('#pose-timeline-time').textContent();
  console.log('  Live timeline time during drag:', liveTime);
  assert.ok(liveTime && !liveTime.startsWith('0.30s'), 'Timeline time should have updated away from 0.30s during drag');

  // Release mouse
  await page.mouse.up();
  await page.waitForTimeout(200);

  // Verify dragging ended and keyframe committed
  const newTimeText = await page.locator('#pose-timeline-time').textContent();
  const statusText = await page.locator('#pose-manager-status').textContent();
  console.log('  After drag - Timeline time:', newTimeText);
  console.log('  After drag - Status text:', statusText);
  assert.ok(/Keyframe digeser dari 0.30s/i.test(statusText), `Status should confirm keyframe drag, got: "${statusText}"`);

  // Verify keyframe time in draft changed
  const draftKeyframeMoved = await page.evaluate(() => {
    const diag = window.aichatPoseDiagnostics?.();
    const frames = diag?.poseEditor?.draft?.tracks?.rightHand || [];
    return frames.some(f => Number(f.time) > 0.34 && Number(f.time) < 0.65);
  });
  assert.ok(draftKeyframeMoved, 'Draft tracks should have the moved keyframe');
  console.log('  PASS: Keyframe drag committed successfully');

  // 4. Test Undo (Ctrl+Z) restores original 0.30s position
  console.log('Test 4: Undo (Ctrl+Z) restores keyframe back to 0.30s');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);

  const statusAfterUndo = await page.locator('#pose-manager-status').textContent();
  console.log('  Status after Undo:', statusAfterUndo);
  assert.ok(/Undo/i.test(statusAfterUndo));

  const hasOriginalKeyframe = await page.evaluate(() => {
    const marker = document.querySelectorAll('#pose-keyframe-track .pose-keyframe-marker')[1];
    return marker && Math.abs(Number(marker.dataset.time) - 0.3) < 0.01;
  });
  assert.ok(hasOriginalKeyframe, 'Marker at index 1 should be restored back to 0.30s');
  console.log('  PASS: Keyframe position restored via Undo');

  // 5. Test Redo (Ctrl+Y) re-applies the drag
  console.log('Test 5: Redo (Ctrl+Y) re-applies keyframe drag');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(200);

  const statusAfterRedo = await page.locator('#pose-manager-status').textContent();
  console.log('  Status after Redo:', statusAfterRedo);
  assert.ok(/Redo/i.test(statusAfterRedo));
  console.log('  PASS: Redo re-applied keyframe drag');

  // 6. Test Escape cancels ongoing drag
  console.log('Test 6: Escape cancels ongoing drag');
  const markerCurrent = page.locator('#pose-keyframe-track .pose-keyframe-marker').nth(1);
  const currentBox = await markerCurrent.boundingBox();
  const cX = currentBox.x + currentBox.width / 2;
  const cY = currentBox.y + currentBox.height / 2;

  await page.mouse.move(cX, cY);
  await page.mouse.down();
  await page.mouse.move(cX + 50, cY, { steps: 5 });
  await page.waitForTimeout(100);

  // Press Escape while dragging
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(200);

  const statusAfterEscape = await page.locator('#pose-manager-status').textContent();
  console.log('  Status after Escape cancel:', statusAfterEscape);
  assert.ok(/dibatalkan/i.test(statusAfterEscape), 'Status should indicate drag was cancelled');
  console.log('  PASS: Drag cancelled cleanly on Escape');

  // 7. Space key still pauses/resumes cleanly
  console.log('Test 7: Space key toggles pause/resume after keyframe interactions');
  assert.equal(await page.locator('#pose-timeline-state').textContent(), 'Paused');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Looping');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '⏸ Pause');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#pose-timeline-state')?.textContent === 'Paused');
  assert.equal(await page.locator('#pose-preview-btn').textContent(), '▶ Resume');
  console.log('  PASS: Space key pause/resume works properly');

  console.log('\n=== Testing Keyframe Drag in Modal Dialog Mode ===');
  const mainPage = await context.newPage();
  await mainPage.goto(`${base}/app/`);
  await mainPage.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });
  await mainPage.locator('#desktop-pose-btn').click();
  await mainPage.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true);
  await mainPage.waitForFunction(() => /siap/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });

  console.log('Test 8: Modal dialog drag keyframe marker');
  await mainPage.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await mainPage.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await mainPage.waitForFunction(() => document.querySelectorAll('#pose-keyframe-track .pose-keyframe-marker').length >= 5);

  const modalMarker = mainPage.locator('#pose-keyframe-track .pose-keyframe-marker').nth(1);
  const mBox = await modalMarker.boundingBox();
  const mX = mBox.x + mBox.width / 2;
  const mY = mBox.y + mBox.height / 2;

  await mainPage.mouse.move(mX, mY);
  await mainPage.mouse.down();
  await mainPage.mouse.move(mX + 50, mY, { steps: 5 });
  await mainPage.waitForTimeout(100);
  await mainPage.mouse.up();
  await mainPage.waitForTimeout(200);

  const modalStatus = await mainPage.locator('#pose-manager-status').textContent();
  console.log('  Modal status after drag:', modalStatus);
  assert.ok(/Keyframe digeser dari 0.30s/i.test(modalStatus));
  console.log('  PASS: Modal dialog keyframe drag works');

  await browser.close();
  console.log('\n*** ALL KEYFRAME DRAG TESTS PASSED! ***');
} finally {
  server.kill();
}
