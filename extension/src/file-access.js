/*
 * Hushmark — file-access.js
 *
 * Writes the edited Markdown back to the file on disk through the browser's
 * File System Access API. Chrome does not let a page write to a file just
 * because it was opened from that path, so the first save asks the user to
 * pick the file once, in Chrome's *open* dialog. (The save dialog would empty
 * the chosen file the moment it is confirmed, before Hushmark could check it
 * or read how it is encoded.)
 *
 * Every write is guarded:
 *   - the picked file must have the same name as the open one and hold the
 *     same text this tab loaded (a browser page cannot see a file's folder,
 *     so an identical copy elsewhere would pass), and a file that changed on
 *     disk since it was opened is never overwritten;
 *   - the file's own conventions are kept: UTF-8 or UTF-16, byte-order mark,
 *     LF or CRLF line endings.
 *
 * The file handle lives in memory for the tab. Only when the user turns on
 * "Remember saved files" is it also kept in IndexedDB, keyed by the file's
 * address, so a later visit needs only Chrome's permission prompt. Nothing
 * here leaves the browser.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  // Files on websites cannot be written back; there a save downloads a copy
  // (app.js), and this module stays out of the website's storage entirely.
  var isLocal = global.location.protocol === 'file:';
  var canLink = isLocal && typeof global.showOpenFilePicker === 'function';
  var canSaveAs = isLocal && typeof global.showSaveFilePicker === 'function';
  var supported = canLink || canSaveAs;
  // The database name predates the rename; kept so remembered file access carries over.
  var DB_NAME = 'local-markdown-viewer';
  var STORE = 'file-handles';
  var key = global.location.href.split('#')[0];
  var handle = null;
  var verified = false;     // the handle's file was checked against this tab's text
  var conventions = null;   // how that file is encoded, read when it was checked

  var MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext'];
  var PICKER_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': MARKDOWN_EXTENSIONS } }];

  function failure(name, message) {
    return Object.assign(new Error(message), { name: name });
  }

  // Read from storage each time: another tab may have turned it off.
  function rememberFiles() {
    return !!(api.prefs && api.prefs.stored().rememberFiles);
  }

  // Deleting the database never creates it (opening it would).
  function dropDb() {
    if (!isLocal) {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      try {
        var req = global.indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      } catch (err) {
        resolve();
      }
    });
  }

  /* ------------------------------------------------------- IndexedDB */

  function openDb() {
    return new Promise(function (resolve, reject) {
      try {
        var req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
      } catch (err) {
        reject(err);
      }
    });
  }

  function withStore(mode, fn) {
    if (!isLocal) {
      return Promise.reject(new Error('No file storage on websites'));
    }
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }

  function remember(h) {
    if (!rememberFiles()) {
      return Promise.resolve();
    }
    return withStore('readwrite', function (store) { return store.put(h, key); }).catch(function () {});
  }

  function restore() {
    if (handle) {
      return Promise.resolve(handle);
    }
    if (!rememberFiles()) {
      return Promise.resolve(null);
    }
    return withStore('readonly', function (store) { return store.get(key); })
      .then(function (stored) {
        if (stored && typeof stored.createWritable === 'function') {
          handle = stored;
          verified = false;
        }
        return handle;
      })
      .catch(function () { return null; });
  }

  // Drops the handle for this file, in memory and in storage.
  function forget() {
    handle = null;
    verified = false;
    conventions = null;
    return withStore('readwrite', function (store) { return store.delete(key); }).catch(function () {});
  }

  // Drops every remembered file handle and address, and this tab's link.
  function forgetAll() {
    handle = null;
    verified = false;
    conventions = null;
    return dropDb();
  }

  // Clears storage but keeps this tab's link to its file.
  function forgetStored() {
    return dropDb();
  }

  // Removes Hushmark's database entirely.
  function deleteAll() {
    handle = null;
    verified = false;
    conventions = null;
    return dropDb();
  }

  /* --------------------------------------------- encoding conventions */

  function normalise(text) {
    return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  // Works out how a file's bytes are encoded and decodes them.
  function readConventions(bytes) {
    var c = { bom: false, crlf: false, encoding: 'utf-8', converted: false, text: '' };
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      c.encoding = 'utf-16le';
      c.bom = true;
    } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      c.encoding = 'utf-16be';
      c.bom = true;
    } else if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      c.bom = true;
    }
    try {
      c.text = new TextDecoder(c.encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (err) {
      // Not valid UTF-8: a legacy single-byte file. Read it the way Chrome
      // showed it; it will be written back as UTF-8.
      var label = (global.document.characterSet || 'windows-1252').toLowerCase();
      try {
        c.text = new TextDecoder(label).decode(bytes);
      } catch (err2) {
        c.text = new TextDecoder('windows-1252').decode(bytes);
      }
      c.converted = true;
    }
    c.crlf = /\r\n/.test(c.text);
    return c;
  }

  function encode(text, c) {
    var out = normalise(text);
    if (c && c.crlf) {
      out = out.replace(/\n/g, '\r\n');
    }
    if (c && c.encoding !== 'utf-8') {
      var le = c.encoding === 'utf-16le';
      var body = (c.bom ? '﻿' : '') + out;
      var bytes = new Uint8Array(body.length * 2);
      for (var i = 0; i < body.length; i++) {
        var code = body.charCodeAt(i);
        bytes[2 * i + (le ? 0 : 1)] = code & 0xFF;
        bytes[2 * i + (le ? 1 : 0)] = code >> 8;
      }
      return bytes;
    }
    return new TextEncoder().encode(((c && c.bom) ? '﻿' : '') + out);
  }

  function readFile(h) {
    return h.getFile()
      .then(function (file) { return file.arrayBuffer(); })
      .then(function (buffer) { return readConventions(new Uint8Array(buffer)); });
  }

  // Resolves true when the file holds the given text (ignoring BOM and
  // CRLF/LF differences, which Chrome's text view hides anyway).
  function holds(h, expectedText) {
    return readFile(h).then(function (c) {
      conventions = c;
      return normalise(c.text) === normalise(expectedText);
    });
  }

  /* ------------------------------------------------------ permission */

  // 'granted', 'denied', or 'needs-gesture' when Chrome refused to show the
  // prompt because the click or key press had already been used up.
  function permission(h, request) {
    var opts = { mode: 'readwrite' };
    return Promise.resolve()
      .then(function () { return h.queryPermission(opts); })
      .then(function (state) {
        if (state === 'granted' || !request) {
          return state;
        }
        return h.requestPermission(opts);
      })
      .catch(function (err) {
        return err && (err.name === 'SecurityError' || err.name === 'NotAllowedError') ? 'needs-gesture' : 'denied';
      });
  }

  // True when a write would succeed without any prompt or dialog.
  function canSaveSilently() {
    if (!supported) {
      return Promise.resolve(false);
    }
    return restore().then(function (h) {
      return h && verified ? permission(h, false).then(function (s) { return s === 'granted'; }) : false;
    });
  }

  /* ------------------------------------------------------------ link */

  // Asks the user to pick the open file in Chrome's open dialog and checks
  // that it really is that file.
  function link(fileName, expectedText, options) {
    if (options.beforePicker) {
      options.beforePicker();
    }
    return global.showOpenFilePicker({ types: PICKER_TYPES, multiple: false })
      .then(function (picked) {
        var h = picked[0];
        if (!h || h.name !== fileName) {
          throw failure('MismatchError', 'A different file was chosen');
        }
        return holds(h, expectedText).then(function (same) {
          if (!same) {
            throw failure('MismatchError', 'The chosen file does not hold the text this tab opened');
          }
          handle = h;
          verified = true;
          return remember(h).then(function () { return h; });
        });
      });
  }

  /* ------------------------------------------------------------ save */

  function write(h, text, c) {
    return h.createWritable().then(function (writable) {
      return writable.write(encode(text, c)).then(function () { return writable.close(); }, function (err) {
        return writable.abort().catch(function () {}).then(function () { throw err; });
      });
    });
  }

  // Saves `text`. Call from a user gesture (click or key press) so Chrome
  // can show its dialog or permission prompt when it needs to.
  // options.expectedText: what this tab believes is on disk (the text it
  //   loaded, or last saved). A file that no longer holds it is not written.
  // options.beforePicker: called right before Chrome's dialog opens.
  // Resolves { name, linked, converted }. Rejects with:
  //   AbortError        the dialog was cancelled
  //   MismatchError     a different file was picked
  //   ConflictError     the file changed on disk since this tab loaded it
  //   NeedsGestureError the file is linked; Chrome needs one more key press
  //   PermissionDeniedError, NotSupportedError, or a write error
  function save(text, fileName, options) {
    options = options || {};
    if (!supported) {
      return Promise.reject(failure('NotSupportedError', 'File System Access API unavailable'));
    }
    var linkedNow = false;
    return restore()
      .then(function (h) {
        if (h && !verified) {
          // remembered from an earlier visit: still the same file, same text?
          return holds(h, options.expectedText).then(function (same) {
            if (same) {
              verified = true;
              return h;
            }
            return forget().then(function () { return null; });
          }, function () { return forget().then(function () { return null; }); });
        }
        return h;
      })
      .then(function (h) {
        if (h) {
          return h;
        }
        if (canLink) {
          linkedNow = true;
          return link(fileName, options.expectedText, options);
        }
        // No open dialog (very old Chrome): save through the save dialog,
        // which cannot be checked first. Used once, never remembered.
        if (options.beforePicker) {
          options.beforePicker();
        }
        return global.showSaveFilePicker({ suggestedName: fileName, types: PICKER_TYPES }).then(function (h2) {
          return write(h2, text, null).then(function () {
            throw Object.assign(failure('SavedAsCopy', 'Saved through the save dialog'), { savedName: h2.name });
          });
        });
      })
      .then(function (h) {
        return permission(h, true).then(function (state) {
          if (state === 'needs-gesture') {
            throw failure('NeedsGestureError', 'Chrome needs another key press to show its permission prompt');
          }
          if (state !== 'granted') {
            throw failure('PermissionDeniedError', 'Permission to write the file was not granted');
          }
          // Refuse to overwrite changes made outside this tab.
          return holds(h, options.expectedText).then(function (same) {
            if (!same) {
              throw failure('ConflictError', 'The file changed on disk since this tab loaded it');
            }
            var c = conventions;
            return write(h, text, c).then(function () {
              return { name: h.name, linked: linkedNow, converted: !!(c && c.converted) };
            });
          });
        });
      });
  }

  // Called once the settings have loaded: with remembering off, remove
  // anything an earlier version stored. (Before the settings load,
  // rememberFiles() would read the defaults.)
  function settingsLoaded() {
    if (isLocal && !rememberFiles()) {
      dropDb();
    }
  }

  api.fileAccess = {
    settingsLoaded: settingsLoaded,
    supported: supported,
    save: save,
    canSaveSilently: canSaveSilently,
    hasHandle: function () { return restore().then(function (h) { return !!h; }); },
    forget: forget,
    forgetAll: forgetAll,
    forgetStored: forgetStored,
    deleteAll: deleteAll,
    rememberCurrent: function () { return handle && verified ? remember(handle) : Promise.resolve(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
