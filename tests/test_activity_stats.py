"""New (DESIGN.md §3 P1 promoted to v1): activity timeline + ribbon,
"blocked on you" stats, and usage history / burn rate."""
import json
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import activity, stats, usagehist

T0 = 1_790_000_400.0    # a 600-s aligned epoch (…:00:00 + n*600)


class TestActivityLog(TripwireTestCase):
    def test_record_dedupes_and_is_monotonic(self):
        log = activity.ActivityLog()
        self.assertTrue(log.record('u', T0, 'busy'))
        self.assertFalse(log.record('u', T0 + 5, 'busy'))
        self.assertTrue(log.record('u', T0 - 10, 'waiting'))   # clock went back
        self.assertEqual(log.entries('u'), [(T0, 'busy'), (T0, 'waiting')])
        self.assertTrue(log.has('u'))
        self.assertEqual(log.uids(), ['u'])
        log.forget('u')
        self.assertFalse(log.has('u'))
        self.assertEqual(log.entries('u'), [])

    def test_prune_keeps_state_at_window_start(self):
        log = activity.ActivityLog(window=100)
        log.record('u', 0, 'idle')
        log.record('u', 10, 'busy')
        log.record('u', 50, 'waiting')
        log.record('u', 200, 'busy')      # cutoff 100: keep (50, waiting)
        self.assertEqual(log.entries('u'), [(50, 'waiting'), (200, 'busy')])

    def test_max_entries(self):
        log = activity.ActivityLog(max_entries=3)
        for i, st in enumerate(['a', 'b', 'a', 'b', 'a']):
            log.record('u', T0 + i, st)
        self.assertEqual(len(log.entries('u')), 3)

    def test_seed_prepends_only_older(self):
        log = activity.ActivityLog()
        log.record('u', T0, 'waiting')
        log.seed('u', [(T0 - 300, 'busy'), (T0 - 60, 'waiting'), (T0 + 10, 'idle')])
        self.assertEqual(log.entries('u'), [(T0 - 300, 'busy'), (T0 - 60, 'waiting')])
        log.seed('new', [(T0 - 5, 'idle'), (T0 - 9, 'busy')])
        self.assertEqual(log.entries('new'), [(T0 - 9, 'busy'), (T0 - 5, 'idle')])
        log.seed('empty', [])
        self.assertFalse(log.has('empty'))

    def test_segments_totals_history(self):
        log = activity.ActivityLog()
        log.record('u', T0 - 3600, 'idle')
        log.record('u', T0 - 1800, 'busy')
        log.record('u', T0 - 600, 'waiting')
        segs = log.segments('u', T0, T0 - 2400)
        self.assertEqual(segs, [
            {'state': 'idle', 'start': T0 - 2400, 'end': T0 - 1800},
            {'state': 'busy', 'start': T0 - 1800, 'end': T0 - 600},
            {'state': 'waiting', 'start': T0 - 600, 'end': None}])
        self.assertEqual(log.totals(segs, T0), {'busy': 1200.0, 'idle': 600.0, 'waiting': 600.0})
        self.assertEqual(log.segments('u', T0 - 3700, T0 - 4000), [])   # before any entry
        h = log.history('u', T0, hours=1)
        self.assertEqual((h['uid'], h['from'], h['to'], h['hours'], h['transitions']),
                         ('u', T0 - 3600, T0, 1, 2))
        self.assertEqual(log.totals([{'state': None, 'start': 0, 'end': 5}], 9), {'unknown': 5.0})

    def test_ribbon(self):
        log = activity.ActivityLog()
        self.assertIsNone(log.ribbon('u', T0))
        now = T0 + 300                       # mid-bucket
        log.record('u', now - 3 * 600 - 300, 'busy')
        log.record('u', now - 600 - 100, 'waiting')
        r = log.ribbon('u', now, buckets=6, bucket_seconds=600)
        self.assertEqual(r['end'], T0 + 600)
        self.assertEqual(r['bucket_s'], 600)
        # buckets: [-,-,b,b,w(400 of 600 → w wins),w]
        self.assertEqual(r['codes'], '--bbww')
        self.assertIs(log.ribbon('u', now + 1, buckets=6, bucket_seconds=600), r)   # cached
        log.record('u', now + 2, 'idle')
        self.assertIsNot(log.ribbon('u', now + 3, buckets=6, bucket_seconds=600), r)

    def test_ribbon_tie_prefers_waiting(self):
        log = activity.ActivityLog()
        log.record('u', T0 + 1, 'idle')
        log.record('u', T0 + 300, 'waiting')          # 299 s each: a tie
        r = log.ribbon('u', T0 + 599, buckets=1, bucket_seconds=600)
        self.assertEqual(r['codes'], 'w')
        log2 = activity.ActivityLog()
        log2.record('u', T0, 'weird')
        self.assertEqual(log2.ribbon('u', T0 + 60, buckets=1, bucket_seconds=600)['codes'], '-')


class TestBlockedStats(TripwireTestCase):
    def test_waits_answered_longest(self):
        st = stats.BlockedStats()
        st.roll(T0)
        self.assertTrue(st.start('a', T0))
        self.assertFalse(st.start('a', T0 + 1))
        st.start('b', T0 + 10)
        self.assertTrue(st.end('a', T0 + 100))
        self.assertFalse(st.end('zz', T0))
        st.end_all(T0 + 50)                   # b ends unanswered
        v = st.view()
        self.assertEqual((v['waiting_seconds'], v['longest_wait_s'], v['answered'], v['waits']),
                         (140, 100, 1, 2))
        self.assertEqual(v['active'], [])
        self.assertEqual(v['day'], stats.day_of(T0))

    def test_active_listed_oldest_first(self):
        st = stats.BlockedStats()
        st.start('b', T0 + 5)
        st.start('a', T0)
        self.assertEqual([a['uid'] for a in st.view()['active']], ['a', 'b'])

    def test_midnight_rollover_clips_active(self):
        midnight = stats.day_start(T0) + 86400
        st = stats.BlockedStats()
        st.start('a', midnight - 600)
        st.end('x', midnight - 300)
        self.assertTrue(st.roll(midnight + 60))
        self.assertFalse(st.roll(midnight + 61))
        self.assertEqual(st.active['a'], midnight)
        st.end('a', midnight + 120)
        v = st.view()
        self.assertEqual((v['waiting_seconds'], v['waits']), (120, 0))

    def test_persist_same_day_only(self):
        path = os.path.join(self.tmp_config_dir, 'stats.json')
        st = stats.BlockedStats(path)
        st.start('a', T0)
        st.end('a', T0 + 90)
        st.save()
        self.assertFalse(st.dirty)
        st.save()                               # not dirty: no-op
        again = stats.BlockedStats(path)
        again.load(T0 + 100)
        self.assertEqual((again.waiting_seconds, again.answered, again.waits), (90.0, 1, 1))
        other = stats.BlockedStats(path)
        other.load(T0 + 3 * 86400)
        self.assertEqual(other.waits, 0)

    def test_load_bad_files(self):
        path = os.path.join(self.tmp_config_dir, 'stats.json')
        st = stats.BlockedStats(path)
        st.load(T0)                              # missing
        for content in ('nope', '[]', json.dumps({'day': stats.day_of(T0), 'waits': 'x'})):
            with open(path, 'w') as f:
                f.write(content)
            st = stats.BlockedStats(path)
            st.load(T0)
            self.assertEqual(st.waits, 0)
        stats.BlockedStats().load(T0)            # no path

    def test_save_failure_is_ignored(self):
        st = stats.BlockedStats(os.path.join(self.tmp_config_dir, 'f', 'stats.json'))
        st.roll(T0)
        with mock.patch('tempfile.mkstemp', side_effect=OSError('ro')):
            st.save()
        self.assertTrue(st.dirty)

    def test_seed(self):
        st = stats.BlockedStats()
        st.start('a', T0)                         # first observation
        midnight = stats.day_start(T0)
        st.seed([(T0 - 900, T0 - 300), (midnight - 500, midnight + 100),
                 (midnight - 900, midnight - 100), (T0 - 60, T0 + 999)],
                {'a': T0 - 120, 'b': midnight - 50}, T0)
        v = st.view()
        self.assertEqual(v['waiting_seconds'], 700)   # 600 + 100 (clipped to midnight)
        self.assertEqual(v['answered'], 2)
        self.assertEqual(v['waits'], 4)                # a (live) + 2 completed + b
        self.assertEqual(st.active, {'a': T0 - 120, 'b': midnight})


class TestUsageHistory(TripwireTestCase):
    def limits(self, pct, resets=T0 + 3600):
        return [{'id': 'claude.five_hour', 'pct': pct, 'resets_at': resets},
                {'id': 'bad', 'pct': None}]

    def path(self):
        return os.path.join(self.tmp_config_dir, 'usage-history.jsonl')

    def test_record_appends_file_and_reloads(self):
        h = usagehist.UsageHistory(self.path())
        self.assertTrue(h.record('claude', self.limits(10.0), T0))
        self.assertFalse(h.record('claude', [{'id': 'x', 'pct': 'n/a'}], T0))
        h.record('claude', self.limits(12.0), T0 + 600)
        with open(self.path()) as f:
            lines = [json.loads(l) for l in f]
        self.assertEqual(lines[0], {'t': T0, 'p': 'claude',
                                    'l': {'claude.five_hour': [10.0, T0 + 3600]}})
        again = usagehist.UsageHistory(self.path())
        again.load(T0 + 700)
        self.assertEqual(again.series('claude.five_hour'),
                         [(T0, 10.0, T0 + 3600), (T0 + 600, 12.0, T0 + 3600)])
        self.assertEqual(again.limit_ids(), {'claude.five_hour': 'claude'})

    def test_load_prunes_old_and_malformed(self):
        with open(self.path(), 'w') as f:
            f.write(json.dumps({'t': T0 - 8 * 86400, 'p': 'c', 'l': {'x': [1, None]}}) + '\n')
            f.write('not json\n')
            f.write(json.dumps({'t': 'x'}) + '\n')
            f.write(json.dumps({'t': T0, 'p': 'c', 'l': {'x': [5]}}) + '\n')
        h = usagehist.UsageHistory(self.path())
        h.load(T0)
        self.assertEqual(h.series('x'), [(T0, 5, None)])
        with open(self.path()) as f:
            self.assertEqual(len(f.readlines()), 1)   # rewritten

    def test_overflow_prunes(self):
        h = usagehist.UsageHistory(self.path(), max_entries=5)
        for i in range(7):
            h.record('claude', self.limits(float(i)), T0 + i)
        self.assertEqual(len(h.series('claude.five_hour')), 5)
        with open(self.path()) as f:
            self.assertEqual(len(f.readlines()), 5)

    def test_memory_only_and_write_errors(self):
        h = usagehist.UsageHistory()
        h.load(T0)
        h.record('claude', self.limits(1.0), T0)
        h.seed([{'t': T0 - 1, 'p': 'claude', 'l': {'claude.five_hour': [0.5, None]}}, {'bad': 1}], T0)
        self.assertEqual(len(h.series('claude.five_hour')), 2)
        blocked = usagehist.UsageHistory(os.path.join(self.path(), 'sub', 'x.jsonl'))
        open(self.path(), 'w').close()            # a file where a dir is needed
        blocked.record('claude', self.limits(1.0), T0)
        blocked.seed([], T0)
        self.assertEqual(len(blocked.series('claude.five_hour')), 1)

    def test_burn_projection_before_reset(self):
        h = usagehist.UsageHistory()
        for i in range(5):                        # +5 % per 10 min = 30 %/h
            h.record('claude', self.limits(50.0 + 5 * i, resets=T0 + 10 * 3600), T0 + 600 * i)
        b = h.burn('claude.five_hour', T0 + 2400)
        self.assertEqual(b['rate_per_hour'], 30.0)
        self.assertEqual(b['eta'], int(T0 + 2400 + 30 / 30 * 3600))
        self.assertTrue(b['before_reset'])
        self.assertTrue(b['text'].startswith('at this rate: 100% '))
        self.assertIsNone(b['at_reset_pct'])

    def test_burn_resets_first_hit_flat_and_insufficient(self):
        h = usagehist.UsageHistory()
        self.assertIsNone(h.burn('claude.five_hour', T0))
        h.record('claude', self.limits(10.0, resets=T0 + 1200), T0)
        self.assertIsNone(h.burn('claude.five_hour', T0))            # one point
        h.record('claude', self.limits(11.0, resets=T0 + 1200), T0 + 300)
        self.assertIsNone(h.burn('claude.five_hour', T0))            # span < 10 min
        h.record('claude', self.limits(12.0, resets=T0 + 1200), T0 + 600)
        b = h.burn('claude.five_hour', T0 + 600)
        self.assertEqual((b['eta'], b['before_reset'], b['at_reset_pct']), (None, False, 14.0))
        self.assertEqual(b['text'], 'at this rate: ~14% at reset')
        flat = usagehist.UsageHistory()
        for i in range(3):
            flat.record('claude', self.limits(40.0), T0 + 600 * i)
        self.assertEqual(flat.burn('claude.five_hour', T0)['text'], 'not rising')
        hit = usagehist.UsageHistory()
        for i in range(3):
            hit.record('claude', self.limits(98.0 + i), T0 + 600 * i)
        self.assertEqual(hit.burn('claude.five_hour', T0)['text'], 'limit hit')

    def test_burn_ignores_previous_cycle(self):
        h = usagehist.UsageHistory()
        h.record('claude', self.limits(90.0, resets=T0), T0 - 1200)
        h.record('claude', self.limits(95.0, resets=T0), T0 - 600)
        h.record('claude', self.limits(1.0, resets=T0 + 18000), T0 + 60)
        self.assertIsNone(h.burn('claude.five_hour', T0 + 60))

    def test_view(self):
        h = usagehist.UsageHistory()
        h.record('claude', self.limits(10.0), T0 - 7200)
        h.record('claude', self.limits(20.0), T0 - 60)
        v = h.view(T0, hours=1)
        self.assertEqual((v['from'], v['to'], v['hours']), (T0 - 3600, T0, 1))
        lim = v['limits']['claude.five_hour']
        self.assertEqual(lim['points'], [[T0 - 60, 20.0]])
        self.assertEqual(lim['latest'], {'t': T0 - 60, 'pct': 20.0, 'resets_at': T0 + 3600})
        self.assertEqual(lim['provider'], 'claude')
        self.assertIn('burn', lim)
        self.assertEqual(h.view(T0 + 86400 * 2, hours=1)['limits'], {})


if __name__ == '__main__':
    unittest.main()
