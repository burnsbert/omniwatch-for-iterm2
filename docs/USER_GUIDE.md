# Omniwatch User Guide

Every view and feature, in one place. For the full design rationale and the
HTTP/SSE contract, see [`DESIGN.md`](DESIGN.md) and [`API.md`](API.md).
Screenshots are captured from `omniwatch demo` (`make screenshots`) in both
themes; `<name>-dark.png` / `<name>-light.png` under
[`docs/screenshots/`](screenshots/).

## Window layout

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/split-dark.png">
  <img src="screenshots/split-light.png" alt="Omniwatch split view with toolbar, projects panel, session list, preview pane, and usage strip labeled" width="820">
</picture>

The default **split** view has, top to bottom:

- **Toolbar** — a waiting pill (amber when > 0; click jumps to the next
  waiting session), a `N tabs · N agents · N waiting` summary, an iTerm2
  status chip (only shown when it isn't `ok`), the "blocked on you" stats
  chip, a search field, a sort menu, the view switch, and settings.
- **Sidebar** — the collapsible Projects panel, then the virtualized
  session list.
- **Preview** — header, screen pane, a reply bar when the selected session
  is waiting, and a footer with "live · updated Xs ago" plus action
  buttons.
- **Usage strip** — one line per Claude/Codex limit, collapsible.

The minimum window size is 640×420. Below 900 px wide, split falls back to
list. The window frame and the current view are restored on relaunch.

## Views

`v` (or `V`) cycles views; `⌘1`/`⌘2`/`⌘3` jump directly to split/list/grid.

### Split (default)

Sidebar + preview, described above. The divider is draggable, or use
`<`/`>` (also `,`/`.`) to step it in 0.05 increments between 0.2 and 0.8.

### List

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/list-dark.png">
  <img src="screenshots/list-light.png" alt="List view: full-width sortable session rows with a bottom preview drawer for the selection" width="640">
</picture>

Full-width rows (state icon, agent chip, tab-color dot, tab label, path,
name/label, age) with a bottom preview drawer for the current selection
(3 lines by default; drag to expand).

### Grid

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/grid-dark.png">
  <img src="screenshots/grid-light.png" alt="Grid view: a responsive tile wall of agent sessions, one waiting tile bordered in amber" width="640">
</picture>

A responsive tile wall (`minmax(340px, 1fr)` columns). Shows agent sessions
only unless you press `A` (all sessions; persisted). Each tile shows the
chrome-stripped tail of the screen, dimmed unless selected, with a bold
amber border for waiting sessions. Arrow keys move by one tile (`←`/`→`) or
by a full row (`↑`/`↓`).

### Zoom

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/zoom-dark.png"><img src="screenshots/zoom-light.png" alt="Zoom overlay: one session's full screen text filling the window body, toolbar still visible" width="640">
</picture>

`Space` zooms the selected session to fill the window body (the toolbar
stays). `↑`/`↓` moves to a different session while zoomed; any other key,
or `Space`/`Esc` again, exits.

## Preview and quick reply

The preview header shows path · label · agent · state and age, with an
accent border colored by state (amber for waiting). The body is the full
screen text, pinned to the bottom (scroll up to read more; it un-pins while
you're scrolled).

When the selected session is an agent currently `waiting`, a reply bar
appears with a button per parsed prompt option (Claude's `❯ 1. Yes`, `2.
Yes, and don't ask again…`; Codex's `Yes (y)` / `No (n)`), reachable with
`⌥1`–`⌥9`, plus a free-text field (`i` to focus it):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/quick-reply-dark.png">
  <img src="screenshots/quick-reply-light.png" alt="Reply bar under a preview pane with buttons for each numbered prompt option" width="640">
</picture>

Quick reply is guarded: it only works for agent sessions currently
`waiting`, and the request must include the screen hash it was based on —
if the screen has changed, or the last snapshot is more than 5 seconds
old, the backend rejects it with a "stale screen" error instead of typing
into the wrong prompt. It can be turned off entirely in Settings.

## Projects panel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/projects-dark.png">
  <img src="screenshots/projects-light.png" alt="Projects panel: five color-coded slots (blue, purple, green, red, yellow) above the session list" width="640">
</picture>

Five fixed, color-coded slots (blue, purple, green, red, yellow), toggled
with `p`. Click a slot (or press `↑` from the top session, then `⏎`) to
name it. With a session selected, `1`–`5` sets its iTerm2 tab color to
that project's color (a colored dot then appears next to the row); `0`
clears it. `c` clears all five names, with a confirmation. Setting tab
colors needs the optional [tab-colors setup](../README.md#first-run-permissions) —
without it, these keys toast "tab colors unavailable" instead of erroring.

## Usage view and usage strip

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/usage-dark.png">
  <img src="screenshots/usage-light.png" alt="Usage view: one card per limit, each with a percentage bar, reset countdown, sparkline, and burn-rate text" width="640">
</picture>

`u` (or `⌘U`, or clicking the usage strip) opens the full-body usage view:
one card per limit — Claude's Session (5h), Weekly (7d), Weekly Sonnet
(7d), and Monthly cap/Extra usage; Codex's 5h and 7d — each with a
level-colored bar (green < 50%, yellow 50–79%, red ≥ 80%), a reset
countdown ("2h 15m · Today at 5:59pm"), a pace warning ("on pace to hit
Friday at 11:00am" or "Limit hit"), and a **usage burn-rate sparkline**:
usage history plotted over time with a projection like "at this rate: 100%
Today at 11:49am". Dollar amounts on the monthly card stay hidden until
you press `$`. A **Refresh** button re-fetches usage on demand (throttled
to once per 10 seconds).

If no Claude Code or Codex session is running, a limit reads "no sessions
running" instead of fetching — usage is only polled while an agent of that
kind is active.

## Activity timeline & "blocked on you" stats

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/timeline-dark.png">
  <img src="screenshots/timeline-light.png" alt="Activity timeline sheet: a horizontal bar of colored busy/waiting/idle/quiet segments over 8 hours, with totals per state" width="640">
</picture>

Every session carries a compact **ribbon** — 48 ten-minute buckets (8
hours) of its busy/waiting/idle/active/quiet history — shown as a small bar
under grid tiles and in the preview header. Press `t` (or `T`) on a
selected session to open its full activity sheet: the same window at full
resolution, with per-state totals and a transition count.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/stats-dark.png">
  <img src="screenshots/stats-light.png" alt="Blocked-on-you stats card: hero number of minutes blocked today, longest wait, answered count, and a histogram of how many agents were waiting over time" width="640">
</picture>

The **"blocked on you"** chip in the toolbar (click for the full card)
tracks, for today (local calendar date): total minutes agents spent
waiting, the longest single wait, how many prompts you've answered, and a
histogram of how many agents were waiting over time (built from every
session's ribbon). It only recomputes on a wait starting or ending, or at
midnight — not every second — so it stays cheap.

## Stall detection

A session that's `busy` with a screen hash that hasn't changed for at
least the configured `stall_minutes` (Settings; default 10, `0` turns it
off) is flagged **stalled**. It gets a distinct chip in the list/grid, is
listed separately in the menu-bar dropdown, and can optionally send one
notification per stall episode ("*title* may be stalled — busy with no
screen change for 12m. Check on it?"). It clears automatically the moment
the screen changes again.

## Reveal / Open in…

From a row's context menu or its keyboard shortcuts (`e` editor, `o`
Finder, `y` copy path — "yank"), jump into the repo an agent is working
in. The path is always the session's own, resolved on the backend (never
taken from anything the client sends):

- **Editor** — runs your configured editor command (Settings, or
  `$VISUAL`/`$EDITOR`, or `code`) against the path, detached. Terminal-only
  editors (`vi`, `vim`, `nano`, …) are skipped rather than launched with no
  terminal to attach to.
- **Finder** — `open -R <path>`.
- **Copy path** — puts the path on the clipboard.

## Command palette

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/palette-dark.png">
  <img src="screenshots/palette-light.png" alt="Command palette: fuzzy search box with matching commands and sessions listed below, matched characters highlighted" width="640">
</picture>

`⌘K` opens a fuzzy search over every keyboard command ("Sort: attention",
"View: grid", "Toggle dollars"…) and every visible session ("Go to
~/src/api-gateway · deploy-fix"). `⏎` runs the highlighted item; `⌥⏎` on a
session selects it without switching to it in iTerm2.

## Settings

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/settings-dark.png">
  <img src="screenshots/settings-light.png" alt="Settings sheet: theme picker, text size, notifications, sound, quick reply, stall minutes, editor command, keep-on-top, launch at login, menu-bar-only" width="640">
</picture>

`⌘,` opens Settings: theme (dark / light / system / high-contrast), text
size, notifications (on/off and whether a click goes to the session or
just shows the window), stall banners, sound on attention, quick reply
on/off, stall-detection minutes, the editor command for "Open in editor",
close-window-on-`q` behavior, hint bar, and (native app only) **Launch at
login** and **Menu bar only** (no Dock icon). A **Setup guide** button
reopens onboarding.

## First-run onboarding

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/onboarding-dark.png">
  <img src="screenshots/onboarding-light.png" alt="First-run onboarding sheet: three steps for Automation access, tab colors, and notifications, each with live status" width="640">
</picture>

A three-step, skippable sheet (reopenable from Settings), each step backed
by live status from the diagnostics endpoint:

1. **Control iTerm2** (required) — explains the Automation prompt;
   **Grant access** triggers it; turns green once a snapshot succeeds.
2. **Tab colors & projects** (optional) — checks whether the backend's
   Python can `import iterm2`, with a copyable `make install-colors`
   command and the iTerm2 setting to flip.
3. **Notifications** (app) / browser permission (browser mode).

A **Try the demo** button restarts the backend in demo mode, so a new user
sees a populated dashboard immediately.

## Empty, error, and permission states

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/empty-not-running-dark.png">
  <img src="screenshots/empty-not-running-light.png" alt="Empty state: iTerm2 isn't running, with a Launch iTerm2 button" width="640">
</picture>

Omniwatch tries to say exactly what's wrong instead of showing nothing:
"Connecting to iTerm2…" while waiting for the first snapshot; "iTerm2
isn't running" with a **Launch iTerm2** button; a permission card
(distinguished from a generic failure) with **Open Automation settings**
and **Try again** when the Automation prompt was denied; "iTerm2 query
failed: …" with stale data still shown under a *Stale* chip on a
transient error; "No sessions match "foo"" when a filter matches nothing;
and "No agent sessions — press A to show all" in an empty grid. If the
backend itself disconnects, a "Reconnecting…" banner appears with
exponential backoff.

## Compact / companion-window mode

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/compact-dark.png">
  <img src="screenshots/compact-light.png" alt="Compact narrow window: a sidebar-only session list, suited to a small companion window beside iTerm2" width="360">
</picture>

Below about 420 px wide the layout collapses to a sidebar-only list —
suited to keeping Omniwatch as a small companion window beside iTerm2.
**Keep window on top** (Settings, or the native menu) pins it above other
windows.

## Menu bar, dock badge, and notifications (native app)

These are native AppKit surfaces and can't be captured as web screenshots,
so they're described here instead of shown:

- **Menu bar**: `○` when no one is waiting, `◉ N` in amber when N > 0
  (capped display `99+`), `◌` while the backend is down. Clicking it opens
  a dropdown of waiting sessions (longest wait first), then a "may be
  stalled" section; clicking an entry goes to that session in iTerm2.
- **Dock badge**: the waiting count, or none at 0. The window title reads
  "Omniwatch — N waiting".
- **Notifications**: on a session transitioning to `waiting`, a
  notification titled "*title* needs you" with the prompt's question (or
  the last meaningful screen line) as the body, and **Go to session** /
  **Show in Omniwatch** actions. Suppressed for muted sessions, and while
  Omniwatch is the frontmost app with that session already visible. A
  similar, quieter notification ("*title* may be stalled") fires once per
  stall episode if stall notifications are on.
- **Global hotkey**: `⌃⌥⌘O` by default shows or hides the window from
  anywhere; a second, off-by-default hotkey goes to the next waiting
  session in iTerm2 without switching to Omniwatch.
- **Launch at login** and **menu-bar-only mode** (no Dock icon) are
  toggled from Settings or the status-item menu.

## Themes and accessibility

Dark, light, system (follows `prefers-color-scheme`), and high-contrast
themes; text scales with `⌘+`/`⌘-`/`⌘0` (persisted). The session list is a
`listbox`, the grid a `grid`, with accessible names like "Waiting 3
minutes, Claude Code, tab 1.1, ~/src/api, label deploy-fix" — state is
never conveyed by color alone. `prefers-reduced-motion` turns off the
spinner, pulse, and smooth scroll.

## Browser mode

`omniwatch --browser` runs the identical backend and opens the same UI in
your default browser instead of the native app. Notifications use the Web
Notification API (permission requested from Settings) instead of native
`UNUserNotification`, and there's no menu-bar counter, dock badge, or
global hotkey — those are native-app-only.
