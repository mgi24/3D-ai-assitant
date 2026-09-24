import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : 'python3';
const token = `copy-paste-${Date.now()}`;
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

  console.log('=== Testing Keyframe Multi-Selection, Copy/Paste & Auto-Extend Duration ===');
  const page = await context.newPage();
  await page.goto(`${base}/app/?poseBrowser=1`);
  await page.waitForFunction(() => document.body.classList.contains('pose-window'));
  await page.waitForFunction(() => document.querySelector('#pose-browser-dialog')?.open === true, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pose-preview-stage canvas') && !/gagal/i.test(document.querySelector('#pose-manager-status')?.textContent || ''), null, { timeout: 30000 });

  // 1. Select pose "wave" (duration 1.2s, 5 keyframes: 0, 0.3, 0.6, 0.9, 1.2)
  console.log('Test 1: Select pose "wave"');
  await page.locator('#pose-cards .pose-card[data-pose="wave"]').click();
  await page.waitForFunction(() => document.querySelector('#pose-preview-title')?.textContent === 'wave');
  await page.waitForFunction(() => document.querySelectorAll('#pose-keyframe-track .pose-keyframe-marker').length === 5);

  const initialDiag = await page.evaluate(() => window.aichatPoseDiagnostics());
  const initialDuration = Number(initialDiag.poseEditor.draft.duration);
  assert.equal(initialDuration, 1.2, 'Initial duration of wave should be 1.2s');
  console.log('  PASS: Wave selected, duration is 1.2s, 5 keyframes present');

  // Verify buttons exist in DOM
  const copyBtn = page.locator('#pose-copy-keyframe-btn');
  const pasteBtn = page.locator('#pose-paste-keyframe-btn');
  assert.equal(await copyBtn.count(), 1, 'Copy button exists');
  assert.equal(await pasteBtn.count(), 1, 'Paste button exists');
  assert.equal(await pasteBtn.isDisabled(), true, 'Paste button disabled when clipboard is empty');

  // 2. Perform Marquee drag selection across 0.20s to 0.70s to select 0.3s and 0.6s
  // 0.3s is 25% (0.3/1.2), 0.6s is 50% (0.6/1.2)
  console.log('Test 2: Marquee drag selection on timeline track');
  const track = page.locator('#pose-keyframe-track');
  const trackBox = await track.boundingBox();
  assert.ok(trackBox, 'Track bounding box exists');

  const startX = trackBox.x + trackBox.width * 0.20;
  const startY = trackBox.y + 3; // above marker center line so not clicking marker directly
  const endX = trackBox.x + trackBox.width * 0.55;
  const endY = trackBox.y + 3;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });

  const hasMarqueeEl = await page.locator('.pose-keyframe-marquee').count();
  assert.equal(hasMarqueeEl, 1, 'Marquee rectangle div must exist during drag');
  
  // Verify marquee starts below the range slider (#pose-timeline-range) and spans down through the keyframe track
  const rangeEl = page.locator('#pose-timeline-range');
  const rangeBox = await rangeEl.boundingBox();
  const marqueeBox = await page.locator('.pose-keyframe-marquee').boundingBox();
  assert.ok(marqueeBox.y >= rangeBox.y + 10, `Marquee y (${marqueeBox.y}) must start below range slider (${rangeBox.y})`);
  
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() || '');
  assert.equal(selectionText, '', 'No native text selection should occur during marquee drag');
  console.log('  PASS: Marquee rectangle visible below scrubber slider, native text selection prevented');

  await page.mouse.up();
  await page.waitForTimeout(200);

  const diagAfterMarquee = await page.evaluate(() => window.aichatPoseDiagnostics());
  console.log('  Selected times after marquee:', diagAfterMarquee.poseEditor.selectedTimes);
  assert.ok(diagAfterMarquee.poseEditor.selectedTimes.includes(0.3), '0.3s should be selected');
  assert.ok(diagAfterMarquee.poseEditor.selectedTimes.includes(0.6), '0.6s should be selected');
  assert.equal(diagAfterMarquee.poseEditor.selectedTimes.length, 2, 'Exactly 2 keyframes selected');

  const selectedMarkersCount = await page.locator('#pose-keyframe-track .pose-keyframe-marker.selected').count();
  assert.equal(selectedMarkersCount, 2, '2 markers should have .selected class');
  assert.equal(await copyBtn.isEnabled(), true, 'Copy button should now be enabled');
  console.log('  PASS: Marquee selection accurately selected 0.3s and 0.6s markers');

  // Test 2b: Marquee drag starting from bottom meta text area (.pose-timeline-meta)
  console.log('Test 2b: Marquee drag starting from bottom meta area');
  const metaEl = page.locator('.pose-timeline-meta');
  const metaBox = await metaEl.boundingBox();
  assert.ok(metaBox, 'Meta bounding box exists');
  await page.mouse.move(metaBox.x + metaBox.width * 0.45, metaBox.y + metaBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(metaBox.x + metaBox.width * 0.85, metaBox.y + metaBox.height * 0.5, { steps: 5 });
  assert.equal(await page.locator('.pose-keyframe-marquee').count(), 1, 'Marquee div appears when dragging from meta area');
  await page.mouse.up();
  await page.waitForTimeout(150);
  const diagMetaDrag = await page.evaluate(() => window.aichatPoseDiagnostics());
  console.log('  Selected times after meta drag:', diagMetaDrag.poseEditor.selectedTimes);
  assert.ok(diagMetaDrag.poseEditor.selectedTimes.includes(0.6), '0.6s selected from meta drag');
  assert.ok(diagMetaDrag.poseEditor.selectedTimes.includes(0.9), '0.9s selected from meta drag');
  console.log('  PASS: Drag selection from bottom meta area works seamlessly');

  // Test 2c: Timeline scrubber slider (#pose-timeline-range) is directly swiped/scrubbed and does NOT trigger marquee
  console.log('Test 2c: Swiping timeline slider directly scrubs time without triggering marquee');
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.5, rangeBox.y + rangeBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.8, rangeBox.y + rangeBox.height * 0.5, { steps: 5 });
  assert.equal(await page.locator('.pose-keyframe-marquee').count(), 0, 'No marquee should be created when dragging timeline slider');
  await page.mouse.up();
  await page.waitForTimeout(150);
  
  const timeText = await page.locator('#pose-timeline-time').textContent();
  console.log('  Timeline time after slider swipe:', timeText);
  assert.ok(!timeText.startsWith('0.00s'), 'Timeline scrubber moved position on drag');
  console.log('  PASS: Timeline slider swiped directly and scrubbed animation successfully');

  // Re-select 0.3s and 0.6s via keyframe track marquee for subsequent copy-paste tests
  const trackBoxFresh = await track.boundingBox();
  await page.mouse.move(trackBoxFresh.x + trackBoxFresh.width * 0.20, trackBoxFresh.y + 3);
  await page.mouse.down();
  await page.mouse.move(trackBoxFresh.x + trackBoxFresh.width * 0.55, trackBoxFresh.y + 3, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);



  // 3. Test Copy via keyboard shortcut (Ctrl+C) even when timeline slider has focus
  console.log('Test 3: Copy keyframes via Ctrl+C shortcut while slider is focused');
  await page.locator('#pose-timeline-range').focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(100);

  const diagAfterCopy = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.ok(diagAfterCopy.poseEditor.clipboard, 'Clipboard must not be null after Ctrl+C');
  assert.equal(diagAfterCopy.poseEditor.clipboard.count, 2, 'Clipboard count should be 2');
  assert.equal(diagAfterCopy.poseEditor.clipboard.span, 0.3, 'Clipboard span should be 0.3s');
  assert.equal(await pasteBtn.isEnabled(), true, 'Paste button should now be enabled');
  console.log('  PASS: Copied 2 keyframes to clipboard via Ctrl+C shortcut');

  // 4. Test Auto-Extend Duration on Paste
  // Current duration is 1.2s. Move to 1.1s.
  // With span = 0.3s, pasted keyframes will be at 1.1s and 1.4s!
  // Since 1.4s > 1.2s, duration MUST auto-extend to 1.4s!
  console.log('Test 4: Auto-extend duration on paste beyond timeline length');
  await page.evaluate(() => {
    // Select 1.10s
    const range = document.querySelector('#pose-timeline-range');
    range.value = '1.10';
    range.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await page.waitForFunction(() => document.querySelector('#pose-timeline-time')?.textContent?.startsWith('1.10s'));
  console.log('  Selected time set to 1.10s');

  // Paste using keyboard shortcut Ctrl+V
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);

  const diagAfterPaste = await page.evaluate(() => window.aichatPoseDiagnostics());
  const newDuration = Number(diagAfterPaste.poseEditor.draft.duration);
  console.log('  New duration after paste:', newDuration);
  assert.ok(newDuration >= 1.4, `Duration should auto-extend to at least 1.4s, got ${newDuration}`);

  const durationInputValue = await page.locator('#pose-duration').inputValue();
  assert.equal(Number(durationInputValue), newDuration, 'Duration input field #pose-duration must sync with extended duration');

  const markersCountAfterPaste = await page.locator('#pose-keyframe-track .pose-keyframe-marker').count();
  assert.ok(markersCountAfterPaste >= 7, `Expected at least 7 markers after paste, got ${markersCountAfterPaste}`);
  console.log(`  PASS: Duration automatically extended to ${newDuration}s, markers count increased to ${markersCountAfterPaste}`);

  // 5. Test Undo (Ctrl+Z) reverses paste AND duration extension
  console.log('Test 5: Undo reverses paste and restores previous duration');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);

  const diagAfterUndo = await page.evaluate(() => window.aichatPoseDiagnostics());
  const undoneDuration = Number(diagAfterUndo.poseEditor.draft.duration);
  assert.equal(undoneDuration, 1.2, `Undo must restore duration to 1.2s, got ${undoneDuration}`);
  assert.equal(Number(await page.locator('#pose-duration').inputValue()), 1.2, 'Duration input restored to 1.2s');
  assert.equal(await page.locator('#pose-keyframe-track .pose-keyframe-marker').count(), 5, 'Markers count restored to 5');
  console.log('  PASS: Undo restored duration and marker count');

  // 6. Test Redo (Ctrl+Y) restores paste and duration extension
  console.log('Test 6: Redo restores paste and duration extension');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(200);

  const diagAfterRedo = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(Number(diagAfterRedo.poseEditor.draft.duration), newDuration, 'Redo restores extended duration');
  assert.equal(await page.locator('#pose-keyframe-track .pose-keyframe-marker').count(), markersCountAfterPaste, 'Redo restores pasted markers');
  console.log('  PASS: Redo restored extended duration and markers');

  // 7. Test Select All (Ctrl+A) and Copy via Ctrl+C
  console.log('Test 7: Select all (Ctrl+A) and copy via Ctrl+C');
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);

  const diagAfterSelectAll = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(diagAfterSelectAll.poseEditor.selectedTimes.length, markersCountAfterPaste, 'Ctrl+A selects all markers');

  await page.keyboard.press('Control+c');
  await page.waitForTimeout(100);
  const diagAfterCtrlC = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(diagAfterCtrlC.poseEditor.clipboard.count, markersCountAfterPaste, 'Ctrl+C copied all markers');
  console.log('  PASS: Ctrl+A and Ctrl+C work smoothly');

  // 8. Test Multi-Keyframe Dragging
  console.log('Test 8: Multi-keyframe dragging with relative spacing');
  // First, select only 0.3s and 0.6s again using marquee
  const trackBox2 = await track.boundingBox();
  const startX2 = trackBox2.x + trackBox2.width * 0.20;
  const startY2 = trackBox2.y + 3;
  const endX2 = trackBox2.x + trackBox2.width * 0.55;
  const endY2 = trackBox2.y + 3;

  await page.mouse.move(startX2, startY2);
  await page.mouse.down();
  await page.mouse.move(endX2, endY2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const diagBeforeDrag = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(diagBeforeDrag.poseEditor.selectedTimes.length, 2, '2 keyframes selected for drag');

  // Drag marker 0.3s (which is around 25% of track) to the right by 10%
  // 0.3s should move to ~0.42s and 0.6s should move to ~0.72s
  const marker03 = page.locator('#pose-keyframe-track .pose-keyframe-marker').nth(1);
  const marker03Box = await marker03.boundingBox();
  assert.ok(marker03Box);

  await page.mouse.move(marker03Box.x + marker03Box.width / 2, marker03Box.y + marker03Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(marker03Box.x + marker03Box.width / 2 + trackBox2.width * 0.10, marker03Box.y + marker03Box.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const diagAfterDrag = await page.evaluate(() => window.aichatPoseDiagnostics());
  console.log('  Selected times after multi-drag:', diagAfterDrag.poseEditor.selectedTimes);
  const movedTimes = diagAfterDrag.poseEditor.selectedTimes.sort((a, b) => a - b);
  assert.equal(movedTimes.length, 2, 'Both keyframes still selected after multi-drag');
  assert.ok(movedTimes[0] > 0.35, `First keyframe moved from 0.3s to ${movedTimes[0]}`);
  assert.ok(movedTimes[1] > 0.65, `Second keyframe moved from 0.6s to ${movedTimes[1]}`);
  // Relative difference between the two moved keyframes should still be ~0.3s!
  const spacing = Number((movedTimes[1] - movedTimes[0]).toFixed(2));
  assert.equal(spacing, 0.3, `Relative spacing must be preserved (0.3s), got ${spacing}`);
  console.log('  PASS: Multi-drag moved both keyframes maintaining 0.3s spacing');

  // Test Undo on multi-drag
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const diagUndoDrag = await page.evaluate(() => {
    const draft = window.aichatPoseDiagnostics().poseEditor.draft;
    const allTimes = [];
    for (const group of ['tracks', 'positionTracks', 'expressionTracks']) {
      for (const frames of Object.values(draft[group] || {})) {
        for (const f of frames || []) allTimes.push(Number(f.time));
      }
    }
    return allTimes;
  });
  assert.ok(diagUndoDrag.some(t => Math.abs(t - 0.3) < 0.01), '0.3s restored after undo');
  assert.ok(diagUndoDrag.some(t => Math.abs(t - 0.6) < 0.01), '0.6s restored after undo');
  console.log('  PASS: Undo restored keyframes to original positions');

  // 9. Test Shift-click multi-selection and drag
  console.log('Test 9: Shift-click multi-selection without double-toggle, and multi-drag');
  // First, click marker 0 (0.0s) without Shift -> selects ONLY 0.0s
  const marker00 = page.locator('#pose-keyframe-track .pose-keyframe-marker').nth(0);
  await marker00.click();
  await page.waitForTimeout(100);
  let diagShift = await page.evaluate(() => window.aichatPoseDiagnostics());
  assert.equal(diagShift.poseEditor.selectedTimes.length, 1);
  assert.equal(diagShift.poseEditor.selectedTimes[0], 0);

  // Now hold Shift and click marker 1 (0.3s)
  await page.keyboard.down('Shift');
  await marker03.click();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);

  diagShift = await page.evaluate(() => window.aichatPoseDiagnostics());
  console.log('  Selected times after Shift-click:', diagShift.poseEditor.selectedTimes);
  assert.equal(diagShift.poseEditor.selectedTimes.length, 2, 'Shift-click should select 2 keyframes (0.0s and 0.3s)');
  assert.ok(diagShift.poseEditor.selectedTimes.includes(0));
  assert.ok(diagShift.poseEditor.selectedTimes.includes(0.3));

  // Now drag marker 0.3s to the right by ~6% of track width
  const marker03BoxNow = await marker03.boundingBox();
  await page.mouse.move(marker03BoxNow.x + marker03BoxNow.width / 2, marker03BoxNow.y + marker03BoxNow.height / 2);
  await page.mouse.down();
  await page.mouse.move(marker03BoxNow.x + marker03BoxNow.width / 2 + trackBox2.width * 0.08, marker03BoxNow.y + marker03BoxNow.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const diagAfterShiftDrag = await page.evaluate(() => window.aichatPoseDiagnostics());
  const movedShiftTimes = diagAfterShiftDrag.poseEditor.selectedTimes.sort((a, b) => a - b);
  console.log('  Selected times after Shift-click multi-drag:', movedShiftTimes);
  assert.equal(movedShiftTimes.length, 2, 'Both keyframes still selected after dragging Shift-clicked markers');
  assert.ok(movedShiftTimes[0] > 0, `First keyframe moved from 0s to ${movedShiftTimes[0]}`);
  assert.ok(movedShiftTimes[1] > 0.3, `Second keyframe moved from 0.3s to ${movedShiftTimes[1]}`);
  const shiftSpacing = Number((movedShiftTimes[1] - movedShiftTimes[0]).toFixed(2));
  assert.equal(shiftSpacing, 0.3, 'Relative spacing 0.3s between 0.0s and 0.3s preserved');
  console.log('  PASS: Shift-click selected 2 keyframes and both moved together smoothly!');

  console.log('=== ALL COPY/PASTE & AUTO-EXTEND KEYFRAME TESTS PASSED ===');
  await browser.close();
} finally {
  server.kill();
}
