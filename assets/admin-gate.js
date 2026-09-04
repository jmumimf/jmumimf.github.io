/* ============================================================================
 * admin-gate.js — the passcode screen shared by both dashboards.
 *
 * With a backend, the backend decides: the typed code goes to /admin-check and
 * is then attached to every request that needs privileged data (the Estimathon
 * answer key, form responses). Without a backend there is nothing to ask, so
 * it falls back to the published constant in config.js, which is a courtesy
 * lock and nothing more.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var API = global.ESTIMATHON_API || null;
  var UNLOCK_KEY = 'estimathon:adminUnlocked';

  /* Resolves { ok, reason }. A backend we cannot reach is NOT a wrong
     passcode, and saying so saves a long hunt for the right one when the real
     problem is CORS or a Worker that is down. */
  function check(code) {
    if (!code) return Promise.resolve({ ok: false, reason: 'empty' });

    if (!API) {
      var local = global.ADMIN_PASSCODE || '';
      var ok = !!local && code.toLowerCase() === local.toLowerCase();
      return Promise.resolve({ ok: ok, reason: ok ? 'ok' : 'wrong' });
    }

    return fetch(API + '/admin-check?key=' + encodeURIComponent(code))
      .then(function (r) {
        if (!r.ok) return { ok: false, reason: 'status', status: r.status };
        return r.json().then(function (j) {
          return { ok: !!j.ok, reason: j.ok ? 'ok' : 'wrong' };
        });
      })
      .catch(function (err) {
        return { ok: false, reason: 'unreachable', error: err };
      });
  }

  function verify(code) {
    return check(code).then(function (r) { return r.ok; });
  }

  function messageFor(result) {
    if (result.reason === 'unreachable') {
      return 'Could not reach the backend at ' + API + '. The passcode was ' +
             'never checked. Usually this is the page being served from an ' +
             'origin the Worker does not allow, or the Worker being down — ' +
             'open the console for the exact error.';
    }
    if (result.reason === 'status') {
      return 'The backend answered ' + result.status + ' instead of checking ' +
             'the passcode. It may be missing the /admin-check endpoint.';
    }
    if (!API) {
      return 'Not quite. With no backend, the passcode is ADMIN_PASSCODE in ' +
             'config.js.';
    }
    return 'Not quite. In production the passcode is the Worker’s ' +
           'ADMIN_CODE secret, not the one in config.js.';
  }

  /* opts: { gate, form, input, error, view, onUnlock(code) } */
  function mount(opts) {
    var unlocked = false;

    function unlock(code) {
      if (unlocked) return;
      unlocked = true;
      opts.gate.hidden = true;
      opts.view.hidden = false;
      opts.onUnlock(code);
    }

    opts.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = opts.input.value.trim();
      opts.error.hidden = true;
      check(code).then(function (result) {
        if (!result.ok) {
          opts.error.textContent = messageFor(result);
          opts.error.hidden = false;
          if (result.error) console.error('Estimathon admin check failed:', result.error);
          opts.input.select();
          return;
        }
        try { sessionStorage.setItem(UNLOCK_KEY, code); } catch (err) {}
        unlock(code);
      });
    });

    /* Survive a refresh without retyping. */
    try {
      var saved = sessionStorage.getItem(UNLOCK_KEY);
      if (saved) check(saved).then(function (r) { if (r.ok) unlock(saved); });
    } catch (err) { /* private mode: just show the gate */ }
  }

  global.AdminGate = {
    mount: mount, verify: verify, check: check, usingRemote: !!API
  };
})(window);
