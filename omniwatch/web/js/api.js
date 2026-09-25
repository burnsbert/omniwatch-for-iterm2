// api.js — thin client for the HTTP API described in DESIGN.md §4.4.
//
// DOM-independent: uses only the global `fetch`. The auth cookie
// (`ow_session`, set by GET /auth?token=...) is sent automatically by the
// browser for same-origin requests, so no token handling happens here
// (per §4.5, the token is never put in the page).
//
// Error shape from the server: {"ok":false,"error":{"code":"...","message":"..."}}.
// On any non-2xx response, or `ok:false`, this module throws an Error whose
// `.code` and `.status` carry the server's error code / HTTP status so
// callers can branch on them (e.g. 409 `stale_screen` for quick reply).

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] prefix for every request path (default: '')
 * @param {Function} [opts.fetchImpl] injectable fetch (tests / non-global environments)
 */
export function createApi({ baseUrl = '', fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!doFetch) {
    throw new Error('api.js: no fetch implementation available; pass fetchImpl');
  }

  async function request(method, path, body) {
    const init = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers = JSON_HEADERS;
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(`${baseUrl}${path}`, init);
    } catch (cause) {
      const e = new Error(`network error calling ${method} ${path}: ${cause.message}`);
      e.code = 'network_error';
      e.cause = cause;
      throw e;
    }
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (_) {
        json = null;
      }
    }
    if (!res.ok || (json && json.ok === false)) {
      const errShape = (json && json.error) || {};
      const e = new Error(errShape.message || `HTTP ${res.status} for ${method} ${path}`);
      e.code = errShape.code || 'unknown';
      e.status = res.status;
      throw e;
    }
    return json;
  }

  const encode = (uid) => encodeURIComponent(uid);

  return {
    request, // exposed for endpoints not yet enumerated (forward-compat)

    health: () => request('GET', '/api/v1/health'),
    getState: () => request('GET', '/api/v1/state'),
    summary: () => request('GET', '/api/v1/summary'),
    diagnostics: () => request('GET', '/api/v1/diagnostics'),
    probeAutomation: () => request('POST', '/api/v1/diagnostics/probe-automation'),

    goto: (uid) => request('POST', `/api/v1/sessions/${encode(uid)}/goto`),
    visit: (uid) => request('POST', `/api/v1/sessions/${encode(uid)}/visit`),
    setLabel: (uid, label) => request('PUT', `/api/v1/sessions/${encode(uid)}/label`, { label }),
    setColor: (uid, colorOrProject) => {
      const body = typeof colorOrProject === 'number'
        ? { project: colorOrProject }
        : { color: colorOrProject };
      return request('PUT', `/api/v1/sessions/${encode(uid)}/color`, body);
    },
    setMuted: (uid, muted) => request('PUT', `/api/v1/sessions/${encode(uid)}/mute`, { muted }),
    closeTab: (uid) => request('POST', `/api/v1/sessions/${encode(uid)}/close`, { confirm: true }),
    reply: (uid, { text, submit = false, expectHash }) => request(
      'POST',
      `/api/v1/sessions/${encode(uid)}/reply`,
      { text, submit, expect_hash: expectHash },
    ),

    newTab: () => request('POST', '/api/v1/tabs/new'),
    launchIterm: () => request('POST', '/api/v1/iterm/launch'),
    refresh: () => request('POST', '/api/v1/refresh'),

    getPrefs: () => request('GET', '/api/v1/prefs'),
    patchPrefs: (patch) => request('PATCH', '/api/v1/prefs', patch),

    setProject: (slot, name) => request('PUT', `/api/v1/projects/${slot}`, { name }),
    clearProjects: () => request('DELETE', '/api/v1/projects', { confirm: true }),

    quotaEmailDraft: () => request('POST', '/api/v1/quota-email/draft'),
    quotaEmailSkip: () => request('POST', '/api/v1/quota-email/skip'),

    shutdown: () => request('POST', '/api/v1/shutdown'),

    demoStep: (seconds) => request('POST', '/api/v1/demo/step', { seconds }),
    demoScenario: (name) => request('POST', '/api/v1/demo/scenario', { name }),
  };
}

/** Default instance bound to the global fetch, for direct browser use. */
export const api = (typeof fetch !== 'undefined') ? createApi() : null;
