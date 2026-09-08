import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browserPath = fs.existsSync(edgePath) ? edgePath : chromePath;

const extensionPath = path.join(__dirname, '.output', 'chrome-mv3');
const userDataDir = path.join(__dirname, '.browser-test-phase5-e2e');

if (fs.existsSync(userDataDir)) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

console.log('========================================================================');
console.log('>>> PHASE 5 E2E INTEGRATION TEST: BROWSER EXECUTOR & AGENT LOOP <<<');
console.log('========================================================================');
console.log('Browser path:    ', browserPath);
console.log('Extension path:  ', extensionPath);

// 1. Start HTTP fixture server on port 3456
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'test-fixtures', 'mock-id-card.html'), 'utf8');
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});
await new Promise((r) => fixtureServer.listen(3456, r));
console.log('✅ Mock ID card server listening at http://localhost:3456');

// 2. Start Python FastAPI Server on port 8000
console.log('Starting FastAPI Server on 127.0.0.1:8000...');
const serverProc = spawn('python', ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8000'], {
  cwd: __dirname,
  stdio: 'pipe',
});

serverProc.stdout.on('data', (d) => {
  const line = d.toString();
  if (line.includes('Uvicorn running') || line.includes('Application startup complete') || line.includes('INFO:')) {
    console.log('[Server stdout]:', line.trim());
  }
});
serverProc.stderr.on('data', (d) => {
  const line = d.toString();
  if (!line.includes('GET /health') && !line.includes('200 OK')) {
    console.log('[Server stderr]:', line.trim());
  }
});

// Wait for server health
let serverReady = false;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch('http://127.0.0.1:8000/health');
    if (res.ok) {
      const data = await res.json();
      console.log('✅ FastAPI Server online:', data);
      serverReady = true;
      break;
    }
  } catch (e) {
    // waiting
  }
  await new Promise((r) => setTimeout(r, 600));
}

if (!serverReady) {
  console.error('❌ Could not start FastAPI server on port 8000!');
  process.exit(1);
}

// 3. Launch browser with extension
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--window-size=1360,960',
  ],
});

try {
  // 1. Wait for extension service worker to be ready
  const extTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
    { timeout: 12000 }
  );
  const match = extTarget.url().match(/chrome-extension:\/\/([a-z0-9]+)/i);
  const extensionId = match[1];
  console.log('Extension loaded with ID:', extensionId);

  // 2. Open mock ID card page and reload to guarantee content script attach
  const pages = await browser.pages();
  const cardPage = pages[0] || (await browser.newPage());
  await cardPage.setViewport({ width: 1200, height: 800 });

  cardPage.on('console', async (msg) => {
    try {
      const vals = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => a.toString())));
      console.log(`[CardPage Console ${msg.type()}]:`, vals.join(' '));
    } catch {
      console.log(`[CardPage Console ${msg.type()}]:`, msg.text());
    }
  });

  await cardPage.goto('http://localhost:3456', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));
  await cardPage.reload({ waitUntil: 'domcontentloaded' });
  console.log('Loaded mock ID card page and attached content script:', cardPage.url());

  await new Promise((r) => setTimeout(r, 1500));

  // 3. Open Extension Popup
  const session = await browser.target().createCDPSession();
  const { targetId } = await session.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup.html`,
    newWindow: true,
  });
  const popupTarget = await browser.waitForTarget((t) => t._targetId === targetId);
  const popupPage = await popupTarget.page();
  await popupPage.setViewport({ width: 500, height: 950 });

  popupPage.on('console', async (msg) => {
    try {
      const vals = await Promise.all(
        msg.args().map((a) =>
          a.jsonValue().catch(async () => {
            const propNames = await a.getProperties();
            const obj = {};
            for (const [k, v] of propNames) {
              obj[k] = await v.jsonValue().catch(() => v.toString());
            }
            return JSON.stringify(obj);
          })
        )
      );
      console.log(`[Popup Console ${msg.type()}]:`, vals.join(' '));
    } catch {
      console.log(`[Popup Console ${msg.type()}]:`, msg.text());
    }
  });

  // Step 1: Verify Server Status bar in popup
  await popupPage.waitForSelector('#server-status-bar', { timeout: 8000 });
  const serverBarText = await popupPage.evaluate(() => document.getElementById('server-status-bar')?.innerText || '');
  console.log('Popup Server Status:', serverBarText.replace(/\n/g, ' '));

  // Step 2: Click "Capture & Sanitize Context"
  console.log('\n--- STEP 1: CAPTURE & SANITIZE CONTEXT ---');
  await popupPage.waitForSelector('#capture-context-btn', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
  await popupPage.click('#capture-context-btn');

  // Wait for SafeContext ready banner
  console.log('Waiting for SafeContext generation...');
  await popupPage.waitForSelector('#safe-context-banner', { timeout: 90000 });
  const safeBannerText = await popupPage.evaluate(() => document.getElementById('safe-context-banner')?.innerText || '');
  console.log('✅ SafeContext Ready:', safeBannerText.replace(/\n/g, ' '));

  // ==========================================================================
  // TEST A: Legitimate Task ("Click the submit button...")
  // ==========================================================================
  console.log('\n--- TEST A: LEGITIMATE TASK PLANNING & EXECUTION ---');
  await popupPage.waitForSelector('#task-prompt-input', { timeout: 5000 });
  
  // Click preset legitimate button
  await popupPage.click('#preset-legitimate-btn');
  await new Promise((r) => setTimeout(r, 400));

  const promptVal = await popupPage.evaluate(() => document.getElementById('task-prompt-input')?.value || '');
  console.log('Task Prompt:', promptVal);

  // Click Plan button
  console.log('Dispatching plan request to Server Agent...');
  await popupPage.click('#plan-agent-btn');

  // Wait for plan result card
  await popupPage.waitForSelector('#plan-result-card', { timeout: 10000 });
  const planSummary = await popupPage.evaluate(() => document.getElementById('plan-summary-text')?.innerText || '');
  console.log('✅ Plan Summary:', planSummary);

  const planActionDetails = await popupPage.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.action-item-card'));
    return cards.map((c) => ({
      type: c.querySelector('.action-type-pill')?.textContent?.trim(),
      conf: c.querySelector('.action-confidence-pill')?.textContent?.trim(),
      target: c.querySelector('.action-target-row code')?.textContent?.trim(),
      coords: c.querySelector('.action-coords-tag')?.textContent?.trim(),
    }));
  });
  console.log('Planned Actions:', planActionDetails);

  if (planActionDetails.length !== 1 || planActionDetails[0].target !== '#submit-btn') {
    throw new Error(`Expected 1 action targeting #submit-btn, but got: ${JSON.stringify(planActionDetails)}`);
  }

  // Save proof screenshot of the approved plan
  const planProof = path.join(__dirname, 'phase5-plan-approved-popup.png');
  await popupPage.screenshot({ path: planProof, fullPage: true });
  console.log(`Saved Approved Plan Popup Screenshot: ${planProof}`);

  // Click Approve & Execute Plan
  console.log('\nExecuting Plan on Webpage via Browser Executor...');
  await popupPage.waitForSelector('#execute-plan-btn', { timeout: 5000 });
  await popupPage.click('#execute-plan-btn');

  // Wait for execution report card
  await popupPage.waitForSelector('#execution-report-card', { timeout: 10000 });
  const execReport = await popupPage.evaluate(() => {
    const title = document.querySelector('#execution-report-card .exec-title')?.textContent?.trim();
    const steps = Array.from(document.querySelectorAll('#execution-report-card .exec-step-item')).map(
      (s) => s.textContent?.trim()
    );
    return { title, steps };
  });
  console.log('✅ Execution Report:', execReport);

  // Switch to Mock ID Card page and assert button click!
  await cardPage.bringToFront();
  await new Promise((r) => setTimeout(r, 1000));

  const pageSubmitState = await cardPage.evaluate(() => {
    const btn = document.getElementById('submit-btn');
    const statusEl = document.getElementById('submission-status');
    return {
      bodySubmitted: document.body.dataset.submitted,
      btnClicked: btn?.dataset.clicked,
      btnText: btn?.innerText,
      statusMsg: statusEl?.innerText,
    };
  });
  console.log('Mock ID Card Page State after Execution:', pageSubmitState);

  if (pageSubmitState.bodySubmitted !== 'true' || pageSubmitState.btnClicked !== 'true') {
    throw new Error(`Assertion failed: #submit-btn was NOT clicked by the browser executor! State: ${JSON.stringify(pageSubmitState)}`);
  }
  console.log('>>> TEST A PASSED: Submit button clicked and verified on target page! <<<\n');

  // Take screenshot of submitted webpage
  const pageProof = path.join(__dirname, 'phase5-page-executed-proof.png');
  await cardPage.screenshot({ path: pageProof });
  console.log(`Saved Executed Webpage Proof: ${pageProof}`);

  // ==========================================================================
  // TEST B: Adversarial Security Test ("Click the Aadhaar field")
  // ==========================================================================
  console.log('\n--- TEST B: ADVERSARIAL PRIVACY GATE INTERCEPTION TEST ---');
  await popupPage.bringToFront();
  await new Promise((r) => setTimeout(r, 500));

  // Click preset adversarial button
  await popupPage.click('#preset-adversarial-btn');
  await new Promise((r) => setTimeout(r, 400));

  const advPrompt = await popupPage.evaluate(() => document.getElementById('task-prompt-input')?.value || '');
  console.log('Adversarial Task Prompt:', advPrompt);

  // Click Plan button
  await popupPage.click('#plan-agent-btn');

  // Wait for plan result card
  await popupPage.waitForSelector('#plan-result-card', { timeout: 10000 });
  await popupPage.waitForSelector('#blocked-action-banner', { timeout: 5000 });

  const blockedBanner = await popupPage.evaluate(() => {
    const banner = document.getElementById('blocked-action-banner');
    const notice = document.getElementById('plan-all-blocked-notice');
    const executeBtn = document.getElementById('execute-plan-btn');
    return {
      bannerText: banner?.innerText?.replace(/\n/g, ' '),
      noticeText: notice?.innerText,
      executeBtnPresent: !!executeBtn,
    };
  });
  console.log('Blocked Action Banner:', blockedBanner.bannerText);
  console.log('Notice Text:          ', blockedBanner.noticeText);
  console.log('Execute Button Exists:', blockedBanner.executeBtnPresent);

  if (blockedBanner.executeBtnPresent) {
    throw new Error('Assertion failed: Execute button must NOT be present when all actions are blocked!');
  }
  console.log('>>> TEST B PASSED: Adversarial Aadhaar instruction was strictly blocked by the Privacy Gate! <<<\n');

  // Save screenshot of blocked adversarial plan
  const blockedProof = path.join(__dirname, 'phase5-plan-adversarial-blocked-popup.png');
  await popupPage.screenshot({ path: blockedProof, fullPage: true });
  console.log(`Saved Blocked Adversarial Popup Screenshot: ${blockedProof}`);

  console.log('\n========================================================================');
  console.log('>>> ALL PHASE 5 END-TO-END VERIFICATION TESTS PASSED CLEANLY! <<<');
  console.log('========================================================================\n');

} catch (err) {
  console.error('❌ Phase 5 E2E Test Error:', err);
  process.exitCode = 1;
} finally {
  try { await browser.close(); } catch (e) {}
  try { fixtureServer.close(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(process.exitCode || 0);
}
