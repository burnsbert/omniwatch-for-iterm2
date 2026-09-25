"""New module (docs/DESIGN.md §4.2/§5): the Provider protocol and
RealProviders wrapping. Exercises RealProviders' methods with injected
`run=`/`fetch=`/`set_color=` fakes, never a real subprocess or the
network — the tripwire would fail the test if anything slipped through.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireError, TripwireTestCase

from omniwatch import providers
from omniwatch.snapshot import ItermSnapshot, PathsSnapshot


class TestRealItermProvider(TripwireTestCase):
    def test_snapshot_uses_injected_run(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append(script)
            return ''
        p = providers.RealItermProvider(run=fake_run)
        snap = p.snapshot(at=5.0)
        self.assertIsInstance(snap, ItermSnapshot)
        self.assertEqual(snap.at, 5.0)
        self.assertEqual(len(calls), 1)

    def test_paths_uses_injected_run(self):
        p = providers.RealItermProvider(run=lambda s, args=(), timeout=10: '')
        self.assertIsInstance(p.paths(at=1.0), PathsSnapshot)

    def test_goto_close_reply_probe_new_tab_roundtrip(self):
        calls = []

        def fake_run(script, args=(), timeout=10):
            calls.append((script.strip().split('\n')[0][:0], args))
            return 'ok\n'
        p = providers.RealItermProvider(run=fake_run)
        self.assertTrue(p.goto('UID-1'))
        self.assertTrue(p.close_uid('UID-1'))
        self.assertTrue(p.reply('UID-1', '1', submit=False))
        self.assertTrue(p.probe())
        p.new_tab()
        self.assertEqual(len(calls), 5)

    def test_launch_goes_through_subprocess_and_is_tripwired(self):
        p = providers.RealItermProvider()
        with self.assertRaises(TripwireError):
            p.launch()

    def test_default_run_is_real_osascript_runner(self):
        from omniwatch import iterm as iterm_module
        p = providers.RealItermProvider()
        self.assertIs(p.run, iterm_module.run_osascript)


class TestRealAgentsProvider(TripwireTestCase):
    def test_scan_and_fill_cwds_are_tripwired_without_a_fake(self):
        p = providers.RealAgentsProvider()
        # get_agent_ttys()/fill_missing_tty_cwds() swallow subprocess
        # errors internally (see agents.py), so the tripwire firing
        # inside them must not propagate — they degrade to {}.
        self.assertEqual(p.scan(), {})
        self.assertEqual(p.fill_cwds(['/dev/ttys000']), {})


class TestRealUsageProvider(TripwireTestCase):
    def test_fetch_delegates_to_injected_callable(self):
        p = providers.RealUsageProvider(lambda: ({'x': 1}, None))
        self.assertEqual(p.fetch(), ({'x': 1}, None))


class TestRealColorsProvider(TripwireTestCase):
    def test_fetch_and_set_raise_color_api_unavailable_without_iterm2(self):
        from omniwatch import itermcolor
        p = providers.RealColorsProvider()
        with mock.patch.dict(sys.modules, {'iterm2': None}):
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                p.fetch()
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                p.set('UID-1', 'red')


class TestRealOpenerAndClock(TripwireTestCase):
    def test_open_url_is_tripwired(self):
        p = providers.RealOpener()
        with self.assertRaises(TripwireError):
            p.open_url('https://example.invalid')

    def test_open_app_is_tripwired(self):
        p = providers.RealOpener()
        with self.assertRaises(TripwireError):
            p.open_app('iTerm')

    def test_clock_reads_real_time(self):
        import time
        clock = providers.RealClock()
        before = time.time()
        self.assertGreaterEqual(clock.time(), before)
        self.assertIsInstance(clock.monotonic(), float)
        clock.sleep(0)  # must not raise


class TestRealProvidersBundle(TripwireTestCase):
    def test_has_every_provider(self):
        p = providers.RealProviders()
        self.assertIsInstance(p.iterm, providers.RealItermProvider)
        self.assertIsInstance(p.agents, providers.RealAgentsProvider)
        self.assertIsInstance(p.usage_claude, providers.RealUsageProvider)
        self.assertIsInstance(p.usage_codex, providers.RealUsageProvider)
        self.assertIsInstance(p.colors, providers.RealColorsProvider)
        self.assertIsInstance(p.opener, providers.RealOpener)
        self.assertIsInstance(p.clock, providers.RealClock)

    def test_usage_providers_wrap_the_right_fetch_functions(self):
        from omniwatch import usage_claude, usage_codex
        p = providers.RealProviders()
        self.assertIs(p.usage_claude._fetch, usage_claude.fetch_usage)
        self.assertIs(p.usage_codex._fetch, usage_codex.fetch_codex_usage)


if __name__ == '__main__':
    unittest.main()
