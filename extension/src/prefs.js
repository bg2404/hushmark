/*
 * Hushmark — prefs.js
 *
 * Appearance, editing and privacy preferences. Stored as one value in the
 * extension's own storage (chrome.storage.local): private to Hushmark, never
 * synced, and not readable by the pages it runs on. That matters now that
 * Hushmark also runs on websites, where the page's localStorage would belong
 * to the website.
 *
 * Earlier versions kept the settings in the localStorage of file:// pages;
 * they are moved over once and removed from there.
 *
 * Loading is asynchronous: content.js waits for prefs.load() before
 * mounting. Changes made in any tab reach every other tab through
 * chrome.storage.onChanged.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  var KEY = 'prefs';
  var LEGACY_KEY = 'local-markdown-viewer:prefs'; // localStorage of file:// pages, before 2.1
  var LEGACY_DONE = 'legacyChecked';               // set once the old key has been looked at
  var storage = global.chrome && global.chrome.storage && global.chrome.storage.local;

  // swatch: [background, surface, text, accent] for the theme picker;
  // tone groups the picker's list (Auto has none)
  var THEMES = [
    { id: 'auto', name: 'Auto (system)', swatch: ['#ffffff', '#0d1117', '#1f2328', '#4493f8'] },
    { id: 'github-light', tone: 'light', name: 'GitHub Light', swatch: ['#ffffff', '#f6f8fa', '#1f2328', '#0969da'] },
    { id: 'github-dark', tone: 'dark', name: 'GitHub Dark', swatch: ['#0d1117', '#161b22', '#f0f6fc', '#4493f8'] },
    { id: 'solarized-light', tone: 'light', name: 'Solarized Light', swatch: ['#fdf6e3', '#eee8d5', '#586e75', '#268bd2'] },
    { id: 'solarized-dark', tone: 'dark', name: 'Solarized Dark', swatch: ['#002b36', '#073642', '#93a1a1', '#268bd2'] },
    { id: 'sepia', tone: 'light', name: 'Sepia', swatch: ['#f4ecd8', '#ece2c8', '#5b4636', '#8b5a2b'] },
    { id: 'nord', tone: 'dark', name: 'Nord', swatch: ['#2e3440', '#3b4252', '#eceff4', '#88c0d0'] },
    { id: 'dracula', tone: 'dark', name: 'Dracula', swatch: ['#282a36', '#21222c', '#f8f8f2', '#8be9fd'] },
    { id: 'gruvbox-dark', tone: 'dark', name: 'Gruvbox Dark', swatch: ['#282828', '#3c3836', '#ebdbb2', '#83a598'] },
    { id: 'one-dark', tone: 'dark', name: 'One Dark', swatch: ['#282c34', '#21252b', '#abb2bf', '#61afef'] }
  ];
  var FONTS = [
    { id: 'sans', name: 'Sans-serif' },
    { id: 'serif', name: 'Serif' },
    { id: 'mono', name: 'Monospace' }
  ];
  var WIDTHS = [
    { id: 'full', name: 'Full width' },
    { id: 'comfortable', name: 'Comfortable' },
    { id: 'narrow', name: 'Narrow' }
  ];
  var LEGACY_WIDTHS = { normal: 'comfortable', wide: 'full' };
  var SIZE_MIN = 12;
  var SIZE_MAX = 24;

  var DEFAULTS = {
    theme: 'auto',
    font: 'sans',
    size: 16,
    width: 'full',
    toc: false,
    autosave: false,
    spellcheck: false,
    rememberFiles: false,  // keep file handles between visits (stores file addresses)
    remoteImages: false,   // load images, video and audio from other sites automatically
    webPages: true,        // format Markdown files on websites automatically
    splitRatio: 0.5
  };

  function hasId(list, id) {
    return list.some(function (item) { return item.id === id; });
  }

  function sanitize(raw) {
    var p = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    if (!hasId(THEMES, p.theme)) p.theme = DEFAULTS.theme;
    if (!hasId(FONTS, p.font)) p.font = DEFAULTS.font;
    if (LEGACY_WIDTHS[p.width]) p.width = LEGACY_WIDTHS[p.width];
    if (!hasId(WIDTHS, p.width)) p.width = DEFAULTS.width;
    p.splitRatio = Number(p.splitRatio);
    if (!(p.splitRatio >= 0.25 && p.splitRatio <= 0.75)) p.splitRatio = DEFAULTS.splitRatio;
    p.size = Math.round(Number(p.size));
    p.size = isFinite(p.size) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, p.size)) : DEFAULTS.size;
    p.toc = !!p.toc;
    p.autosave = !!p.autosave;
    p.spellcheck = !!p.spellcheck;
    p.rememberFiles = !!p.rememberFiles;
    p.remoteImages = !!p.remoteImages;
    p.webPages = p.webPages !== false;
    return p;
  }

  var current = sanitize({});
  var listeners = [];

  function get() {
    return Object.assign({}, current);
  }

  function apply() {
    var root = global.document.documentElement;
    // suppress colour transitions for a frame so a theme change does not flash
    root.classList.add('mdv-theme-switching');
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () { root.classList.remove('mdv-theme-switching'); });
    });
    root.setAttribute('data-mdv-theme', current.theme);
    root.setAttribute('data-mdv-font', current.font);
    root.setAttribute('data-mdv-width', current.width);
    root.style.setProperty('--mdv-font-size', current.size + 'px');
  }

  // Shows a theme without saving it (the theme picker's hover preview).
  // preview(null) goes back to the saved theme.
  function preview(themeId) {
    var root = global.document.documentElement;
    root.classList.add('mdv-theme-switching');
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () { root.classList.remove('mdv-theme-switching'); });
    });
    root.setAttribute('data-mdv-theme', themeId && hasId(THEMES, themeId) ? themeId : current.theme);
  }

  function notify() {
    var snapshot = get();
    listeners.forEach(function (fn) {
      try { fn(snapshot); } catch (err) { /* one listener must not break others */ }
    });
  }

  function write(value) {
    if (!storage) {
      return;
    }
    var item = {};
    item[KEY] = value;
    try { storage.set(item); } catch (err) { /* extension context gone */ }
  }

  // Settings from earlier versions, kept in the localStorage of file:// pages.
  function takeLegacy() {
    if (global.location.protocol !== 'file:') {
      return null; // never touch a website's own storage
    }
    try {
      var raw = global.localStorage.getItem(LEGACY_KEY);
      global.localStorage.removeItem(LEGACY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  // Reads the stored settings. Resolves with a snapshot.
  function load() {
    return new Promise(function (resolve) {
      if (!storage) {
        current = sanitize(takeLegacy());
        resolve(get());
        return;
      }
      try {
        storage.get([KEY, LEGACY_DONE], function (result) {
          var stored = result && result[KEY];
          // Settings from before 2.1 are imported once, on the first local
          // file opened after the update, and never again. A new install
          // starts with the marker set (background.js), so a local HTML file
          // cannot plant settings through the old key.
          if (!(result && result[LEGACY_DONE]) && global.location.protocol === 'file:') {
            var legacy = takeLegacy();
            var item = {};
            item[LEGACY_DONE] = true;
            if (!stored && legacy && typeof legacy === 'object') {
              // Only these are brought over. Options that lower privacy
              // (web images, remembered files, spell check) are only ever
              // turned on in Settings, and options added later can never be
              // planted through the old key.
              var kept = {};
              ['theme', 'font', 'size', 'width', 'toc', 'splitRatio', 'autosave'].forEach(function (k) {
                if (k in legacy) kept[k] = legacy[k];
              });
              stored = sanitize(kept);
              item[KEY] = stored;
            }
            try { storage.set(item); } catch (err) { /* extension context gone */ }
          }
          current = sanitize(stored);
          resolve(get());
        });
      } catch (err) {
        resolve(get());
      }
    });
  }

  function set(patch) {
    current = sanitize(Object.assign({}, current, patch));
    write(current);
    apply();
    notify();
  }

  // The settings as this tab knows them; other tabs' changes arrive through
  // chrome.storage.onChanged below, so this is never stale for long.
  function stored() {
    return get();
  }

  // Back to the defaults, and the stored value removed rather than rewritten.
  function reset() {
    current = sanitize({});
    if (storage) {
      try { storage.remove(KEY); } catch (err) { /* extension context gone */ }
    }
    takeLegacy();
    apply();
    notify();
  }

  // Another tab (or Reset in another tab) changed the settings: follow it,
  // so this tab never writes stale values back.
  if (global.chrome && global.chrome.storage && global.chrome.storage.onChanged) {
    global.chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[KEY]) {
        var next = sanitize(changes[KEY].newValue);
        if (!global.document.documentElement.hasAttribute('data-mdv')) {
          current = next; // not showing a file: leave the page alone
          return;
        }
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          current = next;
          apply();
          notify();
        }
      }
    });
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  api.prefs = {
    THEMES: THEMES,
    FONTS: FONTS,
    WIDTHS: WIDTHS,
    SIZE_MIN: SIZE_MIN,
    SIZE_MAX: SIZE_MAX,
    DEFAULTS: DEFAULTS,
    KEY: KEY,
    load: load,
    get: get,
    set: set,
    reset: reset,
    stored: stored,
    apply: apply,
    preview: preview,
    onChange: onChange
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
