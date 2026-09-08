import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionPath = path.join(__dirname, 'dist');
const userDataDir = path.join(__dirname, '.browser-test-phase3-full');

if (fs.existsSync(userDataDir)) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

// 1. Start local server for synthetic fixture
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'test-fixtures', 'mock-id-card.html'), 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(3456, r));
console.log('Test fixture server running on http://localhost:3456');

// 2. Launch browser with extension
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--window-size=1300,920',
  ],
});

try {
  console.log('\n========================================================================');
  console.log('>>> RUNNING PHASE 3 PROTECT STAGE VERIFICATION (PRIVACY GATE) <<<');
  console.log('========================================================================');

  const pages = await browser.pages();
  const cardPage = pages[0] || (await browser.newPage());
  await cardPage.setViewport({ width: 1200, height: 800 });
  await cardPage.goto('http://localhost:3456', { waitUntil: 'domcontentloaded' });
  console.log('Mock ID card page loaded with unclassified field:', cardPage.url());

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
  await popupPage.setViewport({ width: 500, height: 980 });

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

  console.log('Popup page opened. Clicking "Capture & Sanitize Context"...');
  await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
  await popupPage.click('#capture-context-btn');

  // Wait for Privacy Gate section to appear
  console.log('Waiting for Phase 3 Privacy Gate & Sanitize to complete...');
  await popupPage.waitForSelector('#privacy-gate-banner', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Extract evaluations from popup DOM
  const gateData = await popupPage.evaluate(() => {
    const summaryText = document.querySelector('#summary-sentence-text')?.textContent || '';
    const metricTotal = document.querySelector('.gate-metric.total .metric-num')?.textContent || '';
    const metricMasked = document.querySelector('.gate-metric.masked .metric-num')?.textContent || '';
    const metricBlocked = document.querySelector('.gate-metric.blocked .metric-num')?.textContent || '';
    const metricAllowed = document.querySelector('.gate-metric.allowed .metric-num')?.textContent || '';

    const auditRows = Array.from(document.querySelectorAll('#audit-log-table tbody tr')).map((tr) => {
      const cat = tr.querySelector('.cat-name')?.textContent || '';
      const action = tr.querySelector('.action-badge')?.textContent || '';
      const source = tr.querySelector('.source-badge')?.textContent || '';
      const details = tr.querySelector('.details-cell')?.textContent || '';
      const bbox = tr.querySelector('.bbox-cell')?.textContent || '';
      return { cat, action, source, details, bbox };
    });

    const hasOriginalScreenshot = !!document.querySelector('#original-screenshot-img');
    const hasRedactedScreenshot = !!document.querySelector('#redacted-screenshot-img');
    const redactedScreenshotSrc = document.querySelector('#redacted-screenshot-img')?.getAttribute('src') || '';
    const originalScreenshotSrc = document.querySelector('#original-screenshot-img')?.getAttribute('src') || '';

    return {
      summaryText,
      metricTotal,
      metricMasked,
      metricBlocked,
      metricAllowed,
      auditRows,
      hasOriginalScreenshot,
      hasRedactedScreenshot,
      redactedScreenshotSrc,
      originalScreenshotSrc,
    };
  });

  console.log('\n========================================================================');
  console.log('>>> PHASE 3 PRIVACY GATE RESULTS <<<');
  console.log('========================================================================');
  console.log(`Summary Banner:            ${gateData.summaryText}`);
  console.log(`Fields Detected:           ${gateData.metricTotal}`);
  console.log(`Fields Masked:             ${gateData.metricMasked}`);
  console.log(`Fields Blocked:            ${gateData.metricBlocked}`);
  console.log(`Fields Allowed:            ${gateData.metricAllowed}`);
  console.log(`Original Screenshot Valid: ${gateData.hasOriginalScreenshot ? 'YES' : 'NO'}`);
  console.log(`Redacted Screenshot Valid: ${gateData.hasRedactedScreenshot ? 'YES' : 'NO'}`);

  console.log('\n========================================================================================================');
  console.log('>>> AUDIT LOG TABLE (RECORDED PRIVACY DECISIONS) <<<');
  console.log('========================================================================================================');
  console.log('| Category     | Action  | Source | Details                              | Bounding Box             |');
  console.log('|--------------|---------|--------|--------------------------------------|--------------------------|');
  gateData.auditRows.forEach((r) => {
    const cat = r.cat.padEnd(12);
    const act = r.action.padEnd(7);
    const src = r.source.padEnd(6);
    const det = r.details.slice(0, 36).padEnd(36);
    const bbox = r.bbox.padEnd(24);
    console.log(`| ${cat} | ${act} | ${src} | ${det} | ${bbox} |`);
  });
  console.log('========================================================================================================');

  // Ground Truth Assertions
  console.log('\n--- VERIFYING REQUIREMENTS ---');

  // Requirement 1: Aadhaar, PAN, Address get MASKED by default
  const aadhaarEntry = gateData.auditRows.find((r) => r.cat === 'AADHAAR');
  const panEntry = gateData.auditRows.find((r) => r.cat === 'PAN');
  const addressEntry = gateData.auditRows.find((r) => r.cat === 'ADDRESS');

  console.log(`1. Aadhaar MASKED:  ${aadhaarEntry?.action === 'MASK' ? 'PASS ✅' : 'FAIL ❌'} (${aadhaarEntry?.action})`);
  console.log(`2. PAN MASKED:      ${panEntry?.action === 'MASK' ? 'PASS ✅' : 'FAIL ❌'} (${panEntry?.action})`);
  console.log(`3. Address MASKED:  ${addressEntry?.action === 'MASK' ? 'PASS ✅' : 'FAIL ❌'} (${addressEntry?.action})`);

  // Requirement 2: Total / amount is ALLOWED (unredacted)
  const amountEntry = gateData.auditRows.find((r) => r.cat === 'AMOUNT');
  console.log(`4. Amount ALLOWED:  ${amountEntry?.action === 'ALLOW' ? 'PASS ✅' : 'FAIL ❌'} (${amountEntry?.action})`);

  // Requirement 3: Any unclassified field defaults to MASK, not ALLOW (Fail-Safe Verification)
  const unclassEntry = gateData.auditRows.find((r) => r.cat === 'UNCLASSIFIED');
  console.log(`5. Unclassified Field FAIL-SAFE to MASK: ${unclassEntry?.action === 'MASK' ? 'PASS ✅' : 'FAIL ❌'} (${unclassEntry?.action})`);

  // Save screenshots
  const proofPrivacyGate = path.join(__dirname, 'phase3-privacy-gate-popup.png');
  await popupPage.screenshot({ path: proofPrivacyGate, fullPage: true });
  console.log(`\nSaved Privacy Gate Popup screenshot to: ${proofPrivacyGate}`);

  // Test Settings tab
  await popupPage.click('#tab-policy-settings');
  await new Promise((r) => setTimeout(r, 600));
  const proofSettings = path.join(__dirname, 'phase3-policy-settings-tab.png');
  await popupPage.screenshot({ path: proofSettings, fullPage: true });
  console.log(`Saved Policy Settings Tab screenshot to: ${proofSettings}`);

  // Save the redacted screenshot canvas separately
  if (gateData.redactedScreenshotSrc && gateData.redactedScreenshotSrc.startsWith('data:image/png;base64,')) {
    const base64Data = gateData.redactedScreenshotSrc.replace(/^data:image\/png;base64,/, '');
    const proofCanvas = path.join(__dirname, 'phase3-sidebyside-redacted-canvas.png');
    fs.writeFileSync(proofCanvas, Buffer.from(base64Data, 'base64'));
    console.log(`Saved Redacted Canvas Image to: ${proofCanvas}`);
  }

} catch (err) {
  console.error('Phase 3 verification error:', err);
} finally {
  await browser.close();
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
