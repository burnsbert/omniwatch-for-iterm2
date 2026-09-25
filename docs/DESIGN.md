# Omniwatch for iTerm2 — Design

Status: design for v1.0 · Source of truth for parity: Ultrawatch for iTerm2 v1.2.3
(`/Users/ericburns/src/ultrawatch-for-iterm2`, read-only reference; file names below refer to
`ultrawatch_lib/…` unless noted).

Omniwatch is a GUI rebuild of Ultrawatch that runs in its own window instead of inside
iTerm2. It's for people running many Claude Code / Codex agents, and it answers the question
Ultrawatch answers: **who needs me right now, and what are they doing?** — in a native Mac
window, with a menu-bar counter and notifications, and without taking an iTerm2 tab.

Shape (coordinator decision, kept):

```
┌──────────── Omniwatch.app (Swift/AppKit, swiftc-built) ─────────────┐
│ NSWindow ─ WKWebView ──HTTP/SSE──┐   NSStatusItem · dock badge ·     │
│                                  │   UNUserNotification · hotkey     │
│   own SSE client (URLSession) ───┤                                   │
└───────────── spawns + supervises │ ──────────────────────────────────┘
                                   ▼
        python3 omniwatch.pyz serve   (stdlib only, 127.0.0.1:<random>, token)
        engine ← pollers ← providers: osascript · ps/lsof · Keychain/HTTPS · iterm2 API
                               └── demo providers (fake iTerm, fake usage) ──┘
```

`omniwatch --browser` runs the same backend and opens the same UI in the default browser.

---

## 1. Parity matrix

Status key: **Keep** = port nearly verbatim · **Adapt** = same behavior, GUI form ·
**Improve** = same intent, deliberately better · **Drop** = terminal-only, reason given.
Every row gets a test ID (`P-xx`), and the parity test suite (§5) references these IDs so
coverage can be checked.

### 1.1 Data collection & detection

| ID | Ultrawatch behavior (source) | Omniwatch equivalent | Status |
|----|------------------------------|----------------------|--------|
| P-01 | One batched AppleScript collection query (`iterm.py SNAPSHOT_SCRIPT`) gets window id, tab/session index, unique id, tty, `is processing`, name, and full screen `text` for every session; US/RS framing; `missing value` → `''`; malformed records are dropped | Same script and parser (`omniwatch/iterm.py`) | Keep |
| P-02 | Poll every 2 s; adaptive cadence `max(interval, 2×elapsed)` (`pollers.ItermWorker.run`) | Same; `poll_ms` exposed in `/state.iterm` | Keep |
| P-03 | Per-session `variable named "path"` loop every 10 s; the last paths snapshot is kept if a poll fails | Same | Keep |
| P-04 | Every osascript call (polls and actions) is serialized on one worker thread; any action triggers an immediate re-poll | Same (`ItermWorker`) | Keep |
| P-05 | Parameters go through `on run argv`, never interpolated into AppleScript source | Same rule, applied to every new script too (reply, close-by-uid, probe) | Keep |
| P-06 | `ps -eo tty,comm,args` every 5 s → claude/codex per TTY, including `node`/`bun` launchers and `@anthropic-ai/claude-code` / `@openai/codex` (`agents.py`); `??` TTYs ignored | Same; the registry becomes data-driven in P1 (§3) | Keep |
| P-07 | `lsof -d cwd` fallback path for TTYs with no shell-integration path, only for TTYs the UI reports as missing a path (`needs_cwd_box`) | Same; the engine computes the missing set | Keep |
| P-08 | Classifier: last 25 non-blank lines scanned bottom-up, first match wins, per-agent rule tables, fallback `is processing`→busy else idle (`heuristics.classify_agent`) | Verbatim, plus `extract_prompt()` for quick reply (§3) | Keep |
| P-09 | Non-agent sessions: `active` if processing or the screen changed in the last 5 s, else `quiet` | Same | Keep |
| P-10 | Change hash = CRC32 of the screen with spinner glyphs stripped and trailing blanks trimmed | Same; exposed as `screen_hash` (hex) | Keep |
| P-11 | Two-snapshot debounce; the first observation publishes immediately (`SessionTracker._debounce`) | Same | Keep |
| P-12 | Attention latch: set when WAITING is published (or first seen WAITING), cleared on visit or when the session leaves WAITING | Same; the client calls `POST …/visit` when a session is selected. Exposed as `attention` (= "waiting and not yet looked at") | Keep |
| P-13 | Sessions that disappear are garbage-collected from the tracker | Same | Keep |
| P-14 | Tab colors via the optional iTerm2 Python API every 5 s; fresh connection per poll; stderr of the `iterm2` package silenced; `ColorApiUnavailable` (package missing) permanently disables it with no error shown; other failures retried; nearest-preset RGB classification; colors are set by injecting OSC 6 (repaint reason documented in `itermcolor.py`) | Verbatim. `capabilities.tab_colors` = `true`/`false`/`null` (unknown yet) drives the UI | Keep |
| P-15 | Claude usage: OAuth token from Keychain item `Claude Code-credentials` via `security`, `GET https://api.anthropic.com/api/oauth/usage` with the same headers/UA | Verbatim. New: "no credentials" is distinguished from "fetch failed" | Keep + Improve |
| P-16 | Codex usage: `~/.codex/auth.json` token, `GET https://chatgpt.com/backend-api/wham/usage`, merged with rate limits read from the 10 newest `~/.codex/sessions/*/*/*/*.jsonl` (≤24 h old, 8 MB tail), 5h/7d labeling | Verbatim | Keep |
| P-17 | Usage gating: fetch only while an agent of that kind runs; "inactive" is published once and drops data; 300 s interval; Retry-After stretches the interval (never below base); last-good data is kept through failures; a manual refresh refetches only if data is ≥10 s old (`UsagePoller`) | Verbatim | Keep |
| P-18 | Pace projections for five_hour / seven_day / seven_day_sonnet / monthly / Codex windows; "limit hit" vs "on pace to hit X at <abs time>" (`projection.py`) | Same math; returns structured `{kind, at, text}` instead of a pre-indented string | Adapt |
| P-19 | Usage level green <50, yellow 50–79, red ≥80 (`usage_level`) | Same thresholds → `level` field → color tokens | Keep |
| P-20 | Claude extra usage: shown only if `is_enabled`; `utilization` or used/limit; "Monthly Limit" when there's a cap, "Extra Usage" when there isn't; resets at local midnight on the 1st; monthly projection | Same | Keep |
| P-21 | Quota email: opt-in `~/.claude/quota-email/config.json` (`enabled: true`, `threshold_percent` default 90); at most once per calendar month via `~/.claude/quota-email/.last-email-sent`; modal osascript dialog "Skip This Month"/"Draft Email"; opens a Gmail compose URL | Same files (shared with Ultrawatch, so no double prompt). The modal osascript dialog becomes an in-app banner + native notification with **Draft email** / **Skip this month** (no modal system dialog; nothing opens during tests) | Improve |

### 1.2 Model & presentation

| ID | Ultrawatch behavior | Omniwatch equivalent | Status |
|----|---------------------|----------------------|--------|
| P-22 | Tab label `3`, or `2.3` when there are several windows; window ordinal = order of first appearance (`app.tab_label`, `window_number`) | Computed by the backend as `tab_label`, `window_number` | Keep |
| P-23 | Path = shell-integration path, else lsof cwd; `$HOME` → `~` | `path` + `path_display` | Keep |
| P-24 | Display name = label, else session name; row title (toasts) = label, else short path, else name, else uid[:8] | `display_name`, `title` from the backend | Keep |
| P-25 | Header: `N tabs · N agents · N waiting` (waiting in amber) | Toolbar summary chips; the waiting chip is clickable (jump to next waiting) | Adapt |
| P-26 | Header shows `iTerm2 not running` (red) / `STALE` on poll error / `STALE <age>` when the last snapshot is older than 4×interval | Status chip: *Not running* / *Stale · 12s* / *Error* with a tooltip showing the error | Adapt |
| P-27 | Glyphs: ◉ waiting, animated braille spinner busy, ○ idle, · output; 5 fps spinner only while something is busy | SVG/CSS state icons with text labels; spinner in CSS, static under `prefers-reduced-motion` | Adapt |
| P-28 | Badges CC (Claude, magenta), CX (Codex, blue), `···` plain, `▶▶▶` self | Agent chips "Claude" / "Codex" with accent colors; plain = no chip. There's no "self" row (Omniwatch isn't an iTerm2 session); see P-50 | Adapt |
| P-29 | Waiting rows amber from the tab number to the edge; "fresh" rows (last change <30 s ago, ignoring the first 5 s after launch, not busy/waiting) green; amber wins (`list_view.is_fresh`) | Amber / green row tint + left accent bar. Backend sends `fresh_until` (epoch) so the client expires it without a server push | Keep |
| P-30 | Right-aligned age column: `wait 3m` for waiting; `idle 22m` for idle/quiet ≥60 s; uniform column width | Same strings, computed client-side from `state_since` / `last_change`, ticking once a second | Keep |
| P-31 | Flash: the row pulses for 1.5 s on a busy→waiting transition | CSS pulse animation on `transition` events (reduced-motion: a single highlight instead) | Adapt |
| P-32 | Toast `◉ <title> is waiting for your input` on a transition to WAITING | In-app toast + native notification (§2.8) | Adapt + Improve |
| P-33 | Bell on attention, toggled with `b`, persisted | "Sound on attention" toggle (`b`), persisted; NSSound in the app, WebAudio chime in the browser | Adapt |
| P-34 | Tab-color dot next to rows with a tab color | Colored dot + tooltip with the color name and project name | Keep |
| P-35 | Window group headers in list view (natural sort with >1 window only) | Group headers in list view **and** the split-view sidebar, same rule | Improve (small) |
| P-36 | The row's label is rendered in the label color | Label shown as a pill | Adapt |

### 1.3 Views

| ID | Ultrawatch behavior | Omniwatch equivalent | Status |
|----|---------------------|----------------------|--------|
| P-37 | Views cycle split → list → grid (`v`), persisted | Segmented control + `v` + ⌘1/⌘2/⌘3; persisted | Adapt |
| P-38 | Split: list left, live preview right; ratio 0.2–0.8 in 0.05 steps via `<`/`>` (also `,`/`.`), persisted (default 0.42); list ≥26 cols, preview ≥32 cols; below 100 cols falls back to list | Draggable divider + the same keys and steps; persisted `split_ratio`; below 900 px window width, falls back to list | Adapt |
| P-39 | Split sidebar title `SESSIONS ── sort: X ── filter: Y` | Sidebar header shows the sort and an active-filter chip | Adapt |
| P-40 | Preview title: path · label · agent · `STATE age`; border colored by state (amber waiting) / agent | Preview header with the same fields; accent border in the same colors | Keep |
| P-41 | Preview footer `live · updated just now` (<3 s) / `updated Xs ago`, plus hints `space zoom · ⏎ goto` | Same text in the footer; hints become buttons | Adapt |
| P-42 | Preview body = the last N lines that fit, trailing blanks trimmed | Full screen text in a monospace pane, pinned to the bottom (scroll up to read more; unpins while scrolled) | Improve |
| P-43 | `UW_DEBUG_STATE=1` shows `rule: <name>` in the preview footer | `OW_DEBUG_STATE=1` (and `UW_DEBUG_STATE=1` as an alias) **or** Settings › Advanced › "Show classifier rule" | Adapt |
| P-44 | List view: full-width rows + a 3-line mini-preview strip for the selection (when height ≥10 rows) | List view with a bottom preview drawer (3 lines by default, drag to expand) | Adapt |
| P-45 | Grid camera wall: agent sessions only, falling back to all sessions if there are no agents; `A` toggles all; tiles show the chrome-stripped tail (input-box rules, bare `❯`, `⏵⏵` lines, `% remaining]` lines, ≤8 stripped); dimmed unless selected; heavy border for waiting; title: glyph, tab, basename or label, badge, age | Responsive CSS grid (`minmax(340px,1fr)`), same filtering, same chrome stripping (JS port, sharing fixtures with Python), bold amber border for waiting, same title fields. `grid_all` persisted (Ultrawatch didn't persist it) | Adapt |
| P-46 | Grid arrows: ←/→ ±1, ↑/↓ ± number of columns; empty text `no agent sessions — press A to show all` | Same; the column count is read from the computed grid | Keep |
| P-47 | Zoom (`Space`): full-body preview; ↑/↓ changes session while zoomed; any other key exits | Same (Esc/Space/any other non-modifier key exits) | Keep |
| P-48 | Help overlay `?`, any key closes | Keyboard-shortcut sheet (`?` or ⌘/), grouped Navigate/Act/View/System, Esc closes | Adapt |
| P-49 | Usage footer: one row per limit (label, pct, 15-cell bar, `resets in 2h 15m (Today at 5:59pm)`), each pace warning on its own line, error rows `usage API fetch failed`; truncated so the body keeps ≥8 rows | Usage strip at the bottom of the window (compact meters + warnings), collapsible, persisted `usage_strip` | Adapt |
| P-50 | Title card instead of a preview when the session is Ultrawatch itself (`is_me`) or another instance (banner `▛▞ ULTRAWATCH` on the first line) | The infinite-mirror problem can't happen (Omniwatch isn't in a tab). Sessions running Ultrawatch are detected (same banner rule) and badged "Ultrawatch" and left out of the grid by default. The ASCII-art card is dropped | Drop (card) / Keep (detection) |
| P-51 | Usage screen (`u`): Claude and Codex sections, Session 5h / Weekly 7d / Sonnet 7d / Monthly cap rows, warnings, `fetch failing — showing data from Xm ago`, `no Claude Code or Codex sessions running`, `refreshed X ago`; inside it: `$`, `r`, `u`/Esc/`q` back | Usage view (§2.4) with cards per limit and the same messages and keys | Adapt |
| P-52 | Status line: toast for 5 s, otherwise legend `◉ waiting ⠹ busy ○ idle · output` + `filter: X` | Toast stack (bottom-right, 5 s, hover pauses); legend in the help sheet and as tooltips on the state icons | Adapt |
| P-53 | Context-sensitive key-hint bar | Optional hint bar (Settings › "Show shortcut hints", on by default) + tooltips that include the shortcuts | Adapt |
| P-54 | Empty states: `iTerm2 is not running`, `iTerm2 query failed: …`, `connecting to iTerm2…` | Empty-state panels with actions (§2.9), including **Launch iTerm2** and a **permission denied** state Ultrawatch couldn't tell apart | Improve |

### 1.4 Interaction & actions

| ID | Ultrawatch behavior | Omniwatch equivalent | Status |
|----|---------------------|----------------------|--------|
| P-55 | ↑/↓/j/k move selection; selection follows the session uid across refreshes; snaps back to the first row if the selection is filtered out | Same | Keep |
| P-56 | Selecting a row calls `tracker.visit` (clears attention) | `POST /sessions/{uid}/visit` when a selection change settles (150 ms debounce) | Keep |
| P-57 | `⏎`/`g`/double-click → go to session (select session, tab, window; activate iTerm2); toast `→ tab 2.3`; failure `goto failed: session not found` | Same (button, keys, double-click) | Keep |
| P-58 | `a` → select the next waiting session, cycling longest-waiting first; `no sessions waiting` otherwise (selects only, no iTerm2 switch) | Same. New: "Go to next waiting in iTerm2" command (menu bar, hotkey, palette) | Keep + Improve |
| P-59 | `/` fuzzy filter: case-insensitive subsequence over `"{path} {name} {label}"`, live while typing, `N of M match`, Esc clears, ⏎ keeps; not persisted | Search field (`/` or ⌘F), same matcher (JS port) and semantics, match count in the field | Keep |
| P-60 | `s` cycles sorts natural → attention → agents → activity → path; toast `sort: X`; persisted. attention = waiting (longest first) < busy < active < idle < quiet < unknown; agents = agents first; activity = latest change first; path = alphabetical, blank as `~`; ties → natural (window, tab, session) | Sort menu + `s`; identical comparators (JS, unit-tested against a Python-generated golden file) | Keep |
| P-61 | `l` label: inline edit, ⏎ saves (stripped), an empty label removes it, Esc cancels; printable ASCII only | Inline edit in the row / preview header. Unicode allowed, max 80 chars | Improve |
| P-62 | Labels keyed by uid with `last_seen`; touched while alive; GC after 14 days (`persist.py`) | Verbatim | Keep |
| P-63 | Projects section (`p`, persisted `projects_open`): 5 slots colored blue, purple, green, red, yellow; ↑ from the top session enters the slots; ⏎ or click edits; ⏎ saves, Esc cancels | Projects panel above the sessions list (same colors and order), same focus model (↑ from the top row, ⏎ to edit, click to edit) | Adapt |
| P-64 | `1`–`5` set the selected session's tab color to that project's color; `0` clears it; toasts `tab 2 → blue (api)`, `tab 2: color cleared`, `tab colors unavailable — see README` | Same keys, plus a project picker in the row context menu and drag-and-drop from a row onto a project chip. The "unavailable" toast links to onboarding step 2 | Keep + Improve |
| P-65 | `c` clear all 5 project names, confirmed `(y/n)` | Same, with an in-app confirm dialog | Adapt |
| P-66 | `n` new tab in the current iTerm2 window with the default profile, activates iTerm2; toast `opening new tab…` | Same | Keep |
| P-67 | `x` close tab, confirmed `Close tab N (label)? (y/n)`; closes by (window id, tab index) captured at confirm time | In-app confirm (y/⏎ confirms, n/Esc cancels). **Closes the tab containing the session uid** (looked up inside the AppleScript), so a tab reorder between confirm and close can't close the wrong tab | Improve |
| P-68 | `r` refresh: kick every poller; toast `refreshing…` | Same (`r`, ⌘R) | Keep |
| P-69 | `$` toggle dollar amounts, persisted; toast `Claude monthly dollar limit shown/hidden` | Same. The backend omits dollar values from the API unless `show_dollars` is on | Keep + Improve |
| P-70 | `u` usage screen; clicking the header opens usage | `u`, clicking the usage strip, ⌘U | Adapt |
| P-71 | Action failure toast `{kind} failed: {detail}` | Same text via the SSE `action` event | Keep |
| P-72 | Mouse: click selects, double-click goes to the session, wheel moves the selection one row per notch (90 ms coalescing), click on a project slot edits it | Native mouse: click, double-click, context menu, drag. The wheel **scrolls** (normal GUI behavior) instead of moving the selection | Improve |
| P-73 | `q` quits; Esc unwinds: text entry/confirm → overlay → filter → quit | Esc unwinds the same stack but never quits. `q` closes the window (the app stays in the menu bar; configurable), ⌘Q quits. In `--browser` mode `q` does nothing | Improve |

### 1.5 Persistence, config, ops

| ID | Ultrawatch behavior | Omniwatch equivalent | Status |
|----|---------------------|----------------------|--------|
| P-74 | `state.json`: `version, labels, view, sort, show_dollars, bell, split_ratio, projects[5], projects_open`; atomic write (tmp + `os.replace`), 2 s debounce, saved on quit, best-effort; unknown or invalid values normalized | Same mechanics in `~/.config/omniwatch/state.json` (`XDG_CONFIG_HOME` honored; `OMNIWATCH_CONFIG_DIR` overrides). New keys in §4.6 | Keep |
| P-75 | — | **Migration:** on first run with no Omniwatch state, import labels, projects, projects_open, view, sort, show_dollars, bell→sound, split_ratio from `~/.config/ultrawatch/state.json`, read-only. The Ultrawatch file is never written. Records `migrated_from_ultrawatch: <epoch>` | New |
| P-76 | Intervals in `config.py` (2/10/5/300/300/5 s, timeouts 10/3/5 s, toast 5 s, flash 1.5 s, fresh 30 s, label GC 14 d) | Same constants. Advanced overrides in `~/.config/omniwatch/config.json` (optional; §4.6) | Keep |
| P-77 | stderr redirected at the fd level to `~/.config/ultrawatch/stderr.log`, truncated each run, so it doesn't garble curses | Backend logs (Python `logging` + fd-2 redirect kept, because the `iterm2` package prints) go to `~/Library/Logs/Omniwatch/backend.log`; the previous run is kept as `.1`. Shell log: `shell.log` | Adapt |
| P-78 | Full repaint heartbeat (5 s), SIGWINCH handling, resize settle (`redraw.py`) | — | Drop: exists only because curses can drift out of sync with the terminal |
| P-79 | `UW_SCREENSHOT` / `UW_SCREENSHOT_AFTER` text dump; `tests/drive_tui.py` pty driver | Replaced by demo mode + Playwright screenshots (§6) | Drop (replaced) |
| P-80 | 256/8-color palette fallback (`theme.py`) | Replaced by design tokens (§2.6) | Drop |
| P-81 | `make test`, `make check` (tests + py_compile), `make dist` (zipapp), `make install-colors`, `make clean` | `make test`, `make check`, `make dist` (zipapp incl. web assets), `make app`, `make install`, `make install-colors`, `make e2e`, `make screenshots`, `make coverage`, `make clean` | Adapt |
| P-82 | Version `__version__ = '1.2.3'` shown on the title card | `omniwatch.__version__` shown in About, `/health`, and `omniwatch --version` | Adapt |
| P-83 | Keyboard synonyms: `j/k`, `g`, `,`/`.`, upper-case variants (`V`, `S`, `L`, `P`, `N`, `X`, `U`, `B`, `R`, `C`, `G`); `A` is case-sensitive (grid all) | Same keymap table (single source `web/js/keymap.js`) | Keep |

---

## 2. GUI design

### 2.1 Window layout (split view, default)

```
┌ Omniwatch — 2 waiting ─────────────────────────────────────────────── ● ● ● ┐
│ [◉ 2 waiting] 9 tabs · 4 agents   ⌕ Filter sessions…   Sort ▾  [▥ ☰ ▦]  ⚙   │  toolbar
├───────────────────────────┬──────────────────────────────────────────────────┤
│ PROJECTS            ✎  ⌫  │ ~/src/api-gateway · deploy-fix · Claude · ◉ 3m   │  preview header
│ ● 1 api   ● 2 billing …   │ ┌──────────────────────────────────────────────┐ │
├───────────────────────────┤ │ ╭────────────────────────────────────────╮   │ │
│ SESSIONS  sort: attention │ │ │ Bash command  npm test                 │   │ │
│ ─ Window 1 ───────────────│ │ │ Do you want to proceed?                │   │ │
│▌◉ Claude 1.1 ~/src/api  … │ │ │ ❯ 1. Yes                               │   │ │  monospace screen
│  ⠹ Claude 1.2 ~/src/bill… │ │ ╰────────────────────────────────────────╯   │ │
│  ○ Codex  1.4 ~/src/site  │ └──────────────────────────────────────────────┘ │
│  · zsh    1.3 ~/src/infra │ ┌ Reply ─ [1 Yes] [2 Yes, don't ask] [3 No…] ✎ ┐ │  quick reply (waiting only)
│                           │ live · updated 1s ago   [Go to ⏎] [Zoom ␣] [⋯]   │
├───────────────────────────┴──────────────────────────────────────────────────┤
│ Claude  Session 62% ▰▰▰▰▰▱▱▱ 2h 15m  Weekly 31% ▰▰▱▱▱▱ 5d 3h ⚠ pace: Fri 11am │  usage strip
│ Codex   7d 84% ▰▰▰▰▰▰▰▱ 1d 4h                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Toolbar** (in the web content, under a standard macOS title bar whose title carries the
  waiting count): waiting pill (amber when >0; click = next waiting), summary text, iTerm2
  status chip when not OK, search field, sort menu, view segmented control, settings.
- **Sidebar**: the collapsible Projects panel, then the session list (virtualized over 200
  rows). A row has a state icon, an agent chip, a tab-color dot, the tab label, the path
  (middle-truncated), the name/label pill, and the age. There's a context menu per row.
- **Preview**: header, screen pane, a reply bar when the session is waiting with parsed
  options, and a footer.
- **Usage strip**: one line per provider, meters colored by level, warnings inline;
  collapses to a single summary line.
- Minimum window size is 640×420. Below 900 px width split falls back to list (P-38). Window
  frame and view are restored.

### 2.2 Views

| View | Layout | Notes |
|------|--------|-------|
| Split | sidebar + preview | default; the divider is draggable and the keys step it |
| List | full-width table, sortable column headers, bottom preview drawer | columns: state, agent, tab, path, name/label, age, color |
| Grid | tile wall, `minmax(340px, 1fr)` columns, tile height 9 lines | agents-only unless `A`; waiting tiles get an amber 2 px border and sort to the top in attention sort |
| Zoom | overlay covering the body; toolbar stays | ↑/↓ changes session; Esc/Space exits |
| Usage | full-body panel (overlay state `usage`) | §2.4 |
| (P1) Board | columns Waiting · Busy · Idle · Other | §3 |

### 2.3 Components (web, `omniwatch/web/js/components/`)

`Toolbar`, `SummaryPill`, `StatusChip`, `SearchField`, `SortMenu`, `ViewSwitch`,
`ProjectsPanel` (+`ProjectSlot` with inline edit), `SessionList` (+`SessionRow`,
`WindowHeader`), `Preview` (+`PreviewHeader`, `ScreenPane`, `ReplyBar`, `PreviewFooter`),
`GridTile`, `UsageStrip`, `UsageView` (+`LimitCard`), `ToastStack`, `ConfirmDialog`,
`CommandPalette`, `ShortcutSheet`, `SettingsSheet`, `Onboarding`, `EmptyState`,
`ConnectionBanner`. Components are plain functions that build DOM from state (small
`h()` helper, keyed reconciliation for lists). No framework, no build.

### 2.4 Usage view

One card per limit: title ("Session · 5h"), big percentage, level-colored bar, "Resets in
2h 15m · Today at 5:59 pm" (countdown ticks client-side), and the pace warning ("On pace to
hit Friday at 11:00 am" in warn color / "Limit hit" in danger color). The monthly card shows
"$ hidden · press $" unless dollars are shown. The header says "Refreshed 2m ago" and has a
**Refresh** button. Error lines match P-51. No agents running: "No Claude Code or Codex
sessions running" plus a short explanation of gating.

### 2.5 Keyboard (full parity + GUI additions)

Bare keys apply when focus isn't in a text field. The table lives in `web/js/keymap.js` and
feeds the shortcut sheet, command palette, and hint bar, so there's one source.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| ↑ ↓ j k | move (grid: ± columns) | ← → | grid move |
| ⏎ | go to session / edit focused project | g | go to session |
| a | select next waiting | Space | zoom |
| v · ⌘1/⌘2/⌘3 | cycle view · split/list/grid | < > , . | resize split |
| / · ⌘F | filter | s | cycle sort |
| l | label | p | projects panel |
| 1–5 · 0 | set / clear tab color | c | clear projects (confirm) |
| n | new iTerm2 tab | x | close tab (confirm) |
| u · ⌘U | usage | $ | dollars |
| b | sound on attention | A | grid: all ↔ agents |
| r · ⌘R | refresh | ? · ⌘/ | shortcuts |
| Esc | unwind | q | close window |
| ⌘K | command palette | ⌘, | settings |
| i | focus reply field (waiting) | ⌥1–⌥9 | send reply option N (waiting) |
| ⌘+ / ⌘− / ⌘0 | text size | Tab / ⇧Tab | cycle focus region (toolbar, projects, list, preview) |

Global hotkey (app only, configurable, default ⌃⌥⌘O): show/hide Omniwatch. Second global
hotkey (default off): go to the next waiting session in iTerm2.

**Command palette (⌘K):** fuzzy search over every keymap action ("Sort: attention", "View:
grid", "Toggle dollars"…) and every session ("Go to ~/src/api · deploy-fix"). ⏎ runs the
item, ⌥⏎ selects the session without going to it. It uses the same fuzzy matcher, with
matched characters highlighted.

### 2.6 Theming tokens

`web/css/tokens.css` defines the variables. `:root[data-theme="dark"]`, `[data-theme="light"]`,
and `system` (a `prefers-color-scheme` media query) choose values. In the app, the web page
posts the resolved theme to native so `NSApp.appearance` matches the window chrome.

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--ow-bg` | `#0f1115` | `#f7f7f8` | window |
| `--ow-surface` | `#171a21` | `#ffffff` | panels |
| `--ow-surface-2` | `#1f232c` | `#f0f1f4` | hover, selected (unfocused) |
| `--ow-border` | `#2a2f3a` | `#dcdfe5` | dividers |
| `--ow-text` | `#e6e8ee` | `#1b1e24` | body |
| `--ow-text-muted` | `#8b93a3` | `#5d6573` | ages, hints |
| `--ow-claude` | `#d98ad9` | `#a3399f` | Claude chip/accent (Ultrawatch magenta lineage) |
| `--ow-codex` | `#5fafff` | `#1f6fd1` | Codex chip/accent |
| `--ow-attention` | `#ffb020` | `#b86e00` | waiting text, pill, border |
| `--ow-attention-bg` | `rgba(255,176,32,.14)` | `rgba(255,170,0,.16)` | waiting row tint |
| `--ow-fresh` | `#7fd48a` | `#1e8a3a` | fresh text |
| `--ow-fresh-bg` | `rgba(127,212,138,.12)` | `rgba(30,138,58,.10)` | fresh row tint |
| `--ow-busy` | `#7fd48a` | `#1e8a3a` | spinner, green usage |
| `--ow-warn` | `#ffb020` | `#9a6200` | yellow usage, pace |
| `--ow-danger` | `#ff6b6b` | `#c62828` | hit, close confirm |
| `--ow-selection` | `#2b4a7a` | `#d6e4ff` | selected row (focused) |
| `--ow-focus-ring` | `#6aa9ff` | `#2f6fe0` | keyboard focus |
| `--ow-tab-{red,orange,yellow,green,blue,purple,gray}` | iTerm2 preset RGBs (`itermcolor.PRESETS`) | same, 10 % darker for contrast on white | dots, project slots |
| `--ow-font-ui` | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | | |
| `--ow-font-mono` | `"SF Mono", ui-monospace, Menlo, monospace` | | preview |
| `--ow-radius` / `--ow-gap` | `8px` / `8px` | | |

Contrast target: WCAG AA (4.5:1) for text tokens on `--ow-surface` in both themes. The
`test_tokens` unit test computes the contrast ratios from `tokens.css`.

### 2.7 Accessibility

- The session list is `role="listbox"` with `aria-activedescendant`; the grid is `role="grid"`;
  every row has an accessible name like "Waiting 3 minutes, Claude Code, tab 1.1, ~/src/api,
  label deploy-fix".
- State is never conveyed by color alone (icon shape + text + aria).
- `aria-live="polite"` region for transitions and toasts; `assertive` only for errors.
- Full keyboard operation, visible focus rings, focus trapping in dialogs/palette.
- `prefers-reduced-motion` turns off the spinner, pulse, and smooth scroll;
  `prefers-contrast: more` switches to a higher-contrast token set; text scales with ⌘+/−
  (persisted `font_scale`).
- VoiceOver works through WKWebView's AX tree (spot-checked manually; axe-core is not
  bundled, but Playwright's `accessibility.snapshot()`/role locators are asserted in E2E).

### 2.8 Attention routing & notifications

On `transition` → WAITING (after debounce):
1. The row/tile pulses (P-31), a toast appears (P-32), and the sound plays if enabled (P-33).
2. **App:** the native shell (from its own SSE stream) posts a `UNUserNotification` titled
   "<title> needs you", with body = the prompt question or last meaningful line and actions
   **Go to session** / **Show in Omniwatch**. It's suppressed when Omniwatch is the key
   window and that session is visible, when the session is muted, or when notifications are
   off. Focus modes are honored by macOS.
3. **Browser mode:** Web Notification API when the page is hidden (permission requested from
   settings).
4. The dock badge and menu-bar title show the waiting count (`◉ 2`, amber template tint when
   >0).

### 2.9 Empty, error & permission states

| State (backend `iterm.status`) | UI |
|---|---|
| `connecting` | skeleton rows + "Connecting to iTerm2…" |
| `not_running` | "iTerm2 isn't running" + **Launch iTerm2** (`open -a iTerm`) |
| `not_authorized` (osascript error -1743 / "Not authorized to send Apple events") | Permission card: why, **Open Automation settings** (`x-apple.systempreferences:com.apple.preference.security?Privacy_Automation`), **Try again** |
| `error` | "iTerm2 query failed: <msg>" + Retry; stale data stays visible with the *Stale* chip |
| no sessions | "No iTerm2 sessions" + **New tab** |
| filter no match | "No sessions match “foo”" + Clear (Esc) |
| grid no agents | "No agent sessions — press A to show all" |
| backend disconnected | top banner "Reconnecting…" with exponential backoff (0.5→8 s); after 3 failed backend restarts (app) the native error view shows the log path |
| usage no creds | "Sign in to Claude Code to see limits" / "Codex auth not found" (P-15) |

### 2.10 First-run onboarding

A 3-step sheet (skippable, reopenable from Settings). Each step shows live status from
`GET /api/v1/diagnostics`:
1. **Control iTerm2** (required): explains the Automation prompt; **Grant access** calls
   `POST /diagnostics/probe-automation` (runs `tell application "iTerm2" to count windows`,
   which triggers the macOS prompt); shows ✓ once snapshots succeed.
2. **Tab colors & projects** (optional): checks that the `iterm2` package can be imported
   by the backend interpreter, with a copyable `make install-colors` command; explains
   iTerm2 › Settings › General › Magic › Enable Python API; ✓ when `capabilities.tab_colors`
   is `true`.
3. **Notifications** (app) / browser permission (browser mode).
There's also a **"Try the demo"** button that restarts the backend in demo mode, so a new
user sees a populated dashboard right away.

---

## 3. New & "wow" features

Chosen for someone running 5–20 agents across projects: the time they lose is the time
agents sit **blocked on them**, plus the cost of context-switching to find out what each
one wants.

### P0 — ship in v1

| Feature | Why | Size |
|---|---|---|
| **Native window + menu-bar counter + dock badge** | the headline: glanceable "who needs me" without a tab | in WP7 |
| **Native notifications with actions** (Go to session / Show) | attention routing that works when Omniwatch is hidden | in WP7 |
| **Quick reply** — the prompt's options (`❯ 1. Yes`, `2. Yes, and don't ask…`, Codex `Yes (y)`) become buttons in the preview; ⌥1–⌥9; free-text reply field. Uses AppleScript `write text` via argv. **Guarded:** only for agent sessions currently `waiting`, and the request must carry the `screen_hash` it was based on; the backend rejects with 409 if the screen has changed or the snapshot is >5 s old. Can be turned off in Settings | the biggest time saver: unblock an agent without switching tabs | moderate |
| **Mute session** (no notifications/sound/flash for it; still listed, dimmed icon) | noise control for long-running watchers | basic |
| **Keep window on top** toggle + compact width support (sidebar-only layout ≤420 px) | the typical setup is a small companion window beside iTerm2 | basic |
| **Command palette** (⌘K) | discoverability for 30+ actions | routine |
| **Dark / light / system theme** | stated goal | in WP4 |
| **Demo mode + first-run showcase** | lets people try it with zero setup; the same data drives tests and screenshots | in WP3 |
| **Launch iTerm2 / permission diagnostics** (`omniwatch doctor` + onboarding) | removes the top two "it shows nothing" support issues | routine |
| **Ultrawatch migration** (labels, projects, prefs) | existing users keep their setup | basic |

### P1 — next release

| Feature | Why |
|---|---|
| **Activity timeline** per session: busy/waiting/idle ribbon over the last 1–8 h (engine ring buffer of transitions, `GET /sessions/{uid}/history`), shown under each grid tile and in the preview header | see at a glance which agent has been stuck, and for how long |
| **"Blocked on you" stats**: today's total agent-minutes spent waiting, and the longest single wait | makes the cost of attention visible; strong screenshot |
| **Stall detection**: busy with an unchanged hash for > N min (default 10) → "Stalled?" chip + optional notification | catches hung tools / infinite loops |
| **Board view** (Waiting · Busy · Idle · Other columns) | triage layout for many agents |
| **Notification quick-reply actions** (answer "1"/"y" from the banner, same hash guard) | unblock without opening anything; P1 because a mis-tap from a banner is riskier |
| **Usage history & burn rate** (local sqlite-free JSONL at `~/.config/omniwatch/usage-history.jsonl`, sparkline per limit, "at this rate: 100 % at 3:40 pm") | the pace warning becomes a chart |
| **Open in… / Reveal** (Finder, editor via `$EDITOR`/`code`, copy path) — path resolved server-side from the session, never taken from the client | quick jump into the repo an agent is editing |
| **Search screen text** (filter toggle "also match screen contents") | "which agent printed that error?" |
| **Data-driven agent registry** (`agents.json`: process matchers + rule tables; built-ins for Claude Code, Codex; add Gemini CLI, Aider, OpenCode) | future-proofs the heuristics that the README says need maintenance |
| **Launch at login** (LaunchAgent plist; `SMAppService` if it works for ad-hoc builds) | companion apps should just be there |
| **Menu-bar-only mode** (no dock icon) | preference |
| **iTerm2 plugin** (§4.8) | instant focus/tab-color events, status-bar counter inside iTerm2 |

### P2 — later / exploratory

- ANSI-colored previews (needs the iTerm2 Python API's styled screen contents; I haven't
  confirmed the API exposes per-cell style cheaply).
- Push to phone when a wait exceeds N minutes (ntfy/Pushover webhook, opt-in, external
  sends).
- Read-only LAN/phone view (needs TLS + pairing; security review first).
- Session recipes: "new tab in project X running `claude`" (AppleScript `write text` into
  the new tab).
- Homebrew cask with signed/notarized builds and auto-update.

---

## 4. Architecture

### 4.1 Repository layout

```
omniwatch-for-iterm2/
├── omniwatch/                     # Python backend package (stdlib only, 3.9+)
│   ├── __init__.py                # __version__
│   ├── __main__.py                # python -m omniwatch → cli.main()
│   ├── cli.py                     # serve | --browser | demo | doctor | --version
│   ├── config.py                  # constants, paths, env overrides, config.json loader
│   ├── snapshot.py                # immutable snapshot dataclasses          (verbatim)
│   ├── iterm.py                   # AppleScript scripts + parsers + actions (near-verbatim)
│   ├── agents.py                  # ps/lsof agent + cwd detection           (verbatim)
│   ├── heuristics.py              # classifier, debounce tracker            (verbatim + extract_prompt)
│   ├── itermcolor.py              # optional iterm2 API colors              (verbatim)
│   ├── usage_claude.py            # fetch (verbatim) + structured limits()
│   ├── usage_codex.py             # fetch/merge (verbatim) + structured limits()
│   ├── projection.py              # pace math → structured                  (adapted)
│   ├── timefmt.py                 #                                         (verbatim)
│   ├── persist.py                 # StateStore + new keys + migration       (adapted)
│   ├── notifier.py                # quota-email eligibility + draft URL      (adapted: no dialog)
│   ├── pollers.py                 # threads; providers injected             (near-verbatim)
│   ├── providers.py               # Provider protocol + real implementations
│   ├── engine.py                  # NEW: replaces ui/app.py's model & dispatch
│   ├── views.py                   # NEW: session/usage/state JSON serializers (pure)
│   ├── textutil.py                # tail_lines, strip_chrome, fuzzy (Python side, for notifications/tests)
│   ├── server.py                  # NEW: ThreadingHTTPServer, routes, static files
│   ├── sse.py                     # NEW: SSE hub (per-client queues, heartbeat)
│   ├── security.py                # NEW: token, cookie, Host/Origin checks
│   ├── runtime.py                 # NEW: runtime.json discovery file (0600)
│   ├── logs.py                    # replaces quiet.py: log file + fd-2 redirect
│   ├── demo/
│   │   ├── __init__.py
│   │   ├── scenario.py            # scripted timeline, deterministic clock
│   │   ├── providers.py           # FakeIterm, FakeAgents, FakeUsage, FakeColors
│   │   ├── usage_payloads.py      # API-shaped fake payloads
│   │   └── screens/*.txt          # realistic Claude/Codex/shell screens
│   └── web/                       # static UI, served by server.py (inside the package so the zipapp carries it)
│       ├── index.html
│       ├── css/{tokens.css, app.css}
│       ├── js/{main.js, store.js, reducer.js, api.js, sse.js, keymap.js, commands.js,
│       │       fuzzy.js, sort.js, format.js, preview.js, dom.js, native.js}
│       ├── js/components/*.js
│       └── assets/{logo.svg, icons.svg}
├── shell/                         # Swift AppKit shell (swiftc, no SwiftPM/Xcode)
│   ├── Core/                      # pure Foundation logic — unit-tested
│   │   ├── BackendProcess.swift   # spawn/supervise python, ready-line handshake
│   │   ├── ReadyLine.swift        # parse {"event":"ready",…}
│   │   ├── SSEParser.swift        # incremental text/event-stream parser
│   │   ├── EventStreamClient.swift# URLSession SSE with reconnect
│   │   ├── Models.swift           # Codable Summary/Transition
│   │   ├── PythonLocator.swift    # interpreter discovery rules
│   │   ├── RestartPolicy.swift    # backoff/limit
│   │   └── BadgeFormatter.swift   # "", "3", "99+"
│   ├── App/                       # AppKit/WebKit glue — compile-checked, self-test
│   │   ├── main.swift, AppDelegate.swift, WindowController.swift,
│   │   ├── WebBridge.swift, StatusItemController.swift, Notifications.swift,
│   │   └── HotKey.swift, Menus.swift, SelfTest.swift
│   ├── Resources/{Info.plist, Omniwatch.icns}
│   ├── Tests/{TestMain.swift, *Tests.swift}   # tiny assert harness, swiftc-compiled
│   └── build.sh                   # swiftc → Omniwatch.app, ad-hoc codesign
├── plugin/iterm2/omniwatch_status.py          # optional AutoLaunch script (later phase)
├── tests/                         # Python unittest (+ _support.py tripwires)
│   └── fixtures/                  # screens + payloads shared with JS tests
├── web-tests/
│   ├── package.json               # devDependency @playwright/test (pinned); nothing else
│   ├── unit/*.test.mjs            # node --test
│   ├── e2e/*.spec.mjs             # Playwright (chromium + webkit, headless)
│   └── playwright.config.mjs
├── scripts/{screenshots.mjs, make-icon.sh, golden_sort.py}
├── packaging/homebrew/{omniwatch.rb.tmpl}
├── docs/{DESIGN.md, USER_GUIDE.md, API.md, TROUBLESHOOTING.md, screenshots/}
├── install.sh · uninstall.sh · Makefile · README.md · CHANGELOG.md · LICENSE (MIT © Eric Burns)
```

### 4.2 Backend: what ports how

| Module | Change |
|---|---|
| snapshot, agents, timefmt, itermcolor | verbatim (rename the package imports) |
| heuristics | verbatim + `extract_prompt(kind, text) -> {question, options:[{key,label,selected}], free_text} or None` (Claude: `❯? N. text` lines inside the last box; Codex: `Yes (y)` / `No (n)` style lines) + `SessionTracker.history(uid)` ring buffer (maxlen 256, P1 uses it) |
| iterm | verbatim scripts + `WRITE_TEXT_SCRIPT` (argv: uid, text, newline flag; `write text … newline NO` for single-key replies), `CLOSE_SESSION_TAB_SCRIPT` (by uid), `PROBE_SCRIPT`; `run_osascript` maps `-1743` / "Not authorized" → `ItermNotAuthorized` |
| pollers | verbatim threading model; `ItermWorker` gains actions `reply`, `close_uid`, `probe`; all pollers take a `providers` object (real or demo) instead of importing modules directly |
| usage_claude / usage_codex | fetch unchanged; `*_rows` replaced by `limits(usage, show_dollars, now) -> [Limit]` (§4.4); the old row functions stay as thin wrappers so the ported tests keep passing |
| projection | returns `{"kind": "hit"|"pace", "at": epoch|null, "text": str}`; string-tuple API kept as a wrapper for the ported tests |
| persist | same StateStore; new DEFAULTS; `migrate_from_ultrawatch(path)`; validation whitelist for `PATCH /prefs` |
| notifier | `check(pct) -> QuotaPrompt|None` (same config/flag/threshold/once-a-month rules); `draft_url(cfg)`; `mark_notified()`. No osascript dialog. The engine emits a `quota` event; `POST /quota-email/draft` opens the URL with `open` (skipped in demo) |
| config | + `OMNIWATCH_CONFIG_DIR`, `OW_DEBUG_STATE`/`UW_DEBUG_STATE`, `OMNIWATCH_DEMO`, log dir, `config.json` overrides (intervals, hotkeys, fresh seconds) |
| ui/* , theme, redraw, quiet | dropped; model logic from `ui/app.py` (`agent_kinds`, `tab_label`, `window_number`, `session_path`, `row_title`, visit/next-waiting, transition handling) moves into `engine.py`/`views.py`; sort, filter, and fuzzy move to JS; `draw.tail_lines`/`_is_chrome`/`fuzzy_match`/`age_str` are ported to both `textutil.py` and `web/js/preview.js`/`fuzzy.js`/`format.js` and tested against shared fixtures |

**Engine threading.** Pollers post to `events: Queue` exactly as before. One `engine` thread
takes the place of the curses UI thread: it drains events, owns `SessionTracker` and
`StateStore` (still single-threaded), applies commands from `commands: Queue`, and after
each change builds an immutable published document (`views.build_state`) under a lock, then
diffs it against the previous one to emit SSE events. HTTP handler threads never touch the
tracker or store. They read the published document or enqueue a command and (for sync
commands like `label`) wait on a `concurrent.futures.Future` for up to 2 s.

### 4.3 CLI

```
omniwatch                         # app installed → `open -a Omniwatch`; else same as --browser
omniwatch --browser               # serve + open the default browser at the auth URL
omniwatch demo                    # serve --demo --browser (ephemeral config dir)
omniwatch serve [--port 0] [--demo] [--demo-scenario NAME] [--demo-seed N] [--demo-clock EPOCH]
                [--config-dir DIR] [--ready-json] [--parent-pid PID] [--log-file PATH] [--no-open]
omniwatch doctor                  # print diagnostics (python, iterm2 pkg, automation, creds)
omniwatch --version
```

`--ready-json` prints exactly one line to stdout once the socket is listening:
`{"event":"ready","port":53817,"token":"<43 chars>","pid":1234,"version":"1.0.0","demo":false}`.

### 4.4 HTTP API (v1)

Base `http://127.0.0.1:<port>`. All `/api/*` routes require auth (§4.5). JSON only, UTF-8.
Errors: `{"ok":false,"error":{"code":"not_found","message":"…"}}` with codes 400
`bad_request`, 401 `unauthorized`, 403 `forbidden` (Host/Origin), 404 `not_found`, 409
`conflict` (stale reply), 422 `invalid`, 503 `iterm_unavailable`. Actions that go through
the iTerm worker return **202** `{"ok":true,"action_id":"a-17"}`; the result arrives as an
SSE `action` event.

| Method & path | Body | Response / notes |
|---|---|---|
| `GET /` · `/css/*` · `/js/*` · `/assets/*` | — | static files (via `pkgutil.get_data`, so they load from the zipapp); CSP header |
| `GET /auth?token=T` | — | sets cookie, 302 → `/` (the only unauthenticated route besides static files) |
| `GET /api/v1/health` | — | `{ok, version, demo, pid, uptime_s}` |
| `GET /api/v1/state` | — | full **State** (below) |
| `GET /api/v1/events` | — | SSE stream (§4.4.2) |
| `GET /api/v1/summary` | — | `{tabs, agents, waiting, busy, waiting_sessions:[{uid,title,since,agent}]}` for the menu bar/plugin |
| `GET /api/v1/diagnostics` | — | `{python:{path,version}, iterm:{status,error}, automation:"ok"|"denied"|"unknown", tab_colors:{package:bool, reachable:bool|null}, claude_credentials:bool, codex_credentials:bool, config_dir, log_path}` |
| `POST /api/v1/diagnostics/probe-automation` | — | 202 |
| `POST /api/v1/sessions/{uid}/goto` | — | 202 |
| `POST /api/v1/sessions/{uid}/visit` | — | 200 (clears attention) |
| `PUT /api/v1/sessions/{uid}/label` | `{"label":"deploy-fix"}` (`""` removes) | 200 `{label}` |
| `PUT /api/v1/sessions/{uid}/color` | `{"project":1..5}` or `{"color":"blue"}` or `{"color":null}` | 202; 503 `tab_colors_unavailable` if capability false |
| `PUT /api/v1/sessions/{uid}/mute` | `{"muted":true}` | 200 |
| `POST /api/v1/sessions/{uid}/close` | `{"confirm":true}` | 202; 400 without confirm |
| `POST /api/v1/sessions/{uid}/reply` | `{"text":"1","submit":false,"expect_hash":"9f3a01bc"}` | 202; 409 `stale_screen` if the hash differs or the snapshot is >5 s old; 422 if not an agent session in `waiting`; text ≤ 2000 chars, control chars rejected except `\n` |
| `POST /api/v1/tabs/new` | — | 202 |
| `POST /api/v1/iterm/launch` | — | 202 (`open -a iTerm`) |
| `POST /api/v1/refresh` | — | 200 (kick all) |
| `GET /api/v1/prefs` · `PATCH /api/v1/prefs` | partial prefs | 200 full prefs; whitelist + type validation |
| `PUT /api/v1/projects/{n}` | `{"name":"api"}` | 200 |
| `DELETE /api/v1/projects` | `{"confirm":true}` | 200 (clear all 5) |
| `POST /api/v1/quota-email/draft` · `/skip` | — | 200 |
| `POST /api/v1/shutdown` | — | 200 then clean exit (used by the shell) |
| *demo only* `POST /api/v1/demo/step` | `{"seconds":2}` | advance the fake clock + scenario, poll synchronously, 200 with the new `seq` |
| *demo only* `POST /api/v1/demo/scenario` | `{"name":"busy-morning"}` | reset to a scenario |

#### 4.4.1 JSON shapes

**State**
```json
{
  "version": "1.0.0", "seq": 812, "server_time": 1790000000.12, "demo": false,
  "iterm": {"status": "ok", "error": "", "last_poll_at": 1790000000.0, "poll_ms": 240, "stale": false},
  "summary": {"tabs": 9, "agents": 4, "waiting": 2, "busy": 1,
              "waiting_uids": ["A1…", "B2…"]},
  "windows": [{"id": 104, "number": 1}, {"id": 311, "number": 2}],
  "sessions": [Session, …],
  "screens": {"<uid>": {"hash": "9f3a01bc", "text": "…full screen text…"}},
  "usage": {"claude": UsageBlock, "codex": UsageBlock},
  "prefs": Prefs,
  "projects": [{"slot": 1, "name": "api", "color": "blue"}, {"slot": 2, "name": "", "color": "purple"},
               {"slot": 3, "name": "", "color": "green"}, {"slot": 4, "name": "", "color": "red"},
               {"slot": 5, "name": "", "color": "yellow"}],
  "capabilities": {"tab_colors": true, "reply": true, "debug_rule": false},
  "quota_prompt": null
}
```

**Session** (natural order; screen text lives in `screens`, not here)
```json
{
  "uid": "AAAAAAAA-0002-4AAA-8AAA-000000000002",
  "window_id": 104, "window_number": 1, "tab_index": 2, "session_index": 1, "tab_label": "1.2",
  "tty": "/dev/ttys001", "name": "✳ Refactor parser", "is_processing": false,
  "path": "/Users/me/src/billing", "path_display": "~/src/billing",
  "agent": "claude", "agents": ["claude"],
  "state": "waiting", "state_since": 1789999820.0, "rule": "menu-option",
  "attention": true, "last_change": 1789999990.4, "fresh_until": null,
  "label": "refactor", "display_name": "refactor", "title": "refactor",
  "tab_color": "blue", "project": 1, "muted": false, "is_dashboard": false,
  "screen_hash": "9f3a01bc",
  "prompt": {"question": "Do you want to proceed?",
             "options": [{"key": "1", "label": "Yes", "selected": true},
                         {"key": "2", "label": "Yes, and don't ask again for npm test commands", "selected": false},
                         {"key": "3", "label": "No, and tell Claude what to do differently (esc)", "selected": false}],
             "free_text": false}
}
```
`state` ∈ `busy|waiting|idle|active|quiet|null`. `rule` is included only when
`capabilities.debug_rule`. `project` is the slot whose color equals `tab_color`, if any.

**UsageBlock**
```json
{
  "status": "ok", "fetched_at": 1789999700.0, "stale_since": null,
  "limits": [
    {"id": "claude.five_hour", "label": "Session", "window": "5h", "pct": 62.0, "level": "yellow",
     "resets_at": 1790008140, "reset_text": "2h 15m (Today at 5:59pm)",
     "projection": {"kind": "pace", "at": 1790006400, "text": "on pace to hit session limit Today at 5:30pm"}},
    {"id": "claude.monthly", "label": "Monthly cap", "window": "month", "pct": 91.0, "level": "red",
     "resets_at": 1790812800, "reset_text": "9d 6h (Oct 1 at 12:00am)", "has_cap": true,
     "limit_display": null, "projection": null}
  ]
}
```
`status` ∈ `ok|inactive|error|stale|no_credentials`: `stale` = the last fetch failed but
last-good data is present (`stale_since` set); `error` = failed with no data.
`limit_display` (e.g. `"$200"`) is non-null only when `prefs.show_dollars`.

**Prefs** (persisted; `PATCH`-able unless marked)
```json
{"view": "split", "sort": "natural", "show_dollars": false, "sound": false, "split_ratio": 0.42,
 "projects_open": false, "grid_all": false, "usage_strip": "expanded", "theme": "system",
 "font_scale": 1.0, "notifications": {"enabled": true, "click": "goto"}, "quick_reply": true,
 "keep_on_top": false, "close_window_on_q": true, "hint_bar": true, "debug_rule": false,
 "onboarding_done": false}
```

#### 4.4.2 SSE contract (`GET /api/v1/events`)

Each message is `id: <seq>`, `event: <type>`, `data: <json>`. On connect (or reconnect with
`Last-Event-ID`) the server always sends `hello` then a full `state`; clients never have to
replay a gap. Comment heartbeat `: ping` every 15 s. Per-client queue bounded at 256; a
client that falls behind is dropped (it reconnects and gets a full state).

| event | data | when |
|---|---|---|
| `hello` | `{version, server_time, demo}` | on connect |
| `state` | State | on connect |
| `sessions` | `{seq, sessions, summary, windows, iterm}` | after any iTerm/agents/paths/colors update whose serialized sessions changed |
| `screens` | `{seq, screens:{uid:{hash,text}}, removed:[uid]}` | only uids whose **raw** text changed (so spinners animate) |
| `usage` | `{seq, usage}` | usage snapshot or `show_dollars` change |
| `prefs` | `{seq, prefs, projects}` | any pref/project change (all clients stay in sync) |
| `transition` | `{uid, from, to, at, title, agent, prompt, muted}` | each published tracker transition |
| `toast` | `{level:"info"|"warn"|"error", message}` | server-originated toasts (`refreshing…`, etc.) |
| `action` | `{id, kind, uid, ok, detail}` | iTerm worker action results |
| `quota` | `{pct, to}` | quota email becomes eligible |
| `capabilities` | Capabilities | tab-color availability changes |

The client reducer (`web/js/reducer.js`) is a pure `(state, event) → state` function; the
same fixtures exercise it in node tests.

### 4.5 Security

- Binds **only** `127.0.0.1` (not configurable in v1). The port defaults to 0 (random);
  `--port` for development.
- Per-launch token: `secrets.token_urlsafe(32)`. Accepted as `Authorization: Bearer T` (shell
  SSE client, plugin, curl) or as cookie `ow_session=T; HttpOnly; SameSite=Strict; Path=/`,
  set by `GET /auth?token=T` → 302 (needed because `EventSource` can't send headers). The
  token is never put in the page, and the URL fragment is stripped by the redirect.
  Comparison uses `hmac.compare_digest`.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding
  defense). Non-GET requests must have `Origin` equal to that origin or absent with a
  Bearer token (CSRF). No CORS headers are ever sent.
- CSP: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
  connect-src 'self'; frame-ancestors 'none'`. Screen text is always inserted as text
  nodes, never `innerHTML`.
- There's no endpoint that takes a path, URL, or shell command from the client. Actions
  reference session uids that the backend resolves; the Gmail URL comes from the user's
  own config file.
- `~/.config/omniwatch/runtime.json` (mode 0600, removed on exit):
  `{"port":53817,"token":"…","pid":1234,"version":"1.0.0","started_at":…}` — for the
  plugin and the CLI (`omniwatch` reuses a running backend instead of starting a second
  one).
- Reply is the one input-injection path: agent + waiting + fresh hash + length/control-char
  limits + a Settings kill switch.

### 4.6 Config & state paths

| Path | Content |
|---|---|
| `~/.config/omniwatch/state.json` | Prefs + `labels` + `projects` + `muted` + `version:2` + `migrated_from_ultrawatch` |
| `~/.config/omniwatch/config.json` (optional, user-edited) | `{"intervals":{"snapshot":2,"paths":10,"agents":5,"usage":300,"colors":5}, "fresh_seconds":30, "python": "/opt/homebrew/bin/python3", "hotkeys":{"toggle":"ctrl+opt+cmd+o","next_waiting":null}}` |
| `~/.config/omniwatch/runtime.json` | discovery (§4.5) |
| `~/Library/Logs/Omniwatch/{backend.log,backend.log.1,shell.log}` | logs |
| `~/.claude/quota-email/{config.json,.last-email-sent}` | unchanged, shared with Ultrawatch |
| `~/.config/ultrawatch/state.json` | read once for migration, never written |

`XDG_CONFIG_HOME` is honored; `OMNIWATCH_CONFIG_DIR` overrides everything (tests, demo).
Demo mode always uses a fresh temp dir unless `--config-dir` is given.

### 4.7 Process lifecycle (Swift shell ↔ Python backend)

1. **Locate Python** (`PythonLocator`): `config.json.python` → `OMNIWATCH_PYTHON` →
   `Contents/Resources/python-path` (written by `install.sh`) → `/opt/homebrew/bin/python3`,
   `/usr/local/bin/python3`, `/usr/bin/python3`. It takes the first that is ≥3.9, preferring
   one that can `import iterm2` (tab colors). Probing uses `-c` with a 3 s timeout.
2. **Spawn** `python3 Resources/omniwatch.pyz serve --ready-json --parent-pid <pid>
   --log-file ~/Library/Logs/Omniwatch/backend.log` with stdin = a pipe the shell keeps
   open. The backend exits when stdin hits EOF or the parent pid changes (checked every 2 s),
   so a crashed shell never leaves an orphan.
3. **Handshake**: read one stdout line within 10 s → `ReadyLine`. The WKWebView loads
   `http://127.0.0.1:<port>/auth?token=<t>`. The native `EventStreamClient` connects to
   `/api/v1/events` with a Bearer token and drives the badge, menu bar, and notifications
   whether or not the window is visible.
4. **Supervise**: on unexpected exit, restart with backoff 1 s, 2 s, 5 s. More than 3
   restarts in 60 s → native error view (log path, **Retry**, **Open log**).
5. **Quit** (⌘Q, menu): `POST /shutdown` → wait 2 s → SIGTERM → wait 2 s → SIGKILL. The
   backend's shutdown saves state (P-74) and removes runtime.json.
6. **Bridge**: native → web: `evaluateJavaScript("window.omniwatch.command('view.grid')")`
   for menu items and hotkeys. Web → native: `webkit.messageHandlers.omniwatch.postMessage(
   {type:"theme",value:"dark"} | {type:"notifyPermission"} | {type:"keepOnTop",value:true})`.
   Navigation to any non-`127.0.0.1` URL is cancelled and opened with `NSWorkspace`.
7. **TCC**: Apple Events are attributed to Omniwatch.app as the responsible process, so
   `Info.plist` sets `NSAppleEventsUsageDescription`. I believe the prompt then reads
   "Omniwatch wants to control iTerm2", but I haven't confirmed it for a python child of an
   ad-hoc app. WP7's acceptance includes a manual check. `NSAllowsLocalNetworking` is set
   for ATS.
8. `--self-test` (headless): `setActivationPolicy(.prohibited)`, no windows. It spawns the
   backend with `--demo`, completes the handshake, receives `hello`+`state` over SSE, checks
   `summary.waiting > 0`, POSTs `/shutdown`, verifies the child exited, and exits 0/1. This
   is how CI-style tests cover the lifecycle without any UI.

### 4.8 iTerm2 plugin (later phase, optional)

`plugin/iterm2/omniwatch_status.py`, installed by `make install-plugin` into
`~/Library/Application Support/iTerm2/Scripts/AutoLaunch/`. It uses the `iterm2` package and
needs the Python API enabled.
- **Status-bar component** "Omniwatch": `◉ 2 waiting` (hidden at 0). Reads
  `runtime.json`, polls `GET /api/v1/summary` every 2 s with Bearer. Clicking it posts to
  `/sessions/{next}/goto`. If there's no backend, it shows `Omniwatch off` and a click runs
  `open -a Omniwatch`.
- **Event push** (optional toggle): `FocusMonitor` → `POST /api/v1/plugin/focus
  {"uid":…}`, so visiting a waiting session in iTerm2 clears its attention (new behavior),
  and tab-color changes are pushed instead of polled every 5 s.
- The backend endpoint `/api/v1/plugin/focus` ships in v1 (tiny); the plugin itself is WP10.

---

## 5. Test strategy

**Rule: no test may open a window, activate an app, send Apple Events, touch the real
Keychain/network, or write outside a temp dir.** It's enforced, not assumed:

- `tests/_support.py` `TripwireTestCase` patches `subprocess.run`/`Popen`/`os.system`,
  `urllib.request.urlopen`, and `webbrowser.open` to raise `TripwireError`, unless a test
  installs a fake. `OMNIWATCH_CONFIG_DIR` points at a `tempfile.TemporaryDirectory`. Every
  test class derives from it; a meta-test fails if one doesn't.
- `OMNIWATCH_DEMO=1` or `--demo` makes the real `run_osascript`, `security`, and `open`
  raise. Demo mode can't reach iTerm2 even by mistake.
- Playwright runs `headless: true` only (the config refuses `--headed` unless
  `OW_ALLOW_HEADED=1`). The Swift self-test uses `.prohibited` activation. Nothing takes
  screenshots of the real screen; doc screenshots are rendered by Playwright from demo
  mode.

**The fake iTerm/osascript seam.** Every external effect goes through `providers.py`:

```python
class Providers:            # real: RealProviders(); tests/demo: FakeProviders(...)
    iterm: ItermProvider    # snapshot(at) -> ItermSnapshot; paths(at); goto(uid); close_uid(uid);
                            # new_tab(); reply(uid, text, submit); probe(); launch()
    agents: AgentsProvider  # scan() -> {tty:{agents}}; fill_cwds(ttys) -> {tty:cwd}
    usage_claude / usage_codex: UsageProvider   # fetch() -> (data|None, retry_after|None)
    colors: ColorsProvider  # fetch() -> {uid:name}; set(uid, name|None)
    opener: Opener          # open_url(url); open_app(name)
    clock: Clock            # time(), monotonic(), sleep()  (fake clock in demo/tests)
```

`RealProviders` wraps the ported functions (their `run=` injection points stay, so the
ported parser tests keep working unchanged). `FakeItermProvider` records every action call
for assertions and mutates its sessions (for example, a goto marks the session focused, a
reply advances the scripted screen).

**Demo data** (`omniwatch/demo/`): scenario `default` has 2 windows, 11 sessions: 3 Claude (one
waiting on a Bash permission prompt, one busy with a spinner, one idle 22 m), 2 Codex (one
approval prompt, one working), a `tail -f` log (active), a quiet shell, an Ultrawatch
instance (dashboard badge), labels, 3 tab colors matching named projects, usage at
62 %/31 %/sonnet 12 %/monthly 91 % with a cap (quota prompt eligible), and Codex 5h 40 % /
7d 84 %. The timeline is scripted (e.g. t+6 s the busy Claude flips to waiting). `--demo-seed`
jitters ages; `--demo-clock` freezes time for screenshots. `demo/step` advances it
deterministically in E2E tests. Other scenarios: `empty`, `not-running`, `not-authorized`,
`many` (60 sessions, for scrolling/virtualization/perf), `usage-errors`.

| Layer | Runner | Scope | Target |
|---|---|---|---|
| Python unit | `python3 -m unittest discover -s tests` | all 163 ported Ultrawatch tests (adapted imports) + new: engine transitions/commands, views serializers, extract_prompt fixtures, persist migration, security (token/host/origin/cookie), server routes (real `ThreadingHTTPServer` on port 0 in-thread, `http.client`), SSE framing/heartbeat/backpressure, runtime.json perms, notifier without dialog, demo scenario determinism, CLI arg parsing | **≥90 % line** for `omniwatch/` overall; **≥95 %** for heuristics, projection, engine, views, security, persist |
| Python coverage | `make coverage` → `python3 -m coverage run -m unittest …` | `coverage` isn't installed here; it's a dev-only `pip install coverage` (documented). Without it, `make coverage` prints how to install and exits non-zero rather than faking a number | as above |
| JS unit | `node --test web-tests/unit/` (Node 20) | fuzzy, sort (vs a Python-generated golden file), format (ages, countdowns), preview (tail/strip chrome vs shared fixtures), reducer (every SSE event), keymap (every P-row key → command), command palette ranking, token contrast | **≥90 % line** via `node --test --experimental-test-coverage` |
| E2E | `npx playwright test` (chromium **and** webkit — WebKit is close to WKWebView), global setup spawns `python3 -m omniwatch serve --demo --ready-json --demo-clock …` | one spec per GUI area; every P-row that is user-visible has a test tagged `@P-xx` (a script checks that every non-Drop P-ID appears in a unit or E2E test); keyboard parity table driven from `keymap.js`; themes (dark/light/system via `colorScheme`); a11y roles; reconnect after backend restart; quick-reply 409 path | all non-Drop P-IDs covered |
| Swift logic | `make swift-test` → `swiftc shell/Core/*.swift shell/Tests/*.swift -o build/swift-tests && build/swift-tests` | ReadyLine, SSEParser (chunk boundaries, multi-line data, comments, ids), RestartPolicy, PythonLocator (injected filesystem/probe), BadgeFormatter, Models decoding from real backend JSON fixtures | every public Core function exercised; optional `llvm-cov` report (CLT ships `llvm-cov`/`llvm-profdata`) |
| Swift app | `make app` (full compile) + `Omniwatch.app/Contents/MacOS/Omniwatch --self-test` | compile check of AppKit/WebKit glue; headless lifecycle test (§4.7.8) | passes |
| Packaging | `make check-install` → `install.sh --prefix $(mktemp -d) --no-open` | layout, shim runs `--version`, app bundle has `Info.plist` keys, codesign verifies | passes |

Note on Swift tooling: in this environment SwiftPM can't link manifests (the `swift test`
manifest link fails with an undefined `PackageDescription.Package.__allocating_init`), and
CLT has no XCTest. So Swift tests are a plain `swiftc`-built executable with a ~40-line
assert harness (`TestMain.swift`: `check(_:_:file:line:)`, per-test isolation, a count
summary, and exit code). I verified the plain-`swiftc` approach compiles and runs here.

`make test` = Python unit + JS unit + Swift logic (fast, no browsers). `make e2e` =
Playwright. `make check` = test + py_compile + `make app` + self-test.

---

## 6. Packaging, install, docs & screenshots

**Artifacts** (`make dist`):
- `dist/omniwatch` — zipapp (`python3 -m zipapp`, shebang `/usr/bin/env python3`)
  containing `omniwatch/` including `web/`. Static files are read with `pkgutil.get_data`,
  so the zipapp is self-contained.
- `dist/Omniwatch.app` — `shell/build.sh`: `swiftc -O -target arm64-apple-macos13
  -framework AppKit -framework WebKit -framework UserNotifications -framework Carbon
  shell/Core/*.swift shell/App/*.swift`, plus a universal build via `-target
  x86_64-apple-macos13` and `lipo` (optional flag). Bundle: `Contents/MacOS/Omniwatch`,
  `Contents/Resources/{omniwatch.pyz, Omniwatch.icns, python-path}`, `Info.plist`
  (`CFBundleIdentifier com.burnsbert.omniwatch`, `LSMinimumSystemVersion 13.0`,
  `NSAppleEventsUsageDescription`, `NSAppTransportSecurity.NSAllowsLocalNetworking`). Then
  `codesign --force -s - --identifier com.burnsbert.omniwatch`. The icon is generated from
  `assets/logo.svg` by `scripts/make-icon.sh` (headless Playwright render → `sips` →
  `iconutil`), and the `.icns` is committed so a normal build doesn't need node.

**Install** (one command, no sudo):
```bash
git clone https://github.com/burnsbert/omniwatch-for-iterm2 && cd omniwatch-for-iterm2 && ./install.sh
```
`install.sh [--prefix DIR] [--no-app] [--with-colors] [--no-open]`: checks macOS, python
≥3.9, and `swiftc` (if it's missing, offers `xcode-select --install` or `--no-app`
browser-only mode). It builds the dist, copies `Omniwatch.app` → `~/Applications/`, and
installs the `omniwatch` shim → `~/.local/bin` (warning if that isn't on PATH). It records
the chosen python, optionally runs `install-colors`, and opens the app. It's idempotent;
`./uninstall.sh` reverses it (leaving config unless `--purge`). Homebrew (later):
`packaging/homebrew/omniwatch.rb.tmpl` is a tap formula that builds from source on the
user's machine with CLT (so there's no Gatekeeper/notarization problem) and uses `post_install`
to link the app to `~/Applications`. A cask needs signed/notarized releases (P2).

**Docs**: `README.md` (hero screenshot dark + light via `<picture>` with
`prefers-color-scheme`, feature tour, install, permissions, keys table generated from
`keymap.js` by `scripts/gen-keys-md.mjs`, FAQ, Ultrawatch migration, MIT). `docs/USER_GUIDE.md`
(every view and feature with screenshots), `docs/API.md` (§4.4, for plugin/scripting
users), `docs/TROUBLESHOOTING.md` (Automation denied, stale TCC after a rebuild, Python API,
Keychain prompt, logs, `omniwatch doctor`), `CHANGELOG.md`.

**Screenshots** (`make screenshots` → `node scripts/screenshots.mjs`): starts the demo
backend with `--demo-clock <fixed epoch> --demo-seed 7`, uses a headless Chromium at
viewport 1440×900 with `deviceScaleFactor: 2`, and for `colorScheme` ∈ {dark, light}
captures: `split`, `list`, `grid`, `zoom`, `usage`, `palette`, `quick-reply`, `onboarding`,
`projects`, `empty-not-running`, `compact` → `docs/screenshots/<name>-<theme>.png`. It
disables animations (`reducedMotion: 'reduce'`) for stable pixels. An optional `--frame`
wraps each capture in a CSS macOS window frame for README polish. The menu bar and native
notifications can't be captured without grabbing the screen, so the docs describe them in
text (no fake mockups).

---

## 7. Implementation work breakdown

The contracts in §4.3–§4.5 are the interfaces between packages; packages that depend only
on a contract can start in parallel against fixtures.

| WP | Scope | Depends on | Parallel with | Difficulty | Acceptance |
|---|---|---|---|---|---|
| **WP0** Scaffold | dirs per §4.1, `Makefile` targets (stubs OK), `LICENSE` MIT © Eric Burns, README stub, `tests/_support.py` tripwires + meta-test, `web-tests/package.json` pinned `@playwright/test` | — | — | basic | `make test` runs (0+ tests, tripwire meta-test passes); `.gitignore` keeps `/.*.md`, `.rightsize-goal/` |
| **WP1** Backend core port | config, snapshot, iterm (+reply/close-by-uid/probe/not-authorized), agents, heuristics (+extract_prompt, history), itermcolor, usage_* (+limits()), projection (structured), timefmt, persist (+new keys, migration), notifier (no dialog), textutil, providers (Real), pollers (provider-injected); port all 163 Ultrawatch tests | WP0 | WP3, WP4, WP7-Core | moderate | all ported tests + new tests pass; the tripwire proves no real subprocess; migration test uses a copied Ultrawatch state fixture |
| **WP2** Engine + server | engine thread, views serializers, server routes (§4.4), SSE hub (§4.4.2), security (§4.5), runtime.json, logs, CLI (§4.3) incl. `--ready-json`, parent-pid/stdin-EOF exit, `doctor` | WP1 (providers interface) | WP3, WP4, WP7 | hard | route tests for every endpoint and error code; SSE contract tests; Host/Origin/token tests; `serve --demo --ready-json` prints a valid ready line and serves `/state`; coverage ≥90 % on engine/server/security |
| **WP3** Demo mode | demo providers, fake clock, scenarios (§5), screens, usage payloads, demo endpoints, OMNIWATCH_DEMO guard | WP1 interfaces | WP2, WP4 | moderate | determinism test (same seed+clock → identical State JSON); each scenario produces its intended status; the guard test proves no osascript in demo |
| **WP4** Web foundation | index.html shell, tokens.css (dark/light/system/high-contrast), dom helper, api.js, sse.js (reconnect/backoff), reducer, store, keymap/commands, fuzzy/sort/format/preview ports, native.js bridge shim | contract §4.4 (+ a static State fixture) | WP1–WP3, WP7 | moderate | node unit tests ≥90 % line; sort golden test vs Python; reducer covers every event type; contrast test AA |
| **WP5** Web views & features | toolbar, projects panel, session list/rows (virtualized), split/list/grid/zoom, preview + reply bar, usage strip + usage view, toasts, confirm dialogs, label/project editing, filter, sort menu, shortcut sheet, command palette, settings, onboarding, empty/error states, mute, keep-on-top toggle, a11y | WP4; live dev against WP2+WP3 | WP6 prep, WP7 | hard | manual walkthrough in `omniwatch demo`; every user-visible P-row implemented; no `innerHTML` with session text (lint grep in `make check`) |
| **WP6** E2E + screenshots | Playwright config (chromium+webkit, headless-only guard), specs per area tagged `@P-xx`, keyboard parity from keymap, theme tests, reconnect test, P-ID coverage checker script, `scripts/screenshots.mjs` | WP2, WP3, WP5 | WP8 | moderate | `make e2e` green on both engines; the P-ID checker reports 0 uncovered; `make screenshots` produces 22 PNGs deterministically (byte-stable on rerun, or within a pixel diff threshold) |
| **WP7** Swift shell | Core (§4.1) + tests binary; App: window/WKWebView, bridge, menus (mirroring commands), status item with a waiting dropdown, dock badge, notifications with actions, hotkeys (Carbon `RegisterEventHotKey`, no Accessibility permission needed), keep-on-top, restore frame, supervision, error view, `--self-test`; `build.sh`, Info.plist, icon | ready-line + SSE contract (WP2 for integration) | WP1–WP5 | hard | `make swift-test` green; `make app` builds; `--self-test` exits 0 against the demo backend; manual (user-run) check list: Automation prompt names Omniwatch, a notification shows and its click goes to the session, badge/menu count match |
| **WP8** Install & packaging | `make dist` (zipapp w/ web), `install.sh`/`uninstall.sh`, python-path recording, `install-colors`, `check-install` test, Homebrew formula template | WP2, WP7 | WP6, WP9 | routine | `make check-install` into a temp prefix passes; install is idempotent (run twice); `omniwatch --version` from the shim |
| **WP9** Docs | README, USER_GUIDE, API.md, TROUBLESHOOTING, CHANGELOG, generated keys table, screenshots embedded (dark/light `<picture>`) | WP6, WP8 | — | routine | every README feature has a screenshot or a sentence; links checked; keys table regenerates with no diff |
| **WP10** iTerm2 plugin *(later phase)* | `plugin/iterm2/omniwatch_status.py`, `make install-plugin`, backend `/plugin/focus` handling (the endpoint itself is in WP2) | WP2 | — | moderate | unit tests with a fake `iterm2` module; manual check in iTerm2 by the user |
| **WP11** P1 features *(later)* | timeline/history, blocked-on-you stats, stall detection, board view, notification reply actions, usage history, reveal/open, screen-text search, agent registry, login item, menu-bar-only | WP5, WP7 | — | moderate each | per-feature tests + E2E |

Critical path: WP0 → WP1 → WP2 → WP5 → WP6 → WP9. WP3, WP4, and WP7 start as soon as WP0
lands.

---

## 8. Risks & uncertainties

- **Heuristic drift**: Claude Code/Codex rendering changes break classification and
  `extract_prompt`. Mitigations: shared fixtures, the debug-rule UI, and the P1 data-driven
  registry.
- **Quick reply correctness**: I believe a single digit keypress selects a Claude Code menu
  option (and `y` answers a Codex approval) without Enter, but I haven't verified it against
  the current CLIs. WP1/WP5 must confirm manually (the user runs it) before shipping the
  default `submit:false` behavior.
- **TCC identity of ad-hoc builds**: every rebuild changes the cdhash, which can re-prompt
  for Automation or leave stale rows. Mitigations: document it, only rebuild when sources
  change, and optional signing with a stable local self-signed identity (P1).
- **UNUserNotificationCenter with ad-hoc signing**: I believe it works for a locally built,
  ad-hoc-signed bundle but haven't confirmed. If authorization fails at runtime, Omniwatch
  falls back to in-app toast + sound + dock badge + menu-bar count, and Settings says why.
- **Playwright setup**: `npx playwright` 1.55 is available, but `@playwright/test` isn't
  installed globally (the npx cache has 1.54.1). WP6 needs a one-time `npm ci` in
  `web-tests/` (network, dev-only). Browsers for chromium and webkit appear to be cached
  locally.
- **Python choice**: `/usr/bin/python3` is 3.9.6 (CLT) and has no `iterm2`; Homebrew's 3.13
  has it. PythonLocator prefers the interpreter with `iterm2`; both must pass the test suite
  (3.9 compatibility: no `match`, no `X | Y` types, no 3.10+ stdlib APIs).
