import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { browserPath } from './browser-path.mjs';
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: browserPath(),
  args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto('http://127.0.0.1:4317');
await page.waitForFunction(() => document.body.dataset.avatar, { timeout: 30000 });
await page.waitForTimeout(2000);
console.log(JSON.stringify({ avatar: await page.evaluate(() => window.avatarInfo),
  avatarState: await page.getAttribute('body', 'data-avatar'), errors }));
await page.screenshot({ path: 'test-results/desktop.png' });
await page.getByRole('button', { name: 'Buka pengaturan' }).click();
await page.screenshot({ path: 'test-results/settings.png' });
await page.getByRole('button', { name: 'Tutup pengaturan' }).click();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
console.log(JSON.stringify({ mobileOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) }));
await browser.close();
