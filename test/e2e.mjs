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
const extensionPath = realpathSync(resolve(here, '..', 'extension'));
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
  page.on('request', (r) => { if (/^https?:/i.test(r.url())) remote.push(r.url()); });
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
  const ctx = contexts.find((c) => c.auxData && c.auxData.isDefault === false && c.name === 'Local Markdown Viewer');
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

// A fake showSaveFilePicker whose "file" records what was written on the
// <html> element, where the test (in the main world) can read it.
const SAVE_STUB = `
  window.__picks = 0;
  window.__perm = [];
  window.showSaveFilePicker = async (opts) => {
    window.__picks += 1;
    let buf = '';
    return {
      kind: 'file',
      name: window.__pickName || (opts && opts.suggestedName) || 'untitled.md',
      queryPermission: async () => { window.__perm.push('query'); return window.__perm.includes('request') ? 'granted' : 'prompt'; },
      requestPermission: async () => { window.__perm.push('request'); return 'granted'; },
      getFile: async () => ({ text: async () => buf, arrayBuffer: async () => new TextEncoder().encode(buf).buffer }),
      createWritable: async () => {
        let next = '';
        return {
          write: async (chunk) => { next += typeof chunk === 'string' ? chunk : ''; },
          close: async () => { buf = next; document.documentElement.setAttribute('data-test-saved', buf); },
        };
      },
    };
  };
  true`;

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
context.on('request', (r) => { if (/^https?:/i.test(r.url())) allRemote.push(r.url()); });
console.log(`chromium: ${findChromium()}  headless=${headless}`);

try {
  // ---------------------------------------------------------------- basic
  {
    const { page, remote, errors } = await openFixture(context, 'basic.md');
    check('basic: rendered', (await rendered(page)) === 'rendered');
    check('basic: no http(s) requests', remote.length === 0, remote.join(', '));
    check('basic: no console/page errors', errors.length === 0, errors.join(' | '));
    check('basic: original <pre> hidden', await page.evaluate(() => { const p = document.querySelector('.mdv-root > pre'); return p.hidden && getComputedStyle(p).display === 'none'; }));
    check('basic: document.title', await page.title() === 'Local Markdown Viewer fixture · basic.md', await page.title());
    check('basic: filename in toolbar', await page.textContent('.mdv-filename') === 'basic.md');
    check('basic: Read mode selected', await page.getAttribute('button[data-mode="read"]', 'aria-pressed') === 'true');
    check('basic: h1 text', (await page.textContent('.mdv-content h1')).includes('Local Markdown Viewer fixture'));
    check('basic: front matter table', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table.mdv-frontmatter tr')].map((r) => r.textContent);
      return rows.length === 3 && rows[0] === 'titleLocal Markdown Viewer fixture';
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
      'local-markdown-viewer-fixture', 'lists', 'table', 'code', 'quote', 'image',
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
      return !document.querySelector('.mdv-split').hidden && document.querySelector('.mdv-stage').hidden && t.value.startsWith('---\ntitle: Local Markdown Viewer fixture');
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
    check('themes: all themes listed as swatches', await page.evaluate(() => document.querySelectorAll('.mdv-settings .mdv-theme-swatch').length) === 10);
    await page.click('.mdv-settings .mdv-theme-swatch[data-theme="nord"]');
    check('themes: nord applied', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme')) === 'nord' && (await bg(page)) === 'rgb(46, 52, 64)', await bg(page));
    check('themes: swatch shows selection', await page.getAttribute('.mdv-theme-swatch[data-theme="nord"]', 'aria-pressed') === 'true');
    await page.selectOption('.mdv-settings select[aria-label="Font"]', 'serif');
    check('themes: serif font applied', /Palatino|Georgia/.test(await page.evaluate(() => getComputedStyle(document.body).fontFamily)));
    await page.click('.mdv-settings button[title="Larger text"]');
    await page.click('.mdv-settings button[title="Larger text"]');
    check('themes: text size 18px reaches the document', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-content p')).fontSize) === '18px', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-content p')).fontSize));
    check('themes: full width by default', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth) === 'none');
    await page.selectOption('.mdv-settings select[aria-label="Width"]', 'comfortable');
    check('themes: comfortable width caps the column', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth) === '1088px', await page.evaluate(() => getComputedStyle(document.querySelector('.mdv-doc')).maxWidth));
    await page.screenshot({ path: join(outDir, 'theme-nord.png'), fullPage: false });
    await page.keyboard.press('Escape');
    check('themes: Escape closes settings', await page.evaluate(() => !document.querySelector('dialog.mdv-settings').open));
    check('themes: focus returns to the settings button', await page.evaluate(() => document.activeElement === document.querySelector('.mdv-settings-toggle')));

    await page.reload();
    await page.waitForTimeout(300);
    check('themes: persist across reload', await page.evaluate(() => document.documentElement.getAttribute('data-mdv-theme') === 'nord' && document.documentElement.getAttribute('data-mdv-font') === 'serif' && getComputedStyle(document.querySelector('.mdv-content p')).fontSize === '18px'));

    // every theme renders with a distinct background and no errors
    const seen = new Set();
    for (const id of ['github-light', 'github-dark', 'solarized-light', 'solarized-dark', 'sepia', 'nord', 'dracula', 'gruvbox-dark', 'one-dark']) {
      await page.evaluate((t) => { localStorage.setItem('local-markdown-viewer:prefs', JSON.stringify({ theme: t })); }, id);
      await page.reload();
      await page.waitForTimeout(150);
      seen.add(await bg(page));
      if (id === 'sepia' || id === 'dracula') await page.screenshot({ path: join(outDir, `theme-${id}.png`) });
    }
    check('themes: nine explicit themes have distinct backgrounds', seen.size === 9, [...seen].join(' | '));

    // outline
    await page.evaluate(() => localStorage.setItem('local-markdown-viewer:prefs', JSON.stringify({})));
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
    check('edit: front matter note shown', await page.evaluate(() => !document.querySelector('.mdv-fm-note').hidden && document.querySelector('.mdv-fm-note pre').textContent.includes('title: Local Markdown Viewer fixture')));
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
    const expectLines = ['---\ntitle: Local Markdown Viewer fixture', 'autolink https://example.org/also-never-fetched. **Added** *text.*', '## Added heading', '- item one\n- [ ] todo item', '```js\nconst x = 1;\nconst y = 2;\n```', '> quoted', '| Name | Qty |', '[Docs](./docs/guide.md)', '- [x] done task', '- [x] open task', '| Left | Center | Right |', '| :-- | :-: | --: |', '~~strike~~', '<details>\n<summary>Expand me</summary>\n\nHidden *markdown* content.\n\n</details>'];
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
    await world.eval(SAVE_STUB);
    await page.click('.mdv-save');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-test-saved'), null, { timeout: 5000 }).catch(() => {});
    const saved = await page.evaluate(() => document.documentElement.getAttribute('data-test-saved'));
    check('save: text written through showSaveFilePicker', typeof saved === 'string' && saved === md, (await page.textContent('.mdv-save-state')));
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
    check('save: the file was picked once and reused with a permission prompt', (await world.eval('JSON.stringify({ picks: window.__picks, perm: window.__perm })')) === JSON.stringify({ picks: 1, perm: ['query', 'request'] }), await world.eval('JSON.stringify({ picks: window.__picks, perm: window.__perm })'));

    // picking a different file name must not silently redirect the document
    await page.click('.mdv-settings-toggle');
    await page.click('.mdv-settings button:has-text("Forget file access")');
    await page.keyboard.press('Escape');
    await world.eval('window.__pickName = "elsewhere.md"; true');
    await page.focus('.mdv-source');
    await page.keyboard.type('More.');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => /elsewhere\.md/.test(document.querySelector('.mdv-save-state').textContent), null, { timeout: 5000 }).catch(() => {});
    check('save: a copy saved under another name leaves the document unsaved', await page.evaluate(() => /Saved a copy as elsewhere\.md/.test(document.querySelector('.mdv-save-state').textContent) && document.querySelector('.mdv-save').classList.contains('mdv-dirty')), await page.textContent('.mdv-save-state'));
    await world.eval('window.__pickName = ""; true');
    check('edit: no http(s) requests during editing', remote.length === 0, remote.join(', '));
    check('edit: no console/page errors', realErrors(errors).length === 0, realErrors(errors).join(' | '));
    await page.screenshot({ path: join(outDir, 'editing.png'), fullPage: true });
    await world.detach();
    await page.close();
  }

  // ------------------------------------------------ round-trip fidelity
  {
    const { page } = await openFixture(context, 'basic.md');
    const world = await isolatedWorld(page);
    for (const name of ['basic.md', 'linked.md', 'encoding.md', 'bom.md', 'no-frontmatter.md', 'comments.md', 'xss.md']) {
      const text = readFileSync(join(fixtures, name), 'utf8').replace(/^﻿/, '');
      const r = await world.eval(`(() => {
        const api = window.LocalMarkdownViewer;
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
    await page.evaluate(() => localStorage.setItem('local-markdown-viewer:prefs', JSON.stringify({})));
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
