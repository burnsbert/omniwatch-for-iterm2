import os
import sys
import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import usage_claude, usage_codex

NOW_LOCAL = datetime(2026, 6, 9, 12, 0)
NOW_UTC = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)


def claude_payload(extra=None):
    payload = {
        'five_hour': {'utilization': 42.0,
                      'resets_at': '2026-06-09T17:00:00+00:00'},
        'seven_day': {'utilization': 10.0,
                      'resets_at': '2026-06-12T00:00:00+00:00'},
    }
    if extra is not None:
        payload['extra_usage'] = extra
    return payload


def codex_payload(primary=True, secondary=True, **overrides):
    rate_limit = {}
    if primary:
        rate_limit['primary_window'] = {
            'used_percent': overrides.get('primary_pct', 42.0),
            'reset_at': int(NOW_UTC.timestamp()) + 3600,
            'limit_window_seconds': 18000,
        }
    if secondary:
        rate_limit['secondary_window'] = {
            'used_percent': overrides.get('secondary_pct', 12.0),
            'reset_at': int(NOW_UTC.timestamp()) + 3 * 86400,
            'limit_window_seconds': 604800,
        }
    return {'rate_limit': rate_limit}


class TestFormatDollarLimit(TripwireTestCase):
    def test_whole_dollars(self):
        self.assertEqual(usage_claude.format_dollar_limit(30000), '$300')

    def test_cents(self):
        self.assertEqual(usage_claude.format_dollar_limit(12345), '$123.45')

    def test_invalid(self):
        self.assertEqual(usage_claude.format_dollar_limit(None), '')
        self.assertEqual(usage_claude.format_dollar_limit('abc'), '')


class TestClaudeExtraUsageRow(TripwireTestCase):
    def test_none_usage(self):
        self.assertIsNone(usage_claude.claude_extra_usage_row(None,
                                                              now=NOW_LOCAL))

    def test_missing_extra_usage(self):
        self.assertIsNone(
            usage_claude.claude_extra_usage_row(claude_payload(),
                                                now=NOW_LOCAL))

    def test_disabled_extra_usage(self):
        usage = claude_payload({'is_enabled': False, 'used_credits': 100,
                                'monthly_limit': 30000})
        self.assertIsNone(usage_claude.claude_extra_usage_row(usage,
                                                              now=NOW_LOCAL))

    def test_pct_computed_from_used_and_limit(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 15000,
                                'monthly_limit': 30000})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['pct'], 50.0)
        self.assertEqual(row['label'], 'CC Monthly Limit')
        self.assertFalse(row['hit'])

    def test_utilization_takes_precedence(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 15000,
                                'monthly_limit': 30000, 'utilization': 51.5})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['pct'], 51.5)

    def test_dollar_detail_hidden_by_default(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 100,
                                'monthly_limit': 30000, 'utilization': 1.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertNotIn('limit $', row['detail'])
        self.assertIn('resets in 21d 12h', row['detail'])

    def test_dollar_detail_shown_when_requested(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 100,
                                'monthly_limit': 30000, 'utilization': 1.0})
        row = usage_claude.claude_extra_usage_row(usage, show_dollar_limit=True,
                                                  now=NOW_LOCAL)
        self.assertIn('limit $300', row['detail'])
        self.assertIn('resets in 21d 12h', row['detail'])

    def test_no_limit_extra_usage_label(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 500,
                                'utilization': 12.5})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['label'], 'CC Extra Usage ')
        self.assertEqual(row['detail'], '')
        self.assertEqual(row['pct'], 12.5)
        self.assertFalse(row['hit'])
        self.assertIsNone(row['projection'])  # no limit -> no projection

    def test_hit_and_projection(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 31500,
                                'monthly_limit': 30000, 'utilization': 105.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertTrue(row['hit'])
        self.assertEqual(row['projection'], ('  ⚠ monthly limit hit', True))

    def test_on_pace_projection(self):
        # June 9 noon: ~28% of June elapsed, 80% used -> on pace warning
        usage = claude_payload({'is_enabled': True, 'used_credits': 24000,
                                'monthly_limit': 30000, 'utilization': 80.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertIsNotNone(row['projection'])
        self.assertIn('on pace to hit monthly limit', row['projection'][0])


class TestCodexUsageRows(TripwireTestCase):
    def test_both_windows(self):
        rows = usage_codex.codex_usage_rows(codex_payload(), now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows],
                         ['CX 5h Limit', 'CX 7d Limit'])
        self.assertEqual(rows[0]['pct'], 42.0)
        self.assertTrue(rows[0]['reset'].startswith('1h 0m ('))
        self.assertTrue(rows[1]['reset'].startswith('3d 0h ('))
        self.assertFalse(rows[0]['hit'])
        self.assertFalse(rows[1]['hit'])

    def test_missing_secondary_window(self):
        rows = usage_codex.codex_usage_rows(codex_payload(secondary=False),
                                            now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 5h Limit'])

    def test_primary_weekly_window_is_labeled_by_duration(self):
        usage = codex_payload(secondary=False)
        usage['rate_limit']['primary_window']['limit_window_seconds'] = 604800
        rows = usage_codex.codex_usage_rows(usage, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_session_window_fills_missing_api_window(self):
        usage = codex_payload(primary=False)
        five_hour = {
            18000: {'used_percent': 7.0,
                    'reset_at': int(NOW_UTC.timestamp()) + 3600,
                    'limit_window_seconds': 18000},
        }
        merged = usage_codex.merge_session_rate_limits(usage, five_hour)
        rows = usage_codex.codex_usage_rows(merged, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows],
                         ['CX 5h Limit', 'CX 7d Limit'])
        self.assertEqual([r['pct'] for r in rows], [7.0, 12.0])

    def test_missing_session_window_is_hidden(self):
        usage = codex_payload(primary=False)
        merged = usage_codex.merge_session_rate_limits(usage, {})
        rows = usage_codex.codex_usage_rows(merged, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_reads_both_windows_across_recent_session_logs(self):
        now = NOW_UTC.timestamp()
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            weekly = os.path.join(day, 'weekly.jsonl')
            both = os.path.join(day, 'both.jsonl')
            payloads = [
                (weekly, {'primary': {'used_percent': 12,
                                      'window_minutes': 10080,
                                      'resets_at': now + 86400},
                          'secondary': None}),
                (both, {'primary': {'used_percent': 7,
                                    'window_minutes': 300,
                                    'resets_at': now + 3600},
                        'secondary': {'used_percent': 11,
                                      'window_minutes': 10080,
                                      'resets_at': now + 86400}}),
            ]
            for index, (path, limits) in enumerate(payloads):
                with open(path, 'w') as f:
                    f.write(json.dumps({'payload': {
                        'rate_limits': limits}}) + '\n')
                os.utime(path, (now - index, now - index))
            windows = usage_codex.session_rate_limit_windows(root, now=now)
        self.assertEqual(windows[18000]['used_percent'], 7)
        self.assertEqual(windows[604800]['used_percent'], 12)

    def test_none_used_percent_skipped(self):
        rows = usage_codex.codex_usage_rows(
            codex_payload(primary_pct=None), now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_hit_flag_at_100(self):
        rows = usage_codex.codex_usage_rows(
            codex_payload(primary_pct=100.0), now=NOW_UTC)
        self.assertTrue(rows[0]['hit'])
        self.assertEqual(rows[0]['projection'],
                         ('  ⚠ Codex 5h limit hit', True))

    def test_none_usage(self):
        self.assertEqual(usage_codex.codex_usage_rows(None, now=NOW_UTC), [])

    def test_missing_rate_limit(self):
        self.assertEqual(usage_codex.codex_usage_rows({}, now=NOW_UTC), [])


class TestClaudeLimits(TripwireTestCase):
    """New (docs/DESIGN.md §4.2/§4.4.1): structured Limit rows."""

    def test_empty_usage(self):
        self.assertEqual(usage_claude.limits(None, now=NOW_UTC), [])
        self.assertEqual(usage_claude.limits({}, now=NOW_UTC), [])

    def test_rolling_windows_shape(self):
        rows = usage_claude.limits(claude_payload(), now=NOW_UTC)
        self.assertEqual([r['id'] for r in rows],
                         ['claude.five_hour', 'claude.seven_day'])
        five_hour = rows[0]
        self.assertEqual(five_hour['label'], 'Session')
        self.assertEqual(five_hour['window'], '5h')
        self.assertEqual(five_hour['pct'], 42.0)
        self.assertEqual(five_hour['level'], 'green')
        self.assertIsInstance(five_hour['resets_at'], int)
        self.assertIn('(', five_hour['reset_text'])

    def test_monthly_row_has_cap_and_dollar_gating(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 27000,
                                'monthly_limit': 30000, 'utilization': 90.0})
        hidden = usage_claude.limits(usage, show_dollars=False, now=NOW_UTC)
        shown = usage_claude.limits(usage, show_dollars=True, now=NOW_UTC)
        monthly_hidden = next(r for r in hidden if r['id'] == 'claude.monthly')
        monthly_shown = next(r for r in shown if r['id'] == 'claude.monthly')
        self.assertEqual(monthly_hidden['label'], 'Monthly cap')
        self.assertTrue(monthly_hidden['has_cap'])
        self.assertIsNone(monthly_hidden['limit_display'])
        self.assertEqual(monthly_shown['limit_display'], '$300')
        self.assertEqual(monthly_hidden['level'], 'red')

    def test_monthly_row_without_cap_is_extra_usage(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 500,
                                'utilization': 12.5})
        rows = usage_claude.limits(usage, now=NOW_UTC)
        monthly = next(r for r in rows if r['id'] == 'claude.monthly')
        self.assertEqual(monthly['label'], 'Extra usage')
        self.assertFalse(monthly['has_cap'])
        self.assertIsNone(monthly['limit_display'])

    def test_no_extra_usage_key_omits_monthly_row(self):
        rows = usage_claude.limits(claude_payload(), now=NOW_UTC)
        self.assertFalse(any(r['id'] == 'claude.monthly' for r in rows))

    def test_projection_is_structured(self):
        usage = claude_payload()
        usage['five_hour']['utilization'] = 95.0
        # 4h elapsed of the 5h window (1h left) — well over pace at 95%.
        usage['five_hour']['resets_at'] = '2026-06-09T13:00:00+00:00'
        rows = usage_claude.limits(usage, now=NOW_UTC)
        five_hour = next(r for r in rows if r['id'] == 'claude.five_hour')
        self.assertIsNotNone(five_hour['projection'])
        self.assertIn(five_hour['projection']['kind'], ('hit', 'pace'))
        self.assertIn('text', five_hour['projection'])


class TestCodexLimits(TripwireTestCase):
    """New (docs/DESIGN.md §4.2/§4.4.1): structured Limit rows."""

    def test_empty_usage(self):
        self.assertEqual(usage_codex.limits(None, now=NOW_UTC), [])
        self.assertEqual(usage_codex.limits({}, now=NOW_UTC), [])

    def test_both_windows_shape(self):
        rows = usage_codex.limits(codex_payload(), now=NOW_UTC)
        self.assertEqual([r['id'] for r in rows],
                         ['codex.five_hour', 'codex.seven_day'])
        self.assertEqual([r['label'] for r in rows], ['Session', 'Weekly'])
        self.assertEqual([r['window'] for r in rows], ['5h', '7d'])
        self.assertEqual(rows[0]['pct'], 42.0)
        self.assertEqual(rows[0]['level'], 'green')
        self.assertIsInstance(rows[0]['resets_at'], int)

    def test_hit_projection_structured(self):
        rows = usage_codex.limits(codex_payload(primary_pct=100.0), now=NOW_UTC)
        five_hour = next(r for r in rows if r['id'] == 'codex.five_hour')
        self.assertEqual(five_hour['projection'],
                         {'kind': 'hit', 'at': None,
                          'text': 'Codex 5h limit hit'})

    def test_missing_percent_skipped(self):
        rows = usage_codex.limits(codex_payload(primary_pct=None), now=NOW_UTC)
        self.assertEqual([r['id'] for r in rows], ['codex.seven_day'])


class TestGetOauthToken(TripwireTestCase):
    """Exercises the Keychain path with a mocked subprocess.run — no real
    `security` call (the tripwire would fail this test otherwise)."""

    def test_success(self):
        creds = json.dumps({'claudeAiOauth': {'accessToken': 'tok-123'}})
        result = mock.Mock(returncode=0, stdout=creds)
        with mock.patch('subprocess.run', return_value=result):
            self.assertEqual(usage_claude.get_oauth_token(), 'tok-123')

    def test_nonzero_returncode_is_none(self):
        with mock.patch('subprocess.run',
                        return_value=mock.Mock(returncode=1, stdout='')):
            self.assertIsNone(usage_claude.get_oauth_token())

    def test_malformed_json_is_none(self):
        with mock.patch('subprocess.run',
                        return_value=mock.Mock(returncode=0, stdout='{not json')):
            self.assertIsNone(usage_claude.get_oauth_token())

    def test_subprocess_failure_is_none(self):
        with mock.patch('subprocess.run', side_effect=OSError('no security')):
            self.assertIsNone(usage_claude.get_oauth_token())


class TestFetchUsage(TripwireTestCase):
    """Exercises the HTTP fetch path with a mocked urlopen — no real
    network call."""

    def test_no_token_short_circuits(self):
        with mock.patch.object(usage_claude, 'get_oauth_token',
                               return_value=None):
            self.assertEqual(usage_claude.fetch_usage(), (None, None))

    def test_success_parses_json(self):
        payload = json.dumps({'five_hour': {'utilization': 10}}).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = payload
        with mock.patch.object(usage_claude, 'get_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', return_value=cm):
            data, retry = usage_claude.fetch_usage()
        self.assertEqual(data, {'five_hour': {'utilization': 10}})
        self.assertIsNone(retry)

    def test_http_error_with_retry_after(self):
        import urllib.error
        err = urllib.error.HTTPError(
            'url', 429, 'Too Many Requests',
            {'Retry-After': '30'}, None)
        with mock.patch.object(usage_claude, 'get_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', side_effect=err):
            data, retry = usage_claude.fetch_usage()
        self.assertIsNone(data)
        self.assertEqual(retry, 30)

    def test_http_error_without_retry_after(self):
        import urllib.error
        err = urllib.error.HTTPError('url', 500, 'Server Error', {}, None)
        with mock.patch.object(usage_claude, 'get_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', side_effect=err):
            data, retry = usage_claude.fetch_usage()
        self.assertIsNone(data)
        self.assertIsNone(retry)

    def test_generic_failure(self):
        with mock.patch.object(usage_claude, 'get_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', side_effect=OSError('down')):
            self.assertEqual(usage_claude.fetch_usage(), (None, None))


class TestUsageClaudeEdgeCases(TripwireTestCase):
    """New: exercise the invalid-pct exception branches in
    claude_extra_usage_row() and limits()."""

    def test_extra_usage_row_non_numeric_used_credits_falls_back_to_zero(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 'oops',
                                'monthly_limit': 30000})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['pct'], 0)

    def test_limits_malformed_resets_at_yields_no_epoch(self):
        usage = claude_payload()
        usage['five_hour']['resets_at'] = 'not-a-date'
        rows = usage_claude.limits(usage, now=NOW_UTC)
        five_hour = next(r for r in rows if r['id'] == 'claude.five_hour')
        self.assertIsNone(five_hour['resets_at'])
        self.assertEqual(five_hour['reset_text'], '')

    def test_limits_extra_usage_non_numeric_used_credits_falls_back_to_zero(self):
        usage = claude_payload({'is_enabled': True, 'used_credits': 'oops',
                                'monthly_limit': 30000})
        rows = usage_claude.limits(usage, now=NOW_UTC)
        monthly = next(r for r in rows if r['id'] == 'claude.monthly')
        self.assertEqual(monthly['pct'], 0)


class TestGetCodexOauthToken(TripwireTestCase):
    def test_reads_access_token_from_auth_json(self):
        with tempfile.TemporaryDirectory() as home:
            codex_dir = os.path.join(home, '.codex')
            os.makedirs(codex_dir)
            with open(os.path.join(codex_dir, 'auth.json'), 'w') as f:
                json.dump({'tokens': {'access_token': 'cx-tok'}}, f)
            with mock.patch.object(usage_codex.config, 'HOME', home):
                self.assertEqual(usage_codex.get_codex_oauth_token(), 'cx-tok')

    def test_missing_file_is_none(self):
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.object(usage_codex.config, 'HOME', home):
                self.assertIsNone(usage_codex.get_codex_oauth_token())


class TestFetchCodexUsage(TripwireTestCase):
    def test_no_token_short_circuits(self):
        with mock.patch.object(usage_codex, 'get_codex_oauth_token',
                               return_value=None):
            self.assertEqual(usage_codex.fetch_codex_usage(), (None, None))

    def test_success_merges_session_rate_limits(self):
        payload = json.dumps({'rate_limit': {}}).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = payload
        with mock.patch.object(usage_codex, 'get_codex_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', return_value=cm), \
             mock.patch.object(usage_codex, 'merge_session_rate_limits',
                               return_value={'merged': True}) as merge:
            data, retry = usage_codex.fetch_codex_usage()
        self.assertEqual(data, {'merged': True})
        self.assertIsNone(retry)
        merge.assert_called_once()

    def test_http_error_with_retry_after(self):
        import urllib.error
        err = urllib.error.HTTPError('url', 429, 'Too Many Requests',
                                     {'Retry-After': '15'}, None)
        with mock.patch.object(usage_codex, 'get_codex_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', side_effect=err):
            data, retry = usage_codex.fetch_codex_usage()
        self.assertIsNone(data)
        self.assertEqual(retry, 15)

    def test_generic_failure(self):
        with mock.patch.object(usage_codex, 'get_codex_oauth_token',
                               return_value='tok'), \
             mock.patch('urllib.request.urlopen', side_effect=OSError('down')):
            self.assertEqual(usage_codex.fetch_codex_usage(), (None, None))


class TestSessionRateLimitWindowsEdgeCases(TripwireTestCase):
    def test_no_matching_files_returns_empty(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(
                usage_codex.session_rate_limit_windows(root, now=NOW_UTC.timestamp()),
                {})

    def test_unreadable_log_is_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            path = os.path.join(day, 'broken.jsonl')
            with open(path, 'w') as f:
                f.write('not json at all\n')
            windows = usage_codex.session_rate_limit_windows(
                root, now=NOW_UTC.timestamp())
        self.assertEqual(windows, {})

    def test_reset_at_in_past_is_skipped(self):
        now = NOW_UTC.timestamp()
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            path = os.path.join(day, 'stale.jsonl')
            with open(path, 'w') as f:
                f.write(json.dumps({'payload': {'rate_limits': {
                    'primary': {'used_percent': 50, 'window_minutes': 300,
                               'resets_at': now - 10}}}}) + '\n')
            windows = usage_codex.session_rate_limit_windows(root, now=now)
        self.assertEqual(windows, {})


if __name__ == '__main__':
    unittest.main()
