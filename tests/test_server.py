"""New (docs/DESIGN.md §4.4/§4.5, docs/SHELL_CONTRACT.md §4-§5): every HTTP
route and error code against a real ThreadingHTTPServer on port 0, in
this process, over http.client; plus the SSE wire contract."""
import http.client
import json
import os
import sys
import threading
import time
import unittest
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import Harness
import fake_providers as fp

from omniwatch import server as server_mod
from omniwatch import security
from omniwatch.server import OmniwatchServer

TOKEN = 'test-token_123'


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def json(self):
        return json.loads(self.body.decode('utf-8'))

    def header(self, name):
        return self.headers.get(name)


class ServerTestCase(TripwireTestCase):
    demo = False
    heartbeat = 15.0

    def setUp(self):
        super().setUp()
        kw = {}
        if self.demo:
            p = fp.make_providers('default', frozen_clock=1_800_000_000.0)
            kw = dict(providers=p, sync=True, demo=True, demo_factory=fp.make_providers,
                      demo_options={'scenarios': fp.SCENARIOS,
                                    'factory_kwargs': {'frozen_clock': 1_800_000_000.0}})
        self.h = Harness(self.tmp_config_dir, tick=0.02, heartbeat=self.heartbeat, **kw)
        self.h.poll()
        self.h.engine.start()
        self.addCleanup(self.h.engine.stop)
        self.shutdowns = []
        self.srv = OmniwatchServer(self.h.engine, self.h.hub, TOKEN, demo=self.demo,
                                   on_shutdown=lambda: self.shutdowns.append(True))
        self.srv.start()
        self.addCleanup(self.srv.stop)
        self.addCleanup(self.h.hub.close)
        self.port = self.srv.port

    def conn(self, timeout=5):
        return http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)

    def headers(self, auth='bearer', host=None, origin=None, extra=None):
        h = {'Host': host or '127.0.0.1:%d' % self.port}
        if auth == 'bearer':
            h['Authorization'] = 'Bearer ' + TOKEN
        elif auth == 'cookie':
            h['Cookie'] = 'ow_session=' + TOKEN
        if origin:
            h['Origin'] = origin
        h.update(extra or {})
        return h

    def req(self, method, path, body=None, raw=None, **kw):
        c = self.conn()
        headers = self.headers(**kw)
        data = raw
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        resp = Response(r.status, dict(r.getheaders()), r.read())
        c.close()
        return resp

    def assertError(self, resp, status, code):
        self.assertEqual(resp.status, status, resp.body)
        self.assertEqual(resp.json['ok'], False)
        self.assertEqual(resp.json['error']['code'], code)
        self.assertIsInstance(resp.json['error']['message'], str)

    def origin(self):
        return 'http://127.0.0.1:%d' % self.port


class TestStatic(ServerTestCase):
    def test_index_with_csp(self):
        r = self.req('GET', '/', auth=None)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.header('Content-Type'), 'text/html; charset=utf-8')
        self.assertEqual(r.header('Content-Security-Policy'), security.CSP)
        self.assertEqual(r.header('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(r.header('X-Frame-Options'), 'DENY')
        self.assertIn(b'<!doctype html>', r.body.lower())
        self.assertIsNone(r.header('Access-Control-Allow-Origin'))
        self.assertEqual(self.req('GET', '/index.html', auth=None).body, r.body)

    def test_assets_content_types(self):
        self.assertEqual(self.req('GET', '/css/tokens.css', auth=None).header('Content-Type'),
                         'text/css; charset=utf-8')
        self.assertEqual(self.req('GET', '/js/api.js', auth=None).header('Content-Type'),
                         'text/javascript; charset=utf-8')

    def test_not_found_and_traversal(self):
        for path in ('/nope.txt', '/css', '/css/', '/../engine.py', '/%2e%2e/engine.py',
                     '/js/..%2f..%2fengine.py', '/a\\b', '/%00x', '/./index.html'):
            r = self.req('GET', path, auth=None)
            self.assertEqual(r.status, 404, path)
            self.assertNotIn(b'import', r.body)

    def test_static_host_check(self):
        self.assertError(self.req('GET', '/', auth=None, host='evil.com'), 403, 'forbidden')

    def test_non_get_non_api(self):
        self.assertError(self.req('POST', '/', auth=None), 404, 'not_found')

    def test_helpers(self):
        self.assertEqual(server_mod.safe_static_path('/'), 'index.html')
        self.assertEqual(server_mod.safe_static_path('/js/a%20b.js'), 'js/a b.js')
        self.assertIsNone(server_mod.safe_static_path('/js//x.js'))
        self.assertEqual(server_mod.content_type('x.svg'), 'image/svg+xml')
        self.assertEqual(server_mod.content_type('x.wasm'), 'application/wasm')
        self.assertEqual(server_mod.content_type('x.zzz'), 'application/octet-stream')
        self.assertIsNone(self.srv.load_static('does/not/exist.js'))


class TestAuth(ServerTestCase):
    def test_auth_sets_cookie_and_redirects(self):
        r = self.req('GET', '/auth?token=' + TOKEN, auth=None)
        self.assertEqual(r.status, 302)
        self.assertEqual(r.header('Location'), '/')
        self.assertEqual(r.header('Set-Cookie'),
                         'ow_session=%s; HttpOnly; SameSite=Strict; Path=/' % TOKEN)

    def test_auth_errors(self):
        self.assertError(self.req('GET', '/auth?token=nope', auth=None), 401, 'unauthorized')
        self.assertError(self.req('GET', '/auth', auth=None), 401, 'unauthorized')
        self.assertError(self.req('GET', '/auth?token=' + TOKEN, auth=None, host='evil:1'),
                         403, 'forbidden')
        self.assertError(self.req('POST', '/auth?token=' + TOKEN, auth=None), 405,
                         'method_not_allowed')

    def test_api_requires_token(self):
        self.assertError(self.req('GET', '/api/v1/state', auth=None), 401, 'unauthorized')
        self.assertError(self.req('GET', '/api/v1/state', auth=None,
                                  extra={'Authorization': 'Bearer wrong'}), 401, 'unauthorized')
        self.assertEqual(self.req('GET', '/api/v1/state', auth='cookie').status, 200)
        self.assertEqual(self.req('GET', '/api/v1/state',
                                  host='localhost:%d' % self.port).status, 200)

    def test_api_host_and_origin(self):
        self.assertError(self.req('GET', '/api/v1/state', host='evil.com:%d' % self.port),
                         403, 'forbidden')
        # cookie + no Origin on a write → CSRF rejection
        self.assertError(self.req('POST', '/api/v1/refresh', auth='cookie'), 403, 'forbidden')
        self.assertEqual(self.req('POST', '/api/v1/refresh', auth='cookie',
                                  origin=self.origin()).status, 200)
        self.assertError(self.req('POST', '/api/v1/refresh', origin='http://evil.com'),
                         403, 'forbidden')
        # the shell: Bearer, no Origin
        self.assertEqual(self.req('POST', '/api/v1/refresh').status, 200)

    def test_no_cors_headers(self):
        r = self.req('GET', '/api/v1/health', origin='http://evil.com')
        self.assertIsNone(r.header('Access-Control-Allow-Origin'))


class TestReadRoutes(ServerTestCase):
    def test_health(self):
        r = self.req('GET', '/api/v1/health')
        self.assertEqual(r.status, 200)
        self.assertEqual(r.header('Content-Type'), 'application/json; charset=utf-8')
        self.assertEqual(r.header('Cache-Control'), 'no-store')
        j = r.json
        self.assertEqual((j['ok'], j['version'], j['demo'], j['pid']),
                         (True, '1.0.0', False, os.getpid()))
        self.assertGreaterEqual(j['uptime_s'], 0)

    def test_state(self):
        j = self.req('GET', '/api/v1/state').json
        self.assertEqual(set(j), {'version', 'seq', 'server_time', 'demo', 'iterm', 'summary',
                                  'windows', 'sessions', 'screens', 'usage', 'prefs',
                                  'projects', 'capabilities', 'quota_prompt', 'stats'})
        self.assertEqual(j['summary']['waiting'], 2)
        self.assertEqual(len(j['screens']), 4)

    def test_summary(self):
        j = self.req('GET', '/api/v1/summary').json
        self.assertEqual(set(j), {'tabs', 'agents', 'waiting', 'busy', 'stalled',
                                  'waiting_sessions', 'stats'})
        self.assertEqual(j['waiting_sessions'][0]['uid'], fp.UID_WAIT)

    def test_diagnostics(self):
        j = self.req('GET', '/api/v1/diagnostics').json
        for key in ('python', 'iterm', 'automation', 'tab_colors', 'claude_credentials',
                    'codex_credentials', 'config_dir', 'log_path'):
            self.assertIn(key, j)

    def test_prefs(self):
        self.assertEqual(self.req('GET', '/api/v1/prefs').json['view'], 'split')

    def test_unknown_route_and_method(self):
        self.assertError(self.req('GET', '/api/v1/nope'), 404, 'not_found')
        self.assertError(self.req('GET', '/api/v2/state'), 404, 'not_found')
        self.assertError(self.req('DELETE', '/api/v1/state'), 405, 'method_not_allowed')
        self.assertError(self.req('GET', '/api/v1/sessions/%s/goto' % fp.UID_WAIT),
                         405, 'method_not_allowed')
        self.assertError(self.req('POST', '/api/v1/sessions//goto'), 404, 'not_found')


class TestCommandRoutes(ServerTestCase):
    def sess(self, uid, action):
        return '/api/v1/sessions/%s/%s' % (quote(uid, safe=''), action)

    def test_goto_202(self):
        r = self.req('POST', self.sess(fp.UID_WAIT, 'goto'))
        self.assertEqual(r.status, 202)
        self.assertEqual(r.json['ok'], True)
        self.assertRegex(r.json['action_id'], r'^a-\d+$')
        self.assertEqual(self.h.pollers['iterm'].requests, [('goto', fp.UID_WAIT)])
        self.assertError(self.req('POST', self.sess('A/B?c', 'goto')), 404, 'not_found')

    def test_visit(self):
        self.assertEqual(self.req('POST', self.sess(fp.UID_WAIT, 'visit')).json, {'ok': True})
        self.assertError(self.req('POST', self.sess('nope', 'visit')), 404, 'not_found')

    def test_label(self):
        r = self.req('PUT', self.sess(fp.UID_WAIT, 'label'), {'label': 'deploy-fix'})
        self.assertEqual((r.status, r.json['label']), (200, 'deploy-fix'))
        self.assertError(self.req('PUT', self.sess(fp.UID_WAIT, 'label'), {'label': 'x' * 81}),
                         422, 'invalid')
        self.assertError(self.req('PUT', self.sess(fp.UID_WAIT, 'label'), {}), 400, 'bad_request')

    def test_color(self):
        self.assertEqual(self.req('PUT', self.sess(fp.UID_WAIT, 'color'), {'project': 2}).status, 202)
        self.assertEqual(self.req('PUT', self.sess(fp.UID_WAIT, 'color'), {'color': None}).status, 202)
        self.h.pollers['colors'].available = False
        self.assertError(self.req('PUT', self.sess(fp.UID_WAIT, 'color'), {'color': 'red'}),
                         503, 'tab_colors_unavailable')

    def test_mute(self):
        self.assertEqual(self.req('PUT', self.sess(fp.UID_WAIT, 'mute'), {'muted': True}).json,
                         {'ok': True, 'muted': True})
        self.assertError(self.req('PUT', self.sess(fp.UID_WAIT, 'mute'), {'muted': 1}),
                         400, 'bad_request')

    def test_close(self):
        self.assertEqual(self.req('POST', self.sess(fp.UID_SHELL, 'close'), {'confirm': True}).status, 202)
        self.assertError(self.req('POST', self.sess(fp.UID_SHELL, 'close')), 400, 'bad_request')

    def test_reply(self):
        h = self.req('GET', '/api/v1/state').json['sessions'][0]['screen_hash']
        ok = self.req('POST', self.sess(fp.UID_WAIT, 'reply'),
                      {'text': '1', 'submit': False, 'expect_hash': h})
        self.assertEqual(ok.status, 202)
        self.assertError(self.req('POST', self.sess(fp.UID_WAIT, 'reply'),
                                  {'text': '1', 'expect_hash': '00000000'}), 409, 'stale_screen')
        self.assertError(self.req('POST', self.sess(fp.UID_SHELL, 'reply'),
                                  {'text': '1', 'expect_hash': h}), 422, 'invalid')
        self.assertError(self.req('POST', self.sess(fp.UID_WAIT, 'reply'),
                                  {'text': 'a\x07', 'expect_hash': h}), 422, 'invalid')
        self.assertError(self.req('POST', self.sess(fp.UID_WAIT, 'reply'), {'text': '1'}),
                         400, 'bad_request')

    def test_iterm_unavailable_503(self):
        self.h.p.iterm.mode = 'not_running'
        self.h.engine.call(self.h.engine.sync_poll)
        self.assertError(self.req('POST', '/api/v1/tabs/new'), 503, 'iterm_unavailable')

    def test_simple_actions(self):
        for path, status in (('/api/v1/tabs/new', 202), ('/api/v1/iterm/launch', 202),
                             ('/api/v1/diagnostics/probe-automation', 202),
                             ('/api/v1/refresh', 200)):
            r = self.req('POST', path)
            self.assertEqual(r.status, status, path)
            self.assertTrue(r.json['ok'])

    def test_patch_prefs(self):
        r = self.req('PATCH', '/api/v1/prefs', {'keep_on_top': True})
        self.assertEqual(r.status, 200)
        self.assertTrue(r.json['keep_on_top'])
        self.assertEqual(set(r.json), set(self.req('GET', '/api/v1/prefs').json))
        self.assertError(self.req('PATCH', '/api/v1/prefs', {'keep_on_top': 'yes'}), 422, 'invalid')
        self.assertError(self.req('PATCH', '/api/v1/prefs', {'nope': 1}), 422, 'invalid')

    def test_bad_bodies(self):
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=b'{nope'), 400, 'bad_request')
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=b'[1]'), 400, 'bad_request')
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=b'\xff\xfe'), 400, 'bad_request')
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=b'{}',
                                  extra={'Content-Length': 'abc'}), 400, 'bad_request')
        big = b'{"x":"' + b'a' * (server_mod.MAX_BODY + 1) + b'"}'
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=big), 400, 'bad_request')
        self.assertError(self.req('PATCH', '/api/v1/prefs', raw=b'',
                                  extra={'Transfer-Encoding': 'chunked'}), 400, 'bad_request')

    def test_projects(self):
        r = self.req('PUT', '/api/v1/projects/1', {'name': 'api'})
        self.assertEqual(r.json['project'], {'slot': 1, 'name': 'api', 'color': 'blue'})
        self.assertError(self.req('PUT', '/api/v1/projects/x', {'name': 'a'}), 404, 'not_found')
        self.assertError(self.req('PUT', '/api/v1/projects/6', {'name': 'a'}), 404, 'not_found')
        self.assertError(self.req('DELETE', '/api/v1/projects'), 400, 'bad_request')
        self.assertEqual(self.req('DELETE', '/api/v1/projects', {'confirm': True}).status, 200)

    def test_quota(self):
        self.assertEqual(self.req('POST', '/api/v1/quota-email/draft').json['opened'], True)
        self.assertError(self.req('POST', '/api/v1/quota-email/draft'), 404, 'not_found')
        self.assertError(self.req('POST', '/api/v1/quota-email/skip'), 404, 'not_found')

    def test_quota_skip(self):
        self.assertEqual(self.req('POST', '/api/v1/quota-email/skip').json, {'ok': True})

    def test_plugin_focus(self):
        self.assertEqual(self.req('POST', '/api/v1/plugin/focus', {'uid': fp.UID_WAIT}).status, 200)
        self.assertError(self.req('POST', '/api/v1/plugin/focus', {}), 400, 'bad_request')

    def test_demo_routes_404_outside_demo(self):
        self.assertError(self.req('POST', '/api/v1/demo/step', {'seconds': 1}), 404, 'not_found')
        self.assertError(self.req('POST', '/api/v1/demo/scenario', {'name': 'x'}), 404, 'not_found')

    def test_shutdown(self):
        r = self.req('POST', '/api/v1/shutdown')
        self.assertEqual((r.status, r.json), (200, {'ok': True}))
        # the 200 is written before on_shutdown runs, so allow it a moment
        deadline = time.time() + 2
        while not self.shutdowns and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.shutdowns, [True])

    def test_internal_error_500(self):
        def boom():
            raise RuntimeError('kaput')
        self.h.engine.summary = boom
        import logging
        logging.getLogger('omniwatch.server').disabled = True
        self.addCleanup(setattr, logging.getLogger('omniwatch.server'), 'disabled', False)
        self.assertError(self.req('GET', '/api/v1/summary'), 500, 'internal')


class TestDemoRoutes(ServerTestCase):
    demo = True

    def test_health_reports_demo(self):
        self.assertTrue(self.req('GET', '/api/v1/health').json['demo'])

    def test_step_and_scenario(self):
        r = self.req('POST', '/api/v1/demo/step', {'seconds': 6})
        self.assertEqual(r.status, 200)
        state = self.req('GET', '/api/v1/state').json
        self.assertEqual(r.json['seq'], state['seq'])
        self.assertEqual(state['summary']['waiting'], 3)
        self.assertError(self.req('POST', '/api/v1/demo/step', {'seconds': 'x'}), 400, 'bad_request')
        r = self.req('POST', '/api/v1/demo/scenario', {'name': 'empty'})
        self.assertEqual(r.json['scenario'], 'empty')
        self.assertEqual(self.req('GET', '/api/v1/state').json['sessions'], [])
        self.assertError(self.req('POST', '/api/v1/demo/scenario', {'name': 'zzz'}), 422, 'invalid')


class TestP1Routes(ServerTestCase):
    def test_history(self):
        r = self.req('GET', '/api/v1/sessions/%s/history' % fp.UID_WAIT)
        self.assertEqual(r.status, 200)
        self.assertEqual(set(r.json), {'uid', 'from', 'to', 'hours', 'segments', 'totals',
                                       'transitions'})
        self.assertEqual(r.json['hours'], 8)
        self.assertEqual(self.req('GET', '/api/v1/sessions/%s/history?hours=2' % fp.UID_WAIT)
                         .json['hours'], 2.0)
        for q in ('abc', '0', '9', 'nan', '-1'):
            self.assertError(self.req('GET', '/api/v1/sessions/%s/history?hours=%s'
                                      % (fp.UID_WAIT, q)), 400, 'bad_request')
        self.assertError(self.req('GET', '/api/v1/sessions/nope/history'), 404, 'not_found')

    def test_usage_history(self):
        r = self.req('GET', '/api/v1/usage/history')
        self.assertEqual((r.status, r.json['hours']), (200, 24))
        self.assertIn('claude.five_hour', r.json['limits'])
        self.assertEqual(self.req('GET', '/api/v1/usage/history?hours=168').status, 200)
        self.assertError(self.req('GET', '/api/v1/usage/history?hours=169'), 400, 'bad_request')

    def test_stats(self):
        r = self.req('GET', '/api/v1/stats')
        self.assertEqual(set(r.json), {'day', 'waiting_seconds', 'longest_wait_s', 'answered',
                                       'waits', 'active'})

    def test_reveal(self):
        r = self.req('POST', '/api/v1/sessions/%s/reveal' % fp.UID_WAIT, {'target': 'copy_path'})
        self.assertEqual(r.status, 202)
        self.assertRegex(r.json['action_id'], r'^a-\d+$')
        self.assertError(self.req('POST', '/api/v1/sessions/%s/reveal' % fp.UID_WAIT,
                                  {'target': 'x'}), 422, 'invalid')
        self.assertError(self.req('POST', '/api/v1/sessions/%s/reveal' % fp.UID_WAIT,
                                  {'target': 'finder', 'path': '/etc'}, auth='cookie'),
                         403, 'forbidden')      # cookie write without Origin


def read_events(resp, count, timeout=5):
    """Read `count` SSE items (events or pings) from an http.client response."""
    out = []
    deadline = time.time() + timeout
    buf = []
    while len(out) < count and time.time() < deadline:
        line = resp.fp.readline().decode('utf-8')
        if line == '':
            break
        if line == '\n':
            block = ''.join(buf)
            buf = []
            if block.startswith(':'):
                out.append(('ping',))
                continue
            fields = dict(l.split(': ', 1) for l in block.strip('\n').split('\n'))
            out.append((int(fields['id']), fields['event'], json.loads(fields['data'])))
        else:
            buf.append(line)
    return out


class TestSSE(ServerTestCase):
    heartbeat = 0.3

    def open_stream(self, path='/api/v1/events', **kw):
        c = self.conn(timeout=5)
        headers = self.headers(**kw)
        headers['Accept'] = 'text/event-stream'
        c.request('GET', path, headers=headers)
        r = c.getresponse()
        self.addCleanup(c.close)
        return r

    def test_hello_then_state(self):
        r = self.open_stream()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader('Content-Type'), 'text/event-stream; charset=utf-8')
        self.assertEqual(r.getheader('Cache-Control'), 'no-store')
        (id1, ev1, hello), (id2, ev2, state) = read_events(r, 2)
        self.assertEqual((ev1, ev2), ('hello', 'state'))
        self.assertEqual(set(hello), {'version', 'server_time', 'demo'})
        self.assertEqual(id1, id2)
        self.assertEqual(state['seq'], id2)
        self.assertEqual(state['summary']['waiting'], 2)

    def test_live_events_follow(self):
        r = self.open_stream()
        _, (seq0, _, _) = read_events(r, 2)
        self.req('PUT', '/api/v1/sessions/%s/label' % fp.UID_SHELL, {'label': 'infra'})
        ev = [e for e in read_events(r, 3, timeout=3) if e[0] != 'ping'][0]
        self.assertEqual(ev[1], 'sessions')
        self.assertGreater(ev[0], seq0)
        self.assertEqual(ev[2]['seq'], ev[0])
        self.assertEqual([s['label'] for s in ev[2]['sessions'] if s['uid'] == fp.UID_SHELL],
                         ['infra'])

    def test_heartbeat_ping(self):
        r = self.open_stream()
        read_events(r, 2)
        self.assertEqual(read_events(r, 1, timeout=3), [('ping',)])

    def test_reconnect_with_last_event_id(self):
        for kw in ({'extra': {'Last-Event-ID': '3'}}, {}):
            path = '/api/v1/events' + ('' if kw else '?last_event_id=3')
            r = self.open_stream(path, **kw)
            self.assertEqual([e[1] for e in read_events(r, 2)], ['hello', 'state'])

    def test_cookie_auth_for_eventsource(self):
        r = self.open_stream(auth='cookie')
        self.assertEqual(r.status, 200)

    def test_unauthorized(self):
        r = self.open_stream(auth=None)
        self.assertEqual(r.status, 401)

    def test_stream_ends_on_hub_close(self):
        r = self.open_stream()
        read_events(r, 2)
        self.h.hub.close()
        self.assertEqual(read_events(r, 5, timeout=3), [])   # EOF, no more events
        r2 = self.open_stream()
        self.assertEqual(r2.status, 503)


if __name__ == '__main__':
    unittest.main()
