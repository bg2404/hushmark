/*
 * Hushmark — render.js
 *
 * Turns Markdown text into sanitized HTML and adds GitHub-style heading
 * anchors. Pure transformation code: it never touches the network, storage,
 * or anything outside the element it is handed.
 *
 * Depends on two vendored libraries loaded before this file:
 *   - marked    (Markdown parser)      vendor/marked.umd.js
 *   - DOMPurify (HTML sanitizer)       vendor/purify.js
 */
(function (global) {
  'use strict';

  var markedLib = global.marked;
  var DOMPurify = global.DOMPurify;
  if (!markedLib || !DOMPurify) {
    return;
  }

  /* ------------------------------------------------------------------ *
   * Sanitizer configuration
   * ------------------------------------------------------------------ */

  // URL schemes a local document may link to or embed. Anything else that
  // looks like a scheme (javascript:, vbscript:, data: on links, ...) is
  // dropped. Relative URLs and #fragments always pass. DOMPurify still allows
  // data: URLs on <img>/<audio>/<video> through its own DATA_URI_TAGS rule.
  var ALLOWED_URI = /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

  var PURIFY_CONFIG = {
    // Plain HTML only. No SVG or MathML, which have large attack surfaces
    // and almost never appear in Markdown documents.
    USE_PROFILES: { html: true },
    // Keep HTML comments (e.g. "<!-- toc -->" markers) so an edit does not
    // delete them; DOMPurify still drops comments that contain markup.
    ADD_TAGS: ['#comment'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    // No form controls: a document must not be able to collect or submit
    // anything. <input> is handled separately below for task lists.
    FORBID_TAGS: [
      'style', 'form', 'button', 'select', 'textarea', 'option', 'optgroup',
      'fieldset', 'legend', 'datalist', 'output', 'template', 'marquee'
    ],
    // Inline styles can load remote resources (url(...)) and overlay the UI.
    // spellcheck: the editor's setting decides, not the document.
    FORBID_ATTR: ['style', 'spellcheck']
  };

  // The "mdv-" class prefix and "data-mdv*" attributes belong to the viewer's
  // own UI. A document must not be able to borrow them to imitate or hide
  // the controls, or to have its content treated as editor furniture.
  var sanitizingOwnMarkup = false;
  DOMPurify.addHook('uponSanitizeAttribute', function (node, data) {
    if (sanitizingOwnMarkup) {
      return;
    }
    if (/^data-mdv/i.test(data.attrName)) {
      data.keepAttr = false;
    } else if (data.attrName === 'class') {
      data.attrValue = data.attrValue.split(/\s+/).filter(function (c) { return c && !/^mdv-/i.test(c); }).join(' ');
      if (!data.attrValue) {
        data.keepAttr = false;
      }
    }
  });

  // Copying or cutting a held-back image puts its parked address on the
  // clipboard. Put it back before attributes are checked, so it goes through
  // the normal URL rules and is parked again below, instead of being dropped
  // with the other data-mdv attributes. (DOMPurify works in an inert
  // document, so nothing loads here.)
  DOMPurify.addHook('beforeSanitizeAttributes', function (node) {
    if (sanitizingOwnMarkup || !node.getAttribute) {
      return;
    }
    MEDIA_ATTRS.forEach(function (attr) {
      var parked = node.getAttribute('data-mdv-remote-' + attr);
      if (parked != null) {
        if (!node.hasAttribute(attr)) {
          node.setAttribute(attr, parked);
        }
        node.removeAttribute('data-mdv-remote-' + attr);
      }
    });
    node.removeAttribute('data-mdv-blocked');
  });

  // Task-list checkboxes are the only <input> Markdown produces. Force every
  // surviving <input> to be a disabled checkbox so a document cannot show
  // text fields or submit buttons.
  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.nodeName === 'INPUT') {
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
      node.removeAttribute('name');
      node.removeAttribute('form');
      node.removeAttribute('value');
    }
    if (blockRemote) {
      parkRemote(node);
    }
  });

  /* ------------------------------------------------------------------ *
   * Images, video and audio from the web
   * ------------------------------------------------------------------ */

  // Rendering would make Chrome fetch any image, video or audio a document
  // embeds from the web, which tells that server the file is being read.
  // Unless the user chose otherwise, such addresses are parked in
  // data-mdv-remote-* attributes, so nothing loads, and are put back when
  // the user asks to load them or when the document is saved.
  var MEDIA_ATTRS = ['src', 'srcset', 'poster', 'background'];
  var blockRemote = true;

  // Resolves the address the way Chrome will (it accepts "https:host/x",
  // backslashes, and tabs or control characters inside the scheme) and lets
  // only files on this computer, data: and blob: through.
  function isRemoteUrl(raw) {
    var s = String(raw).replace(/[\u0000-\u0020]/g, '');
    if (!s) {
      return false;
    }
    var u;
    try {
      u = new URL(s, global.document.baseURI);
    } catch (err) {
      return true; // unparseable: do not risk it
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') {
      return false;
    }
    if (u.protocol === 'file:') {
      return !(u.hostname === '' || u.hostname === 'localhost');
    }
    // A Markdown file on a website may show images from its own site: that
    // server already served the file. Images from any other site are held.
    var page = global.location;
    return !((page.protocol === 'http:' || page.protocol === 'https:') && u.origin === page.origin);
  }

  function isRemote(attr, value) {
    if (attr === 'srcset') {
      return value.split(',').some(function (part) {
        var url = part.trim().split(/\s+/)[0];
        return !!url && isRemoteUrl(url);
      });
    }
    return isRemoteUrl(value);
  }

  function parkRemote(node) {
    if (!node.getAttribute) {
      return;
    }
    MEDIA_ATTRS.forEach(function (attr) {
      var value = node.getAttribute(attr);
      if (value != null && isRemote(attr, value)) {
        node.setAttribute('data-mdv-remote-' + attr, value);
        node.removeAttribute(attr);
        node.setAttribute('data-mdv-blocked', '');
      }
    });
  }

  // Puts parked addresses back inside `root`; returns how many elements.
  function restoreRemote(root) {
    var nodes = root.querySelectorAll('[data-mdv-blocked]');
    nodes.forEach(function (node) {
      MEDIA_ATTRS.forEach(function (attr) {
        var name = 'data-mdv-remote-' + attr;
        if (node.hasAttribute(name)) {
          node.setAttribute(attr, node.getAttribute(name));
          node.removeAttribute(name);
        }
      });
      node.removeAttribute('data-mdv-blocked');
    });
    return nodes.length;
  }

  function countRemote(root) {
    return root.querySelectorAll('[data-mdv-blocked]').length;
  }

  function sanitizeWith(html, options) {
    blockRemote = !(options && options.remote);
    try {
      return DOMPurify.sanitize(html, PURIFY_CONFIG);
    } finally {
      blockRemote = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * Markdown parser
   * ------------------------------------------------------------------ */

  var parser = new markedLib.Marked({
    gfm: true,       // tables, task lists, strikethrough, autolinks
    breaks: false,   // like GitHub's .md rendering: single newlines do not break
    pedantic: false,
    async: false
  });

  /* ------------------------------------------------------------------ *
   * Front matter
   * ------------------------------------------------------------------ */

  var FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
  var SIMPLE_ENTRY = /^([A-Za-z0-9_][A-Za-z0-9_ .\-]*?)\s*:\s?(.*)$/;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Splits a leading YAML-style front matter block off the document.
  // Returns { body, html } where html is a small table of key/value pairs
  // (or the raw block when it is not simple key: value lines).
  function extractFrontMatter(markdown) {
    var match = FRONT_MATTER.exec(markdown);
    // A document that merely opens with a "---" rule is not front matter:
    // the first line of a front matter block is a key, a comment or a list.
    if (!match || !/^(?:[A-Za-z0-9_][A-Za-z0-9_ .\-]*:|#|- )/.test(match[1])) {
      return { body: markdown, html: '', raw: '', block: '' };
    }
    var raw = match[1];
    var body = markdown.slice(match[0].length);
    var rows = [];
    var simple = true;
    var lines = raw.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) {
        continue; // blank line or comment
      }
      var entry = SIMPLE_ENTRY.exec(line);
      if (entry && !/^\s/.test(line)) {
        rows.push([entry[1].trim(), entry[2].trim()]);
      } else if (rows.length && /^\s/.test(line)) {
        // continuation / nested value: append to the previous entry
        rows[rows.length - 1][1] = (rows[rows.length - 1][1] + ' ' + line.trim()).trim();
      } else {
        simple = false;
        break;
      }
    }
    var html;
    if (simple && rows.length) {
      html = '<table class="mdv-frontmatter"><tbody>' + rows.map(function (row) {
        return '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + escapeHtml(row[1]) + '</td></tr>';
      }).join('') + '</tbody></table>\n';
    } else {
      html = '<pre class="mdv-frontmatter">' + escapeHtml(raw) + '</pre>\n';
    }
    // block is the exact original text of the front matter, so an editor can
    // put it back byte for byte.
    return { body: body, html: html, raw: raw, block: match[0] };
  }

  /* ------------------------------------------------------------------ *
   * Encoding repair
   * ------------------------------------------------------------------ */

  // Chrome shows local text files that have no byte-order mark using the
  // windows-1252 encoding, so a UTF-8 file with accents, CJK text or emoji
  // comes out garbled ("Ã©" instead of "é"). windows-1252 maps every byte to
  // exactly one character, so the original bytes can be recovered from the
  // garbled text and decoded as UTF-8. If the bytes are not valid UTF-8 the
  // file really was windows-1252 and the text is returned unchanged.
  var CP1252_HIGH = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178
  ];
  var CP1252_REVERSE = new Map();
  for (var b = 0; b < CP1252_HIGH.length; b++) {
    CP1252_REVERSE.set(CP1252_HIGH[b], 0x80 + b);
  }

  function repairWindows1252(text) {
    if (typeof TextDecoder === 'undefined' || !/[^\x00-\x7F]/.test(text)) {
      return text; // pure ASCII: nothing to repair
    }
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80 || (code >= 0xA0 && code <= 0xFF)) {
        bytes[i] = code;
      } else if (CP1252_REVERSE.has(code)) {
        bytes[i] = CP1252_REVERSE.get(code);
      } else {
        return text; // not something windows-1252 could have produced
      }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      return text; // genuinely not UTF-8; keep Chrome's decoding
    }
  }

  // Chrome's default encoding for local text files follows the UI language
  // (Shift_JIS for Japanese, windows-1251 for Russian, ...). For any
  // single-byte legacy encoding the bytes can be recovered the same way as
  // for windows-1252: decode each of the 256 bytes once to build the
  // reverse table. Multi-byte encodings are left alone.
  var reverseTables = {};
  function reverseTable(label) {
    if (label in reverseTables) {
      return reverseTables[label];
    }
    var table = null;
    try {
      var decoder = new TextDecoder(label);
      var map = new Map();
      var single = true;
      for (var b = 0; b < 256 && single; b++) {
        var ch = decoder.decode(new Uint8Array([b]));
        if (ch.length !== 1) {
          single = false;
        } else if (!map.has(ch)) {
          map.set(ch, b);
        }
      }
      table = single && map.size > 200 ? map : null;
    } catch (err) {
      table = null;
    }
    reverseTables[label] = table;
    return table;
  }

  function repairLegacyDecoding(text, label) {
    label = String(label || '').toLowerCase();
    if (label === 'windows-1252' || label === 'iso-8859-1' || label === 'us-ascii') {
      return repairWindows1252(text);
    }
    if (typeof TextDecoder === 'undefined' || !/[^\x00-\x7F]/.test(text)) {
      return text;
    }
    var table = reverseTable(label);
    if (!table) {
      return text;
    }
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch.charCodeAt(0) < 0x80) {
        bytes[i] = ch.charCodeAt(0);
      } else if (table.has(ch)) {
        bytes[i] = table.get(ch);
      } else {
        return text;
      }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      return text;
    }
  }

  /* ------------------------------------------------------------------ *
   * Markdown -> sanitized HTML
   * ------------------------------------------------------------------ */

  // options.frontMatter === false renders the text as-is without looking
  // for a front matter block (used when the caller already removed it).
  function toHtml(markdown, options) {
    var fm = (options && options.frontMatter === false)
      ? { body: markdown, html: '' }
      : extractFrontMatter(markdown);
    var html = sanitizeWith(parser.parse(fm.body), options);
    var fmHtml = '';
    if (fm.html) {
      // built by extractFrontMatter from escaped text; keeps its own class
      sanitizingOwnMarkup = true;
      try {
        fmHtml = DOMPurify.sanitize(fm.html, PURIFY_CONFIG);
      } finally {
        sanitizingOwnMarkup = false;
      }
    }
    return fmHtml + html;
  }

  // Sanitizes arbitrary HTML (for example pasted content) with the same
  // rules the rendered document gets.
  function sanitizeHtml(html, options) {
    return sanitizeWith(String(html), options);
  }

  // True when a URL typed by the user would survive the sanitizer, i.e. it is
  // relative, a fragment, or uses http(s), mailto, tel or file.
  function isSafeUrl(url) {
    var cleaned = String(url).replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g, '');
    return cleaned.length > 0 && ALLOWED_URI.test(cleaned);
  }

  /* ------------------------------------------------------------------ *
   * Heading ids and anchors (GitHub style)
   * ------------------------------------------------------------------ */

  // "Hello, World!" -> "hello-world". Letters and digits in any script are
  // kept; punctuation and symbols are dropped; whitespace becomes "-".
  function slugify(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
  }

  // Gives every heading inside `root` a unique id and a "#" anchor link, after
  // the HTML has been sanitized and inserted into the page (so ids cannot be
  // smuggled in by the document and existing ids are respected).
  // Returns { title } — the text of the first <h1>, if any.
  function addHeadingAnchors(root) {
    var doc = root.ownerDocument;
    var used = new Set();
    root.querySelectorAll('[id]').forEach(function (el) { used.add(el.id); });

    var title = '';
    var first = root.querySelector('h1');
    if (first) {
      title = first.textContent.replace(/\s+/g, ' ').trim();
    }

    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function (heading) {
      var id = heading.id;
      if (!id) {
        var base = slugify(heading.textContent) || 'section';
        id = base;
        for (var n = 1; used.has(id); n++) {
          id = base + '-' + n;
        }
        used.add(id);
        heading.id = id;
      }
      var anchor = doc.createElement('a');
      anchor.className = 'mdv-anchor';
      anchor.href = '#' + id;
      anchor.setAttribute('aria-label', 'Link to this section');
      anchor.textContent = '#';
      heading.insertBefore(anchor, heading.firstChild);
    });

    return { title: title };
  }

  global.Hushmark = {
    version: '2.0.0',
    toHtml: toHtml,
    sanitizeHtml: sanitizeHtml,
    restoreRemote: restoreRemote,
    countRemote: countRemote,
    isSafeUrl: isSafeUrl,
    slugify: slugify,
    extractFrontMatter: extractFrontMatter,
    addHeadingAnchors: addHeadingAnchors,
    repairWindows1252: repairWindows1252,
    repairLegacyDecoding: repairLegacyDecoding,
    escapeHtml: escapeHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
