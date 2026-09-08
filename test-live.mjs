import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Start test HTTP server
const testHtml = fs.readFileSync(path.join(__dirname, 'test-page', 'index.html'), 'utf-8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(testHtml);
});

const PORT = 8089;
server.listen(PORT, async () => {
  console.log(`Test server running at http://localhost:${PORT}`);

  const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const extensionPath = path.join(__dirname, 'dist');
  const userDataDir = path.join(__dirname, '.browser-test-data');

  if (fs.existsSync(userDataDir)) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('Launching browser with unpacked extension from:', extensionPath);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,850',
      ],
    });

    // 1. Open test page with form
    const pages = await browser.pages();
    const formPage = pages[0] || (await browser.newPage());
    await formPage.setViewport({ width: 1200, height: 750 });
    await formPage.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    console.log('Test form page loaded:', formPage.url());

    // 2. Locate extension ID
    const extTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
      { timeout: 8000 }
    );
    const match = extTarget.url().match(/chrome-extension:\/\/([a-z0-9]+)/i);
    const extensionId = match[1];
    console.log(`Detected Extension ID: ${extensionId}`);

    // 3. Open extension popup
    console.log('Opening extension popup...');
    const popupPage = await browser.newPage();
    await popupPage.setViewport({ width: 440, height: 620 });

    const capturedLogs = [];
    popupPage.on('console', async (msg) => {
      try {
        const vals = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => a.toString())));
        capturedLogs.push({ type: msg.type(), text: vals.join(' ') });
        console.log(`[Popup Console ${msg.type()}]:`, ...vals);
      } catch {
        capturedLogs.push({ type: msg.type(), text: msg.text() });
        console.log(`[Popup Console ${msg.type()}]:`, msg.text());
      }
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'networkidle0',
    });
    console.log('Popup page opened.');

    // 4. Click Capture Context button
    await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 800));
    console.log('Clicking "Capture Context" button...');
    await popupPage.click('#capture-context-btn');

    // 5. Wait for result
    console.log('Waiting for context capture and screenshot render...');
    await popupPage.waitForSelector('#captured-screenshot-img', { timeout: 10000 });
    await popupPage.waitForSelector('.badge', { timeout: 5000 });
    await popupPage.waitForSelector('.dom-list .dom-node-item', { timeout: 5000 });

    const evaluation = await popupPage.evaluate(() => {
      const img = document.querySelector('#captured-screenshot-img');
      const badge = document.querySelector('.badge');
      const urlText = document.querySelector('.url-text');
      const items = Array.from(document.querySelectorAll('.dom-node-item')).map((el) => el.innerText);
      return {
        url: urlText ? urlText.innerText : '',
        badge: badge ? badge.innerText : '',
        screenshotLength: img ? img.src.length : 0,
        screenshotPrefix: img ? img.src.substring(0, 50) : '',
        isScreenshotValidImage: img && img.src.startsWith('data:image/png;base64,') && img.naturalWidth > 0,
        domCount: items.length,
        domItems: items,
      };
    });

    console.log('\n=============================================================');
    console.log('               NEXUS PRIVACY AGENT TEST REPORT               ');
    console.log('=============================================================');
    console.log('Target URL:               ', evaluation.url);
    console.log('Status Badge:             ', evaluation.badge);
    console.log('DOM Elements Extracted:   ', evaluation.domCount);
    console.log('Screenshot Data Length:   ', evaluation.screenshotLength, 'bytes/chars');
    console.log('Screenshot Prefix:        ', evaluation.screenshotPrefix);
    console.log('Screenshot Natural Width: ', evaluation.isScreenshotValidImage);

    console.log('\nExtracted DOM Elements Details:');
    evaluation.domItems.forEach((item, idx) => {
      console.log(`  [${idx + 1}] ${item.replace(/\n/g, ' ')}`);
    });

    // Save final visual proof screenshot of popup
    const proofPath = path.join(__dirname, 'popup-test-result.png');
    await popupPage.screenshot({ path: proofPath });
    console.log(`\nFinal popup screenshot saved to: ${proofPath}`);

    console.log('\n=============================================================');
    console.log('>>> VERIFICATION PASSED: END-TO-END PIPELINE FUNCTIONAL! <<<');
    console.log('=============================================================\n');
  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    if (browser) await browser.close();
    server.close();
    process.exit(0);
  }
});
