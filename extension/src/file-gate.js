/*
 * Hushmark — file-gate.js
 *
 * Runs on local files only while "Format Markdown in other local files" is
 * on; background.js registers it for file:///* together with
 * looks-like-markdown.js.
 *
 * It looks at the page and nothing else. Files whose name already says
 * Markdown are left to the manifest's own content script. Everything else
 * stops here, unchanged, unless all of these hold:
 *   - Chrome shows the file in its plain-text view (a single <pre>),
 *   - Chrome typed it as plain text, not as code (text/javascript,
 *     text/x-python-script, ...), and its name is not a code, config, data
 *     or log name,
 *   - it is not larger than MAX_BYTES,
 *   - its beginning looks like Markdown (looksLikeMarkdown).
 * Then it asks the background worker to load the rest of Hushmark into this
 * one document. It reads the text only in this tab and sends nothing else.
 */
(function () {
  'use strict';

  // Exactly what the manifest's own content script matches (its URL patterns
  // are case-sensitive, and only .md and .markdown have a ?query form).
  // Other Markdown names, such as notes.MKD, are left to this gate.
  var STATIC_PATH = /\.(?:md|MD|Md|markdown|Markdown|MARKDOWN|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/;
  var STATIC_QUERY_PATH = /\.(?:md|markdown)$/;
  var MARKDOWN_PATH = /\.(?:md|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext)$/i;
  var PLAIN_TYPES = /^(text\/plain|text\/markdown|text\/x-markdown)$/i;
  var MAX_BYTES = 4 * 1024 * 1024; // larger files stay plain; the toolbar button still works
  var detect = window.HushmarkDetect;

  function shownByManifest() {
    var path = location.pathname;
    var query = location.href.split('#')[0].indexOf('?') >= 0;
    return STATIC_PATH.test(path) && (!query || STATIC_QUERY_PATH.test(path));
  }

  function fileName() {
    var last = location.pathname.split('/').pop() || '';
    try {
      return decodeURIComponent(last);
    } catch (err) {
      return last;
    }
  }

  // The text of Chrome's plain-text view, or null when this is not one.
  function plainText() {
    if (document instanceof XMLDocument) {
      return null;
    }
    var type = (document.contentType || '').toLowerCase();
    if (!PLAIN_TYPES.test(type)) {
      return null; // HTML, XML, images, and code Chrome typed itself
    }
    var body = document.body;
    if (!body || body.childElementCount !== 1 || body.firstElementChild.tagName !== 'PRE') {
      return null; // an empty file has no <pre>, and nothing to format
    }
    var pre = body.firstElementChild;
    var node = pre.firstChild;
    // one text node holds the whole file; reading it does not copy it
    return node && node.nodeType === 3 && !node.nextSibling ? node.data : pre.textContent;
  }

  function main() {
    if (!detect || window.top !== window || location.protocol !== 'file:') {
      return;
    }
    var name = fileName();
    if (shownByManifest()) {
      return;
    }
    // A Markdown name the manifest's patterns miss needs no content check.
    var named = MARKDOWN_PATH.test(location.pathname);
    if (!named && detect.vetoedByName(name)) {
      return;
    }
    var html = document.documentElement;
    if (html.hasAttribute('data-mdv') || html.hasAttribute('data-mdv-claim')) {
      return;
    }
    var text = plainText();
    if (text == null || !text.trim() || text.length > MAX_BYTES) {
      return;
    }
    if (!named && detect.looksLikeMarkdown(text, name).score < detect.THRESHOLD) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ hushmark: 'render-file', named: named });
    } catch (err) { /* extension updated or removed since the page loaded */ }
  }

  main();
})();
