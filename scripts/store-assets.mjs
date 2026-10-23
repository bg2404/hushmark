// Renders the Chrome Web Store images into store/assets/:
//   screenshot-1..5.png  1280x800, the real extension running in Chromium
//   promo-small.png      440x280 small promo tile
//   store-icon-128.png   128x128 icon: 96x96 artwork with 16px transparent padding
//
// Screenshots are of the unpacked extension in extension/ opening
// store/sample/website-relaunch.md from disk, so they show the UI exactly as
// a user would see it. Store images must not have an alpha channel, so every
// screenshot and the promo tile are checked after writing.
//
//   npm run store:assets
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'extension');
const outDir = join(root, 'store', 'assets');
const sample = pathToFileURL(join(root, 'store', 'sample', 'website-relaunch.md')).href;
const profileDir = join(root, 'test', '.store-profile');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* fall through */ }
  const cache = join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
  for (const b of (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const bin = join(cache, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(bin)) return bin;
  }
  throw new Error('No Chromium found. Run: npx playwright install chromium   (or set CHROMIUM_PATH)');
}

// PNG colour type lives in the IHDR chunk at byte 25: 2 = RGB, 6 = RGBA.
function pngColorType(path) {
  return readFileSync(path)[25];
}

mkdirSync(outDir, { recursive: true });
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
// Hushmark keeps its settings in chrome.storage.local, reached through the
// extension's service worker.
const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const page = await context.newPage();
const requests = [];
page.on('request', (r) => { if (/^https?:/i.test(r.url())) requests.push(r.url()); });

async function open(prefs) {
  await sw.evaluate((p) => chrome.storage.local.set({ prefs: p }), prefs);
  await page.goto(sample);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv'));
  await page.waitForTimeout(300);
}

async function shot(name) {
  await page.mouse.move(1279, 799); // park the pointer away from hover states
  await page.waitForTimeout(250);
  const path = join(outDir, name);
  await page.screenshot({ path, type: 'png' });
  return path;
}

const written = [];

// 1. Read mode, the default light theme, with the outline open
await open({ theme: 'github-light', toc: true });
written.push(await shot('screenshot-1.png'));

// 2. Edit mode: formatting bar, caret in the milestones table with its tools showing
await open({ theme: 'github-light' });
await page.click('button[data-mode="edit"]');
await page.evaluate(() => {
  const cell = [...document.querySelectorAll('main.mdv-content td')].find((td) => td.textContent.trim() === 'In review');
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.querySelector('main.mdv-content').focus();
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
written.push(await shot('screenshot-2.png'));

// 3. Source mode with live preview, GitHub Dark
await open({ theme: 'github-dark' });
await page.click('button[data-mode="source"]');
await page.evaluate(() => { const t = document.querySelector('.mdv-source'); t.setSelectionRange(0, 0); t.scrollTop = 0; t.blur(); });
written.push(await shot('screenshot-3.png'));

// 4. Settings: the theme picker open, previewing Nord on the page behind it
await open({ theme: 'github-light' });
await page.click('.mdv-settings-toggle');
await page.waitForTimeout(250);
await page.click('.mdv-picker-button');
await page.hover('.mdv-picker-option[data-value="nord"]');
await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv-theme') === 'nord'); // the preview waits for the pointer to rest
await page.waitForTimeout(200);
{
  const path = join(outDir, 'screenshot-4.png');
  await page.screenshot({ path, type: 'png' }); // keep the pointer on the option
  written.push(path);
}
await page.keyboard.press('Escape');

// 5. A calm reading setup: Sepia, serif, larger text, a comfortable column
await open({ theme: 'sepia', font: 'serif', size: 18, width: 'comfortable' });
await page.evaluate(() => { const h = [...document.querySelectorAll('main.mdv-content h2')].find((x) => x.textContent.includes('Decisions')); h.scrollIntoView({ block: 'start' }); document.querySelector('.mdv-stage').scrollTop -= 24; });
written.push(await shot('screenshot-5.png'));

await context.close();

/* ------------------------------------------------- promo tile and icon */

const svg = readFileSync(join(extensionPath, 'icons', 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const plain = await browser.newPage({ deviceScaleFactor: 1 });

await plain.setViewportSize({ width: 440, height: 280 });
await plain.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
  body {
    display: flex; align-items: center; gap: 26px; box-sizing: border-box; padding: 0 34px;
    background: radial-gradient(120% 140% at 0% 0%, #2b3440 0%, #161b22 55%, #0d1117 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    color: #f0f6fc;
  }
  .icon svg { width: 112px; height: 112px; display: block; filter: drop-shadow(0 6px 18px rgba(0,0,0,.45)); }
  h1 { margin: 0 0 10px; font-size: 48px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
  p { margin: 0; font-size: 21px; line-height: 1.3; color: #c9d1d9; }
</style></head><body>
  <div class="icon">${svg.replace('width="128" height="128"', 'width="112" height="112"')}</div>
  <div>
    <h1>Hushmark</h1>
    <p>Private Markdown<br>viewer &amp; editor</p>
  </div>
</body></html>`);
const tile = join(outDir, 'promo-small.png');
await plain.screenshot({ path: tile, type: 'png', omitBackground: false });
written.push(tile);

await plain.setViewportSize({ width: 128, height: 128 });
await plain.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
  <div style="width:128px;height:128px;display:flex;align-items:center;justify-content:center">
  ${svg.replace('width="128" height="128"', 'width="96" height="96"')}</div></body></html>`);
const icon = join(outDir, 'store-icon-128.png');
await plain.screenshot({ path: icon, type: 'png', omitBackground: true });
await browser.close();

/* -------------------------------------------------------------- checks */

let ok = true;
for (const p of written) {
  const type = pngColorType(p);
  const name = p.slice(outDir.length + 1);
  const alpha = type === 6 || type === 4;
  console.log(`${alpha ? 'ALPHA ' : 'ok    '} ${name}  (PNG colour type ${type})`);
  if (alpha) ok = false;
}
console.log(`ok     store-icon-128.png  (transparent padding expected)`);
if (requests.length) {
  console.log('network requests during rendering: ' + requests.join(', '));
  ok = false;
}
if (!ok) process.exit(1);
