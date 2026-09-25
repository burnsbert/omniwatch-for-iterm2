"""Detection of AI coding agents (Claude Code, Codex) on iTerm2 TTYs.

Ported verbatim from ultrawatch_lib/agents.py (see docs/DESIGN.md §4.2).
"""
import os
import subprocess

from omniwatch import config

NODE_LAUNCHERS = {'node', 'bun'}


def process_basename(value):
    return os.path.basename(value.strip('"')).lower()


def detect_agents_from_process(comm, args):
    """Identify supported agents from a process command and argv."""
    tokens = args.split()
    first = process_basename(tokens[0]) if tokens else ''
    second = tokens[1] if len(tokens) > 1 else ''
    second_base = process_basename(second)
    comm_base = process_basename(comm)
    launch_prefix = ' '.join(tokens[:3]).lower()

    agents = set()
    if (comm_base == 'claude' or first == 'claude' or
            (first in NODE_LAUNCHERS and second_base == 'claude') or
            '@anthropic-ai/claude-code' in launch_prefix):
        agents.add('claude')
    if (comm_base == 'codex' or first == 'codex' or
            (first in NODE_LAUNCHERS and second_base == 'codex') or
            '@openai/codex' in launch_prefix):
        agents.add('codex')
    return agents


def get_agent_ttys():
    """Find TTYs that have known AI coding agents running on them."""
    try:
        result = subprocess.run(
            ['ps', '-eo', 'tty,comm,args'],
            capture_output=True, text=True, errors='replace',
            timeout=config.PS_TIMEOUT
        )
        ttys = {}
        for line in result.stdout.strip().split('\n'):
            parts = line.split(None, 2)
            if len(parts) >= 2:
                tty = parts[0]
                if tty == '??':
                    continue
                args = parts[2] if len(parts) > 2 else ''
                for agent in detect_agents_from_process(parts[1], args):
                    ttys.setdefault(f'/dev/{tty}', set()).add(agent)
        return ttys
    except Exception:
        return {}


def fill_missing_tty_cwds(ttys):
    """Use lsof to detect working directories for the given TTYs.

    Takes an iterable of tty strings (e.g. '/dev/ttys003') and returns a
    dict {tty: cwd} for the shells found on those TTYs. Used when shell
    integration is unavailable.
    """
    empty_ttys = set(ttys)
    if not empty_ttys:
        return {}
    try:
        # Find first (oldest = shell) PID per TTY
        result = subprocess.run(
            ['ps', '-eo', 'pid,tty'], capture_output=True, text=True,
            timeout=config.PS_TIMEOUT
        )
        tty_pid = {}
        for line in result.stdout.strip().split('\n')[1:]:
            parts = line.split()
            if len(parts) >= 2:
                tty = f'/dev/{parts[1]}'
                if tty in empty_ttys:
                    tty_pid[tty] = parts[0]  # last (highest) PID = shell, not login
        if not tty_pid:
            return {}
        # Batch lsof for CWDs
        result = subprocess.run(
            ['lsof', '-a', '-d', 'cwd', '-p', ','.join(tty_pid.values()), '-Fn'],
            capture_output=True, text=True, timeout=config.PS_TIMEOUT
        )
        pid_cwd = {}
        cur_pid = None
        for line in result.stdout.split('\n'):
            if line.startswith('p'):
                cur_pid = line[1:]
            elif line.startswith('n') and cur_pid:
                pid_cwd[cur_pid] = line[1:]
        return {tty: pid_cwd.get(pid, '') for tty, pid in tty_pid.items()}
    except Exception:
        return {}
