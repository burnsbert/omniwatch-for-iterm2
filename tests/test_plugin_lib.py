"""New (docs/DESIGN.md §4.8, §7 WP10): the Omniwatch iTerm2 plugin's pure
logic — runtime discovery, HTTP client, status formatting, click/focus
handling.

The HTTP client tests use a real, loopback-only `http.server.HTTPServer`
(bound to 127.0.0.1:0, a background thread) rather than a mock — the same
"real ThreadingHTTPServer on port 0 in-thread, http.client" convention
docs/DESIGN.md §5 specifies for the backend's own server route tests.
`plugin_lib` deliberately uses `http.client` (not `urllib.request`) for
exactly this reason: `tests/_support.py`'s tripwire patches
`urllib.request.urlopen`, not `http.client`, and a loopback-only test
server is not "the network" in the sense the tripwire cares about (real
subprocesses, DNS, external hosts). No test here ever touches a real
iTerm2 or a real backend.
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'plugin', 'iterm2'))

from _support import TripwireTestCase

import omniwatch_plugin_lib as lib


# ---------------------------------------------------------------------
# A tiny fake backend (loopback-only), for the HTTP client tests.
# ---------------------------------------------------------------------

class _FakeBackendHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep test output quiet

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        want = 'Bearer ' + self.server.token
        return self.headers.get('Authorization') == want

    def do_GET(self):
        if not self._check_auth():
            self._send_json(401, {'ok': False})
            return
        if self.path == '/api/v1/summary':
            self.server.calls.append(('GET', self.path))
            self._send_json(200, self.server.summary)
            return
        self._send_json(404, {'ok': False})

    def do_POST(self):
        if not self._check_auth():
            self._send_json(401, {'ok': False})
            return
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        body = json.loads(raw.decode('utf-8')) if raw else {}
        self.server.calls.append(('POST', self.path, body))
        if self.path.endswith('/goto'):
            self._send_json(202, {'ok': True, 'action_id': 'a-1'})
        elif self.path == '/api/v1/plugin/focus':
            self._send_json(200, {'ok': True})
        elif self.path == '/api/v1/broken-json':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', '4')
            self.end_headers()
            self.wfile.write(b'nope')
        elif self.path == '/api/v1/empty':
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
        else:
            self._send_json(404, {'ok': False})


class _FakeBackend:
    """A real HTTPServer bound to 127.0.0.1:0, for exercising the HTTP
    client against actual sockets without touching the real network."""

    def __init__(self, summary=None):
        self.httpd = http.server.HTTPServer(('127.0.0.1', 0), _FakeBackendHandler)
        self.httpd.token = 'test-token-123'
        self.httpd.summary = summary if summary is not None else {
            'tabs': 3, 'agents': 2, 'waiting': 1, 'busy': 1,
            'waiting_sessions': [{'uid': 'UID-1', 'title': 'api',
                                 'since': 100.0, 'agent': 'claude'}],
        }
        self.httpd.calls = []
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={'poll_interval': 0.01},
                                       daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    @property
    def calls(self):
        return self.httpd.calls

    @property
    def runtime(self):
        return {'port': self.httpd.server_address[1], 'pid': os.getpid(),
                'token': self.httpd.token, 'version': '1.0.0',
                'started_at': 0}


class BackendTestCase(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.backend = _FakeBackend().start()
        self.addCleanup(self.backend.stop)


# ---------------------------------------------------------------------
# runtime.json discovery
# ---------------------------------------------------------------------

class TestConfigDir(TripwireTestCase):
    def test_omniwatch_config_dir_override_wins(self):
        env = {'OMNIWATCH_CONFIG_DIR': '/tmp/custom', 'XDG_CONFIG_HOME': '/tmp/xdg'}
        self.assertEqual(lib.default_config_dir(env), '/tmp/custom')

    def test_xdg_config_home_used_when_no_override(self):
        env = {'XDG_CONFIG_HOME': '/tmp/xdg'}
        self.assertEqual(lib.default_config_dir(env), '/tmp/xdg/omniwatch')

    def test_falls_back_to_home_config(self):
        env = {}
        self.assertTrue(lib.default_config_dir(env).endswith('/.config/omniwatch'))

    def test_runtime_path_joins_filename(self):
        env = {'OMNIWATCH_CONFIG_DIR': '/tmp/custom'}
        self.assertEqual(lib.runtime_path(env), '/tmp/custom/runtime.json')


class TestReadRuntimeFile(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'runtime.json')

    def write(self, obj):
        with open(self.path, 'w') as f:
            json.dump(obj, f)

    def test_valid_file(self):
        self.write({'port': 1234, 'pid': 999, 'token': 'abc'})
        info = lib.read_runtime_file(self.path)
        self.assertEqual(info['port'], 1234)

    def test_missing_file_is_none(self):
        self.assertIsNone(lib.read_runtime_file(self.path))

    def test_malformed_json_is_none(self):
        with open(self.path, 'w') as f:
            f.write('{not json')
        self.assertIsNone(lib.read_runtime_file(self.path))

    def test_non_dict_is_none(self):
        self.write([1, 2, 3])
        self.assertIsNone(lib.read_runtime_file(self.path))

    def test_missing_port_is_none(self):
        self.write({'pid': 999, 'token': 'abc'})
        self.assertIsNone(lib.read_runtime_file(self.path))

    def test_non_int_pid_is_none(self):
        self.write({'port': 1234, 'pid': 'nope', 'token': 'abc'})
        self.assertIsNone(lib.read_runtime_file(self.path))

    def test_non_str_token_is_none(self):
        self.write({'port': 1234, 'pid': 999, 'token': 42})
        self.assertIsNone(lib.read_runtime_file(self.path))


class TestPidAlive(TripwireTestCase):
    def test_current_process_is_alive(self):
        self.assertTrue(lib.pid_alive(os.getpid()))

    def test_zero_or_negative_is_false(self):
        self.assertFalse(lib.pid_alive(0))
        self.assertFalse(lib.pid_alive(-5))

    def test_non_int_is_false(self):
        self.assertFalse(lib.pid_alive('123'))

    def test_process_lookup_error_is_false(self):
        def kill(pid, sig):
            raise ProcessLookupError()
        self.assertFalse(lib.pid_alive(12345, kill=kill))

    def test_permission_error_is_true(self):
        def kill(pid, sig):
            raise PermissionError()
        self.assertTrue(lib.pid_alive(1, kill=kill))

    def test_other_os_error_is_false(self):
        def kill(pid, sig):
            raise OSError('weird')
        self.assertFalse(lib.pid_alive(12345, kill=kill))


class TestReadLiveRuntime(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'runtime.json')

    def test_alive_pid_returns_info(self):
        with open(self.path, 'w') as f:
            json.dump({'port': 1, 'pid': 2, 'token': 't'}, f)
        info = lib.read_live_runtime(self.path, pid_alive_fn=lambda pid: True)
        self.assertEqual(info['port'], 1)

    def test_dead_pid_returns_none(self):
        with open(self.path, 'w') as f:
            json.dump({'port': 1, 'pid': 2, 'token': 't'}, f)
        info = lib.read_live_runtime(self.path, pid_alive_fn=lambda pid: False)
        self.assertIsNone(info)

    def test_missing_file_returns_none(self):
        self.assertIsNone(lib.read_live_runtime(self.path))


# ---------------------------------------------------------------------
# HTTP client (real loopback server)
# ---------------------------------------------------------------------

class TestFetchSummary(BackendTestCase):
    def test_fetch_summary_success(self):
        summary = lib.fetch_summary(self.backend.runtime)
        self.assertEqual(summary['waiting'], 1)
        self.assertEqual(self.backend.calls, [('GET', '/api/v1/summary')])

    def test_bad_token_raises_backend_unavailable(self):
        bad = dict(self.backend.runtime, token='wrong')
        with self.assertRaises(lib.BackendUnavailable):
            lib.fetch_summary(bad)

    def test_connection_refused_raises_backend_unavailable(self):
        # nothing listening on this port
        dead = {'port': 1, 'token': 'x'}
        with self.assertRaises(lib.BackendUnavailable):
            lib.fetch_summary(dead, timeout=0.5)

    def test_malformed_json_response_raises_backend_unavailable(self):
        with self.assertRaises(lib.BackendUnavailable):
            lib.request_json(self.backend.runtime, 'POST', '/api/v1/broken-json',
                             body={})

    def test_empty_body_response_is_empty_dict(self):
        self.assertEqual(
            lib.request_json(self.backend.runtime, 'POST', '/api/v1/empty',
                             body={}),
            {})


class TestPostGoto(BackendTestCase):
    def test_posts_to_goto_endpoint(self):
        result = lib.post_goto(self.backend.runtime, 'UID-1')
        self.assertTrue(result['ok'])
        self.assertEqual(self.backend.calls,
                         [('POST', '/api/v1/sessions/UID-1/goto', {})])


class TestPostPluginFocus(BackendTestCase):
    def test_posts_uid_in_body(self):
        result = lib.post_plugin_focus(self.backend.runtime, 'UID-2')
        self.assertTrue(result['ok'])
        self.assertEqual(self.backend.calls,
                         [('POST', '/api/v1/plugin/focus', {'uid': 'UID-2'})])


# ---------------------------------------------------------------------
# uid mapping
# ---------------------------------------------------------------------

class TestUidFromSessionId(TripwireTestCase):
    def test_strips_window_tab_pane_prefix(self):
        self.assertEqual(lib.uid_from_session_id('w0t2p0:GUID-1'), 'GUID-1')

    def test_bare_guid_passthrough(self):
        self.assertEqual(lib.uid_from_session_id('GUID-1'), 'GUID-1')


# ---------------------------------------------------------------------
# status formatting
# ---------------------------------------------------------------------

class TestFormatStatus(TripwireTestCase):
    def test_no_backend_is_off(self):
        self.assertEqual(lib.format_status(None), 'Omniwatch off')

    def test_zero_waiting_is_hidden(self):
        self.assertEqual(lib.format_status({'waiting': 0}), '')

    def test_missing_waiting_key_is_hidden(self):
        self.assertEqual(lib.format_status({}), '')

    def test_some_waiting_shows_count(self):
        self.assertEqual(lib.format_status({'waiting': 2}), '◉ 2 waiting')


class TestNextWaitingUid(TripwireTestCase):
    def test_none_summary(self):
        self.assertIsNone(lib.next_waiting_uid(None))

    def test_empty_waiting_sessions(self):
        self.assertIsNone(lib.next_waiting_uid({'waiting_sessions': []}))

    def test_first_uid_returned(self):
        summary = {'waiting_sessions': [{'uid': 'A'}, {'uid': 'B'}]}
        self.assertEqual(lib.next_waiting_uid(summary), 'A')


# ---------------------------------------------------------------------
# poll_once / handle_click / handle_focus_changed
# ---------------------------------------------------------------------

class TestPollOnce(BackendTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'runtime.json')

    def write_runtime(self, runtime):
        with open(self.path, 'w') as f:
            json.dump(runtime, f)

    def test_no_runtime_file_is_off(self):
        text, summary = lib.poll_once(path=self.path)
        self.assertEqual(text, 'Omniwatch off')
        self.assertIsNone(summary)

    def test_live_backend_returns_status_and_summary(self):
        self.write_runtime(self.backend.runtime)
        text, summary = lib.poll_once(path=self.path)
        self.assertEqual(text, '◉ 1 waiting')
        self.assertEqual(summary['waiting'], 1)

    def test_dead_backend_process_is_off(self):
        # port is real (backend is up) but the recorded pid is bogus, so
        # read_live_runtime() should treat it as not running.
        self.write_runtime(dict(self.backend.runtime, pid=99999999))
        text, summary = lib.poll_once(path=self.path)
        self.assertEqual(text, 'Omniwatch off')
        self.assertIsNone(summary)

    def test_request_failure_degrades_to_off(self):
        self.write_runtime(dict(self.backend.runtime, token='wrong'))
        text, summary = lib.poll_once(path=self.path)
        self.assertEqual(text, 'Omniwatch off')
        self.assertIsNone(summary)


class TestHandleClick(BackendTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'runtime.json')

    def write_runtime(self, runtime):
        with open(self.path, 'w') as f:
            json.dump(runtime, f)

    def test_no_backend_opens_app(self):
        opened = []
        result = lib.handle_click(path=self.path, open_app=opened.append)
        self.assertEqual(opened, ['Omniwatch'])
        self.assertIn('opened Omniwatch', result)

    def test_no_backend_without_open_app_hook_does_not_raise(self):
        result = lib.handle_click(path=self.path)  # open_app=None
        self.assertIn('opened Omniwatch', result)

    def test_live_backend_no_waiting_sessions(self):
        self.backend.httpd.summary = {'waiting': 0, 'waiting_sessions': []}
        self.write_runtime(self.backend.runtime)
        result = lib.handle_click(path=self.path)
        self.assertEqual(result, 'no sessions waiting')

    def test_live_backend_goes_to_next_waiting(self):
        self.write_runtime(self.backend.runtime)
        result = lib.handle_click(path=self.path)
        self.assertEqual(result, 'goto UID-1')
        self.assertIn(('POST', '/api/v1/sessions/UID-1/goto', {}),
                      self.backend.calls)

    def test_request_failure_reported_not_raised(self):
        self.write_runtime(dict(self.backend.runtime, token='wrong'))
        result = lib.handle_click(path=self.path)
        self.assertIn('backend request failed', result)


class TestHandleFocusChanged(BackendTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'runtime.json')

    def write_runtime(self, runtime):
        with open(self.path, 'w') as f:
            json.dump(runtime, f)

    def test_no_backend_is_a_quiet_noop(self):
        result = lib.handle_focus_changed('w0t0p0:UID-9', path=self.path)
        self.assertEqual(result, 'no backend')

    def test_live_backend_pushes_focus_by_uid(self):
        self.write_runtime(self.backend.runtime)
        result = lib.handle_focus_changed('w0t0p0:UID-9', path=self.path)
        self.assertEqual(result, 'focus UID-9')
        self.assertIn(('POST', '/api/v1/plugin/focus', {'uid': 'UID-9'}),
                      self.backend.calls)

    def test_request_failure_reported_not_raised(self):
        self.write_runtime(dict(self.backend.runtime, token='wrong'))
        result = lib.handle_focus_changed('w0t0p0:UID-9', path=self.path)
        self.assertIn('focus push failed', result)


if __name__ == '__main__':
    unittest.main()
