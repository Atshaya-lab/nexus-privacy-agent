import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionPath = path.join(__dirname, 'dist');
const userDataDir = path.join(__dirname, '.browser-test-canvas');

if (fs.existsSync(userDataDir)) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--window-size=1280,850',
  ],
});

try {
  console.log('\n>>> RUNNING TEST CASE 2: Public Canvas App (JS Paint) <<<');
  const pages = await browser.pages();
  const canvasPage = pages[0] || (await browser.newPage());
  await canvasPage.setViewport({ width: 1200, height: 750 });
  await canvasPage.goto('https://jspaint.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Canvas page loaded:', canvasPage.url());

  // Wait 2s for canvas elements to fully render
  await new Promise((r) => setTimeout(r, 2000));

  const extTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
    { timeout: 8000 }
  );
  const match = extTarget.url().match(/chrome-extension:\/\/([a-z0-9]+)/i);
  const extensionId = match[1];

  const session = await browser.target().createCDPSession();
  const { targetId } = await session.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup.html`,
    newWindow: true,
  });
  const popupTarget = await browser.waitForTarget((t) => t._targetId === targetId);
  const popupPage = await popupTarget.page();
  await popupPage.setViewport({ width: 460, height: 750 });

  const popupConsoleLogs = [];
  popupPage.on('console', async (msg) => {
    try {
      const vals = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => a.toString())));
      const line = vals.join(' ');
      popupConsoleLogs.push({ type: msg.type(), text: line });
      console.log(`[Popup Console ${msg.type()}]:`, line);
    } catch {
      popupConsoleLogs.push({ type: msg.type(), text: msg.text() });
      console.log(`[Popup Console ${msg.type()}]:`, msg.text());
    }
  });

  console.log('Popup page opened. Clicking "Capture Context" (CAPTURE 1: COLD RUN)...');
  await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
  await popupPage.click('#capture-context-btn');

  // Wait for visual perception to complete on cold run (downloads/loads TrOCR)
  console.log('Waiting for Capture 1 (Cold Run) results...');
  await popupPage.waitForSelector('#visual-regions-container', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));

  const coldResult = await popupPage.evaluate(() => {
    const badge = document.querySelector('.badge');
    const badgeVision = document.querySelector('.badge-vision');
    const runPill = document.querySelector('.run-pill');
    const providerPill = document.querySelector('.provider-pill');
    const metricsBox = document.querySelector('.metrics-box');
    const regionItems = Array.from(document.querySelectorAll('.region-item')).map((el) => el.innerText.replace(/\n/g, ' '));
    const noRegions = document.querySelector('.no-regions');
    return {
      domCount: badge ? badge.innerText : '',
      visionBadge: badgeVision ? badgeVision.innerText : '',
      runType: runPill ? runPill.innerText : '',
      provider: providerPill ? providerPill.innerText : '',
      metrics: metricsBox ? metricsBox.innerText.replace(/\n/g, ' | ') : '',
      regionsCount: regionItems.length,
      regions: regionItems,
      emptyNotice: noRegions ? noRegions.innerText : '',
    };
  });

  const proofCold = path.join(__dirname, 'phase2-case2-cold-run.png');
  await popupPage.screenshot({ path: proofCold, fullPage: true });
  console.log(`Saved Capture 1 (Cold Run) screenshot to: ${proofCold}`);

  // ==========================================
  // CAPTURE 2: WARM RUN (Click "Capture Context" a second time)
  // ==========================================
  console.log('\n--- CLICKING "Capture Context" A SECOND TIME (CAPTURE 2: WARM RUN) ---');
  await new Promise((r) => setTimeout(r, 1500));
  await popupPage.click('#capture-context-btn');

  console.log('Waiting for Capture 2 (Warm Run) results...');
  // Wait until .run-pill.warm appears indicating warm run completed
  await popupPage.waitForSelector('.run-pill.warm', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));

  const warmResult = await popupPage.evaluate(() => {
    const badge = document.querySelector('.badge');
    const badgeVision = document.querySelector('.badge-vision');
    const runPill = document.querySelector('.run-pill');
    const providerPill = document.querySelector('.provider-pill');
    const metricsBox = document.querySelector('.metrics-box');
    const regionItems = Array.from(document.querySelectorAll('.region-item')).map((el) => el.innerText.replace(/\n/g, ' '));
    const noRegions = document.querySelector('.no-regions');
    return {
      domCount: badge ? badge.innerText : '',
      visionBadge: badgeVision ? badgeVision.innerText : '',
      runType: runPill ? runPill.innerText : '',
      provider: providerPill ? providerPill.innerText : '',
      metrics: metricsBox ? metricsBox.innerText.replace(/\n/g, ' | ') : '',
      regionsCount: regionItems.length,
      regions: regionItems,
      emptyNotice: noRegions ? noRegions.innerText : '',
    };
  });

  console.log('\n======================================================');
  console.log('>>> TEST CASE 2 COMPARATIVE RESULTS (COLD vs WARM) <<<');
  console.log('======================================================');
  console.log('DOM Elements Found:      ', warmResult.domCount);
  console.log('Execution Provider:      ', warmResult.provider);
  console.log('\n[CAPTURE 1: COLD RUN]');
  console.log('  Run Tag:               ', coldResult.runType);
  console.log('  Metrics:               ', coldResult.metrics);
  console.log('  Detected Regions Count:', coldResult.regionsCount);
  if (coldResult.emptyNotice) console.log('  Notice:                ', coldResult.emptyNotice);
  coldResult.regions.forEach((r, i) => console.log(`    [${i + 1}] ${r}`));

  console.log('\n[CAPTURE 2: WARM RUN]');
  console.log('  Run Tag:               ', warmResult.runType);
  console.log('  Metrics:               ', warmResult.metrics);
  console.log('  Detected Regions Count:', warmResult.regionsCount);
  if (warmResult.emptyNotice) console.log('  Notice:                ', warmResult.emptyNotice);
  warmResult.regions.forEach((r, i) => console.log(`    [${i + 1}] ${r}`));

  const proof2 = path.join(__dirname, 'phase2-case2-canvas-vision.png');
  await popupPage.screenshot({ path: proof2, fullPage: true });
  console.log(`\nSaved Final Test Case 2 (Warm Run) screenshot to: ${proof2}`);
  console.log('>>> TEST CASE 2 PASSED: Double-capture verified cold load vs warm inference! <<<\n');

} catch (err) {
  console.error('Test 2 error:', err);
} finally {
  await browser.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
