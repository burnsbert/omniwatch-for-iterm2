"""New test coverage for config.py's env overrides and config.json loader
(docs/DESIGN.md §4.2)."""
import importlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import config


class TestConfigDirOverride(TripwireTestCase):
    def test_state_dir_follows_omniwatch_config_dir(self):
        # The tripwire's own setUp already sets OMNIWATCH_CONFIG_DIR to a
        # fresh temp dir; reload to pick it up and confirm the override.
        importlib.reload(config)
        try:
            self.assertEqual(config.STATE_DIR, self.tmp_config_dir)
            self.assertEqual(config.STATE_PATH,
                             os.path.join(self.tmp_config_dir, 'state.json'))
        finally:
            importlib.reload(config)

    def test_ultrawatch_path_ignores_omniwatch_config_dir(self):
        importlib.reload(config)
        try:
            self.assertNotIn(self.tmp_config_dir, config.ULTRAWATCH_STATE_PATH)
            self.assertTrue(
                config.ULTRAWATCH_STATE_PATH.endswith(
                    os.path.join('ultrawatch', 'state.json')))
        finally:
            importlib.reload(config)


class TestDebugStateAlias(TripwireTestCase):
    def test_ow_debug_state(self):
        with mock.patch.dict(os.environ, {'OW_DEBUG_STATE': '1'}, clear=False):
            importlib.reload(config)
            try:
                self.assertTrue(config.DEBUG_STATE)
            finally:
                importlib.reload(config)

    def test_uw_debug_state_alias(self):
        with mock.patch.dict(os.environ, {'UW_DEBUG_STATE': '1'}, clear=False):
            importlib.reload(config)
            try:
                self.assertTrue(config.DEBUG_STATE)
            finally:
                importlib.reload(config)

    def test_unset_is_false(self):
        env = dict(os.environ)
        env.pop('OW_DEBUG_STATE', None)
        env.pop('UW_DEBUG_STATE', None)
        with mock.patch.dict(os.environ, env, clear=True):
            importlib.reload(config)
            try:
                self.assertFalse(config.DEBUG_STATE)
            finally:
                importlib.reload(config)


class TestConfigJsonOverrides(TripwireTestCase):
    def test_interval_overrides_applied(self):
        with open(os.path.join(self.tmp_config_dir, 'config.json'), 'w') as f:
            json.dump({'intervals': {'snapshot': 7, 'agents': 3},
                      'fresh_seconds': 60}, f)
        importlib.reload(config)
        try:
            self.assertEqual(config.SNAPSHOT_INTERVAL, 7)
            self.assertEqual(config.AGENTS_INTERVAL, 3)
            self.assertEqual(config.PATHS_INTERVAL, 10)  # untouched default
            self.assertEqual(config.FRESH_SECONDS, 60)
        finally:
            importlib.reload(config)

    def test_malformed_config_json_falls_back_to_defaults(self):
        with open(os.path.join(self.tmp_config_dir, 'config.json'), 'w') as f:
            f.write('{not json')
        importlib.reload(config)
        try:
            self.assertEqual(config.SNAPSHOT_INTERVAL, 2)
            self.assertEqual(config.FRESH_SECONDS, 30)
        finally:
            importlib.reload(config)

    def test_missing_config_json_uses_defaults(self):
        importlib.reload(config)
        try:
            self.assertEqual(config.SNAPSHOT_INTERVAL, 2)
            self.assertEqual(config.PATHS_INTERVAL, 10)
            self.assertEqual(config.AGENTS_INTERVAL, 5)
            self.assertEqual(config.USAGE_REFRESH_INTERVAL, 300)
            self.assertEqual(config.CODEX_USAGE_REFRESH_INTERVAL, 300)
            self.assertEqual(config.COLOR_INTERVAL, 5)
        finally:
            importlib.reload(config)

    def test_negative_interval_ignored(self):
        with open(os.path.join(self.tmp_config_dir, 'config.json'), 'w') as f:
            json.dump({'intervals': {'snapshot': -5}}, f)
        importlib.reload(config)
        try:
            self.assertEqual(config.SNAPSHOT_INTERVAL, 2)
        finally:
            importlib.reload(config)


class TestDemoFlag(TripwireTestCase):
    def test_demo_flag_from_env(self):
        with mock.patch.dict(os.environ, {'OMNIWATCH_DEMO': '1'}):
            importlib.reload(config)
            try:
                self.assertTrue(config.DEMO)
            finally:
                importlib.reload(config)


if __name__ == '__main__':
    unittest.main()
