#!/usr/bin/env node
// Driver for the Convention Price Sheet (static web app).
// Launches headless Chromium via Playwright against a locally-served index.html,
// runs smoke checks, and writes a screenshot. This is the agent path — there is
// no build step; the app is plain HTML/JS.
//
// Usage:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node driver.mjs [url] [--out FILE] [--full] [--edit]
//
//   url        page to drive (default http://localhost:8089/index.html)
//   --out      screenshot path (default /tmp/pricesheet.png)
//   --full     full-page screenshot instead of viewport
//   --edit     click the "+ Add / Edit" FAB and screenshot the edit UI
//
// Exit code 0 = all smoke checks passed; non-zero = something is wrong.
//
// Playwright is installed globally in this container, so the driver resolves it
// from the global node_modules rather than relying on a bare ESM import.

import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const groot = execSync('npm root -g').toString().trim();
  ({ chromium } = require(`${groot}/playwright`));
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || 'http://localhost:8089/index.html';
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : '/tmp/pricesheet.png';
const fullPage = args.includes('--full');
const doEdit = args.includes('--edit');

const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

// Separate real JS errors (app bugs) from external-resource load failures.
// Google Fonts and the Cloudflare sync Worker are blocked by the container's
// network, producing ERR_CERT_AUTHORITY_INVALID / ERR_NAME_NOT_RESOLVED noise
// that is NOT an app failure.
const NETWORK_NOISE = /ERR_CERT_AUTHORITY_INVALID|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|Failed to load resource/i;
const jsErrors = [];
const netNoise = [];
const bucket = (t) => (NETWORK_NOISE.test(t) ? netNoise : jsErrors).push(t);
page.on('console', (m) => { if (m.type() === 'error') bucket(m.text()); });
page.on('pageerror', (e) => bucket(String(e)));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

// Smoke checks
const title = await page.title();
console.log('title:', title);
if (!/price sheet/i.test(title)) fail(`unexpected title: ${title}`);

// <image-slot> is a custom element — confirm it upgraded (shadow/own content rendered).
const slotCount = await page.locator('image-slot').count();
console.log('image-slot elements:', slotCount);
if (slotCount < 1) fail('no <image-slot> elements found');

const slotDefined = await page.evaluate(() => !!customElements.get('image-slot'));
console.log('image-slot customElement defined:', slotDefined);
if (!slotDefined) fail('image-slot custom element did not register (image-slot.js failed to load)');

// Product grids should be populated from assets/<group>/index.json manifests.
const flowerCards = await page.locator('#flower-grid .thumb, #flower-grid image-slot').count();
console.log('flower grid items:', flowerCards);

// Edit FAB exists (inline edit mode entry point).
const fab = page.locator('#edit-toggle-fab');
if ((await fab.count()) === 0) fail('edit FAB (#edit-toggle-fab) missing');

if (doEdit) {
  await fab.click();
  await page.waitForTimeout(500);
  console.log('clicked edit FAB');
}

await page.screenshot({ path: out, fullPage });
console.log('screenshot:', out, fullPage ? '(full page)' : '(viewport)');

if (netNoise.length) {
  console.log(`note: ${netNoise.length} external-resource error(s) (fonts/sync Worker blocked by sandbox) — ignored`);
}
if (jsErrors.length) {
  console.error('JS errors:\n  ' + jsErrors.slice(0, 10).join('\n  '));
  fail(`${jsErrors.length} JS/page error(s)`);
}

await browser.close();
console.log(process.exitCode ? 'DONE (with failures)' : 'OK: all smoke checks passed');
