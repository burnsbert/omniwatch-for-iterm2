"""Immutable snapshot types passed from poller threads to the engine.

Ported verbatim from ultrawatch_lib/snapshot.py (see docs/DESIGN.md §4.2).
"""
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SessionInfo:
    """One iTerm2 session as reported by the batched snapshot script."""
    window_id: int
    tab_index: int
    session_index: int
    uid: str
    tty: str
    is_processing: bool
    name: str
    text: str


@dataclass(frozen=True)
class ItermSnapshot:
    sessions: tuple = ()          # tuple[SessionInfo]
    at: float = 0.0               # time.time() when captured
    not_running: bool = False
    error: str = ''               # non-empty when the poll failed


@dataclass(frozen=True)
class PathsSnapshot:
    paths: tuple = ()             # tuple[(uid, path)]
    at: float = 0.0


@dataclass(frozen=True)
class ColorsSnapshot:
    """uid -> tab color name ('red', 'orange', ...), from iTerm2's Python
    API. Only sessions with a tab color set are included."""
    colors: tuple = ()            # tuple[(uid, name)]
    at: float = 0.0


@dataclass(frozen=True)
class AgentSnapshot:
    """tty -> frozenset of agent names ('claude', 'codex')."""
    ttys: tuple = ()              # tuple[(tty, frozenset)]
    tty_cwd: tuple = ()           # tuple[(tty, cwd)] lsof fallback paths
    at: float = 0.0

    def agents_for(self, tty):
        for t, agents in self.ttys:
            if t == tty:
                return agents
        return frozenset()


@dataclass(frozen=True)
class UsageSnapshot:
    """Claude Code or Codex usage API result."""
    data: Optional[dict] = None   # last successful payload (treat as immutable)
    ok: bool = True               # last fetch succeeded
    inactive: bool = False        # no matching agent running; nothing fetched
    at: float = 0.0


@dataclass(frozen=True)
class ErrorSnapshot:
    kind: str = ''
    error: str = ''
    at: float = 0.0
