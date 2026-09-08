import puppeteer from 'puppeteer-core';

const browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--no-sandbox', '--window-size=1200,800'],
});

const page = await browser.newPage();
console.log('Navigating to https://jspaint.app...');
await page.goto('https://jspaint.app', { waitUntil: 'domcontentloaded', timeout: 20000 });
const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
console.log('Canvas elements on jspaint.app:', canvasCount);

await browser.close();
process.exit(0);
