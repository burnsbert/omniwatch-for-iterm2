"""New (docs/DESIGN.md §4.2 engine threading, §4.4 commands, §7 WP2):
engine transitions, publishing/diffing, and every command's validation."""
import os
import queue
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import Harness, RecColors, RecWorker
import fake_providers as fp

from omniwatch import engine as engine_mod
from omniwatch import heuristics as H
from omniwatch import persist
from omniwatch.engine import ApiError
from omniwatch.snapshot import ColorsSnapshot, ItermSnapshot, UsageSnapshot


class EngineTestCase(TripwireTestCase):
    def harness(self, **kw):
        return Harness(self.tmp_config_dir, **kw)

    def assertApiError(self, status, code, fn, *args):
        with self.assertRaises(ApiError) as cm:
            fn(*args)
        self.assertEqual((cm.exception.status, cm.exception.code), (status, code),
                         cm.exception.message)
        return cm.exception


class TestInitialState(EngineTestCase):
    def test_connecting_document(self):
        h = self.harness()
        doc = h.engine.state()
        self.assertEqual(doc['iterm']['status'], 'connecting')
        self.assertEqual(doc['sessions'], [])
        self.assertEqual(doc['summary'], {'tabs': 0, 'agents': 0, 'waiting': 0,
                                          'busy': 0, 'stalled': 0, 'waiting_uids': []})
        self.assertEqual(doc['usage']['claude']['status'], 'inactive')
        self.assertEqual([p['color'] for p in doc['projects']],
                         ['blue', 'purple', 'green', 'red', 'yellow'])
        self.assertEqual(doc['capabilities'],
                         {'tab_colors': None, 'reply': True, 'debug_rule': False})
        self.assertIsNone(doc['quota_prompt'])
        self.assertFalse(doc['demo'])
        self.assertEqual(set(doc['prefs']), set(persist.PREF_KEYS))
        self.assertEqual(h.events(), [])

    def test_hello_and_sse_snapshot(self):
        h = self.harness()
        hello = h.engine.hello()
        self.assertEqual(hello['version'], '1.0.0')
        self.assertEqual(hello['server_time'], h.p.clock.time())
        seq, doc = h.engine.sse_snapshot()
        self.assertEqual(seq, doc['seq'])

    def test_quota_defaults_to_notifier_module_outside_demo(self):
        from omniwatch import notifier
        p = fp.default_world()
        store = persist.StateStore(path=os.path.join(self.tmp_config_dir, 's.json'),
                                   ultrawatch_path=os.path.join(self.tmp_config_dir, 'x'))
        from omniwatch import sse
        eng = engine_mod.Engine(p, store, sse.Hub(), pollers={})
        self.assertIs(eng.quota, notifier)
        eng2 = engine_mod.Engine(p, store, sse.Hub(), pollers={}, demo=True)
        self.assertIsInstance(eng2.quota, engine_mod.MemoryQuota)

    def test_invalid_stored_prefs_are_normalized(self):
        store = persist.StateStore(path=os.path.join(self.tmp_config_dir, 's.json'),
                                   ultrawatch_path=os.path.join(self.tmp_config_dir, 'x'))
        store.state.update(view='bogus', split_ratio=5, notifications={'enabled': 1},
                           theme='dark')
        engine_mod.normalize_prefs(store)
        self.assertEqual(store.get('view'), 'split')
        self.assertEqual(store.get('split_ratio'), 0.42)
        self.assertEqual(store.get('notifications'),
                         {'enabled': True, 'click': 'goto', 'stall': True})
        self.assertEqual(store.get('theme'), 'dark')

    def test_notifications_missing_key_migration_fills_default(self):
        """A stored `notifications` dict from before the `stall` key
        existed keeps its other valid values; only the missing key is
        filled from the default (it must not be wiped wholesale)."""
        store = persist.StateStore(path=os.path.join(self.tmp_config_dir, 's.json'),
                                   ultrawatch_path=os.path.join(self.tmp_config_dir, 'x'))
        store.state['notifications'] = {'enabled': False, 'click': 'show'}
        engine_mod.normalize_prefs(store)
        self.assertEqual(store.get('notifications'),
                         {'enabled': False, 'click': 'show', 'stall': True})

    def test_notifications_invalid_key_falls_back_individually(self):
        store = persist.StateStore(path=os.path.join(self.tmp_config_dir, 's.json'),
                                   ultrawatch_path=os.path.join(self.tmp_config_dir, 'x'))
        store.state['notifications'] = {'enabled': False, 'click': 'bogus', 'stall': 'nope'}
        engine_mod.normalize_prefs(store)
        self.assertEqual(store.get('notifications'),
                         {'enabled': False, 'click': 'goto', 'stall': True})


class TestSessionsPublishing(EngineTestCase):
    def test_first_poll_builds_sessions(self):
        h = self.harness()
        h.poll()
        doc = h.engine.state()
        self.assertEqual(doc['iterm']['status'], 'ok')
        self.assertEqual(doc['iterm']['last_poll_at'], h.p.clock.time())
        self.assertEqual([s['uid'] for s in doc['sessions']],
                         [fp.UID_WAIT, fp.UID_BUSY, fp.UID_CODEX, fp.UID_SHELL])
        self.assertEqual(doc['windows'], [{'id': 100, 'number': 1}, {'id': 200, 'number': 2}])
        self.assertEqual(doc['summary'], {
            'tabs': 4, 'agents': 3, 'waiting': 2, 'busy': 1, 'stalled': 0,
            'waiting_uids': [fp.UID_WAIT, fp.UID_CODEX]})
        wait = h.session(fp.UID_WAIT)
        self.assertEqual(wait['tab_label'], '1.1')
        self.assertEqual(wait['path_display'], '~/src/api')
        self.assertEqual(wait['agent'], 'claude')
        self.assertEqual(wait['agents'], ['claude'])
        self.assertEqual(wait['state'], 'waiting')
        self.assertTrue(wait['attention'])
        self.assertEqual(wait['tab_color'], 'blue')
        self.assertEqual(wait['project'], 1)
        self.assertEqual(wait['prompt']['question'], 'Do you want to proceed?')
        self.assertNotIn('rule', wait)
        shell = h.session(fp.UID_SHELL)
        self.assertIsNone(shell['agent'])
        self.assertIsNone(shell['prompt'])
        self.assertEqual(doc['screens'][fp.UID_WAIT]['text'], fp.CLAUDE_WAITING)
        self.assertEqual(doc['screens'][fp.UID_WAIT]['hash'], wait['screen_hash'])
        self.assertEqual(doc['capabilities']['tab_colors'], True)
        names = [e[1] for e in h.events()]
        self.assertEqual(names[:2], ['sessions', 'screens'])

    def test_lsof_cwd_fallback_and_needs_cwd_box(self):
        from omniwatch.pollers import LatestBox
        box = LatestBox()
        h = self.harness(needs_cwd_box=box)
        h.poll()
        self.assertEqual(box.get(), frozenset({'/dev/ttys004'}))
        h.poll()   # second pass asks the agents provider for the missing cwd
        self.assertIn(frozenset({'/dev/ttys004'}), h.p.agents.fill_requests)
        self.assertEqual(h.session(fp.UID_SHELL)['path_display'], '~/src/infra')

    def test_debug_rule_included(self):
        h = self.harness(debug_state=True)
        h.poll()
        self.assertEqual(h.session(fp.UID_WAIT)['rule'], 'permission-question')
        self.assertTrue(h.engine.state()['capabilities']['debug_rule'])

    def test_sessions_event_seq_and_state_seq(self):
        h = self.harness()
        seq = h.poll()
        events = h.events()
        self.assertEqual(events[-1][0], seq)
        self.assertEqual(h.engine.state()['seq'], seq)
        sess = [e for e in events if e[1] == 'sessions'][0]
        self.assertEqual(sess[2]['seq'], sess[0])
        self.assertEqual(set(sess[2]), {'seq', 'sessions', 'summary', 'windows', 'iterm'})

    def test_no_events_when_nothing_changes(self):
        h = self.harness()
        h.poll(times=2)   # the 2nd pass fills the shell's lsof cwd
        h.events()
        h.p.clock.advance(1)   # last_poll_at moves but doesn't trigger an event
        h.poll()
        self.assertEqual(h.events(), [])

    def test_screens_event_only_for_raw_changes_and_removals(self):
        h = self.harness()
        h.poll()
        h.events()
        h.set_text(fp.UID_BUSY, fp.CLAUDE_BUSY.replace('✢', '✻'))  # spinner frame
        h.poll()
        screens = h.named('screens')
        self.assertEqual(len(screens), 1)
        self.assertEqual(list(screens[0]['screens']), [fp.UID_BUSY])
        self.assertEqual(screens[0]['removed'], [])
        del h.p.iterm.sessions[3]
        h.poll()
        screens = h.named('screens')
        self.assertEqual(screens[0]['removed'], [fp.UID_SHELL])
        self.assertEqual(screens[0]['screens'], {})

    def test_single_window_tab_label(self):
        p = fp.FakeProviders(sessions=[fp.session('U1', '/dev/ttys9', fp.SHELL, tab=3)])
        h = self.harness(providers=p)
        h.poll()
        s = h.session('U1')
        self.assertEqual(s['tab_label'], '3')
        self.assertEqual(s['title'], 'zsh')        # no label, no path → name
        self.assertEqual(s['display_name'], 'zsh')

    def test_dashboard_detection(self):
        p = fp.FakeProviders(sessions=[fp.session('U1', '/dev/ttys9',
                                                  '▛▞ ULTRAWATCH  3 tabs\nrest')])
        h = self.harness(providers=p)
        h.poll()
        self.assertTrue(h.session('U1')['is_dashboard'])


class TestTransitions(EngineTestCase):
    def test_busy_to_waiting_after_debounce(self):
        h = self.harness()
        h.poll()
        h.events()
        h.p.clock.advance(3)
        h.set_text(fp.UID_BUSY, fp.CLAUDE_WAITING, processing=False)
        h.poll()
        self.assertEqual(h.named('transition'), [])    # debounced
        h.poll()
        events = h.events()
        names = [e[1] for e in events]
        self.assertIn('transition', names)
        self.assertLess(names.index('sessions'), names.index('transition'))
        tr = [e[2] for e in events if e[1] == 'transition'][0]
        self.assertEqual((tr['uid'], tr['from'], tr['to']), (fp.UID_BUSY, 'busy', 'waiting'))
        self.assertEqual(tr['at'], h.p.clock.time())
        self.assertEqual(tr['title'], '~/src/billing')
        self.assertEqual(tr['agent'], 'claude')
        self.assertEqual(tr['prompt']['options'][0]['key'], '1')
        self.assertFalse(tr['muted'])
        self.assertIn(fp.UID_BUSY, h.engine.state()['summary']['waiting_uids'])

    def test_transition_carries_muted_flag(self):
        h = self.harness()
        h.poll()
        h.engine.set_muted(fp.UID_BUSY, {'muted': True})
        h.set_text(fp.UID_BUSY, fp.CLAUDE_WAITING, processing=False)
        h.poll(times=2)
        tr = h.named('transition')
        self.assertTrue(tr and tr[0]['muted'])

    def test_transition_dropped_when_session_vanishes(self):
        h = self.harness()
        h.poll()
        h.engine._transitions.append(('GONE', 'busy', 'waiting', 1.0))
        h.engine.pump()
        self.assertEqual(h.named('transition'), [])

    def test_visit_clears_attention(self):
        h = self.harness()
        h.poll()
        self.assertTrue(h.session(fp.UID_WAIT)['attention'])
        self.assertEqual(h.engine.visit(fp.UID_WAIT), {'ok': True})
        self.assertFalse(h.session(fp.UID_WAIT)['attention'])
        self.assertApiError(404, 'not_found', h.engine.visit, 'nope')

    def test_plugin_focus(self):
        h = self.harness()
        h.poll()
        h.engine.plugin_focus({'uid': fp.UID_WAIT})
        self.assertFalse(h.session(fp.UID_WAIT)['attention'])
        self.assertApiError(400, 'bad_request', h.engine.plugin_focus, {})

    def test_fresh_until(self):
        h = self.harness()
        h.poll()
        self.assertIsNone(h.session(fp.UID_SHELL)['fresh_until'])   # startup grace
        h.p.clock.advance(10)
        h.set_text(fp.UID_SHELL, fp.SHELL + '\nls\n')
        h.poll()
        s = h.session(fp.UID_SHELL)
        self.assertEqual(s['fresh_until'], s['last_change'] + 30)
        self.assertIsNone(h.session(fp.UID_BUSY)['fresh_until'])    # busy never fresh
        h.p.clock.advance(31)
        h.engine.pump()
        self.assertIsNone(h.session(fp.UID_SHELL)['fresh_until'])


class TestItermStatus(EngineTestCase):
    def test_not_running_clears_sessions(self):
        h = self.harness()
        h.poll()
        h.p.iterm.mode = 'not_running'
        h.poll()
        doc = h.engine.state()
        self.assertEqual(doc['iterm']['status'], 'not_running')
        self.assertEqual(doc['sessions'], [])
        self.assertFalse(doc['iterm']['stale'])

    def test_not_authorized_prefix_mapping(self):
        h = self.harness()
        h.p.iterm.mode = 'not_authorized'
        h.poll()
        it = h.engine.state()['iterm']
        self.assertEqual(it['status'], 'not_authorized')
        self.assertIn('-1743', it['error'])
        self.assertEqual(h.engine.diagnostics()['automation'], 'denied')

    def test_error_keeps_sessions_and_marks_stale(self):
        h = self.harness()
        h.poll()
        h.p.iterm.mode = 'error'
        h.poll()
        doc = h.engine.state()
        self.assertEqual(doc['iterm']['status'], 'error')
        self.assertEqual(doc['iterm']['error'], 'osascript timed out')
        self.assertTrue(doc['iterm']['stale'])
        self.assertEqual(len(doc['sessions']), 4)

    def test_stale_after_four_intervals(self):
        h = self.harness()
        h.poll()
        h.p.clock.advance(8.5)
        h.engine.pump()
        self.assertTrue(h.engine.state()['iterm']['stale'])

    def test_poll_ms_from_real_snapshot_time(self):
        h = self.harness()
        h.engine.events.put(('iterm', ItermSnapshot(sessions=(), at=time.time() - 0.25)))
        h.engine.pump()
        self.assertGreaterEqual(h.engine.state()['iterm']['poll_ms'], 250)

    def test_poll_ms_zero_in_demo(self):
        h = self.harness(demo=True)
        h.poll()
        self.assertEqual(h.engine.state()['iterm']['poll_ms'], 0)


class TestUsageAndQuota(EngineTestCase):
    def test_usage_ok_blocks(self):
        h = self.harness()
        h.poll()
        usage = h.engine.state()['usage']
        self.assertEqual(usage['claude']['status'], 'ok')
        self.assertEqual(usage['claude']['fetched_at'], h.p.clock.time())
        ids = [l['id'] for l in usage['claude']['limits']]
        self.assertEqual(ids, ['claude.five_hour', 'claude.seven_day', 'claude.monthly'])
        self.assertIsNone(usage['claude']['limits'][-1]['limit_display'])
        self.assertEqual([l['id'] for l in usage['codex']['limits']],
                         ['codex.five_hour', 'codex.seven_day'])

    def test_show_dollars_emits_usage(self):
        h = self.harness()
        h.poll()
        h.events()
        h.engine.patch_prefs({'show_dollars': True})
        events = h.events()
        usage = [e[2] for e in events if e[1] == 'usage']
        self.assertEqual(usage[0]['usage']['claude']['limits'][-1]['limit_display'], '$200')
        self.assertIn('prefs', [e[1] for e in events])

    def test_inactive_when_no_agent(self):
        h = self.harness()
        h.p.agents.ttys = {'/dev/ttys003': {'codex'}}
        h.poll()
        self.assertEqual(h.engine.state()['usage']['claude']['status'], 'inactive')
        self.assertEqual(h.p.usage_claude.fetches, 0)

    def test_stale_keeps_last_good(self):
        h = self.harness()
        h.poll()
        h.p.clock.advance(300)
        h.p.usage_claude.data = None
        h.poll()
        block = h.engine.state()['usage']['claude']
        self.assertEqual(block['status'], 'stale')
        self.assertEqual(block['stale_since'], h.p.clock.time())
        self.assertTrue(block['limits'])
        h.engine.refresh()      # a manual refresh refetches right away
        h.p.clock.advance(5)
        h.poll()
        self.assertEqual(h.p.usage_claude.fetches, 3)
        self.assertEqual(h.engine.state()['usage']['claude']['stale_since'],
                         h.p.clock.time() - 5)   # first failure time kept

    def test_sync_usage_fetch_interval_and_no_event_churn(self):
        h = self.harness()
        h.poll()
        h.events()
        for _ in range(3):
            h.p.clock.advance(60)
            h.poll()
        self.assertEqual(h.p.usage_claude.fetches, 1)
        self.assertEqual(h.named('usage'), [])
        h.p.agents.ttys = {}
        h.poll()
        h.poll()
        usage = h.named('usage')
        self.assertEqual(len(usage), 1)
        self.assertEqual(usage[0]['usage']['claude']['status'], 'inactive')

    def test_error_then_no_credentials(self):
        h = self.harness()
        gate = threading.Event()
        h.p.usage_claude.data = None
        h.p.usage_claude.has_credentials = lambda: gate.wait(5) and False
        h.poll()
        self.assertEqual(h.engine.state()['usage']['claude']['status'], 'error')
        gate.set()
        kind, payload = h.engine.events.get(timeout=5)   # the off-thread creds check
        self.assertEqual((kind, payload), ('__creds__', ('claude', False)))
        h.engine.events.put((kind, payload))
        h.engine.pump()
        self.assertEqual(h.engine.state()['usage']['claude']['status'], 'no_credentials')

    def test_credentials_check_skipped_without_provider_hook(self):
        h = self.harness()
        h.p.usage_codex = type('U', (), {'fetch': lambda self: (None, None)})()
        h.poll()
        self.assertEqual(h.engine.state()['usage']['codex']['status'], 'error')
        self.assertNotIn('codex', h.engine._creds_inflight)
        self.assertIsNone(h.engine.diagnostics()['codex_credentials'])

    def test_quota_prompt_once_then_draft(self):
        h = self.harness()
        h.poll()
        quota = h.named('quota')
        self.assertEqual(quota, [{'pct': 91.0, 'to': 'you@example.com'}])
        self.assertEqual(h.engine.state()['quota_prompt'], quota[0])
        h.poll()
        self.assertEqual(h.named('quota'), [])
        self.assertEqual(h.engine.quota_draft(), {'ok': True, 'opened': True})
        self.assertEqual(h.p.opener.calls,
                         [('open_url', 'https://mail.google.com/mail/?view=cm&to=you@example.com')])
        self.assertTrue(h.quota.notified)
        self.assertIsNone(h.engine.state()['quota_prompt'])
        states = h.named('state')
        self.assertEqual(len(states), 1)
        self.assertIsNone(states[0]['quota_prompt'])
        self.assertApiError(404, 'not_found', h.engine.quota_draft)

    def test_quota_skip(self):
        h = self.harness()
        h.poll()
        self.assertEqual(h.engine.quota_skip(), {'ok': True})
        self.assertTrue(h.quota.notified)
        self.assertApiError(404, 'not_found', h.engine.quota_skip)

    def test_quota_draft_without_url(self):
        quota = engine_mod.MemoryQuota()
        quota.draft_url = lambda: None
        h = self.harness(quota=quota)
        h.poll()
        self.assertEqual(h.engine.quota_draft(), {'ok': True, 'opened': False})
        self.assertEqual(h.p.opener.calls, [])

    def test_quota_pct_computed_and_ignored_cases(self):
        h = self.harness()
        e = h.engine
        e._check_quota({'extra_usage': {'is_enabled': False}})
        e._check_quota({'extra_usage': 'nope'})
        e._check_quota({'extra_usage': {'is_enabled': True, 'monthly_limit': 0,
                                        'used_credits': 5}})
        e._check_quota({'extra_usage': {'is_enabled': True, 'monthly_limit': 'x',
                                        'used_credits': 5}})
        self.assertIsNone(e.quota_prompt)
        e._check_quota({'extra_usage': {'is_enabled': True, 'monthly_limit': 100,
                                        'used_credits': 95}})
        self.assertEqual(e.quota_prompt['pct'], 95.0)

    def test_quota_below_threshold(self):
        h = self.harness(quota=engine_mod.MemoryQuota(threshold=95))
        h.poll()
        self.assertIsNone(h.engine.state()['quota_prompt'])


class TestCommands(EngineTestCase):
    def setUp(self):
        super().setUp()
        self.h = self.harness()
        self.h.poll()
        self.h.events()
        self.worker = self.h.pollers['iterm']

    def test_goto_and_action_mapping(self):
        r = self.h.engine.goto(fp.UID_CODEX)
        self.assertEqual(r, {'ok': True, 'action_id': 'a-1'})
        self.assertEqual(self.worker.requests, [('goto', fp.UID_CODEX)])
        self.h.engine.events.put(('action', ('goto', True, '')))
        self.h.engine.pump()
        self.assertEqual(self.h.named('action'), [
            {'id': 'a-1', 'kind': 'goto', 'uid': fp.UID_CODEX, 'ok': True, 'detail': '→ tab 2.1'}])
        self.assertApiError(404, 'not_found', self.h.engine.goto, 'nope')

    def test_action_failure_and_fifo(self):
        self.h.engine.goto(fp.UID_WAIT)
        self.h.engine.close(fp.UID_SHELL, {'confirm': True})
        self.h.engine.events.put(('action', ('goto', False, 'session not found')))
        self.h.engine.events.put(('action', ('close_uid', True, '')))
        self.h.engine.pump()
        actions = self.h.named('action')
        self.assertEqual([(a['id'], a['kind'], a['ok'], a['detail']) for a in actions],
                         [('a-1', 'goto', False, 'session not found'),
                          ('a-2', 'close', True, '')])

    def test_unmatched_action_event(self):
        self.h.engine.events.put(('action', ('new', True, '')))
        self.h.engine.pump()
        self.assertEqual(self.h.named('action'),
                         [{'id': None, 'kind': 'new_tab', 'uid': None, 'ok': True, 'detail': ''}])

    def test_iterm_unavailable(self):
        self.h.p.iterm.mode = 'not_running'
        self.h.poll()
        self.assertApiError(503, 'iterm_unavailable', self.h.engine.new_tab)
        engine = engine_mod.Engine(fp.default_world(), self.h.store, self.h.hub, pollers={})
        engine.sync_poll()
        self.assertApiError(503, 'iterm_unavailable', engine.new_tab)

    def test_close_requires_confirm(self):
        self.assertApiError(400, 'bad_request', self.h.engine.close, fp.UID_SHELL, {})
        self.assertApiError(404, 'not_found', self.h.engine.close, 'x', {'confirm': True})
        self.h.engine.close(fp.UID_SHELL, {'confirm': True})
        self.assertEqual(self.worker.requests, [('close_uid', fp.UID_SHELL)])

    def test_new_tab_probe(self):
        self.assertEqual(self.h.engine.new_tab()['action_id'], 'a-1')
        self.assertEqual(self.h.engine.probe_automation()['action_id'], 'a-2')
        self.assertEqual(self.worker.requests, [('new',), ('probe',)])
        self.h.engine.events.put(('action', ('new', True, '')))
        self.h.engine.pump()
        self.assertEqual(self.h.named('action')[0]['detail'], 'opening new tab…')

    def test_launch_runs_off_thread(self):
        r = self.h.engine.launch_iterm()
        item = self.h.engine.events.get(timeout=5)
        self.assertEqual(item, ('__action_done__', (r['action_id'], 'launch', None, True,
                                                    'launching iTerm2…')))
        self.assertEqual(self.h.p.iterm.calls, [('launch',)])
        self.assertEqual(self.worker.kicks, 1)
        self.h.engine.events.put(item)
        self.h.engine.pump()
        self.assertEqual(self.h.named('action')[0]['kind'], 'launch')

    def test_launch_failure(self):
        self.h.p.iterm.fail_actions = RuntimeError('open failed')
        self.h.engine.launch_iterm()
        item = self.h.engine.events.get(timeout=5)
        self.assertEqual(item[1][3:], (False, 'open failed'))

    def test_refresh_kicks_and_toasts(self):
        self.assertEqual(self.h.engine.refresh(), {'ok': True})
        self.assertEqual(self.worker.kicks, 1)
        self.assertEqual(self.h.pollers['agents'].kicks, 1)
        self.assertEqual(self.h.named('toast'), [{'level': 'info', 'message': 'refreshing…'}])

    def test_label(self):
        e = self.h.engine
        self.assertEqual(e.set_label(fp.UID_SHELL, {'label': '  deploy-fix  '}),
                         {'ok': True, 'label': 'deploy-fix'})
        s = self.h.session(fp.UID_SHELL)
        self.assertEqual((s['label'], s['display_name'], s['title']),
                         ('deploy-fix', 'deploy-fix', 'deploy-fix'))
        self.assertEqual(e.set_label(fp.UID_SHELL, {'label': 'ünïcødé ✓'})['label'], 'ünïcødé ✓')
        e.set_label(fp.UID_SHELL, {'label': ''})
        self.assertEqual(self.h.session(fp.UID_SHELL)['label'], '')
        self.assertApiError(400, 'bad_request', e.set_label, fp.UID_SHELL, {})
        self.assertApiError(400, 'bad_request', e.set_label, fp.UID_SHELL, {'label': 3})
        self.assertApiError(422, 'invalid', e.set_label, fp.UID_SHELL, {'label': 'x' * 81})
        self.assertApiError(422, 'invalid', e.set_label, fp.UID_SHELL, {'label': 'a\tb'})
        self.assertApiError(404, 'not_found', e.set_label, 'nope', {'label': 'x'})

    def test_mute(self):
        e = self.h.engine
        self.assertEqual(e.set_muted(fp.UID_WAIT, {'muted': True}), {'ok': True, 'muted': True})
        self.assertTrue(self.h.session(fp.UID_WAIT)['muted'])
        self.assertApiError(400, 'bad_request', e.set_muted, fp.UID_WAIT, {'muted': 'yes'})
        self.assertApiError(404, 'not_found', e.set_muted, 'nope', {'muted': True})

    def test_color(self):
        e = self.h.engine
        colors = self.h.pollers['colors']
        e.set_project(2, {'name': 'billing'})
        r = e.set_color(fp.UID_BUSY, {'project': 2})
        self.assertEqual(colors.requests, [(fp.UID_BUSY, 'purple')])
        details = [a['detail'] for a in self.h.named('action')]
        self.assertEqual(details, ['tab 1.2 → purple (billing)'])
        self.assertTrue(r['action_id'].startswith('a-'))
        e.set_color(fp.UID_BUSY, {'color': 'orange'})
        e.set_color(fp.UID_BUSY, {'color': None})
        self.assertEqual(colors.requests[1:], [(fp.UID_BUSY, 'orange'), (fp.UID_BUSY, None)])
        details = [a['detail'] for a in self.h.named('action')]
        self.assertEqual(details, ['tab 1.2 → orange', 'tab 1.2: color cleared'])
        self.assertApiError(400, 'bad_request', e.set_color, fp.UID_BUSY, {})
        self.assertApiError(400, 'bad_request', e.set_color, fp.UID_BUSY, {'project': True})
        self.assertApiError(422, 'invalid', e.set_color, fp.UID_BUSY, {'project': 6})
        self.assertApiError(400, 'bad_request', e.set_color, fp.UID_BUSY, {'color': 7})
        self.assertApiError(422, 'invalid', e.set_color, fp.UID_BUSY, {'color': 'mauve'})
        self.assertApiError(404, 'not_found', e.set_color, 'nope', {'color': 'red'})

    def test_color_unavailable(self):
        self.h.pollers['colors'].available = False
        self.h.engine.pump()
        self.assertFalse(self.h.engine.state()['capabilities']['tab_colors'])
        self.assertIn('capabilities', [e[1] for e in self.h.events()])
        self.assertApiError(503, 'tab_colors_unavailable', self.h.engine.set_color,
                            fp.UID_BUSY, {'color': 'red'})
        del self.h.pollers['colors']
        self.h.engine.colors_unavailable = False
        self.assertApiError(503, 'tab_colors_unavailable', self.h.engine.set_color,
                            fp.UID_BUSY, {'color': 'red'})

    def test_no_worker(self):
        del self.h.pollers['iterm']
        self.assertApiError(503, 'iterm_unavailable', self.h.engine.goto, fp.UID_WAIT)

    def test_projects(self):
        e = self.h.engine
        r = e.set_project(1, {'name': ' api '})
        self.assertEqual(r, {'ok': True, 'project': {'slot': 1, 'name': 'api', 'color': 'blue'}})
        prefs_events = self.h.named('prefs')
        self.assertEqual(prefs_events[0]['projects'][0]['name'], 'api')
        self.assertApiError(404, 'not_found', e.set_project, 0, {'name': 'x'})
        self.assertApiError(404, 'not_found', e.set_project, 6, {'name': 'x'})
        self.assertApiError(400, 'bad_request', e.set_project, 1, {})
        self.assertApiError(422, 'invalid', e.set_project, 1, {'name': 'x' * 81})
        self.assertApiError(400, 'bad_request', e.clear_projects, {})
        self.assertEqual(e.clear_projects({'confirm': True}), {'ok': True})
        self.assertEqual(self.h.engine.state()['projects'][0]['name'], '')


class TestReply(EngineTestCase):
    def setUp(self):
        super().setUp()
        self.h = self.harness()
        self.h.poll()
        self.hash = self.h.session(fp.UID_WAIT)['screen_hash']

    def body(self, **kw):
        b = {'text': '1', 'submit': False, 'expect_hash': self.hash}
        b.update(kw)
        return b

    def test_reply_accepted(self):
        r = self.h.engine.reply(fp.UID_WAIT, self.body())
        self.assertEqual(r['ok'], True)
        self.assertEqual(self.h.pollers['iterm'].requests, [('reply', fp.UID_WAIT, '1', False)])
        self.h.engine.reply(fp.UID_WAIT, self.body(text='fix it\nplease', submit=True,
                                                   expect_hash=self.hash.upper()))

    def test_validation(self):
        e = self.h.engine
        bad = [
            (400, 'bad_request', self.body(text=None)),
            (400, 'bad_request', self.body(submit='no')),
            (400, 'bad_request', self.body(expect_hash='')),
            (422, 'invalid', self.body(text='')),
            (422, 'invalid', self.body(text='x' * 2001)),
            (422, 'invalid', self.body(text='a\x1bb')),
        ]
        for status, code, body in bad:
            self.assertApiError(status, code, e.reply, fp.UID_WAIT, body)
        self.assertApiError(404, 'not_found', e.reply, 'nope', self.body())
        shell_hash = self.h.session(fp.UID_SHELL)['screen_hash']
        self.assertApiError(422, 'invalid', e.reply, fp.UID_SHELL, self.body(expect_hash=shell_hash))
        self.assertApiError(422, 'invalid', e.reply, fp.UID_BUSY, self.body())
        self.assertEqual(self.h.pollers['iterm'].requests, [])

    def test_stale_hash_409(self):
        self.assertApiError(409, 'stale_screen', self.h.engine.reply, fp.UID_WAIT,
                            self.body(expect_hash='deadbeef'))

    def test_old_snapshot_409(self):
        self.h.p.clock.advance(5.5)
        self.assertApiError(409, 'stale_screen', self.h.engine.reply, fp.UID_WAIT, self.body())

    def test_disabled_422(self):
        self.h.engine.patch_prefs({'quick_reply': False})
        self.assertFalse(self.h.engine.state()['capabilities']['reply'])
        self.assertApiError(422, 'invalid', self.h.engine.reply, fp.UID_WAIT, self.body())

    def test_iterm_error_503(self):
        self.h.p.iterm.mode = 'error'
        self.h.poll()
        self.assertApiError(503, 'iterm_unavailable', self.h.engine.reply, fp.UID_WAIT, self.body())


class TestPrefs(EngineTestCase):
    def test_patch_valid(self):
        h = self.harness()
        prefs = h.engine.patch_prefs({'view': 'grid', 'split_ratio': 0.456,
                                      'font_scale': 1, 'notifications': {'click': 'show'},
                                      'keep_on_top': True})
        self.assertEqual(prefs['view'], 'grid')
        self.assertEqual(prefs['split_ratio'], 0.46)
        self.assertEqual(prefs['font_scale'], 1.0)
        self.assertIsInstance(prefs['font_scale'], float)
        self.assertEqual(prefs['notifications'],
                         {'enabled': True, 'click': 'show', 'stall': True})
        self.assertEqual(h.engine.prefs(), prefs)
        ev = h.named('prefs')
        self.assertEqual(ev[0]['prefs'], prefs)
        self.assertEqual(len(ev[0]['projects']), 5)

    def test_patch_theme_high_contrast(self):
        h = self.harness()
        prefs = h.engine.patch_prefs({'theme': 'high-contrast'})
        self.assertEqual(prefs['theme'], 'high-contrast')

    def test_patch_notifications_stall(self):
        h = self.harness()
        prefs = h.engine.patch_prefs({'notifications': {'stall': False}})
        self.assertEqual(prefs['notifications'],
                         {'enabled': True, 'click': 'goto', 'stall': False})
        self.assertApiError(422, 'invalid', h.engine.patch_prefs,
                            {'notifications': {'stall': 'no'}})

    def test_patch_invalid_is_atomic(self):
        h = self.harness()
        cases = [{'bogus': 1}, {'view': 'tiles'}, {'sound': 1}, {'split_ratio': 0.9},
                 {'split_ratio': True}, {'notifications': {'enabled': 'y'}},
                 {'notifications': {'x': True}}, {'notifications': []},
                 {'sound': True, 'theme': 'neon'}]
        for body in cases:
            self.assertApiError(422, 'invalid', h.engine.patch_prefs, body)
        self.assertFalse(h.engine.prefs()['sound'])

    def test_patch_empty(self):
        h = self.harness()
        self.assertEqual(h.engine.patch_prefs({}), h.engine.prefs())
        self.assertEqual(h.named('prefs'), [])

    def test_prefs_persist(self):
        h = self.harness()
        h.engine.patch_prefs({'theme': 'dark'})
        h.engine.stop()
        store = persist.StateStore(path=h.store.path)
        self.assertEqual(store.get('theme'), 'dark')

    def test_clean_text(self):
        self.assertEqual(engine_mod.clean_text('a\nb', 't', 10, allow_newline=True), 'a\nb')
        with self.assertRaises(ApiError):
            engine_mod.clean_text('a\nb', 't', 10)


class TestSyncMode(EngineTestCase):
    """Demo mode: providers driven on the engine thread; no pollers."""

    def test_sync_actions_run_provider_and_repoll(self):
        h = self.harness(sync=True)
        h.poll()
        e = h.engine
        e.goto(fp.UID_WAIT)
        e.close(fp.UID_SHELL, {'confirm': True})
        e.reply(fp.UID_WAIT, {'text': '1', 'expect_hash': h.session(fp.UID_WAIT)['screen_hash']})
        e.new_tab()
        e.probe_automation()
        e.launch_iterm()
        e.pump()
        h.p.iterm.action_result = False
        e.goto(fp.UID_WAIT)
        e.pump()
        calls = [c[0] for c in h.p.iterm.calls]
        self.assertEqual(calls, ['goto', 'close_uid', 'reply', 'new_tab', 'probe', 'launch', 'goto'])
        actions = h.named('action')
        self.assertEqual([(a['kind'], a['ok']) for a in actions],
                         [('goto', True), ('close', True), ('reply', True), ('new_tab', True),
                          ('probe', True), ('launch', True), ('goto', False)])
        self.assertEqual(actions[-1]['detail'], 'session not found')
        self.assertIsNone(h.session(fp.UID_SHELL))   # re-polled after close

    def test_sync_action_exception(self):
        h = self.harness(sync=True)
        h.poll()
        h.p.iterm.fail_actions = RuntimeError('kaput')
        h.engine.new_tab()
        h.engine.pump()
        self.assertEqual(h.named('action')[0]['detail'], 'kaput')

    def test_sync_colors_and_refresh(self):
        h = self.harness(sync=True)
        h.poll()
        h.engine.set_color(fp.UID_SHELL, {'color': 'red'})
        h.engine.pump()
        self.assertEqual(h.p.colors.sets, [(fp.UID_SHELL, 'red')])
        self.assertEqual(h.session(fp.UID_SHELL)['tab_color'], 'red')
        h.engine.refresh()
        h.engine.pump()
        h.p.colors.unavailable = True
        h.engine.set_color(fp.UID_SHELL, {'color': 'blue'})
        h.engine.pump()
        self.assertFalse(h.engine.state()['capabilities']['tab_colors'])
        self.assertTrue(h.engine.colors_unavailable)

    def test_sync_colors_other_failure_ignored(self):
        h = self.harness(sync=True)
        h.poll()
        h.p.colors.set = lambda uid, name: 1 / 0
        h.p.colors.fetch = lambda: 1 / 0
        h.engine.set_color(fp.UID_SHELL, {'color': 'red'})
        h.engine.pump()
        self.assertEqual(h.session(fp.UID_SHELL)['tab_color'], None)

    def test_sync_poll_colors_unavailable(self):
        h = self.harness(sync=True)
        h.p.colors.unavailable = True
        h.poll()
        self.assertTrue(h.engine.colors_unavailable)

    def test_autostep(self):
        p = fp.make_providers()
        h = self.harness(providers=p, sync=True, autostep=0.0, demo=True)
        h.engine._housekeeping()
        self.assertEqual(len(p.demo.steps), 1)
        self.assertEqual(h.engine.state()['iterm']['status'], 'connecting')
        h.engine.pump()
        self.assertEqual(h.engine.state()['iterm']['status'], 'ok')


class TestDemo(EngineTestCase):
    def demo_harness(self, **kw):
        p = fp.make_providers('default', frozen_clock=1_800_000_000.0)
        opts = {'scenarios': fp.SCENARIOS, 'factory_kwargs': {'seed': 0, 'frozen_clock': 1_800_000_000.0}}
        return self.harness(providers=p, sync=True, demo=True, demo_factory=fp.make_providers,
                            demo_options=opts, **kw)

    def test_step_publishes_debounced_transition(self):
        h = self.demo_harness()
        h.poll()
        h.events()
        r = h.engine.demo_step({'seconds': 6})
        self.assertEqual(r['seq'], h.engine.seq)
        self.assertEqual(h.p.clock.time(), 1_800_000_006.0)
        tr = [t for t in h.named('transition') if t['to'] == 'waiting']
        self.assertEqual([t['uid'] for t in tr], [fp.UID_BUSY])

    def test_step_validation(self):
        h = self.demo_harness()
        self.assertApiError(400, 'bad_request', h.engine.demo_step, {'seconds': 'x'})
        self.assertApiError(422, 'invalid', h.engine.demo_step, {'seconds': -1})
        self.assertEqual(h.engine.demo_step({})['ok'], True)

    def test_not_demo(self):
        h = self.harness()
        self.assertApiError(404, 'not_found', h.engine.demo_step, {'seconds': 1})
        self.assertApiError(404, 'not_found', h.engine.demo_scenario, {'name': 'empty'})

    def test_scenario_reset(self):
        h = self.demo_harness()
        h.poll()
        h.events()
        r = h.engine.demo_scenario({'name': 'empty'})
        self.assertEqual(r['scenario'], 'empty')
        states = h.named('state')
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]['sessions'], [])
        self.assertEqual(h.engine.state()['iterm']['status'], 'ok')
        h.engine.demo_scenario({'name': 'default'})
        self.assertEqual(len(h.engine.state()['sessions']), 4)
        self.assertEqual(h.session(fp.UID_WAIT)['label'], 'refactor')   # seed re-applied
        self.assertApiError(422, 'invalid', h.engine.demo_scenario, {'name': 'nope'})
        self.assertApiError(400, 'bad_request', h.engine.demo_scenario, {'name': 3})

    def test_seed_state(self):
        h = self.demo_harness()
        engine_mod.apply_seed_state(h.store, h.p.demo)
        h.poll()
        self.assertEqual(h.session(fp.UID_WAIT)['label'], 'refactor')
        self.assertTrue(h.session(fp.UID_CODEX)['muted'])
        self.assertEqual(h.engine.state()['projects'][0]['name'], 'api')
        self.assertTrue(h.engine.prefs()['sound'])

    def test_seed_state_edge_cases(self):
        h = self.harness()
        engine_mod.apply_seed_state(h.store, None)
        engine_mod.apply_seed_state(h.store, object())
        demo = type('D', (), {'initial_state': lambda self: {'labels': {'u': 'x', 1: 'y'},
                                                             'prefs': {'view': 'bad', 'grid_all': True}}})()
        engine_mod.apply_seed_state(h.store, demo)
        self.assertEqual(h.store.label('u'), 'x')
        self.assertEqual(h.store.get('view'), 'split')
        self.assertTrue(h.store.get('grid_all'))


class TestThreadedCalls(EngineTestCase):
    def test_commands_via_engine_thread(self):
        h = self.harness(tick=0.05)
        h.engine.start()
        try:
            self.assertTrue(h.engine.running)
            h.engine.events.put(('agents', h.engine.agents_snap))
            h.engine.call(h.engine.sync_poll)
            self.assertEqual(h.engine.visit(fp.UID_WAIT), {'ok': True})
            with self.assertRaises(ApiError):
                h.engine.visit('nope')
            with self.assertRaises(ApiError) as cm:
                h.engine.call(time.sleep, 0.5, timeout=0.05)
            self.assertEqual(cm.exception.status, 503)
        finally:
            h.engine.stop()
        self.assertFalse(h.engine.running)

    def test_start_launches_real_pollers(self):
        started = {}

        def fake_start(events, stop, providers):
            started['called'] = True
            return {'iterm': RecWorker()}, None
        from omniwatch import pollers
        orig = pollers.start_pollers
        pollers.start_pollers = fake_start
        try:
            h = Harness(self.tmp_config_dir, pollers=None, sync=False)
            h.engine._start_pollers = True
            h.engine.start()
            h.engine.stop()
        finally:
            pollers.start_pollers = orig
        self.assertTrue(started['called'])

    def test_cancelled_future_is_skipped(self):
        import concurrent.futures
        h = self.harness()
        fut = concurrent.futures.Future()
        fut.cancel()
        h.engine.events.put(('__cmd__', (lambda: 1 / 0, (), fut)))
        h.engine.pump()


class TestReads(EngineTestCase):
    def test_summary_endpoint(self):
        h = self.harness()
        h.poll()
        s = h.engine.summary()
        self.assertEqual(s['waiting'], 2)
        self.assertEqual([w['uid'] for w in s['waiting_sessions']], [fp.UID_WAIT, fp.UID_CODEX])
        self.assertEqual(s['waiting_sessions'][0]['title'], '~/src/api')

    def test_diagnostics(self):
        h = self.harness(config_dir='/cfg', log_path='/log')
        h.poll()
        d = h.engine.diagnostics()
        self.assertEqual(d['automation'], 'ok')
        self.assertEqual(d['iterm'], {'status': 'ok', 'error': ''})
        self.assertTrue(d['claude_credentials'])
        self.assertEqual((d['config_dir'], d['log_path']), ('/cfg', '/log'))
        self.assertIsInstance(d['tab_colors']['package'], bool)
        self.assertTrue(d['tab_colors']['reachable'])
        self.assertEqual(d['python']['path'], sys.executable)

    def test_colors_event(self):
        h = self.harness()
        h.poll()
        h.engine.events.put(('colors', ColorsSnapshot(colors=((fp.UID_SHELL, 'green'),))))
        h.engine.events.put(('usage_claude', UsageSnapshot(inactive=True)))
        h.engine.events.put(('__wake__', None))
        h.engine.pump()
        self.assertEqual(h.session(fp.UID_SHELL)['project'], 3)
        self.assertEqual(h.engine.state()['usage']['claude']['status'], 'inactive')


if __name__ == '__main__':
    unittest.main()
