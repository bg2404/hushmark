/*
 * Hushmark — prefs.js
 *
 * Appearance and editing preferences: theme, font, text size, width,
 * outline, autosave. Stored as one JSON value in the page's localStorage,
 * which for file:// pages lives only in this browser profile on this
 * computer and is never synced. Everything degrades gracefully when
 * storage is unavailable.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  // The key predates the rename; it is kept so saved settings carry over.
  var KEY = 'local-markdown-viewer:prefs';

  // swatch: [background, surface, text, accent] for the theme picker
  var THEMES = [
    { id: 'auto', name: 'Auto (system)', swatch: ['#ffffff', '#0d1117', '#1f2328', '#4493f8'] },
    { id: 'github-light', name: 'GitHub Light', swatch: ['#ffffff', '#f6f8fa', '#1f2328', '#0969da'] },
    { id: 'github-dark', name: 'GitHub Dark', swatch: ['#0d1117', '#161b22', '#f0f6fc', '#4493f8'] },
    { id: 'solarized-light', name: 'Solarized Light', swatch: ['#fdf6e3', '#eee8d5', '#586e75', '#268bd2'] },
    { id: 'solarized-dark', name: 'Solarized Dark', swatch: ['#002b36', '#073642', '#93a1a1', '#268bd2'] },
    { id: 'sepia', name: 'Sepia', swatch: ['#f4ecd8', '#ece2c8', '#5b4636', '#8b5a2b'] },
    { id: 'nord', name: 'Nord', swatch: ['#2e3440', '#3b4252', '#eceff4', '#88c0d0'] },
    { id: 'dracula', name: 'Dracula', swatch: ['#282a36', '#21222c', '#f8f8f2', '#8be9fd'] },
    { id: 'gruvbox-dark', name: 'Gruvbox Dark', swatch: ['#282828', '#3c3836', '#ebdbb2', '#83a598'] },
    { id: 'one-dark', name: 'One Dark', swatch: ['#282c34', '#21252b', '#abb2bf', '#61afef'] }
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
    splitRatio: 0.5
  };

  function hasId(list, id) {
    return list.some(function (item) { return item.id === id; });
  }

  function sanitize(raw) {
    var p = Object.assign({}, DEFAULTS, raw || {});
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
    return p;
  }

  function read() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (!raw) {
        return {};
      }
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  var current = sanitize(read());
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

  function set(patch) {
    current = sanitize(Object.assign({}, current, patch));
    try {
      global.localStorage.setItem(KEY, JSON.stringify(current));
    } catch (err) { /* storage unavailable: keep the in-memory value */ }
    apply();
    var snapshot = get();
    listeners.forEach(function (fn) {
      try { fn(snapshot); } catch (err) { /* one listener must not break others */ }
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
    get: get,
    set: set,
    apply: apply,
    onChange: onChange
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
