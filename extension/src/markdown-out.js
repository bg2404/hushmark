/*
 * Hushmark — markdown-out.js
 *
 * Turns the edited document (DOM) back into Markdown using the vendored
 * Turndown library plus its GFM plugin, tuned to produce the same style of
 * Markdown that GitHub documents usually use: "#" headings, "-" bullets,
 * fenced code blocks, "**bold**", "*italic*", "~~strike~~", pipe tables and
 * "- [x]" task lists.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  var TurndownService = global.TurndownService;
  var gfm = global.turndownPluginGfm;
  if (!api || !TurndownService) {
    return;
  }

  var service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '  '
  });

  if (gfm && gfm.gfm) {
    service.use(gfm.gfm); // tables, strikethrough, task lists
  }

  // Rules added later take precedence over earlier ones.

  // GitHub documents use two tildes; the plugin emits one.
  service.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: function (content) {
      return '~~' + content + '~~';
    }
  });

  // Link and image addresses. Markdown un-escapes "\\" (and "\\(" etc.) inside
  // them, and Turndown only escapes brackets, so an address with backslashes
  // (a Windows or network path) would lose half of them on every save.
  // Backslashes are doubled first; addresses with whitespace go in <...>.
  // These rules are added before the autolink and layout rules below, which
  // therefore still take precedence.
  function destination(url) {
    var d = String(url).replace(/\\/g, '\\\\').replace(/([<>()])/g, '\\$1');
    return /\s/.test(d) ? '<' + d + '>' : d;
  }

  function titlePart(node) {
    var t = node.getAttribute('title');
    if (!t) {
      return '';
    }
    t = t.replace(/(\n+\s*)+/g, '\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ' "' + t + '"';
  }

  // Markdown cannot carry some addresses faithfully: marked percent-encodes
  // backslashes and control characters in them, which turns a Windows or
  // network path into a different, local one. Those keep their HTML tag.
  var NEEDS_HTML = /[\\\u0000-\u001f\u007f]/;

  function attr(name, value) {
    return value ? ' ' + name + '="' + api.escapeHtml(value) + '"' : '';
  }

  service.addRule('image', {
    filter: 'img',
    replacement: function (content, node) {
      var src = node.getAttribute('src') || '';
      if (!src) {
        return '';
      }
      if (NEEDS_HTML.test(src)) {
        return '<img' + attr('src', src) + attr('alt', node.getAttribute('alt')) + attr('title', node.getAttribute('title')) + '>';
      }
      var alt = service.escape((node.getAttribute('alt') || '').replace(/(\n+\s*)+/g, '\n'));
      return '![' + alt + '](' + destination(src) + titlePart(node) + ')';
    }
  });

  service.addRule('inlineLink', {
    filter: function (node) {
      return node.nodeName === 'A' && !!node.getAttribute('href');
    },
    replacement: function (content, node) {
      var href = node.getAttribute('href');
      if (NEEDS_HTML.test(href)) {
        return '<a' + attr('href', href) + attr('title', node.getAttribute('title')) + '>' + content + '</a>';
      }
      return '[' + content + '](' + destination(href) + titlePart(node) + ')';
    }
  });

  // A link whose text is its own URL becomes a bare autolink.
  service.addRule('autolink', {
    filter: function (node) {
      if (node.nodeName !== 'A' || node.getAttribute('title')) {
        return false;
      }
      var href = (node.getAttribute('href') || '').trim();
      return /^(?:https?:\/\/|mailto:)/i.test(href) && node.textContent.trim() === href;
    },
    replacement: function (content, node) {
      return node.getAttribute('href').trim();
    }
  });

  // Task-list checkboxes, including inside loose lists (<li><p><input>…).
  service.addRule('taskCheckbox', {
    filter: function (node) {
      if (node.nodeName !== 'INPUT' || node.getAttribute('type') !== 'checkbox') {
        return false;
      }
      var parent = node.parentNode;
      if (parent && parent.nodeName === 'P') {
        parent = parent.parentNode;
      }
      return !!parent && parent.nodeName === 'LI';
    },
    replacement: function (content, node) {
      var next = node.nextSibling;
      var spaceFollows = next && next.nodeType === 3 && /^\s/.test(next.nodeValue);
      return (node.checked || node.hasAttribute('checked') ? '[x]' : '[ ]') + (spaceFollows ? '' : ' ');
    }
  });

  // Table cells: escape pipes and flatten line breaks so the table stays valid.
  service.addRule('tableCellSafe', {
    filter: ['th', 'td'],
    replacement: function (content, node) {
      var index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      var prefix = index === 0 ? '| ' : ' ';
      var text = content.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
      return prefix + text + ' |';
    }
  });

  // GitHub-style list items: one space after the marker ("- item", "1. item")
  // instead of Turndown's padded "-   item"; nested content is indented to
  // the item's content column.
  service.addRule('listItemCompact', {
    filter: 'li',
    replacement: function (content, node, options) {
      var parent = node.parentNode;
      var prefix = options.bulletListMarker + ' ';
      if (parent.nodeName === 'OL') {
        var start = parent.getAttribute('start');
        var index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '. ';
      }
      var indent = new Array(prefix.length + 1).join(' ');
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + indent);
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    }
  });

  // A hard break inside a table cell has no Markdown form; keep it as HTML.
  service.addRule('cellBreak', {
    filter: function (node) {
      return node.nodeName === 'BR' && !!node.parentNode.closest('td, th');
    },
    replacement: function () {
      return '<br>';
    }
  });

  // <details>: the wrapper stays HTML, the content inside goes back to
  // Markdown (which is how people write collapsible sections).
  service.addRule('summary', {
    filter: 'summary',
    replacement: function (content) {
      return '<summary>' + content.trim() + '</summary>\n';
    }
  });
  service.addRule('details', {
    filter: 'details',
    replacement: function (content, node) {
      return '\n\n<details' + (node.hasAttribute('open') ? ' open' : '') + '>\n' + content.trim() + '\n\n</details>\n\n';
    }
  });

  // Anchors and ids that fragment links depend on.
  service.addRule('namedAnchor', {
    filter: function (node) {
      return (node.nodeName === 'A' && !node.getAttribute('href') && (node.id || node.getAttribute('name'))) ||
        (node.nodeName === 'SPAN' && node.id);
    },
    replacement: function (content, node) {
      return node.nodeName === 'A' ? node.outerHTML : '<span id="' + api.escapeHtml(node.id) + '">' + content + '</span>';
    }
  });

  // Layout HTML that Markdown cannot express stays as it was written.
  service.addRule('layoutHtml', {
    filter: function (node) {
      return ((node.nodeName === 'P' || node.nodeName === 'DIV') && node.hasAttribute('align')) ||
        (node.nodeName === 'IMG' && (node.hasAttribute('width') || node.hasAttribute('height')));
    },
    replacement: function (content, node) {
      return node.nodeName === 'IMG' ? node.outerHTML : '\n\n' + node.outerHTML + '\n\n';
    }
  });

  // HTML comments (turned into placeholder elements by prepare()).
  service.addRule('comment', {
    filter: function (node) {
      return node.nodeName === 'MDV-COMMENT';
    },
    replacement: function (content, node) {
      return '<!--' + node.getAttribute('data-text') + '-->';
    }
  });

  // Elements Markdown has no syntax for stay as inline HTML.
  service.keep([
    'kbd', 'sup', 'sub', 'mark', 'abbr', 'dl', 'dt', 'dd',
    'video', 'audio', 'source', 'figure', 'figcaption', 'ins', 'small', 'cite',
    'q', 'var', 'samp', 'u', 'center'
  ]);
  service.remove(['script', 'style', 'template']);

  // Turndown escapes "[" and "]" everywhere, which turns ordinary prose like
  // "array[0]" into "array\[0\]". Only escape brackets when they could form
  // a link or reference.
  // Turndown also leaves "<" and "&" alone, so literal text such as
  // "a <script> tag" or "&copy;" would turn into live HTML on the next render.
  var defaultEscape = service.escape.bind(service);
  service.escape = function (text) {
    var escaped = defaultEscape(text);
    if (!/\]\(|\]\[|\]:/.test(text)) {
      escaped = escaped.replace(/\\([\[\]])/g, '$1');
    }
    return escaped
      .replace(/<(?=[A-Za-z\/!?])/g, '\\<')
      .replace(/&(?=[A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&amp;');
  };

  // Removes editor-only nodes and normalises what contenteditable leaves
  // behind (non-breaking spaces in prose, empty "<p><br></p>" lines).
  function prepare(root) {
    // Work on a copy inside an inert document: it has no browsing context,
    // so restoring a blocked image's address below cannot make it load.
    var doc = root.ownerDocument.implementation.createHTMLDocument('');
    var clone = doc.importNode(root, true);
    doc.body.appendChild(clone);
    clone.querySelectorAll('.mdv-anchor, [data-mdv-ui]').forEach(function (el) { el.remove(); });
    // web images that were blocked from loading keep their real addresses
    if (api.restoreRemote) {
      api.restoreRemote(clone);
    }
    clone.querySelectorAll('[contenteditable]').forEach(function (el) { el.removeAttribute('contenteditable'); });
    // a raw <pre> without <code> is still a code block
    clone.querySelectorAll('pre').forEach(function (pre) {
      if (!pre.querySelector(':scope > code')) {
        var code = doc.createElement('code');
        code.textContent = pre.textContent;
        pre.replaceChildren(code);
      }
    });
    // Turndown cannot see comments; carry them as placeholder elements
    var comments = doc.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    var found = [];
    var c;
    while ((c = comments.nextNode())) {
      found.push(c);
    }
    found.forEach(function (comment) {
      var holder = doc.createElement('mdv-comment');
      holder.setAttribute('data-text', comment.data);
      comment.parentNode.replaceChild(holder, comment);
    });
    clone.querySelectorAll('p, div').forEach(function (el) {
      if (!el.textContent.trim() && !el.querySelector('img, input, video, audio, hr, table, a[id], a[name], span[id], mdv-comment')) {
        el.remove();
      }
    });
    // contenteditable types non-breaking spaces into prose; code keeps its bytes
    var walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.indexOf(' ') !== -1 && !node.parentNode.closest('pre, code')) {
        node.nodeValue = node.nodeValue.replace(/ /g, ' ');
      }
    }
    return clone;
  }

  // Blank-looking lines outside code fences carry nothing; inside a fence
  // they are content.
  function tidy(markdown) {
    var inFence = false;
    return markdown.split('\n').map(function (line) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/^[ \t]+$/, '');
    }).join('\n');
  }

  function toMarkdown(root) {
    var markdown = tidy(service.turndown(prepare(root)));
    markdown = markdown.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    return markdown.length ? markdown.replace(/\n*$/, '\n') : '';
  }

  api.toMarkdown = toMarkdown;
})(typeof globalThis !== 'undefined' ? globalThis : window);
