import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `interp-test-${Date.now()}`;
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

  console.log('=== Testing Keyframe Interpolation Feature ===');
  const page = await context.newPage();
  await page.goto(`${base}/app/?poseBrowser=1`);
  await page.waitForFunction(() => document.body.classList.contains('pose-window'));
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });

  // 1. Select pose "wave"
  console.log('Test 1: Select pose "wave"');
  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForFunction(() => document.querySelectorAll('#pose-keyframe-track .pose-keyframe-marker').length === 5);

  const interpSelect = page.locator('#pose-keyframe-interpolation');
  assert.equal(await interpSelect.count(), 1, 'Interpolation select element exists');

  // 2. Click keyframe at 0.3s
  console.log('Test 2: Click keyframe marker at 0.3s');
  const marker03 = page.locator('.pose-keyframe-marker[data-time="0.300"]');
  await marker03.click();
  await page.waitForTimeout(100);

  // Dropdown should be enabled and default to "linear"
  assert.equal(await interpSelect.isDisabled(), false, 'Interpolation select is enabled for selected keyframe');
  assert.equal(await interpSelect.inputValue(), 'linear', 'Default interpolation is linear');

  // 3. Change interpolation to "easeInOut"
  console.log('Test 3: Change interpolation to "easeInOut"');
  await interpSelect.selectOption('easeInOut');
  await page.waitForTimeout(100);

  let diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  let kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  assert.equal(kf03?.interpolation, 'easeInOut', 'Draft rightUpperArm keyframe at 0.3s has interpolation easeInOut');
  assert.equal(await marker03.getAttribute('data-interpolation'), 'easeInOut', 'Marker data-interpolation updated');
  const tooltipText = await marker03.locator('.pose-keyframe-tooltip').textContent();
  assert.ok(tooltipText?.includes('easeInOut'), `Tooltip contains easeInOut: ${tooltipText}`);

  // Capture screenshot of UI
  await page.screenshot({ path: 'C:/Users/Workload17/.gemini/antigravity-ide/brain/727b2c80-a5f0-426f-93b9-a318a6866fcb/keyframe_interpolation_ui.png' });

  // 4. Change interpolation to "step"
  console.log('Test 4: Change interpolation to "step"');
  await interpSelect.selectOption('step');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  assert.equal(kf03?.interpolation, 'step', 'Draft keyframe at 0.3s has interpolation step');

  // 5. Test Undo (Ctrl+Z)
  console.log('Test 5: Test Undo to revert to easeInOut');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  assert.equal(kf03?.interpolation, 'easeInOut', 'After undo, keyframe at 0.3s reverted to easeInOut');
  assert.equal(await interpSelect.inputValue(), 'easeInOut', 'Dropdown reflects easeInOut after undo');

  // 6. Test Redo (Ctrl+Y)
  console.log('Test 6: Test Redo to restore step');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  assert.equal(kf03?.interpolation, 'step', 'After redo, keyframe at 0.3s is step');
  assert.equal(await interpSelect.inputValue(), 'step', 'Dropdown reflects step after redo');

  // 7. Change back to "linear"
  console.log('Test 7: Change back to "linear"');
  await interpSelect.selectOption('linear');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  assert.ok(!kf03?.interpolation || kf03?.interpolation === 'linear', 'Draft keyframe interpolation is linear or removed');

  // 8. Multi-selection: Select 0.3s and 0.6s
  console.log('Test 8: Multi-selection interpolation update');
  await marker03.click();
  await page.waitForTimeout(50);
  const marker06 = page.locator('.pose-keyframe-marker[data-time="0.600"]');
  // Shift-click marker 0.6s
  await page.keyboard.down('Shift');
  await marker06.click();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(diag.poseEditor.selectedTimes.length, 2, 'Two keyframes selected');

  // Set interpolation to "easeOut" for both
  await interpSelect.selectOption('easeOut');
  await page.waitForTimeout(100);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  kf03 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.3) < 0.01);
  const kf06 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 0.6) < 0.01);
  assert.equal(kf03?.interpolation, 'easeOut', '0.3s keyframe updated to easeOut');
  assert.equal(kf06?.interpolation, 'easeOut', '0.6s keyframe updated to easeOut');

  // 9. Copy & Paste keyframes with interpolation preserved
  console.log('Test 9: Copy and Paste keyframes preserves interpolation');
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(100);

  // Seek to 1.0s
  await page.evaluate(() => {
    const range = document.querySelector('#pose-timeline-range');
    range.value = '1.00';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(100);

  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);

  diag = await page.evaluate(() => window.aichatPoseDiagnostics());
  const pasted0 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 1.0) < 0.02);
  const pasted1 = diag.poseEditor.draft.tracks.rightHand?.find(f => Math.abs(f.time - 1.3) < 0.02);
  assert.ok(pasted0, 'Pasted keyframe at 1.0s exists');
  assert.ok(pasted1, 'Pasted keyframe at 1.3s exists');
  assert.equal(pasted0.interpolation, 'easeOut', 'Pasted keyframe 0 preserved easeOut interpolation');
  assert.equal(pasted1.interpolation, 'easeOut', 'Pasted keyframe 1 preserved easeOut interpolation');

  console.log('=== All Keyframe Interpolation Tests PASSED Successfully! ===');
  await browser.close();
  server.kill();
  process.exit(0);
} catch (err) {
  console.error('Test Failed:', err);
  server.kill();
  process.exit(1);
}
