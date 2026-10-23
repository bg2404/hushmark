/*
 * Hushmark — web-gate.js
 *
 * The only Hushmark code that runs on its own on websites, and only while
 * "Format Markdown files on websites" is on. background.js registers it for
 * web addresses ending in a Markdown extension.
 *
 * It looks at the page and nothing else. Unless the site served the file as
 * plain text (Chrome then shows it in a single <pre>), it stops here and the
 * page is left exactly as it was: no styles, no other scripts, no changes.
 * For a plain-text Markdown file it asks the background worker to load the
 * rest of Hushmark into this one document.
 */
(function () {
  'use strict';

  var MARKDOWN_PATH = /\.(?:md|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext)$/i;

  function isPlainText() {
    var type = document.contentType || '';
    // HTML and XML documents can run their own scripts; Chrome's plain-text
    // view of a raw file cannot.
    if (document instanceof XMLDocument || /html|xml/i.test(type)) {
      return false;
    }
    var body = document.body;
    if (!body) {
      return false;
    }
    if (body.childElementCount === 0) {
      return !body.textContent.trim(); // an empty file
    }
    return body.childElementCount === 1 && body.firstElementChild.tagName === 'PRE';
  }

  if (window.top === window && MARKDOWN_PATH.test(location.pathname) && isPlainText()) {
    try {
      chrome.runtime.sendMessage({ hushmark: 'render-web' });
    } catch (err) { /* extension updated or removed since the page loaded */ }
  }
})();
