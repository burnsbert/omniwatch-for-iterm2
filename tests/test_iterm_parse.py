import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import iterm

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')

US, RS = iterm.US, iterm.RS


def rec(win='104', tab='1', sess='1', uid='UID-1', tty='/dev/ttys000',
        proc='false', name='zsh', text='hello\nworld'):
    return US.join([win, tab, sess, uid, tty, proc, name, text])


class TestParseSnapshot(TripwireTestCase):
    def test_real_fixture(self):
        with open(os.path.join(FIXTURES, 'snapshot_raw.txt'),
                  encoding='utf-8') as f:
            raw = f.read()
        snap = iterm.parse_snapshot(raw, at=123.0)
        self.assertEqual(len(snap.sessions), 11)
        self.assertEqual(snap.at, 123.0)
        first = snap.sessions[0]
        self.assertEqual(first.window_id, 104)
        self.assertEqual(first.tab_index, 1)
        self.assertEqual(first.tty, '/dev/ttys000')
        # every record carries a UUID and screen text
        for s in snap.sessions:
            self.assertRegex(s.uid, r'^[0-9A-F-]{36}$')
            self.assertTrue(s.text)
            self.assertIsInstance(s.is_processing, bool)

    def test_single_record(self):
        snap = iterm.parse_snapshot(rec(proc='true'))
        self.assertEqual(len(snap.sessions), 1)
        s = snap.sessions[0]
        self.assertTrue(s.is_processing)
        self.assertEqual(s.text, 'hello\nworld')
        self.assertEqual(s.name, 'zsh')

    def test_text_may_contain_tabs_and_newlines(self):
        text = 'col1\tcol2\nrow2\t\trow2b\n'
        snap = iterm.parse_snapshot(rec(text=text))
        self.assertEqual(snap.sessions[0].text, text.rstrip('\n'))

    def test_malformed_records_dropped(self):
        raw = RS.join([rec(), 'garbage-no-separators', rec(uid='UID-2')])
        snap = iterm.parse_snapshot(raw)
        self.assertEqual([s.uid for s in snap.sessions], ['UID-1', 'UID-2'])

    def test_non_numeric_indices_dropped(self):
        raw = RS.join([rec(win='abc'), rec(uid='UID-2')])
        snap = iterm.parse_snapshot(raw)
        self.assertEqual([s.uid for s in snap.sessions], ['UID-2'])

    def test_missing_value_tty_normalized(self):
        snap = iterm.parse_snapshot(rec(tty='missing value'))
        self.assertEqual(snap.sessions[0].tty, '')

    def test_not_running_sentinel(self):
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.parse_snapshot('__NOT_RUNNING__\n')

    def test_empty_output(self):
        snap = iterm.parse_snapshot('\n')
        self.assertEqual(snap.sessions, ())


class TestParsePaths(TripwireTestCase):
    def test_basic(self):
        raw = RS.join([f'UID-1{US}/Users/x/src', f'UID-2{US}'])
        snap = iterm.parse_paths(raw, at=5.0)
        self.assertEqual(snap.paths, (('UID-1', '/Users/x/src'), ('UID-2', '')))
        self.assertEqual(snap.at, 5.0)

    def test_missing_value_normalized(self):
        snap = iterm.parse_paths(f'UID-1{US}missing value')
        self.assertEqual(snap.paths, (('UID-1', ''),))

    def test_not_running(self):
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.parse_paths('__NOT_RUNNING__')

    def test_malformed_dropped(self):
        raw = RS.join(['no-sep-here', f'UID-2{US}/tmp'])
        snap = iterm.parse_paths(raw)
        self.assertEqual(snap.paths, (('UID-2', '/tmp'),))


class TestRunOsascriptAuthorization(TripwireTestCase):
    """New: run_osascript() must distinguish a denied-Automation failure
    from any other osascript error (docs/DESIGN.md §4.2)."""

    def _fake_run(self, returncode, stderr):
        def run(script, args=(), timeout=10):
            class Result:
                pass
            r = Result()
            r.returncode = returncode
            r.stdout = ''
            r.stderr = stderr
            return r
        return run

    def test_not_authorized_maps_to_itermnotauthorized(self):
        import unittest.mock as mock
        result = mock.Mock(returncode=1, stdout='',
                           stderr='execution error: Not authorized to send '
                                  'Apple events to iTerm2. (-1743)')
        with mock.patch('subprocess.run', return_value=result):
            with self.assertRaises(iterm.ItermNotAuthorized):
                iterm.run_osascript('tell application "iTerm2" to count windows')

    def test_other_failure_is_plain_itermerror(self):
        import unittest.mock as mock
        result = mock.Mock(returncode=1, stdout='', stderr='some other failure')
        with mock.patch('subprocess.run', return_value=result):
            with self.assertRaises(iterm.ItermError):
                iterm.run_osascript('tell application "iTerm2" to count windows')
            try:
                with mock.patch('subprocess.run', return_value=result):
                    iterm.run_osascript('x')
            except iterm.ItermNotAuthorized:
                self.fail('plain failures must not raise ItermNotAuthorized')
            except iterm.ItermError:
                pass


class TestNewScripts(TripwireTestCase):
    """New: write_text/close_session_tab/probe pass parameters through
    argv, never interpolated into AppleScript source (P-05)."""

    def test_write_text_ok(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append((script, args))
            return 'ok\n'
        self.assertTrue(iterm.write_text('UID-1', '1', submit=False, run=fake_run))
        script, args = calls[0]
        self.assertEqual(args, ('UID-1', '1', 'NO'))
        self.assertIn('write text', script)

    def test_write_text_submit_uses_newline_yes(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append(args)
            return 'ok\n'
        iterm.write_text('UID-1', 'hello', submit=True, run=fake_run)
        self.assertEqual(calls[0], ('UID-1', 'hello', 'YES'))

    def test_write_text_not_found(self):
        self.assertFalse(iterm.write_text('UID-1', 'x', run=lambda s, args=(), timeout=10: 'notfound\n'))

    def test_close_session_tab_ok(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append(args)
            return 'ok\n'
        self.assertTrue(iterm.close_session_tab('UID-9', run=fake_run))
        self.assertEqual(calls[0], ('UID-9',))

    def test_close_session_tab_not_found(self):
        self.assertFalse(iterm.close_session_tab(
            'UID-9', run=lambda s, args=(), timeout=10: 'notfound\n'))

    def test_probe_runs_the_probe_script_and_returns_true(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append(script)
            return ''
        self.assertTrue(iterm.probe(run=fake_run))
        self.assertIn('count windows', calls[0])

    def test_probe_propagates_not_authorized(self):
        def fake_run(script, args=(), timeout=10):
            raise iterm.ItermNotAuthorized('nope')
        with self.assertRaises(iterm.ItermNotAuthorized):
            iterm.probe(run=fake_run)


if __name__ == '__main__':
    unittest.main()
