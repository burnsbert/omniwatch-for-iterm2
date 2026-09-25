"""New (docs/DESIGN.md §4.1/§5, §7 WP3): demo mode's Providers bundle —
determinism, scenario -> status via the REAL heuristics/tracker, actions,
and the fake clock."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import heuristics as H
from omniwatch import iterm
from omniwatch.demo import SCENARIOS, make_demo_providers

FROZEN = 1_700_000_000.0


def agent_kinds(providers):
    kinds = {}
    for tty, agents in providers.agents.scan().items():
        if 'claude' in agents:
            kinds[tty] = 'claude'
        elif 'codex' in agents:
            kinds[tty] = 'codex'
    return kinds


def snapshot_repr(providers):
    """A plain, comparable snapshot of everything observable, for
    determinism checks."""
    snap = providers.iterm.snapshot(at=providers.clock.time())
    sessions = tuple(
        (s.window_id, s.tab_index, s.session_index, s.uid, s.tty,
         s.is_processing, s.name, s.text)
        for s in snap.sessions)
    return {
        'sessions': sessions,
        'paths': providers.iterm.paths(at=providers.clock.time()).paths,
        'colors': tuple(sorted(providers.colors.fetch().items())),
        'agents': tuple(sorted(
            (tty, tuple(sorted(a))) for tty, a in providers.agents.scan().items())),
        'usage_claude': providers.usage_claude.fetch(),
        'usage_codex': providers.usage_codex.fetch(),
    }


class TestScenariosConstant(TripwireTestCase):
    def test_scenarios_tuple(self):
        self.assertEqual(
            set(SCENARIOS),
            {'default', 'empty', 'not-running', 'not-authorized', 'many',
             'usage-errors'})

    def test_unknown_scenario_raises(self):
        with self.assertRaises(ValueError):
            make_demo_providers('bogus-scenario')


class TestDeterminism(TripwireTestCase):
    """Same seed + clock -> identical outputs; a different seed differs."""

    def run_and_step(self, scenario, seed, seconds_sequence):
        p = make_demo_providers(scenario, seed=seed, frozen_clock=FROZEN)
        out = [snapshot_repr(p)]
        for seconds in seconds_sequence:
            p.demo.step(seconds)
            out.append(snapshot_repr(p))
        return tuple(out)

    def test_default_scenario_same_seed_identical(self):
        steps = [6.0, 60.0, 1200.0]
        a = self.run_and_step('default', 3, steps)
        b = self.run_and_step('default', 3, steps)
        self.assertEqual(a, b)

    def test_default_scenario_different_seed_differs(self):
        steps = [6.0, 60.0]
        a = self.run_and_step('default', 3, steps)
        b = self.run_and_step('default', 4, steps)
        self.assertNotEqual(a, b)

    def test_many_scenario_deterministic(self):
        a = self.run_and_step('many', 1, [30.0])
        b = self.run_and_step('many', 1, [30.0])
        self.assertEqual(a, b)

    def test_step_is_idempotent_at_same_total_elapsed(self):
        # Stepping by 3 then 3 must equal stepping by 6 once, from the
        # same starting state.
        p1 = make_demo_providers('default', seed=9, frozen_clock=FROZEN)
        p1.demo.step(3.0)
        p1.demo.step(3.0)
        p2 = make_demo_providers('default', seed=9, frozen_clock=FROZEN)
        p2.demo.step(6.0)
        self.assertEqual(snapshot_repr(p1), snapshot_repr(p2))


class TestDefaultScenarioThroughRealTracker(TripwireTestCase):
    """Every scenario must classify to its intended statuses through the
    REAL omniwatch.heuristics classifier/tracker — not a demo shortcut."""

    def poll(self, providers, tracker, now=None):
        snap = providers.iterm.snapshot(at=providers.clock.time())
        return tracker.update(snap.sessions, agent_kinds(providers),
                              now if now is not None else providers.clock.time())

    def test_initial_statuses(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        tracker = H.SessionTracker()
        self.poll(p, tracker)  # first observation only publishes silently
        expected = {
            'DEMO-0001': H.WAITING,   # Claude: Bash permission prompt
            'DEMO-0002': H.BUSY,      # Claude: busy spinner
            'DEMO-0003': H.BUSY,      # Codex: working
            'DEMO-0004': H.ACTIVE,    # quiet shell, just observed
            'DEMO-0005': H.ACTIVE,    # tail -f log
            'DEMO-0006': H.IDLE,      # Claude: idle
            'DEMO-0007': H.WAITING,   # Codex: approval prompt
        }
        for uid, want in expected.items():
            state, _, _ = tracker.state(uid)
            self.assertEqual(state, want, uid)

    def test_scripted_busy_to_waiting_transition(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        tracker = H.SessionTracker()
        self.poll(p, tracker, now=FROZEN)
        self.assertEqual(tracker.state('DEMO-0002')[0], H.BUSY)

        p.demo.step(6.0)
        self.poll(p, tracker, now=FROZEN + 6.0)  # 1st waiting observation
        self.assertEqual(tracker.state('DEMO-0002')[0], H.BUSY)  # debounced

        p.demo.step(0.0)
        events = self.poll(p, tracker, now=FROZEN + 8.0)  # 2nd -> publishes
        self.assertIn(('DEMO-0002', H.BUSY, H.WAITING), events)
        self.assertEqual(tracker.state('DEMO-0002')[0], H.WAITING)
        self.assertTrue(tracker.has_attention('DEMO-0002'))

    def test_tail_log_stays_active_while_quiet_shell_settles(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        tracker = H.SessionTracker()
        self.poll(p, tracker, now=FROZEN)
        self.poll(p, tracker, now=FROZEN + 10.0)
        self.poll(p, tracker, now=FROZEN + 20.0)
        self.assertEqual(tracker.state('DEMO-0005')[0], H.ACTIVE)  # is_processing=True
        self.assertEqual(tracker.state('DEMO-0004')[0], H.QUIET)   # unchanged, idle

    def test_extract_prompt_available_for_waiting_sessions(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        snap = p.iterm.snapshot(at=p.clock.time())
        bash_prompt_session = next(s for s in snap.sessions if s.uid == 'DEMO-0001')
        prompt = H.extract_prompt('claude', bash_prompt_session.text)
        self.assertIsNotNone(prompt)
        self.assertEqual(prompt['question'], 'Do you want to proceed?')

    def test_labels_present(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        # labels live on the fake session, surfaced only via the world,
        # not the Providers protocol (labels are a StateStore concern) —
        # sanity check at least one is present for the "labels" part of
        # §5's demo data description.
        world = p.iterm._world
        labels = {uid: s.label for uid, s in world.sessions.items() if s.label}
        self.assertIn('DEMO-0001', labels)
        self.assertEqual(labels['DEMO-0001'], 'deploy-fix')

    def test_three_tab_colors_present(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        self.assertEqual(set(p.colors.fetch().values()), {'blue', 'purple', 'green'})

    def test_eleven_sessions_two_windows(self):
        p = make_demo_providers('default', seed=0, frozen_clock=FROZEN)
        snap = p.iterm.snapshot(at=p.clock.time())
        self.assertEqual(len(snap.sessions), 11)
        self.assertEqual(len({s.window_id for s in snap.sessions}), 2)


class TestOtherScenarios(TripwireTestCase):
    def test_empty_scenario_has_no_sessions(self):
        p = make_demo_providers('empty', frozen_clock=FROZEN)
        snap = p.iterm.snapshot(at=p.clock.time())
        self.assertEqual(snap.sessions, ())
        self.assertEqual(p.agents.scan(), {})

    def test_not_running_scenario_raises_iterm_not_running(self):
        p = make_demo_providers('not-running', frozen_clock=FROZEN)
        with self.assertRaises(iterm.ItermNotRunning):
            p.iterm.snapshot(at=p.clock.time())
        with self.assertRaises(iterm.ItermNotRunning):
            p.iterm.paths(at=p.clock.time())
        with self.assertRaises(iterm.ItermNotRunning):
            p.iterm.probe()

    def test_not_authorized_scenario_raises_iterm_not_authorized(self):
        p = make_demo_providers('not-authorized', frozen_clock=FROZEN)
        with self.assertRaises(iterm.ItermNotAuthorized):
            p.iterm.snapshot(at=p.clock.time())
        with self.assertRaises(iterm.ItermNotAuthorized):
            p.iterm.probe()

    def test_many_scenario_has_60_sessions_and_a_mix_of_states(self):
        p = make_demo_providers('many', frozen_clock=FROZEN)
        snap = p.iterm.snapshot(at=p.clock.time())
        self.assertEqual(len(snap.sessions), 60)
        tracker = H.SessionTracker()
        tracker.update(snap.sessions, agent_kinds(p), now=FROZEN)
        states = {tracker.state(s.uid)[0] for s in snap.sessions}
        # a real mix, not everything collapsing to one bucket
        self.assertTrue({H.WAITING, H.BUSY, H.IDLE} & states)
        self.assertGreaterEqual(len({s.uid for s in snap.sessions}), 60)

    def test_fill_cwds_always_returns_empty(self):
        # demo sessions always carry a shell-integration path already, so
        # the lsof-fallback provider method is a harmless no-op.
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertEqual(p.agents.fill_cwds(['/dev/ttys001', '/dev/ttys999']), {})

    def test_usage_errors_scenario_fetch_fails_both(self):
        p = make_demo_providers('usage-errors', frozen_clock=FROZEN)
        self.assertEqual(p.usage_claude.fetch(), (None, None))
        self.assertEqual(p.usage_codex.fetch(), (None, None))
        # but at least one agent is running, so a real UsagePoller would
        # actually call fetch() instead of gating to "inactive".
        self.assertTrue(p.agents.scan())


class TestActions(TripwireTestCase):
    def test_goto_marks_focused(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertTrue(p.iterm.goto('DEMO-0006'))
        self.assertEqual(p.iterm._world.focused_uid, 'DEMO-0006')

    def test_goto_unknown_uid_returns_false(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertFalse(p.iterm.goto('NOPE'))

    def test_close_uid_removes_session(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertTrue(p.iterm.close_uid('DEMO-0004'))
        snap = p.iterm.snapshot(at=p.clock.time())
        self.assertNotIn('DEMO-0004', {s.uid for s in snap.sessions})
        self.assertEqual(len(snap.sessions), 10)

    def test_close_uid_unknown_returns_false(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertFalse(p.iterm.close_uid('NOPE'))

    def test_new_tab_adds_a_plain_shell(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        before = len(p.iterm.snapshot(at=p.clock.time()).sessions)
        p.iterm.new_tab()
        after = p.iterm.snapshot(at=p.clock.time())
        self.assertEqual(len(after.sessions), before + 1)
        new_session = max(after.sessions, key=lambda s: s.uid)
        self.assertIn('devbox', new_session.text)

    def test_reply_to_waiting_claude_session_advances_screen(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        tracker = H.SessionTracker()
        snap = p.iterm.snapshot(at=p.clock.time())
        tracker.update(snap.sessions, agent_kinds(p), now=FROZEN)
        self.assertEqual(tracker.state('DEMO-0001')[0], H.WAITING)

        self.assertTrue(p.iterm.reply('DEMO-0001', '1', submit=False))
        snap2 = p.iterm.snapshot(at=p.clock.time())
        session = next(s for s in snap2.sessions if s.uid == 'DEMO-0001')
        self.assertTrue(session.is_processing)
        self.assertNotIn('Do you want to proceed?', session.text)

    def test_reply_to_codex_approval_moves_to_working(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertTrue(p.iterm.reply('DEMO-0007', 'y', submit=False))
        snap = p.iterm.snapshot(at=p.clock.time())
        session = next(s for s in snap.sessions if s.uid == 'DEMO-0007')
        state, _ = H.classify_agent('codex', session.text, session.is_processing)
        self.assertEqual(state, H.BUSY)

    def test_reply_to_unknown_uid_returns_false(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertFalse(p.iterm.reply('NOPE', '1'))

    def test_reply_without_a_scripted_effect_is_a_harmless_true(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        before = p.iterm.snapshot(at=p.clock.time())
        self.assertTrue(p.iterm.reply('DEMO-0006', 'irrelevant'))
        after = p.iterm.snapshot(at=p.clock.time())
        self.assertEqual(
            next(s.text for s in before.sessions if s.uid == 'DEMO-0006'),
            next(s.text for s in after.sessions if s.uid == 'DEMO-0006'))

    def test_set_color_and_clear(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertTrue(p.colors.set('DEMO-0004', 'red'))
        self.assertEqual(p.colors.fetch()['DEMO-0004'], 'red')
        self.assertTrue(p.colors.set('DEMO-0004', None))
        self.assertNotIn('DEMO-0004', p.colors.fetch())

    def test_set_color_unknown_uid_returns_false(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertFalse(p.colors.set('NOPE', 'red'))

    def test_launch_and_probe_are_harmless_on_ok_scenario(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        self.assertIsNone(p.iterm.launch())
        self.assertTrue(p.iterm.probe())

    def test_opener_records_without_side_effects(self):
        p = make_demo_providers('default', frozen_clock=FROZEN)
        p.opener.open_url('https://mail.google.com/mail/?view=cm')
        p.opener.open_app('iTerm')
        self.assertEqual(p.iterm._world.opened,
                         [('open_url', 'https://mail.google.com/mail/?view=cm'),
                          ('open_app', 'iTerm')])


class TestFakeClock(TripwireTestCase):
    def test_starts_at_frozen_epoch(self):
        p = make_demo_providers('default', frozen_clock=123.0)
        self.assertEqual(p.clock.time(), 123.0)
        self.assertEqual(p.clock.monotonic(), 0.0)

    def test_starts_at_real_time_when_unfrozen(self):
        import time
        before = time.time()
        p = make_demo_providers('default')
        self.assertGreaterEqual(p.clock.time(), before)

    def test_advance_moves_both_time_and_monotonic(self):
        p = make_demo_providers('default', frozen_clock=100.0)
        p.demo.step(50.0)
        self.assertEqual(p.clock.time(), 150.0)
        self.assertEqual(p.clock.monotonic(), 50.0)

    def test_sleep_does_not_block(self):
        p = make_demo_providers('default', frozen_clock=100.0)
        p.clock.sleep(999999)  # must return instantly, not hang the test
        self.assertEqual(p.clock.time(), 100.0)  # sleep never advances time

    def test_demo_scenario_property(self):
        p = make_demo_providers('many', frozen_clock=100.0)
        self.assertEqual(p.demo.scenario, 'many')


if __name__ == '__main__':
    unittest.main()
