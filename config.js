/* ============================================================================
 * config.js — where the pages look for their backend.
 *
 * This is the ONE file to edit when you deploy. It is loaded before
 * estimathon.js on both pages.
 *
 *   ""    -> no backend. State lives in this browser only (localStorage),
 *            synced across tabs on one machine. Fine for testing; teams on
 *            other devices cannot see each other.
 *
 *   a URL -> every page talks to that backend, from anywhere. This is what
 *            makes https://jmumimf.github.io playable without a tunnel.
 *
 * Note there is no trailing slash, and the URL must be https:// — a page
 * served over https cannot call a plain http backend; browsers block it.
 *
 * When server.py serves these pages itself it overrides this with "/api",
 * so running locally keeps working no matter what is set here.
 * ==========================================================================*/
window.ESTIMATHON_API = "";
