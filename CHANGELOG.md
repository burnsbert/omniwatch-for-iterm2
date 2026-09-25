# Changelog

All notable changes to Omniwatch for iTerm2 are documented here.

## 1.0.0 — 2026-09-25

Initial release: a GUI rebuild of [Ultrawatch for iTerm2](https://github.com/burnsbert/ultrawatch-for-iterm2)
that runs in its own native window instead of an iTerm2 tab.

### Parity with Ultrawatch

- Live preview of any session's screen, updated from one batched
  AppleScript snapshot every 2 seconds.
- Busy / waiting / idle classification for Claude Code and Codex sessions,
  with attention routing (row flash, toast, sound on a busy→waiting
  transition).
- Split, list, and grid views, plus a full-screen zoom.
- Fuzzy filter, five sort orders, persistent session labels, a five-slot
  color-coded Projects panel with iTerm2 tab-color assignment.
- Claude (Session 5h, Weekly 7d, Weekly Sonnet 7d, Monthly cap/Extra usage)
  and Codex (5h, 7d) usage limits with pace warnings and reset countdowns.
- Full keyboard parity, mouse support, and an opt-in quota-email prompt.

### New in Omniwatch

- Native macOS shell (`Omniwatch.app`): its own window, menu-bar counter,
  dock badge, and `UNUserNotification`s with **Go to session** / **Show in
  Omniwatch** actions — all driven by the shell's own SSE connection, so
  they work whether or not the window is visible. `omniwatch --browser`
  runs the identical backend in your default browser instead.
- **Quick reply**: prompt options become buttons (plus `⌥1`–`⌥9` and a
  free-text field) in the preview, guarded by a screen-hash check so a
  stale prompt can't be answered by mistake.
- **"Blocked on you" stats**: today's total agent-minutes spent waiting,
  the longest single wait, and how many prompts you've answered.
- **Activity timeline**: a busy/waiting/idle ribbon per session over the
  last 8 hours, in the preview header, under grid tiles, and in a
  dedicated history sheet (`t`).
- **Stall detection**: a busy session with no screen change for a
  configurable number of minutes (default 10, off at 0) gets a "may be
  stalled?" chip and an optional notification.
- **Usage burn rate**: usage history feeds a sparkline per limit and an
  "at this rate: 100% at …" projection.
- **Reveal / Open in…**: jump to a session's path in Finder, your editor,
  or the clipboard — resolved on the backend, never from the client.
- **Command palette** (`⌘K`) over every keyboard command and session.
- Dark, light, system, and high-contrast themes; adjustable text size;
  reduced-motion support.
- Mute, keep-window-on-top, a compact narrow-window layout, launch at
  login, and menu-bar-only mode.
- **Demo mode** (`omniwatch demo`): a fully scripted fake dashboard with
  zero setup, used for onboarding, tests, and this repo's screenshots.
- `omniwatch doctor` and a first-run onboarding sheet for the two most
  common "it shows nothing" problems: iTerm2 not running, and the
  Automation permission not granted.
- **Ultrawatch migration**: labels, projects, and prefs are imported
  read-only from an existing `~/.config/ultrawatch/state.json` on first
  run.
- An optional iTerm2 status-bar plugin (`make install-plugin`) showing the
  waiting count inside iTerm2 itself.

### Removed (terminal-only, no longer applicable)

- The curses full-repaint heartbeat and resize handling (a GUI window
  doesn't drift out of sync the way a terminal can).
- The ASCII-art "you're viewing yourself" title card — replaced by
  detecting and badging other Ultrawatch/Omniwatch sessions instead of
  needing a card at all.
- The 256/8-color terminal palette fallback — replaced by CSS design
  tokens with light, dark, and high-contrast variants.
