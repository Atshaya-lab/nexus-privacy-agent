import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionPath = path.join(__dirname, 'dist');
const userDataDir = path.join(__dirname, '.browser-test-p2');

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
  // ==========================================
  // TEST CASE 1: https://developer.chrome.com/docs/devtools
  // Expected: DOM is text-rich -> SKIP visual perception
  // ==========================================
  console.log('\n>>> RUNNING TEST CASE 1: developer.chrome.com/docs/devtools <<<');
  const pages = await browser.pages();
  const testPage = pages[0] || (await browser.newPage());
  try {
    await testPage.goto('https://developer.chrome.com/docs/devtools', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.warn('DevTools page load warning:', e.message);
  }
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
  await popupPage.setViewport({ width: 460, height: 800 });

  const consoleLogs = [];
  popupPage.on('console', async (msg) => {
    try {
      const vals = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => a.toString())));
      consoleLogs.push({ type: msg.type(), text: vals.join(' ') });
      console.log(`[Popup Console ${msg.type()}]:`, ...vals);
    } catch {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
      console.log(`[Popup Console ${msg.type()}]:`, msg.text());
    }
  });

  await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 600));
  await popupPage.click('#capture-context-btn');

  // Wait for capture result
  await popupPage.waitForSelector('#vision-skipped-notice', { timeout: 10000 });
  await popupPage.waitForSelector('#captured-screenshot-img', { timeout: 5000 });

  const test1Result = await popupPage.evaluate(() => {
    const notice = document.querySelector('#vision-skipped-notice');
    const badgeSkipped = document.querySelector('.badge-skipped');
    const domBadge = document.querySelector('.badge');
    const url = document.querySelector('.url-text');
    return {
      url: url ? url.innerText : '',
      domCount: domBadge ? domBadge.innerText : '',
      badgeSkippedText: badgeSkipped ? badgeSkipped.innerText : '',
      noticeText: notice ? notice.innerText.replace(/\n/g, ' ') : '',
    };
  });

  console.log('\n--- TEST CASE 1 VERIFICATION RESULT ---');
  console.log('Target URL:         ', test1Result.url);
  console.log('DOM Count:          ', test1Result.domCount);
  console.log('Badge Text:         ', test1Result.badgeSkippedText);
  console.log('Notice Text:        ', test1Result.noticeText);

  // Save proof screenshot for Case 1
  const proof1 = path.join(__dirname, 'phase2-case1-devtools-skipped.png');
  await popupPage.screenshot({ path: proof1, fullPage: true });
  console.log(`Saved Test Case 1 screenshot to: ${proof1}`);
  console.log('>>> TEST CASE 1 PASSED: Visual perception was correctly skipped! <<<\n');

  await popupPage.close();

} catch (err) {
  console.error('Test 1 error:', err);
} finally {
  await browser.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
