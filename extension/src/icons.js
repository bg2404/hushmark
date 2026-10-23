/*
 * Hushmark — icons.js
 *
 * A small set of inline SVG icons (24x24, stroked) used by the toolbar and
 * app chrome. Everything is a constant string in this file; no icon fonts,
 * no files, no network.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  var PATHS = {
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>',
    read: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M13 7l3 3"/>',
    source: '<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M14 5l-4 14"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>',
    outline: '<path d="M4 6h16"/><path d="M8 12h12"/><path d="M12 18h8"/>',
    settings: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="17" r="2" fill="currentColor"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 8"/>',
    ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor"/>',
    ol: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 5l1.5-1v4.5"/><path d="M3.3 10.6a1.6 1.6 0 0 1 2.9 1c0 1.2-2.8 1.6-2.8 3h3"/><path d="M3.3 16h2.6l-1.4 1.6a1.4 1.4 0 1 1-1.4 2.2"/>',
    task: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>',
    quote: '<path d="M5 17h4a2 2 0 0 0 2-2v-4H5v4a2 2 0 0 0 0 0z"/><path d="M5 11a4 4 0 0 1 4-4"/><path d="M13 17h4a2 2 0 0 0 2-2v-4h-6v4z"/><path d="M13 11a4 4 0 0 1 4-4"/>',
    code: '<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/>',
    codeblock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 10l-2 2 2 2"/><path d="M14.5 10l2 2-2 2"/>',
    table: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14M15 5v14"/>',
    hr: '<path d="M4 12h16"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a5 5 0 0 1 0 10h-4"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a5 5 0 0 0 0 10h4"/>',
    clear: '<path d="M4 20h11"/><path d="M6.5 15.5l8.5-8.5 4 4-6 6H9z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    check: '<path d="M5 12l4 4L19 7"/>'
  };

  function icon(name) {
    var holder = global.document.createElement('span');
    holder.innerHTML = '<svg class="mdv-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (PATHS[name] || '') + '</svg>';
    return holder.firstChild;
  }

  api.icon = icon;
})(typeof globalThis !== 'undefined' ? globalThis : window);
