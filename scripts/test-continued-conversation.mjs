import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';
const browser = await chromium.launch({ headless: true,
  executablePath: browserPath(),
  args: ['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve('test-results/microphone-fixture.wav')}`] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
try {
  await page.goto('http://127.0.0.1:4317/?diagnostics=1');
  await page.waitForFunction(() => document.body.dataset.avatar === 'ready');
  // Reuse the already tested real providers; this test isolates playback completion and rearming.
  await page.route('**/api/stt', route => route.fulfill({json:{text:'Halo, siapa namamu?',latencyMs:1}}));
  await page.route('**/api/chat', route => route.fulfill({json:{text:'Hai, aku Mamad. Senang bertemu denganmu.',emotion:'happy',gesture:'wave',latencyMs:1}}));
  await page.getByLabel('Percakapan berlanjut').check();
  await page.waitForFunction(() => document.body.dataset.state === 'listening');
  await page.getByRole('button', {name:'Selesai bicara MIC'}).click();
  await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, {timeout:40000});
  await page.waitForFunction(() => document.body.dataset.state === 'listening', null, {timeout:20000});
  assert.equal(await page.evaluate(() => window.aichatDiagnostics().microphoneActive), true);
  await page.getByRole('button', {name:'■ Stop percakapan',exact:true}).click();
  await page.waitForTimeout(300);
  const stopped = await page.evaluate(() => window.aichatDiagnostics());
  assert.equal(stopped.microphoneActive,false);
  assert.equal(stopped.state,'idle');
  console.log('PASS: playback completes, continuous conversation rearms the microphone, stop closes it.');
  await writeFile('test-results/continued-conversation.json', JSON.stringify({passed:true, stopped},null,2));
} finally { await browser.close(); }
