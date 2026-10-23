/*
 * Hushmark — background.js (service worker)
 *
 * Three jobs, and nothing else:
 *
 * 1. Websites. While "Format Markdown files on websites" is on (the
 *    default), registers a small gate script (web-gate.js) for web addresses
 *    ending in a Markdown extension. The gate leaves every page alone unless
 *    the site served it as plain text; only then does it ask for the rest of
 *    Hushmark, which is loaded into that one document. When the setting is
 *    turned off the gate is unregistered, so no Hushmark code runs on
 *    websites at all.
 *
 * 2. The toolbar button. Clicking Hushmark's icon renders the current tab
 *    if it shows plain text (a raw Markdown file whose address does not end
 *    in .md, for example), whatever the setting. Other tabs get nothing.
 *
 * 3. The support link on sites that sandbox their files and so block new
 *    tabs: it opens the publisher's support page (config.js) for them.
 *
 * It makes no network requests and keeps no state of its own; the setting
 * is read from chrome.storage.local, where prefs.js keeps it.
 */
'use strict';

// The publisher's support page (config.js, shared with the content scripts).
self.Hushmark = {};
importScripts('config.js');
const SUPPORT_URL = (self.Hushmark.config && self.Hushmark.config.supportUrl) || '';

const WEB_SCRIPT_ID = 'hushmark-web';
const WEB_GATE = 'src/web-gate.js';
const ENDINGS = ['md', 'MD', 'Md', 'markdown', 'Markdown', 'MARKDOWN', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'mdtext'];
// "*://" covers http and https only. "?*" catches addresses with a query.
const WEB_MATCHES = ENDINGS.flatMap((e) => ['*://*/*.' + e, '*://*/*.' + e + '?*']);

// The same files the manifest injects into local Markdown files.
function contentFiles() {
  const cs = chrome.runtime.getManifest().content_scripts[0];
  return { js: cs.js, css: cs.css };
}

async function webPagesEnabled() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return !(prefs && prefs.webPages === false); // on unless turned off
}

let syncing = Promise.resolve();

// Registers or unregisters the website script to match the setting.
// Calls are queued so two quick changes cannot race.
function syncWebScript() {
  syncing = syncing.then(async () => {
    const enabled = await webPagesEnabled();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WEB_SCRIPT_ID] });
    if (enabled && !existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: WEB_SCRIPT_ID,
        matches: WEB_MATCHES,
        js: [WEB_GATE],
        runAt: 'document_end',
        allFrames: false,
        persistAcrossSessions: true,
      }]);
    } else if (!enabled && existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [WEB_SCRIPT_ID] });
    }
  }).catch((err) => console.error('[Hushmark] could not update the website script', err));
  return syncing;
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // A new install has no settings from before 2.1 to bring over, so none
    // are ever imported (see prefs.js).
    chrome.storage.local.set({ legacyChecked: true });
  }
  // An update may change the registered file list: register it afresh.
  syncing = syncing
    .then(() => chrome.scripting.unregisterContentScripts({ ids: [WEB_SCRIPT_ID] }))
    .catch(() => {});
  syncWebScript();
});
chrome.runtime.onStartup.addListener(syncWebScript);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prefs) {
    syncWebScript();
  }
});

// Loads Hushmark into one document: the stylesheets first, then the scripts.
async function inject(target, files) {
  await chrome.scripting.insertCSS({ target, files: files.css });
  await chrome.scripting.executeScript({ target, files: files.js });
}

// The gate found a plain-text Markdown file in a tab's top frame. Load
// Hushmark into exactly that document, not whatever the tab shows by now.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab) {
    return;
  }
  if (msg.hushmark === 'render-web' && sender.frameId === 0 && sender.documentId) {
    inject({ tabId: sender.tab.id, documentIds: [sender.documentId] }, contentFiles())
      .catch((err) => console.error('[Hushmark] could not show this file', err));
  }
  // The Settings support link, on a sandboxed site that cannot open tabs.
  // It only ever opens the publisher's own address, never one it is sent.
  if (msg.hushmark === 'open-support' && /^https:\/\/\S+$/i.test(SUPPORT_URL)) {
    chrome.tabs.create({ url: SUPPORT_URL, index: sender.tab.index + 1 });
  }
});

// The same test as web-gate.js, run in the tab by the toolbar button.
// 'shown' when Hushmark already shows this tab.
function tabShowsPlainText() {
  if (document.documentElement.hasAttribute('data-mdv')) {
    return 'shown';
  }
  const type = document.contentType || '';
  const body = document.body;
  if (document instanceof XMLDocument || /html|xml/i.test(type) || !body) {
    return false;
  }
  return body.childElementCount === 0 ? !body.textContent.trim()
    : body.childElementCount === 1 && body.firstElementChild.tagName === 'PRE';
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
    if (check && check.result === 'shown') {
      return true;
    }
    if (check && check.result === true) {
      const target = check.documentId ? { tabId, documentIds: [check.documentId] } : { tabId };
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
self.syncWebScript = syncWebScript;
