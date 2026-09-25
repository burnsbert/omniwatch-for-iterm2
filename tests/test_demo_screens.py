"""New (docs/DESIGN.md §4.1/§5, WP3): every demo screen classifies
correctly under the REAL omniwatch.heuristics rules — demo mode never
gets a classifier shortcut."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import heuristics as H
from omniwatch.demo.screens import SCREENS


class TestDemoScreensClassifyCorrectly(TripwireTestCase):
    def test_all_screens_loaded(self):
        expected = {
            'claude_waiting_bash', 'claude_waiting_billing',
            'claude_busy_spinner', 'claude_busy_build', 'claude_idle',
            'codex_approval', 'codex_working', 'tail_log', 'quiet_shell',
            'plain_idle', 'vite_dev_server',
        }
        self.assertEqual(set(SCREENS), expected)
        for name, text in SCREENS.items():
            self.assertTrue(text.strip(), f'{name} is empty')

    def test_claude_waiting_screens_are_waiting(self):
        for name in ('claude_waiting_bash', 'claude_waiting_billing'):
            state, _ = H.classify_agent('claude', SCREENS[name], False)
            self.assertEqual(state, H.WAITING, name)

    def test_claude_busy_spinner_is_busy(self):
        state, _ = H.classify_agent('claude', SCREENS['claude_busy_spinner'], True)
        self.assertEqual(state, H.BUSY)

    def test_claude_idle_is_idle(self):
        state, _ = H.classify_agent('claude', SCREENS['claude_idle'], False)
        self.assertEqual(state, H.IDLE)

    def test_codex_approval_is_waiting(self):
        state, _ = H.classify_agent('codex', SCREENS['codex_approval'], False)
        self.assertEqual(state, H.WAITING)

    def test_codex_working_is_busy(self):
        state, _ = H.classify_agent('codex', SCREENS['codex_working'], True)
        self.assertEqual(state, H.BUSY)

    def test_extract_prompt_works_on_demo_waiting_screens(self):
        prompt = H.extract_prompt('claude', SCREENS['claude_waiting_bash'])
        self.assertIsNotNone(prompt)
        self.assertEqual(prompt['question'], 'Do you want to proceed?')
        self.assertTrue(prompt['options'][0]['selected'])

        prompt = H.extract_prompt('codex', SCREENS['codex_approval'])
        self.assertIsNotNone(prompt)
        self.assertEqual([o['key'] for o in prompt['options']], ['y', 'esc'])

    def test_no_demo_screen_is_a_dashboard(self):
        # Demo screens become README screenshots: no terminal-dashboard
        # banner (P-50) and no legacy product name anywhere.
        from omniwatch import views
        for name, text in SCREENS.items():
            self.assertFalse(views.is_dashboard(text), name)
            self.assertNotIn('ultrawatch', text.lower(), name)

    def test_no_scenario_shows_the_legacy_product(self):
        from omniwatch import views
        from omniwatch.demo import SCENARIOS, make_demo_providers
        for scenario in SCENARIOS:
            p = make_demo_providers(scenario=scenario, seed=0, frozen_clock=1_790_000_000)
            try:
                sessions = p.iterm.snapshot(at=0).sessions
                paths = dict(p.iterm.paths(at=0).paths)
            except Exception:   # not-running / not-authorized scenarios
                continue
            for s in sessions:
                self.assertFalse(views.is_dashboard(s.text), (scenario, s.uid))
                for value in (s.text, s.name, paths.get(s.uid, '')):
                    self.assertNotIn('ultrawatch', value.lower(), (scenario, s.uid))

    def test_non_agent_screens_have_no_agent_markers(self):
        # quiet_shell/tail_log/plain_idle must not accidentally look like
        # an agent prompt if ever misclassified with an agent kind.
        for name in ('quiet_shell', 'tail_log', 'plain_idle', 'vite_dev_server'):
            state, rule = H.classify_agent('claude', SCREENS[name], False)
            self.assertNotEqual(state, H.WAITING, f'{name} looks like a prompt')


if __name__ == '__main__':
    unittest.main()
