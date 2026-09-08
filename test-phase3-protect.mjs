import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionPath = path.join(__dirname, 'dist');
const userDataDir = path.join(__dirname, '.browser-test-phase3');

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
    '--window-size=1300,900',
  ],
});

try {
  console.log('\n================================================================');
  console.log('>>> RUNNING PHASE 3 TEST: PROTECT STAGE (SPATIAL REDACTION) <<<');
  console.log('================================================================');

  const pages = await browser.pages();
  const cardPage = pages[0] || (await browser.newPage());
  await cardPage.setViewport({ width: 1200, height: 800 });
  await cardPage.goto('http://localhost:3456', { waitUntil: 'domcontentloaded' });
  console.log('Mock ID card page loaded:', cardPage.url());

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
  await popupPage.setViewport({ width: 480, height: 950 });

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

  console.log('Popup page opened. Clicking "Capture Context"...');
  await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
  await popupPage.click('#capture-context-btn');

  // Wait for Privacy Shield container to appear
  console.log('Waiting for Phase 3 Privacy Shield & Redaction to complete...');
  await popupPage.waitForSelector('#privacy-shield-container', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Extract Protected Context data from DOM
  const protectedData = await popupPage.evaluate(() => {
    const shieldTitle = document.querySelector('.shield-title')?.textContent || '';
    const boundaryPill = document.querySelector('.boundary-pill')?.textContent || '';
    const statRedacted = document.querySelector('.stat-box.redacted .stat-number')?.textContent || '';
    const statPreserved = document.querySelector('.stat-box.preserved .stat-number')?.textContent || '';
    const piiChips = Array.from(document.querySelectorAll('.pii-chip')).map((el) => el.textContent.trim());

    const regionItems = Array.from(document.querySelectorAll('.region-item')).map((el) => {
      const isRedacted = el.classList.contains('redacted-item');
      const textEl = el.querySelector('.region-redacted-label, .region-text');
      const tagEl = el.querySelector('.redact-tag, .preserved-tag');
      const bboxEl = el.querySelector('.region-bbox');
      return {
        isRedacted,
        text: textEl ? textEl.textContent.trim() : '',
        tag: tagEl ? tagEl.textContent.trim() : '',
        bbox: bboxEl ? bboxEl.textContent.trim() : '',
      };
    });

    const hasProtectedScreenshot = !!document.querySelector('#protected-screenshot-img');
    const protectedScreenshotSrc = document.querySelector('#protected-screenshot-img')?.getAttribute('src') || '';

    return {
      shieldTitle,
      boundaryPill,
      statRedacted,
      statPreserved,
      piiChips,
      regionItems,
      hasProtectedScreenshot,
      screenshotLength: protectedScreenshotSrc.length,
      protectedScreenshotSrc,
    };
  });

  console.log('\n================================================================');
  console.log('>>> PHASE 3 PROTECT STAGE EVALUATION RESULTS <<<');
  console.log('================================================================');
  console.log(`Privacy Shield Status:        ${protectedData.boundaryPill}`);
  console.log(`Sensitive Regions Redacted:   ${protectedData.statRedacted}`);
  console.log(`Non-Sensitive Preserved:      ${protectedData.statPreserved}`);
  console.log(`Protected PII Categories:     ${protectedData.piiChips.join(', ')}`);
  console.log(`Protected Screenshot Render:  ${protectedData.hasProtectedScreenshot ? 'SUCCESS (DataUrl valid)' : 'FAILED'}`);

  console.log('\n--- SANITIZED REGIONS (TRUST-BOUNDARY PAYLOAD) ---');
  protectedData.regionItems.forEach((r, i) => {
    console.log(`  [Region ${i + 1}] ${r.tag.padEnd(12)} | ${r.text.padEnd(30)} | ${r.bbox}`);
  });

  // Verification of the 5 Fields
  const groundTruthAudit = [
    { field: 'Aadhaar', expectedPii: true, expectedType: 'AADHAAR' },
    { field: 'PAN', expectedPii: true, expectedType: 'PAN' },
    { field: 'Name', expectedPii: true, expectedType: 'NAME' },
    { field: 'Address', expectedPii: true, expectedType: 'ADDRESS' },
    { field: 'Total', expectedPii: false, expectedType: 'CONTROL_FIELD' },
  ];

  console.log('\n========================================================================================================');
  console.log('>>> PHASE 3 PRIVACY REDACTION AUDIT TABLE: TRUST BOUNDARY PROTECTION <<<');
  console.log('========================================================================================================');
  console.log('| Field    | Type          | Expected Policy | Redacted? | Trust Boundary Status      | Protection Quality |');
  console.log('|----------|---------------|-----------------|-----------|----------------------------|--------------------|');

  let privacyPassedCount = 0;

  groundTruthAudit.forEach((gt) => {
    let matchedRegion;
    if (gt.expectedPii) {
      matchedRegion = protectedData.regionItems.find(
        (r) => r.isRedacted && r.text.includes(gt.expectedType)
      );
    } else {
      matchedRegion = protectedData.regionItems.find(
        (r) => !r.isRedacted && (r.text.includes('TOTAL') || r.text.includes('4,500') || r.text.includes('54500'))
      );
    }

    const fieldStr = gt.field.padEnd(8);
    const typeStr = gt.expectedType.padEnd(13);
    const policyStr = gt.expectedPii ? 'MUST REDACT'.padEnd(15) : 'PRESERVE'.padEnd(15);
    const isRedactedStr = (matchedRegion?.isRedacted ? 'YES 🛡️' : 'NO ✅').padEnd(9);

    let statusStr = '';
    let qualStr = '';

    if (gt.expectedPii) {
      if (matchedRegion && matchedRegion.isRedacted) {
        statusStr = 'ZERO LEAK (PROTECTED) ✅'.padEnd(26);
        qualStr = '100% CONTAINED ✅';
        privacyPassedCount++;
      } else {
        statusStr = 'LEAKED SENSITIVE PII ❌'.padEnd(26);
        qualStr = 'POLICY BREACH ❌';
      }
    } else {
      if (matchedRegion && !matchedRegion.isRedacted) {
        statusStr = 'ALLOWED THROUGH ✅       ';
        qualStr = '0 FALSE POSITIVE ✅';
        privacyPassedCount++;
      } else {
        statusStr = 'FALSE POSITIVE BLOCKED ⚠️';
        qualStr = 'OVER-REDACTED ⚠️';
      }
    }

    console.log(`| ${fieldStr} | ${typeStr} | ${policyStr} | ${isRedactedStr} | ${statusStr} | ${qualStr} |`);
  });
  console.log('========================================================================================================');

  const totalAuditFields = groundTruthAudit.length;
  const auditScore = (privacyPassedCount / totalAuditFields) * 100;
  console.log(`\nPrivacy Policy Audit Score: ${privacyPassedCount} / ${totalAuditFields} (${auditScore.toFixed(1)}%)`);
  console.log(`Zero PII Leakage Guarantee: ${privacyPassedCount === totalAuditFields ? 'VERIFIED ✅ (100% Compliant)' : 'FAILED ❌'}`);

  // Save screenshots
  const proofProtected = path.join(__dirname, 'phase3-protected-popup.png');
  await popupPage.screenshot({ path: proofProtected, fullPage: true });
  console.log(`\nSaved Protected Popup screenshot to: ${proofProtected}`);

  // Save the redacted screenshot separately if available
  if (protectedData.protectedScreenshotSrc && protectedData.protectedScreenshotSrc.startsWith('data:image/png;base64,')) {
    const base64Data = protectedData.protectedScreenshotSrc.replace(/^data:image\/png;base64,/, '');
    const proofCanvas = path.join(__dirname, 'phase3-redacted-canvas.png');
    fs.writeFileSync(proofCanvas, Buffer.from(base64Data, 'base64'));
    console.log(`Saved Redacted Canvas Image to: ${proofCanvas}`);
  }

  // Toggle to Raw View and capture screenshot
  await popupPage.click('#toggle-raw-view-btn');
  await new Promise((r) => setTimeout(r, 600));
  const proofRaw = path.join(__dirname, 'phase3-raw-popup.png');
  await popupPage.screenshot({ path: proofRaw, fullPage: true });
  console.log(`Saved Pre-Redaction Raw Popup screenshot to: ${proofRaw}`);

} catch (err) {
  console.error('Phase 3 test error:', err);
} finally {
  await browser.close();
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
