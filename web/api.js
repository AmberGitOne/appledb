/**
 * API client - replaces the prototype's localStorage persistence.
 *
 * Loaded before app.js. It fetches the application state once over HTTP,
 * hands it to the app, and writes changes back to the server. Saves are
 * debounced and serialised: the UI calls save() freely (it does so on almost
 * every interaction), and this batches those calls into one PUT.
 *
 * Exposes window.CRM.
 */
(function () {
  'use strict';

  var API = '/api';
  var SAVE_DELAY = 350;        // ms of quiet before a save goes out
  var state = null;
  var booted = false;
  var bootError = null;
  var queue = [];              // callbacks waiting for the first load

  var saveTimer = null;
  var inFlight = false;
  var pendingAgain = false;
  var lastError = null;

  // -------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------

  function request(method, path, body, opts) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (opts && opts.keepalive) init.keepalive = true;

    var token = null;
    try { token = window.localStorage.getItem('aglc-token'); } catch (e) {}
    if (token) init.headers.Authorization = 'Bearer ' + token;

    return fetch(API + path, init).then(function (res) {
      var isJson = (res.headers.get('content-type') || '').indexOf('json') >= 0;
      return (isJson ? res.json() : res.text()).then(function (payload) {
        if (!res.ok) {
          var msg = (payload && payload.error) || res.status + ' ' + res.statusText;
          var err = new Error(msg);
          err.status = res.status;
          err.payload = payload;
          throw err;
        }
        return payload;
      });
    });
  }

  // -------------------------------------------------------------------
  // status pill - tells the user whether their work is actually saved
  // -------------------------------------------------------------------

  var pill = null;
  function status(text, kind) {
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'crm-sync';
      pill.setAttribute('role', 'status');
      pill.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:9999',
        'font:500 12px/1 Inter,system-ui,sans-serif', 'padding:7px 11px',
        'border-radius:999px', 'pointer-events:none',
        'transition:opacity .25s', 'opacity:0'
      ].join(';');
      document.body.appendChild(pill);
    }
    var palette = {
      saving: ['#eef2f8', '#55637a'],
      saved: ['#e7f5ec', '#1c7a52'],
      error: ['#fde8e8', '#b42318']
    }[kind] || ['#eef2f8', '#55637a'];
    pill.style.background = palette[0];
    pill.style.color = palette[1];
    pill.textContent = text;
    pill.style.opacity = '1';
    clearTimeout(pill._h);
    if (kind !== 'error') {
      pill._h = setTimeout(function () { pill.style.opacity = '0'; }, 1400);
    }
  }

  function notify(message) {
    if (typeof window.toast === 'function') window.toast(message);
    else status(message, 'error');
  }

  // -------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------

  /**
   * Ask the server who we are, and let the sign-in page relabel the top bar.
   *
   * Only when auth is enforced. With REQUIRE_AUTH off the server answers
   * with its admin fallback identity, which nobody actually signed in as -
   * adopting it would overwrite the prototype's desk persona for every
   * local run. Cosmetic either way, so failures are ignored.
   */
  function syncIdentity() {
    request('GET', '/auth/me').then(function (res) {
      if (res && res.requireAuth && res.user && window.CRMLogin) {
        window.CRMLogin.adopt(res.user);
      }
    }).catch(function () {});
  }

  function bootstrap() {
    return request('GET', '/state').then(function (res) {
      state = res.data;
      booted = true;
      bootError = null;
      flushQueue();
      syncIdentity();
      return state;
    }).catch(function (err) {
      // 401 means the server has REQUIRE_AUTH on and we have no valid token.
      // That is not a failure - it is a prompt to sign in.
      if (err.status === 401) {
        try { window.localStorage.removeItem('aglc-token'); } catch (e) {}
        return showLogin().then(bootstrap);
      }
      bootError = err;
      booted = true;
      console.error('[CRM] could not load state from the server:', err);
      showFatal(err);
      throw err;
    });
  }

  // -------------------------------------------------------------------
  // sign-in - the page itself lives in web/login.js
  // -------------------------------------------------------------------

  function showLogin(reason) {
    if (window.CRMLogin) return window.CRMLogin.show({ reason: reason });
    // login.js is linked by the build and checked for at build time, so this
    // only happens if web/ has been edited by hand. Say so rather than hang.
    var err = new Error('The sign-in page (login.js) failed to load.');
    showFatal(err);
    return Promise.reject(err);
  }

  function showFatal(err) {
    var box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:10000', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:24px',
      'background:rgba(15,27,42,.72)',
      'font:400 14px/1.55 Inter,system-ui,sans-serif'
    ].join(';');
    box.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:520px;padding:26px 28px;' +
      'box-shadow:0 24px 60px -12px rgba(10,20,60,.45)">' +
      '<h2 style="margin:0 0 10px;font-size:17px;color:#0f1b2a">Cannot reach the server</h2>' +
      '<p style="margin:0 0 12px;color:#55637a">' +
      'The app loads its data from the API, so it needs the server running.</p>' +
      '<pre style="margin:0 0 14px;background:#f4f6f9;padding:10px 12px;border-radius:8px;' +
      'font-size:12px;color:#b42318;white-space:pre-wrap">' + String(err.message) + '</pre>' +
      '<p style="margin:0;color:#55637a">Start it with <code style="background:#f4f6f9;' +
      'padding:2px 6px;border-radius:5px">npm start</code>, then reload this page.</p>' +
      '</div>';
    document.body.appendChild(box);
  }

  function flushQueue() {
    var fns = queue.slice();
    queue.length = 0;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](state); } catch (e) { console.error('[CRM] ready callback failed:', e); }
    }
  }

  // -------------------------------------------------------------------
  // saving
  // -------------------------------------------------------------------

  function doSave() {
    if (inFlight) { pendingAgain = true; return; }
    if (!state) return;

    inFlight = true;
    status('Saving…', 'saving');

    request('PUT', '/state', state).then(function (res) {
      inFlight = false;
      lastError = null;
      if (res && res.changed) {
        var n = res.summary ? res.summary.rows : 0;
        status('Saved' + (n ? ' · ' + n + (n === 1 ? ' row' : ' rows') : ''), 'saved');
      } else {
        status('No changes', 'saved');
      }
      if (pendingAgain) { pendingAgain = false; doSave(); }
    }).catch(function (err) {
      inFlight = false;
      lastError = err;

      // The session lapsed mid-session. Ask for credentials and retry the
      // save, so the user does not lose the edit they just made.
      if (err.status === 401) {
        try { window.localStorage.removeItem('aglc-token'); } catch (e) {}
        status('Session expired — sign in again', 'error');
        showLogin('expired').then(function () { doSave(); });
        return;
      }

      status('Not saved — ' + err.message, 'error');
      console.error('[CRM] save failed:', err);
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DELAY);
  }

  // Try not to lose the last edit when the tab closes.
  window.addEventListener('beforeunload', function () {
    if (!saveTimer && !pendingAgain) return;
    clearTimeout(saveTimer);
    if (!state) return;
    try {
      request('PUT', '/state', state, { keepalive: true });
    } catch (e) { /* best effort */ }
  });

  // -------------------------------------------------------------------
  // public surface
  // -------------------------------------------------------------------

  window.CRM = {
    /** The live state object. app.js mutates this in place. */
    get state() { return state; },
    set state(v) { state = v; },

    /** Run fn once the state has arrived (immediately if it already has). */
    ready: function (fn) {
      if (booted && !bootError) fn(state);
      else if (booted && bootError) return;       // fatal screen is already up
      else queue.push(fn);
    },

    /** Called by the app's save(). Debounced; the newest state always wins. */
    save: function (next) {
      if (next) state = next;
      scheduleSave();
    },

    /** Force an immediate write and resolve when the server confirms it. */
    flush: function () {
      clearTimeout(saveTimer);
      return request('PUT', '/state', state);
    },

    /** Reload from the database, discarding anything unsaved. */
    reload: function () {
      return request('GET', '/state').then(function (res) {
        state = res.data;
        return state;
      });
    },

    /** Re-seed the demo data server-side and adopt the fresh state. */
    reset: function () {
      clearTimeout(saveTimer);
      status('Resetting…', 'saving');
      return request('POST', '/state/reset').then(function (res) {
        state = res.data;
        status('Demo data reset', 'saved');
        return state;
      }).catch(function (err) {
        status('Reset failed — ' + err.message, 'error');
        notify('Reset failed: ' + err.message);
        throw err;
      });
    },

    /** Generic access to the REST resources, for anything beyond state. */
    get: function (path, params) {
      var qs = '';
      if (params) {
        var parts = [];
        for (var k in params) {
          if (params[k] === undefined || params[k] === '') continue;
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
        if (parts.length) qs = '?' + parts.join('&');
      }
      return request('GET', path + qs);
    },
    post: function (path, body) { return request('POST', path, body); },
    patch: function (path, body) { return request('PATCH', path, body); },
    del: function (path) { return request('DELETE', path); },

    /** The signed-in user, as the server described them, or null. */
    user: function () {
      return window.CRMLogin ? window.CRMLogin.user() : null;
    },

    /** Drop the token and go to /login so another account can be used. */
    logout: function () {
      if (window.CRMLogin) window.CRMLogin.signOut();
    },

    /** Show the sign-in page on demand. Resolves with the new user. */
    login: function () { return showLogin('switch'); },

    status: status,
    lastError: function () { return lastError; }
  };

  // Kick the load off straight away; app.js waits on CRM.ready().
  bootstrap();
})();
