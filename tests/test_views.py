"""New (docs/DESIGN.md §4.4.1): pure view serializers."""
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
import fake_providers as fp

from omniwatch import heuristics as H
from omniwatch import usage_claude, views
from omniwatch.snapshot import AgentSnapshot, UsageSnapshot

NOW = 1_790_000_000.0


class TestHelpers(TripwireTestCase):
    def test_screen_hash_is_8_hex_and_ignores_spinners(self):
        h = views.screen_hash('⠋ working\n')
        self.assertRegex(h, r'^[0-9a-f]{8}$')
        self.assertEqual(h, views.screen_hash('⠙ working\n\n'))

    def test_shorten(self):
        self.assertEqual(views.shorten('/Users/me/src', '/Users/me'), '~/src')
        self.assertEqual(views.shorten('/opt/x', '/Users/me'), '/opt/x')
        self.assertEqual(views.shorten('/x', ''), '/x')

    def test_agent_kinds_prefers_claude(self):
        snap = AgentSnapshot(ttys=(('a', frozenset({'claude', 'codex'})),
                                   ('b', frozenset({'codex'})), ('c', frozenset({'other'}))))
        self.assertEqual(views.agent_kinds(snap), {'a': 'claude', 'b': 'codex'})
        self.assertEqual(views.agent_kinds(None), {})
        self.assertEqual(views.agents_for(snap, 'a'), ['claude', 'codex'])
        self.assertEqual(views.agents_for(snap, ''), [])
        self.assertEqual(views.agents_for(None, 'a'), [])

    def test_window_numbers_and_tab_labels(self):
        s1 = fp.session('1', 't1', '', window=300, tab=2)
        s2 = fp.session('2', 't2', '', window=100, tab=1)
        numbers = views.window_numbers([s1, s2, s1])
        self.assertEqual(numbers, {300: 1, 100: 2})
        self.assertEqual(views.windows([s1, s2]), [{'id': 300, 'number': 1},
                                                   {'id': 100, 'number': 2}])
        self.assertEqual(views.tab_label(s2, numbers), '2.1')
        self.assertEqual(views.tab_label(s2, {100: 1}), '1')

    def test_session_path_fallbacks(self):
        s = fp.session('U', '/dev/ttys1', '')
        snap = AgentSnapshot(tty_cwd=(('/dev/ttys0', '/a'), ('/dev/ttys1', '/b')))
        self.assertEqual(views.session_path(s, {'U': '/p'}, snap), '/p')
        self.assertEqual(views.session_path(s, {}, snap), '/b')
        self.assertEqual(views.session_path(s, {}, AgentSnapshot()), '')
        self.assertEqual(views.session_path(s, {}, None), '')

    def test_row_title(self):
        self.assertEqual(views.row_title('lbl', '~/p', 'n', 'uid-123456789'), 'lbl')
        self.assertEqual(views.row_title('', '~/p', 'n', 'uid-123456789'), '~/p')
        self.assertEqual(views.row_title('', '', 'n', 'uid-123456789'), 'n')
        self.assertEqual(views.row_title('', '', '', 'uid-123456789'), 'uid-1234')

    def test_fresh_until(self):
        started = NOW
        self.assertIsNone(views.fresh_until(H.BUSY, NOW + 10, started, NOW + 11, 30))
        self.assertIsNone(views.fresh_until(H.WAITING, NOW + 10, started, NOW + 11, 30))
        self.assertIsNone(views.fresh_until(H.IDLE, NOW + 5, started, NOW + 6, 30))
        self.assertEqual(views.fresh_until(H.IDLE, NOW + 10, started, NOW + 11, 30), NOW + 40)
        self.assertIsNone(views.fresh_until(H.QUIET, NOW + 10, started, NOW + 40, 30))

    def test_project_slot(self):
        self.assertEqual([views.project_slot(c) for c in views.PROJECT_COLORS], [1, 2, 3, 4, 5])
        self.assertIsNone(views.project_slot('orange'))
        self.assertIsNone(views.project_slot(None))

    def test_is_dashboard_first_line_only(self):
        self.assertTrue(views.is_dashboard('▛▞ ULTRAWATCH v1\n'))
        self.assertFalse(views.is_dashboard('x\n▛▞ ULTRAWATCH'))

    def test_capabilities(self):
        self.assertEqual(views.capabilities(None, 1, 0),
                         {'tab_colors': None, 'reply': True, 'debug_rule': False})


class TestSummary(TripwireTestCase):
    def test_summary_and_endpoint(self):
        sv = [{'uid': 'a', 'agent': 'claude', 'state': 'waiting', 'title': 'A', 'state_since': 5},
              {'uid': 'b', 'agent': None, 'state': 'busy', 'title': 'B', 'state_since': 1},
              {'uid': 'c', 'agent': 'codex', 'state': 'waiting', 'title': 'C', 'state_since': 2}]
        summ = views.summary(sv, ['c', 'gone', 'a'])
        self.assertEqual(summ, {'tabs': 3, 'agents': 2, 'waiting': 2, 'busy': 1,
                                'waiting_uids': ['c', 'a']})
        ep = views.summary_endpoint(sv, summ)
        self.assertEqual(ep['waiting_sessions'],
                         [{'uid': 'c', 'title': 'C', 'since': 2, 'agent': 'codex'},
                          {'uid': 'a', 'title': 'A', 'since': 5, 'agent': 'claude'}])
        self.assertNotIn('waiting_uids', ep)


class TestUsageBlock(TripwireTestCase):
    def test_inactive(self):
        for snap in (None, UsageSnapshot(inactive=True, at=1.0)):
            b = views.usage_block('claude', snap, False, NOW)
            self.assertEqual(b, {'status': 'inactive', 'fetched_at': None,
                                 'stale_since': None, 'limits': []})

    def test_ok(self):
        b = views.usage_block('claude', UsageSnapshot(data=fp.CLAUDE_USAGE, at=NOW), False, NOW)
        self.assertEqual(b['status'], 'ok')
        self.assertEqual(b['fetched_at'], NOW)
        monthly = b['limits'][-1]
        self.assertEqual(monthly['id'], 'claude.monthly')
        self.assertIsNone(monthly['limit_display'])
        self.assertTrue(monthly['reset_text'])       # regression: was '' with `now`
        self.assertEqual(monthly['projection']['kind'], 'pace')
        b = views.usage_block('claude', UsageSnapshot(data=fp.CLAUDE_USAGE, at=NOW), True, NOW)
        self.assertEqual(b['limits'][-1]['limit_display'], '$200')

    def test_codex(self):
        b = views.usage_block('codex', UsageSnapshot(data=fp.CODEX_USAGE, at=NOW), False, NOW)
        self.assertEqual([l['window'] for l in b['limits']], ['5h', '7d'])

    def test_stale_error_no_credentials(self):
        stale = views.usage_block('claude', UsageSnapshot(data=fp.CLAUDE_USAGE, ok=False, at=NOW),
                                  False, NOW, stale_since=NOW - 60)
        self.assertEqual((stale['status'], stale['stale_since']), ('stale', NOW - 60))
        self.assertTrue(stale['limits'])
        failed = UsageSnapshot(data=None, ok=False, at=NOW)
        self.assertEqual(views.usage_block('claude', failed, False, NOW)['status'], 'error')
        self.assertEqual(views.usage_block('claude', failed, False, NOW,
                                           has_credentials=True)['status'], 'error')
        self.assertEqual(views.usage_block('claude', failed, False, NOW,
                                           has_credentials=False)['status'], 'no_credentials')

    def test_monthly_reset_text_with_aware_now(self):
        rows = usage_claude.limits(fp.CLAUDE_USAGE,
                                   now=datetime.fromtimestamp(NOW, timezone.utc))
        self.assertRegex(rows[-1]['reset_text'], r'^\d+d \d+h \(')


if __name__ == '__main__':
    unittest.main()
