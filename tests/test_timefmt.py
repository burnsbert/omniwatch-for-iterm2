import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import timefmt

# Tuesday, June 9 2026
NOW_LOCAL = datetime(2026, 6, 9, 10, 0)
NOW_UTC = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)


class TestParseIso(TripwireTestCase):
    def test_offset_with_colon(self):
        dt = timefmt.parse_iso('2026-06-09T12:30:00+00:00')
        self.assertEqual(dt.year, 2026)
        self.assertEqual(dt.utcoffset(), timedelta(0))

    def test_offset_without_colon(self):
        dt = timefmt.parse_iso('2026-06-09T12:30:00+0530')
        self.assertEqual(dt.utcoffset(), timedelta(hours=5, minutes=30))

    def test_fractional_seconds(self):
        dt = timefmt.parse_iso('2026-06-09T12:30:00.123456+00:00')
        self.assertEqual(dt.microsecond, 123456)

    def test_naive(self):
        dt = timefmt.parse_iso('2026-06-09T12:30:00')
        self.assertIsNone(dt.tzinfo)


class TestFormatAbsTime(TripwireTestCase):
    def test_today(self):
        dt = datetime(2026, 6, 9, 14, 59)
        self.assertEqual(timefmt.format_abs_time(dt, now=NOW_LOCAL),
                         'Today at 2:59pm')

    def test_tomorrow(self):
        dt = datetime(2026, 6, 10, 11, 59)
        self.assertEqual(timefmt.format_abs_time(dt, now=NOW_LOCAL),
                         'Tomorrow at 11:59am')

    def test_weekday_within_week(self):
        dt = datetime(2026, 6, 12, 9, 5)  # Friday
        self.assertEqual(timefmt.format_abs_time(dt, now=NOW_LOCAL),
                         'Friday at 9:05am')

    def test_far_date(self):
        dt = datetime(2026, 6, 20, 0, 1)
        self.assertEqual(timefmt.format_abs_time(dt, now=NOW_LOCAL),
                         'Jun 20 at 12:01am')


class TestFormatResetTime(TripwireTestCase):
    def test_hours_minutes(self):
        iso = (NOW_UTC + timedelta(hours=2, minutes=15, seconds=30)).isoformat()
        result = timefmt.format_reset_time(iso, now=NOW_UTC)
        self.assertTrue(result.startswith('2h 15m ('), result)
        self.assertTrue(result.endswith(')'), result)

    def test_days_hours(self):
        iso = (NOW_UTC + timedelta(days=5, hours=3, minutes=5)).isoformat()
        result = timefmt.format_reset_time(iso, now=NOW_UTC)
        self.assertTrue(result.startswith('5d 3h ('), result)

    def test_minutes_only(self):
        iso = (NOW_UTC + timedelta(minutes=42, seconds=10)).isoformat()
        result = timefmt.format_reset_time(iso, now=NOW_UTC)
        self.assertTrue(result.startswith('42m ('), result)

    def test_past_is_now(self):
        iso = (NOW_UTC - timedelta(minutes=1)).isoformat()
        self.assertEqual(timefmt.format_reset_time(iso, now=NOW_UTC), 'now')

    def test_empty(self):
        self.assertEqual(timefmt.format_reset_time('', now=NOW_UTC), '')


class TestFormatEpochResetTime(TripwireTestCase):
    def test_hours_minutes(self):
        epoch = int(NOW_UTC.timestamp()) + 3600 + 120
        result = timefmt.format_epoch_reset_time(epoch, now=NOW_UTC)
        self.assertTrue(result.startswith('1h 2m ('), result)

    def test_past_is_now(self):
        epoch = int(NOW_UTC.timestamp()) - 60
        self.assertEqual(timefmt.format_epoch_reset_time(epoch, now=NOW_UTC),
                         'now')

    def test_empty(self):
        self.assertEqual(timefmt.format_epoch_reset_time(None, now=NOW_UTC), '')


class TestFormatResetDelta(TripwireTestCase):
    def test_days_hours(self):
        reset = datetime(2026, 7, 1, 0, 0)
        result = timefmt.format_reset_delta(reset, now=NOW_LOCAL)
        self.assertTrue(result.startswith('21d 14h ('), result)

    def test_past_is_now(self):
        reset = NOW_LOCAL - timedelta(seconds=5)
        self.assertEqual(timefmt.format_reset_delta(reset, now=NOW_LOCAL), 'now')


class TestNextMonthStart(TripwireTestCase):
    def test_mid_year(self):
        self.assertEqual(timefmt.next_month_start(datetime(2026, 6, 15, 13, 30)),
                         datetime(2026, 7, 1))

    def test_december_rollover(self):
        self.assertEqual(timefmt.next_month_start(datetime(2026, 12, 31, 23, 59)),
                         datetime(2027, 1, 1))


if __name__ == '__main__':
    unittest.main()
