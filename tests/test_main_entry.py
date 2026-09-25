"""New (docs/DESIGN.md §4.1): `python -m omniwatch` entry point flushes and
hard-exits with cli.main()'s status."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import __main__ as entry


class TestMainEntry(TripwireTestCase):
    def test_run_exits_with_main_status(self):
        for returned, expected in ((0, 0), (3, 3), (None, 0)):
            with mock.patch.object(entry, 'main', return_value=returned), \
                    mock.patch('os._exit') as hard_exit:
                entry.run()
            hard_exit.assert_called_once_with(expected)

    def test_flush_errors_ignored(self):
        broken = mock.Mock()
        broken.flush.side_effect = ValueError('closed')
        with mock.patch.object(entry, 'main', return_value=0), \
                mock.patch('os._exit') as hard_exit, \
                mock.patch.object(sys, 'stdout', broken):
            entry.run()
        hard_exit.assert_called_once_with(0)


if __name__ == '__main__':
    unittest.main()
