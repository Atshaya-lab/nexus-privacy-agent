import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionPath = path.join(__dirname, 'dist');
const userDataDir = path.join(__dirname, '.browser-test-stress');

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
    '--window-size=1280,850',
  ],
});

try {
  console.log('\n>>> RUNNING STRESS TEST: Synthetic Mock ID Card (<canvas>) <<<');
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
  await popupPage.setViewport({ width: 460, height: 850 });

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

  // Wait for visual perception results
  console.log('Waiting for visual perception results...');
  await popupPage.waitForSelector('#visual-regions-container', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  const rawRegions = await popupPage.evaluate(() => {
    const regionEls = Array.from(document.querySelectorAll('.region-item'));
    return regionEls.map((el) => {
      const textEl = el.querySelector('.region-text');
      const confEl = el.querySelector('.region-conf');
      const bboxEl = el.querySelector('.region-bbox');
      return {
        extractedText: textEl ? textEl.innerText.replace(/^"|"$/g, '') : '',
        confidence: confEl ? confEl.innerText : '',
        bbox: bboxEl ? bboxEl.innerText : '',
      };
    });
  });

  console.log(`\n=== RAW DETECTED TEXT REGIONS (${rawRegions.length} total) ===`);
  rawRegions.forEach((r, i) => {
    console.log(`  [Region ${i + 1}] bbox: ${r.bbox} | text: "${r.extractedText}" | conf: ${r.confidence}`);
  });

  // Expected 5 fields
  const groundTruth = [
    { field: 'Aadhaar', expected: '2345 6789 0123', pattern: /2345|6789|0123/i, labelPat: /aadha|adha|abdha/i },
    { field: 'PAN', expected: 'ABCDE1234F', pattern: /ABCDE|1234F/i, labelPat: /pan/i },
    { field: 'Name', expected: 'Rahul Sharma', pattern: /rahul|rahui|sharma|sharna/i, labelPat: /name/i },
    { field: 'Address', expected: 'MG Road, Bangalore', pattern: /mg\s*road|bangalore|bangal/i, labelPat: /address/i },
    { field: 'Total', expected: '₹4,500', pattern: /4,?500|54500|52000/i, labelPat: /total/i },
  ];

  const recallRows = groundTruth.map((gt) => {
    // Find region matching this field
    const matchedRegion = rawRegions.find(
      (r) => gt.labelPat.test(r.extractedText) || gt.pattern.test(r.extractedText)
    );

    if (!matchedRegion) {
      return {
        field: gt.field,
        expected: gt.expected,
        detected: 'NO',
        extracted: '— (Not Detected)',
        confidence: '—',
        fullMatch: false,
        garbled: false,
      };
    }

    const ext = matchedRegion.extractedText;
    let isFullMatch = false;
    if (gt.field === 'Aadhaar') isFullMatch = ext.includes('2345 6789 0123');
    else if (gt.field === 'PAN') isFullMatch = ext.includes('ABCDE1234F');
    else if (gt.field === 'Name') isFullMatch = ext.toLowerCase().includes('rahul sharma');
    else if (gt.field === 'Address') isFullMatch = ext.toLowerCase().includes('mg road, bangalore') || ext.toLowerCase().includes('mg road bangalore');
    else if (gt.field === 'Total') isFullMatch = ext.includes('4,500') || ext.includes('4500');
    const isGarbled = !isFullMatch;

    return {
      field: gt.field,
      expected: gt.expected,
      detected: 'YES',
      extracted: ext,
      confidence: matchedRegion.confidence,
      fullMatch: isFullMatch,
      garbled: isGarbled,
    };
  });

  console.log('\n========================================================================================================');
  console.log('>>> RECALL EVALUATION TABLE: OCR DETECTION ON SYNTHETIC ID CARD (Xenova/trocr-small-printed) <<<');
  console.log('========================================================================================================');
  console.log('| Field    | Expected Text           | Detected? | Extracted Text                     | Conf | Quality     |');
  console.log('|----------|-------------------------|-----------|------------------------------------|------|-------------|');
  recallRows.forEach((r) => {
    const fld = r.field.padEnd(8);
    const exp = r.expected.padEnd(23);
    const det = r.detected.padEnd(9);
    const ext = r.extracted.slice(0, 34).padEnd(34);
    const cnf = r.confidence.padEnd(4);
    const qlt = r.fullMatch ? 'FULL MATCH ✅' : r.detected === 'YES' ? 'GARBLED ⚠️  ' : 'MISSED ❌   ';
    console.log(`| ${fld} | ${exp} | ${det} | ${ext} | ${cnf} | ${qlt} |`);
  });
  console.log('========================================================================================================');

  const detectedCount = recallRows.filter((r) => r.detected === 'YES').length;
  const fullMatchCount = recallRows.filter((r) => r.fullMatch).length;
  const garbledCount = recallRows.filter((r) => r.garbled).length;

  const detectionRecall = (detectedCount / groundTruth.length) * 100;
  const fullMatchRecall = (fullMatchCount / groundTruth.length) * 100;

  console.log('\n=== RECALL & FEASIBILITY METRICS ===');
  console.log(`Total Target Fields:          5`);
  console.log(`Regions Located (Detection):  ${detectedCount} / 5 (${detectionRecall.toFixed(1)}%)`);
  console.log(`Exact Full Matches:           ${fullMatchCount} / 5 (${fullMatchRecall.toFixed(1)}%)`);
  console.log(`Garbled / Partial Matches:    ${garbledCount} / 5`);
  console.log(`Target Recall Target:         ≥ 95%`);
  console.log(`Feasibility Target Status:    ${fullMatchRecall >= 95 ? 'MET ✅' : 'NOT MET ⚠️ (Current model below target)'}`);

  const proofStress = path.join(__dirname, 'phase2-stress-mock-id.png');
  await popupPage.screenshot({ path: proofStress, fullPage: true });
  console.log(`\nSaved Stress Test screenshot to: ${proofStress}`);

} catch (err) {
  console.error('Stress test error:', err);
} finally {
  await browser.close();
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
