/*
 * Hushmark — editor.js
 *
 * WYSIWYG editing on top of the rendered document. The rendered <main> is
 * made contenteditable; formatting goes through the browser's own editing
 * commands (so undo/redo work) plus a few DOM operations for things the
 * browser cannot do (lists nesting, tables, task items). Markdown shortcuts
 * typed at the start of a line ("# ", "- ", "1. ", "> ", "```", "---",
 * "[ ] ") turn into the matching structure, Typora-style.
 *
 * Nothing here parses or serialises Markdown; app.js converts the DOM back
 * with markdown-out.js when the document is saved or the mode changes.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  var BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,dd,dt';
  var isMac = /Mac|iPhone|iPad/.test(global.navigator.platform);
  var MOD = isMac ? '⌘' : 'Ctrl+';
  var ALT = isMac ? '⌥' : 'Alt+';
  var SHIFT = isMac ? '⇧' : 'Shift+';

  var TOOLBAR = [
    { cmd: 'heading', arg: 1, text: 'H1', title: 'Heading 1', keys: MOD + ALT + '1' },
    { cmd: 'heading', arg: 2, text: 'H2', title: 'Heading 2', keys: MOD + ALT + '2' },
    { cmd: 'heading', arg: 3, text: 'H3', title: 'Heading 3', keys: MOD + ALT + '3' },
    { cmd: 'paragraph', text: '\u00B6', title: 'Paragraph', keys: MOD + ALT + '0' },
    null,
    { cmd: 'bold', text: 'B', title: 'Bold', keys: MOD + 'B' },
    { cmd: 'italic', text: 'I', title: 'Italic', keys: MOD + 'I' },
    { cmd: 'strike', text: 'S', title: 'Strikethrough', keys: MOD + SHIFT + 'X' },
    { cmd: 'code', icon: 'code', title: 'Inline code', keys: MOD + 'E' },
    { cmd: 'link', icon: 'link', title: 'Link', keys: MOD + 'K' },
    { cmd: 'image', icon: 'image', title: 'Image', keys: MOD + SHIFT + 'K' },
    null,
    { cmd: 'ul', icon: 'ul', title: 'Bulleted list', keys: MOD + SHIFT + '8' },
    { cmd: 'ol', icon: 'ol', title: 'Numbered list', keys: MOD + SHIFT + '7' },
    { cmd: 'task', icon: 'task', title: 'Task list', keys: MOD + SHIFT + '9' },
    { cmd: 'quote', icon: 'quote', title: 'Quote', keys: MOD + SHIFT + '.' },
    { cmd: 'codeBlock', icon: 'codeblock', title: 'Code block', keys: MOD + ALT + 'C' },
    { cmd: 'table', icon: 'table', title: 'Insert table' },
    { cmd: 'hr', icon: 'hr', title: 'Horizontal rule' },
    null,
    { cmd: 'undo', icon: 'undo', title: 'Undo', keys: MOD + 'Z' },
    { cmd: 'redo', icon: 'redo', title: 'Redo', keys: MOD + SHIFT + 'Z' },
    { cmd: 'clear', icon: 'clear', title: 'Clear formatting' }
  ];

  var TABLE_TOOLS = [
    ['rowBelow', 'Add row'],
    ['colRight', 'Add column'],
    ['delRow', 'Delete row'],
    ['delCol', 'Delete column'],
    ['delTable', 'Delete table']
  ];

  function createEditor(options) {
    var root = options.element;
    var doc = root.ownerDocument;
    var container = options.container || doc.body;   // table tools, positioned relative to this
    var overlay = options.overlay || container;        // dialogs cover this
    var onChange = options.onChange || function () {};
    var isSafeUrl = options.isSafeUrl || function () { return true; };
    var sanitize = options.sanitize || function (html) { return html; };
    var escapeHtml = api.escapeHtml;

    var enabled = false;
    var savedRange = null;
    var dialog = null;
    var tableTools = null;
    var toolsReturnRange = null; // caret to restore when leaving the table tools
    var live = doc.createElement('div'); // screen-reader feedback for table operations
    live.className = 'mdv-sr-only';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('data-mdv-ui', '');
    var toolbarFrame = 0;
    var buttons = {};

    /* ---------------------------------------------------------------- *
     * Toolbar
     * ---------------------------------------------------------------- */

    var toolbar = doc.createElement('div');
    toolbar.className = 'mdv-format';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Formatting');
    TOOLBAR.forEach(function (item) {
      if (!item) {
        var sep = doc.createElement('span');
        sep.className = 'mdv-sep';
        toolbar.appendChild(sep);
        return;
      }
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'mdv-btn mdv-btn-' + item.cmd;
      if (item.icon && api.icon) {
        b.appendChild(api.icon(item.icon));
      } else {
        b.textContent = item.text;
      }
      b.title = item.title + (item.keys ? ' (' + item.keys + ')' : '');
      b.setAttribute('aria-label', item.title);
      b.dataset.cmd = item.cmd;
      if (item.arg != null) {
        b.dataset.arg = String(item.arg);
      }
      // mousedown would move focus (and the selection) out of the editor
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { run(item.cmd, item.arg); });
      b.tabIndex = -1;
      buttons[item.cmd + (item.arg != null ? item.arg : '')] = b;
      toolbar.appendChild(b);
    });

    // One Tab stop for the whole toolbar; arrow keys move between buttons.
    var toolbarButtons = Array.prototype.slice.call(toolbar.querySelectorAll('button'));
    toolbarButtons[0].tabIndex = 0;
    function visibleToolbarButtons() {
      return toolbarButtons.filter(function (b) { return b.offsetParent !== null; });
    }
    toolbar.addEventListener('keydown', function (e) {
      var keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
      if (!(e.key in keys)) {
        return;
      }
      var list = visibleToolbarButtons();
      var i = list.indexOf(doc.activeElement);
      var next = keys[e.key] === 'first' ? 0 : keys[e.key] === 'last' ? list.length - 1 : (i + keys[e.key] + list.length) % list.length;
      e.preventDefault();
      toolbarButtons.forEach(function (b) { b.tabIndex = -1; });
      list[next].tabIndex = 0;
      list[next].focus();
    });
    function markToolbarEnd() {
      toolbar.classList.toggle('mdv-at-end', toolbar.scrollLeft + toolbar.clientWidth >= toolbar.scrollWidth - 1);
    }
    toolbar.addEventListener('scroll', markToolbarEnd, { passive: true });

    /* ---------------------------------------------------------------- *
     * Selection helpers
     * ---------------------------------------------------------------- */

    function selection() {
      return doc.getSelection();
    }

    function range() {
      var s = selection();
      return s && s.rangeCount ? s.getRangeAt(0) : null;
    }

    function inside(node) {
      return !!node && node !== root && root.contains(node);
    }

    function caretNode() {
      var r = range();
      if (!r || !root.contains(r.startContainer)) {
        return null;
      }
      var n = r.startContainer;
      return n.nodeType === 1 ? n : n.parentNode;
    }

    function closest(sel) {
      var n = caretNode();
      if (!n) {
        return null;
      }
      var el = n.closest(sel);
      return inside(el) ? el : null;
    }

    function currentBlock() {
      var n = caretNode();
      while (n && n !== root) {
        if (n.nodeType === 1 && n.matches(BLOCKS)) {
          return n;
        }
        n = n.parentNode;
      }
      return null;
    }

    function textBefore(block) {
      var r = range();
      if (!r) {
        return '';
      }
      var c = doc.createRange();
      c.selectNodeContents(block);
      c.setEnd(r.startContainer, r.startOffset);
      return c.toString();
    }

    function textAfter(block) {
      var r = range();
      if (!r) {
        return '';
      }
      var c = doc.createRange();
      c.selectNodeContents(block);
      c.setStart(r.endContainer, r.endOffset);
      return c.toString();
    }

    function selectRange(r) {
      var s = selection();
      s.removeAllRanges();
      s.addRange(r);
    }

    function placeCaret(node, atEnd) {
      var r = doc.createRange();
      r.selectNodeContents(node);
      r.collapse(!atEnd);
      selectRange(r);
    }

    function selectContents(node) {
      var r = doc.createRange();
      r.selectNodeContents(node);
      selectRange(r);
    }

    function exec(cmd, value) {
      doc.execCommand(cmd, false, value == null ? null : value);
    }

    function changed() {
      onChange();
      scheduleToolbar();
    }

    // Replaces a node through insertHTML so the change is undoable.
    function replaceNodeWithHtml(node, html) {
      var r = doc.createRange();
      r.selectNode(node);
      selectRange(r);
      exec('insertHTML', html);
    }

    function takeNew(selector) {
      var el = root.querySelector(selector + '[data-mdv-new]');
      if (el) {
        el.removeAttribute('data-mdv-new');
      }
      return el;
    }

    function isEmptyBlock(block) {
      return !!block && block.textContent.trim() === '' && !block.querySelector('img, input, table, hr');
    }

    // Always leave a paragraph after a trailing block the caret cannot enter.
    function ensureTrailingParagraph() {
      var last = root.lastElementChild;
      if (!last || /^(PRE|TABLE|UL|OL|BLOCKQUOTE|HR|DETAILS|DIV)$/.test(last.tagName)) {
        var p = doc.createElement('p');
        p.innerHTML = '<br>';
        root.appendChild(p);
      }
    }

    /* ---------------------------------------------------------------- *
     * Commands
     * ---------------------------------------------------------------- */

    function formatBlock(tag) {
      var block = currentBlock();
      if (block && block.tagName === 'PRE') {
        var lines = block.textContent.replace(/\n$/, '').split('\n');
        replaceNodeWithHtml(block, lines.map(function (l) { return '<p>' + (escapeHtml(l) || '<br>') + '</p>'; }).join(''));
        if (tag === 'p') {
          changed();
          return;
        }
      }
      exec('formatBlock', '<' + tag + '>');
      changed();
    }

    function toggleInlineCode() {
      var code = closest('code');
      if (code && !code.closest('pre')) {
        replaceNodeWithHtml(code, escapeHtml(code.textContent));
        changed();
        return;
      }
      if (closest('pre')) {
        return;
      }
      var r = range();
      if (!r) {
        return;
      }
      var collapsed = r.collapsed;
      var text = collapsed ? 'code' : r.toString();
      exec('insertHTML', '<code data-mdv-new="1">' + escapeHtml(text) + '</code>');
      var el = takeNew('code');
      if (el) {
        if (collapsed) {
          selectContents(el);
        } else {
          placeCaret(el, true);
        }
      }
      changed();
    }

    function toggleQuote() {
      var bq = closest('blockquote');
      if (bq) {
        unquote(bq);
      } else {
        makeQuote();
      }
    }

    function insertCodeBlock(lang) {
      if (closest('pre')) {
        return;
      }
      var r = range();
      var text = r && !r.collapsed ? r.toString() : '';
      var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      var html = '<pre data-mdv-new="1"><code' + cls + '>' + escapeHtml(text || '\n') + '</code></pre>';
      var block = currentBlock();
      if (isEmptyBlock(block) && block.tagName === 'P') {
        replaceNodeWithHtml(block, html);
      } else {
        exec('insertHTML', html);
      }
      var pre = takeNew('pre');
      if (pre) {
        placeCaret(pre.firstChild || pre, false);
      }
      ensureTrailingParagraph();
      changed();
    }

    // Chrome's insertUnorderedList on an emptied paragraph nests the list
    // inside the <p>, so lists and quotes that start from an empty block are
    // built from explicit HTML instead.
    function makeList(tag) {
      var block = currentBlock();
      if (isEmptyBlock(block) && (block.tagName === 'P' || block.tagName === 'DIV')) {
        replaceNodeWithHtml(block, '<' + tag + '><li data-mdv-new="1"><br></li></' + tag + '>');
        var li = takeNew('li');
        if (li) {
          placeCaret(li, false);
        }
      } else {
        exec(tag === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
      }
      changed();
    }

    function makeQuote() {
      var block = currentBlock();
      if (!block || block.tagName === 'LI' || block.tagName === 'TD' || block.tagName === 'TH') {
        return;
      }
      if (isEmptyBlock(block) && (block.tagName === 'P' || block.tagName === 'DIV')) {
        replaceNodeWithHtml(block, '<blockquote><p data-mdv-new="1"><br></p></blockquote>');
      } else {
        // Chrome's formatBlock would replace the paragraph instead of wrapping it
        var inner = block.cloneNode(true);
        inner.setAttribute('data-mdv-new', '1');
        replaceNodeWithHtml(block, '<blockquote>' + inner.outerHTML + '</blockquote>');
      }
      var p = takeNew(block.tagName.toLowerCase()) || takeNew('p');
      if (p) {
        placeCaret(p, true);
      }
      changed();
    }

    function unquote(bq) {
      var inner = bq.cloneNode(true);
      var first = inner.firstElementChild;
      if (first) {
        first.setAttribute('data-mdv-new', '1');
      }
      replaceNodeWithHtml(bq, inner.innerHTML || '<p data-mdv-new="1"><br></p>');
      var el = root.querySelector('[data-mdv-new]');
      if (el) {
        el.removeAttribute('data-mdv-new');
        placeCaret(el, true);
      }
      changed();
    }

    function isTaskItem(li) {
      var first = li ? firstContent(li) : null;
      return !!first && first.nodeName === 'INPUT' && first.type === 'checkbox';
    }

    function removeCheckbox(li) {
      var first = firstContent(li);
      var r = doc.createRange();
      r.setStartBefore(first);
      r.setEndAfter(first);
      var next = first.nextSibling;
      if (next && next.nodeType === 3 && /^\s/.test(next.nodeValue)) {
        r.setEnd(next, 1);
      }
      selectRange(r);
      exec('delete');
    }

    // insertText turns newlines into <br> inside <pre>, which serialises
    // badly, so text goes in as a text node. A selection is deleted through
    // Chrome first so that part stays undoable.
    function insertPlainTextInPre(text) {
      var r = range();
      if (!r) {
        return;
      }
      if (!r.collapsed) {
        exec('delete');
        r = range();
      }
      var codeEl = closest('code') || closest('pre');
      var tn = doc.createTextNode(text);
      r.insertNode(tn);
      // A <pre> does not render a line after a trailing newline, so the
      // caret could not stay there: keep one more newline at the end.
      if (/\n$/.test(text)) {
        var rest = doc.createRange();
        rest.setStartAfter(tn);
        rest.setEndAfter(codeEl.lastChild || tn);
        if (rest.toString() === '') {
          codeEl.appendChild(doc.createTextNode('\n'));
        }
      }
      var after = doc.createRange();
      after.setStartAfter(tn);
      after.collapse(true);
      selectRange(after);
      changed();
    }

    function firstContent(li) {
      var n = li.firstChild;
      while (n && n.nodeType === 3 && !n.nodeValue.trim()) {
        n = n.nextSibling;
      }
      if (n && n.nodeName === 'P') {
        return firstContent(n);
      }
      return n;
    }

    function toggleTask(forceChecked) {
      var li = closest('li');
      if (!li) {
        makeList('ul');
        li = closest('li');
        if (!li) {
          return;
        }
      }
      if (isTaskItem(li)) {
        removeCheckbox(li);
      } else {
        var target = li.firstElementChild && li.firstElementChild.tagName === 'P' ? li.firstElementChild : li;
        var start = doc.createRange();
        start.setStart(target, 0);
        start.collapse(true);
        selectRange(start);
        exec('insertHTML', '<input type="checkbox" data-mdv-new="1"' + (forceChecked ? ' checked' : '') + '> ');
        takeNew('input');
      }
      placeCaret(li, true);
      changed();
    }

    function insertTable(rows, cols) {
      if (closest('table') || closest('pre')) {
        return;
      }
      var html = '<table data-mdv-new="1"><thead><tr>';
      for (var c = 0; c < cols; c++) {
        html += '<th>' + (c === 0 ? 'Header' : '') + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (var r = 1; r < rows; r++) {
        html += '<tr>';
        for (var d = 0; d < cols; d++) {
          html += '<td><br></td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      var block = currentBlock();
      if (isEmptyBlock(block) && block.tagName === 'P') {
        replaceNodeWithHtml(block, html);
      } else {
        exec('insertHTML', html);
      }
      var table = takeNew('table');
      if (table) {
        selectContents(table.querySelector('th'));
      }
      changed();
    }

    function tableOp(op) {
      var cell = closest('td, th');
      if (!cell) {
        return null;
      }
      var table = cell.closest('table');
      var row = cell.parentNode;
      var index = Array.prototype.indexOf.call(row.children, cell);
      var rowIndex = Array.prototype.indexOf.call(table.rows, row);
      var inHead = row.parentNode.tagName === 'THEAD';

      // Work on a copy and commit it with insertHTML so the change is undoable.
      var copy = table.cloneNode(true);
      copy.setAttribute('data-mdv-new', '1');
      var crow = copy.rows[rowIndex];
      var focusRow = rowIndex;
      var focusCol = index;
      var removed = false;

      if (op === 'rowBelow') {
        var tr = doc.createElement('tr');
        for (var i = 0; i < crow.children.length; i++) {
          var td = doc.createElement('td');
          td.innerHTML = '<br>';
          tr.appendChild(td);
        }
        if (inHead) {
          var tbody = copy.tBodies[0] || copy.appendChild(doc.createElement('tbody'));
          tbody.insertBefore(tr, tbody.firstChild);
        } else {
          crow.parentNode.insertBefore(tr, crow.nextSibling);
        }
        focusRow = rowIndex + 1;
      } else if (op === 'colRight') {
        Array.prototype.forEach.call(copy.rows, function (r) {
          var ref = r.children[index];
          var c = doc.createElement(r.parentNode.tagName === 'THEAD' ? 'th' : 'td');
          c.innerHTML = '<br>';
          r.insertBefore(c, ref ? ref.nextSibling : null);
        });
        focusCol = index + 1;
      } else if (op === 'delRow') {
        if (inHead || copy.rows.length <= 1) {
          removed = true;
        } else {
          crow.remove();
          focusRow = Math.min(rowIndex, copy.rows.length - 1);
        }
      } else if (op === 'delCol') {
        if (crow.children.length <= 1) {
          removed = true;
        } else {
          Array.prototype.forEach.call(copy.rows, function (r) {
            if (r.children[index]) {
              r.children[index].remove();
            }
          });
          focusCol = Math.min(index, crow.children.length - 1);
        }
      } else if (op === 'delTable') {
        removed = true;
      }

      if (removed) {
        replaceNodeWithHtml(table, '<p data-mdv-new="1"><br></p>');
        var p = takeNew('p');
        toolsReturnRange = null;
        root.focus({ preventScroll: true });
        if (p) {
          placeCaret(p, false);
        }
        live.textContent = op === 'delTable' ? 'Table deleted' : 'Table deleted (nothing left of it)';
        hideTableTools();
        changed();
        return null;
      }

      replaceNodeWithHtml(table, copy.outerHTML);
      var fresh = takeNew('table');
      var target = fresh && fresh.rows[focusRow] && fresh.rows[focusRow].children[focusCol];
      toolsReturnRange = null;
      root.focus({ preventScroll: true });
      if (target) {
        selectContents(target);
      }
      live.textContent = { rowBelow: 'Row added', colRight: 'Column added', delRow: 'Row deleted', delCol: 'Column deleted' }[op] || '';
      ensureTrailingParagraph();
      changed();
      return fresh;
    }

    function moveCell(dir) {
      var cell = closest('td, th');
      if (!cell) {
        return false;
      }
      var cells = Array.prototype.slice.call(cell.closest('table').querySelectorAll('th, td'));
      var i = cells.indexOf(cell) + dir;
      if (i < 0) {
        return true;
      }
      if (i >= cells.length) {
        var fresh = tableOp('rowBelow');
        var last = fresh && fresh.rows[fresh.rows.length - 1];
        if (last && last.firstElementChild) {
          selectContents(last.firstElementChild); // first cell of the new row
        }
        return true;
      }
      selectContents(cells[i]);
      return true;
    }

    function indentList(dir) {
      var li = closest('li');
      if (!li) {
        return false;
      }
      var r = range();
      var caret = r ? { node: r.startContainer, offset: r.startOffset } : null;
      var list = li.parentNode;

      if (dir > 0) {
        var prev = li.previousElementSibling;
        if (!prev) {
          return true; // first item cannot be nested further
        }
        var sub = prev.querySelector(':scope > ul, :scope > ol');
        if (!sub) {
          sub = doc.createElement(list.tagName);
          prev.appendChild(sub);
        }
        sub.appendChild(li);
      } else {
        var parentLi = list.parentNode;
        if (!parentLi || parentLi.tagName !== 'LI') {
          exec('outdent');
          changed();
          return true;
        }
        var trailing = [];
        while (li.nextSibling) {
          trailing.push(li.nextSibling);
          li.parentNode.removeChild(li.nextSibling);
        }
        if (trailing.length) {
          var carry = doc.createElement(list.tagName);
          trailing.forEach(function (n) { carry.appendChild(n); });
          li.appendChild(carry);
        }
        parentLi.parentNode.insertBefore(li, parentLi.nextSibling);
        if (!list.children.length) {
          list.remove();
        }
      }

      if (caret && root.contains(caret.node)) {
        var nr = doc.createRange();
        nr.setStart(caret.node, Math.min(caret.offset, caret.node.nodeType === 3 ? caret.node.length : caret.node.childNodes.length));
        nr.collapse(true);
        selectRange(nr);
      } else {
        placeCaret(li, true);
      }
      changed();
      return true;
    }

    function exitBlock() {
      var n = caretNode();
      if (!n) {
        return;
      }
      var top = n;
      while (top.parentNode && top.parentNode !== root) {
        top = top.parentNode;
      }
      var p = doc.createElement('p');
      p.innerHTML = '<br>';
      root.insertBefore(p, top.nextSibling);
      placeCaret(p, false);
      changed();
    }

    function clearFormatting() {
      exec('removeFormat');
      exec('unlink');
      var block = currentBlock();
      if (block && /^(H[1-6]|PRE|BLOCKQUOTE)$/.test(block.tagName)) {
        formatBlock('p');
      }
      changed();
    }

    var commands = {
      bold: function () { exec('bold'); changed(); },
      italic: function () { exec('italic'); changed(); },
      strike: function () { exec('strikeThrough'); changed(); },
      code: toggleInlineCode,
      heading: function (level) {
        var block = currentBlock();
        var tag = 'h' + level;
        if (block && block.tagName.toLowerCase() === tag) {
          tag = 'p';
        }
        formatBlock(tag);
      },
      paragraph: function () { formatBlock('p'); },
      quote: toggleQuote,
      codeBlock: function () { insertCodeBlock(''); },
      ul: function () { makeList('ul'); },
      ol: function () { makeList('ol'); },
      task: function () { toggleTask(false); },
      link: openLinkDialog,
      image: openImageDialog,
      table: function () { insertTable(3, 3); },
      hr: function () { exec('insertHorizontalRule'); ensureTrailingParagraph(); changed(); },
      undo: function () { exec('undo'); changed(); },
      redo: function () { exec('redo'); changed(); },
      clear: clearFormatting,
      indent: function () { indentList(1); },
      outdent: function () { indentList(-1); },
      exitBlock: exitBlock
    };

    function run(cmd, arg) {
      if (!enabled || !commands[cmd]) {
        return;
      }
      if (doc.activeElement !== root && !root.contains(doc.activeElement)) {
        root.focus();
        if (savedRange) {
          selectRange(savedRange);
        }
      }
      commands[cmd](arg);
    }

    /* ---------------------------------------------------------------- *
     * Markdown shortcuts while typing
     * ---------------------------------------------------------------- */

    function deleteMarker(block) {
      var r = range();
      var d = doc.createRange();
      d.setStart(block, 0);
      d.setEnd(r.startContainer, r.startOffset);
      selectRange(d);
      exec('delete');
    }

    function spaceRule() {
      var block = currentBlock();
      var r = range();
      if (!block || !r || !r.collapsed || closest('pre')) {
        return false;
      }
      var tag = block.tagName;
      if (tag !== 'P' && tag !== 'DIV' && tag !== 'LI') {
        return false;
      }
      var before = textBefore(block);
      var m;
      if (tag !== 'LI') {
        if ((m = /^(#{1,6})$/.exec(before))) {
          deleteMarker(block);
          formatBlock('h' + m[1].length);
          return true;
        }
        if (/^[-*+]$/.test(before)) {
          deleteMarker(block);
          makeList('ul');
          return true;
        }
        if (/^1\.$/.test(before)) {
          deleteMarker(block);
          makeList('ol');
          return true;
        }
        if (/^>$/.test(before)) {
          deleteMarker(block);
          makeQuote();
          return true;
        }
      }
      if ((m = /^(?:[-*+] )?\[([ xX])\]$/.exec(before))) {
        deleteMarker(block);
        if (tag !== 'LI') {
          makeList('ul');
        }
        toggleTask(m[1] !== ' ');
        return true;
      }
      return false;
    }

    function enterRule() {
      var block = currentBlock();
      var r = range();
      if (!block || block.tagName !== 'P' || !r || !r.collapsed) {
        return false;
      }
      if (textAfter(block).trim()) {
        return false;
      }
      var before = textBefore(block);
      var m;
      if ((m = /^```[ \t]*([\w+#.-]*)$/.exec(before))) {
        deleteMarker(block);
        insertCodeBlock(m[1]);
        return true;
      }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(before)) {
        deleteMarker(block);
        exec('insertHorizontalRule');
        ensureTrailingParagraph();
        changed();
        return true;
      }
      return false;
    }

    /* ---------------------------------------------------------------- *
     * Events
     * ---------------------------------------------------------------- */

    function onKeydown(e) {
      var mod = e.metaKey || e.ctrlKey;
      var key = e.key;

      if (key === 'Enter') {
        if (mod) {
          e.preventDefault();
          exitBlock();
          return;
        }
        if (closest('pre')) {
          // insertLineBreak would add a <br> and insertHTML drops a lone
          // newline next to existing whitespace, so insert the text node
          // directly and put the caret after it.
          e.preventDefault();
          insertPlainTextInPre('\n');
          return;
        }
        if (e.shiftKey) {
          return; // native line break
        }
        if (enterRule()) {
          e.preventDefault();
          return;
        }
        var li = closest('li');
        if (li && isTaskItem(li)) {
          e.preventDefault();
          if (li.textContent.trim() === '') {
            removeCheckbox(li);     // empty task item: Enter leaves the list
            exec('insertParagraph');
          } else {
            exec('insertParagraph'); // new item gets its own checkbox
            var nli = closest('li');
            if (nli && !isTaskItem(nli)) {
              exec('insertHTML', '<input type="checkbox"> ');
            }
          }
          changed();
          return;
        }
        var block = currentBlock();
        var quote = closest('blockquote');
        if (block && block.tagName === 'P' && isEmptyBlock(block) && quote && block.parentNode === quote) {
          e.preventDefault();
          var copy = quote.cloneNode(true);
          var idx = Array.prototype.indexOf.call(quote.children, block);
          copy.children[idx].remove();
          replaceNodeWithHtml(quote, (copy.children.length ? copy.outerHTML : '') + '<p data-mdv-new="1"><br></p>');
          var np = takeNew('p');
          if (np) {
            placeCaret(np, false);
          }
          changed();
        }
        return;
      }

      if (key === 'Tab') {
        if (moveCell(e.shiftKey ? -1 : 1)) {
          e.preventDefault();
          return;
        }
        if (closest('li')) {
          e.preventDefault();
          indentList(e.shiftKey ? -1 : 1);
          return;
        }
        if (closest('pre')) {
          e.preventDefault();
          exec('insertText', '  ');
          changed();
        }
        return;
      }

      if (key === ' ' && !mod && !e.altKey) {
        if (spaceRule()) {
          e.preventDefault();
        }
        return;
      }

      if (key === 'Escape') {
        hideTableTools();
        return;
      }

      if (e.altKey && !mod && e.code === 'KeyT') {
        if (focusTableTools()) {
          e.preventDefault();
        }
        return;
      }

      if (!mod) {
        return;
      }

      var handled = true;
      var lower = key.toLowerCase();
      if (e.altKey && /^Digit[0-6]$/.test(e.code)) {
        var level = Number(e.code.slice(5));
        if (level === 0) {
          commands.paragraph();
        } else {
          commands.heading(level);
        }
      } else if (e.altKey && e.code === 'KeyC') {
        commands.codeBlock();
      } else if (e.shiftKey && e.code === 'KeyX') {
        commands.strike();
      } else if (e.shiftKey && e.code === 'KeyK') {
        commands.image();
      } else if (e.shiftKey && e.code === 'Digit7') {
        commands.ol();
      } else if (e.shiftKey && e.code === 'Digit8') {
        commands.ul();
      } else if (e.shiftKey && e.code === 'Digit9') {
        commands.task();
      } else if (e.shiftKey && e.code === 'Period') {
        commands.quote();
      } else if (!e.shiftKey && !e.altKey && lower === 'e') {
        commands.code();
      } else if (!e.shiftKey && !e.altKey && lower === 'k') {
        commands.link();
      } else if (!e.shiftKey && !e.altKey && lower === 'b') {
        commands.bold();
      } else if (!e.shiftKey && !e.altKey && lower === 'i') {
        commands.italic();
      } else if (!e.shiftKey && !e.altKey && lower === 'u') {
        // underline has no Markdown form; swallow the shortcut
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
      }
    }

    function onPaste(e) {
      var data = e.clipboardData;
      if (!data) {
        return;
      }
      var html = data.getData('text/html');
      var text = data.getData('text/plain');
      if (closest('pre')) {
        if (!text) {
          return;
        }
        e.preventDefault();
        insertPlainTextInPre(text);
      } else if (!html) {
        if (!text) {
          return;
        }
        e.preventDefault();
        exec('insertText', text);
      } else {
        e.preventDefault();
        exec('insertHTML', sanitize(html));
      }
      changed();
    }

    function onInput() {
      ensureTrailingParagraph();
      changed();
    }

    function onClick(e) {
      var t = e.target;
      if (t && t.nodeName === 'INPUT' && t.type === 'checkbox') {
        if (t.checked) {
          t.setAttribute('checked', '');
        } else {
          t.removeAttribute('checked');
        }
        // keep typing in the editor rather than on the checkbox
        var r = doc.createRange();
        r.setStartAfter(t);
        r.collapse(true);
        root.focus();
        selectRange(r);
        changed();
      }
    }

    /* ---------------------------------------------------------------- *
     * Toolbar state and table tools
     * ---------------------------------------------------------------- */

    function scheduleToolbar() {
      if (!enabled || toolbarFrame) {
        return;
      }
      toolbarFrame = global.requestAnimationFrame(function () {
        toolbarFrame = 0;
        refreshToolbar();
      });
    }

    function pressed(key, state) {
      var b = buttons[key];
      if (b) {
        b.setAttribute('aria-pressed', state ? 'true' : 'false');
      }
    }

    function queryState(cmd) {
      try {
        return doc.queryCommandState(cmd);
      } catch (err) {
        return false;
      }
    }

    function refreshToolbar() {
      var active = !!caretNode();
      var block = active ? currentBlock() : null;
      var li = active ? closest('li') : null;
      var first = li ? firstContent(li) : null;
      // queryCommandState('bold') is also true inside 600-weight headings
      pressed('bold', active && !!closest('strong, b'));
      pressed('italic', active && !!closest('em, i'));
      pressed('strike', active && !!closest('del, s, strike'));
      pressed('code', active && !!closest('code') && !closest('pre'));
      pressed('ul', active && queryState('insertUnorderedList') && !(first && first.nodeName === 'INPUT'));
      pressed('ol', active && queryState('insertOrderedList'));
      pressed('task', !!(first && first.nodeName === 'INPUT'));
      pressed('quote', active && !!closest('blockquote'));
      pressed('codeBlock', active && !!closest('pre'));
      for (var i = 1; i <= 3; i++) {
        pressed('heading' + i, !!block && block.tagName === 'H' + i);
      }
      pressed('paragraph', !!block && block.tagName === 'P');
      updateTableTools();
    }

    function buildTableTools() {
      var box = doc.createElement('div');
      box.className = 'mdv-table-tools';
      box.setAttribute('role', 'toolbar');
      box.setAttribute('aria-label', 'Table tools');
      box.setAttribute('aria-keyshortcuts', 'Alt+T');
      box.title = 'Table tools (' + ALT + 'T)';
      box.setAttribute('data-mdv-ui', '');
      box.setAttribute('contenteditable', 'false');
      TABLE_TOOLS.forEach(function (t, i) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.textContent = t[1];
        b.tabIndex = i === 0 ? 0 : -1;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { tableOp(t[0]); });
        box.appendChild(b);
      });
      box.addEventListener('keydown', function (e) {
        var buttons = Array.prototype.slice.call(box.querySelectorAll('button'));
        var i = buttons.indexOf(doc.activeElement);
        var next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          next = (i + 1) % buttons.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          next = (i - 1 + buttons.length) % buttons.length;
        } else if (e.key === 'Home') {
          next = 0;
        } else if (e.key === 'End') {
          next = buttons.length - 1;
        } else if (e.key === 'Tab' && e.shiftKey) {
          e.preventDefault(); // backwards: on to the formatting toolbar
          toolsReturnRange = null;
          var tb = toolbar.querySelector('button[tabindex="0"]') || toolbar.querySelector('button');
          if (tb) {
            tb.focus();
          }
          return;
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          leaveTableTools();
          return;
        }
        if (next >= 0) {
          e.preventDefault();
          buttons.forEach(function (b) { b.tabIndex = -1; });
          buttons[next].tabIndex = 0;
          buttons[next].focus();
        }
      });
      return box;
    }

    // Alt+T with the caret in a table: move focus into the strip.
    function focusTableTools() {
      var r = range();
      if (!closest('table') || !r) {
        return false;
      }
      toolsReturnRange = r.cloneRange();
      updateTableTools();
      if (!tableTools || !tableTools.parentNode) {
        return false;
      }
      var buttons = tableTools.querySelectorAll('button');
      buttons.forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
      buttons[0].focus();
      return true;
    }

    // Escape or Tab inside the strip: caret goes back where it was.
    function leaveTableTools() {
      root.focus({ preventScroll: true });
      if (toolsReturnRange) {
        var n = toolsReturnRange.startContainer;
        var cell = n && (n.nodeType === 1 ? n : n.parentNode);
        cell = cell && cell.closest ? cell.closest('td, th') : null;
        if (cell && inside(cell)) {
          selectRange(toolsReturnRange);
        }
      }
      toolsReturnRange = null;
      scheduleToolbar();
    }

    function updateTableTools() {
      var table = enabled ? closest('table') : null;
      if (!table) {
        hideTableTools();
        return;
      }
      if (!tableTools) {
        tableTools = buildTableTools();
      }
      if (!tableTools.parentNode) {
        container.appendChild(tableTools);
      }
      var tr = table.getBoundingClientRect();
      var cr = container.getBoundingClientRect();
      var w = tableTools.offsetWidth;
      var h = tableTools.offsetHeight;
      var gap = 8;
      var left;
      var top;
      // Prefer the free space beside a narrow table, so nothing is covered.
      if (tr.right + gap + w <= cr.right - gap) {
        left = tr.right - cr.left + gap;
        top = tr.top - cr.top;
      } else {
        // Otherwise above the table if the element before it leaves room,
        // else below it.
        left = Math.max(0, tr.left - cr.left);
        var prev = table.previousElementSibling;
        var roomAbove = prev ? tr.top - prev.getBoundingClientRect().bottom : tr.top - cr.top;
        top = roomAbove >= h + gap
          ? tr.top - cr.top - h - gap / 2
          : tr.bottom - cr.top + gap / 2;
      }
      tableTools.style.left = left + 'px';
      tableTools.style.top = top + 'px';
    }

    function hideTableTools() {
      if (tableTools && tableTools.parentNode) {
        if (tableTools.contains(doc.activeElement)) {
          leaveTableTools();
        }
        tableTools.parentNode.removeChild(tableTools);
      }
    }

    /* ---------------------------------------------------------------- *
     * Dialogs (link, image)
     * ---------------------------------------------------------------- */

    function closeDialog() {
      if (dialog) {
        var d = dialog;
        dialog = null;
        if (d.open) {
          d.close();
        }
        if (d.parentNode) {
          d.parentNode.removeChild(d);
        }
      }
    }

    function restoreSelection() {
      root.focus();
      if (savedRange) {
        try { selectRange(savedRange); } catch (err) { /* node may be gone */ }
      }
    }

    function openDialog(spec) {
      closeDialog();
      var r = range();
      savedRange = r ? r.cloneRange() : null;

      var form = doc.createElement('form');
      form.className = 'mdv-popover';
      form.setAttribute('role', 'dialog');
      form.setAttribute('aria-label', spec.title);
      form.setAttribute('data-mdv-ui', '');

      var title = doc.createElement('div');
      title.className = 'mdv-popover-title';
      title.textContent = spec.title;
      form.appendChild(title);

      var inputs = {};
      spec.fields.forEach(function (f) {
        var label = doc.createElement('label');
        label.textContent = f.label;
        var input = doc.createElement('input');
        input.type = 'text';
        input.name = f.name;
        input.value = f.value || '';
        input.placeholder = f.placeholder || '';
        input.autocomplete = 'off';
        input.spellcheck = false;
        label.appendChild(input);
        form.appendChild(label);
        inputs[f.name] = input;
      });

      var error = doc.createElement('div');
      error.className = 'mdv-popover-error';
      error.setAttribute('aria-live', 'polite');
      form.appendChild(error);

      var actions = doc.createElement('div');
      actions.className = 'mdv-popover-actions';
      var ok = doc.createElement('button');
      ok.type = 'submit';
      ok.textContent = spec.submitLabel || 'Insert';
      var cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { closeDialog(); restoreSelection(); });
      actions.appendChild(ok);
      actions.appendChild(cancel);
      if (spec.extra) {
        var spacer = doc.createElement('span');
        spacer.className = 'mdv-spacer';
        actions.appendChild(spacer);
        var extra = doc.createElement('button');
        extra.type = 'button';
        extra.textContent = spec.extra.label;
        extra.addEventListener('click', function () {
          closeDialog();
          restoreSelection();
          spec.extra.onClick();
        });
        actions.appendChild(extra);
      }
      form.appendChild(actions);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var values = {};
        Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value.trim(); });
        var problem = spec.validate ? spec.validate(values) : '';
        if (problem) {
          error.textContent = problem;
          return;
        }
        closeDialog();
        restoreSelection();
        spec.onSubmit(values);
      });

      var modal = doc.createElement('dialog');
      modal.className = 'mdv-dialog';
      modal.setAttribute('aria-label', spec.title);
      modal.setAttribute('data-mdv-ui', '');
      modal.addEventListener('mousedown', function (e) {
        if (e.target === modal) { // the backdrop
          e.preventDefault();
          closeDialog();
          restoreSelection();
        }
      });
      modal.addEventListener('cancel', function (e) { // Escape
        e.preventDefault();
        closeDialog();
        restoreSelection();
      });
      modal.appendChild(form);
      overlay.appendChild(modal);
      dialog = modal;
      modal.showModal();
      var firstInput = form.querySelector('input');
      if (firstInput) {
        firstInput.focus();
        firstInput.select();
      }
    }

    function openLinkDialog() {
      var a = closest('a');
      var r = range();
      var selected = r && !r.collapsed ? r.toString() : '';
      var fields = [{ name: 'url', label: 'URL or path', value: a ? a.getAttribute('href') || '' : '', placeholder: 'https://example.com or ./notes.md' }];
      if (!a && !selected) {
        fields.unshift({ name: 'text', label: 'Text', value: '', placeholder: 'Link text' });
      }
      openDialog({
        title: a ? 'Edit link' : 'Insert link',
        submitLabel: a ? 'Update' : 'Insert',
        fields: fields,
        validate: function (v) {
          if (!v.url) return 'Enter a URL or a path.';
          if (!isSafeUrl(v.url)) return 'Only http(s), mailto, tel, file and relative links are allowed.';
          if (fields[0].name === 'text' && !v.text) return 'Enter the link text.';
          return '';
        },
        extra: a ? { label: 'Remove link', onClick: function () { exec('unlink'); changed(); } } : null,
        onSubmit: function (v) {
          if (a) {
            a.setAttribute('href', v.url);
          } else if (selected) {
            exec('createLink', v.url);
          } else {
            exec('insertHTML', '<a href="' + escapeHtml(v.url) + '">' + escapeHtml(v.text) + '</a>');
          }
          changed();
        }
      });
    }

    function openImageDialog() {
      openDialog({
        title: 'Insert image',
        fields: [
          { name: 'src', label: 'Image path or URL', placeholder: './images/photo.png' },
          { name: 'alt', label: 'Description (alt text)', placeholder: 'What the image shows' }
        ],
        validate: function (v) {
          if (!v.src) return 'Enter an image path or URL.';
          if (!isSafeUrl(v.src)) return 'That URL scheme is not allowed.';
          return '';
        },
        onSubmit: function (v) {
          exec('insertHTML', '<img src="' + escapeHtml(v.src) + '" alt="' + escapeHtml(v.alt) + '">');
          changed();
        }
      });
    }

    /* ---------------------------------------------------------------- *
     * Enable / disable
     * ---------------------------------------------------------------- */

    function enable() {
      if (enabled) {
        return;
      }
      enabled = true;
      root.setAttribute('contenteditable', 'true');
      // Chrome's "enhanced" spell check sends text to Google; off unless asked
      root.setAttribute('spellcheck', options.spellcheck && options.spellcheck() ? 'true' : 'false');
      root.classList.add('mdv-editing');
      root.querySelectorAll('.mdv-anchor').forEach(function (a) { a.remove(); });
      root.querySelectorAll('input[type="checkbox"]').forEach(function (i) { i.removeAttribute('disabled'); });
      if (!root.firstElementChild) {
        root.innerHTML = '<p><br></p>';
      }
      ensureTrailingParagraph();
      try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (err) { /* older engines */ }
      root.addEventListener('keydown', onKeydown);
      root.addEventListener('paste', onPaste);
      root.addEventListener('input', onInput);
      root.addEventListener('click', onClick);
      doc.addEventListener('selectionchange', scheduleToolbar);
      container.appendChild(live);
      toolbar.hidden = false;
      refreshToolbar();
    }

    function disable() {
      if (!enabled) {
        return;
      }
      enabled = false;
      closeDialog();
      hideTableTools();
      toolsReturnRange = null;
      live.textContent = '';
      if (live.parentNode) {
        live.parentNode.removeChild(live);
      }
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('input', onInput);
      root.removeEventListener('click', onClick);
      doc.removeEventListener('selectionchange', scheduleToolbar);
      root.removeAttribute('contenteditable');
      root.removeAttribute('spellcheck');
      root.classList.remove('mdv-editing');
      root.querySelectorAll('input[type="checkbox"]').forEach(function (i) { i.setAttribute('disabled', ''); });
      toolbar.hidden = true;
    }

    return {
      toolbar: toolbar,
      enable: enable,
      disable: disable,
      run: run,
      setSpellcheck: function (on) {
        if (enabled) {
          root.setAttribute('spellcheck', on ? 'true' : 'false');
        }
      },
      focus: function () { root.focus(); },
      isEnabled: function () { return enabled; }
    };
  }

  api.createEditor = createEditor;
  api.editorShortcuts = { MOD: MOD, ALT: ALT, SHIFT: SHIFT };
})(typeof globalThis !== 'undefined' ? globalThis : window);
