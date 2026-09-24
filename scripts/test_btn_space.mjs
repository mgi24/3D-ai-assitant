import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage();
await page.setContent(`
  <button id="btn">Button</button>
  <script>
    let clickCount = 0;
    let keydownCount = 0;
    const btn = document.getElementById("btn");
    btn.onclick = () => { clickCount++; console.log("CLICK:", clickCount); };
    window.addEventListener("keydown", e => {
      if (e.code === "Space") {
        keydownCount++;
        console.log("KEYDOWN:", keydownCount);
        e.preventDefault();
      }
    });
  </script>
`);
page.on('console', msg => console.log(msg.text()));
await page.locator('#btn').focus();
await page.keyboard.press('Space');
await page.waitForTimeout(300);
await browser.close();
