import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import agents


class TestDetectAgentsFromProcess(TripwireTestCase):
    def test_comm_claude(self):
        self.assertEqual(agents.detect_agents_from_process('claude', ''),
                         {'claude'})

    def test_args_first_token_claude(self):
        self.assertEqual(
            agents.detect_agents_from_process('node', 'claude --resume'),
            {'claude'})

    def test_node_launcher_claude(self):
        self.assertEqual(
            agents.detect_agents_from_process(
                'node', 'node /Users/x/.local/bin/claude --dangerously-skip-permissions'),
            {'claude'})

    def test_bun_launcher_codex(self):
        self.assertEqual(agents.detect_agents_from_process('bun', 'bun codex'),
                         {'codex'})

    def test_anthropic_package_in_launch_prefix(self):
        self.assertEqual(
            agents.detect_agents_from_process(
                'node',
                'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
            {'claude'})

    def test_openai_codex_package_in_launch_prefix(self):
        self.assertEqual(
            agents.detect_agents_from_process(
                'node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'),
            {'codex'})

    def test_comm_codex(self):
        self.assertEqual(
            agents.detect_agents_from_process('codex', 'codex exec'),
            {'codex'})

    def test_plain_process_empty(self):
        self.assertEqual(agents.detect_agents_from_process('vim', 'vim file.txt'),
                         set())
        self.assertEqual(agents.detect_agents_from_process('zsh', '-zsh'),
                         set())

    def test_never_both_agents_from_one_process(self):
        cases = [
            ('claude', 'claude'),
            ('node', 'node /x/claude'),
            ('codex', 'codex'),
            ('bun', 'bun codex'),
            ('node', 'node /x/@anthropic-ai/claude-code/cli.js'),
            ('node', 'node /x/@openai/codex/bin/codex.js'),
        ]
        for comm, args in cases:
            with self.subTest(comm=comm, args=args):
                self.assertLessEqual(
                    len(agents.detect_agents_from_process(comm, args)), 1)

    def test_quoted_basename(self):
        self.assertEqual(
            agents.detect_agents_from_process('node', '"/Users/x/bin/Claude"'),
            {'claude'})

    def test_empty_args(self):
        self.assertEqual(agents.detect_agents_from_process('login', ''), set())


class TestGetAgentTtys(TripwireTestCase):
    """Exercises the ps-parsing path with a mocked subprocess.run — no
    real process spawned (the tripwire would fail this test otherwise)."""

    def test_parses_ps_output_into_tty_agent_map(self):
        ps_output = (
            'TT       COMM             ARGS\n'
            'ttys000  claude           claude --resume\n'
            'ttys001  node             node /x/@openai/codex/bin/codex.js\n'
            '??       zsh              -zsh\n'
            'ttys002  vim              vim file.txt\n'
        )
        result = mock.Mock(stdout=ps_output)
        with mock.patch('subprocess.run', return_value=result):
            ttys = agents.get_agent_ttys()
        self.assertEqual(ttys, {'/dev/ttys000': {'claude'},
                                '/dev/ttys001': {'codex'}})

    def test_subprocess_failure_returns_empty_dict(self):
        with mock.patch('subprocess.run', side_effect=OSError('no ps')):
            self.assertEqual(agents.get_agent_ttys(), {})

    def test_blank_output_returns_empty_dict(self):
        with mock.patch('subprocess.run', return_value=mock.Mock(stdout='')):
            self.assertEqual(agents.get_agent_ttys(), {})


class TestFillMissingTtyCwds(TripwireTestCase):
    def test_empty_input_short_circuits_without_subprocess(self):
        # Must not even attempt a subprocess call for an empty request.
        self.assertEqual(agents.fill_missing_tty_cwds([]), {})

    def test_maps_ttys_to_cwds_via_ps_then_lsof(self):
        ps_output = 'PID TT\n  100 ttys000\n  200 ttys000\n  300 ttys001\n'
        lsof_output = 'p200\nn/Users/x/src\np300\nn/Users/x/other\n'
        results = [mock.Mock(stdout=ps_output), mock.Mock(stdout=lsof_output)]
        with mock.patch('subprocess.run', side_effect=results):
            cwds = agents.fill_missing_tty_cwds(['/dev/ttys000', '/dev/ttys001'])
        self.assertEqual(cwds, {'/dev/ttys000': '/Users/x/src',
                                '/dev/ttys001': '/Users/x/other'})

    def test_no_matching_ttys_skips_lsof_call(self):
        ps_output = 'PID TT\n  100 ttys999\n'
        with mock.patch('subprocess.run',
                        return_value=mock.Mock(stdout=ps_output)) as run:
            cwds = agents.fill_missing_tty_cwds(['/dev/ttys000'])
        self.assertEqual(cwds, {})
        run.assert_called_once()  # only the `ps` call, no `lsof`

    def test_subprocess_failure_returns_empty_dict(self):
        with mock.patch('subprocess.run', side_effect=OSError('no ps')):
            self.assertEqual(agents.fill_missing_tty_cwds(['/dev/ttys000']), {})


if __name__ == '__main__':
    unittest.main()
