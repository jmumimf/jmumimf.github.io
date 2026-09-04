/* ============================================================================
 * config.js, where the pages look for their backend.
 *
 * This is the ONE file to edit when you deploy. It is loaded before everything
 * else on both the Estimathon and the forms pages.
 * ==========================================================================*/

/* The deployed Cloudflare Worker. No trailing slash, and https:// — a page
   served over https cannot call a plain http backend. */
var DEPLOYED_API = "https://estimathon.jmumimf.workers.dev";

/* Only talk to the deployed Worker when the page is actually being served from
   somewhere it will accept.
 *
 * The Worker sends `Access-Control-Allow-Origin: https://jmumimf.github.io`.
 * A page opened from disk, or served by Live Server on localhost:5500, is a
 * different origin, so the browser blocks every call before it is even sent —
 * which looks exactly like "forms won't load" and "the passcode is wrong".
 *
 * So: on localhost or file://, default to no backend. The pages then use
 * forms.json and localStorage, which is what you want for poking at the UI.
 * `server.py` overrides this with "/api" on the line it injects just below,
 * so running the real local server still gets the real local API.
 *
 * To aim a local page at the deployed Worker on purpose, set ALLOW_ORIGIN to
 * "*" in worker/wrangler.toml, redeploy, and set FORCE_DEPLOYED_API below. */
var FORCE_DEPLOYED_API = false;

(function () {
  var host = location.hostname;
  var isLocal = host === '' ||            /* file:// */
                host === 'localhost' ||
                host === '127.0.0.1' ||
                host === '[::1]' ||
                host.endsWith('.local');

  window.ESTIMATHON_API = (isLocal && !FORCE_DEPLOYED_API) ? "" : DEPLOYED_API;
})();

/* ---------------------------------------------------------------------------
 * LOCAL-ONLY admin passcode, shared by the Estimathon dashboard and the forms
 * dashboard. This file is public — GitHub Pages serves it verbatim — so treat
 * this string as published, not secret.
 *
 * In production the Worker's ADMIN_CODE secret is what actually gates the
 * answer key and the form responses, and it MUST be a different string from
 * this one, or reading this file is enough to get in. This value only applies
 * when there is no backend at all.
 *
 * server.py finds this line by its marker comment, so the variable may be
 * renamed but the marker has to stay.
 * ------------------------------------------------------------------------- */
window.ADMIN_PASSCODE = 'local-dev'; /* admin-passcode */
