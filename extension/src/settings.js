/*
 * Hushmark — settings.js
 *
 * The Settings drawer: a native <dialog> with a fixed header, a scrolling
 * body of grouped cards, and (when the publisher set one) a support footer
 * pinned to the bottom.
 *
 *   Appearance  theme picker with live preview, font, text size, line width
 *   Editing     autosave, spell check
 *   Files and websites  other local files that look like Markdown, and
 *               Markdown files on websites
 *   Privacy     web images, remembered files, forget / reset
 *
 * Every control writes through prefs.set() and follows prefs.onChange(), so
 * a change made in another tab shows up here too. The theme picker previews
 * a theme while the pointer rests on it or the keyboard highlights it, and
 * goes back to the saved one unless the user picks it.
 *
 * Only the user's own input can change a setting. On a website the site's
 * scripts can reach this page's DOM (a page of the same origin can open the
 * file in a window and script it), so events made by scripts are stopped
 * before any control sees them. A site could still restyle the page to steer
 * a real click, so on websites the switches that affect privacy, editing or
 * local files are read-only here; they are changed in Hushmark's own
 * settings page (options.html), which no website can reach.
 *
 * The same drawer is that settings page: createSettings({ page: true }).
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }
  var doc = global.document;
  var uid = 0;

  // A hovered theme is shown only once the pointer rests on it, so sweeping
  // across the list does not flash the page between light and dark.
  var HOVER_PREVIEW_MS = 150;
  // Remembered files live in the storage of file:// pages, out of a website
  // tab's reach.
  var IS_LOCAL = global.location.protocol === 'file:';
  // A site that sandboxes its raw files (raw.githubusercontent.com does)
  // gives the page an opaque origin; Chrome then blocks new tabs from it.
  var SANDBOXED = !IS_LOCAL && global.origin === 'null';
  // anything but a local file or Hushmark's own page: websites, and also a
  // blob: page a site made itself and the toolbar button formatted
  var IS_WEB_PAGE = !IS_LOCAL && global.location.protocol !== 'chrome-extension:';
  // read-only on websites (see the top of this file)
  var LOCKED_ON_WEB = { autosave: true, spellcheck: true, anyFile: true, remoteImages: true, rememberFiles: true };

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Runs fn only for the user's own input, never for a script-made event.
  function trusted(fn) {
    return function (e) {
      if (e && e.isTrusted) {
        return fn.apply(this, arguments);
      }
    };
  }

  function nextId(prefix) {
    uid += 1;
    return 'mdv-' + prefix + '-' + uid;
  }

  function button(cls, text) {
    var b = el('button', cls, text);
    b.type = 'button';
    return b;
  }

  // An icon-only button. Its title is both the tooltip and the accessible
  // name, so it is announced once.
  function iconButton(cls, iconName, title) {
    var b = button(cls);
    b.title = title;
    b.appendChild(api.icon(iconName));
    return b;
  }

  // A tiny preview of a theme: its background, "Aa" in its text colour and
  // a dot of its accent. Auto shows the light and dark halves.
  function swatch(theme) {
    var s = el('span', 'mdv-swatch', 'Aa');
    s.setAttribute('aria-hidden', 'true');
    var c = theme.swatch; // [background, surface, text, accent]
    if (theme.id === 'auto') {
      s.style.background = 'linear-gradient(135deg, #ffffff 0 50%, #0d1117 50% 100%)';
      s.style.color = '#8c959f';
    } else {
      s.style.background = c[0];
      s.style.color = c[2];
    }
    var dot = el('span', 'mdv-swatch-accent');
    dot.style.background = c[3];
    s.appendChild(dot);
    return s;
  }

  // options: prefs, fileAccess, supportUrl, setStatus(text), onClose()
  function createSettings(options) {
    var prefs = options.prefs;
    var syncs = []; // functions(prefs) that update a control

    var panel = el('dialog', 'mdv-settings');
    var titleId = nextId('settings-title');
    panel.setAttribute('aria-labelledby', titleId);

    // Script-made events never reach a control (see the comment at the top).
    // Real clicks, taps and key presses are trusted and pass.
    // This guard is a first line only: a script can move a control out of the
    // panel, or stop events before they reach it, so every handler that
    // changes something also checks for itself (trusted() below).
    // On the settings page, input that arrives just after the page comes to
    // the front was aimed at whatever was there before: a website can bring
    // this page up ("Open settings page") between the two clicks of a
    // double-click. Such input is ignored for half a second.
    var calmUntil = 0;
    if (options.page) {
      var settle = function () { calmUntil = Date.now() + 500; };
      settle();
      doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') settle(); });
      global.addEventListener('focus', settle);
      var chr = global.chrome;
      if (chr && chr.tabs && chr.tabs.onActivated) chr.tabs.onActivated.addListener(settle);
      if (chr && chr.windows && chr.windows.onFocusChanged) chr.windows.onFocusChanged.addListener(settle);
    }
    ['click', 'change', 'input', 'keydown', 'mousedown', 'pointerdown', 'mousemove', 'mouseenter', 'mouseleave'].forEach(function (type) {
      panel.addEventListener(type, function (e) {
        if (!e.isTrusted || Date.now() < calmUntil) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
    });

    /* -------------------------------------------------------- header */

    var head = el('header', 'mdv-set-head');
    var title = el(options.page ? 'h1' : 'h2', null, options.page ? 'Hushmark settings' : 'Settings');
    title.id = titleId;
    var closeBtn = iconButton('mdv-icon-btn mdv-set-close', 'close', 'Close settings');
    closeBtn.addEventListener('click', trusted(function () { panel.close(); }));
    head.append(title);
    if (!options.page) {
      head.appendChild(closeBtn);
    } else {
      panel.classList.add('mdv-settings-page');
    }

    var body = el('div', 'mdv-set-body');

    /* ------------------------------------------------------- helpers */

    function section(name, iconName, children, note) {
      var s = el('section', 'mdv-set-section');
      var h = el('h3', 'mdv-set-heading');
      h.id = nextId('section');
      s.setAttribute('aria-labelledby', h.id);
      if (iconName) {
        h.appendChild(api.icon(iconName));
      }
      h.appendChild(el('span', null, name));
      var card = el('div', 'mdv-set-card');
      children.forEach(function (c) { card.appendChild(c); });
      s.append(h, card);
      if (note) {
        s.appendChild(el('p', 'mdv-set-note', note));
      }
      return s;
    }

    // A row: label (and description) on the left, control on the right, or
    // the control underneath when `stacked`. The label and description are
    // attached to control.labelTarget when the control is a wrapper, and
    // control.labelExtra (ids) is read after the label, for a control whose
    // name must also say its value. A pointer `hint` is shown but is not the
    // control's description: keyboard and screen-reader users preview with
    // the arrow keys, and touch screens cannot hover.
    function row(label, desc, control, stacked, hint) {
      var r = el('div', 'mdv-set-row' + (stacked ? ' mdv-set-row-stacked' : ''));
      var text = el('div', 'mdv-set-text');
      var l = el('div', 'mdv-set-label', label);
      l.id = nextId('label');
      text.appendChild(l);
      var target = control.labelTarget || control;
      target.setAttribute('aria-labelledby', [l.id].concat(control.labelExtra || []).join(' '));
      if (desc) {
        var d = el('div', 'mdv-set-desc', desc);
        d.id = nextId('desc');
        text.appendChild(d);
        target.setAttribute('aria-describedby', d.id);
      }
      if (hint) {
        text.appendChild(el('div', 'mdv-set-desc mdv-hover-hint', hint));
      }
      r.append(text, control);
      return r;
    }

    // An on/off switch row; the whole row is the click target, but only the
    // label names the switch (the description is its description).
    function toggle(label, desc, key) {
      var locked = IS_WEB_PAGE && LOCKED_ON_WEB[key] === true;
      var input = el('input', 'mdv-switch');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.dataset.pref = key;
      input.checked = prefs.get()[key];
      input.disabled = locked;
      // The click, not change: after a script's input.click() Chrome fires a
      // trusted change event, but the click itself is untrusted and can be
      // refused (preventDefault puts the switch back).
      input.addEventListener('click', function (e) {
        // locked is checked here as well, since a script can re-enable the
        // input or move it
        if (!e.isTrusted || locked) {
          e.preventDefault();
          return;
        }
        var patch = {};
        patch[key] = input.checked;
        prefs.set(patch);
      });
      var r = el('label', 'mdv-set-row mdv-toggle-row' + (locked ? ' mdv-locked' : ''));
      var text = el('span', 'mdv-set-text');
      var l = el('span', 'mdv-set-label', label);
      l.id = nextId('label');
      input.setAttribute('aria-labelledby', l.id);
      text.appendChild(l);
      if (desc) {
        var d = el('span', 'mdv-set-desc', desc);
        d.id = nextId('desc');
        input.setAttribute('aria-describedby', d.id);
        text.appendChild(d);
      }
      r.append(text, input);
      syncs.push(function (p) { input.checked = p[key]; });
      return r;
    }

    // A segmented control with radio semantics (arrow keys move and select).
    function segmented(items, key, decorate) {
      var group = el('div', 'mdv-segmented');
      group.setAttribute('role', 'radiogroup');
      group.dataset.pref = key;
      function choose(id) {
        var patch = {};
        patch[key] = id;
        prefs.set(patch);
      }
      var buttons = items.map(function (item) {
        var b = button('mdv-seg', item.label);
        b.setAttribute('role', 'radio');
        b.dataset.value = item.id;
        if (decorate) decorate(b, item);
        b.addEventListener('click', trusted(function () { choose(item.id); }));
        group.appendChild(b);
        return b;
      });
      group.addEventListener('keydown', trusted(function (e) {
        var i = buttons.indexOf(doc.activeElement);
        var n = buttons.length;
        var next = {
          ArrowRight: buttons[(i + 1) % n], ArrowDown: buttons[(i + 1) % n],
          ArrowLeft: buttons[(i - 1 + n) % n], ArrowUp: buttons[(i - 1 + n) % n],
          Home: buttons[0], End: buttons[n - 1]
        }[e.key];
        if (!next) return;
        e.preventDefault();
        next.focus();
        choose(next.dataset.value);
      }));
      function sync(p) {
        buttons.forEach(function (b) {
          var on = b.dataset.value === p[key];
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        });
      }
      sync(prefs.get());
      syncs.push(sync);
      return group;
    }

    /* --------------------------------------------- theme picker */

    function themePicker() {
      var wrap = el('div', 'mdv-picker');
      var listId = nextId('themes');
      var btn = button('mdv-picker-button');
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', listId);
      var btnSwatch = el('span', 'mdv-picker-swatch');
      var btnName = el('span', 'mdv-picker-name');
      btnName.id = nextId('theme-name');
      btn.append(btnSwatch, btnName, api.icon('chevron'));

      var list = el('div', 'mdv-picker-list');
      list.id = listId;
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Theme');
      list.tabIndex = -1;
      list.hidden = true;

      function option(t) {
        var o = el('div', 'mdv-picker-option');
        o.id = nextId('theme');
        o.setAttribute('role', 'option');
        o.dataset.value = t.id;
        var mark = api.icon('check');
        mark.classList.add('mdv-picker-check');
        o.append(swatch(t), el('span', 'mdv-picker-option-name', t.name), mark);
        return o;
      }

      // Auto first, then the light themes, then the dark ones, so moving
      // through the list never alternates between light and dark.
      var opts = [];
      prefs.THEMES.filter(function (t) { return !t.tone; }).forEach(function (t) {
        var o = option(t);
        list.appendChild(o);
        opts.push(o);
      });
      [['light', 'Light'], ['dark', 'Dark']].forEach(function (g) {
        var themes = prefs.THEMES.filter(function (t) { return t.tone === g[0]; });
        if (!themes.length) return;
        var group = el('div', 'mdv-picker-group');
        group.setAttribute('role', 'group');
        var label = el('div', 'mdv-picker-group-label', g[1]);
        label.id = nextId('theme-group');
        label.setAttribute('role', 'presentation');
        group.setAttribute('aria-labelledby', label.id);
        group.appendChild(label);
        themes.forEach(function (t) {
          var o = option(t);
          group.appendChild(o);
          opts.push(o);
        });
        list.appendChild(group);
      });
      wrap.append(btn, list);

      var active = null;
      var hoverTimer = 0;

      function themeById(id) {
        return prefs.THEMES.filter(function (t) { return t.id === id; })[0] || prefs.THEMES[0];
      }

      function savedOption() {
        var saved = prefs.get().theme;
        return opts.filter(function (o) { return o.dataset.value === saved; })[0] || opts[0];
      }

      function cancelHover() {
        global.clearTimeout(hoverTimer);
        hoverTimer = 0;
      }

      // Highlights an option; previewIt also shows its theme on the page.
      // The keyboard previews at once; the pointer only after resting.
      function setActive(o, previewIt, fromPointer) {
        active = o;
        opts.forEach(function (x) { x.classList.toggle('mdv-active', x === o); });
        list.setAttribute('aria-activedescendant', o.id);
        if (!fromPointer) {
          o.scrollIntoView({ block: 'nearest' });
        }
        if (previewIt) {
          cancelHover();
          prefs.preview(o.dataset.value);
        }
      }

      function isOpen() {
        return !list.hidden;
      }

      function open() {
        list.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        panel.classList.add('mdv-previewing');
        setActive(savedOption(), false);
        list.scrollIntoView({ block: 'nearest' }); // the whole list, if it fits
        list.focus();
        doc.addEventListener('mousedown', outside, true);
      }

      // commit: a theme id to save, or null to go back to the saved theme
      function close(commit, keepFocus) {
        if (!isOpen()) return;
        cancelHover();
        list.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        panel.classList.remove('mdv-previewing');
        doc.removeEventListener('mousedown', outside, true);
        if (commit) {
          prefs.set({ theme: commit });
        }
        prefs.preview(null);
        if (!keepFocus) btn.focus();
      }

      function outside(e) {
        if (!wrap.contains(e.target)) {
          close(null, true);
        }
      }

      btn.addEventListener('click', trusted(function () {
        if (isOpen()) close(null); else open();
      }));
      btn.addEventListener('keydown', trusted(function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          open();
        }
      }));

      // Hover follows real pointer movement only. Chrome also fires
      // mouseenter when the list opens or scrolls under a pointer that has
      // not moved; that must not highlight or preview anything.
      // The last real pointer position anywhere on the page (recorded after
      // the options' own handlers run), so a list that opens under a still
      // pointer sees no movement.
      var lastX = null;
      var lastY = null;
      doc.addEventListener('mousemove', trusted(function (e) {
        lastX = e.screenX;
        lastY = e.screenY;
      }));
      opts.forEach(function (o) {
        o.addEventListener('mousemove', trusted(function (e) {
          if (e.screenX === lastX && e.screenY === lastY) {
            return;
          }
          lastX = e.screenX;
          lastY = e.screenY;
          if (active === o) {
            return;
          }
          setActive(o, false, true);
          cancelHover();
          hoverTimer = global.setTimeout(function () {
            hoverTimer = 0;
            if (isOpen() && active === o) {
              prefs.preview(o.dataset.value);
            }
          }, HOVER_PREVIEW_MS);
        }));
        o.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus on the list
        o.addEventListener('click', trusted(function () { close(o.dataset.value); }));
      });
      // The pointer left the list without picking: show the saved theme
      // again, and highlight it, so Enter cannot pick the one left behind.
      list.addEventListener('mouseleave', trusted(function () {
        cancelHover();
        if (isOpen()) {
          setActive(savedOption(), false, true);
          prefs.preview(null);
        }
      }));

      list.addEventListener('keydown', trusted(function (e) {
        var i = opts.indexOf(active);
        var target = null;
        if (e.key === 'ArrowDown') target = opts[Math.min(opts.length - 1, i + 1)];
        else if (e.key === 'ArrowUp') target = opts[Math.max(0, i - 1)];
        else if (e.key === 'Home') target = opts[0];
        else if (e.key === 'End') target = opts[opts.length - 1];
        if (target) {
          e.preventDefault();
          setActive(target, true);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          close(active ? active.dataset.value : null);
        } else if (e.key === 'Escape') {
          e.preventDefault(); // close the list, not the whole drawer
          e.stopPropagation();
          close(null);
        } else if (e.key === 'Tab') {
          close(null, true);
        }
      }));

      function sync(p) {
        var t = themeById(p.theme);
        btnSwatch.replaceChildren(swatch(t));
        btnName.textContent = t.name;
        opts.forEach(function (o) { o.setAttribute('aria-selected', String(o.dataset.value === p.theme)); });
      }
      sync(prefs.get());
      syncs.push(sync);

      // row() labels the button, and its name reads "Theme, GitHub Light"
      wrap.labelTarget = btn;
      wrap.labelExtra = [btnName.id];
      wrap.close = function () { close(null, true); };
      return wrap;
    }

    /* ------------------------------------------------- text size */

    function sizeStepper() {
      var box = el('div', 'mdv-stepper');
      box.setAttribute('role', 'group');
      // aria-disabled rather than disabled at the limits, so the focused
      // button keeps focus
      var minus = iconButton('mdv-step', 'minus', 'Smaller text');
      var out = el('output', 'mdv-step-value');
      out.setAttribute('aria-live', 'polite');
      var plus = iconButton('mdv-step', 'plus', 'Larger text');
      function step(delta) {
        var size = prefs.get().size;
        var next = Math.min(prefs.SIZE_MAX, Math.max(prefs.SIZE_MIN, size + delta));
        if (next !== size) {
          prefs.set({ size: next });
        }
      }
      minus.addEventListener('click', trusted(function () { step(-1); }));
      plus.addEventListener('click', trusted(function () { step(1); }));
      box.append(minus, out, plus);
      function sync(p) {
        out.textContent = p.size + ' px';
        minus.setAttribute('aria-disabled', String(p.size <= prefs.SIZE_MIN));
        plus.setAttribute('aria-disabled', String(p.size >= prefs.SIZE_MAX));
      }
      sync(prefs.get());
      syncs.push(sync);
      return box;
    }

    /* ------------------------------------------------ your data */

    // The background worker keeps the "Show as plain text" choices in
    // memory; Reset asks it to forget them. Resolves either way.
    function askWorker() {
      return new Promise(function (done) {
        try {
          global.chrome.runtime.sendMessage({ hushmark: 'reset' }, function () {
            void global.chrome.runtime.lastError;
            done();
          });
        } catch (err) {
          done();
        }
      });
    }

    function dataRow() {
      var r = el('div', 'mdv-set-row mdv-set-row-stacked');
      var text = el('div', 'mdv-set-text');
      var desc = el('div', 'mdv-set-desc', IS_LOCAL
        ? 'Remove remembered files, or every setting and record Hushmark keeps in this browser.'
        : 'Remembered files belong to files on your computer: open one to forget them. Reset removes your settings now, and remembered files the next time you open a file from your computer.');
      text.append(el('div', 'mdv-set-label', 'Your data'), desc);

      // the outcome, shown here (the status bar is behind the drawer)
      var result = el('p', 'mdv-set-result');
      result.setAttribute('role', 'status');
      function report(message) {
        result.replaceChildren(api.icon('check'), el('span', null, message));
        options.setStatus(message);
      }

      var actions = el('div', 'mdv-set-actions');
      if (IS_LOCAL) {
        var forget = button('mdv-set-action', 'Forget saved files');
        forget.addEventListener('click', trusted(function () {
          options.fileAccess.forgetAll().then(function () {
            report('Saved files forgotten. The next save asks for the file again.');
          });
        }));
        actions.appendChild(forget);
      }
      var reset = button('mdv-set-action mdv-danger', 'Reset all Hushmark data');
      actions.appendChild(reset);

      // Reset asks first, in place: what it removes, that it cannot be
      // undone, and Cancel focused. (A sandboxed site ignores confirm().)
      var confirmBox = el('div', 'mdv-set-confirm');
      confirmBox.setAttribute('role', 'group');
      confirmBox.tabIndex = -1; // a click inside keeps focus here, so Escape still cancels
      var confirmTitle = el('div', 'mdv-set-confirm-title', 'Reset Hushmark?');
      confirmTitle.id = nextId('confirm');
      var confirmText = el('p', 'mdv-set-confirm-text', IS_LOCAL
        ? 'This removes every setting and forgets all saved files in this browser. It cannot be undone.'
        : 'This resets every setting now, and forgets saved files the next time you open a file from your computer. It cannot be undone.');
      confirmText.id = nextId('confirm-text');
      confirmBox.setAttribute('aria-labelledby', confirmTitle.id);
      confirmBox.setAttribute('aria-describedby', confirmText.id);
      var cancelBtn = button('mdv-set-action', 'Cancel');
      var confirmBtn = button('mdv-set-action mdv-danger-solid', 'Reset everything');
      var confirmActions = el('div', 'mdv-set-actions');
      confirmActions.append(cancelBtn, confirmBtn);
      confirmBox.append(confirmTitle, confirmText, confirmActions);
      confirmBox.hidden = true;

      function askReset(show) {
        confirmBox.hidden = !show;
        actions.hidden = show;
        (show ? cancelBtn : reset).focus();
      }
      reset.addEventListener('click', trusted(function () {
        result.replaceChildren();
        askReset(true);
      }));
      cancelBtn.addEventListener('click', trusted(function () { askReset(false); }));
      confirmBox.addEventListener('keydown', trusted(function (e) {
        if (e.key === 'Escape') {
          e.preventDefault(); // cancel the reset, not the whole drawer
          e.stopPropagation();
          askReset(false);
        }
      }));
      confirmBtn.addEventListener('click', trusted(function () {
        askReset(false);
        options.fileAccess.deleteAll().then(askWorker).then(function () {
          prefs.reset();
          report(IS_LOCAL
            ? 'All Hushmark data in this browser was removed.'
            : 'Settings were reset. Saved files are forgotten the next time you open a file from your computer.');
        });
      }));

      r.append(text, actions, confirmBox, result);
      r.cancelConfirm = function () {
        confirmBox.hidden = true;
        actions.hidden = false;
        result.replaceChildren();
      };
      return r;
    }

    /* --------------------------------------------------- sections */

    var picker = themePicker();
    var fontItems = prefs.FONTS.map(function (f) { return { id: f.id, label: { sans: 'Sans', serif: 'Serif', mono: 'Mono' }[f.id] || f.name }; });
    var widthItems = prefs.WIDTHS.map(function (w) { return { id: w.id, label: { full: 'Full', comfortable: 'Comfortable', narrow: 'Narrow' }[w.id] || w.name }; });

    var appearance = section('Appearance', 'palette', [
      row('Theme', null, picker, true, 'Hover over a theme to preview it.'),
      row('Font', null, segmented(fontItems, 'font', function (b, item) { b.classList.add('mdv-seg-font-' + item.id); }), true),
      row('Text size', null, sizeStepper(), false),
      row('Line width', 'Full uses the whole window; the others keep lines short for reading.', segmented(widthItems, 'width'), true)
    ]);

    // On a website: say why some switches are read-only, and link to the
    // settings page where they can be changed.
    var lockedNote = null;
    if (IS_WEB_PAGE) {
      lockedNote = el('div', 'mdv-set-locked');
      var lockedText = el('p', 'mdv-set-locked-text', 'On a website, the editing, local-file and privacy switches are read-only here, so the site cannot change them. Change them in Hushmark\u2019s settings page.');
      var openPage = button('mdv-set-action', 'Open settings page');
      openPage.addEventListener('click', trusted(function () {
        try {
          global.chrome.runtime.sendMessage({ hushmark: 'open-options' });
        } catch (err) { /* extension updated or removed since the page loaded */ }
      }));
      lockedNote.append(lockedText, openPage);
    }

    var editing = section('Editing', 'edit', [
      toggle('Autosave', 'Saves 2 seconds after you stop typing, once the file is linked.', 'autosave'),
      toggle('Spell check', "Uses the browser's spell checker. With Chrome's Enhanced spell check on, Chrome sends the text to Google.", 'spellcheck')
    ]);

    var websites = section('Files and websites', 'globe', [
      toggle('Format Markdown in other local files', 'Text files on your computer that are not named .md, such as notes.txt or README, open formatted when they look like Markdown. Code, logs and data files never do.', 'anyFile'),
      toggle('Format Markdown files on websites', 'Raw .md files on websites open formatted. When off, Hushmark runs on a website only when you click its toolbar button.', 'webPages')
    ]);

    var yourData = dataRow();
    var privacy = section('Privacy', 'shield', [
      toggle('Load web images automatically', 'When off, images a file embeds from other sites wait until you click Load images.', 'remoteImages'),
      toggle('Remember saved files', "Keeps each saved file's address in this browser, so the next visit needs only Chrome's permission prompt.", 'rememberFiles'),
      yourData
    ], 'Hushmark reads the file you open only to show and edit it in this tab, and sends nothing anywhere. Images a file embeds from the web load only if you choose. Settings are stored in this browser on this computer.');

    body.append.apply(body, [appearance, lockedNote, editing, websites, privacy].filter(Boolean));
    panel.append(head, body);

    /* ------------------------------------------- support footer */

    var supportUrl = options.supportUrl;
    if (supportUrl && /^https:\/\/[^\s]+$/i.test(supportUrl)) {
      var foot = el('footer', 'mdv-set-foot');
      var text = el('div', 'mdv-support-text');
      text.append(el('strong', null, 'Enjoying Hushmark?'), el('span', null, 'It is free and private. A coffee helps keep it that way.'));
      var link = el('a', 'mdv-support-link');
      link.href = supportUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(api.coffeeIcon(), el('span', null, 'Buy me a coffee'));
      link.title = 'Opens ' + supportUrl.replace(/^https:\/\//, '') + ' in a new tab';
      // A sandboxed site blocks new tabs, so the background worker opens the
      // publisher's page instead (it opens only that address, never one it
      // is sent).
      link.addEventListener('click', function (e) {
        if (!e.isTrusted) {
          e.preventDefault(); // a script must not open tabs through Hushmark
          return;
        }
        if (SANDBOXED && global.chrome && global.chrome.runtime && global.chrome.runtime.sendMessage) {
          e.preventDefault();
          try {
            global.chrome.runtime.sendMessage({ hushmark: 'open-support' });
          } catch (err) { /* extension updated or removed since the page loaded */ }
        }
      });
      foot.append(text, link);
      panel.appendChild(foot);
    }

    /* ---------------------------------------------------- wiring */

    prefs.onChange(function (p) {
      syncs.forEach(function (fn) { fn(p); });
    });

    panel.addEventListener('close', function () {
      picker.close();
      yourData.cancelConfirm();
      if (options.onClose) options.onClose();
    });
    panel.addEventListener('mousedown', function (e) {
      if (!options.page && e.target === panel) panel.close(); // the backdrop
    });

    // the settings page: shown in place, not as a modal drawer
    panel.openPage = function () {
      if (!panel.open) panel.show();
    };

    panel.openDrawer = function () {
      if (panel.open) return;
      panel.showModal();
      body.scrollTop = 0;
      picker.querySelector('.mdv-picker-button').focus();
    };
    return panel;
  }

  api.createSettings = createSettings;
})(typeof globalThis !== 'undefined' ? globalThis : window);
