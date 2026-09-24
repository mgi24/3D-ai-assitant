import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `screenshot-cap-${Date.now()}`;
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
  
  // 1. Capture Desktop Assistant Window
  console.log('Capturing Desktop Assistant...');
  const contextMain = await browser.newContext({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 1.5 });
  await contextMain.request.post(`${base}/api/desktop-session`, { headers: { 'X-AICHAT-Desktop-Token': token } });
  const pageMain = await contextMain.newPage();
  await pageMain.goto(`${base}/app/`);
  await pageMain.waitForFunction(() => document.querySelector('#avatar-stage canvas'), null, { timeout: 30000 });
  await pageMain.waitForTimeout(2000); // let avatar settle in idle

  // Open chat conversation drawer if closed
  await pageMain.evaluate(() => {
    const drawer = document.querySelector('#conversation-drawer');
    if (drawer) drawer.classList.remove('desktop-closed');
    const toggle = document.querySelector('#desktop-chat-toggle');
    if (toggle) toggle.classList.add('active');
    
    // Add a sample conversation message for rich aesthetics
    const messages = document.querySelector('#messages');
    if (messages && messages.children.length === 0) {
      const uMsg = document.createElement('div');
      uMsg.className = 'message user';
      uMsg.innerHTML = '<span class="author">Anda</span><p>Halo Mamad, apa kabar hari ini?</p>';
      messages.appendChild(uMsg);

      const aMsg = document.createElement('div');
      aMsg.className = 'message assistant';
      aMsg.innerHTML = '<span class="author">Mamad</span><p>Halo! Kabar saya sangat baik dan siap menemani Anda beraktivitas. Ada yang bisa saya bantu?</p>';
      messages.appendChild(aMsg);
    }

    // Set a stylish clean dark desktop backdrop so the transparent floating avatar pops
    document.documentElement.style.setProperty('background', '#0f172a', 'important');
    document.body.style.setProperty('background', 'radial-gradient(circle at 50% 35%, #1e293b 0%, #090d16 100%)', 'important');
  });
  await pageMain.waitForTimeout(500);
  await pageMain.screenshot({ path: 'docs/screenshots/desktop-assistant.png' });
  console.log('Saved docs/screenshots/desktop-assistant.png');

  // 2. Capture Settings Dialog
  console.log('Capturing Settings Dialog...');
  await pageMain.evaluate(() => {
    const dialog = document.querySelector('#settings-dialog');
    dialog?.showModal();
    const hw = document.querySelector('#hardware-setting');
    if (hw) {
      hw.value = 'cuda:0';
      hw.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const stt = document.querySelector('#stt-model-setting');
    if (stt) {
      stt.value = 'small';
      stt.dispatchEvent(new Event('change', { bubbles: true }));
    }
    dialog.scrollTop = 380;
  });
  await pageMain.waitForTimeout(500);
  await pageMain.screenshot({ path: 'docs/screenshots/settings-panel.png' });
  console.log('Saved docs/screenshots/settings-panel.png');
  await contextMain.close();

  // 3. Capture 3D Pose Browser & Keyframe Editor
  console.log('Capturing 3D Pose Editor...');
  const contextPose = await browser.newContext({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 1.5 });
  await contextPose.request.post(`${base}/api/desktop-session`, { headers: { 'X-AICHAT-Desktop-Token': token } });
  const pagePose = await contextPose.newPage();
  await pagePose.goto(`${base}/app/?poseBrowser=1`);
  await pagePose.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await pagePose.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });
  
  // Select pose "wave"
  await pagePose.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await pagePose.waitForTimeout(500);

  // Click keyframe at 0.3s
  const marker03 = pagePose.locator('.pose-keyframe-marker[data-time="0.300"]');
  if (await marker03.count()) {
    await marker03.click();
    await pagePose.waitForTimeout(200);
  }
  
  // Set interpolation to easeInOut
  const interpSelect = pagePose.locator('#pose-keyframe-interpolation');
  if (await interpSelect.count()) {
    await interpSelect.selectOption('easeInOut');
    await pagePose.waitForTimeout(300);
  }

  // Hover over marker 0.3s so tooltip shows nicely
  if (await marker03.count()) {
    await marker03.hover();
    await pagePose.waitForTimeout(200);
  }

  await pagePose.screenshot({ path: 'docs/screenshots/pose-editor.png' });
  console.log('Saved docs/screenshots/pose-editor.png');
  await contextPose.close();

  console.log('=== All Screenshots Captured Successfully! ===');
  await browser.close();
  server.kill();
  process.exit(0);
} catch (err) {
  console.error('Capture Failed:', err);
  server.kill();
  process.exit(1);
}
