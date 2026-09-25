"""New (docs/DESIGN.md §4.3/§4.7, docs/SHELL_CONTRACT.md §1-§3): CLI parsing,
serve lifecycle (ready line, shutdown, stdin EOF, parent death, signals),
doctor, and runtime.json handling.

In-process tests drive cli.serve() on a thread (coverage). A few tests
spawn a real `python -m omniwatch serve` child — always with fake
providers and OMNIWATCH_DEMO=1, never able to reach iTerm2 — to prove the
process-level contract the Swift shell relies on."""
import http.client
import io
import json
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import REAL_POPEN, REPO, child_env
import fake_providers as fp

from omniwatch import cli, runtime

FACTORY = 'fake_providers:make_providers'
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCENARIOS = ('default', 'denied', 'broken')


def make_special(scenario='default', seed=0, frozen_clock=None):
    """Providers factory for doctor/serve edge cases (see SCENARIOS)."""
    p = fp.make_providers('default', seed, frozen_clock)
    if scenario == 'denied':
        p.iterm.mode = 'not_authorized'
    elif scenario == 'broken':
        p.iterm.mode = 'error'
        p.usage_claude.has_credentials = lambda: 1 / 0
    return p


class LineSink:
    """Thread-safe stdout stand-in that signals when a line arrives."""

    def __init__(self):
        self.buf = io.StringIO()
        self.lock = threading.Lock()
        self.got_line = threading.Event()

    def write(self, s):
        with self.lock:
            self.buf.write(s)
            if '\n' in s:
                self.got_line.set()

    def flush(self):
        pass

    def getvalue(self):
        with self.lock:
            return self.buf.getvalue()


def http_json(port, token, method, path, body=None):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    headers = {'Authorization': 'Bearer ' + token}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    c.request(method, path, body=data, headers=headers)
    r = c.getresponse()
    out = (r.status, json.loads(r.read() or b'null'))
    c.close()
    return out


class CliTestCase(TripwireTestCase):
    def run_serve_thread(self, argv, **kwargs):
        opts = cli.serve_parser().parse_args(argv)
        sink = LineSink()
        err = io.StringIO()
        result = {}
        kwargs.setdefault('install_signals', False)
        kwargs.setdefault('watch_stdin_fd', None)
        kwargs.setdefault('redirect_fd2', False)

        def target():
            result['code'] = cli.serve(opts, stdout=sink, stderr=err, **kwargs)
        t = threading.Thread(target=target, daemon=True)
        t.start()
        self.assertTrue(sink.got_line.wait(10), err.getvalue())
        return t, sink, err, result, opts


class TestParsing(CliTestCase):
    def test_version(self):
        out = io.StringIO()
        self.assertEqual(cli.main(['--version'], stdout=out), 0)
        self.assertEqual(out.getvalue(), 'omniwatch 1.0.0\n')
        out = io.StringIO()
        self.assertEqual(cli.main(['serve', '--version'], stdout=out), 0)
        self.assertEqual(out.getvalue(), 'omniwatch 1.0.0\n')

    def test_bad_args_exit_2(self):
        with mock.patch('sys.stderr', io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                cli.main(['serve', '--port', 'x'])
        self.assertEqual(cm.exception.code, 2)

    def test_serve_defaults(self):
        o = cli.serve_parser().parse_args([])
        self.assertEqual((o.port, o.demo, o.demo_scenario, o.demo_seed, o.demo_clock,
                          o.ready_json, o.parent_pid, o.log_file, o.browser, o.no_open),
                         (0, False, 'default', 0, None, False, 0, None, False, False))

    def test_resolve_config_dir(self):
        o = cli.serve_parser().parse_args(['--config-dir', '~/x'])
        self.assertEqual(cli.resolve_config_dir(o), (os.path.expanduser('~/x'), False))
        o = cli.serve_parser().parse_args([])
        self.assertEqual(cli.resolve_config_dir(o), (self.tmp_config_dir, False))
        with mock.patch.dict(os.environ, {'OMNIWATCH_CONFIG_DIR': '',
                                          'XDG_CONFIG_HOME': '/xdg'}):
            self.assertEqual(cli.resolve_config_dir(o), ('/xdg/omniwatch', False))
            o.demo = True
            d, temp = cli.resolve_config_dir(o)
            self.assertTrue(temp)
            self.assertTrue(os.path.isdir(d))
            os.rmdir(d)

    def test_load_factory_errors(self):
        for spec in ('', 'nocolon', ':f', 'm:', 'no_such_module_xyz:f', 'fake_providers:nope'):
            with self.assertRaises(cli.CliError):
                cli.load_factory(spec)
        self.assertIs(cli.load_factory(FACTORY), fp.make_providers)

    def test_build_providers(self):
        with mock.patch.dict(os.environ, {'OMNIWATCH_DEMO': ''}):
            o = cli.serve_parser().parse_args(['--providers-factory', FACTORY,
                                               '--demo-scenario', 'empty', '--demo-clock', '5'])
            p, factory, scenarios = cli.build_providers(o)
            self.assertEqual(os.environ['OMNIWATCH_DEMO'], '1')
            self.assertEqual(p.demo.scenario, 'empty')
            self.assertEqual(p.clock.time(), 5.0)
            self.assertIs(factory, fp.make_providers)
            self.assertEqual(scenarios, fp.SCENARIOS)
        o.demo_scenario = 'bogus'
        with self.assertRaises(cli.CliError):
            cli.build_providers(o)

    def test_build_providers_real_demo_package(self):
        try:
            import omniwatch.demo  # noqa: F401 (WP3; may not have landed)
        except ImportError:
            self.skipTest('omniwatch.demo not present')
        o = cli.serve_parser().parse_args(['--demo', '--demo-clock', '1700000000'])
        p, factory, scenarios = cli.build_providers(o)
        self.assertIn('default', scenarios)
        self.assertEqual(p.clock.time(), 1700000000.0)

    def test_demo_unavailable(self):
        o = cli.serve_parser().parse_args(['--demo'])
        with mock.patch.dict(sys.modules, {'omniwatch.demo': None}):
            with self.assertRaises(cli.CliError):
                cli.build_providers(o)
            err = io.StringIO()
            self.assertEqual(cli.main(['serve', '--demo'], stderr=err, redirect_fd2=False), 1)
            self.assertIn('demo mode is unavailable', err.getvalue())

    def test_real_providers_when_not_demo(self):
        from omniwatch.providers import RealProviders
        o = cli.serve_parser().parse_args([])
        self.assertIsInstance(cli.build_providers(o)[0], RealProviders)

    def test_cli_error_exit_2(self):
        err = io.StringIO()
        self.assertEqual(cli.main(['doctor', '--providers-factory', 'bad'], stderr=err), 2)
        self.assertIn('MODULE:FUNC', err.getvalue())

    def test_helpers(self):
        self.assertEqual(cli.auth_url(5, 'tok'), 'http://127.0.0.1:5/auth?token=tok')
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.assertTrue(cli.stdin_is_pipe(r))
        os.close(w)
        self.assertFalse(cli.stdin_is_pipe(987654))
        with open(os.devnull) as f:
            self.assertFalse(cli.stdin_is_pipe(f.fileno()))
        with mock.patch('os.path.isdir', return_value=False):
            self.assertFalse(cli.app_installed())

    def test_open_browser_uses_webbrowser(self):
        with mock.patch('webbrowser.open') as wb:
            cli.open_browser('http://x')
        wb.assert_called_once_with('http://x')


class TestWatchers(CliTestCase):
    def test_watch_parent(self):
        stop = threading.Event()
        calls = []
        cli.watch_parent(42, stop, calls.append, interval=0, getppid=lambda: 1)
        self.assertEqual(calls, ['parent 42 is gone'])
        pids = iter([42, 42, 7])
        calls = []
        cli.watch_parent(42, stop, calls.append, interval=0, getppid=lambda: next(pids))
        self.assertEqual(calls, ['parent 42 is gone'])
        stop.set()
        calls = []
        cli.watch_parent(42, stop, calls.append, interval=0, getppid=lambda: 42)
        self.assertEqual(calls, [])

    def test_watch_stdin_eof(self):
        r, w = os.pipe()
        os.write(w, b'data')
        os.close(w)
        calls = []
        cli.watch_stdin(calls.append, fd=r)
        os.close(r)
        self.assertEqual(calls, ['stdin closed'])

    def test_watch_stdin_bad_fd(self):
        calls = []
        cli.watch_stdin(calls.append, fd=987654)
        self.assertEqual(calls, ['stdin closed'])


class TestServeInProcess(CliTestCase):
    def test_ready_line_state_and_shutdown(self):
        t, sink, err, result, opts = self.run_serve_thread(
            ['--ready-json', '--port', '0', '--providers-factory', FACTORY])
        lines = sink.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        ready = json.loads(lines[0])
        self.assertEqual(set(ready), {'event', 'port', 'token', 'pid', 'version', 'demo'})
        self.assertEqual((ready['event'], ready['pid'], ready['version'], ready['demo']),
                         ('ready', os.getpid(), '1.0.0', True))
        self.assertRegex(ready['token'], r'^[A-Za-z0-9_-]{43}$')
        rt = runtime.read(os.path.join(self.tmp_config_dir, 'runtime.json'))
        self.assertEqual((rt['port'], rt['token']), (ready['port'], ready['token']))
        status, state = http_json(ready['port'], ready['token'], 'GET', '/api/v1/state')
        self.assertEqual(status, 200)
        self.assertTrue(state['demo'])
        self.assertEqual(state['summary']['waiting'], 2)
        self.assertEqual(state['sessions'][0]['label'], 'refactor')   # demo seed
        status, _ = http_json(ready['port'], ready['token'], 'POST', '/api/v1/demo/step',
                              {'seconds': 6})
        self.assertEqual(status, 200)
        self.assertEqual(http_json(ready['port'], ready['token'], 'POST',
                                   '/api/v1/shutdown'), (200, {'ok': True}))
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertEqual(result['code'], 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp_config_dir, 'runtime.json')))
        self.assertEqual(len(sink.getvalue().splitlines()), 1)   # nothing after the ready line

    def test_stdin_eof_exits(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        t, sink, err, result, _ = self.run_serve_thread(
            ['--ready-json', '--providers-factory', FACTORY], watch_stdin_fd=r)
        os.close(w)
        t.join(5)
        self.assertEqual(result.get('code'), 0)

    def test_parent_change_exits(self):
        with mock.patch.object(cli, 'PARENT_CHECK_SECONDS', 0.05):
            t, sink, err, result, _ = self.run_serve_thread(
                ['--ready-json', '--parent-pid', '1', '--providers-factory', FACTORY])
            t.join(5)
        self.assertEqual(result.get('code'), 0)

    def test_human_banner_and_browser(self):
        opened = []
        log_path = os.path.join(self.tmp_config_dir, 'b.log')
        with mock.patch.object(cli, 'open_browser', opened.append), \
                mock.patch('omniwatch.config.BACKEND_LOG_PATH', log_path):
            t, sink, err, result, opts = self.run_serve_thread(
                ['--browser', '--providers-factory', FACTORY])
            self.assertEqual(opts.log_file, log_path)   # --browser defaults the log file
            out = sink.getvalue()
            self.assertIn('Omniwatch 1.0.0 on http://127.0.0.1:', out)
            port = int(out.split('127.0.0.1:')[1].split('/')[0])
            self.assertEqual(len(opened), 1)
            self.assertTrue(opened[0].startswith('http://127.0.0.1:%d/auth?token=' % port))
            token = opened[0].split('token=')[1]
            http_json(port, token, 'POST', '/api/v1/shutdown')
            t.join(5)
        self.assertEqual(result['code'], 0)
        with open(log_path) as f:
            self.assertIn('shutting down: shutdown requested', f.read())

    def test_browser_open_failure_is_logged(self):
        def boom(url):
            raise RuntimeError('no browser')
        log_path = os.path.join(self.tmp_config_dir, 'b.log')
        with mock.patch.object(cli, 'open_browser', boom):
            t, sink, err, result, _ = self.run_serve_thread(
                ['--browser', '--log-file', log_path, '--providers-factory', FACTORY])
            port = int(sink.getvalue().split('127.0.0.1:')[1].split('/')[0])
            token = sink.getvalue().split('token=')[1].split()[0]
            http_json(port, token, 'POST', '/api/v1/shutdown')
            t.join(5)
        with open(log_path) as f:
            self.assertIn('could not open a browser: no browser', f.read())

    def test_port_in_use_returns_1(self):
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        s.listen(1)
        self.addCleanup(s.close)
        opts = cli.serve_parser().parse_args(
            ['--ready-json', '--port', str(s.getsockname()[1]), '--providers-factory', FACTORY])
        out, err = LineSink(), io.StringIO()
        self.assertEqual(cli.serve(opts, stdout=out, stderr=err, redirect_fd2=False,
                                   install_signals=False, watch_stdin_fd=None), 1)
        self.assertEqual(out.getvalue(), '')
        self.assertIn('omniwatch:', err.getvalue())

    def test_demo_temp_config_dir_removed(self):
        with mock.patch.dict(os.environ, {'OMNIWATCH_CONFIG_DIR': ''}):
            t, sink, err, result, _ = self.run_serve_thread(
                ['--ready-json', '--demo', '--providers-factory', FACTORY, '--demo-clock', '1'])
            ready = json.loads(sink.getvalue())
            _, diag = http_json(ready['port'], ready['token'], 'GET', '/api/v1/diagnostics')
            config_dir = diag['config_dir']
            self.assertTrue(os.path.basename(config_dir).startswith('omniwatch-demo-'))
            self.assertTrue(os.path.exists(os.path.join(config_dir, 'runtime.json')))
            http_json(ready['port'], ready['token'], 'POST', '/api/v1/shutdown')
            t.join(5)
        self.assertFalse(os.path.exists(config_dir))

    def test_signal_handlers_installed_on_main_thread(self):
        """serve() on the main thread installs SIGTERM/SIGINT handlers that
        request shutdown, and restores the old ones afterwards."""
        before = signal.getsignal(signal.SIGTERM)
        opts = cli.serve_parser().parse_args(['--ready-json', '--providers-factory', FACTORY])
        sink = LineSink()

        def fire():
            sink.got_line.wait(10)
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=fire, daemon=True).start()
        code = cli.serve(opts, stdout=sink, stderr=io.StringIO(), redirect_fd2=False,
                         watch_stdin_fd=None)
        self.assertEqual(code, 0)
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)


class TestMainModes(CliTestCase):
    def test_bare_opens_installed_app(self):
        from omniwatch import providers
        with mock.patch.object(cli, 'app_installed', return_value=True), \
                mock.patch.object(providers.RealOpener, 'open_app') as open_app:
            self.assertEqual(cli.main([]), 0)
        open_app.assert_called_once_with('Omniwatch')

    def test_bare_reuses_running_backend(self):
        info = {'port': 1, 'token': 't', 'pid': os.getpid()}
        runtime.write(os.path.join(self.tmp_config_dir, 'runtime.json'), info)
        opened, out = [], io.StringIO()
        with mock.patch.object(cli, 'app_installed', return_value=False), \
                mock.patch.object(cli, 'backend_healthy', return_value=True), \
                mock.patch.object(cli, 'open_browser', opened.append):
            self.assertEqual(cli.main(['--browser'], stdout=out), 0)
        self.assertEqual(opened, ['http://127.0.0.1:1/auth?token=t'])
        self.assertIn('already running', out.getvalue())
        with mock.patch.object(cli, 'backend_healthy', return_value=True), \
                mock.patch.object(cli, 'open_browser') as ob:
            self.assertEqual(cli.main(['--no-open'], stdout=io.StringIO()), 0)
        ob.assert_not_called()

    def test_bare_starts_browser_mode_when_nothing_running(self):
        calls = []

        def fake_serve(opts, **kw):
            calls.append(opts)
            return 0
        with mock.patch.object(cli, 'app_installed', return_value=False), \
                mock.patch.object(cli, 'serve', fake_serve):
            self.assertEqual(cli.main([]), 0)
            self.assertEqual(cli.main(['demo', '--no-open']), 0)
        self.assertTrue(calls[0].browser)
        self.assertFalse(calls[0].demo)
        self.assertTrue(calls[1].demo and calls[1].browser and calls[1].no_open)

    def test_backend_healthy_against_live_server(self):
        t, sink, err, result, _ = self.run_serve_thread(
            ['--ready-json', '--providers-factory', FACTORY])
        ready = json.loads(sink.getvalue())
        self.assertTrue(cli.backend_healthy(ready))
        self.assertFalse(cli.backend_healthy(dict(ready, token='wrong')))
        http_json(ready['port'], ready['token'], 'POST', '/api/v1/shutdown')
        t.join(5)
        self.assertFalse(cli.backend_healthy(ready, timeout=0.5))


class TestDoctor(CliTestCase):
    def doctor(self, *args):
        out = io.StringIO()
        self.assertEqual(cli.main(['doctor'] + list(args), stdout=out), 0)
        return out.getvalue()

    def test_text_report(self):
        text = self.doctor('--providers-factory', FACTORY)
        self.assertIn('Omniwatch 1.0.0', text)
        self.assertIn('iTerm2           ok — 4 session(s)', text)
        self.assertIn('Claude creds     yes', text)
        self.assertIn('running backend  none', text)

    def test_json_report_states(self):
        rep = json.loads(self.doctor('--json', '--providers-factory', FACTORY,
                                     '--demo-scenario', 'not-running'))
        self.assertEqual(rep['iterm']['status'], 'not_running')
        self.assertEqual(rep['automation'], 'unknown')
        rep = json.loads(self.doctor('--json', '--providers-factory', 'test_cli:make_special',
                                     '--demo-scenario', 'denied'))
        self.assertEqual((rep['iterm']['status'], rep['automation']), ('not_authorized', 'denied'))
        rep = json.loads(self.doctor('--json', '--providers-factory', 'test_cli:make_special',
                                     '--demo-scenario', 'broken'))
        self.assertEqual(rep['iterm']['status'], 'error')
        self.assertIsNone(rep['claude_credentials'])
        rep = json.loads(self.doctor('--json', '--demo', '--providers-factory', FACTORY))
        self.assertEqual(rep['config_dir'], '(demo: temporary)')

    def test_text_report_with_running_backend(self):
        runtime.write(os.path.join(self.tmp_config_dir, 'runtime.json'),
                      {'port': 9, 'token': 't', 'pid': os.getpid()})
        text = self.doctor('--providers-factory', 'test_cli:make_special',
                           '--demo-scenario', 'broken')
        self.assertIn('running backend  pid %d on port 9' % os.getpid(), text)
        self.assertIn('Claude creds     unknown', text)


class TestProcessLifecycle(CliTestCase):
    """Real child processes: the exact contract the Swift shell supervises."""

    def spawn(self, *extra):
        env = child_env(PYTHONPATH=REPO + os.pathsep + TESTS_DIR)
        log = os.path.join(self.tmp_config_dir, 'backend.log')
        proc = REAL_POPEN(
            [sys.executable, '-m', 'omniwatch', 'serve', '--ready-json', '--port', '0',
             '--log-file', log, '--providers-factory', FACTORY] + list(extra),
            cwd=REPO, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        self.addCleanup(self._reap, proc)
        ready_io, _, _ = select.select([proc.stdout], [], [], 15)
        self.assertTrue(ready_io, 'no ready line within 15 s')
        line = proc.stdout.readline()
        return proc, json.loads(line), log

    @staticmethod
    def _reap(proc):
        if proc.poll() is None:
            proc.kill()
        proc.wait(5)
        for f in (proc.stdin, proc.stdout, proc.stderr):
            try:
                f.close()
            except Exception:
                pass

    def assertExits(self, proc, within, code=0):
        start = time.time()
        rc = proc.wait(within)
        self.assertEqual(rc, code, proc.stderr.read().decode())
        return time.time() - start

    def test_ready_then_shutdown_exit_0(self):
        proc, ready, log = self.spawn('--parent-pid', str(os.getpid()))
        self.assertEqual(ready['pid'], proc.pid)
        status, state = http_json(ready['port'], ready['token'], 'GET', '/api/v1/state')
        self.assertEqual((status, state['summary']['waiting']), (200, 2))
        self.assertTrue(os.path.exists(os.path.join(self.tmp_config_dir, 'runtime.json')))
        self.assertEqual(http_json(ready['port'], ready['token'], 'POST', '/api/v1/shutdown'),
                         (200, {'ok': True}))
        self.assertLess(self.assertExits(proc, 2), 2)
        self.assertEqual(proc.stdout.read(), b'')           # nothing after the ready line
        self.assertFalse(os.path.exists(os.path.join(self.tmp_config_dir, 'runtime.json')))

    def test_stdin_eof_exit_0(self):
        proc, ready, _ = self.spawn('--parent-pid', str(os.getpid()))
        proc.stdin.close()
        self.assertExits(proc, 5)

    def test_parent_pid_mismatch_exit_0(self):
        proc, ready, _ = self.spawn('--parent-pid', '1')
        self.assertExits(proc, 5)

    def test_sigterm_exit_0(self):
        proc, ready, log = self.spawn()
        proc.send_signal(signal.SIGTERM)
        self.assertExits(proc, 5)
        with open(log) as f:
            self.assertIn('shutting down: signal %d' % signal.SIGTERM, f.read())


if __name__ == '__main__':
    unittest.main()
