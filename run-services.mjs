import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Fixture Server on port 3456
const fixturePath = path.join(__dirname, 'test-fixtures', 'mock-id-card.html');
const fixtureHtml = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, 'utf8') : '<h1>Mock ID Card</h1>';
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

console.log('\n======================================================');
console.log('🎉 SERVER AGENT & FIXTURE ARE LIVE (NO BROWSER AUTO-LAUNCH)!');
console.log('1. FastAPI Server Agent: http://127.0.0.1:8000');
console.log('2. Target Test Page:     http://localhost:3456');
console.log('3. Health Check:         http://127.0.0.1:8000/health');
console.log('======================================================\n');

process.on('SIGINT', () => {
  try { serverProc.kill(); } catch (e) {}
  try { fixtureServer.close(); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { serverProc.kill(); } catch (e) {}
  try { fixtureServer.close(); } catch (e) {}
  process.exit(0);
});
