/**
 * Sign-in page.
 *
 * Loaded before web/api.js, which calls CRMLogin.show() whenever the server
 * answers 401 - at boot, or mid-session when a token lapses. It is also
 * reachable on demand at /login, which is what the top bar's sign-out button
 * navigates to, so you can come back and sign in as somebody else.
 *
 * Styling lives in web/login.css. Both files are hand-maintained:
 * scripts/build-frontend.js links them but never generates them.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'aglc-token';   // shared with web/api.js
  var USER_KEY = 'aglc-user';
  var ROLE_KEY = 'aglc-role';     // read by web/boot.js

  /**
   * Backend roles are the permission model (6 of them). The prototype's
   * ROLES map in boot.js is something else: 17 desk personas, each with a
   * home screen and a navigation whitelist. Signing in as Dr. Sara should
   * land on the pharmacy desk, so the two have to be mapped.
   *
   * Desk is checked first, because one backend role covers two very
   * different desks - both Priya (Support) and Yusuf (Sourcing) are agents.
   */
  var BY_DESK = {
    'Sales': 'dsales', 'Marketing': 'dmkt', 'Digital marketing': 'ddigital',
    'Design': 'ddesign', 'Support': 'dsupport', 'Processing': 'dproc',
    'Shipping': 'dship', 'Warehouse': 'dwh', 'Sourcing': 'dsource',
    'Pharmacy': 'dpharm', 'Quality': 'dqual', 'Quality & regulatory': 'dqual',
    'Pharmacovigilance': 'dqual', 'Accounts': 'dacct', 'Legal': 'dlegal',
    'HR & admin': 'dadmin', 'IT & systems': 'dit'
  };

  var BY_ROLE = {
    'role-admin': 'admin',
    'role-manager': 'dsales',
    'role-agent': 'dsupport',
    'role-pharm': 'dpharm',
    'role-qa': 'dqual',
    'role-view': 'sbu'
  };

  var AVATAR_COLOUR = {
    'role-admin': '#1b3c8f', 'role-manager': '#2e8fe8', 'role-agent': '#0e7c8c',
    'role-pharm': '#29a0a6', 'role-qa': '#1e7d34', 'role-view': '#5b34c9'
  };

  function personaFor(acct) {
    if (!acct) return 'admin';
    // An admin is not tied to a desk - they get the view with everything on.
    if (acct.roleId === 'role-admin') return 'admin';
    return BY_DESK[acct.desk] || BY_ROLE[acct.roleId] || 'admin';
  }

  // ------------------------------------------------------------------
  // storage helpers - every one of these can throw in private mode
  // ------------------------------------------------------------------

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }
  function drop(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }

  function storedUser() {
    var raw = read(USER_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // ------------------------------------------------------------------
  // transport - deliberately standalone, so the sign-in page works even
  // if api.js has not finished loading
  // ------------------------------------------------------------------

  function call(method, path, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch('/api' + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (!res.ok) {
          var err = new Error(payload.error || res.status + ' ' + res.statusText);
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    });
  }

  // ------------------------------------------------------------------
  // the page
  // ------------------------------------------------------------------

  var open = null;        // the in-flight promise, so show() is idempotent

  function show(opts) {
    if (open) return open;
    opts = opts || {};

    open = new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.id = 'crm-login';
      wrap.innerHTML = template(opts.reason);
      document.body.appendChild(wrap);
      document.body.style.overflow = 'hidden';

      var form = wrap.querySelector('#lg-form');
      var email = wrap.querySelector('#lg-email');
      var pass = wrap.querySelector('#lg-pass');
      var errBox = wrap.querySelector('#lg-err');
      var button = wrap.querySelector('#lg-go');
      var users = wrap.querySelector('#lg-users');
      var note = wrap.querySelector('#lg-note');

      var demoPassword = null;
      var busyRow = null;

      function fail(message) {
        errBox.textContent = message;
        button.disabled = false;
        button.textContent = 'Sign in';
        if (busyRow) {
          busyRow.removeAttribute('aria-busy');
          busyRow = null;
        }
        enableRows(true);
      }

      function enableRows(on) {
        var rows = users.querySelectorAll('.lg-user');
        for (var i = 0; i < rows.length; i++) rows[i].disabled = !on;
      }

      function attempt(row) {
        errBox.textContent = '';
        button.disabled = true;
        button.textContent = 'Signing in…';
        if (row) {
          busyRow = row;
          row.setAttribute('aria-busy', 'true');
          enableRows(false);
          row.disabled = false;
        }

        call('POST', '/auth/login', {
          email: email.value.trim(),
          password: pass.value
        }).then(function (res) {
          write(TOKEN_KEY, res.token);
          write(USER_KEY, JSON.stringify(res.user));
          applyPersona(personaFor({
            roleId: res.user.role && res.user.role.id,
            desk: res.user.desk
          }));
          document.body.style.overflow = '';
          wrap.remove();
          open = null;
          mountSignOut();
          watchIdentity();
          resolve(res.user);
        }).catch(function (err) {
          fail(err.status === 401
            ? 'That email and password do not match an account.'
            : err.message);
          pass.select();
        });
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        attempt(null);
      });

      // ---- the account picker ----
      call('GET', '/auth/accounts').then(function (res) {
        if (!res.demo || !res.data || !res.data.length) {
          // Not a demo build: the plain form is the whole page.
          users.parentNode.removeChild(users);
          var legend = wrap.querySelector('#lg-legend');
          if (legend) legend.parentNode.removeChild(legend);
          var sub = wrap.querySelector('.lg-sub');
          if (sub) sub.textContent = 'Use your work address to continue.';
          if (res.requireAuth === false) note.textContent =
            'This server is not enforcing sign-in, so the app will open either way.';
          else note.textContent = '';
          return;
        }

        demoPassword = res.password || null;
        res.data.forEach(function (acct) {
          users.appendChild(row(acct));
        });

        note.innerHTML = demoPassword
          ? 'Demo accounts. Pick one to sign in, or type an address above. ' +
            'They all share the password <code>' + esc(demoPassword) + '</code>.' +
            (res.requireAuth === false
              ? '<br>The server is not enforcing sign-in here, so your choice sets the view rather than the access.'
              : '')
          : 'Pick an account to fill the form in.';
      }).catch(function () {
        users.parentNode.removeChild(users);
        var legend = wrap.querySelector('#lg-legend');
        if (legend) legend.parentNode.removeChild(legend);
        note.textContent = 'Could not reach the server to list accounts. ' +
          'You can still sign in with an email address.';
      });

      function row(acct) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lg-user';

        var av = document.createElement('span');
        av.className = 'lg-av';
        av.style.background = AVATAR_COLOUR[acct.roleId] || '#55637a';
        av.textContent = acct.avatar || initials(acct.name);

        var who = document.createElement('span');
        who.className = 'lg-who';
        var nm = document.createElement('span');
        nm.className = 'lg-nm';
        nm.textContent = acct.name;
        var jt = document.createElement('span');
        jt.className = 'lg-jt';
        jt.textContent = acct.desk
          ? acct.jobTitle + ' · ' + acct.desk
          : acct.jobTitle || acct.email;
        who.appendChild(nm);
        who.appendChild(jt);

        var chip = document.createElement('span');
        chip.className = 'lg-chip';
        chip.textContent = acct.roleName;

        btn.appendChild(av);
        btn.appendChild(who);
        btn.appendChild(chip);
        btn.title = acct.email + (acct.roleDescription ? ' — ' + acct.roleDescription : '');

        btn.addEventListener('click', function () {
          email.value = acct.email;
          if (demoPassword) {
            pass.value = demoPassword;
            attempt(btn);
          } else {
            // No shared password to offer: fill the address and let them type.
            pass.focus();
          }
        });
        return btn;
      }

      // The address field is the sensible focus on a desktop. On a phone,
      // focusing it opens the keyboard over the account list, so don't.
      if (!window.matchMedia('(max-width: 880px)').matches) email.focus();
    });

    return open;
  }

  function template(reason) {
    var flash = '';
    if (reason === 'expired') {
      flash = '<p class="lg-flash">Your session has expired. Sign in again and ' +
              'the change you just made will be saved.</p>';
    } else if (reason === 'switch') {
      flash = '<p class="lg-flash">Signed out. Pick an account to carry on.</p>';
    }

    return '' +
      '<section class="lg-brand">' +
        '<div class="lg-mark"><i>AG</i><span>Apple Globalcare</span></div>' +
        '<h2>Named-patient supply, end to end.</h2>' +
        '<p>Service desk, sourcing, quotes, prescriptions, QA release, cold chain ' +
        'and the warehouse wave - one record per case, from the first enquiry to ' +
        'the batch that ships.</p>' +
        '<div class="lg-facts">' +
          '<div><b id="lg-n-cases">—</b><span>Cases</span></div>' +
          '<div><b id="lg-n-tickets">—</b><span>Tickets</span></div>' +
          '<div><b id="lg-n-orders">—</b><span>Orders</span></div>' +
          '<div><b id="lg-n-suppliers">—</b><span>Suppliers</span></div>' +
        '</div>' +
      '</section>' +

      '<div class="lg-pane">' +
        '<form class="lg-card" id="lg-form" autocomplete="on">' +
          '<h1>Sign in</h1>' +
          '<p class="lg-sub">Use your work address, or choose a demo account.</p>' +
          flash +

          '<label for="lg-email">Email address</label>' +
          '<input id="lg-email" name="username" type="email" required ' +
            'autocomplete="username" autocapitalize="off" spellcheck="false" ' +
            'placeholder="you@appleglobalcare.com">' +

          '<label for="lg-pass">Password</label>' +
          '<input id="lg-pass" name="password" type="password" required ' +
            'autocomplete="current-password">' +

          '<div class="lg-err" id="lg-err" role="alert"></div>' +
          '<button class="lg-go" id="lg-go" type="submit">Sign in</button>' +

          '<p class="lg-legend" id="lg-legend">Or continue as</p>' +
          '<div class="lg-users" id="lg-users"></div>' +

          '<p class="lg-note" id="lg-note"></p>' +
        '</form>' +
      '</div>';
  }

  /** Real numbers from the public health endpoint - cosmetic, never blocking. */
  function fillFacts() {
    call('GET', '/health').then(function (res) {
      var c = res.counts || {};
      var set = function (id, n) {
        var el = document.getElementById(id);
        if (el && typeof n === 'number') el.textContent = n.toLocaleString();
      };
      set('lg-n-cases', c.cases);
      set('lg-n-tickets', c.tickets);
      set('lg-n-orders', c.orders);
      set('lg-n-suppliers', c.suppliers);
    }).catch(function () { /* the panel just keeps its dashes */ });
  }

  // ------------------------------------------------------------------
  // handing the signed-in user to the app
  // ------------------------------------------------------------------

  /**
   * boot.js reads aglc-role once, at load, and then applies it from inside a
   * CRM.ready callback. Writing the key alone is therefore not enough on a
   * first sign-in - boot has already captured the old value. Driving the
   * "View as" select instead goes through boot's own change handler, which is
   * the only public way into its applyRole().
   *
   * Queued on CRM.ready so it lands after boot's own callback; the queue is
   * first-in-first-out, and boot registered first.
   */
  function applyPersona(key) {
    write(ROLE_KEY, key);
    var go = function () {
      var sel = document.getElementById('viewas');
      if (!sel) return;
      sel.value = key;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (window.CRM && window.CRM.ready) window.CRM.ready(go);
    else go();
  }

  // ------------------------------------------------------------------
  // sign out / switch user
  // ------------------------------------------------------------------

  function signOut() {
    // Best effort: clear the cookie server-side, but do not wait on it.
    try { call('POST', '/auth/logout'); } catch (e) {}
    drop(TOKEN_KEY);
    drop(USER_KEY);
    window.location.href = '/login';
  }

  /**
   * Keep the top bar's identity block showing who actually signed in.
   *
   * applyRole() rewrites .me from the prototype's own ROLES map, so signing
   * in as Maria L. and landing on the sales desk would label you "Marco B."
   * - that map's placeholder for the desk. The signed-in account has to win.
   *
   * Done with an observer rather than boot.js's __onRole hook, because
   * app.js already owns that hook and whichever file assigned it last would
   * silently drop the other. The guard makes our own write a no-op, so the
   * observer does not retrigger itself.
   */
  function paintIdentity() {
    var user = storedUser();
    if (!user) return;                       // nobody signed in: leave it be
    var me = document.querySelector('.me');
    if (!me) return;

    var current = me.querySelector('.crm-me-name');
    if (current && current.textContent === user.name) return;

    var role = (user.role && user.role.name) || '';
    var sub = user.jobTitle || role;
    me.innerHTML =
      '<div class="avatar">' + esc(user.avatar || initials(user.name)) + '</div>' +
      '<div><div class="crm-me-name" style="font-size:11.5px;font-weight:500">' +
        esc(user.name) + '</div>' +
      '<div class="rl" style="font-size:10px;color:#8b98ab">' + esc(sub) + '</div></div>';
    me.title = user.email + (role ? ' · ' + role : '');
  }

  function watchIdentity() {
    var me = document.querySelector('.me');
    if (!me || me.__crmWatched) return;
    me.__crmWatched = true;
    paintIdentity();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(paintIdentity).observe(me, { childList: true, subtree: true });
    }
  }

  /**
   * A sign-out button in the top bar, next to the identity block.
   *
   * Injected rather than written into the markup for two reasons: index.html
   * is generated by the build, and applyRole() rewrites .me's innerHTML on
   * every role change - anything inside it would be destroyed. This sits
   * beside it instead.
   */
  function mountSignOut() {
    if (document.getElementById('crm-signout')) return;
    var me = document.querySelector('.me');
    if (!me || !me.parentNode) return;

    var btn = document.createElement('button');
    btn.id = 'crm-signout';
    btn.type = 'button';
    btn.title = 'Sign out and switch user';
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'style="vertical-align:-2px"><path d="M12.5 6.5V4.2a1.2 1.2 0 0 0-1.2-1.2H4.7a1.2 1.2 0 0 0-1.2 1.2v11.6a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V13.5"/>' +
      '<path d="M8 10h8.5M14 7.5 16.5 10 14 12.5"/></svg><span> Sign out</span>';
    btn.addEventListener('click', signOut);
    me.parentNode.insertBefore(btn, me.nextSibling);
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    // /login is an explicit request for this page, whatever the token says.
    if (window.location.pathname.replace(/\/+$/, '') === '/login') {
      drop(TOKEN_KEY);
      show({ reason: 'switch' }).then(function () {
        window.history.replaceState({}, '', '/');
        // api.js holds the state; it has to re-read it as the new user.
        if (window.CRM && window.CRM.reload) window.CRM.reload();
      });
    }
    if (document.getElementById('crm-login')) fillFacts();
    if (read(TOKEN_KEY) || storedUser()) { mountSignOut(); watchIdentity(); }
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    return String(name || '?')
      .replace(/^(Dr|Mr|Mrs|Ms)\.?\s+/i, '')
      .split(/\s+/).slice(0, 2)
      .map(function (p) { return p.charAt(0).toUpperCase(); })
      .join('');
  }

  window.CRMLogin = {
    /** Show the page. Resolves with the signed-in user. Idempotent. */
    show: function (opts) {
      var p = show(opts);
      fillFacts();
      return p;
    },
    /**
     * Take the server's word for who is signed in.
     *
     * The session cookie is httpOnly and outlives localStorage, so after a
     * cleared cache - or in a second tab - the app can be authenticated as
     * somebody localStorage knows nothing about. api.js calls this with the
     * answer from /auth/me so the top bar names the real account.
     */
    adopt: function (user) {
      if (!user || !user.id) return;
      var known = storedUser();
      if (known && known.id === user.id) return;
      write(USER_KEY, JSON.stringify(user));
      mountSignOut();
      watchIdentity();
      paintIdentity();
    },

    signOut: signOut,
    mountSignOut: mountSignOut,
    paintIdentity: paintIdentity,
    personaFor: personaFor,
    user: storedUser
  };
})();
