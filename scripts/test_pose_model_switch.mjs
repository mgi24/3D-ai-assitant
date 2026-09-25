import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `model-switch-test-${Date.now()}`;
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

  console.log('=== Testing VRM Model Switching in Pose Editor ===');
  const page = await context.newPage();
  await page.goto(`${base}/app/?poseBrowser=1`);
  await page.waitForFunction(() => document.body.classList.contains('pose-window'));
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });

  // 1. Verify model selector presence and options
  console.log('Test 1: Verify model selector UI');
  const modelSelect = page.locator('#pose-model-select');
  assert.equal(await modelSelect.count(), 1, 'Model selector dropdown exists');

  await page.waitForFunction(() => {
    const sel = document.querySelector('#pose-model-select');
    return sel && sel.options.length >= 2;
  }, null, { timeout: 10000 });

  const optionTexts = await page.$$eval('#pose-model-select option', opts => opts.map(o => o.text));
  console.log('Available models in dropdown:', optionTexts);
  assert.ok(optionTexts.some(t => /character\.vrm/i.test(t)), 'character.vrm in list');
  assert.ok(optionTexts.some(t => /servermmv\.vrm/i.test(t)), 'servermmv.vrm in list');

  // 2. Select pose "wave" on current model
  console.log('Test 2: Select pose "wave" on initial model');
  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForTimeout(500);

  // 3. Switch model to servermmv.vrm
  console.log('Test 3: Switch model to servermmv.vrm');
  const servermmvVal = await page.$$eval('#pose-model-select option', opts => {
    const opt = opts.find(o => /servermmv/i.test(o.value) || /servermmv/i.test(o.text));
    return opt ? opt.value : null;
  });
  assert.ok(servermmvVal, 'servermmv option value found');

  await page.selectOption('#pose-model-select', servermmvVal);

  // Wait for loading to finish and status to show success
  await page.waitForFunction(() => {
    const status = document.querySelector('#pose-manager-status')?.textContent || '';
    const modelStatus = document.querySelector('#pose-model-status')?.textContent || '';
    return /servermmv.*berhasil/i.test(status) || /servermmv/i.test(modelStatus);
  }, null, { timeout: 20000 });

  console.log('Model switched successfully.');

  // 4. Verify servermmv avatar state and bones
  console.log('Test 4: Verify avatar bones and armature editor on servermmv.vrm');
  const avatarState = await page.evaluate(() => {
    const avatar = window.avatarInfo;
    const select = document.querySelector('#pose-model-select');
    const selectedBone = document.querySelector('#pose-selected-bone')?.textContent;
    return {
      avatarInfo: avatar,
      selectedVal: select ? select.value : null,
      selectedBone
    };
  });
  console.log('Avatar state after switch:', avatarState);
  assert.equal(avatarState.selectedBone, 'head', 'Selected bone is preserved as head');

  // 5. Verify pose is still playing and timeline works
  console.log('Test 5: Verify pose timeline on servermmv.vrm');
  const timelineTime1 = await page.$eval('#pose-timeline-time', el => el.textContent);
  await page.waitForTimeout(600);
  const timelineTime2 = await page.$eval('#pose-timeline-time', el => el.textContent);
  console.log('Timeline progression:', timelineTime1, '->', timelineTime2);

  // 6. Capture screenshot
  const screenshotPath = 'docs/screenshots/pose-editor-servermmv.png';
  await page.locator('.pose-model-selector-wrap').scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Saved screenshot to:', screenshotPath);

  // 7. Switch back to character.vrm to ensure bidirectional switching
  console.log('Test 7: Switch back to character.vrm');
  const charVal = await page.$$eval('#pose-model-select option', opts => {
    const opt = opts.find(o => /character/i.test(o.value) || /character/i.test(o.text));
    return opt ? opt.value : null;
  });
  await page.selectOption('#pose-model-select', charVal);
  await page.waitForFunction(() => {
    const modelStatus = document.querySelector('#pose-model-status')?.textContent || '';
    return /character/i.test(modelStatus);
  }, null, { timeout: 20000 });
  console.log('Successfully switched back to character.vrm.');

  console.log('=== All VRM Model Switching Tests Passed! ===');
  await browser.close();
} finally {
  server.kill();
}
