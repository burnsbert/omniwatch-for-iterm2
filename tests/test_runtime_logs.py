"""New (docs/DESIGN.md §4.5/§4.6, P-77): runtime.json (0600, owner-only
removal) and the log file + fd-2 redirect."""
import json
import logging
import os
import stat
import sys
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import child_env, real_run

from omniwatch import logs, runtime


class TestRuntime(TripwireTestCase):
    def path(self):
        return os.path.join(self.tmp_config_dir, 'sub', 'runtime.json')

    def test_write_is_0600_and_readable(self):
        info = {'port': 5, 'token': 't', 'pid': os.getpid(), 'version': '1', 'started_at': 1.0}
        runtime.write(self.path(), info)
        self.assertEqual(stat.S_IMODE(os.stat(self.path()).st_mode), 0o600)
        self.assertEqual(runtime.read(self.path()), info)
        self.assertEqual(runtime.read_live(self.path()), info)
        self.assertEqual([f for f in os.listdir(os.path.dirname(self.path()))], ['runtime.json'])

    def test_read_rejects_bad_files(self):
        p = self.path()
        self.assertIsNone(runtime.read(p))
        os.makedirs(os.path.dirname(p))
        for content in ('not json', '[]', '{"port": "x", "pid": 1, "token": "t"}',
                        '{"port": 1, "pid": 1}'):
            with open(p, 'w') as f:
                f.write(content)
            self.assertIsNone(runtime.read(p), content)

    def test_read_live_ignores_dead_pid(self):
        runtime.write(self.path(), {'port': 5, 'token': 't', 'pid': 2 ** 22 + 12345})
        self.assertIsNone(runtime.read_live(self.path()))

    def test_pid_alive(self):
        self.assertTrue(runtime.pid_alive(os.getpid()))
        self.assertTrue(runtime.pid_alive(1))            # launchd: EPERM → alive
        self.assertFalse(runtime.pid_alive(0))
        self.assertFalse(runtime.pid_alive('1'))
        self.assertFalse(runtime.pid_alive(2 ** 22 + 12345))

    def test_remove_only_own_file(self):
        runtime.write(self.path(), {'port': 5, 'token': 't', 'pid': 1})
        self.assertFalse(runtime.remove(self.path()))
        self.assertTrue(os.path.exists(self.path()))
        self.assertTrue(runtime.remove(self.path(), pid=1))
        self.assertFalse(runtime.remove(self.path()))     # already gone
        runtime.write(self.path(), {'port': 5, 'token': 't', 'pid': os.getpid()})
        self.assertTrue(runtime.remove(self.path()))

    def test_write_failure_cleans_temp(self):
        class Boom:
            pass
        with self.assertRaises(TypeError):
            runtime.write(self.path(), {'x': Boom()})
        self.assertEqual(os.listdir(os.path.dirname(self.path())), [])


class TestLogs(TripwireTestCase):
    def tearDown(self):
        logs.teardown()
        super().tearDown()

    def test_file_logging_with_rotation(self):
        path = os.path.join(self.tmp_config_dir, 'logs', 'backend.log')
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as f:
            f.write('previous run\n')
        logs.setup(path, redirect_fd2=False)
        logs.log.info('hello %s', 'log')
        logs.teardown()
        with open(path + '.1') as f:
            self.assertEqual(f.read(), 'previous run\n')
        with open(path) as f:
            self.assertIn('INFO MainThread omniwatch: hello log', f.read())

    def test_stream_logging(self):
        import io
        buf = io.StringIO()
        logs.setup(None, stream=buf, level=logging.WARNING)
        logs.log.info('quiet')
        logs.log.warning('loud')
        self.assertNotIn('quiet', buf.getvalue())
        self.assertIn('loud', buf.getvalue())
        logs.setup(None, stream=buf)     # re-setup replaces the handler
        self.assertEqual(len(logs.log.handlers), 1)

    def test_rotate_missing_is_noop(self):
        logs.rotate(os.path.join(self.tmp_config_dir, 'nope.log'))

    def test_rotate_failure_ignored(self):
        path = os.path.join(self.tmp_config_dir, 'x.log')
        open(path, 'w').close()
        with unittest.mock.patch('os.replace', side_effect=OSError('busy')):
            logs.rotate(path)
        self.assertTrue(os.path.exists(path))

    def test_setup_redirects_fd2_to_the_log_stream(self):
        path = os.path.join(self.tmp_config_dir, 'fd.log')
        seen = []
        with unittest.mock.patch.object(logs, 'redirect_stderr', seen.append):
            handler = logs.setup(path)
        self.assertEqual(seen, [handler.stream])

    def test_redirect_stderr_onto_spare_fd(self):
        """The real dup2, onto a spare descriptor (never the runner's fd 2)."""
        path = os.path.join(self.tmp_config_dir, 'fd.log')
        spare = os.dup(1)
        try:
            with open(path, 'w') as f:
                logs.redirect_stderr(f, fd=spare)
                os.write(spare, b'spare fd write\n')
        finally:
            os.close(spare)
        with open(path) as f:
            self.assertEqual(f.read(), 'spare fd write\n')

    def test_teardown_swallows_handler_errors(self):
        class Bad(logging.Handler):
            def flush(self):
                raise OSError('closed')
        logs.log.addHandler(Bad())
        logs.teardown()
        self.assertEqual(logs.log.handlers, [])

    def test_redirect_stderr_fd(self):
        """fd redirect in a child process (never dup2 the test runner's fd 2)."""
        path = os.path.join(self.tmp_config_dir, 'child.log')
        code = ('import os,sys; from omniwatch import logs; logs.setup(%r); '
                'os.write(2, b"raw fd2 write\\n"); logs.log.info("via logging")' % path)
        rc, _, err = real_run([sys.executable, '-c', code], env=child_env())
        self.assertEqual(rc, 0, err)
        with open(path) as f:
            text = f.read()
        self.assertIn('raw fd2 write', text)
        self.assertIn('via logging', text)


if __name__ == '__main__':
    unittest.main()
