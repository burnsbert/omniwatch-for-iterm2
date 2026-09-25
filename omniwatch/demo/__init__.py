"""Demo mode: fully-fake Providers so Omniwatch can be tried and
screenshotted with zero setup (docs/DESIGN.md §3, §5, §7 WP3).

``make_demo_providers()`` returns an object with the same shape as
``omniwatch.providers.RealProviders`` — ``iterm``, ``agents``,
``usage_claude``, ``usage_codex``, ``colors``, ``opener``, ``clock`` —
plus a ``.demo`` extension (``scenario``, ``step(seconds)``) the server
uses to drive deterministic timelines for tests and screenshots. Nothing
here ever touches a real subprocess or the network.
"""
from omniwatch.demo.providers import SCENARIOS, make_demo_providers

__all__ = ['SCENARIOS', 'make_demo_providers']
