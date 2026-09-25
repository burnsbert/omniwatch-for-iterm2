import os
import queue
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import iterm, itermcolor, pollers
from omniwatch.snapshot import AgentSnapshot, ItermSnapshot


def agents_snap(*ttys_agents):
    return AgentSnapshot(
        ttys=tuple((t, frozenset(a)) for t, a in ttys_agents), at=1.0)


class TestUsagePollerGating(TripwireTestCase):
    """Exercises poll() synchronously — no threads started."""

    def setUp(self):
        super().setUp()
        self.events = queue.Queue()
        self.box = pollers.LatestBox()
        self.fetches = []

    def poller(self, result=({'x': 1}, None)):
        def fetch():
            self.fetches.append(1)
            return result
        return pollers.UsagePoller('usage_claude', self.events,
                                   threading.Event(), self.box, 'claude',
                                   fetch, base_interval=300)

    def drain(self):
        out = []
        while not self.events.empty():
            out.append(self.events.get_nowait())
        return out

    def test_inactive_publishes_once_no_fetch(self):
        self.box.set(agents_snap(('/dev/ttys001', {'codex'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0)
        events = self.drain()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0][1].inactive)
        self.assertEqual(self.fetches, [])

    def test_active_fetches_then_waits_interval(self):
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0)   # within interval — no fetch
        p.poll(now=401.0)   # past interval — fetch again
        self.assertEqual(len(self.fetches), 2)
        events = self.drain()
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0][1].data, {'x': 1})
        self.assertTrue(events[0][1].ok)

    def test_failure_keeps_last_good_and_respects_retry_after(self):
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        def failing_fetch():
            self.fetches.append(1)
            return (None, 900)
        p.fetch = failing_fetch
        p.poll(now=401.0)
        events = self.drain()
        self.assertEqual(events[1][1].data, {'x': 1})  # last good kept
        self.assertFalse(events[1][1].ok)
        self.assertEqual(p.interval, 900)
        p.poll(now=401.0 + 350)  # would be due at base interval, not at 900
        self.assertEqual(len(self.fetches), 2)

    def test_agent_disappearing_clears_data(self):
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        self.box.set(agents_snap())
        p.poll(now=105.0)
        events = self.drain()
        self.assertTrue(events[-1][1].inactive)
        self.assertIsNone(p.data)

    def test_forced_kick_rate_floored(self):
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0, forced=True)   # only 5s old — no refetch
        self.assertEqual(len(self.fetches), 1)
        p.poll(now=115.0, forced=True)   # >10s old — refetch
        self.assertEqual(len(self.fetches), 2)


class TestColorsPoller(TripwireTestCase):
    """Exercises poll() synchronously — no threads, no real iTerm2."""

    def setUp(self):
        super().setUp()
        self.events = queue.Queue()

    def drain(self):
        out = []
        while not self.events.empty():
            out.append(self.events.get_nowait())
        return out

    def poller(self, fetch):
        return pollers.ColorsPoller(self.events, threading.Event(),
                                    fetch=fetch)

    def test_normal_fetch_emits_snapshot(self):
        p = self.poller(lambda: {'UID-1': 'red', 'UID-2': 'blue'})
        p.poll(now=100.0)
        events = self.drain()
        self.assertEqual(len(events), 1)
        kind, snap = events[0]
        self.assertEqual(kind, 'colors')
        self.assertEqual(dict(snap.colors),
                         {'UID-1': 'red', 'UID-2': 'blue'})
        self.assertEqual(snap.at, 100.0)
        self.assertTrue(p.available)

    def test_unavailable_stops_future_polls_without_raising(self):
        calls = []

        def fetch():
            calls.append(1)
            raise itermcolor.ColorApiUnavailable('no iterm2 package')

        p = self.poller(fetch)
        p.poll(now=100.0)
        p.poll(now=105.0)  # poll() itself checks `available` and no-ops
        self.assertFalse(p.available)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.drain(), [])

    def test_transient_failure_is_swallowed_and_retried(self):
        calls = []

        def fetch():
            calls.append(1)
            raise ConnectionRefusedError('API not enabled yet')

        p = self.poller(fetch)
        p.poll(now=100.0)
        p.poll(now=105.0)
        self.assertTrue(p.available)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.drain(), [])


class TestColorsPollerSetColor(TripwireTestCase):
    """Exercises request()/_do_action() synchronously — no thread spun."""

    def poller(self, set_color):
        return pollers.ColorsPoller(queue.Queue(), threading.Event(),
                                    fetch=lambda: {}, set_color=set_color)

    def test_request_enqueues_set_color_action(self):
        p = self.poller(lambda uid, name: None)
        p.request('UID-9', 'red')
        self.assertEqual(p.actions.get_nowait(),
                         ('set_color', ('UID-9', 'red')))

    def test_kick_enqueues_poll_sentinel(self):
        p = self.poller(lambda uid, name: None)
        p.kick()
        self.assertEqual(p.actions.get_nowait(), ('poll', ()))

    def test_do_action_calls_set_color(self):
        calls = []
        p = self.poller(lambda uid, name: calls.append((uid, name)))
        p._do_action('set_color', ('UID-1', 'red'))
        self.assertEqual(calls, [('UID-1', 'red')])
        self.assertTrue(p.available)

    def test_do_action_clear_passes_none(self):
        calls = []
        p = self.poller(lambda uid, name: calls.append((uid, name)))
        p._do_action('set_color', ('UID-1', None))
        self.assertEqual(calls, [('UID-1', None)])

    def test_do_action_unavailable_stops_poller(self):
        def set_color(uid, name):
            raise itermcolor.ColorApiUnavailable('no iterm2 package')
        p = self.poller(set_color)
        p._do_action('set_color', ('UID-1', 'red'))
        self.assertFalse(p.available)

    def test_do_action_transient_failure_swallowed(self):
        def set_color(uid, name):
            raise ConnectionRefusedError('API not enabled yet')
        p = self.poller(set_color)
        p._do_action('set_color', ('UID-1', 'red'))  # must not raise
        self.assertTrue(p.available)


class TestLatestBox(TripwireTestCase):
    def test_set_get(self):
        box = pollers.LatestBox()
        self.assertIsNone(box.get())
        box.set(42)
        self.assertEqual(box.get(), 42)


class _FakeIterm:
    def __init__(self):
        self.calls = []
        self.goto_result = True
        self.reply_result = True
        self.close_result = True

    def goto(self, uid):
        self.calls.append(('goto', uid))
        return self.goto_result

    def close_uid(self, uid):
        self.calls.append(('close_uid', uid))
        return self.close_result

    def new_tab(self):
        self.calls.append(('new_tab',))

    def reply(self, uid, text, submit=False):
        self.calls.append(('reply', uid, text, submit))
        return self.reply_result

    def probe(self):
        self.calls.append(('probe',))
        return True

    def snapshot(self, at=0.0):
        return ItermSnapshot(at=at)

    def paths(self, at=0.0):
        raise RuntimeError('boom')


class _FakeProviders:
    def __init__(self, iterm_provider):
        self.iterm = iterm_provider


class TestItermWorkerActions(TripwireTestCase):
    """New (docs/DESIGN.md §4.2): provider-injected ItermWorker actions —
    reply, close_uid, probe — exercised synchronously via _do_action(),
    matching the style of the other poller tests above."""

    def setUp(self):
        super().setUp()
        self.events = queue.Queue()
        self.fake_iterm = _FakeIterm()
        self.providers = _FakeProviders(self.fake_iterm)
        self.worker = pollers.ItermWorker(self.events, threading.Event(),
                                          self.providers)

    def drain(self):
        out = []
        while not self.events.empty():
            out.append(self.events.get_nowait())
        return out

    def test_goto_action(self):
        self.worker._do_action('goto', ('UID-1',))
        self.assertEqual(self.fake_iterm.calls, [('goto', 'UID-1')])
        kind, (akind, ok, detail) = self.drain()[0]
        self.assertEqual((kind, akind, ok, detail), ('action', 'goto', True, ''))

    def test_goto_not_found(self):
        self.fake_iterm.goto_result = False
        self.worker._do_action('goto', ('UID-1',))
        _, (akind, ok, detail) = self.drain()[0]
        self.assertFalse(ok)
        self.assertEqual(detail, 'session not found')

    def test_close_uid_action(self):
        self.worker._do_action('close_uid', ('UID-9',))
        self.assertEqual(self.fake_iterm.calls, [('close_uid', 'UID-9')])

    def test_new_tab_action(self):
        self.worker._do_action('new', ())
        self.assertEqual(self.fake_iterm.calls, [('new_tab',)])

    def test_reply_action(self):
        self.worker._do_action('reply', ('UID-1', '1', False))
        self.assertEqual(self.fake_iterm.calls,
                         [('reply', 'UID-1', '1', False)])

    def test_reply_not_found(self):
        self.fake_iterm.reply_result = False
        self.worker._do_action('reply', ('UID-1', '1', False))
        _, (akind, ok, detail) = self.drain()[0]
        self.assertFalse(ok)
        self.assertEqual(detail, 'session not found')

    def test_probe_action(self):
        self.worker._do_action('probe', ())
        self.assertEqual(self.fake_iterm.calls, [('probe',)])

    def test_action_exception_reports_failure(self):
        def boom(uid):
            raise RuntimeError('nope')
        self.fake_iterm.goto = boom
        self.worker._do_action('goto', ('UID-1',))
        _, (akind, ok, detail) = self.drain()[0]
        self.assertFalse(ok)
        self.assertEqual(detail, 'nope')

    def test_poll_snapshot_not_authorized_maps_to_error_prefix(self):
        def raise_not_authorized(at=0.0):
            raise iterm.ItermNotAuthorized('nope')
        self.fake_iterm.snapshot = raise_not_authorized
        self.worker._poll_snapshot()
        kind, snap = self.drain()[0]
        self.assertEqual(kind, 'iterm')
        self.assertTrue(snap.error.startswith('not_authorized:'))

    def test_poll_snapshot_not_running(self):
        def raise_not_running(at=0.0):
            raise iterm.ItermNotRunning()
        self.fake_iterm.snapshot = raise_not_running
        self.worker._poll_snapshot()
        kind, snap = self.drain()[0]
        self.assertTrue(snap.not_running)

    def test_poll_paths_failure_is_swallowed(self):
        self.worker._poll_paths()  # fake_iterm.paths() raises — must not propagate
        self.assertEqual(self.drain(), [])


class _NoopAgents:
    def scan(self):
        return {}

    def fill_cwds(self, ttys):
        return {}


class _NoopColors:
    def fetch(self):
        return {}

    def set(self, uid, name):
        return True


class _FullFakeProviders:
    def __init__(self):
        self.iterm = _FakeIterm()
        self.agents = _NoopAgents()
        self.usage_claude = _NoopUsage()
        self.usage_codex = _NoopUsage()
        self.colors = _NoopColors()


class _NoopUsage:
    def fetch(self):
        return (None, None)


class TestStartPollers(TripwireTestCase):
    """New (docs/DESIGN.md §4.2): start_pollers()/kick_all() against an
    injected `providers` object — no real subprocess/network involved, so
    a fast, deterministic integration test of the wiring."""

    def test_start_kick_and_stop_all_pollers(self):
        events = queue.Queue()
        stop = threading.Event()
        fake_providers = _FullFakeProviders()
        started, needs_cwd_box = pollers.start_pollers(events, stop,
                                                        fake_providers)
        try:
            self.assertEqual(set(started),
                             {'iterm', 'agents', 'colors', 'usage_claude',
                              'usage_codex'})
            for name, p in started.items():
                self.assertTrue(p.is_alive(), f'{name} did not start')
            pollers.kick_all(started)
            needs_cwd_box.set(frozenset({'/dev/ttys000'}))
        finally:
            stop.set()
            pollers.kick_all(started)
            for name, p in started.items():
                p.join(timeout=3)
        for name, p in started.items():
            self.assertFalse(p.is_alive(), f'{name} did not stop')
        # the iterm worker should have posted at least one snapshot event
        kinds = set()
        while not events.empty():
            kinds.add(events.get_nowait()[0])
        self.assertIn('iterm', kinds)


if __name__ == '__main__':
    unittest.main()
