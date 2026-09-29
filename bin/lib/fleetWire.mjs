/**
 * EVERY `/fleet/*` ENDPOINT, derived from the one roster URL.
 *
 * One place configures the API base (`FLEET_URL`, overridable by
 * `FLOWVIANT_FLEET_URL`, ending in `/fleet/agents`) and every other daemon
 * endpoint is that URL with its final `agents` segment swapped — so a
 * self-hosted server, or the `/api` → `/api/v2` alias, is honoured by every
 * lane at once.
 *
 * ONE HOME (SOLID audit 2026-09-26, F166). The swap was spelled
 * `FLEET_URL.replace(/\/agents\/?$/, '/…')` forty-nine times across eighteen
 * files; a change to the roster URL's shape, or to what counts as a valid
 * endpoint name, was forty-nine edits.
 *
 * WHAT IT VALIDATES, AND WHAT IT DELIBERATELY DOES NOT. An endpoint NAME that
 * is not a plain lowercase path is a programming error and throws. A ROSTER
 * URL that does not end in `/agents` is NOT refused here: endpoints are
 * derived while modules load (fleetReports.mjs, landed.mjs, login.mjs), and a throw
 * there took down every command — `help` and `projects` included — over a
 * setting only the daemon's lanes use (measured while making this change). Such
 * a URL comes back unchanged, exactly as the forty-nine copies answered, and
 * the roster poll against it is the first thing to fail and say so.
 *
 * The push channel (`STREAM_URL` in config.mjs) is the one derivation kept
 * apart: it switches the scheme to ws and keeps a trailing slash.
 *
 * A leaf on purpose: it takes the roster URL as an argument rather than
 * importing `config.mjs`, so modules that are handed a `fleetUrl` (the
 * artifact reporter, the knowledge fetcher, the tray's remote status) do not
 * gain a config import to name a path.
 */

const ROSTER_TAIL = /\/agents\/?$/;
const NAME = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

/**
 * The `/fleet/<name>` endpoint beside the roster URL `rosterUrl`
 * (`https://api.flowviant.com/api/fleet/agents` → `…/api/fleet/<name>`). A
 * trailing slash on the roster URL is accepted and not carried over.
 */
export function fleetEndpoint(name, rosterUrl) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(`fleetEndpoint: "${name}" is not a /fleet endpoint name`);
  }
  return String(rosterUrl).replace(ROSTER_TAIL, `/${name}`);
}
