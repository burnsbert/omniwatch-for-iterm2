"""Pure, testable logic for the Omniwatch iTerm2 status-bar plugin
(docs/DESIGN.md §4.8, §7 WP10).

This module has **no** dependency on the `iterm2` package (which only
exists inside iTerm2's bundled Python environment) and **no** dependency
on the `omniwatch` package (the plugin runs in a different Python
process — and often a different Python environment — than the backend).
It's stdlib-only so it can be imported and unit-tested from anywhere;
`omniwatch_status.py` (the actual AutoLaunch script, installed alongside
this file) imports it and wires it to the real `iterm2` API.

Runtime discovery duplicates omniwatch/runtime.py's file format and
validation (kept in sync by hand — see the docstring there) rather than
importing it, for the reason above.
"""
import http.client
import json
import os

DEFAULT_TIMEOUT = 2.0
UPDATE_CADENCE_SECONDS = 2  # matches docs/DESIGN.md §4.8 "polls ... every 2 s"


# ---------------------------------------------------------------------
# runtime.json discovery (mirrors omniwatch/runtime.py + omniwatch/config.py)
# ---------------------------------------------------------------------

def default_config_dir(env=None):
    env = os.environ if env is None else env
    override = env.get('OMNIWATCH_CONFIG_DIR')
    if override:
        return override
    xdg = env.get('XDG_CONFIG_HOME')
    base = xdg or os.path.join(os.path.expanduser('~'), '.config')
    return os.path.join(base, 'omniwatch')


def runtime_path(env=None):
    return os.path.join(default_config_dir(env), 'runtime.json')


def read_runtime_file(path):
    """Same validation as omniwatch.runtime.read(): {"port", "pid",
    "token", ...} or None if missing/unreadable/malformed."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get('port'), int) or not isinstance(data.get('pid'), int):
        return None
    if not isinstance(data.get('token'), str):
        return None
    return data


def pid_alive(pid, kill=os.kill):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def read_live_runtime(path, pid_alive_fn=pid_alive):
    """The runtime info of a backend that is still running, else None."""
    info = read_runtime_file(path)
    if info and pid_alive_fn(info['pid']):
        return info
    return None


# ---------------------------------------------------------------------
# HTTP client — stdlib http.client (not urllib.request), so it can be
# exercised in tests against a real loopback-only http.server.HTTPServer
# the same way docs/DESIGN.md §5 has the server's own route tests do
# ("real ThreadingHTTPServer on port 0 in-thread, http.client").
# ---------------------------------------------------------------------

class BackendUnavailable(Exception):
    """No live backend, or the request to it failed."""


def request_json(runtime, method, path, body=None, timeout=DEFAULT_TIMEOUT,
                 connection_factory=http.client.HTTPConnection):
    """One request to the local Omniwatch backend described by `runtime`
    (a dict with at least "port" and "token"). Raises BackendUnavailable
    on any connection or HTTP-level failure; returns the parsed JSON body
    (or {} for an empty body) on success."""
    conn = connection_factory('127.0.0.1', runtime['port'], timeout=timeout)
    try:
        headers = {'Authorization': 'Bearer ' + runtime['token']}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        if resp.status >= 400:
            raise BackendUnavailable('%s %s -> %d' % (method, path, resp.status))
        if not data:
            return {}
        try:
            return json.loads(data.decode('utf-8'))
        except ValueError as e:
            raise BackendUnavailable('bad JSON from backend: %s' % e) from e
    except (OSError, http.client.HTTPException) as e:
        raise BackendUnavailable(str(e)) from e
    finally:
        conn.close()


def fetch_summary(runtime, **kwargs):
    """GET /api/v1/summary -> {tabs, agents, waiting, busy, waiting_sessions}."""
    return request_json(runtime, 'GET', '/api/v1/summary', **kwargs)


def post_goto(runtime, uid, **kwargs):
    """POST /api/v1/sessions/{uid}/goto (202, fire-and-forget from the
    plugin's point of view)."""
    return request_json(runtime, 'POST', '/api/v1/sessions/%s/goto' % uid,
                        body={}, **kwargs)


def post_plugin_focus(runtime, uid, **kwargs):
    """POST /api/v1/plugin/focus {"uid": uid} — visiting a waiting
    session in iTerm2 clears its attention (docs/DESIGN.md §4.8)."""
    return request_json(runtime, 'POST', '/api/v1/plugin/focus',
                        body={'uid': uid}, **kwargs)


# ---------------------------------------------------------------------
# uid mapping (mirrors omniwatch.itermcolor.uid_from_session_id)
# ---------------------------------------------------------------------

def uid_from_session_id(session_id):
    """iTerm2 Python API session ids are 'w0t2p0:GUID'; the GUID is what
    Omniwatch elsewhere calls a session's uid (AppleScript 'unique id')."""
    return session_id.rsplit(':', 1)[-1]


# ---------------------------------------------------------------------
# status-bar text + click target
# ---------------------------------------------------------------------

NO_BACKEND_TEXT = 'Omniwatch off'


def format_status(summary):
    """`◉ 2 waiting`, '' (hidden — no one's waiting), or 'Omniwatch off'
    (summary is None: no live backend, or the request failed)."""
    if summary is None:
        return NO_BACKEND_TEXT
    waiting = summary.get('waiting') or 0
    if not waiting:
        return ''
    return '◉ %d waiting' % waiting  # '◉'


def next_waiting_uid(summary):
    """The longest-waiting session's uid (waiting_sessions is already
    longest-first — see omniwatch.views.summary_endpoint), or None."""
    if not summary:
        return None
    sessions = summary.get('waiting_sessions') or []
    return sessions[0]['uid'] if sessions else None


def poll_once(path=None, env=None, timeout=DEFAULT_TIMEOUT,
             connection_factory=http.client.HTTPConnection):
    """One full poll cycle: discover the runtime file, fetch the
    summary if the backend is alive. Returns (status_text, summary or
    None). Never raises — any failure degrades to the "off" state, since
    this drives a status bar that must never crash iTerm2's script host.
    """
    runtime = read_live_runtime(path or runtime_path(env))
    if runtime is None:
        return NO_BACKEND_TEXT, None
    try:
        summary = fetch_summary(runtime, timeout=timeout,
                                connection_factory=connection_factory)
    except BackendUnavailable:
        return NO_BACKEND_TEXT, None
    return format_status(summary), summary


def handle_click(path=None, env=None, timeout=DEFAULT_TIMEOUT,
                 connection_factory=http.client.HTTPConnection,
                 open_app=None, clicked_session_id=None):
    """Click the status-bar item: go to the next waiting session, or —
    with no live backend — launch the app. Returns a short result string
    for logging; never raises.

    `clicked_session_id` (the session whose status bar instance was
    clicked, per iTerm2's `onclick` callback) is accepted but not used to
    choose the goto target — Omniwatch always jumps to the
    longest-waiting session regardless of which status bar was clicked
    (docs/DESIGN.md §4.8) — it's only threaded through for future
    logging/debugging use."""
    del clicked_session_id  # currently informational only; see docstring
    runtime = read_live_runtime(path or runtime_path(env))
    if runtime is None:
        if open_app is not None:
            open_app('Omniwatch')
        return 'no backend — opened Omniwatch'
    try:
        summary = fetch_summary(runtime, timeout=timeout,
                                connection_factory=connection_factory)
        uid = next_waiting_uid(summary)
        if uid is None:
            return 'no sessions waiting'
        post_goto(runtime, uid, timeout=timeout,
                 connection_factory=connection_factory)
        return 'goto %s' % uid
    except BackendUnavailable as e:
        return 'backend request failed: %s' % e


def handle_focus_changed(session_id, path=None, env=None,
                         timeout=DEFAULT_TIMEOUT,
                         connection_factory=http.client.HTTPConnection):
    """FocusMonitor pushed an active-session change: tell the backend so
    it can clear that session's attention latch immediately instead of
    waiting for the next snapshot poll (docs/DESIGN.md §4.8). No-ops
    quietly if there's no live backend. Returns a short result string for
    logging; never raises."""
    runtime = read_live_runtime(path or runtime_path(env))
    if runtime is None:
        return 'no backend'
    uid = uid_from_session_id(session_id)
    try:
        post_plugin_focus(runtime, uid, timeout=timeout,
                          connection_factory=connection_factory)
        return 'focus %s' % uid
    except BackendUnavailable as e:
        return 'focus push failed: %s' % e
