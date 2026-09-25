"""New module (docs/DESIGN.md §4.2): curses-free text helpers, ported
from the non-curses parts of ultrawatch_lib/ui/draw.py and shared with
web/js/preview.js, fuzzy.js, format.js against these same fixtures."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import textutil

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


class TestIsChrome(TripwireTestCase):
    def test_blank_is_chrome(self):
        self.assertTrue(textutil.is_chrome(''))
        self.assertTrue(textutil.is_chrome('   '))

    def test_bare_prompt_is_chrome(self):
        self.assertTrue(textutil.is_chrome('❯'))
        self.assertTrue(textutil.is_chrome('  ❯  '))

    def test_divider_is_chrome(self):
        self.assertTrue(textutil.is_chrome('─' * 40))
        self.assertTrue(textutil.is_chrome('━' * 10))

    def test_auto_mode_line_is_chrome(self):
        self.assertTrue(textutil.is_chrome(
            '⏵⏵ auto mode on (shift+tab to cycle)'))

    def test_percent_remaining_footer_is_chrome(self):
        self.assertTrue(textutil.is_chrome(
            '  Sonnet 4.6 | acme-widgets (main) [55% remaining]'))

    def test_real_content_is_not_chrome(self):
        self.assertFalse(textutil.is_chrome('✢ Ruminating…'))
        self.assertFalse(textutil.is_chrome('Do you want to proceed?'))


class TestStripChromeLines(TripwireTestCase):
    def test_strips_trailing_chrome_from_busy_spinner_fixture(self):
        lines = [l.rstrip() for l in
                 fixture('claude_busy_spinner.txt').split('\n')]
        while lines and not lines[-1]:
            lines.pop()
        stripped = textutil.strip_chrome_lines(lines)
        self.assertNotIn('❯', stripped)
        self.assertFalse(any('% remaining]' in l for l in stripped))
        self.assertFalse(any(set(l.strip()) <= {'─', '━'} for l in stripped
                             if l.strip()))
        self.assertTrue(any('✢ Ruminating…' in l for l in stripped))
        self.assertIn('Tip: Use /permissions', stripped[-1])

    def test_max_lines_limits_stripping(self):
        lines = ['real content'] + ['❯'] * 10
        stripped = textutil.strip_chrome_lines(lines, max_lines=3)
        self.assertEqual(len(stripped), len(lines) - 3)


class TestTailLines(TripwireTestCase):
    def test_basic_tail(self):
        text = 'a\nb\nc\nd\ne\n'
        self.assertEqual(textutil.tail_lines(text, 2, 80), ['d', 'e'])

    def test_trims_trailing_blank_lines(self):
        text = 'a\nb\n\n\n'
        self.assertEqual(textutil.tail_lines(text, 5, 80), ['a', 'b'])

    def test_clips_to_width(self):
        text = 'a very long line indeed'
        self.assertEqual(textutil.tail_lines(text, 1, 5), ['a ver'])

    def test_zero_n_returns_empty(self):
        self.assertEqual(textutil.tail_lines('a\nb', 0, 80), [])

    def test_strip_chrome_true_drops_footer(self):
        text = fixture('claude_busy_spinner.txt')
        without = textutil.tail_lines(text, 20, 80, strip_chrome=False)
        with_strip = textutil.tail_lines(text, 20, 80, strip_chrome=True)
        self.assertGreater(len(without), len(with_strip))
        self.assertNotIn('⏵⏵ auto mode on (shift+tab to cycle)', with_strip)


class TestAgeStr(TripwireTestCase):
    def test_seconds(self):
        self.assertEqual(textutil.age_str(45), '45s')

    def test_minutes(self):
        self.assertEqual(textutil.age_str(125), '2m')

    def test_hours(self):
        self.assertEqual(textutil.age_str(3 * 3600 + 10), '3h')

    def test_days(self):
        self.assertEqual(textutil.age_str(2 * 86400 + 100), '2d')

    def test_negative_clamped_to_zero(self):
        self.assertEqual(textutil.age_str(-5), '0s')


class TestFuzzyMatch(TripwireTestCase):
    def test_empty_needle_matches_everything(self):
        self.assertTrue(textutil.fuzzy_match('', 'anything'))

    def test_subsequence_matches(self):
        self.assertTrue(textutil.fuzzy_match('gwy', 'gateway'))

    def test_case_insensitive(self):
        self.assertTrue(textutil.fuzzy_match('GwY', 'Gateway'))

    def test_out_of_order_does_not_match(self):
        self.assertFalse(textutil.fuzzy_match('ywg', 'gateway'))

    def test_missing_char_does_not_match(self):
        self.assertFalse(textutil.fuzzy_match('gwz', 'gateway'))


if __name__ == '__main__':
    unittest.main()
