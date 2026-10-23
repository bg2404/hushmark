/*
 * Hushmark — content.js
 *
 * Runs on file:// URLs that end in a Markdown extension (see manifest.json).
 * Chrome shows such files as plain text inside a single <pre> element; this
 * script reads that text, fixes Chrome's default windows-1252 decoding when
 * the bytes are really UTF-8, and hands the text to app.js, which builds the
 * viewer/editor in the page. The original <pre> is kept (hidden) in the page.
 *
 * It does nothing unless the page looks exactly like Chrome's plain-text
 * viewer, and it never sends anything anywhere.
 */
(function () {
  'use strict';

  var MARKDOWN_PATH = /\.(?:md|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext)$/i;
  var api = window.Hushmark;

  function isChromePlainTextView() {
    var type = document.contentType || '';
    if (document instanceof XMLDocument || /html|xml/i.test(type)) {
      return false; // HTML and XML documents, which can run their own scripts
    }
    var body = document.body;
    if (!body) {
      return false;
    }
    if (body.childElementCount === 0 && !body.textContent.trim()) {
      // An empty file: Chrome renders nothing at all, not even a <pre>.
      body.appendChild(document.createElement('pre'));
      return true;
    }
    if (body.childElementCount !== 1) {
      return false;
    }
    var only = body.firstElementChild;
    return !!only && only.tagName === 'PRE';
  }

  function fileName() {
    var last = location.pathname.split('/').pop() || location.pathname;
    try {
      return decodeURIComponent(last);
    } catch (err) {
      return last;
    }
  }

  // Chrome tried to jump to the #fragment before our headings had ids.
  function scrollToHash() {
    var hash = location.hash;
    if (!hash || hash.length < 2) {
      return;
    }
    var raw = hash.slice(1);
    var decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch (err) { /* keep raw */ }
    var target = document.getElementById(decoded) || document.getElementById(raw);
    if (target) {
      target.scrollIntoView();
    }
  }

  function main() {
    // Set by the toolbar button: render this tab even if its address does
    // not end in a Markdown extension.
    var forced = window.__hushmarkForce === true;
    window.__hushmarkForce = false;
    // Set by the background worker when the file gate found a local file
    // whose content looks like Markdown (file-gate.js).
    var detected = !forced && window.__hushmarkDetected === true && location.protocol === 'file:';
    window.__hushmarkDetected = false;
    if (!api || typeof api.mount !== 'function' || !api.prefs) {
      return;
    }
    var html = document.documentElement;
    if (html.hasAttribute('data-mdv') || html.hasAttribute('data-mdv-claim')) {
      return; // already rendered, or being rendered
    }
    if (!forced && !detected && !MARKDOWN_PATH.test(location.pathname)) {
      return;
    }
    if (!isChromePlainTextView()) {
      return;
    }
    // Claim the page now, so a second injection (toolbar button plus the
    // automatic script) cannot mount twice while the settings load.
    html.setAttribute('data-mdv-claim', '');
    api.prefs.load().then(function (prefs) {
      // Automatic rendering on websites can be turned off in Settings; the
      // background worker then stops injecting, and this check covers a tab
      // that was already loading.
      var web = location.protocol !== 'file:';
      if (web && !forced && !prefs.webPages) {
        html.removeAttribute('data-mdv-claim');
        return;
      }
      if (detected && !prefs.anyFile) {
        html.removeAttribute('data-mdv-claim'); // turned off while loading
        return;
      }
      if (api.fileAccess && api.fileAccess.settingsLoaded) {
        api.fileAccess.settingsLoaded();
      }
      start(detected);
    });
  }

  function start(detected) {

    var pre = document.body.firstElementChild;
    var source = pre.textContent;
    var charset = (document.characterSet || '').toLowerCase();
    if (charset && charset !== 'utf-8' && !/^utf-16/.test(charset)) {
      source = api.repairLegacyDecoding(source, charset);
    }

    try {
      api.mount({ pre: pre, text: source, fileName: fileName(), detected: detected });
    } catch (err) {
      console.error('[Hushmark] Could not render this file; leaving the plain text in place.', err);
      document.documentElement.removeAttribute('data-mdv');
      pre.hidden = false;
      return;
    }

    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
  }

  main();
})();
