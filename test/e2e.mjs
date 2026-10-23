// End-to-end test: loads the unpacked extension into a throwaway Chromium
// profile, opens the fixture files from disk, and checks rendering, editing,
// themes, saving, XSS resistance, and that the pages make zero network
// requests.
//
//   npm test                 (headless)
//   HEADED=1 npm test        (visible browser window)
//
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// HUSHMARK_EXTENSION_DIR lets the suite run against an unpacked store zip.
const extensionPath = realpathSync(process.env.HUSHMARK_EXTENSION_DIR ? resolve(process.env.HUSHMARK_EXTENSION_DIR) : resolve(here, '..', 'extension'));
const EXTENSION_NAME = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8')).name;
const fixtures = resolve(here, 'fixtures');
const outDir = resolve(here, 'output');
const profileDir = resolve(here, '.profile');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -- ${detail}` : ''}`);
}

const fileUrl = (name, hash = '') => pathToFileURL(join(fixtures, name)).href + hash;

// Google Chrome's branded stable builds ignore --load-extension since
// Chrome 137, so the test needs a Chromium build. Playwright's cached
// Chromium for Testing is used; set CHROMIUM_PATH to override.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* fall through */ }
  const cache = join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const b of builds) {
      const bin = join(cache, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error('No Chromium found. Run: npx playwright install chromium   (or set CHROMIUM_PATH)');
}

async function launch({ headless }) {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    executablePath: findChromium(),
    headless,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function openFixture(context, name, hash = '') {
  const page = await context.newPage();
  const remote = [];
  const errors = [];
  page.on('request', (r) => { if (/^(?:https?:|file:\/\/(?!\/|localhost\/))/i.test(r.url())) remote.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(fileUrl(name, hash));
  await page.waitForTimeout(250);
  return { page, remote, errors };
}

const rendered = (page) => page.evaluate(() => document.documentElement.getAttribute('data-mdv'));
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const realErrors = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

// Evaluates JavaScript inside the extension's content-script world (the
// isolated world Chrome gives content scripts), which page.evaluate cannot
// reach. Used to call the extension's own API and to stub the file picker.
async function isolatedWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 150));
  const ctx = contexts.find((c) => c.auxData && c.auxData.isDefault === false && c.name === EXTENSION_NAME);
  if (!ctx) throw new Error('content-script world not found among: ' + JSON.stringify(contexts.map((c) => c.name)));
  return {
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('isolated eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    detach: () => cdp.detach().catch(() => {}),
  };
}

// A stand-in for Chrome's file pickers, run inside the extension's own script
// context. window.__disk is the one file on "disk": its name and its bytes.
// showOpenFilePicker returns a handle to it without emptying it (as Chrome's
// open dialog does); permission is tracked per handle; writes replace the
// bytes and mirror the decoded text onto <html data-test-saved>.
const SAVE_STUB = `
  window.__picks = 0;
  window.__perm = [];
  window.__disk = window.__disk || { name: 'untitled.md', bytes: new Uint8Array(0) };
  const decode = (bytes) => {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  };
  const makeHandle = () => {
    let granted = false;
    return {
      kind: 'file',
      name: window.__pickName || window.__disk.name,
      queryPermission: async () => { window.__perm.push('query'); return granted ? 'granted' : 'prompt'; },
      requestPermission: async () => {
        window.__perm.push('request');
        if (window.__gestureOnce) { window.__gestureOnce = false; throw new DOMException('User activation is required', 'SecurityError'); }
        granted = true;
        return 'granted';
      },
      getFile: async () => {
        const bytes = window.__disk.bytes.slice();
        return { text: async () => decode(bytes), arrayBuffer: async () => bytes.buffer };
      },
      createWritable: async () => {
        const parts = [];
        return {
          write: async (chunk) => { parts.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer || chunk)); },
          abort: async () => {},
          close: async () => {
            const size = parts.reduce((n, p) => n + p.length, 0);
            const out = new Uint8Array(size);
            let o = 0;
            for (const p of parts) { out.set(p, o); o += p.length; }
            window.__disk.bytes = out;
            document.documentElement.setAttribute('data-test-saved', decode(out).replace(/^\\uFEFF/, ''));
          },
        };
      },
    };
  };
  window.showOpenFilePicker = async () => { window.__picks += 1; return [makeHandle()]; };
  window.showSaveFilePicker = async () => { throw new Error('the save dialog should not be used'); };
  true`;

// Puts `text` (or raw bytes given as an array) on the stand-in disk.
const diskWith = (name, text) => `window.__disk = { name: ${JSON.stringify(name)}, bytes: new TextEncoder().encode(${JSON.stringify(text)}) }; true`;
const diskWithBytes = (name, bytes) => `window.__disk = { name: ${JSON.stringify(name)}, bytes: new Uint8Array(${JSON.stringify(Array.from(bytes))}) }; true`;

async function setSelection(page, selector, where) {
  await page.evaluate(([sel, w]) => {
    const el = document.querySelector(sel);
    const r = document.createRange();
    if (w === 'end' || w === 'start') { r.selectNodeContents(el); r.collapse(w === 'start'); }
    else { // select the first occurrence of a word
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.nodeValue.indexOf(w);
        if (i >= 0) { r.setStart(n, i); r.setEnd(n, i + w.length); break; }
      }
    }
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, [selector, where]);
}

const xssAudit = (page) => page.evaluate(() => {
  const main = document.querySelector('.mdv-content');
  const bad = [];
  if (!main) return ['no .mdv-content'];
  for (const el of main.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'iframe', 'frame', 'object', 'embed', 'applet', 'form', 'button', 'style', 'meta', 'base', 'link', 'svg', 'math', 'template', 'marquee', 'textarea', 'select', 'noscript', 'portal', 'fencedframe'].includes(tag)) bad.push('<' + tag + '>');
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') bad.push('non-html ns:' + tag);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) bad.push(tag + '@' + a.name);
      if (a.name === 'style') bad.push(tag + '@style');
      if (a.name === 'spellcheck') bad.push(tag + '@spellcheck');
      if (['href', 'src', 'srcset', 'data', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'ping'].includes(a.name) && /^\s*(javascript|vbscript|data):/i.test(a.value) && !(tag === 'img' && a.name === 'src' && /^\s*data:image\//i.test(a.value))) bad.push(tag + '@' + a.name + '=' + a.value.slice(0, 40));
    }
    if (tag === 'input' && !(el.type === 'checkbox' && (el.disabled || main.isContentEditable))) bad.push('live input');
    if (tag === 'a' && el.getAttribute('target')) bad.push('a@target');
  }
  if (document.querySelector('[name="getElementById"], #querySelector, [name="body"], [name="cookie"], [id="cookie"]')) bad.push('dom clobbering attr survived');
  if (getComputedStyle(document.body).display === 'none') bad.push('body hidden by <style>');
  if (document.querySelector('base, meta[http-equiv]')) bad.push('<base>/<meta http-equiv> in document');
  if (!document.querySelector('.mdv-top') || !document.querySelector('.mdv-modes')) bad.push('toolbar missing');
  return bad;
});

const headless = !process.env.HEADED;
const context = await launch({ headless });
const allRemote = [];
// md.test is the stand-in website served by context.route below; remote.invalid
// is what the web-images tests deliberately ask to load.
context.on('request', (r) => { if (/^(?:https?:|file:\/\/(?!\/|localhost\/))/i.test(r.url()) && !/remote\.invalid|\/\/md\.test\//.test(r.url())) allRemote.push(r.url()); });

// Hushmark keeps its settings in chrome.storage.local; the tests reach it
// through the extension's service worker.
const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const setPrefs = (prefs) => sw.evaluate((p) => chrome.storage.local.set({ prefs: p }), prefs);
const clearPrefs = () => sw.evaluate(() => chrome.storage.local.remove('prefs'));
const getPrefs = () => sw.evaluate(async () => (await chrome.storage.local.get('prefs')).prefs || null);
const webScriptRegistered = () => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['hushmark-web'] })).length === 1);
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
console.log(`chromium: ${findChromium()}  headless=${headless}`);
console.log(`extension: ${extensionPath}`);

try {
  // ---------------------------------------------------------------- basic
  {
    const { page, remote, errors } = await openFixture(context, 'basic.md');
    check('basic: rendered', (await rendered(page)) === 'rendered');
    check('basic: no http(s) requests', remote.length === 0, remote.join(', '));
    check('basic: no console/page errors', errors.length === 0, errors.join(' | '));
    check('basic: original <pre> hidden', await page.evaluate(() => { const p = document.querySelector('.mdv-root > pre'); return p.hidden && getComputedStyle(p).display === 'none'; }));
    check('basic: document.title', await page.title() === 'Hushmark fixture · basic.md', await page.title());
    check('basic: filename in toolbar', await page.textContent('.mdv-filename') === 'basic.md');
    check('basic: Read mode selected', await page.getAttribute('button[data-mode="read"]', 'aria-pressed') === 'true');
    check('basic: h1 text', (await page.textContent('.mdv-content h1')).includes('Hushmark fixture'));
    check('basic: front matter table', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table.mdv-frontmatter tr')].map((r) => r.textContent);
      return rows.length === 3 && rows[0] === 'titleHushmark fixture';
    }));
    check('basic: no literal front matter in body', !(await page.textContent('.mdv-content')).includes('tags: test'));
    check('basic: GFM table', await page.evaluate(() => document.querySelectorAll('.mdv-content table:not(.mdv-frontmatter) td').length === 6));
    check('basic: task list checkboxes disabled', await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.mdv-content input')];
      return boxes.length === 2 && boxes.every((b) => b.type === 'checkbox' && b.disabled) && boxes[0].checked && !boxes[1].checked;
    }));
    check('basic: fenced code keeps language class', await page.evaluate(() => !!document.querySelector('.mdv-content pre code.language-js')));
    check('basic: strikethrough', await page.evaluate(() => !!document.querySelector('.mdv-content del')));
    check('basic: autolink', await page.evaluate(() => !!document.querySelector('.mdv-content a[href="https://example.org/also-never-fetched"]')));
    check('basic: relative image loaded from disk', await page.evaluate(() => {
      const img = document.querySelector('.mdv-content img');
      return img && img.complete && img.naturalWidth === 48;
    }));
    check('basic: inline <details> kept', await page.evaluate(() => !!document.querySelector('.mdv-content details > summary')));
    check('basic: <kbd> kept', await page.evaluate(() => document.querySelectorAll('.mdv-content kbd').length === 2));
    const ids = await page.evaluate(() => [...document.querySelectorAll('.mdv-content h1, .mdv-content h2, .mdv-content h3')].map((h) => h.id));
    check('basic: heading ids', JSON.stringify(ids) === JSON.stringify([
      'hushmark-fixture', 'lists', 'table', 'code', 'quote', 'image',
      'duplicate', 'duplicate-1', 'hello-world-punctuation--quotes', 'inline-html',
    ]), JSON.stringify(ids));
    check('basic: anchor links point at their heading', await page.evaluate(() =>
      [...document.querySelectorAll('.mdv-content h2')].every((h) => h.querySelector('a.mdv-anchor').getAttribute('href') === '#' + h.id)));
    check('basic: light background by default', (await bg(page)) === 'rgb(255, 255, 255)', await bg(page));
    check('basic: word count shown', /\d+ words/.test(await page.textContent('.mdv-words')), await page.textContent('.mdv-words'));
    await page.screenshot({ path: join(outDir, 'basic-light.png'), fullPage: true });

    // source mode shows the exact original text
    await page.click('button[data-mode="source"]');
    check('source: textarea visible with original text', await page.evaluate(() => {
      const t = document.querySelector('.mdv-source');
      return !document.querySelector('.mdv-split').hidden && document.querySelector('.mdv-stage').hidden && t.value.startsWith('---\ntitle: Hushmark fixture');
    }));
    check('source: preview rendered', await page.evaluate(() => !!document.querySelector('.mdv-preview h1')));
    check('source: data-mdv="source"', (await rendered(page)) === 'source');
    await page.click('button[data-mode="read"]');
    check('source: back to Read', await page.evaluate(() => !document.querySelector('.mdv-stage').hidden && document.querySelector('.mdv-split').hidden));
    check('source: untouched document is not dirty', !(await page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty'))));

    // dark mode (auto theme)
    await page.emulateMedia({ colorScheme: 'dark' });
    check('dark: auto theme follows system', (await bg(page)) === 'rgb(13, 17, 23)', await bg(page));
    await page.screenshot({ path: join(outDir, 'basic-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });

    // relative link navigation + hash scroll on the new page
    await page.click('.mdv-content a[href$="linked.md#target"]');
    await page.waitForFunction(() => location.pathname.endsWith('linked.md') && document.documentElement.getAttribute('data-mdv'));
    await page.waitForTimeout(200);
    check('link: navigated to linked.md and rendered', (await rendered(page)) === 'rendered');
    check('link: scrolled to #target', await page.evaluate(() => {
      const stage = document.querySelector('.mdv-stage');
      const r = document.getElementById('target').getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return stage.scrollTop > 500 && r.top >= s.top && r.top < s.top + 200;
    }), await page.evaluate(() => `scrollTop=${document.querySelector('.mdv-stage').scrollTop} top=${document.getElementById('target').getBoundingClientRect().top}`));
    check('link: inline style attribute stripped', await page.evaluate(() => !document.querySelector('.mdv-content [style]')));
    await page.close();
  }

  // ---------------------------------------------------------- hash on load
  {
    const { page } = await openFixture(context, 'linked.md', '#target');
    check('hash: scrolls to heading on load', await page.evaluate(() => {
      const stage = document.querySelector('.mdv-stage');
      const r = document.getElementById('target').getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return stage.scrollTop > 500 && r.top >= s.top && r.top < s.top + 200;
    }), await page.evaluate(() => `scrollTop=${document.querySelector('.mdv-stage').scrollTop} top=${document.getElementById('target').getBoundingClientRect().top}`));
    await page.close();
  }

  // --------------------------------------------------------------- themes
  {
    const { page, errors } = await openFixture(context, 'basic.md');
    await page.click('.mdv-settings-toggle');
    check('themes: settings panel opens', await page.evaluate(() => document.querySelector('dialog.mdv-settings').open));
    check('settings: focus starts on the theme picker', await page.evaluate(() => document.activeElement === document.querySelector('.mdv-picker-button')));
    await page.click('.mdv-picker-button');
    check('themes: the picker lists all ten themes', await page.evaluate(() => !document.querySelector('.mdv-picker-list').hidden && document.querySelectorAll('.mdv-picker-option').length === 10));
    check('themes: Auto, then the light themes, then the dark ones', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.mdv-picker-option')].map((o) => o.dataset.value))) === JSON.stringify(['auto', 'github-light', 'solarized-light', 'sepia', 'github-dark', 'solarized-dark', 'nord', 'dracula', 'gruvbox-dark', 'one-dark']) &&
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.mdv-picker-group')].map((g) => g.getAttribute('role') + ':' + document.getElementById(g.getAttribute('aria-labelledby')).textContent))) === JSON.stringify(['group:Light', 'group:Dark']));
    check('themes: the theme button is named "Theme" with its value', (await page.getByRole('button', { name: 'Theme Auto (system)', exact: true }).count()) === 1);
    check('themes: the hover hint is not read as the button\'s description', (await page.getAttribute('.mdv-picker-button', 'aria-describedby')) === null);
    check('settings: each switch is named by its label alone', (await page.getByRole('switch', { name: 'Autosave', exact: true }).count()) === 1 && (await page.getByRole('switch', { name: 'Spell check', exact: true }).count()) === 1);

    // hovering previews a theme without saving it, once the pointer rests
    await page.hover('.mdv-picker-option[data-value="dracula"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv-theme') === 'dracula', null, { timeout: 2000 }).catch(() => {});
    check('themes: hovering a theme previews it', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'dracula' && (await bg(page)) === 'rgb(40, 42, 54)', await bg(page));
    check('themes: ... without saving it', ((await getPrefs()) || {}).theme === undefined || ((await getPrefs()) || {}).theme === 'auto', JSON.stringify(await getPrefs()));
    await page.mouse.move(100, 400); // off the list
    check('themes: moving off the list goes back to the saved theme', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'auto');
    check('themes: ... and highlights the saved theme again', await page.evaluate(() => document.querySelector('.mdv-picker-option.mdv-active').dataset.value) === 'auto');

    // sweeping the pointer across the list does not flash every theme
    {
      const box = async (v) => page.locator(`.mdv-picker-option[data-value="${v}"]`).boundingBox();
      const top = await box('auto');
      const bottom = await box('one-dark');
      await page.mouse.move(top.x + 40, top.y + top.height / 2);
      await page.evaluate(() => {
        window.__themeChanges = 0;
        new MutationObserver((list) => { window.__themeChanges += list.length; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mdv-theme'] });
      });
      await page.mouse.move(bottom.x + 40, bottom.y + bottom.height / 2, { steps: 12 });
      await page.mouse.move(top.x + 40, top.y + top.height / 2, { steps: 12 });
      const during = await page.evaluate(() => window.__themeChanges);
      await page.mouse.move(100, 400);
      check('themes: a quick sweep over the list previews almost nothing', during <= 2, `${during} theme changes`);
    }

    // keyboard: arrows preview, Escape cancels (and closes only the list)
    await page.focus('.mdv-picker-list');
    await page.keyboard.press('ArrowDown');
    check('themes: arrow keys preview the next theme at once', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'github-light');
    await page.keyboard.press('Escape');
    check('themes: Escape cancels the preview and closes the list', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme') === 'auto' && document.querySelector('.mdv-picker-list').hidden && document.querySelector('dialog.mdv-settings').open));

    // picking saves it
    await page.click('.mdv-picker-button');
    await page.click('.mdv-picker-option[data-value="nord"]');
    check('themes: nord applied', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'nord' && (await bg(page)) === 'rgb(46, 52, 64)', await bg(page));
    check('themes: the picker shows the saved theme', (await page.textContent('.mdv-picker-name')) === 'Nord' && (await page.getAttribute('.mdv-picker-option[data-value="nord"]', 'aria-selected')) === 'true' && ((await getPrefs()) || {}).theme === 'nord');
    await page.click('.mdv-picker-button');
    await page.focus('.mdv-picker-list');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    check('themes: Enter picks the highlighted theme', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'dracula' && ((await getPrefs()) || {}).theme === 'dracula');
    await page.click('.mdv-picker-button');
    await page.click('.mdv-picker-option[data-value="nord"]');
    {
      // the list opening under a pointer that has not moved is not hover
      await page.click('.mdv-picker-button');
      const sepia = await page.locator('.mdv-picker-option[data-value="sepia"]').boundingBox();
      await page.keyboard.press('Escape');
      await page.mouse.move(sepia.x + 60, sepia.y + sepia.height / 2);
      await page.focus('.mdv-picker-button');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const still = await page.evaluate(() => ({ active: document.querySelector('.mdv-picker-option.mdv-active').dataset.value, shown: document.documentElement.getAttribute('data-mdv-theme') }));
      check('themes: a list opening under a still pointer highlights and previews nothing', still.active === 'nord' && still.shown === 'nord', JSON.stringify(still));
      await page.keyboard.press('Escape');
      await page.mouse.move(100, 400);
    }

    // the support footer is always in view
    const foot = await page.evaluate(() => {
      const d = document.querySelector('dialog.mdv-settings').getBoundingClientRect();
      const f = document.querySelector('.mdv-set-foot');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { atBottom: Math.abs(r.bottom - d.bottom) <= 2, cup: !!f.querySelector('svg.mdv-coffee'), text: f.textContent };
    });
    const supportConfigured = /supportUrl:\s*'https:/.test(readFileSync(join(extensionPath, 'src', 'config.js'), 'utf8'));
    check(supportConfigured ? 'support: the support footer is pinned to the bottom with the coffee cup' : 'support: no footer without a support link',
      supportConfigured ? !!foot && foot.atBottom && foot.cup && /Buy me a coffee/.test(foot.text) : foot === null, JSON.stringify(foot));
    await page.evaluate(() => { document.querySelector('.mdv-set-body').scrollTop = 99999; });
    check('support: ... and stays in view when the settings scroll', supportConfigured ? await page.evaluate(() => { const f = document.querySelector('.mdv-set-foot').getBoundingClientRect(); return f.top >= 0 && f.bottom <= window.innerHeight; }) : true);
    await page.evaluate(() => { document.querySelector('.mdv-set-body').scrollTop = 0; });

    await page.click('.mdv-segmented[data-pref="font"] [data-value="serif"]');
    check('settings: the font control shows the choice', await page.getAttribute('.mdv-segmented[data-pref="font"] [data-value="serif"]', 'aria-checked') === 'true');
    check('themes: serif font applied', /Palatino|Georgia/.test(await page.evaluate(() => getComputedStyle(document.body).fontFamily)));
    await page.click('.mdv-settings button[title="Larger text"]');
    await page.click('.mdv-settings button[title="Larger text"]');
    {
      // at the largest size the button keeps focus (it is not disabled)
      await page.focus('.mdv-settings button[title="Larger text"]');
      for (let i = 0; i < 8; i++) await page.keyboard.press('Enter');
      const atMax = await page.evaluate(() => { const b = document.querySelector('.mdv-settings button[title="Larger text"]'); return { size: document.querySelector('.mdv-step-value').textContent, disabled: b.getAttribute('aria-disabled'), focused: document.activeElement === b }; });
      check('settings: the text-size button keeps focus at the largest size', atMax.size === '24 px' && atMax.disabled === 'true' && atMax.focused, JSON.stringify(atMax));
      for (let i = 0; i < 6; i++) await page.click('.mdv-settings button[title="Smaller text"]');
    }
    check('themes: text size 18px reaches the document', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-content p')).fontSize) === '18px', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-content p')).fontSize));
    check('themes: full width by default', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth) === 'none');
    await page.click('.mdv-segmented[data-pref="width"] [data-value="comfortable"]');
    check('themes: comfortable width caps the column', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth) === '1088px', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth));
    await page.screenshot({ path: join(outDir, 'theme-nord.png'), fullPage: false });
    await page.keyboard.press('Escape');
    {
      const configured = (readFileSync(join(extensionPath, 'src', 'config.js'), 'utf8').match(/supportUrl:\s*'([^']*)'/) || [])[1] || '';
      const link = await page.evaluate(() => { const a = document.querySelector('.mdv-settings a.mdv-support-link'); return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null; });
      check(configured ? 'support: Settings links to the configured support page, safely' : 'support: no support link while none is configured',
        configured ? !!link && link.href === configured && link.target === '_blank' && /noopener/.test(link.rel) && /noreferrer/.test(link.rel) : link === null,
        JSON.stringify(link));
    }
    check('themes: Escape closes settings', await page.evaluate(() => !document.querySelector('dialog.mdv-settings').open));
    check('themes: focus returns to the settings button', await page.evaluate(() => document.activeElement === document.querySelector('.mdv-settings-toggle')));

    await page.reload();
    await page.waitForTimeout(300);
    check('themes: persist across reload', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme') === 'nord' && document.documentElement.getAttribute('data-mdv-font') === 'serif' && getComputedStyle(document.querySelector('.mdv-content p')).fontSize === '18px'));

    // every theme renders with a distinct background and no errors
    const seen = new Set();
    for (const id of ['github-light', 'github-dark', 'solarized-light', 'solarized-dark', 'sepia', 'nord', 'dracula', 'gruvbox-dark', 'one-dark']) {
      await setPrefs({ theme: id });
      await page.reload();
      await page.waitForTimeout(150);
      seen.add(await bg(page));
      if (id === 'sepia' || id === 'dracula') await page.screenshot({ path: join(outDir, `theme-${id}.png`) });
    }
    check('themes: nine explicit themes have distinct backgrounds', seen.size === 9, [...seen].join(' | '));

    // outline
    await clearPrefs();
    await page.reload();
    await page.waitForTimeout(200);
    await page.click('.mdv-toc-toggle');
    check('outline: lists headings', await page.evaluate(() => !document.querySelector('.mdv-toc').hidden && document.querySelectorAll('.mdv-toc a').length === 10));
    await page.click('.mdv-toc a[href="#duplicate-1"]');
    await page.waitForTimeout(100);
    check('outline: click scrolls to heading', await page.evaluate(() => document.querySelector('.mdv-stage').scrollTop > 100 && location.hash === '#duplicate-1'));
    await page.click('.mdv-toc-toggle');
    check('outline: toggles off', await page.evaluate(() => document.querySelector('.mdv-toc').hidden));
    check('themes: no errors', realErrors(errors).length === 0, realErrors(errors).join(' | '));
    await page.close();
  }

  // -------------------------------------------------------------- editing
  {
    const { page, remote, errors } = await openFixture(context, 'basic.md');
    const world = await isolatedWorld(page);
    check('fsa: File System Access API available on file:// in the content-script world',
      await world.eval('typeof window.showSaveFilePicker === "function" && window.isSecureContext === true'));

    await page.click('button[data-mode="edit"]');
    check('edit: contenteditable on', await page.evaluate(() => document.querySelector('main.mdv-content').getAttribute('contenteditable') === 'true'));
    check('edit: formatting bar visible', await page.evaluate(() => !document.querySelector('.mdv-format').hidden && document.querySelectorAll('.mdv-format button').length >= 20));
    check('edit: heading anchors removed while editing', await page.evaluate(() => !document.querySelector('main .mdv-anchor')));
    check('edit: checkboxes enabled', await page.evaluate(() => [...document.querySelectorAll('main input[type=checkbox]')].every((i) => !i.disabled)));
    check('edit: front matter note shown', await page.evaluate(() => !document.querySelector('.mdv-fm-note').hidden && document.querySelector('.mdv-fm-note pre').textContent.includes('title: Hushmark fixture')));
    check('edit: front matter table not editable content', await page.evaluate(() => !document.querySelector('main table.mdv-frontmatter')));

    // type at the end of the first paragraph
    await setSelection(page, 'main.mdv-content p', 'end');
    await page.keyboard.type(' Added text.');
    check('edit: typing marks the document dirty', await page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty') && document.title.startsWith('●')));
    // Chrome undoes typing in chunks; keep undoing until the typed text is gone
    for (let i = 0; i < 40 && !(await page.evaluate(() => document.querySelector('main p').textContent.trim().endsWith('also-never-fetched.'))); i++) {
      await page.keyboard.press('Meta+z');
    }
    await page.waitForTimeout(300); // the clean check is debounced
    check('edit: undo back to the rendered state clears dirty', !(await page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty'))), await page.evaluate(() => document.querySelector('main p').innerHTML.slice(-160)));
    for (let i = 0; i < 40 && !(await page.evaluate(() => document.querySelector('main p').textContent.includes('Added text.'))); i++) {
      await page.keyboard.press('Meta+Shift+z');
    }
    await page.waitForTimeout(300);
    check('edit: redo makes it dirty again', await page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty') && document.querySelector('main p').textContent.includes('Added text.')));

    // paste: HTML goes through the sanitizer
    await setSelection(page, 'main.mdv-content > p:last-of-type', 'end');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<p><img src="x" onerror="window.__xss=1"><b>pasted bold</b> <a href="javascript:window.__xss=2">bad link</a> <span style="color:red">styled</span></p>');
      dt.setData('text/plain', 'pasted bold bad link styled');
      document.querySelector('main.mdv-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(100);
    check('paste: HTML is sanitized on the way in', await page.evaluate(() => {
      const m = document.querySelector('main.mdv-content');
      return !!m.querySelector('b, strong') && [...m.querySelectorAll('b, strong')].some((b) => b.textContent === 'pasted bold') && !m.querySelector('[onerror], [style], a[href^="javascript"]') && typeof window.__xss === 'undefined';
    }), await page.evaluate(() => document.querySelector('main.mdv-content > p:last-of-type')?.outerHTML.slice(0, 200)));

    // bold a word with the keyboard shortcut
    await setSelection(page, 'main.mdv-content p', 'Added');
    await page.keyboard.press('Meta+b');
    check('edit: Cmd+B bolds the selection', await page.evaluate(() => [...document.querySelectorAll('main p b, main p strong')].some((b) => b.textContent === 'Added')), await page.evaluate(() => document.querySelector('main p').innerHTML.slice(-120)));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    check('edit: toolbar shows bold pressed', await page.getAttribute('.mdv-format .mdv-btn-bold', 'aria-pressed') === 'true');

    // toolbar button: italic via click (selection must survive the click)
    await setSelection(page, 'main.mdv-content p', 'text.');
    await page.click('.mdv-format .mdv-btn-italic');
    check('edit: toolbar italic keeps selection and applies', await page.evaluate(() => [...document.querySelectorAll('main p i, main p em')].some((i) => i.textContent === 'text.')), await page.evaluate(() => document.querySelector('main p').innerHTML.slice(-120)));

    // markdown shortcuts at the end of the document
    await setSelection(page, 'main.mdv-content > p:last-of-type', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Added heading');
    check('edit: "## " turns into an h2', await page.evaluate(() => { const h = [...document.querySelectorAll('main h2')].pop(); return h && h.textContent === 'Added heading'; }), await page.evaluate(() => [...document.querySelectorAll('main h2')].pop()?.outerHTML));
    await page.keyboard.press('Enter');
    await page.keyboard.type('- item one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[ ] todo item');
    check('edit: "- " and "[ ] " make a list with a task item', await page.evaluate(() => {
      const lists = [...document.querySelectorAll('main > ul')];
      const ul = lists[lists.length - 1];
      const items = ul ? [...ul.children] : [];
      return items.length === 2 && items[0].textContent.trim() === 'item one' && items[1].querySelector('input[type=checkbox]') && items[1].textContent.trim() === 'todo item';
    }), await page.evaluate(() => [...document.querySelectorAll('main > ul')].pop()?.outerHTML));
    await page.keyboard.press('Enter');
    check('edit: Enter in a task item starts another task item', await page.evaluate(() => {
      const ul = [...document.querySelectorAll('main > ul')].pop();
      const last = ul && ul.lastElementChild;
      return !!last && !!last.querySelector('input[type=checkbox]') && last.textContent.trim() === '';
    }), await page.evaluate(() => [...document.querySelectorAll('main > ul')].pop()?.outerHTML));
    await page.keyboard.press('Enter');
    check('edit: Enter on an empty task item leaves the list', await page.evaluate(() => {
      const ul = [...document.querySelectorAll('main > ul')].pop();
      return ul.children.length === 2 && ul.nextElementSibling && ul.nextElementSibling.tagName === 'P';
    }), await page.evaluate(() => [...document.querySelectorAll('main > ul')].pop()?.outerHTML + ' NEXT ' + [...document.querySelectorAll('main > ul')].pop()?.nextElementSibling?.outerHTML));
    await page.keyboard.type('```js');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const x = 1;');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const y = 2;');
    check('edit: "```js" opens a fenced code block, Enter keeps newlines inside', await page.evaluate(() => {
      const pre = [...document.querySelectorAll('main pre')].pop();
      return pre && pre.querySelector('code.language-js') && pre.textContent.replace(/\n$/, '') === 'const x = 1;\nconst y = 2;';
    }), await page.evaluate(() => JSON.stringify([...document.querySelectorAll('main pre')].pop()?.innerHTML)));
    await page.keyboard.press('Meta+Enter');
    await page.keyboard.type('> quoted');
    check('edit: Cmd+Enter leaves the code block and "> " makes a quote', await page.evaluate(() => { const q = [...document.querySelectorAll('main blockquote')].pop(); return q && q.textContent.trim() === 'quoted'; }));

    // click a checkbox
    await page.click('main input[type=checkbox] >> nth=1');
    check('edit: clicking a task checkbox toggles it', await page.evaluate(() => document.querySelectorAll('main input[type=checkbox]')[1].checked));

    // table insertion + tools
    await setSelection(page, 'main.mdv-content > p:last-of-type', 'end');
    await page.keyboard.press('Enter');
    await page.click('.mdv-format .mdv-btn-table');
    await page.keyboard.type('Name');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Qty');
    check('edit: table inserted and Tab moves between cells', await page.evaluate(() => {
      const t = [...document.querySelectorAll('main table')].pop();
      const ths = t ? [...t.querySelectorAll('th')].map((c) => c.textContent.trim()) : [];
      return ths.length === 3 && ths[0] === 'Name' && ths[1] === 'Qty' && t.querySelectorAll('tbody tr').length === 2;
    }), await page.evaluate(() => [...document.querySelectorAll('main table')].pop()?.outerHTML));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    check('edit: table tools appear', await page.evaluate(() => !!document.querySelector('.mdv-table-tools')), await page.evaluate(() => { const r = getSelection().rangeCount ? getSelection().getRangeAt(0) : null; return 'active=' + document.activeElement.tagName + ' caret=' + (r ? r.startContainer.nodeName + '>' + r.startContainer.parentNode.nodeName : 'none') + ' inTable=' + !!(r && r.startContainer.parentElement && r.startContainer.parentElement.closest('table')); }));
    await page.click('.mdv-table-tools button:has-text("Add row")');
    check('edit: table tools add a row', await page.evaluate(() => [...document.querySelectorAll('main table')].pop().querySelectorAll('tbody tr').length === 3));

    // keyboard access to the table tools
    const inTable = () => page.evaluate(() => {
      const s = getSelection();
      if (!s.rangeCount) return false;
      const n = s.getRangeAt(0).startContainer;
      const el = n.nodeType === 1 ? n : n.parentElement;
      return document.activeElement === document.querySelector('main.mdv-content') && !!el.closest('table');
    });
    const focusedTool = () => page.evaluate(() => document.activeElement && document.activeElement.closest('.mdv-table-tools') ? document.activeElement.textContent : null);
    // which cell holds the caret: [rowIndex, cellIndex] within the last table
    const caretCell = () => page.evaluate(() => {
      const s = getSelection();
      if (!s.rangeCount) return null;
      const n = s.getRangeAt(0).startContainer;
      const cell = (n.nodeType === 1 ? n : n.parentElement).closest('td, th');
      return cell ? [cell.parentElement.rowIndex, cell.cellIndex] : null;
    });
    // park the caret in the second header cell so the restore has something to prove
    await page.evaluate(() => { const th = [...document.querySelectorAll('main table')].pop().querySelectorAll('th')[1]; const r = document.createRange(); r.selectNodeContents(th); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    const parked = await caretCell();
    await page.keyboard.press('Alt+t');
    check('edit: Alt+T moves focus into the table tools', (await focusedTool()) === 'Add row', String(await focusedTool()));
    await page.keyboard.press('ArrowRight');
    check('edit: arrow keys move between table tool buttons', (await focusedTool()) === 'Add column');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    check('edit: arrows wrap around the strip', (await focusedTool()) === 'Delete table');
    await page.keyboard.press('End');
    check('edit: End reaches the last tool', (await focusedTool()) === 'Delete table');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    check('edit: Enter applies the tool and puts the caret in the new row', (await inTable()) && (await page.evaluate(() => [...document.querySelectorAll('main table')].pop().querySelectorAll('tbody tr').length === 4)) && JSON.stringify(await caretCell()) === JSON.stringify([1, 1]), JSON.stringify(await caretCell()));
    check('edit: the operation is announced for screen readers', await page.evaluate(() => document.querySelector('.mdv-sr-only')?.textContent === 'Row added'));
    // move the selection elsewhere while the strip is focused; Escape must bring it back
    await page.evaluate(() => { const th = [...document.querySelectorAll('main table')].pop().querySelectorAll('th')[1]; const r = document.createRange(); r.selectNodeContents(th); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Alt+t');
    check('edit: Alt+T works again after an operation', (await focusedTool()) === 'Add row');
    const strayThenRefocus = () => page.evaluate(() => {
      const td = [...document.querySelectorAll('main table')].pop().querySelector('tbody tr:last-child td:last-child');
      const r = document.createRange(); r.selectNodeContents(td); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); // this also focuses the editor
      document.querySelector('.mdv-table-tools button').focus();   // re-enter the strip without Alt+T
    });
    await strayThenRefocus();
    await page.keyboard.press('Escape');
    check('edit: Escape returns the caret to the cell it came from', (await inTable()) && JSON.stringify(await caretCell()) === JSON.stringify(parked), JSON.stringify(await caretCell()));
    await page.keyboard.press('Alt+t');
    await strayThenRefocus();
    await page.keyboard.press('Tab');
    check('edit: Tab leaves the tools back to the original cell instead of wandering', (await inTable()) && JSON.stringify(await caretCell()) === JSON.stringify(parked), JSON.stringify(await caretCell()));
    await page.keyboard.press('Alt+t');
    await page.keyboard.press('Shift+Tab');
    check('edit: Shift+Tab from the tools reaches the formatting bar', await page.evaluate(() => !!document.activeElement.closest('.mdv-format')));
    await page.evaluate(() => { const th = [...document.querySelectorAll('main table')].pop().querySelectorAll('th')[1]; const r = document.createRange(); r.selectNodeContents(th); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Alt+t');
    await page.keyboard.press('Escape');
    await page.keyboard.type('Z');
    check('edit: typing after returning goes into the cell', await page.evaluate(() => [...document.querySelectorAll('main table')].pop().querySelectorAll('th')[1].textContent === 'QtyZ'), await page.evaluate(() => [...document.querySelectorAll('main table')].pop().querySelectorAll('th')[1].textContent));
    await page.keyboard.press('Backspace');

    // link dialog
    await setSelection(page, 'main.mdv-content > p:last-of-type', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Meta+k');
    check('edit: link dialog opens', await page.evaluate(() => !!document.querySelector('.mdv-popover[aria-label="Insert link"]')));
    await page.fill('.mdv-popover input[name="text"]', 'Docs');
    await page.fill('.mdv-popover input[name="url"]', 'javascript:alert(1)');
    await page.keyboard.press('Enter');
    check('edit: link dialog rejects javascript: URLs', await page.evaluate(() => !!document.querySelector('.mdv-popover') && document.querySelector('.mdv-popover-error').textContent.length > 0));
    await page.fill('.mdv-popover input[name="url"]', './docs/guide.md');
    await page.keyboard.press('Enter');
    check('edit: link inserted from dialog', await page.evaluate(() => { const a = document.querySelector('main a[href="./docs/guide.md"]'); return !!a && a.textContent === 'Docs' && !document.querySelector('.mdv-popover'); }));

    // source view reflects the rich edits as Markdown
    await page.click('button[data-mode="source"]');
    const md = await page.inputValue('.mdv-source');
    const expectLines = ['---\ntitle: Hushmark fixture', 'autolink https://example.org/also-never-fetched. **Added** *text.*', '## Added heading', '- item one\n- [ ] todo item', '```js\nconst x = 1;\nconst y = 2;\n```', '> quoted', '| Name | Qty |', '[Docs](./docs/guide.md)', '- [x] done task', '- [x] open task', '| Left | Center | Right |', '| :-- | :-: | --: |', '~~strike~~', '<details>\n<summary>Expand me</summary>\n\nHidden *markdown* content.\n\n</details>'];
    for (const line of expectLines) check(`source: contains ${JSON.stringify(line).slice(0, 50)}`, md.includes(line));
    check('source: no non-breaking spaces leaked', !md.includes(' '));
    check('source: no editor artifacts leaked', !/mdv-|data-mdv|contenteditable/.test(md), md.match(/.*mdv.*/)?.[0]);
    writeFileSync(join(outDir, 'edited.md'), md);

    // read mode shows the edits
    await page.click('button[data-mode="read"]');
    check('read after edit: renders the new heading and task', await page.evaluate(() => {
      const h = [...document.querySelectorAll('main h2')].pop();
      const boxes = document.querySelectorAll('main input[type=checkbox]');
      return h && h.textContent.replace(/^#/, '') === 'Added heading' && boxes.length === 3 && boxes[1].checked && [...boxes].every((b) => b.disabled);
    }));

    // save through the (stubbed) File System Access API
    await world.eval(diskWith('basic.md', readFileSync(join(fixtures, 'basic.md'), 'utf8')));
    await world.eval(SAVE_STUB);
    await page.click('.mdv-save');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-test-saved'), null, { timeout: 5000 }).catch(() => {});
    const saved = await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'));
    check('save: first save links the file through the open dialog and writes it', typeof saved === 'string' && saved === md, (await page.textContent('.mdv-save-state')));
    check('save: status says saved', /^Saved \d/.test(await page.textContent('.mdv-save-state')), await page.textContent('.mdv-save-state'));
    check('save: no longer dirty', await page.evaluate(() => !document.querySelector('.mdv-save').classList.contains('mdv-dirty') && !document.title.startsWith('●')));

    // Cmd+S from source mode, reusing the handle
    await page.click('button[data-mode="source"]');
    await page.focus('.mdv-source');
    await page.evaluate(() => { const t = document.querySelector('.mdv-source'); t.setSelectionRange(t.value.length, t.value.length); });
    await page.keyboard.type('\nAppended line.\n');
    check('save: source edit marks dirty', await page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty')));
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => (document.documentElement.getAttribute('data-test-saved') || '').includes('Appended line.'), null, { timeout: 5000 }).catch(() => {});
    check('save: Cmd+S saves from Source mode', (await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'))).endsWith('Appended line.\n'));
    check('save: the file was picked once, then reused after one permission prompt', (await world.eval('JSON.stringify({ picks: window.__picks, perm: window.__perm })')) === JSON.stringify({ picks: 1, perm: ['query', 'request', 'query'] }), await world.eval('JSON.stringify({ picks: window.__picks, perm: window.__perm })'));
    check('save: with "Remember saved files" off, no file address is stored', (await world.eval(`new Promise((done) => { const r = indexedDB.open('local-markdown-viewer', 1); r.onupgradeneeded = () => r.result.createObjectStore('file-handles'); r.onsuccess = () => { const q = r.result.transaction('file-handles').objectStore('file-handles').count(); q.onsuccess = () => { r.result.close(); done(q.result); }; }; })`)) === 0);

    const status = () => page.textContent('.mdv-save-state');
    const dirty = () => page.evaluate(() => document.querySelector('.mdv-save').classList.contains('mdv-dirty'));

    // nothing changed: nothing written
    const writesBefore = await world.eval('window.__disk.bytes.length');
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(150);
    check('save: Cmd+S with no changes writes nothing', (await status()) === 'No changes to save' && (await world.eval('window.__disk.bytes.length')) === writesBefore, await status());

    // the file changed on disk behind the tab's back: refuse to overwrite it
    const lastSaved = await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'));
    await world.eval(`window.__disk.bytes = new TextEncoder().encode('Edited in another program.\\n'); true`);
    await page.focus('.mdv-source');
    await page.keyboard.type('Conflict?');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => /changed on disk/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    check('save: a file changed on disk is not overwritten', /changed on disk/.test(await status()) && (await dirty()) && (await world.eval('new TextDecoder().decode(window.__disk.bytes)')) === 'Edited in another program.\n', await status());
    await world.eval(`window.__disk.bytes = new TextEncoder().encode(${JSON.stringify('')} + document.documentElement.getAttribute('data-test-saved')); true`);

    // picking a different file must not redirect the document
    await page.click('.mdv-settings-toggle');
    await page.click('.mdv-settings button:has-text("Forget saved files")');
    await page.waitForFunction(() => /forgotten/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Escape');
    await world.eval('window.__pickName = "elsewhere.md"; true');
    await page.focus('.mdv-source');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => /not the file this tab opened/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    check('save: choosing a different file saves nothing and leaves the document unsaved', /not the file this tab opened/.test(await status()) && (await dirty()) && (await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'))) === lastSaved, await status());
    await world.eval('window.__pickName = ""; true');

    // Chrome sometimes needs a second key press before it can show its prompt
    await world.eval('window.__gestureOnce = true; true');
    await page.focus('.mdv-source');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => /Press .*S again/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    check('save: if Chrome needs another key press, the status says so', /is linked\. Press .*S again/.test(await status()) && (await dirty()), await status());
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    check('save: the second key press saves', /^Saved \d/.test(await status()) && !(await dirty()) && (await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'))).includes('Conflict?'), await status());
    check('edit: no http(s) requests during editing', remote.length === 0, remote.join(', '));
    check('edit: no console/page errors', realErrors(errors).length === 0, realErrors(errors).join(' | '));
    await page.screenshot({ path: join(outDir, 'editing.png'), fullPage: true });
    await world.detach();
    await page.close();
  }

  // ------------------------------------------- settings storage, migration
  {
    // settings from an earlier version, in the localStorage of file:// pages
    const plant = (p) => page.evaluate((v) => localStorage.setItem('local-markdown-viewer:prefs', JSON.stringify(v)), p);
    await clearPrefs();
    const { page } = await openFixture(context, 'basic.md');
    check('migration: a new install never imports old settings', (await sw.evaluate(async () => (await chrome.storage.local.get('legacyChecked')).legacyChecked)) === true);
    await plant({ theme: 'dracula' });
    await page.reload();
    await page.waitForTimeout(300);
    check('migration: ... so a local page cannot plant settings through the old key', (await getPrefs()) === null && await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'auto', JSON.stringify(await getPrefs()));
    // as after an update from 2.0
    await sw.evaluate(() => chrome.storage.local.remove('legacyChecked'));
    await plant({ theme: 'sepia', size: 19, autosave: true, remoteImages: true, rememberFiles: true, spellcheck: true });
    await page.reload();
    await page.waitForTimeout(300);
    check('migration: old settings are moved into extension storage', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'sepia' && ((await getPrefs()) || {}).size === 19, JSON.stringify(await getPrefs()));
    check('migration: ... except options that lower privacy', ((await getPrefs()) || {}).remoteImages === false && ((await getPrefs()) || {}).rememberFiles === false && ((await getPrefs()) || {}).spellcheck === false && ((await getPrefs()) || {}).autosave === true, JSON.stringify(await getPrefs()));
    check('migration: ... and removed from the page storage other local files can read', await page.evaluate(() => localStorage.getItem('local-markdown-viewer:prefs')) === null);
    await clearPrefs();
    await plant({ theme: 'nord' });
    await page.reload();
    await page.waitForTimeout(300);
    check('migration: ... only once', (await getPrefs()) === null, JSON.stringify(await getPrefs()));
    await page.evaluate(() => localStorage.clear());
    await page.click('.mdv-toc-toggle');
    check('settings: changing a setting writes nothing to page storage', await page.evaluate(() => localStorage.length) === 0, await page.evaluate(() => JSON.stringify(Object.keys(localStorage))));
    await clearPrefs();
    await page.close();
  }

  // ------------------------------------------------------------- websites
  {
    const logo = readFileSync(join(fixtures, 'assets', 'logo.png'));
    await context.route('https://md.test/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/docs/readme.md' || path === '/docs/readme.md?raw=1') {
        return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '# Web readme\n\nSame site: ![logo](./logo.png)\n\nOther site: ![tracker](https://remote.invalid/pixel.png)\n\n- [ ] a task\n' });
      }
      if (path === '/docs/logo.png') return route.fulfill({ status: 200, contentType: 'image/png', body: logo });
      if (path === '/notes/plain') return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '# No extension\n\nRendered only by the toolbar button.\n' });
      // raw.githubusercontent.com serves raw files with this policy
      if (path === '/sandboxed-dl/readme.md') return route.fulfill({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox allow-downloads" }, body: '# Sandboxed\n\nDownloads allowed.\n' });
      // XML can run its own scripts, so it is never treated as plain text
      if (path === '/docs/feed.md') return route.fulfill({ status: 200, contentType: 'text/xml', body: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><PRE># Notes</PRE></body></html>' });
      if (path === '/sandboxed/readme.md') return route.fulfill({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }, body: '# Sandboxed\n\nA raw file.\n' });
      if (path === '/page.html' || path === '/docs/page.md') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title><p>HTML page</p>' });
      return route.fulfill({ status: 404, body: '' });
    });
    await clearPrefs();
    check('web: the website script is registered by default', await waitFor(webScriptRegistered));

    const page = await context.newPage();
    const hits = [];
    page.on('request', (r) => { if (/remote\.invalid/.test(r.url())) hits.push(r.url()); });
    await page.goto('https://md.test/docs/readme.md');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv') === 'rendered', null, { timeout: 5000 }).catch(() => {});
    check('web: a .md file on a website is formatted automatically', await page.evaluate(() => document.documentElement.getAttribute('data-mdv')) === 'rendered' && (await page.textContent('.mdv-content h1')).includes('Web readme'));
    await page.waitForTimeout(300);
    check('web: images from the same site load', await page.evaluate(() => { const i = document.querySelector('.mdv-content img[alt="logo"]'); return !!i && i.complete && i.naturalWidth === 48; }));
    check('web: images from other sites are held back', hits.length === 0 && /did not load 1 image from other sites/.test(await page.textContent('.mdv-notice')), hits.join(', '));
    check('web: Save becomes Download', /Download/.test(await page.textContent('.mdv-save')));
    const webDl = page.waitForEvent('download', { timeout: 2000 }).then((d) => d.suggestedFilename(), () => null);
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(200);
    check('web: Cmd+S downloads a copy', (await webDl) === 'readme.md' && /Downloaded a copy of readme\.md/.test(await page.textContent('.mdv-save-state')), await page.textContent('.mdv-save-state'));

    // a site that sandboxes its raw files blocks downloads without telling the page
    {
      const sand = await context.newPage();
      await sand.goto('https://md.test/sandboxed/readme.md');
      await sand.waitForFunction(() => document.documentElement.getAttribute('data-mdv') === 'rendered', null, { timeout: 5000 }).catch(() => {});
      check('web: a sandboxed raw file is still formatted', (await sand.textContent('.mdv-content h1').catch(() => '')).includes('Sandboxed'));
      const sandDl = sand.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
      await sand.click('.mdv-save');
      check('web: on a sandboxed site, Download says the site blocks downloads', !(await sandDl) && /blocks downloads/.test(await sand.textContent('.mdv-save-state')), await sand.textContent('.mdv-save-state'));
      await sand.click('.mdv-settings-toggle');
      if (await sand.$('.mdv-support-link')) {
        const stubbed = await sw.evaluate(() => {
          self.__opened = [];
          self.__realCreate = chrome.tabs.create;
          chrome.tabs.create = (o) => { self.__opened.push(o.url); return Promise.resolve({}); };
          return chrome.tabs.create !== self.__realCreate;
        });
        await sand.evaluate(() => document.querySelector('.mdv-support-link').click()); // a script: ignored
        await sand.click('.mdv-support-link');
        await sand.waitForTimeout(300);
        const opened = await sw.evaluate(() => { const o = self.__opened; chrome.tabs.create = self.__realCreate; return o; });
        const configured = (readFileSync(join(extensionPath, 'src', 'config.js'), 'utf8').match(/supportUrl:\s*'([^']*)'/) || [])[1];
        check('web: on a sandboxed site, the support link is opened by Hushmark', stubbed && opened.length === 1 && opened[0] === configured, JSON.stringify({ stubbed, opened }));
      }
      await sand.click('.mdv-settings button:has-text("Reset all Hushmark data")');
      check('web: on a sandboxed site, Reset still asks (in place)', await sand.evaluate(() => !document.querySelector('.mdv-set-confirm').hidden));
      await sand.click('.mdv-settings button:has-text("Cancel")');
      await sand.close();

      // ... unless its sandbox allows downloads; the page cannot tell which
      const dl = await context.newPage();
      await dl.goto('https://md.test/sandboxed-dl/readme.md');
      await dl.waitForFunction(() => document.documentElement.getAttribute('data-mdv') === 'rendered', null, { timeout: 5000 }).catch(() => {});
      const got = dl.waitForEvent('download', { timeout: 2000 }).then(() => true, () => false);
      await dl.click('.mdv-save');
      const said = await dl.textContent('.mdv-save-state');
      check('web: a sandbox that allows downloads still downloads, and the status does not deny it', (await got) && !/no copy was saved/.test(said), said);
      await dl.close();
    }
    await page.click('.mdv-toc-toggle');
    await page.waitForTimeout(150);
    {
      // a script on the page cannot change settings: only real input can
      const before = JSON.stringify(await getPrefs());
      await page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        // in place
        q('input[data-pref="remoteImages"]').click();
        const r = q('input[data-pref="rememberFiles"]');
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        q('.mdv-picker-button').click();
        q('.mdv-picker-list').hidden = false;
        q('.mdv-picker-option[data-value="dracula"]').click();
        key(q('.mdv-picker-list'), 'End');
        key(q('.mdv-picker-list'), 'Enter');
        q('.mdv-segmented[data-pref="font"] [data-value="mono"]').click();
        key(q('.mdv-segmented[data-pref="width"]'), 'End');
        q('.mdv-settings button[title="Larger text"]').click();
        q('.mdv-settings button.mdv-danger').click();
        // moved out of the drawer, past its own guard
        for (const sel of ['input[data-pref="spellcheck"]', '.mdv-picker-option[data-value="nord"]', '.mdv-settings button[title="Smaller text"]']) {
          const el = q(sel);
          document.body.appendChild(el);
          el.click();
        }
        // stopped before the drawer sees it
        window.addEventListener('click', (e) => { if (!e.isTrusted) e.stopImmediatePropagation(); }, true);
        q('input[data-pref="autosave"]').click();
        // the outline and the source/preview divider
        q('.mdv-toc-toggle').click();
        if (q('.mdv-divider')) key(q('.mdv-divider'), 'ArrowLeft');
      });
      await page.waitForTimeout(200);
      check('web: scripts on the page cannot change settings', JSON.stringify(await getPrefs()) === before && await page.evaluate(() => !['dracula', 'nord', 'one-dark'].includes(document.documentElement.getAttribute('data-mdv-theme')) && document.querySelector('.mdv-set-confirm').hidden), JSON.stringify(await getPrefs()));
      await page.reload();
      await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv') === 'rendered', null, { timeout: 5000 }).catch(() => {});
      check('web: Settings on a website has no Forget button, and says why', await page.evaluate(() => ![...document.querySelectorAll('.mdv-settings button')].some((b) => /Forget saved files/.test(b.textContent)) && /open one to forget them/.test(document.querySelector('.mdv-settings').textContent)));
    }
    check('web: nothing is written to the website\'s storage', await page.evaluate(async () => localStorage.length === 0 && sessionStorage.length === 0 && (await indexedDB.databases()).length === 0));

    // an HTML page whose address happens to end in .md must be left alone,
    // and must not be able to tell that Hushmark is installed
    const html = await context.newPage();
    await html.goto('https://md.test/docs/page.md');
    await html.waitForTimeout(300);
    check('web: an HTML page at a .md address is never touched', await html.evaluate(() => { const h = document.documentElement; return !h.hasAttribute('data-mdv') && !h.hasAttribute('data-mdv-claim') && !h.hasAttribute('class') && !h.hasAttribute('style') && !document.querySelector('.mdv-root'); }));
    check('web: ... gets none of Hushmark\'s styles', await html.evaluate(() => {
      document.documentElement.setAttribute('data-mdv', 'probe');
      const ok = getComputedStyle(document.body).overflow === 'visible' && getComputedStyle(document.documentElement).getPropertyValue('--mdv-bg') === '';
      document.documentElement.removeAttribute('data-mdv');
      return ok;
    }));
    await setPrefs({ theme: 'nord', size: 21 });
    await html.waitForTimeout(300);
    check('web: ... and does not see settings change', await html.evaluate(() => { const h = document.documentElement; return !h.hasAttribute('data-mdv-theme') && !h.hasAttribute('class') && !h.hasAttribute('style'); }));
    await clearPrefs();
    await html.close();

    // an XML document holding a <PRE> is not Chrome's plain-text view either
    const xml = await context.newPage();
    await xml.goto('https://md.test/docs/feed.md');
    await xml.waitForTimeout(300);
    await setPrefs({ theme: 'dracula' });
    await xml.waitForTimeout(300);
    const xmlRefused = await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://md.test/docs/feed.md' }); return self.renderTab(tab.id); });
    check('web: an XML document at a .md address is never touched, even by the button', xmlRefused === false && await xml.evaluate(() => { const h = document.documentElement; return !h.hasAttribute('data-mdv') && !h.hasAttribute('data-mdv-claim') && !h.hasAttribute('data-mdv-theme'); }));
    await clearPrefs();
    await xml.close();

    // turn automatic rendering off in Settings
    await page.click('.mdv-settings-toggle');
    await page.locator('.mdv-settings label.mdv-toggle-row', { hasText: 'Format Markdown files on websites' }).locator('input').uncheck();
    await page.keyboard.press('Escape');
    check('web: turning the setting off unregisters the website script', await waitFor(async () => !(await webScriptRegistered())));
    await page.reload();
    await page.waitForTimeout(400);
    check('web: with the setting off, Hushmark does not run on websites', await page.evaluate(() => !document.documentElement.hasAttribute('data-mdv') && !document.documentElement.hasAttribute('data-mdv-claim') && document.body.firstElementChild.tagName === 'PRE'));

    // the toolbar button still works on that tab
    const clicked = await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://md.test/docs/readme.md' }); return self.renderTab(tab.id); });
    check('button: the toolbar button renders the tab while automatic rendering is off', clicked === true && (await page.evaluate(() => document.documentElement.getAttribute('data-mdv'))) === 'rendered');

    // ... and on plain text whose address has no Markdown extension
    const plain = await context.newPage();
    await plain.goto('https://md.test/notes/plain');
    await plain.waitForTimeout(200);
    check('button: a plain-text tab without .md is not formatted on its own', await plain.evaluate(() => !document.documentElement.hasAttribute('data-mdv')));
    const clicked2 = await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://md.test/notes/plain' }); return self.renderTab(tab.id); });
    check('button: ... and is formatted by the toolbar button', clicked2 === true && (await plain.textContent('.mdv-content h1')).includes('No extension'));
    const again = await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://md.test/notes/plain' }); return self.renderTab(tab.id); });
    check('button: clicking twice does not render twice', again === true && (await plain.evaluate(() => document.querySelectorAll('.mdv-root').length)) === 1);
    await plain.close();

    // the button on a page that is not plain text reports it on the badge
    const htmlTab = await context.newPage();
    await htmlTab.goto('https://md.test/page.html');
    await htmlTab.waitForTimeout(150);
    const refused = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://md.test/page.html' });
      const ok = await self.renderTab(tab.id);
      return { ok, badge: await chrome.action.getBadgeText({ tabId: tab.id }) };
    });
    check('button: on an HTML page it refuses and shows a badge', refused.ok === false && refused.badge === '!' && (await htmlTab.evaluate(() => !document.querySelector('.mdv-root'))), JSON.stringify(refused));
    check('button: ... without adding any styles to it', await htmlTab.evaluate(() => {
      document.documentElement.setAttribute('data-mdv', 'probe');
      return getComputedStyle(document.body).overflow === 'visible' && getComputedStyle(document.documentElement).getPropertyValue('--mdv-bg') === '';
    }));
    await htmlTab.close();

    // back on
    await setPrefs({ webPages: true });
    check('web: turning the setting back on registers the script again', await waitFor(webScriptRegistered));
    await page.close();
    await clearPrefs();
  }

  // --------------------------------------------- settings across tabs
  {
    const A = await context.newPage();
    await A.goto(fileUrl('basic.md'));
    await setPrefs({ theme: 'nord', rememberFiles: true });
    await A.reload();
    await A.waitForTimeout(250);
    const B = await context.newPage();
    await B.goto(fileUrl('basic.md'));
    await B.waitForTimeout(250);
    await B.click('.mdv-settings-toggle');
    await B.click('.mdv-settings button:has-text("Reset all Hushmark data")');
    await B.click('.mdv-settings button:has-text("Reset everything")');
    await B.waitForTimeout(400);
    check('tabs: a Reset in one tab applies in the others', await A.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'auto');
    await A.click('.mdv-toc-toggle');
    await A.waitForTimeout(100);
    const after = (await getPrefs()) || {};
    check('tabs: another tab does not write the old settings back', after.rememberFiles === false && after.theme === 'auto' && after.toc === true, JSON.stringify(after));
    await clearPrefs();
    await A.close();
    await B.close();
  }

  // ------------------------------- Escape in Settings over a narrow outline
  {
    const { page } = await openFixture(context, 'basic.md');
    await page.setViewportSize({ width: 800, height: 700 });
    await page.click('.mdv-toc-toggle');
    await page.waitForTimeout(150);
    const shown = await page.evaluate(() => !document.querySelector('.mdv-toc').hidden);
    await page.focus('.mdv-settings-toggle'); // the outline's scrim covers the top bar
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ drawer: document.querySelector('dialog.mdv-settings').open, outline: !document.querySelector('.mdv-toc').hidden }));
    check('outline: Escape in Settings closes only Settings, not the outline behind it', shown && !after.drawer && after.outline && ((await getPrefs()) || {}).toc === true, JSON.stringify(after));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('outline: ... and a second Escape closes the outline', await page.evaluate(() => document.querySelector('.mdv-toc').hidden) && ((await getPrefs()) || {}).toc === false);
    await clearPrefs();
    await page.close();
  }

  // ------------------------------------- encodings and line endings kept
  {
    const cases = [
      { name: 'crlf-bom.md', bytes: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# CRLF file\r\n\r\nLine one\r\n', 'utf8')]), check: (b) => b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF && /\r\nLine two/.test(b.toString('utf8')) && !/[^\r]\n/.test(b.toString('utf8')) },
      { name: 'utf16.md', bytes: Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('# UTF-16 file\r\n\r\nHéllo\r\n', 'utf16le')]), check: (b) => b[0] === 0xFF && b[1] === 0xFE && b.subarray(2).toString('utf16le').includes('Héllo\r\nLine two') },
      { name: 'lf-plain.md', bytes: Buffer.from('# LF file\n\nLine one\n', 'utf8'), check: (b) => b[0] === 0x23 && !b.includes(0x0D) && b.toString('utf8').includes('Line one\nLine two') },
    ];
    for (const c of cases) {
      writeFileSync(join(fixtures, c.name), c.bytes);
      try {
        const { page } = await openFixture(context, c.name);
        const world = await isolatedWorld(page);
        await world.eval(diskWithBytes(c.name, c.bytes));
        await world.eval(SAVE_STUB);
        await page.click('button[data-mode="source"]');
        await page.focus('.mdv-source');
        await page.evaluate(() => { const t = document.querySelector('.mdv-source'); t.setSelectionRange(t.value.length, t.value.length); });
        await page.keyboard.type('Line two\n');
        await page.keyboard.press('Meta+s');
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-test-saved'), null, { timeout: 5000 }).catch(() => {});
        const written = Buffer.from(await world.eval('Array.from(window.__disk.bytes)'));
        check(`conventions: ${c.name} keeps its encoding, byte-order mark and line endings`, c.check(written), `${await page.textContent('.mdv-save-state')} | ${JSON.stringify(written.toString('latin1')).slice(0, 120)}`);
        await world.detach();
        await page.close();
      } finally {
        rmSync(join(fixtures, c.name), { force: true });
      }
    }
  }

  // --------------------------------------------------- web images blocked
  {
    await context.route('**://remote.invalid/**', (route) => route.abort());
    // Every form Chrome resolves to a remote address: plain, no slashes, one
    // slash, protocol-relative, backslashes, a tab inside the scheme, a UNC
    // path, srcset, a video poster and a table background. 11 in all.
    writeFileSync(join(fixtures, 'remote.md'), String.raw`# Remote

Badge: ![build](https://remote.invalid/badge.svg)

<img src="https://remote.invalid/logo.png" width="24" alt="logo">

Disguised: ![a](https:remote.invalid/a.png) ![b](https:/remote.invalid/b.png) ![c](//remote.invalid/c.png)

<p><img src="https:\\remote.invalid\d.png" alt="d"> <img src="ht&#9;tps://remote.invalid/e.png" alt="e"> <img src="\\remote.invalid\share\f.png" alt="f"> <img srcset="https:remote.invalid/g.png 1x" alt="g"></p>

<video poster="https:remote.invalid/h.png"></video>

<table background="https:remote.invalid/i.png"><tr><td>cell</td></tr></table>

![local](./assets/logo.png)
`);
    try {
      const page = await context.newPage();
      const hits = [];
      page.on('request', (r) => { if (/remote\.invalid/.test(r.url())) hits.push(r.url()); });
      await page.goto(fileUrl('remote.md'));
      await page.waitForTimeout(300);
      check('remote: images from the web are not loaded', hits.length === 0, hits.join(', '));
      check('remote: a bar says how many were held back, including disguised addresses', await page.evaluate(() => !document.querySelector('.mdv-notice').hidden && /did not load 11 images/.test(document.querySelector('.mdv-notice').textContent)), await page.textContent('.mdv-notice'));
      check('remote: local images still load', await page.evaluate(() => { const img = [...document.querySelectorAll('.mdv-content img')].find((i) => (i.getAttribute('src') || '').includes('assets/logo.png')); return !!img && img.complete && img.naturalWidth === 48; }));
      await page.click('button[data-mode="edit"]');
      await setSelection(page, 'main.mdv-content h1', 'end');
      await page.keyboard.type(' edited');
      await page.click('button[data-mode="source"]');
      const md = await page.inputValue('.mdv-source');
      check('remote: blocked image addresses survive an edit', md.includes('![build](https://remote.invalid/badge.svg)') && md.includes('src="https://remote.invalid/logo.png"') && md.includes('(https:remote.invalid/a.png)') && !/data-mdv/.test(md), md);
      check('remote: still nothing loaded after editing', hits.length === 0, hits.join(', '));

      // cut and paste a held-back image: it must stay held back and keep its address
      await page.click('button[data-mode="edit"]');
      await page.evaluate(() => {
        const p = [...document.querySelectorAll('main.mdv-content p')].find((x) => x.querySelector('img[alt="build"]'));
        const r = document.createRange(); r.selectNodeContents(p);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      await page.keyboard.press('Meta+x');
      await setSelection(page, 'main.mdv-content > p:last-of-type', 'end');
      await page.keyboard.press('Meta+v');
      await page.waitForTimeout(200);
      check('remote: a cut-and-pasted image stays held back', await page.evaluate(() => { const img = document.querySelector('main.mdv-content img[alt="build"]'); return !!img && img.hasAttribute('data-mdv-blocked') && !img.hasAttribute('src'); }), await page.evaluate(() => document.querySelector('main.mdv-content img[alt="build"]')?.outerHTML));
      await page.click('button[data-mode="source"]');
      check('remote: ... and keeps its address in the saved text', (await page.inputValue('.mdv-source')).includes('![build](https://remote.invalid/badge.svg)'), await page.inputValue('.mdv-source'));
      check('remote: nothing loaded by cut and paste', hits.length === 0, hits.join(', '));
      await page.click('button[data-mode="read"]');
      await page.click('.mdv-load-remote');
      await page.waitForTimeout(300);
      check('remote: "Load images" loads them for this tab', hits.length >= 2 && (await page.evaluate(() => document.querySelector('.mdv-notice').hidden)), hits.join(', '));
      await page.close();

      // turning the automatic setting off stops loading again in the same tab
      const p2 = await context.newPage();
      const hits2 = [];
      p2.on('request', (r) => { if (/remote\.invalid/.test(r.url())) hits2.push(r.url()); });
      await p2.goto(fileUrl('remote.md'));
      await p2.waitForTimeout(250);
      await p2.click('.mdv-settings-toggle');
      const auto = p2.locator('.mdv-settings label.mdv-toggle-row', { hasText: 'Load web images automatically' }).locator('input');
      await auto.check();
      await p2.waitForTimeout(300);
      const loadedWhileOn = hits2.length;
      await auto.uncheck();
      await p2.keyboard.press('Escape');
      await p2.click('button[data-mode="source"]');
      await p2.focus('.mdv-source');
      await p2.evaluate(() => { const t = document.querySelector('.mdv-source'); t.setSelectionRange(t.value.length, t.value.length); });
      await p2.keyboard.type('\n![typed](https://remote.invalid/typed.png)\n');
      await p2.waitForTimeout(500);
      check('remote: the automatic setting loads images while on', loadedWhileOn > 0, String(loadedWhileOn));
      check('remote: after turning it off, new web images are held back again', !hits2.some((u) => u.includes('typed.png')) && (await p2.evaluate(() => !document.querySelector('.mdv-notice').hidden)), hits2.join(', '));
      await clearPrefs();
      await p2.close();
    } finally {
      rmSync(join(fixtures, 'remote.md'), { force: true });
    }
  }

  // ------------------------------------------------------ reset all data
  {
    const { page } = await openFixture(context, 'basic.md');
    await setPrefs({ theme: 'nord', rememberFiles: true });
    await page.reload();
    await page.waitForTimeout(250);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.click('.mdv-settings-toggle');
    await page.click('.mdv-settings button:has-text("Reset all Hushmark data")');
    const asked = await page.evaluate(() => { const c = document.querySelector('.mdv-set-confirm'); return { shown: !c.hidden, text: c.textContent, cancelFocused: document.activeElement.textContent === 'Cancel' }; });
    check('reset: asks first, in place, with Cancel focused', asked.shown && /cannot be undone/.test(asked.text) && asked.cancelFocused && dialogs.length === 0, JSON.stringify(asked));
    await page.click('.mdv-set-confirm-text'); // a click inside the box keeps Escape for the box
    await page.keyboard.press('Escape');
    check('reset: Escape cancels the reset but keeps Settings open', await page.evaluate(() => document.querySelector('.mdv-set-confirm').hidden && document.querySelector('dialog.mdv-settings').open && document.activeElement.textContent === 'Reset all Hushmark data') && ((await getPrefs()) || {}).theme === 'nord');
    await page.click('.mdv-settings button:has-text("Reset all Hushmark data")');
    await page.click('.mdv-settings button:has-text("Reset everything")');
    await page.waitForTimeout(300);
    check('reset: the outcome is shown in Settings', /All Hushmark data in this browser was removed/.test(await page.textContent('.mdv-set-result[role="status"]')), await page.textContent('.mdv-set-result'));
    check('reset: settings removed and defaults back', (await getPrefs()) === null && (await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme'))) === 'auto');
    check('reset: the file-handle database is deleted', await page.evaluate(async () => !(await indexedDB.databases()).some((d) => d.name === 'local-markdown-viewer')));
    await page.close();
  }

  // ------------------------------------------------ round-trip fidelity
  {
    const { page } = await openFixture(context, 'basic.md');
    const world = await isolatedWorld(page);
    for (const name of ['basic.md', 'linked.md', 'encoding.md', 'bom.md', 'no-frontmatter.md', 'comments.md', 'xss.md']) {
      const text = readFileSync(join(fixtures, name), 'utf8').replace(/^﻿/, '');
      const r = await world.eval(`(() => {
        const api = window.Hushmark;
        const body = api.extractFrontMatter(${JSON.stringify(text)}).body;
        // a bare <div> in Markdown becomes a paragraph after a round trip; that is fine
        const tags = (html) => { const d = document.createElement('div'); d.innerHTML = html; return [...d.querySelectorAll('*')].map((e) => (e.tagName === 'DIV' ? 'P' : e.tagName) + (e.tagName === 'INPUT' ? (e.checked ? '[x]' : '[ ]') : '') + ['href', 'src', 'alt', 'align', 'class', 'start', 'id', 'width'].map((a) => e.getAttribute(a) ? ' ' + a + '=' + e.getAttribute(a) : '').join('')).join(' '); };
        const html1 = api.toHtml(body, { frontMatter: false });
        const d = document.createElement('div'); d.innerHTML = html1;
        const md = api.toMarkdown(d);
        const html2 = api.toHtml(md, { frontMatter: false });
        const t1 = tags(html1), t2 = tags(html2);
        const text1 = (() => { const e = document.createElement('div'); e.innerHTML = html1; return e.textContent.replace(/\\s+/g, ''); })();
        const text2 = (() => { const e = document.createElement('div'); e.innerHTML = html2; return e.textContent.replace(/\\s+/g, ''); })();
        const comments1 = (html1.match(/<!--[\\s\\S]*?-->/g) || []).length, comments2 = (html2.match(/<!--[\\s\\S]*?-->/g) || []).length;
        return { same: t1 === t2 && comments1 === comments2, sameText: text1 === text2, md, t1: t1.slice(0, 500), t2: t2.slice(0, 500) };
      })()`);
      const strict = name !== 'xss.md';
      check(`roundtrip ${name}: Markdown -> HTML -> Markdown -> HTML keeps structure${strict ? '' : ' (lenient)'}`, strict ? r.same && r.sameText : typeof r.md === 'string', `\n   first: ${r.t1}\n   second: ${r.t2}`);
      if (name === 'basic.md') writeFileSync(join(outDir, 'roundtrip-basic.md'), r.md);
    }
    await world.detach();
    await page.close();
  }

  // ------------------------------------------------------------------ xss
  {
    const corpusDir = join(fixtures, 'xss-corpus');
    const corpus = existsSync(corpusDir)
      ? readdirSync(corpusDir).filter((f) => /\.md$/i.test(f)).sort().map((f) => join('xss-corpus', f))
      : [];
    for (const name of ['xss.md', ...corpus]) {
      const label = `xss(${name})`;
      const { page, remote, errors } = await openFixture(context, name);
      await page.waitForTimeout(400);
      await page.mouse.move(50, 50);
      await page.keyboard.press('Tab');
      await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = !d.open; }); window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(200);
      check(`${label}: rendered`, (await rendered(page)) === 'rendered');
      check(`${label}: nothing executed (window.__xss undefined)`, await page.evaluate(() => typeof window.__xss === 'undefined'), String(await page.evaluate(() => window.__xss)));
      let audit = await xssAudit(page);
      check(`${label}: no dangerous elements or attributes remain`, audit.length === 0, audit.join(', '));
      // the same document through the editor and back
      await page.click('button[data-mode="edit"]');
      await setSelection(page, 'main.mdv-content > :last-child', 'end');
      await page.keyboard.type(' edited');
      await page.click('button[data-mode="source"]');
      await page.click('button[data-mode="read"]');
      await page.waitForTimeout(200);
      audit = await xssAudit(page);
      check(`${label}: still inert after Edit -> Source -> Read`, audit.length === 0 && (await page.evaluate(() => typeof window.__xss === 'undefined')), audit.join(', '));
      check(`${label}: no http(s) requests`, remote.length === 0, remote.join(', '));
      check(`${label}: no console/page errors`, realErrors(errors).length === 0, realErrors(errors).join(' | '));
      if (name === 'xss.md') {
        check(`${label}: text content preserved`, (await page.textContent('.mdv-content')).includes('The end.'));
        await page.screenshot({ path: join(outDir, 'xss.png'), fullPage: true });
      }
      await page.close();
    }
  }

  // ----------------------------------------------------------- responsive
  {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(fileUrl('basic.md'));
    await page.waitForTimeout(250);
    check('phone: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.mdv-top').scrollWidth <= window.innerWidth + 1), await page.evaluate(() => `${document.documentElement.scrollWidth}/${window.innerWidth} top=${document.querySelector('.mdv-top').scrollWidth}`));
    check('phone: mode labels collapse to icons', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-modes .mdv-label')).display === 'none' && document.querySelectorAll('.mdv-modes svg').length === 3));
    check('phone: document uses the full width', await page.evaluate(() => { const d = document.querySelector('.mdv-doc').getBoundingClientRect(); return d.left < 20 && d.right > window.innerWidth - 20; }));
    await page.screenshot({ path: join(outDir, 'phone-read.png') });
    await page.click('button[data-mode="edit"]');
    check('phone: formatting bar scrolls horizontally instead of wrapping', await page.evaluate(() => { const f = document.querySelector('.mdv-format'); return f.scrollWidth > f.clientWidth && f.clientHeight < 60; }));
    await page.screenshot({ path: join(outDir, 'phone-edit.png') });
    await page.click('.mdv-toc-toggle');
    check('phone: outline opens as an overlay with a scrim', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-toc')).position === 'absolute' && !document.querySelector('.mdv-scrim').hidden));
    await page.screenshot({ path: join(outDir, 'phone-outline.png') });
    await page.mouse.click(365, 400); // outside the drawer, on the scrim
    check('phone: tapping the scrim closes the outline', await page.evaluate(() => document.querySelector('.mdv-toc').hidden && document.querySelector('.mdv-scrim').hidden));
    await page.click('button[data-mode="source"]');
    check('phone: source and preview stack vertically', await page.evaluate(() => { const t = document.querySelector('.mdv-source').getBoundingClientRect(); const p = document.querySelector('.mdv-preview-scroll').getBoundingClientRect(); return p.top >= t.bottom - 1 && Math.abs(t.left - p.left) < 2; }));
    await page.screenshot({ path: join(outDir, 'phone-source.png') });
    await page.click('.mdv-settings-toggle');
    check('phone: settings drawer fills the width', await page.evaluate(() => { const r = document.querySelector('.mdv-settings').getBoundingClientRect(); return r.width >= window.innerWidth - 2; }));
    await page.screenshot({ path: join(outDir, 'phone-settings.png') });
    check('phone: no errors', errors.length === 0, errors.join(' | '));

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(fileUrl('basic.md'));
    await page.waitForTimeout(250);
    await page.click('button[data-mode="edit"]');
    check('tablet: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(outDir, 'tablet-edit.png') });
    await page.close();
  }

  // --------------------------------------------------------- split drag
  {
    const { page } = await openFixture(context, 'basic.md');
    await page.click('button[data-mode="source"]');
    const before = await page.evaluate(() => document.querySelector('.mdv-source').getBoundingClientRect().width);
    const d = await page.locator('.mdv-divider').boundingBox();
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x + d.width / 2 - 200, d.y + d.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.querySelector('.mdv-source').getBoundingClientRect().width);
    check('split: dragging the divider resizes the source pane', after < before - 150, `${before} -> ${after}`);
    await page.reload();
    await page.waitForTimeout(250);
    await page.click('button[data-mode="source"]');
    const persisted = await page.evaluate(() => document.querySelector('.mdv-source').getBoundingClientRect().width);
    check('split: ratio persists across reload', Math.abs(persisted - after) < 10, `${after} vs ${persisted}`);
    await clearPrefs();
    await page.screenshot({ path: join(outDir, 'source-split.png') });
    await page.close();
  }

  // ------------------------------------------------------------- encoding
  {
    const { page } = await openFixture(context, 'encoding.md');
    const h1 = await page.textContent('.mdv-content h1');
    const charset = await page.evaluate(() => document.characterSet);
    check('encoding: UTF-8 without BOM decoded', h1.includes('Ünïcödé — 中文 — 日本語 — 🎉'), `charset=${charset} h1=${h1}`);
    check('encoding: body text', (await page.textContent('.mdv-content p')).includes('café naïve, привет'));
    await page.close();
  }

  // ------------------------------------------------------------------ bom
  {
    const { page } = await openFixture(context, 'bom.md');
    check('bom: rendered', (await rendered(page)) === 'rendered');
    check('bom: front matter detected despite BOM', await page.evaluate(() => document.querySelector('table.mdv-frontmatter td')?.textContent === 'With BOM'));
    check('bom: heading id', await page.evaluate(() => document.getElementById('bom-heading') !== null));
    await page.close();
  }

  // ---------------------------------------------------- misc file names
  {
    let r = await openFixture(context, 'empty.md');
    check('empty file: renders without errors', r.errors.length === 0 && (await rendered(r.page)) === 'rendered', r.errors.join(' | '));
    await r.page.click('button[data-mode="edit"]');
    await r.page.keyboard.type('# New file');
    await r.page.click('button[data-mode="source"]');
    check('empty file: can be edited from nothing', (await r.page.inputValue('.mdv-source')).trim() === '# New file', await r.page.inputValue('.mdv-source'));
    await r.page.close();

    r = await openFixture(context, 'plain.txt');
    check('plain.txt: left untouched', (await rendered(r.page)) === null);
    await r.page.close();

    r = await openFixture(context, 'UPPER.MD');
    check('UPPER.MD: rendered', (await rendered(r.page)) === 'rendered');
    await r.page.close();

    r = await openFixture(context, 'with space & stuff.md');
    check('spaces in name: rendered', (await rendered(r.page)) === 'rendered');
    check('spaces in name: decoded in toolbar', await r.page.textContent('.mdv-filename') === 'with space & stuff.md');
    await r.page.close();

    r = await openFixture(context, 'no-frontmatter.md');
    check('"---\\n---": not treated as front matter', await r.page.evaluate(() => !document.querySelector('.mdv-frontmatter') && document.querySelectorAll('.mdv-content hr').length >= 1));
    await r.page.close();
  }

  // ---------------------------------------------------------------- large
  {
    const block = '## Section\n\nSome paragraph text with **bold** and `code` and a [link](#section).\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n';
    const big = '# Large\n\n' + block.repeat(4000);
    writeFileSync(join(fixtures, 'large.md'), big);
    try {
      const t0 = Date.now();
      const { page, errors } = await openFixture(context, 'large.md');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-mdv') === 'rendered', null, { timeout: 30000 });
      const ms = Date.now() - t0;
      check(`large (${(big.length / 1024 / 1024).toFixed(1)} MB): rendered in ${ms} ms`, ms < 15000);
      check('large: all headings present', await page.evaluate(() => document.querySelectorAll('.mdv-content h2').length) === 4000);
      const t1 = Date.now();
      await page.click('button[data-mode="edit"]');
      await page.click('button[data-mode="source"]');
      const ms2 = Date.now() - t1;
      check(`large: Edit -> Source round trip in ${ms2} ms`, ms2 < 20000 && (await page.inputValue('.mdv-source')).startsWith('# Large'));
      check('large: no errors', errors.length === 0, errors.join(' | '));
      await page.close();
    } finally {
      rmSync(join(fixtures, 'large.md'), { force: true });
    }
  }
  check('privacy: zero http(s) requests across the entire run', allRemote.length === 0, allRemote.slice(0, 5).join(', '));
} finally {
  await context.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
