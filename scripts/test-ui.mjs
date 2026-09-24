import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: browserPath(),
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('test-results/microphone-fixture.wav')}`] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [], requests = [], states = [], mouth = [], timings = {};
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
page.on('response', async response => {
  if (response.url().endsWith('/api/stt') || response.url().endsWith('/api/chat')) {
    try { timings[new URL(response.url()).pathname] = await response.json(); } catch {}
  }
});
const started = Date.now();
try {
  await page.goto('http://127.0.0.1:4317/?diagnostics=1');
  await page.waitForFunction(() => document.body.dataset.avatar === 'ready', null, { timeout: 30000 });
  const initial = await page.evaluate(() => window.aichatDiagnostics());
  assert.equal(initial.microphoneActive, false, 'Mic must be off at load');
  console.log('Avatar loaded:', JSON.stringify(initial));
  await page.getByRole('button', { name: '✦ Sapa', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/wave.png' });

  await page.getByLabel('Percakapan berlanjut').check();
  await page.waitForFunction(() => document.body.dataset.state === 'listening');
  assert.equal(await page.evaluate(() => window.aichatDiagnostics().microphoneActive), true);
  console.log('Synthetic microphone is recording.');
  // Collect visible states and mouth values throughout a real STT -> LLM -> TTS turn.
  let sawSpeaking = false, captured = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const diag = await page.evaluate(() => window.aichatDiagnostics());
    if (states.at(-1) !== diag.state) { states.push(diag.state); console.log('State:', diag.state); }
    mouth.push(diag.mouth);
    if (diag.state === 'speaking') {
      sawSpeaking = true;
      if (!captured && diag.mouth > 0.02) {
        await page.screenshot({ path: 'test-results/speaking.png' });
        captured = true;
        // Stop during playback and confirm there is no automatic microphone restart.
  await page.getByRole('button', { name: '■ Stop percakapan', exact: true }).click();
        break;
      }
    }
    const message = await page.locator('#notice').textContent();
    if (message && await page.locator('#notice').isVisible()) throw Error(message);
    await page.waitForTimeout(80);
  }
  assert.ok(sawSpeaking, 'Reply should reach audio playback');
  assert.ok(Math.max(...mouth) > 0.02, 'Real waveform must drive the VRM mouth');
  await page.waitForTimeout(1500);
  const afterStop = await page.evaluate(() => window.aichatDiagnostics());
  assert.equal(afterStop.state, 'idle');
  assert.equal(afterStop.microphoneActive, false);
  assert.equal(afterStop.mouth, 0);
  assert.equal(await page.getByLabel('Percakapan berlanjut').isChecked(), false);
  assert.ok(requests.includes('/api/stt') && requests.includes('/api/chat') && requests.includes('/api/tts'));
  assert.ok((await page.locator('.message.user').last().textContent()).length > 8);
  assert.equal(errors.length, 0, 'No browser exceptions');

  // Cancellation during a delayed response must not add a late answer or start TTS.
  const before = await page.locator('.message.assistant').count();
  await page.route('**/api/chat', async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ json: { text: 'This late answer must be discarded.', emotion: 'happy', gesture: 'wave', latencyMs: 800 } }).catch(() => {});
  });
  await page.locator('#chat-input').fill('Test cancellation');
  await page.getByRole('button', { name: 'Kirim pesan', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.state === 'thinking');
        await page.getByRole('button', { name: '■ Stop percakapan', exact: true }).click();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.message.assistant').count(), before);
  assert.equal(await page.getAttribute('body', 'data-state'), 'idle');
  await page.unroute('**/api/chat');

  await page.getByRole('button', { name: 'Buka pengaturan' }).click();
  await page.locator('#fps-setting').selectOption('15');
  await page.getByRole('button', { name: 'Tutup pengaturan' }).click();
  const frameStart = await page.evaluate(() => window.aichatDiagnostics().frames);
  await page.waitForTimeout(2000);
  const frameEnd = await page.evaluate(() => window.aichatDiagnostics().frames);
  const measuredFPS = (frameEnd - frameStart) / 2;
  assert.ok(measuredFPS <= 17, '15 FPS setting must limit renders');
  const report = { passed: true, durationSeconds: (Date.now() - started) / 1000,
    states, timings, maxMouth: Math.max(...mouth), measuredFPS, afterStop, errors };
  await writeFile('test-results/integration.json', JSON.stringify(report, null, 2));
  console.log('PASS:', JSON.stringify(report));
} finally { await browser.close(); }
