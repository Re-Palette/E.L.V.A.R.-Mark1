// Per-user namespace for everything this app keeps in the browser (docs/ELVAR_MULTIUSER.md 8.7, principles 3 and 4). A classic script that runs BEFORE any
// module: it prefixes every localStorage key with the signed-in user's namespace and gives every IndexedDB database a per-user name, so two people using the
// same browser never see each other's conversation log, files, settings or caches. Signed out: the "anon" namespace. The sign-in session itself and the
// namespace pointer (keys starting elvar_auth / elvar_ns) are device-wide on purpose. web/src/elvar/local.js sets the pointer after sign-in and clears a
// user's data on sign-out. Nothing here talks to a server.
(function () {
  try {
    var POINTER = 'elvar_ns', RAW = /^(elvar_auth|elvar_ns)/;
    var ns = ''; try { ns = localStorage.getItem(POINTER) || ''; } catch (e) { /* storage blocked */ }
    if (!/^[a-f0-9]{16}$/.test(ns)) ns = 'anon';
    var prefix = 'u.' + ns + '.';
    var P = Storage.prototype, get = P.getItem, set = P.setItem, rem = P.removeItem;
    P.getItem = function (k) { return get.call(this, this === localStorage && !RAW.test(String(k)) ? prefix + k : k); };
    P.setItem = function (k, v) { return set.call(this, this === localStorage && !RAW.test(String(k)) ? prefix + k : k, v); };
    P.removeItem = function (k) { return rem.call(this, this === localStorage && !RAW.test(String(k)) ? prefix + k : k); };
    // the ORIGINAL storage methods (no prefix): web/src/elvar/local.js erases a user's already-prefixed keys with them
    window.__elvarRawStorage = { getItem: function (k) { return get.call(localStorage, k); }, setItem: function (k, v) { return set.call(localStorage, k, v); }, removeItem: function (k) { return rem.call(localStorage, k); } };
    var F = typeof IDBFactory !== 'undefined' ? IDBFactory.prototype : null;
    if (F) {
      var open = F.open, del = F.deleteDatabase;
      window.__elvarRawIdb = { deleteDatabase: function (fullName) { return del.call(indexedDB, fullName); } };   // for clearing a user's databases by their full name
      F.open = function (name, v) { return arguments.length > 1 ? open.call(this, name + '@' + ns, v) : open.call(this, name + '@' + ns); };
      F.deleteDatabase = function (name) { return del.call(this, name + '@' + ns); };
    }
    window.__elvarNs = ns;
  } catch (e) { /* the app still works without the shim (single user per browser) */ }
})();
