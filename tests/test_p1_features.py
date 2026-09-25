"""New (T014: DESIGN.md §3 P1 features promoted to v1): engine, server and
demo integration of the activity timeline, blocked-on-you stats, stall
detection, usage history / burn rate, and reveal / open-in."""
import json
import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import Harness
import fake_providers as fp

from omniwatch import engine as engine_mod
from omniwatch import heuristics as H
from omniwatch import persist, providers, stats as stats_mod, views
from omniwatch.engine import ApiError


class P1TestCase(TripwireTestCase):
    def harness(self, **kw):
        return Harness(self.tmp_config_dir, **kw)

    def assertApiError(self, status, code, fn, *args):
        with self.assertRaises(ApiError) as cm:
            fn(*args)
        self.assertEqual((cm.exception.status, cm.exception.code), (status, code))


class TestTimeline(P1TestCase):
    def test_first_observation_and_transitions_recorded(self):
        h = self.harness()
        h.poll()
        t0 = h.p.clock.time()
        self.assertEqual(h.engine.activity.entries(fp.UID_BUSY), [(t0, 'busy')])
        h.p.clock.advance(60)
        h.set_text(fp.UID_BUSY, fp.CLAUDE_WAITING, processing=False)
        h.poll(times=2)
        self.assertEqual(h.engine.activity.entries(fp.UID_BUSY),
                         [(t0, 'busy'), (t0 + 60, 'waiting')])
        hist = h.engine.history(fp.UID_BUSY)
        self.assertEqual([s['state'] for s in hist['segments']], ['busy', 'waiting'])
        self.assertEqual(hist['totals'], {'busy': 60.0, 'waiting': 0.0})
        self.assertEqual(h.engine.history(fp.UID_BUSY, 0.5)['hours'], 0.5)
        self.assertApiError(404, 'not_found', h.engine.history, 'nope')
        ribbon = h.session(fp.UID_BUSY)['ribbon']
        self.assertEqual(len(ribbon['codes']), 48)
        self.assertEqual(ribbon['bucket_s'], 600)
        self.assertTrue(ribbon['codes'].endswith('w') or ribbon['codes'].endswith('b'))

    def test_vanished_and_not_running_forget(self):
        h = self.harness()
        h.poll()
        del h.p.iterm.sessions[0]            # the waiting Claude goes away
        h.poll()
        self.assertFalse(h.engine.activity.has(fp.UID_WAIT))
        v = h.engine.stats_view()
        self.assertEqual((v['answered'], [a['uid'] for a in v['active']]), (0, [fp.UID_CODEX]))
        h.p.iterm.mode = 'not_running'
        h.poll()
        self.assertEqual(h.engine.activity.uids(), [])
        self.assertEqual(h.engine.stats_view()['active'], [])


class TestStats(P1TestCase):
    def test_waits_started_answered_and_published(self):
        h = self.harness()
        h.poll()
        v = h.engine.state()['stats']
        self.assertEqual((v['waits'], v['answered']), (2, 0))
        self.assertEqual(sorted(a['uid'] for a in v['active']), [fp.UID_WAIT, fp.UID_CODEX])
        h.events()
        h.p.clock.advance(90)
        h.set_text(fp.UID_WAIT, fp.CLAUDE_BUSY, processing=True)
        h.poll(times=2)
        ev = h.named('stats')
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]['stats']['answered'], 1)
        self.assertEqual(ev[0]['stats']['waiting_seconds'], 90)
        self.assertEqual(ev[0]['stats']['longest_wait_s'], 90)
        self.assertIn('seq', ev[0])
        self.assertEqual(h.engine.summary()['stats']['answered'], 1)

    def test_persisted_across_restart(self):
        h = self.harness(config_dir=self.tmp_config_dir)
        h.poll()
        h.p.clock.advance(30)
        h.set_text(fp.UID_WAIT, fp.CLAUDE_BUSY, processing=True)
        h.poll(times=2)
        h.engine.stop()
        with open(os.path.join(self.tmp_config_dir, 'stats.json')) as f:
            self.assertEqual(json.load(f)['answered'], 1)
        again = self.harness(config_dir=self.tmp_config_dir,
                             providers=fp.default_world(clock=h.p.clock))
        self.assertEqual(again.engine.state()['stats']['answered'], 1)

    def test_rollover_in_housekeeping(self):
        h = self.harness()
        h.poll()
        h.p.clock.t = stats_mod.day_start(h.p.clock.t) + 86400 + 5
        h.engine.pump()
        v = h.engine.state()['stats']
        self.assertEqual((v['day'], v['waits']), (stats_mod.day_of(h.p.clock.t), 0))


class TestStall(P1TestCase):
    def test_stall_flag_event_and_pref(self):
        h = self.harness()
        h.poll()
        self.assertFalse(h.session(fp.UID_BUSY)['stalled'])
        t0 = h.session(fp.UID_BUSY)['last_change']
        h.events()
        h.p.clock.advance(600)
        h.poll()
        s = h.session(fp.UID_BUSY)
        self.assertEqual((s['stalled'], s['stalled_since']), (True, t0))
        self.assertEqual(h.engine.state()['summary']['stalled'], 1)
        stall = h.named('stall')
        self.assertEqual(stall, [{'uid': fp.UID_BUSY, 'title': '~/src/billing', 'agent': 'claude',
                                  'since': t0, 'minutes': 10, 'muted': False}])
        h.poll()
        self.assertEqual(h.named('stall'), [])        # once per episode
        h.engine.patch_prefs({'stall_minutes': 0})
        self.assertFalse(h.session(fp.UID_BUSY)['stalled'])
        h.engine.patch_prefs({'stall_minutes': 15})
        self.assertFalse(h.session(fp.UID_BUSY)['stalled'])
        for bad in (-1, 241, True, 5.5, '10'):
            self.assertApiError(422, 'invalid', h.engine.patch_prefs, {'stall_minutes': bad})

    def test_stall_event_sent_regardless_of_notifications_stall_pref(self):
        """The backend has no toast/notification path of its own for
        stalls, so `notifications.stall == False` doesn't change the
        `stall` SSE event; clients suppress their own banner/toast for it
        (docs/SHELL_CONTRACT.md §5)."""
        h = self.harness()
        h.engine.patch_prefs({'notifications': {'stall': False}})
        h.poll()
        t0 = h.session(fp.UID_BUSY)['last_change']
        h.events()
        h.p.clock.advance(600)
        h.poll()
        stall = h.named('stall')
        self.assertEqual(stall, [{'uid': fp.UID_BUSY, 'title': '~/src/billing', 'agent': 'claude',
                                  'since': t0, 'minutes': 10, 'muted': False}])

    def test_screen_change_clears_stall(self):
        h = self.harness()
        h.poll()
        h.p.clock.advance(700)
        h.poll()
        self.assertTrue(h.session(fp.UID_BUSY)['stalled'])
        h.set_text(fp.UID_BUSY, fp.CLAUDE_BUSY + '\nmore output')
        h.poll()
        self.assertFalse(h.session(fp.UID_BUSY)['stalled'])

    def test_is_stalled(self):
        self.assertTrue(views.is_stalled(H.BUSY, 0, 600, 600))
        self.assertFalse(views.is_stalled(H.BUSY, 0, 599, 600))
        self.assertFalse(views.is_stalled(H.IDLE, 0, 9999, 600))
        self.assertFalse(views.is_stalled(H.BUSY, 0, 9999, 0))


class TestUsageHistory(P1TestCase):
    def test_recorded_and_burn_in_blocks(self):
        h = self.harness(config_dir=self.tmp_config_dir)
        h.poll()
        path = os.path.join(self.tmp_config_dir, 'usage-history.jsonl')
        with open(path) as f:
            self.assertEqual(sorted(json.loads(l)['p'] for l in f), ['claude', 'codex'])
        limits = h.engine.state()['usage']['claude']['limits']
        self.assertTrue(all('burn' in l for l in limits))
        self.assertIsNone(limits[0]['burn'])          # a single point: no rate yet
        for i in range(3):
            h.p.clock.advance(600)
            h.p.usage_claude.data = dict(fp.CLAUDE_USAGE, five_hour={
                'utilization': 64.0 + 2 * i, 'resets_at': '2026-09-21T20:00:00+00:00'})
            h.engine.refresh()
            h.poll()
        burn = h.engine.state()['usage']['claude']['limits'][0]['burn']
        self.assertEqual(burn['rate_per_hour'], 12.0)
        view = h.engine.usage_history_view(24)
        self.assertEqual(len(view['limits']['claude.five_hour']['points']), 4)
        self.assertEqual(view['limits']['claude.five_hour']['burn'], burn)

    def test_failed_snapshot_not_recorded(self):
        h = self.harness()
        h.p.usage_claude.data = None
        h.poll()
        self.assertNotIn('claude.five_hour', h.engine.usage_history.limit_ids())


class TestReveal(P1TestCase):
    def test_targets_sync(self):
        h = self.harness(sync=True)
        h.poll()
        e = h.engine
        with mock.patch.dict(os.environ, {'VISUAL': '', 'EDITOR': 'vim'}):
            for target in ('finder', 'editor', 'copy_path'):
                self.assertTrue(e.reveal(fp.UID_WAIT, {'target': target})['ok'])
        e.pump()
        self.assertEqual(h.p.opener.calls, [
            ('reveal', '/Users/me/src/api'),
            ('open_editor', ['code', '/Users/me/src/api']),    # vim skipped
            ('copy_text', '/Users/me/src/api')])
        details = [(a['kind'], a['ok'], a['detail']) for a in h.named('action')]
        self.assertEqual(details, [('reveal', True, 'revealed ~/src/api in Finder'),
                                   ('reveal', True, 'opened ~/src/api in code'),
                                   ('reveal', True, 'copied ~/src/api')])

    def test_client_supplied_path_is_ignored(self):
        h = self.harness(sync=True)
        h.poll()
        h.engine.reveal(fp.UID_WAIT, {'target': 'copy_path', 'path': '/etc/passwd'})
        self.assertEqual(h.p.opener.calls, [('copy_text', '/Users/me/src/api')])

    def test_errors(self):
        h = self.harness(sync=True)
        h.poll()
        e = h.engine
        self.assertApiError(400, 'bad_request', e.reveal, fp.UID_WAIT, {})
        self.assertApiError(422, 'invalid', e.reveal, fp.UID_WAIT, {'target': 'terminal'})
        self.assertApiError(404, 'not_found', e.reveal, 'nope', {'target': 'finder'})
        h.p.agents.cwds = {}
        h.poll()
        self.assertApiError(422, 'invalid', e.reveal, fp.UID_SHELL, {'target': 'finder'})

    def test_failures_become_action_errors_threaded(self):
        h = self.harness()
        h.poll()

        def missing(argv, path):
            raise FileNotFoundError(2, 'No such file', argv[0])

        def broken(path):
            raise RuntimeError('open -R failed')
        h.p.opener.open_editor = missing
        h.p.opener.reveal = broken
        h.engine.patch_prefs({'editor': 'subl -n'})
        for target in ('editor', 'finder'):
            h.engine.reveal(fp.UID_WAIT, {'target': target})
            h.engine.events.put(h.engine.events.get(timeout=5))
        h.engine.pump()
        details = [(a['ok'], a['detail']) for a in h.named('action')]
        self.assertEqual(sorted(details), [(False, 'not found: subl'),
                                           (False, 'open -R failed')])

    def test_resolve_editor(self):
        r = engine_mod.resolve_editor
        self.assertEqual(r('zed', {'VISUAL': 'code'}), ['zed'])
        self.assertEqual(r('', {'VISUAL': 'code -w', 'EDITOR': 'vim'}), ['code', '-w'])
        self.assertEqual(r('', {'VISUAL': 'nvim', 'EDITOR': 'open -a "Sublime Text"'}),
                         ['open', '-a', 'Sublime Text'])
        self.assertEqual(r('vi', {'EDITOR': '"unterminated'}), ['code'])
        self.assertEqual(r('   ', {}), ['code'])

    def test_editor_pref_validation(self):
        h = self.harness()
        self.assertEqual(h.engine.patch_prefs({'editor': 'code -w'})['editor'], 'code -w')
        for bad in (3, 'x' * 201, 'code\n', '"open'):
            self.assertApiError(422, 'invalid', h.engine.patch_prefs, {'editor': bad})


class TestRealOpener(P1TestCase):
    def test_commands_are_argv(self):
        calls = []

        class R:
            def __init__(self, rc):
                self.returncode, self.stderr = rc, 'boom'

        def fake_run(argv, **kw):
            calls.append(('run', argv, kw.get('input')))
            return R(0)
        o = providers.RealOpener()
        with mock.patch('subprocess.run', fake_run), \
                mock.patch('subprocess.Popen', lambda argv, **kw: calls.append(('popen', argv))):
            o.reveal('/p q')
            o.copy_text('/p q')
            o.open_editor(['code', '-w'], '/p q')
        self.assertEqual(calls, [('run', ['open', '-R', '/p q'], None),
                                 ('run', ['pbcopy'], '/p q'),
                                 ('popen', ['code', '-w', '/p q'])])
        with mock.patch('subprocess.run', lambda argv, **kw: R(1)):
            with self.assertRaises(RuntimeError):
                o.reveal('/x')
            with self.assertRaises(RuntimeError):
                o.copy_text('/x')


class TestPrefsAndTracker(P1TestCase):
    def test_new_pref_defaults(self):
        self.assertEqual(persist.DEFAULTS['stall_minutes'], 10)
        self.assertEqual(persist.DEFAULTS['editor'], '')
        self.assertIn('stall_minutes', persist.PREF_KEYS)

    def test_tracker_seed_only_moves_earlier(self):
        tr = H.SessionTracker()
        self.assertFalse(tr.seed('u', state_since=1))
        tr.update([fp.session('u', 't', 'x')], {}, 100.0)
        self.assertTrue(tr.seed('u', state_since=50, last_change=40))
        tr.seed('u', state_since=90, last_change=90)
        self.assertEqual((tr.state('u')[1], tr.last_change('u')), (50, 40))


class TestDemoSeed(P1TestCase):
    """The real demo package (WP3) drives all five features."""

    def demo_engine(self, scenario='default'):
        from omniwatch.demo import SCENARIOS, make_demo_providers
        p = make_demo_providers(scenario, frozen_clock=1_790_000_000.0)
        h = Harness(self.tmp_config_dir, providers=p, sync=True, demo=True,
                    demo_factory=make_demo_providers,
                    demo_options={'scenarios': SCENARIOS,
                                  'factory_kwargs': {'frozen_clock': 1_790_000_000.0}})
        engine_mod.apply_seed_state(h.store, p.demo)
        h.engine.sync_poll()
        h.engine.apply_demo_seed()
        h.engine.pump()
        return h

    def test_default_scenario_showcase(self):
        h = self.demo_engine()
        doc = h.engine.state()
        self.assertEqual(h.session('DEMO-0001')['label'], 'deploy-fix')
        self.assertEqual(doc['projects'][0]['name'], 'api-gateway')
        stalled = [s['uid'] for s in doc['sessions'] if s['stalled']]
        self.assertEqual(stalled, ['DEMO-0003'])
        st = doc['stats']
        self.assertEqual((st['waiting_seconds'], st['longest_wait_s'], st['answered'], st['waits']),
                         (83 * 60, 13 * 60, 14, 16))
        self.assertEqual([a['uid'] for a in st['active']], ['DEMO-0001', 'DEMO-0007'])
        self.assertEqual(h.session('DEMO-0006')['state_since'], 1_790_000_000.0 - 22 * 60)
        codes = h.session('DEMO-0001')['ribbon']['codes']
        self.assertEqual(len(codes), 48)
        self.assertGreaterEqual(len(set(codes)), 3)
        hist = h.engine.history('DEMO-0001')
        self.assertEqual(hist['transitions'], 14)
        burns = [l['burn'] for l in doc['usage']['claude']['limits']]
        self.assertTrue(all(b and b['text'].startswith('at this rate') for b in burns))
        view = h.engine.usage_history_view(24)
        self.assertEqual(len(view['limits']['claude.five_hour']['points']), 97)

    def test_screen_states_match_classifier(self):
        from omniwatch.demo import history
        from omniwatch.demo.screens import SCREENS
        for key, expected in history.SCREEN_STATES.items():
            text = SCREENS[key]
            if expected in ('waiting', 'busy', 'idle'):
                kind = 'codex' if key.startswith('codex') else 'claude'
                got = H.classify_agent(kind, text, expected == 'busy')[0]
            else:
                got = expected
            self.assertEqual(got, expected, key)
        self.assertEqual(set(history.SCREEN_STATES), set(SCREENS))

    def test_other_scenarios_seed_deterministically(self):
        from omniwatch.demo import make_demo_providers
        a = make_demo_providers('many', seed=3, frozen_clock=1_790_000_000.0)
        b = make_demo_providers('many', seed=3, frozen_clock=1_790_000_000.0)
        self.assertEqual(a.demo.seed_history(), b.demo.seed_history())
        self.assertEqual(a.demo.seed_usage_history(), b.demo.seed_usage_history())
        self.assertEqual(list(a.demo.seed_last_change()), ['DEMO-MANY-004'])
        for scenario in ('empty', 'usage-errors'):
            p = make_demo_providers(scenario, frozen_clock=1_790_000_000.0)
            self.assertEqual(p.demo.seed_usage_history(), [])
        h = self.demo_engine('many')
        self.assertTrue(h.session('DEMO-MANY-004')['stalled'])
        self.assertGreater(h.engine.state()['stats']['waits'], 0)

    def test_scenario_reset_reseeds(self):
        h = self.demo_engine()
        h.engine.demo_scenario({'name': 'empty'})
        self.assertEqual(h.engine.state()['stats']['waits'], 0)
        self.assertEqual(h.engine.usage_history_view(24)['limits'], {})
        h.engine.demo_scenario({'name': 'default'})
        self.assertEqual(h.engine.state()['stats']['answered'], 14)

    def test_demo_opener_records_reveal(self):
        h = self.demo_engine()
        h.engine.reveal('DEMO-0001', {'target': 'copy_path'})
        h.engine.reveal('DEMO-0001', {'target': 'finder'})
        h.engine.patch_prefs({'editor': 'zed'})
        h.engine.reveal('DEMO-0001', {'target': 'editor'})
        self.assertEqual(h.p.iterm._world.opened[-3:], [
            ('copy_text', '~/src/api-gateway'), ('reveal', '~/src/api-gateway'),
            ('open_editor', ['zed', '~/src/api-gateway'])])

    def test_seed_without_hooks_is_noop(self):
        h = self.harness(sync=True)
        h.poll()
        h.engine.apply_demo_seed()      # FakeProviders has no .demo
        p = fp.make_providers()
        h2 = self.harness(providers=p, sync=True)
        h2.poll()
        h2.engine.apply_demo_seed()     # FakeDemo has no seed_* hooks
        self.assertEqual(h2.engine.state()['stats']['answered'], 0)


if __name__ == '__main__':
    unittest.main()
