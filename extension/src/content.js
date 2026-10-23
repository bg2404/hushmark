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
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      return false;
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
    if (!api || typeof api.mount !== 'function') {
      return;
    }
    if (document.documentElement.hasAttribute('data-mdv')) {
      return; // already rendered
    }
    if (!MARKDOWN_PATH.test(location.pathname)) {
      return;
    }
    if (!isChromePlainTextView()) {
      return;
    }

    var pre = document.body.firstElementChild;
    var source = pre.textContent;
    var charset = (document.characterSet || '').toLowerCase();
    if (charset && charset !== 'utf-8' && !/^utf-16/.test(charset)) {
      source = api.repairLegacyDecoding(source, charset);
    }

    try {
      api.mount({ pre: pre, text: source, fileName: fileName() });
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
