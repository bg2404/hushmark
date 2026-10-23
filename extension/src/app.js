/*
 * Local Markdown Viewer — app.js
 *
 * Builds the app shell: top bar with Read / Edit / Source modes, the
 * formatting toolbar, an outline panel, the content stage (which scrolls on
 * its own), the resizable source/preview split, the status bar, the settings
 * drawer with theme swatches, and the dialogs. Owns the document text and
 * the save flow.
 *
 * Text handling rule: the file's text is only rewritten from the editor's
 * DOM when something was actually changed in Edit mode (and not undone), so
 * opening a file and saving it untouched never reformats it. Front matter is
 * kept byte for byte and can be changed in Source mode.
 */
(function (global) {
  'use strict';

  var api = global.LocalMarkdownViewer;
  if (!api || !api.prefs || !api.createEditor || !api.toMarkdown || !api.fileAccess || !api.icon) {
    return;
  }
  var doc = global.document;
  var prefs = api.prefs;
  var MOD = (api.editorShortcuts && api.editorShortcuts.MOD) || 'Ctrl+';
  var narrow = global.matchMedia('(max-width: 900px)');
  var numbers = new Intl.NumberFormat();

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick, title) {
    var b = el('button', cls);
    b.type = 'button';
    if (typeof label === 'string') {
      b.textContent = label;
    } else if (label) {
      b.appendChild(label);
    }
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title);
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(iconName, title, onClick) {
    return button(api.icon(iconName), 'mdv-icon-btn', onClick, title);
  }

  function labelled(iconName, text) {
    var frag = doc.createDocumentFragment();
    frag.appendChild(api.icon(iconName));
    frag.appendChild(el('span', 'mdv-label', text));
    return frag;
  }

  function debounce(fn, ms) {
    var timer = 0;
    return function () {
      global.clearTimeout(timer);
      timer = global.setTimeout(fn, ms);
    };
  }

  function clockTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // The heading the reader is "at": the last one whose top is at or above
  // the scroller's top edge, else nothing (top of the document).
  function currentHeading(container, scroller) {
    var top = scroller.getBoundingClientRect().top + 8;
    var headings = container.querySelectorAll('h1, h2, h3, h4');
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= top) {
        current = headings[i];
      } else {
        break;
      }
    }
    return current;
  }

  function headingText(h) {
    return h.textContent.replace(/^#\s*/, '').trim();
  }

  function mount(opts) {
    var pre = opts.pre;
    var fileName = opts.fileName;
    var state = {
      mode: 'read',
      text: opts.text,        // current Markdown, including front matter
      original: opts.text,    // what is on disk (as far as we know)
      loaded: opts.text,      // what this page read from the file:// URL
      richDirty: false,       // Edit-mode DOM would convert to different Markdown
      cleanMarkdown: '',      // what the Edit-mode DOM converted to right after rendering
      title: ''
    };
    var frontMatter = api.extractFrontMatter(state.text);
    var saving = false;
    var autosaveSuspended = false;

    /* ------------------------------------------------------------ DOM */

    var root = el('div', 'mdv-root');

    var top = el('header', 'mdv-top');
    var fileBox = el('div', 'mdv-file');
    var nameEl = el('span', 'mdv-filename', fileName);
    nameEl.title = fileName;
    var dirtyDot = el('span', 'mdv-dirty-dot');
    dirtyDot.title = 'Unsaved changes';
    dirtyDot.hidden = true;
    fileBox.append(api.icon('file'), nameEl, dirtyDot);

    var modes = el('div', 'mdv-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Mode');
    var modeButtons = {};
    [['read', 'Read', 'read'], ['edit', 'Edit', 'edit'], ['source', 'Source', 'source']].forEach(function (m) {
      var b = button(labelled(m[2], m[1]), 'mdv-mode', function () { setMode(m[0]); }, m[1] + ' mode');
      b.dataset.mode = m[0];
      b.setAttribute('aria-pressed', 'false');
      modeButtons[m[0]] = b;
      modes.appendChild(b);
    });

    var actions = el('div', 'mdv-actions');
    var tocBtn = iconButton('outline', 'Outline', function () { prefs.set({ toc: !prefs.get().toc }); });
    tocBtn.classList.add('mdv-toc-toggle');
    tocBtn.setAttribute('aria-pressed', 'false');
    var saveBtn = button(labelled('save', 'Save'), 'mdv-save', function () { save(); }, 'Save (' + MOD + 'S)');
    var settingsBtn = iconButton('settings', 'Settings', function () { toggleSettings(); });
    settingsBtn.classList.add('mdv-settings-toggle');
    settingsBtn.setAttribute('aria-expanded', 'false');
    actions.append(tocBtn, saveBtn, settingsBtn);
    top.append(fileBox, modes, actions);

    var main = el('div', 'mdv-main');
    var toc = el('aside', 'mdv-toc');
    toc.setAttribute('aria-label', 'Outline');
    toc.hidden = true;
    var stage = el('div', 'mdv-stage');
    stage.tabIndex = -1; // so Space / PageDown scroll it before any click
    var docWrap = el('div', 'mdv-doc');
    var fmNote = el('details', 'mdv-fm-note');
    fmNote.hidden = true;
    var content = el('main', 'mdv-content');
    docWrap.append(fmNote, content);
    stage.appendChild(docWrap);

    var split = el('div', 'mdv-split');
    split.hidden = true;
    var textarea = el('textarea', 'mdv-source');
    textarea.spellcheck = false;
    textarea.id = 'mdv-source-' + Math.floor(Math.random() * 1e9);
    textarea.setAttribute('aria-label', 'Markdown source');
    var divider = el('div', 'mdv-divider');
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'Resize source and preview');
    divider.setAttribute('aria-controls', textarea.id);
    divider.setAttribute('aria-valuemin', '25');
    divider.setAttribute('aria-valuemax', '75');
    divider.tabIndex = 0;
    var previewScroll = el('div', 'mdv-preview-scroll');
    var previewDoc = el('div', 'mdv-doc');
    var preview = el('div', 'mdv-content mdv-preview');
    preview.setAttribute('aria-label', 'Preview');
    previewDoc.appendChild(preview);
    previewScroll.appendChild(previewDoc);
    split.append(textarea, divider, previewScroll);
    main.append(toc, stage, split);

    var footer = el('footer', 'mdv-status');
    var wordsEl = el('span', 'mdv-words');
    var hintEl = el('span', 'mdv-hint');
    var stateEl = el('span', 'mdv-save-state');
    stateEl.setAttribute('aria-live', 'polite');
    footer.append(wordsEl, hintEl, stateEl);

    var scrim = el('div', 'mdv-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', function () { closeOverlays(); });
    var settings = buildSettings();

    var editor = api.createEditor({
      element: content,
      container: docWrap,
      overlay: root,
      onChange: onRichChange,
      isSafeUrl: api.isSafeUrl,
      sanitize: api.sanitizeHtml,
      spellcheck: function () { return prefs.get().spellcheck; }
    });
    editor.toolbar.hidden = true;

    root.append(top, editor.toolbar, main, footer, scrim, settings, pre);
    pre.hidden = true;

    /* ------------------------------------------------------ rendering */

    function renderInto(target, text, withFrontMatter) {
      target.innerHTML = api.toHtml(text, { frontMatter: withFrontMatter });
      return api.addHeadingAnchors(target).title;
    }

    function renderRead() {
      if (!state.text.trim()) {
        var empty = el('div', 'mdv-empty');
        empty.setAttribute('data-mdv-ui', '');
        empty.append(el('p', null, 'This file is empty.'), button('Start writing', 'mdv-text-btn', function () { setMode('edit'); }));
        content.replaceChildren(empty);
        state.title = '';
        return;
      }
      state.title = renderInto(content, state.text, true);
    }

    function renderEdit() {
      frontMatter = api.extractFrontMatter(state.text);
      state.title = renderInto(content, frontMatter.body, false);
      if (frontMatter.block) {
        var lines = frontMatter.raw.split('\n').length;
        var summary = el('summary', null, 'Front matter · ' + lines + (lines === 1 ? ' line' : ' lines') + ' · kept as is, edit it in Source mode');
        fmNote.replaceChildren(summary, el('pre', null, frontMatter.raw));
        fmNote.open = false;
        fmNote.hidden = false;
      } else {
        fmNote.hidden = true;
      }
    }

    var renderPreview = function () {
      renderInto(preview, state.text, true);
      refreshToc();
    };
    var renderPreviewSoon = debounce(renderPreview, 150);

    /* ---------------------------------------------------------- modes */

    function commitRich() {
      if (state.mode !== 'edit') {
        return;
      }
      var markdown = api.toMarkdown(content);
      if (markdown !== state.cleanMarkdown) {
        state.text = frontMatter.block + markdown;
        state.cleanMarkdown = markdown;
      }
      state.richDirty = false;
    }

    function currentText() {
      if (state.mode === 'edit') {
        commitRich();
      } else if (state.mode === 'source') {
        state.text = textarea.value;
      }
      return state.text;
    }

    function scrollStageTo(id) {
      var target = id && content.querySelector('#' + CSS.escape(id));
      if (target) {
        target.scrollIntoView({ block: 'start' });
      } else {
        stage.scrollTop = 0;
      }
    }

    function setMode(mode) {
      if (mode === state.mode) {
        if (mode === 'edit') editor.focus();
        return;
      }
      // remember where the reader is
      var from = state.mode;
      var placeId = null;
      var placeText = '';
      var h = from === 'source' ? currentHeading(preview, previewScroll) : currentHeading(content, stage);
      if (h) {
        placeId = h.id;
        placeText = headingText(h);
      }

      currentText();
      if (from === 'edit') {
        editor.disable();
        fmNote.hidden = true;
      }
      state.mode = mode;
      stage.hidden = mode === 'source';
      split.hidden = mode !== 'source';
      if (mode === 'read') {
        renderRead();
        scrollStageTo(placeId);
        stage.focus({ preventScroll: true });
      } else if (mode === 'edit') {
        renderEdit();
        editor.enable();
        state.cleanMarkdown = api.toMarkdown(content);
        state.richDirty = false;
        scrollStageTo(placeId);
        editor.focus();
      } else {
        content.replaceChildren(); // so #fragment links resolve in the preview
        textarea.value = state.text;
        renderPreview();
        var at = placeText ? state.text.indexOf(placeText) : 0;
        if (at < 0) at = 0;
        textarea.setSelectionRange(at, at);
        textarea.focus({ preventScroll: true });
        var line = state.text.slice(0, at).split('\n').length - 1;
        textarea.scrollTop = line * (parseFloat(getComputedStyle(textarea).lineHeight) || 22);
      }
      Object.keys(modeButtons).forEach(function (k) {
        modeButtons[k].setAttribute('aria-pressed', String(k === mode));
      });
      doc.documentElement.setAttribute('data-mdv', mode === 'read' ? 'rendered' : mode);
      refreshHint();
      refreshAll();
    }

    function refreshHint() {
      if (state.mode === 'edit') {
        hintEl.textContent = 'Type "# ", "- ", "1. ", "> ", "```" or "[ ] " at the start of a line for quick formatting; in a table, ' + ((api.editorShortcuts && api.editorShortcuts.ALT) || 'Alt+') + 'T opens the table tools';
      } else if (state.mode === 'source') {
        hintEl.textContent = narrow.matches
          ? 'Markdown above, preview below; drag the bar to resize'
          : 'Raw Markdown on the left, live preview on the right; drag the divider to resize';
      } else {
        hintEl.textContent = '';
      }
    }

    /* ------------------------------------------------------- changes */

    function isDirty() {
      return state.richDirty || state.text !== state.original;
    }

    // Dirty until proven otherwise; the debounced check lets an undo back to
    // the rendered state count as unchanged.
    var recheckRich = debounce(function () {
      if (state.mode === 'edit') {
        state.richDirty = api.toMarkdown(content) !== state.cleanMarkdown;
        refreshDirty();
      }
    }, 150);

    function onRichChange() {
      state.richDirty = true;
      refreshDirty();
      recheckRich();
      refreshWordsSoon();
      refreshTocSoon();
      autosaveSoon();
    }

    textarea.addEventListener('input', function () {
      state.text = textarea.value;
      refreshDirty();
      refreshWordsSoon();
      renderPreviewSoon();
      autosaveSoon();
    });

    // keep the preview roughly in step with the source
    textarea.addEventListener('scroll', function () {
      var ratio = textarea.scrollTop / Math.max(1, textarea.scrollHeight - textarea.clientHeight);
      previewScroll.scrollTop = ratio * (previewScroll.scrollHeight - previewScroll.clientHeight);
    }, { passive: true });

    function refreshDirty() {
      var dirty = isDirty();
      saveBtn.classList.toggle('mdv-dirty', dirty);
      dirtyDot.hidden = !dirty;
      doc.title = (dirty ? '● ' : '') + (state.title ? state.title + ' · ' : '') + fileName;
    }

    global.addEventListener('beforeunload', function (e) {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    /* --------------------------------------------------------- saving */

    function setStatus(text, kind, detail) {
      stateEl.textContent = text;
      stateEl.title = detail ? text + '\n' + detail : text;
      stateEl.classList.toggle('mdv-error', kind === 'error');
      stateEl.classList.toggle('mdv-ok', kind === 'ok');
    }

    function downloadCopy(text) {
      var blob = new Blob([text], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url;
      a.download = fileName;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function save(options) {
      options = options || {};
      if (saving) {
        if (options.auto) autosaveSoon(); // try again after the current write
        return Promise.resolve();
      }
      var text = currentText();
      if (!api.fileAccess.supported) {
        if (options.auto) {
          return Promise.resolve();
        }
        downloadCopy(text);
        setStatus('This browser cannot write files directly, so a copy was downloaded instead.', 'error');
        return Promise.resolve();
      }
      saving = true;
      saveBtn.disabled = true;
      setStatus('Saving…');
      return api.fileAccess.save(text, fileName, {
        expectedText: state.loaded,
        beforePicker: function () {
          setStatus('In the dialog, choose ' + fileName + ' itself to save in place. It opens in your last-used folder, not next to the file.');
        }
      }).then(function (result) {
        if (result && result.elsewhere) {
          setStatus('Saved a copy as ' + result.name + '. ' + fileName + ' was not changed, so the document is still unsaved.', 'error');
          return;
        }
        state.original = text;
        state.loaded = text;
        autosaveSuspended = false;
        setStatus('Saved ' + clockTime() + (result && result.picked ? ' through the save dialog' : ''), 'ok');
      }, function (err) {
        var name = (err && err.name) || 'error';
        if (name === 'AbortError') {
          setStatus('Save cancelled');
        } else if (name === 'PermissionDeniedError') {
          setStatus('Not saved: permission to write ' + fileName + ' was not granted. Use "Forget file access" in Settings to choose the file again.', 'error');
        } else if (options.auto) {
          autosaveSuspended = true;
          setStatus('Autosave failed; press ' + MOD + 'S to save.', 'error', name + (err && err.message ? ': ' + err.message : ''));
        } else {
          global.console.error('[Local Markdown Viewer] Save failed', err);
          downloadCopy(text);
          setStatus("Couldn't write to the file, so a copy was downloaded instead.", 'error', name + (err && err.message ? ': ' + err.message : ''));
        }
      }).then(function () {
        saving = false;
        saveBtn.disabled = false;
        refreshDirty();
        if (prefs.get().autosave && isDirty() && !autosaveSuspended) {
          autosaveSoon(); // text typed while the write was in flight
        }
      });
    }

    var autosaveSoon = debounce(function () {
      if (!prefs.get().autosave || !isDirty() || autosaveSuspended) {
        return;
      }
      if (saving) {
        autosaveSoon();
        return;
      }
      api.fileAccess.canSaveSilently().then(function (ok) {
        if (ok) {
          save({ auto: true });
        } else {
          setStatus('Autosave needs one manual save first (' + MOD + 'S)');
        }
      });
    }, 2000);

    doc.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape' && narrow.matches && !toc.hidden) {
        prefs.set({ toc: false });
        tocBtn.focus();
      }
    });

    /* ------------------------------------------------- outline, words */

    var tocLinks = [];

    function refreshToc() {
      var visible = prefs.get().toc;
      var wasHidden = toc.hidden;
      toc.hidden = !visible;
      tocBtn.setAttribute('aria-pressed', String(visible));
      updateScrim();
      if (!visible) {
        tocLinks = [];
        return;
      }
      var source = state.mode === 'source' ? preview : content;
      var list = el('ol');
      tocLinks = [];
      source.querySelectorAll('h1, h2, h3, h4').forEach(function (h) {
        var li = el('li', 'mdv-toc-' + h.tagName.toLowerCase());
        var label = headingText(h) || '(untitled)';
        var a = el('a', null, label);
        a.title = label;
        a.href = h.id ? '#' + h.id : '#';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          h.scrollIntoView({ block: 'start' });
          if (h.id) {
            global.history.replaceState(null, '', '#' + h.id);
          }
          if (narrow.matches) {
            prefs.set({ toc: false });
          }
        });
        li.appendChild(a);
        list.appendChild(li);
        tocLinks.push({ heading: h, link: a });
      });
      var title = el('h2', 'mdv-toc-title', 'Outline');
      title.appendChild(iconButton('close', 'Close outline', function () { prefs.set({ toc: false }); tocBtn.focus(); }));
      toc.replaceChildren(title, list.children.length ? list : el('p', 'mdv-toc-empty', 'No headings yet'));
      markCurrentSection();
      if (wasHidden && narrow.matches) {
        var first = toc.querySelector('a');
        if (first) first.focus();
      }
    }
    var refreshTocSoon = debounce(refreshToc, 300);

    function markCurrentSection() {
      if (!tocLinks.length) {
        return;
      }
      var scroller = state.mode === 'source' ? previewScroll : stage;
      var container = state.mode === 'source' ? preview : content;
      var current = currentHeading(container, scroller) || tocLinks[0].heading;
      tocLinks.forEach(function (item) {
        if (item.heading === current) {
          item.link.setAttribute('aria-current', 'location');
        } else {
          item.link.removeAttribute('aria-current');
        }
      });
    }
    var sectionFrame = 0;
    function scheduleSection() {
      if (sectionFrame) return;
      sectionFrame = global.requestAnimationFrame(function () {
        sectionFrame = 0;
        markCurrentSection();
      });
    }
    stage.addEventListener('scroll', scheduleSection, { passive: true });
    previewScroll.addEventListener('scroll', scheduleSection, { passive: true });

    function documentText() {
      if (!state.text.trim()) {
        return '';
      }
      var source = state.mode === 'source' ? preview : content;
      var text = source.innerText || '';
      var fm = source.querySelector('.mdv-frontmatter');
      if (fm && fm.innerText) {
        text = text.replace(fm.innerText, '');
      }
      return text.trim();
    }

    function refreshWords() {
      var text = documentText();
      var words = (text.match(/\S+/g) || []).length;
      var chars = text.length;
      var parts = [
        numbers.format(words) + (words === 1 ? ' word' : ' words'),
        numbers.format(chars) + (chars === 1 ? ' character' : ' characters')
      ];
      if (words) {
        parts.push((words < 200 ? '<1' : Math.round(words / 200)) + ' min read');
      }
      wordsEl.textContent = parts.join(' · ');
    }
    var refreshWordsSoon = debounce(refreshWords, 200);

    function refreshAll() {
      refreshDirty();
      refreshToc();
      refreshWords();
    }

    /* ----------------------------------------------- split divider */

    function applySplit(ratio) {
      if (narrow.matches) {
        split.style.gridTemplateColumns = '';
        split.style.gridTemplateRows = ratio + 'fr 8px ' + (1 - ratio) + 'fr';
      } else {
        split.style.gridTemplateRows = '';
        split.style.gridTemplateColumns = ratio + 'fr 8px ' + (1 - ratio) + 'fr';
      }
      divider.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
      divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }

    var dragging = false;
    divider.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      dragging = true;
      divider.classList.add('mdv-dragging');
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener('pointermove', function (e) {
      if (!dragging) {
        return;
      }
      var r = split.getBoundingClientRect();
      var ratio = narrow.matches ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      applySplit(Math.min(0.75, Math.max(0.25, ratio)));
    });
    function endDrag() {
      if (!dragging) {
        return;
      }
      dragging = false;
      divider.classList.remove('mdv-dragging');
      prefs.set({ splitRatio: Number(divider.getAttribute('aria-valuenow')) / 100 });
    }
    divider.addEventListener('pointerup', endDrag);
    divider.addEventListener('pointercancel', endDrag);
    divider.addEventListener('keydown', function (e) {
      var less = narrow.matches ? 'ArrowUp' : 'ArrowLeft';
      var more = narrow.matches ? 'ArrowDown' : 'ArrowRight';
      var step = e.key === less ? -0.05 : (e.key === more ? 0.05 : 0);
      if (!step) {
        return;
      }
      e.preventDefault();
      var ratio = Math.min(0.75, Math.max(0.25, prefs.get().splitRatio + step));
      applySplit(ratio);
      prefs.set({ splitRatio: ratio });
    });
    applySplit(prefs.get().splitRatio);
    narrow.addEventListener('change', function () {
      applySplit(prefs.get().splitRatio);
      refreshHint();
      updateScrim();
    });

    /* ------------------------------------------------------- settings */

    function buildSettings() {
      var panel = el('dialog', 'mdv-settings');
      panel.setAttribute('aria-label', 'Settings');
      var p = prefs.get();
      var controls = {};

      var head = el('div', 'mdv-settings-head');
      head.append(el('h2', null, 'Settings'), iconButton('close', 'Close settings', function () { toggleSettings(false); }));

      var grid = el('div', 'mdv-theme-grid');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Theme');
      var swatches = {};
      prefs.THEMES.forEach(function (t) {
        var b = el('button', 'mdv-theme-swatch');
        b.type = 'button';
        b.dataset.theme = t.id;
        b.setAttribute('aria-pressed', String(p.theme === t.id));
        var bar = el('span', 'mdv-swatch-bar');
        t.swatch.forEach(function (c) {
          var s = el('span');
          s.style.background = c;
          bar.appendChild(s);
        });
        b.append(bar, el('span', 'mdv-label', t.name));
        b.addEventListener('click', function () { prefs.set({ theme: t.id }); });
        swatches[t.id] = b;
        grid.appendChild(b);
      });

      function select(labelText, items, key) {
        var label = el('label', 'mdv-row');
        label.appendChild(el('span', null, labelText));
        var s = el('select');
        s.setAttribute('aria-label', labelText);
        items.forEach(function (item) {
          var o = el('option', null, item.name);
          o.value = item.id;
          s.appendChild(o);
        });
        s.value = p[key];
        s.addEventListener('change', function () {
          var patch = {};
          patch[key] = s.value;
          prefs.set(patch);
        });
        label.appendChild(s);
        controls[key] = s;
        return label;
      }

      var size = el('div', 'mdv-row');
      size.setAttribute('role', 'group');
      size.setAttribute('aria-label', 'Text size');
      size.appendChild(el('span', null, 'Text size'));
      var stepper = el('span', 'mdv-stepper');
      var minus = iconButton('minus', 'Smaller text', function () { prefs.set({ size: Math.max(prefs.SIZE_MIN, prefs.get().size - 1) }); });
      var sizeOut = el('output', null, p.size + 'px');
      var plus = iconButton('plus', 'Larger text', function () { prefs.set({ size: Math.min(prefs.SIZE_MAX, prefs.get().size + 1) }); });
      minus.disabled = p.size <= prefs.SIZE_MIN;
      plus.disabled = p.size >= prefs.SIZE_MAX;
      stepper.append(minus, sizeOut, plus);
      size.appendChild(stepper);

      function check(labelText, key) {
        var label = el('label', 'mdv-check');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.checked = p[key];
        cb.addEventListener('change', function () {
          var patch = {};
          patch[key] = cb.checked;
          prefs.set(patch);
        });
        label.append(cb, el('span', null, labelText));
        controls[key] = cb;
        return label;
      }

      var forget = button('Forget file access', 'mdv-text-btn', function () {
        api.fileAccess.forget().then(function () {
          setStatus('File access forgotten; the next save will ask for the file again');
        });
      }, 'Drop the stored permission to write this file');

      panel.append(
        head,
        el('h3', null, 'Theme'),
        grid,
        el('h3', null, 'Text'),
        select('Font', prefs.FONTS, 'font'),
        size,
        select('Width', prefs.WIDTHS, 'width'),
        el('h3', null, 'Editing'),
        check('Autosave 2 s after changes', 'autosave'),
        check("Spell check while editing (uses Chrome's spell checker)", 'spellcheck'),
        forget,
        el('p', 'mdv-settings-note', 'Settings are kept in this browser only and never leave your computer.')
      );

      panel.addEventListener('close', function () {
        settingsBtn.setAttribute('aria-expanded', 'false');
        settingsBtn.focus();
      });
      panel.addEventListener('mousedown', function (e) {
        if (e.target === panel) toggleSettings(false); // the backdrop
      });

      prefs.onChange(function (np) {
        Object.keys(controls).forEach(function (k) {
          if (controls[k].type === 'checkbox') controls[k].checked = np[k];
          else controls[k].value = np[k];
        });
        Object.keys(swatches).forEach(function (id) { swatches[id].setAttribute('aria-pressed', String(np.theme === id)); });
        sizeOut.textContent = np.size + 'px';
        minus.disabled = np.size <= prefs.SIZE_MIN;
        plus.disabled = np.size >= prefs.SIZE_MAX;
        editor.setSpellcheck(np.spellcheck);
        refreshToc();
      });
      return panel;
    }

    function updateScrim() {
      scrim.hidden = toc.hidden || !narrow.matches;
    }

    function toggleSettings(force) {
      var show = typeof force === 'boolean' ? force : !settings.open;
      if (show && !settings.open) {
        settings.showModal();
        settingsBtn.setAttribute('aria-expanded', 'true');
        var first = settings.querySelector('.mdv-theme-swatch[aria-pressed="true"]') || settings.querySelector('button');
        if (first) first.focus();
      } else if (!show && settings.open) {
        settings.close();
      }
    }

    function closeOverlays() {
      if (narrow.matches && !toc.hidden) {
        prefs.set({ toc: false });
        tocBtn.focus();
      }
    }

    /* ----------------------------------------------------------- start */

    prefs.apply();
    renderRead();
    modeButtons.read.setAttribute('aria-pressed', 'true');
    doc.documentElement.setAttribute('data-mdv', 'rendered');
    doc.body.appendChild(root);
    stage.focus({ preventScroll: true });
    refreshAll();
    setStatus(api.fileAccess.supported ? '' : 'Saving will download a copy (File System Access API unavailable)');

    return {
      setMode: setMode,
      save: save,
      getText: currentText,
      isDirty: isDirty
    };
  }

  api.mount = mount;
})(typeof globalThis !== 'undefined' ? globalThis : window);
