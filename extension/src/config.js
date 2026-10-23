/*
 * Hushmark — config.js
 *
 * Settings chosen by whoever publishes this build.
 *
 * supportUrl: an https:// page where people can support Hushmark (for
 *   example a Ko-fi, Buy Me a Coffee or GitHub Sponsors page). When it is
 *   set, Settings shows a "Buy me a coffee" button that opens it in a new
 *   tab; when it is empty, nothing is shown. Hushmark never contacts it.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  api.config = {
    supportUrl: 'https://buymeacoffee.com/furiouslad23'
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
