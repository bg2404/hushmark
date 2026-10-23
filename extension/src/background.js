/*
 * Hushmark — background.js (service worker)
 *
 * Four jobs, and nothing else:
 *
 * 1. Websites. While "Format Markdown files on websites" is on (the
 *    default), registers a small gate script (web-gate.js) for web addresses
 *    ending in a Markdown extension. The gate leaves every page alone unless
 *    the site served it as plain text; only then does it ask for the rest of
 *    Hushmark, which is loaded into that one document. When the setting is
 *    turned off the gate is unregistered, so no Hushmark code runs on
 *    websites at all.
 *
 * 2. Other local files. While "Format Markdown in other local files" is on
 *    (off by default), registers a second gate (file-gate.js, with
 *    looks-like-markdown.js) for local files. Files named .md never need it:
 *    the manifest's own content script shows them. The gate leaves a file
 *    alone unless Chrome shows it as plain text and its content looks like
 *    Markdown; Hushmark is then loaded into that one document, with a "Show
 *    as plain text" button. Files the user turns back to plain text are
 *    remembered in chrome.storage.session (in memory, private to Hushmark,
 *    gone when Chrome closes) so a reload keeps them plain.
 *
 * 3. The toolbar button. Clicking Hushmark's icon renders the current tab
 *    if it shows plain text (a raw Markdown file whose address does not end
 *    in .md, for example), whatever the settings. Other tabs get nothing.
 *
 * 4. The support link on sites that sandbox their files and so block new
 *    tabs: it opens the publisher's support page (config.js) for them.
 *
 * It makes no network requests. The settings are read from
 * chrome.storage.local, where prefs.js keeps them.
 */
'use strict';

// The publisher's support page (config.js, shared with the content scripts).
self.Hushmark = {};
importScripts('config.js');
const SUPPORT_URL = (self.Hushmark.config && self.Hushmark.config.supportUrl) || '';

const WEB_SCRIPT_ID = 'hushmark-web';
const FILE_SCRIPT_ID = 'hushmark-files';
const ENDINGS = ['md', 'MD', 'Md', 'markdown', 'Markdown', 'MARKDOWN', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'mdtext'];
// "*://" covers http and https only. "?*" catches addresses with a query.
const WEB_MATCHES = ENDINGS.flatMap((e) => ['*://*/*.' + e, '*://*/*.' + e + '?*']);

// The gate scripts, each registered only while its setting is on.
const GATES = [
  {
    id: WEB_SCRIPT_ID,
    matches: WEB_MATCHES,
    js: ['src/web-gate.js'],
    enabled: (prefs) => !(prefs && prefs.webPages === false), // on unless turned off
  },
  {
    id: FILE_SCRIPT_ID,
    matches: ['file:///*'],
    js: ['src/looks-like-markdown.js', 'src/file-gate.js'],
    enabled: (prefs) => !!(prefs && prefs.anyFile), // off unless turned on
  },
];

// Local files the user turned back to plain text, until Chrome closes.
// Incognito tabs keep their own list, dropped when the last incognito
// window closes, so an incognito choice never shows in normal windows.
const PLAIN_KEY = 'plainFiles';
const PLAIN_KEY_INCOGNITO = 'plainFilesIncognito';
const PLAIN_MAX = 500;
const plainKey = (incognito) => (incognito ? PLAIN_KEY_INCOGNITO : PLAIN_KEY);

// The same files the manifest injects into local Markdown files.
function contentFiles() {
  const cs = chrome.runtime.getManifest().content_scripts[0];
  return { js: cs.js, css: cs.css };
}

async function readPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return prefs || null;
}

let syncing = Promise.resolve();

// Registers or unregisters each gate to match its setting. Calls are queued
// so two quick changes cannot race.
function syncScripts() {
  syncing = syncing.then(async () => {
    const prefs = await readPrefs();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: GATES.map((g) => g.id) });
    const registered = new Set(existing.map((s) => s.id));
    for (const gate of GATES) {
      const on = gate.enabled(prefs);
      try {
        if (on && !registered.has(gate.id)) {
          await chrome.scripting.registerContentScripts([{
            id: gate.id,
            matches: gate.matches,
            js: gate.js,
            runAt: 'document_end',
            allFrames: false,
            persistAcrossSessions: true,
          }]);
        } else if (!on && registered.has(gate.id)) {
          await chrome.scripting.unregisterContentScripts({ ids: [gate.id] });
        }
      } catch (err) {
        console.error('[Hushmark] could not update the script ' + gate.id, err);
      }
    }
  }).catch((err) => console.error('[Hushmark] could not update the scripts', err));
  return syncing;
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // A new install has no settings from before 2.1 to bring over, so none
    // are ever imported (see prefs.js).
    chrome.storage.local.set({ legacyChecked: true });
  }
  // An update may change the registered file lists: register them afresh.
  syncing = syncing
    .then(() => chrome.scripting.getRegisteredContentScripts({ ids: GATES.map((g) => g.id) }))
    .then((existing) => existing.length && chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) }))
    .catch(() => {});
  syncScripts();
});
chrome.runtime.onStartup.addListener(syncScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prefs) {
    syncScripts();
  }
});

// A local file's address without its #fragment, as remembered below.
function fileKey(url) {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

function isFileUrl(url) {
  return typeof url === 'string' && url.startsWith('file:');
}

async function shownPlain(url, incognito) {
  const store = plainKey(incognito);
  const { [store]: list = [] } = await chrome.storage.session.get(store);
  return list.includes(fileKey(url));
}

async function setShownPlain(url, plain, incognito) {
  const key = fileKey(url);
  const store = plainKey(incognito);
  const { [store]: list = [] } = await chrome.storage.session.get(store);
  const next = list.filter((k) => k !== key);
  if (plain) {
    next.push(key);
  }
  await chrome.storage.session.set({ [store]: next.slice(-PLAIN_MAX) });
}

async function forgetIncognitoIfClosed() {
  const windows = await chrome.windows.getAll();
  if (!windows.some((w) => w.incognito)) {
    await chrome.storage.session.remove(PLAIN_KEY_INCOGNITO);
  }
}
chrome.windows.onRemoved.addListener(() => { forgetIncognitoIfClosed().catch(() => {}); });

// Pages of Hushmark itself (the settings page).
function isOwnPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));
}

// Loads Hushmark into one document: the stylesheets first, then the scripts.
async function inject(target, files) {
  await chrome.scripting.insertCSS({ target, files: files.css });
  await chrome.scripting.executeScript({ target, files: files.js });
}

// The file gate found a local file whose content looks like Markdown. The
// setting and the user's "Show as plain text" choice are checked again here.
async function renderDetected(sender, named) {
  const prefs = await readPrefs();
  if (!(prefs && prefs.anyFile)) {
    return;
  }
  const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
  if (named) {
    // a Markdown name the manifest's patterns miss (notes.MKD): a normal render
    await inject(target, contentFiles());
    return;
  }
  if (await shownPlain(sender.url, sender.tab.incognito)) {
    return;
  }
  await chrome.scripting.executeScript({ target, func: () => { window.__hushmarkDetected = true; } });
  await inject(target, contentFiles());
}

// A gate found a plain-text file in a tab's top frame. Load Hushmark into
// exactly that document, not whatever the tab shows by now.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab) {
    return;
  }
  const top = sender.frameId === 0 && sender.documentId;
  if (msg.hushmark === 'render-web' && top) {
    inject({ tabId: sender.tab.id, documentIds: [sender.documentId] }, contentFiles())
      .catch((err) => console.error('[Hushmark] could not show this file', err));
  }
  if (msg.hushmark === 'render-file' && top && isFileUrl(sender.url)) {
    renderDetected(sender, msg.named === true).catch((err) => console.error('[Hushmark] could not show this file', err));
  }
  // "Show as plain text" on a file formatted because of its content: keep
  // it plain on reload until Chrome closes, then let the tab reload.
  if (msg.hushmark === 'show-plain' && top && isFileUrl(sender.url)) {
    setShownPlain(sender.url, true, sender.tab.incognito).then(() => reply(true), () => reply(false));
    return true; // replies asynchronously
  }
  // Settings → Reset all Hushmark data: also forget the plain-text choices.
  if (msg.hushmark === 'reset' && (isFileUrl(sender.url) || isOwnPage(sender.url))) {
    chrome.storage.session.remove([PLAIN_KEY, PLAIN_KEY_INCOGNITO]).then(() => reply(true), () => reply(false));
    return true;
  }
  // On a website, privacy settings are changed in Hushmark's own settings
  // page, which no website can script.
  if (msg.hushmark === 'open-options') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
  // The Settings support link, on a sandboxed site that cannot open tabs.
  // It only ever opens the publisher's own address, never one it is sent.
  if (msg.hushmark === 'open-support' && /^https:\/\/\S+$/i.test(SUPPORT_URL)) {
    chrome.tabs.create({ url: SUPPORT_URL, index: sender.tab.index + 1 });
  }
});

// The same test as web-gate.js, run in the tab by the toolbar button:
// { state: 'shown' | true | false, href }, 'shown' when Hushmark already
// shows this tab.
function tabShowsPlainText() {
  const href = location.href;
  if (document.documentElement.hasAttribute('data-mdv')) {
    return { state: 'shown', href };
  }
  const type = document.contentType || '';
  const body = document.body;
  if (document instanceof XMLDocument || /html|xml/i.test(type) || !body) {
    return { state: false, href };
  }
  const plain = body.childElementCount === 0 ? !body.textContent.trim()
    : body.childElementCount === 1 && body.firstElementChild.tagName === 'PRE';
  return { state: plain, href };
}

async function flashBadge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action.default_title }).catch(() => {});
    }, 4000);
  } catch (err) { /* tab gone */ }
}

// Renders the tab if it shows plain text. Resolves true when it did.
async function renderTab(tabId) {
  try {
    // Look first, and touch nothing unless the tab shows plain text. Later
    // steps are pinned to the document that was checked.
    const [check] = await chrome.scripting.executeScript({ target: { tabId }, func: tabShowsPlainText });
    const state = check && check.result && check.result.state;
    if (state === 'shown') {
      return true;
    }
    if (state === true) {
      const target = check.documentId ? { tabId, documentIds: [check.documentId] } : { tabId };
      if (isFileUrl(check.result.href)) {
        // asked for by the user: a file once turned back to plain text may
        // be formatted again
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        await setShownPlain(check.result.href, false, !!(tab && tab.incognito)).catch(() => {});
      }
      await chrome.scripting.executeScript({ target, func: () => { window.__hushmarkForce = true; } });
      await inject(target, contentFiles());
      // content.js renders asynchronously once the settings have loaded
      for (let i = 0; i < 20; i++) {
        const [{ result }] = await chrome.scripting.executeScript({
          target,
          func: () => document.documentElement.hasAttribute('data-mdv'),
        });
        if (result) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } catch (err) {
    // pages Chrome does not let extensions touch (chrome://, the Web Store, ...)
  }
  await flashBadge(tabId, '!', 'Hushmark can only show a tab that displays plain text, such as a raw Markdown file');
  return false;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    renderTab(tab.id);
  }
});

// For the end-to-end tests, which cannot click the toolbar.
self.renderTab = renderTab;
self.syncScripts = syncScripts;
self.plainState = { shownPlain, setShownPlain, forgetIncognitoIfClosed };
