"""notifier.py's API changed completely from Ultrawatch's (no more modal
osascript dialog / background Thread — see docs/DESIGN.md §4.2), so these
tests exercise the new check()/draft_url()/mark_notified() API rather than
porting the old check_and_notify()/Thread-mock tests verbatim."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import notifier


class TestNotifierCheck(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_path = os.path.join(self.tmp.name, 'config.json')
        self.flag_path = os.path.join(self.tmp.name, '.last-email-sent')
        self.paths = mock.patch.multiple(
            notifier, CONFIG_PATH=self.config_path, FLAG_PATH=self.flag_path)
        self.paths.start()
        self.addCleanup(self.paths.stop)

    def write_config(self, **overrides):
        config = {
            'enabled': False,
            'threshold_percent': 90,
            'email': {'to': 'manager@example.com', 'subject': 'Subject',
                      'body': 'Body'},
        }
        config.update(overrides)
        with open(self.config_path, 'w') as f:
            json.dump(config, f)

    def test_missing_config_is_disabled(self):
        self.assertIsNone(notifier.check(100))

    def test_missing_enabled_key_is_disabled(self):
        self.write_config()
        with open(self.config_path) as f:
            config = json.load(f)
        del config['enabled']
        with open(self.config_path, 'w') as f:
            json.dump(config, f)
        self.assertIsNone(notifier.check(100))

    def test_explicitly_disabled_config_is_disabled(self):
        self.write_config(enabled=False)
        self.assertIsNone(notifier.check(100))

    def test_explicitly_enabled_config_over_threshold_returns_prompt(self):
        self.write_config(enabled=True)
        prompt = notifier.check(90)
        self.assertEqual(prompt, {'pct': 90, 'to': 'manager@example.com'})

    def test_enabled_config_below_threshold_does_nothing(self):
        self.write_config(enabled=True)
        self.assertIsNone(notifier.check(89))

    def test_custom_threshold(self):
        self.write_config(enabled=True, threshold_percent=50)
        self.assertIsNone(notifier.check(49))
        self.assertIsNotNone(notifier.check(50))

    def test_already_notified_this_month_suppresses(self):
        self.write_config(enabled=True)
        notifier.mark_notified()
        self.assertIsNone(notifier.check(95))

    def test_mark_notified_then_check_next_month(self):
        self.write_config(enabled=True)
        notifier.mark_notified()
        with mock.patch.object(notifier.time, 'strftime', return_value='2099-01'):
            self.assertIsNotNone(notifier.check(95))


class TestDraftUrl(TripwireTestCase):
    def test_builds_gmail_compose_url(self):
        cfg = {'email': {'to': 'a@example.com', 'subject': 'Hi there',
                         'body': 'Body & stuff'}}
        url = notifier.draft_url(cfg)
        self.assertTrue(url.startswith('https://mail.google.com/mail/?'))
        self.assertIn('to=a%40example.com', url)
        self.assertIn('su=Hi%20there', url)

    def test_missing_email_returns_none(self):
        self.assertIsNone(notifier.draft_url({}))
        self.assertIsNone(notifier.draft_url({'email': {}}))

    def test_non_dict_config_returns_none(self):
        # Explicit non-dict values (not None — None means "read the real
        # config file", tested under TestNotifierCheck with a patched path).
        self.assertIsNone(notifier.draft_url(False))
        self.assertIsNone(notifier.draft_url(123))

    def test_never_calls_open(self):
        # draft_url() only builds the URL; opening it is a WP2 server
        # route's job via the Opener provider. subprocess/webbrowser are
        # tripwired, so any accidental `open` call here fails loudly.
        cfg = {'email': {'to': 'a@example.com', 'subject': 's', 'body': 'b'}}
        notifier.draft_url(cfg)  # must not raise TripwireError


if __name__ == '__main__':
    unittest.main()
