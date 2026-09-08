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

// 1. Fixture Server on port 3456
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'test-fixtures', 'mock-id-card.html'), 'utf8');
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});
fixtureServer.listen(3456, () => {
  console.log('✅ Mock ID Card page hosted at: http://localhost:3456');
});

// 2. Python FastAPI Server on port 8000
console.log('Starting Nexus FastAPI Server Agent on http://127.0.0.1:8000...');
const serverProc = spawn('python', ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: {
    ...process.env,
    ZONUI_MODE: process.env.ZONUI_MODE || 'remote_api',
    ZONUI_ENDPOINT: process.env.ZONUI_ENDPOINT || 'https://then-participating-hints-solaris.trycloudflare.com/ground',
  },
});

// 3. Launch browser with extension loaded
console.log('Launching browser with Nexus Privacy Agent extension loaded...');
const browserProc = spawn(browserPath, [
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-first-run',
  'http://localhost:3456',
], {
  detached: true,
  stdio: 'ignore',
});
browserProc.unref();

console.log('\n======================================================');
console.log('🎉 MANUAL TESTING ENVIRONMENT IS LIVE!');
console.log('1. Target Page: http://localhost:3456');
console.log('2. Extension is loaded in the toolbar (click the puzzle icon to pin it)');
console.log('3. FastAPI Server Agent is running on http://127.0.0.1:8000');
console.log('======================================================\n');

process.on('SIGINT', () => {
  try { serverProc.kill(); } catch (e) {}
  try { fixtureServer.close(); } catch (e) {}
  process.exit(0);
});
