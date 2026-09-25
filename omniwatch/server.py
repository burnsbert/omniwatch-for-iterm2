"""HTTP API + static files (docs/DESIGN.md §4.4, §4.5; docs/SHELL_CONTRACT.md §4-§5).

``ThreadingHTTPServer`` bound to 127.0.0.1 only. Every ``/api/*`` route
goes through ``security.check_api`` (Host, token, Origin). Handler threads
never touch engine internals: they read the published state or call an
engine command, which runs on the engine thread.

Static files come from ``omniwatch/web/`` through ``pkgutil.get_data`` so
they load from inside the zipapp too, with a strict CSP.
"""
import json
import logging
import mimetypes
import os
import pkgutil
import posixpath
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from omniwatch import __version__, security, sse
from omniwatch.engine import ApiError

log = logging.getLogger('omniwatch.server')

MAX_BODY = 256 * 1024

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
}


def content_type(path):
    ext = posixpath.splitext(path)[1].lower()
    return CONTENT_TYPES.get(ext) or mimetypes.guess_type(path)[0] or \
        'application/octet-stream'


def safe_static_path(url_path):
    """Map a URL path to a resource path under web/, or None if it's not a
    plain relative file path (no '..', no empty/dot segments, no
    backslashes or NULs)."""
    rel = unquote(url_path).lstrip('/')
    if rel == '':
        return 'index.html'
    if '\\' in rel or '\x00' in rel:
        return None
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        return None
    return rel


# (method, path pattern, handler name). Pattern segments in braces capture
# one percent-decoded path segment.
ROUTES = (
    ('GET', '/api/v1/health', 'health'),
    ('GET', '/api/v1/state', 'state'),
    ('GET', '/api/v1/events', 'events'),
    ('GET', '/api/v1/summary', 'summary'),
    ('GET', '/api/v1/diagnostics', 'diagnostics'),
    ('POST', '/api/v1/diagnostics/probe-automation', 'probe'),
    ('POST', '/api/v1/sessions/{uid}/goto', 'goto'),
    ('POST', '/api/v1/sessions/{uid}/visit', 'visit'),
    ('PUT', '/api/v1/sessions/{uid}/label', 'label'),
    ('PUT', '/api/v1/sessions/{uid}/color', 'color'),
    ('PUT', '/api/v1/sessions/{uid}/mute', 'mute'),
    ('POST', '/api/v1/sessions/{uid}/close', 'close'),
    ('POST', '/api/v1/sessions/{uid}/reply', 'reply'),
    ('POST', '/api/v1/sessions/{uid}/reveal', 'reveal'),
    ('GET', '/api/v1/sessions/{uid}/history', 'history'),
    ('GET', '/api/v1/usage/history', 'usage_history'),
    ('GET', '/api/v1/stats', 'stats'),
    ('POST', '/api/v1/tabs/new', 'new_tab'),
    ('POST', '/api/v1/iterm/launch', 'launch'),
    ('POST', '/api/v1/refresh', 'refresh'),
    ('GET', '/api/v1/prefs', 'get_prefs'),
    ('PATCH', '/api/v1/prefs', 'patch_prefs'),
    ('PUT', '/api/v1/projects/{slot}', 'set_project'),
    ('DELETE', '/api/v1/projects', 'clear_projects'),
    ('POST', '/api/v1/quota-email/draft', 'quota_draft'),
    ('POST', '/api/v1/quota-email/skip', 'quota_skip'),
    ('POST', '/api/v1/plugin/focus', 'plugin_focus'),
    ('POST', '/api/v1/shutdown', 'shutdown'),
    ('POST', '/api/v1/demo/step', 'demo_step'),
    ('POST', '/api/v1/demo/scenario', 'demo_scenario'),
)
_COMPILED = tuple((m, tuple(pattern.strip('/').split('/')), name)
                  for m, pattern, name in ROUTES)


def match_route(method, path):
    """Returns (handler name, params) or raises ApiError 404/405."""
    segments = path.strip('/').split('/')
    allowed = []
    for m, pattern, name in _COMPILED:
        if len(pattern) != len(segments):
            continue
        params = {}
        for pat, seg in zip(pattern, segments):
            if pat.startswith('{'):
                value = unquote(seg)
                if not value:
                    break
                params[pat[1:-1]] = value
            elif pat != seg:
                break
        else:
            if m == method:
                return name, params
            allowed.append(m)
    if allowed:
        raise ApiError(405, 'method_not_allowed',
                       'use %s' % ', '.join(sorted(set(allowed))))
    raise ApiError(404, 'not_found', 'no route for %s' % path)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Omniwatch/' + __version__
    protocol_version = 'HTTP/1.0'   # one request per connection; SSE ends at close
    timeout = 30

    def log_message(self, fmt, *args):
        log.debug('%s %s', self.address_string(), fmt % args)

    # ---- plumbing --------------------------------------------------------

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def _common_headers(self):
        self.send_header('Content-Security-Policy', security.CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')

    def _send(self, status, body, ctype, extra=None, cache='no-store'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self._common_headers()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self._send(status, body, 'application/json; charset=utf-8')

    def _error(self, status, code, message):
        self._json(status, {'ok': False, 'error': {'code': code, 'message': message}})

    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise ApiError(400, 'bad_request', 'chunked bodies are not supported')
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ApiError(400, 'bad_request', 'bad Content-Length')
        if n < 0 or n > MAX_BODY:
            raise ApiError(400, 'bad_request', 'body too large')
        if n == 0:
            return {}
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, 'bad_request', 'invalid JSON')
        if not isinstance(body, dict):
            raise ApiError(400, 'bad_request', 'body must be a JSON object')
        return body

    def _dispatch(self):
        try:
            url = urlsplit(self.path)
            if url.path.startswith('/api/'):
                self._api(url)
            elif url.path == '/auth':
                self._auth(url)
            elif self.command == 'GET':
                self._static(url.path)
            else:
                self._error(404, 'not_found', url.path)
        except ApiError as e:
            self._error(e.status, e.code, e.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error('unhandled error for %s %s\n%s', self.command, self.path,
                      traceback.format_exc())
            try:
                self._error(500, 'internal', 'internal error')
            except Exception:
                pass

    # ---- unauthenticated routes -----------------------------------------

    def _auth(self, url):
        srv = self.server
        if not security.host_ok(self.headers, srv.port):
            raise ApiError(403, 'forbidden', 'bad Host header')
        if self.command != 'GET':
            raise ApiError(405, 'method_not_allowed', 'use GET')
        token = (parse_qs(url.query).get('token') or [''])[0]
        if not security.tokens_equal(token, srv.token):
            raise ApiError(401, 'unauthorized', 'bad token')
        self._send(302, b'', 'text/plain; charset=utf-8',
                   {'Location': '/', 'Set-Cookie': security.session_cookie(srv.token)})

    def _static(self, path):
        srv = self.server
        if not security.host_ok(self.headers, srv.port):
            raise ApiError(403, 'forbidden', 'bad Host header')
        rel = safe_static_path(path)
        data = srv.load_static(rel) if rel else None
        if data is None:
            self._send(404, b'not found\n', 'text/plain; charset=utf-8')
            return
        self._send(200, data, content_type(rel), cache='no-cache')

    # ---- API --------------------------------------------------------------

    def _api(self, url):
        srv = self.server
        denied = security.check_api(self.command, self.headers, srv.port, srv.token)
        if denied:
            raise ApiError(*denied)
        name, params = match_route(self.command, url.path)
        body = self._body() if self.command != 'GET' else {}
        handler = getattr(self, 'route_' + name)
        handler(params, body, url)

    def route_health(self, params, body, url):
        srv = self.server
        self._json(200, {'ok': True, 'version': srv.version, 'demo': srv.demo,
                         'pid': srv.pid, 'uptime_s': round(time.monotonic() - srv.started, 3)})

    def route_state(self, params, body, url):
        self._json(200, self.server.engine.state())

    def route_summary(self, params, body, url):
        self._json(200, self.server.engine.summary())

    def route_diagnostics(self, params, body, url):
        self._json(200, self.server.engine.diagnostics())

    def route_stats(self, params, body, url):
        self._json(200, self.server.engine.stats_view())

    def route_history(self, params, body, url):
        hours = _hours(url, default=8, maximum=8)
        self._json(200, self.server.engine.history(params['uid'], hours))

    def route_usage_history(self, params, body, url):
        hours = _hours(url, default=24, maximum=168)
        self._json(200, self.server.engine.usage_history_view(hours))

    def route_get_prefs(self, params, body, url):
        self._json(200, self.server.engine.prefs())

    def route_events(self, params, body, url):
        srv = self.server
        engine, hub = srv.engine, srv.hub
        query = parse_qs(url.query)
        last_id = sse.parse_last_event_id(self.headers.get('Last-Event-ID'),
                                          (query.get('last_event_id') or [None])[0])
        client, snap = hub.subscribe(engine.sse_snapshot, last_id)
        if client.dropped:
            raise ApiError(503, 'unavailable', 'shutting down')
        seq, doc = snap
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self._common_headers()
        self.end_headers()
        first = (sse.encode(seq, 'hello', engine.hello()),
                 sse.encode(seq, 'state', doc))

        def write(data):
            self.wfile.write(data)
            self.wfile.flush()
        hub.stream(client, write, first)

    def route_shutdown(self, params, body, url):
        self._json(200, {'ok': True})
        self.wfile.flush()
        self.server.request_shutdown()

    def route_set_project(self, params, body, url):
        try:
            slot = int(params['slot'])
        except ValueError:
            raise ApiError(404, 'not_found', 'no such project slot')
        self._json(200, self.server.engine.set_project(slot, body))

    def route_demo_step(self, params, body, url):
        self._demo_only()
        self._json(200, self.server.engine.demo_step(body))

    def route_demo_scenario(self, params, body, url):
        self._demo_only()
        self._json(200, self.server.engine.demo_scenario(body))

    def _demo_only(self):
        if not self.server.demo:
            raise ApiError(404, 'not_found', 'demo mode only')


def _hours(url, default, maximum):
    """`?hours=` as a number in (0, maximum]; 400 otherwise."""
    raw = (parse_qs(url.query).get('hours') or [None])[0]
    if raw is None:
        return default
    try:
        hours = float(raw)
    except ValueError:
        raise ApiError(400, 'bad_request', 'hours must be a number')
    if not 0 < hours <= maximum or hours != hours:
        raise ApiError(400, 'bad_request', 'hours must be in (0, %d]' % maximum)
    return hours


# Engine commands: route name -> (engine method, takes uid, takes body,
# success status).
COMMAND_ROUTES = {
    'probe': ('probe_automation', False, False, 202),
    'goto': ('goto', True, False, 202),
    'visit': ('visit', True, False, 200),
    'label': ('set_label', True, True, 200),
    'color': ('set_color', True, True, 202),
    'mute': ('set_muted', True, True, 200),
    'close': ('close', True, True, 202),
    'reply': ('reply', True, True, 202),
    'reveal': ('reveal', True, True, 202),
    'new_tab': ('new_tab', False, False, 202),
    'launch': ('launch_iterm', False, False, 202),
    'refresh': ('refresh', False, False, 200),
    'patch_prefs': ('patch_prefs', False, True, 200),
    'clear_projects': ('clear_projects', False, True, 200),
    'quota_draft': ('quota_draft', False, False, 200),
    'quota_skip': ('quota_skip', False, False, 200),
    'plugin_focus': ('plugin_focus', False, True, 200),
}


def _command_route(method, takes_uid, takes_body, status):
    def route(self, params, body, url):
        args = []
        if takes_uid:
            args.append(params['uid'])
        if takes_body:
            args.append(body)
        self._json(status, getattr(self.server.engine, method)(*args))
    return route


for _name, _spec in COMMAND_ROUTES.items():
    setattr(Handler, 'route_' + _name, _command_route(*_spec))


class OmniwatchServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, engine, hub, token, port=0, demo=False,
                 version=__version__, on_shutdown=None, pid=None,
                 static_package='omniwatch', static_prefix='web/'):
        super().__init__(('127.0.0.1', port), Handler)
        self.engine = engine
        self.hub = hub
        self.token = token
        self.demo = demo
        self.version = version
        self.on_shutdown = on_shutdown
        self.pid = pid if pid is not None else os.getpid()
        self.started = time.monotonic()
        self.static_package = static_package
        self.static_prefix = static_prefix
        self._thread = None

    @property
    def port(self):
        return self.server_address[1]

    def load_static(self, rel):
        try:
            return pkgutil.get_data(self.static_package, self.static_prefix + rel)
        except (OSError, KeyError, ValueError):
            return None

    def request_shutdown(self):
        if self.on_shutdown is not None:
            self.on_shutdown()

    def start(self):
        self._thread = threading.Thread(target=self.serve_forever,
                                        kwargs={'poll_interval': 0.1},
                                        name='http', daemon=True)
        self._thread.start()
        return self

    def stop(self):
        if self._thread is not None:
            self.shutdown()
            self._thread = None
        self.server_close()
