"""New coverage for the ported (verbatim) snapshot.py dataclasses —
Ultrawatch never had a dedicated test file for these; they were only
exercised indirectly through iterm.py/agents.py/pollers.py tests."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch.snapshot import (AgentSnapshot, ColorsSnapshot, ErrorSnapshot,
                                ItermSnapshot, PathsSnapshot, SessionInfo,
                                UsageSnapshot)


class TestSessionInfo(TripwireTestCase):
    def test_is_frozen(self):
        s = SessionInfo(window_id=1, tab_index=1, session_index=1, uid='U',
                        tty='/dev/ttys000', is_processing=False, name='x',
                        text='hi')
        with self.assertRaises(Exception):
            s.uid = 'other'


class TestItermSnapshotDefaults(TripwireTestCase):
    def test_defaults(self):
        snap = ItermSnapshot()
        self.assertEqual(snap.sessions, ())
        self.assertEqual(snap.at, 0.0)
        self.assertFalse(snap.not_running)
        self.assertEqual(snap.error, '')


class TestPathsSnapshotDefaults(TripwireTestCase):
    def test_defaults(self):
        self.assertEqual(PathsSnapshot().paths, ())


class TestAgentSnapshotAgentsFor(TripwireTestCase):
    def test_agents_for_known_tty(self):
        snap = AgentSnapshot(ttys=(('/dev/ttys000', frozenset({'claude'})),))
        self.assertEqual(snap.agents_for('/dev/ttys000'), frozenset({'claude'}))

    def test_agents_for_unknown_tty_is_empty_frozenset(self):
        snap = AgentSnapshot()
        self.assertEqual(snap.agents_for('/dev/ttys999'), frozenset())


class TestColorsSnapshotDefaults(TripwireTestCase):
    def test_defaults(self):
        self.assertEqual(ColorsSnapshot().colors, ())


class TestUsageSnapshotDefaults(TripwireTestCase):
    def test_defaults(self):
        snap = UsageSnapshot()
        self.assertIsNone(snap.data)
        self.assertTrue(snap.ok)
        self.assertFalse(snap.inactive)


class TestErrorSnapshotDefaults(TripwireTestCase):
    def test_defaults(self):
        snap = ErrorSnapshot()
        self.assertEqual(snap.kind, '')
        self.assertEqual(snap.error, '')


if __name__ == '__main__':
    unittest.main()
