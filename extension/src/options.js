/*
 * Hushmark — options.js
 *
 * Hushmark's own settings page (chrome-extension://…/src/options.html, also
 * reached from the extension's menu or from Settings on a website). It shows
 * the same Settings as the drawer, in a page no website can script, so the
 * switches that are read-only on websites can be changed here.
 *
 * Loaded first by options.html: it creates the namespace that prefs.js,
 * icons.js, config.js, file-access.js and settings.js add to, and builds the
 * page once they have run.
 */
(function (global) {
  'use strict';

  global.Hushmark = global.Hushmark || {};

  function init() {
    var api = global.Hushmark;
    if (!api.prefs || !api.createSettings) {
      return;
    }
    api.prefs.load().then(function () {
      api.prefs.apply();
      var settings = api.createSettings({
        prefs: api.prefs,
        fileAccess: api.fileAccess,
        supportUrl: api.config && api.config.supportUrl,
        setStatus: function () { /* the outcome is shown in the page itself */ },
        page: true
      });
      global.document.getElementById('mdv-options-root').appendChild(settings);
      settings.openPage();
    });
  }

  global.document.addEventListener('DOMContentLoaded', init);
})(typeof globalThis !== 'undefined' ? globalThis : window);
