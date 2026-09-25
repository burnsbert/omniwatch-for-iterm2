import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import persist


class TestStateStore(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, 'state.json')
        # Point migration at a nonexistent file by default so these
        # (ported, pre-migration-era) tests see plain DEFAULTS.
        self.no_ultrawatch = os.path.join(self.dir.name, 'no-ultrawatch.json')
        self.addCleanup(self.dir.cleanup)

    def store(self, now=1000.0):
        return persist.StateStore(path=self.path, now=now,
                                  ultrawatch_path=self.no_ultrawatch)

    def test_defaults_when_no_file(self):
        st = self.store()
        self.assertEqual(st.get('view'), 'split')
        self.assertEqual(st.get('sort'), 'natural')
        self.assertFalse(st.get('show_dollars'))
        self.assertEqual(st.label('X'), '')

    def test_round_trip(self):
        st = self.store(now=1000.0)
        st.set_label('UID-1', 'api server', now=1000.0)
        st.set('view', 'grid', now=1000.0)
        st.set('show_dollars', True, now=1000.0)
        st.save()
        st2 = self.store(now=1001.0)
        self.assertEqual(st2.label('UID-1'), 'api server')
        self.assertEqual(st2.get('view'), 'grid')
        self.assertTrue(st2.get('show_dollars'))

    def test_empty_label_removes(self):
        st = self.store()
        st.set_label('UID-1', 'x', now=1000.0)
        st.set_label('UID-1', '', now=1001.0)
        self.assertEqual(st.label('UID-1'), '')
        self.assertNotIn('UID-1', st.state['labels'])

    def test_debounce(self):
        st = self.store()
        st.set('view', 'list', now=1000.0)
        st.maybe_save(now=1001.0)
        self.assertFalse(os.path.exists(self.path))  # within debounce
        st.maybe_save(now=1002.5)
        self.assertTrue(os.path.exists(self.path))
        st.maybe_save(now=1010.0)  # not dirty anymore — no rewrite needed
        with open(self.path) as f:
            self.assertEqual(json.load(f)['view'], 'list')

    def test_label_gc(self):
        old = 1000.0
        st = self.store(now=old)
        st.set_label('UID-OLD', 'stale', now=old)
        st.set_label('UID-NEW', 'fresh', now=old)
        st.save()
        # 20 days later, only the touched label survives
        later = old + 20 * 86400
        raw = json.load(open(self.path))
        raw['labels']['UID-NEW']['last_seen'] = int(later - 100)
        json.dump(raw, open(self.path, 'w'))
        st2 = self.store(now=later)
        self.assertEqual(st2.label('UID-OLD'), '')
        self.assertEqual(st2.label('UID-NEW'), 'fresh')

    def test_corrupt_file_falls_back_to_defaults(self):
        with open(self.path, 'w') as f:
            f.write('{not json')
        st = self.store()
        self.assertEqual(st.get('view'), 'split')

    def test_touch_labels_refreshes_last_seen(self):
        st = self.store()
        st.set_label('UID-1', 'x', now=1000.0)
        st.touch_labels(['UID-1', 'UID-MISSING'], now=5000.0)
        self.assertEqual(st.state['labels']['UID-1']['last_seen'], 5000)

    def test_projects_default_five_empty_slots(self):
        st = self.store()
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')
        self.assertFalse(st.get('projects_open'))

    def test_set_project_round_trips_and_persists(self):
        st = self.store(now=1000.0)
        st.set_project(1, 'api-gateway', now=1000.0)
        st.set_project(5, 'billing', now=1000.0)
        st.set('projects_open', True, now=1000.0)
        st.save()
        st2 = self.store(now=1001.0)
        self.assertEqual(st2.project(1), 'api-gateway')
        self.assertEqual(st2.project(2), '')
        self.assertEqual(st2.project(5), 'billing')
        self.assertTrue(st2.get('projects_open'))

    def test_clear_projects_resets_all_five(self):
        st = self.store(now=1000.0)
        for i in range(1, 6):
            st.set_project(i, f'proj-{i}', now=1000.0)
        st.clear_projects(now=1001.0)
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')

    def test_malformed_projects_on_load_defaults_safely(self):
        with open(self.path, 'w') as f:
            json.dump({'projects': 'not-a-list'}, f)
        st = self.store()
        for i in range(1, 6):
            self.assertEqual(st.project(i), '')

    def test_short_projects_list_on_load_padded(self):
        with open(self.path, 'w') as f:
            json.dump({'projects': ['only-one']}, f)
        st = self.store()
        self.assertEqual(st.project(1), 'only-one')
        self.assertEqual(st.project(5), '')

    def test_set_is_a_noop_when_value_unchanged(self):
        st = self.store(now=1000.0)
        st.set('view', 'split', now=1000.0)  # already the default
        self.assertIsNone(st._dirty_at)

    def test_set_project_out_of_range_is_a_noop(self):
        st = self.store(now=1000.0)
        st.set_project(0, 'x', now=1000.0)
        st.set_project(6, 'x', now=1000.0)
        self.assertIsNone(st._dirty_at)

    def test_set_project_same_value_is_a_noop(self):
        st = self.store(now=1000.0)
        st.set_project(1, 'api', now=1000.0)
        st.save()
        st.set_project(1, 'api', now=2000.0)  # unchanged
        self.assertIsNone(st._dirty_at)

    def test_project_out_of_range_index_returns_empty(self):
        st = self.store()
        self.assertEqual(st.project(0), '')
        self.assertEqual(st.project(6), '')

    def test_labels_not_a_dict_on_load_resets_to_empty(self):
        with open(self.path, 'w') as f:
            json.dump({'labels': 'not-a-dict'}, f)
        st = self.store()
        self.assertEqual(st.state['labels'], {})

    def test_save_failure_is_swallowed(self):
        st = self.store(now=1000.0)
        st.set('view', 'grid', now=1000.0)
        # An unserializable value in state makes json.dump() raise inside
        # save()'s try block; save() must swallow it (best-effort) rather
        # than crash the engine, and clean up its temp file.
        st.state['bogus'] = object()
        st.save()  # must not raise
        self.assertFalse(os.path.exists(self.path))
        leftover = [f for f in os.listdir(self.dir.name) if f.startswith('.state-')]
        self.assertEqual(leftover, [])


class TestNewPrefsKeys(TripwireTestCase):
    """New (docs/DESIGN.md §4.4.1/§4.6): the expanded Prefs shape."""

    def setUp(self):
        super().setUp()
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, 'state.json')
        self.no_ultrawatch = os.path.join(self.dir.name, 'no-ultrawatch.json')
        self.addCleanup(self.dir.cleanup)

    def store(self, now=1000.0):
        return persist.StateStore(path=self.path, now=now,
                                  ultrawatch_path=self.no_ultrawatch)

    def test_new_default_values(self):
        st = self.store()
        self.assertEqual(st.get('version'), 2)
        self.assertFalse(st.get('grid_all'))
        self.assertEqual(st.get('usage_strip'), 'expanded')
        self.assertEqual(st.get('theme'), 'system')
        self.assertEqual(st.get('font_scale'), 1.0)
        self.assertEqual(st.get('notifications'),
                         {'enabled': True, 'click': 'goto', 'stall': True})
        self.assertTrue(st.get('quick_reply'))
        self.assertFalse(st.get('keep_on_top'))
        self.assertTrue(st.get('close_window_on_q'))
        self.assertTrue(st.get('hint_bar'))
        self.assertFalse(st.get('debug_rule'))
        self.assertFalse(st.get('onboarding_done'))
        self.assertFalse(st.get('sound'))
        self.assertIsNone(st.get('migrated_from_ultrawatch'))

    def test_pref_keys_whitelist_excludes_storage_only_keys(self):
        for key in ('version', 'labels', 'projects', 'muted',
                   'migrated_from_ultrawatch'):
            self.assertNotIn(key, persist.PREF_KEYS)
        self.assertIn('sound', persist.PREF_KEYS)
        self.assertIn('grid_all', persist.PREF_KEYS)

    def test_muted_round_trips(self):
        st = self.store(now=1000.0)
        self.assertFalse(st.muted('UID-1'))
        st.set_muted('UID-1', True, now=1000.0)
        self.assertTrue(st.muted('UID-1'))
        st.save()
        st2 = self.store(now=1001.0)
        self.assertTrue(st2.muted('UID-1'))
        st2.set_muted('UID-1', False, now=1001.0)
        self.assertFalse(st2.muted('UID-1'))

    def test_set_muted_same_value_is_a_noop(self):
        st = self.store(now=1000.0)
        st.set_muted('UID-1', False, now=1000.0)  # already unmuted
        self.assertIsNone(st._dirty_at)

    def test_defaults_are_not_aliased_between_instances(self):
        st1 = self.store(now=1000.0)
        st1.set_label('UID-1', 'x', now=1000.0)
        st1.set_project(1, 'api', now=1000.0)
        st1.set_muted('UID-1', True, now=1000.0)
        st2 = persist.StateStore(path=os.path.join(self.dir.name, 'other.json'),
                                 now=1000.0, ultrawatch_path=self.no_ultrawatch)
        self.assertEqual(st2.state['labels'], {})
        self.assertEqual(st2.project(1), '')
        self.assertFalse(st2.muted('UID-1'))


class TestUltrawatchMigration(TripwireTestCase):
    """New (docs/DESIGN.md §4.2 P-75): one-time read-only import from an
    Ultrawatch state.json."""

    def setUp(self):
        super().setUp()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.omniwatch_path = os.path.join(self.dir.name, 'omniwatch-state.json')
        self.ultrawatch_path = os.path.join(self.dir.name, 'ultrawatch-state.json')

    def write_ultrawatch_state(self, **overrides):
        data = {
            'version': 1,
            'labels': {'UID-1': {'label': 'api', 'last_seen': int(time.time())}},
            'view': 'grid',
            'sort': 'attention',
            'show_dollars': True,
            'bell': True,
            'split_ratio': 0.3,
            'projects': ['api', '', '', '', 'infra'],
            'projects_open': True,
        }
        data.update(overrides)
        with open(self.ultrawatch_path, 'w') as f:
            json.dump(data, f)

    def test_migrate_from_ultrawatch_pure_function(self):
        self.write_ultrawatch_state()
        migrated = persist.migrate_from_ultrawatch(self.ultrawatch_path)
        self.assertEqual(migrated['view'], 'grid')
        self.assertEqual(migrated['sort'], 'attention')
        self.assertTrue(migrated['show_dollars'])
        self.assertTrue(migrated['sound'])  # bell -> sound
        self.assertNotIn('bell', migrated)
        self.assertEqual(migrated['split_ratio'], 0.3)
        self.assertEqual(migrated['projects'][0], 'api')
        self.assertEqual(migrated['labels']['UID-1']['label'], 'api')

    def test_missing_ultrawatch_file_returns_none(self):
        self.assertIsNone(persist.migrate_from_ultrawatch(
            os.path.join(self.dir.name, 'nope.json')))

    def test_corrupt_ultrawatch_file_returns_none(self):
        with open(self.ultrawatch_path, 'w') as f:
            f.write('{not json')
        self.assertIsNone(persist.migrate_from_ultrawatch(self.ultrawatch_path))

    def test_non_dict_ultrawatch_file_returns_none(self):
        with open(self.ultrawatch_path, 'w') as f:
            json.dump(['not', 'a', 'dict'], f)
        self.assertIsNone(persist.migrate_from_ultrawatch(self.ultrawatch_path))

    def test_fresh_store_migrates_on_first_run(self):
        self.write_ultrawatch_state()
        st = persist.StateStore(path=self.omniwatch_path, now=1000.0,
                                ultrawatch_path=self.ultrawatch_path)
        self.assertEqual(st.get('view'), 'grid')
        self.assertEqual(st.get('sort'), 'attention')
        self.assertTrue(st.get('show_dollars'))
        self.assertTrue(st.get('sound'))
        self.assertEqual(st.project(1), 'api')
        self.assertEqual(st.project(5), 'infra')
        self.assertTrue(st.get('projects_open'))
        self.assertEqual(st.label('UID-1'), 'api')
        self.assertEqual(st.get('migrated_from_ultrawatch'), 1000)

    def test_ultrawatch_file_is_never_written(self):
        self.write_ultrawatch_state()
        before = open(self.ultrawatch_path).read()
        st = persist.StateStore(path=self.omniwatch_path, now=1000.0,
                                ultrawatch_path=self.ultrawatch_path)
        st.set('view', 'list', now=1001.0)
        st.save()
        after = open(self.ultrawatch_path).read()
        self.assertEqual(before, after)

    def test_migration_runs_at_most_once(self):
        self.write_ultrawatch_state()
        st = persist.StateStore(path=self.omniwatch_path, now=1000.0,
                                ultrawatch_path=self.ultrawatch_path)
        st.set('view', 'list', now=1000.0)  # diverge from the migrated value
        st.save()
        # Even though the Ultrawatch file is still there, a second load of
        # an *existing* Omniwatch state.json must not re-import over the
        # user's own subsequent changes.
        st2 = persist.StateStore(path=self.omniwatch_path, now=2000.0,
                                 ultrawatch_path=self.ultrawatch_path)
        self.assertEqual(st2.get('view'), 'list')

    def test_no_ultrawatch_file_no_migration_recorded(self):
        st = persist.StateStore(
            path=self.omniwatch_path, now=1000.0,
            ultrawatch_path=os.path.join(self.dir.name, 'nope.json'))
        self.assertIsNone(st.get('migrated_from_ultrawatch'))
        self.assertEqual(st.get('view'), 'split')


if __name__ == '__main__':
    unittest.main()
