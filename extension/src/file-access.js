/*
 * Hushmark — file-access.js
 *
 * Writes the edited Markdown back to the file on disk through the browser's
 * File System Access API. Chrome does not let a page write to a file just
 * because it was opened from that path, so the first save shows Chrome's own
 * save dialog (pick the same file to overwrite it). The granted file handle
 * is then kept in IndexedDB for this URL so later saves, and saves after a
 * reload, only need Chrome's one-click permission prompt.
 *
 * Nothing here leaves the browser: handles are opaque browser objects and
 * IndexedDB for file:// pages is local to this profile.
 */
(function (global) {
  'use strict';

  var api = global.Hushmark;
  if (!api) {
    return;
  }

  var supported = typeof global.showSaveFilePicker === 'function';
  // The database name predates the rename; kept so remembered file access carries over.
  var DB_NAME = 'local-markdown-viewer';
  var STORE = 'file-handles';
  var key = global.location.href.split('#')[0];
  var handle = null;
  var handleVerified = false; // a restored handle has been checked against the open file

  var MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext'];

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
    return withStore('readwrite', function (store) { return store.put(h, key); }).catch(function () {});
  }

  function restore() {
    if (handle) {
      return Promise.resolve(handle);
    }
    return withStore('readonly', function (store) { return store.get(key); })
      .then(function (stored) {
        if (stored && typeof stored.createWritable === 'function') {
          handle = stored;
        }
        return handle;
      })
      .catch(function () { return null; });
  }

  function forget() {
    handle = null;
    handleVerified = false;
    return withStore('readwrite', function (store) { return store.delete(key); }).catch(function () {});
  }

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
      .catch(function () { return 'denied'; });
  }

  // True when a write would succeed without any prompt or dialog.
  function canSaveSilently() {
    if (!supported) {
      return Promise.resolve(false);
    }
    return restore().then(function (h) {
      return h ? permission(h, false).then(function (s) { return s === 'granted'; }) : false;
    });
  }

  // Shows Chrome's save dialog. The dialog opens in the last-used folder,
  // not next to the open file, and the page cannot tell where the picked
  // file lives. A handle whose name differs from the open file is used for
  // this one write only and is never remembered.
  function pick(fileName, hooks) {
    if (hooks && hooks.beforePicker) {
      hooks.beforePicker();
    }
    return global.showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: 'Markdown', accept: { 'text/markdown': MARKDOWN_EXTENSIONS } }]
    }).then(function (h) {
      if (h.name !== fileName) {
        return { handle: h, elsewhere: true, picked: true };
      }
      handle = h;
      handleVerified = true;
      return remember(h).then(function () { return { handle: h, elsewhere: false, picked: true }; });
    });
  }

  // A handle restored from IndexedDB is trusted only if the file it points
  // to still holds the text this page loaded from disk. Otherwise it is
  // dropped (a copy saved elsewhere, or a file edited by another program).
  function verifyRestored(h, expectedText) {
    if (handleVerified || typeof expectedText !== 'string') {
      return Promise.resolve(h);
    }
    return h.getFile()
      .then(function (file) { return file.text(); })
      .then(function (onDisk) {
        // Chrome's text view already dropped a BOM and turned CRLF into LF
        if (onDisk.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') === expectedText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')) {
          handleVerified = true;
          return h;
        }
        return forget().then(function () { return null; });
      }, function () { return forget().then(function () { return null; }); });
  }

  // The page sees the file as LF text without a byte-order mark, whatever
  // the bytes on disk were. Look at the existing bytes and write the same
  // conventions back. A file just created by the save dialog is empty, so
  // it gets plain UTF-8 with LF.
  function matchFileConventions(h, text) {
    return h.getFile()
      .then(function (file) { return file.arrayBuffer(); })
      .then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        if (!bytes.length) {
          return text;
        }
        var bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        var crlf = false;
        for (var i = 0; i < bytes.length - 1; i++) {
          if (bytes[i] === 0x0D && bytes[i + 1] === 0x0A) {
            crlf = true;
            break;
          }
        }
        var out = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
        return (bom ? '\uFEFF' : '') + out;
      }, function () { return text; });
  }

  // Saves `text`. Call from a user gesture (click or key press) so Chrome
  // can show its permission prompt or save dialog when it needs to.
  // options.expectedText: the text loaded from the file:// URL, used to
  //   check a remembered handle before its first use in this page.
  // options.beforePicker: called right before the save dialog opens.
  // Resolves { name, elsewhere, picked }: elsewhere means the text went to a
  // file with a different name, which was not remembered.
  function save(text, fileName, options) {
    options = options || {};
    if (!supported) {
      return Promise.reject(Object.assign(new Error('File System Access API unavailable'), { name: 'NotSupportedError' }));
    }
    return restore()
      .then(function (h) { return h ? verifyRestored(h, options.expectedText) : null; })
      .then(function (h) {
        if (!h) {
          return null;
        }
        return permission(h, true).then(function (state) {
          if (state === 'granted') {
            return { handle: h, elsewhere: false, picked: false };
          }
          // Declined or dismissed: stop here rather than surprising the user
          // with the full save dialog. "Forget file access" starts over.
          throw Object.assign(new Error('Permission to write the file was not granted'), { name: 'PermissionDeniedError' });
        });
      })
      .then(function (target) { return target || pick(fileName, options); })
      .then(function (target) {
        var h = target.handle;
        return matchFileConventions(h, text).then(function (bytesToWrite) {
          return h.createWritable().then(function (writable) {
            return writable.write(bytesToWrite).then(function () { return writable.close(); }, function (err) {
              return writable.abort().catch(function () {}).then(function () { throw err; });
            });
          });
        }).then(function () { return { name: h.name, elsewhere: target.elsewhere, picked: target.picked }; });
      });
  }

  api.fileAccess = {
    supported: supported,
    save: save,
    canSaveSilently: canSaveSilently,
    hasHandle: function () { return restore().then(function (h) { return !!h; }); },
    forget: forget
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
