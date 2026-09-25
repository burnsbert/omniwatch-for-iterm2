# Omniwatch HTTP API (v1)

This is the API as implemented in `omniwatch/server.py`, `engine.py`, `views.py`, `sse.py`,
`security.py`, `runtime.py`, `cli.py`, and (since T014) `activity.py`, `stats.py` and
`usagehist.py`. T014 promoted five DESIGN §3 P1 features into v1: the activity timeline,
"blocked on you" stats, stall detection, usage history with burn rate, and reveal/open-in.
They're marked **(P1→v1)** below. It's written for plugin and
scripting users and for the web UI. Where it differs from the design (DESIGN.md §4.4),
the last section lists every difference.

- Base URL: `http://127.0.0.1:<port>`. The server binds 127.0.0.1 only. The port is random
  unless `--port` is given.
- Everything is JSON (UTF-8) except static files and the SSE stream.
- Responses carry `Cache-Control: no-store` (API) or `no-cache` (static), plus
  `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  and `X-Frame-Options: DENY`. No CORS headers are ever sent.
- The server speaks HTTP/1.0: one request per connection, and an SSE stream ends when the
  connection closes.

## 1. Authentication and request checks

Each launch creates a new token with `secrets.token_urlsafe(32)`: 43 characters of
`[A-Za-z0-9_-]`. You get it from the `--ready-json` line (§8) or from `runtime.json` (§7).

There are two ways to present it:

| Method | Header | Used by |
|---|---|---|
| Bearer | `Authorization: Bearer <token>` (the scheme name is case-insensitive) | the Swift shell, plugins, curl |
| Cookie | `Cookie: ow_session=<token>` | the web page (`EventSource` can't set headers) |

`GET /auth?token=<token>` sets the cookie. It answers `302` with `Location: /` and
`Set-Cookie: ow_session=<token>; HttpOnly; SameSite=Strict; Path=/`. A bad or missing token
gets `401 unauthorized`, a bad Host gets `403 forbidden`, and a non-GET gets
`405 method_not_allowed`. Tokens are compared in constant time.

The server checks every `/api/*` request in this order:

1. **Host** must be exactly `127.0.0.1:<port>` or `localhost:<port>`, otherwise
   `403 forbidden`. This check also covers static files and `/auth` (DNS-rebinding defense).
2. **Token** (Bearer or cookie) must be present and correct, otherwise `401 unauthorized`.
3. **Origin**, for anything other than GET/HEAD. `Origin` must be `http://127.0.0.1:<port>`
   or `http://localhost:<port>`, or else absent with a Bearer token. Anything else gets
   `403 forbidden`. So a cookie-only write with no `Origin` is refused (CSRF defense), and
   `Origin: null` is refused.

Static files (`GET /`, `/index.html`, `/css/*`, `/js/*`, `/assets/*` and anything else under
`omniwatch/web/`) need no token. They're read with `pkgutil.get_data`, so they work from the
zipapp too. Paths containing `..`, `.`, empty segments, backslashes or NUL get `404`, as does
a directory path.

CSP header value:
`default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`.
It blocks inline `style="…"` attributes. Set styles through CSSOM (`el.style.setProperty`)
instead.

## 2. Errors

```json
{"ok": false, "error": {"code": "not_found", "message": "session not found"}}
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | invalid JSON, a body that isn't a JSON object, the wrong type for a field, a missing required field, `confirm` not `true`, `Content-Length` invalid or over 256 KiB, `Transfer-Encoding` set (chunked isn't supported) |
| 401 | `unauthorized` | missing or wrong token |
| 403 | `forbidden` | bad Host; bad or missing Origin on a write |
| 404 | `not_found` | unknown route; unknown session uid; project slot outside 1–5 or not a number; no quota prompt pending; demo routes outside demo mode |
| 405 | `method_not_allowed` | the path exists but not for this method (e.g. `DELETE /api/v1/state`, `GET …/goto`) |
| 409 | `stale_screen` | quick reply: `expect_hash` doesn't match the current screen, or the last iTerm2 snapshot is more than 5 s old |
| 422 | `invalid` | a well-typed but unacceptable value: unknown pref key, value out of range, string too long, control characters, reply to a session that isn't an agent waiting for input, quick reply turned off, unknown demo scenario |
| 500 | `internal` | unhandled server error (logged) |
| 503 | `iterm_unavailable` | an iTerm2 action while `iterm.status` isn't `ok` (`not_running`, `not_authorized`, `error`, `connecting`) |
| 503 | `tab_colors_unavailable` | color change when `capabilities.tab_colors` is `false` |
| 503 | `unavailable` | the engine didn't answer within 2 s; or an SSE connect during shutdown |

Validation runs in this order: body shape and types (400), then the session exists (404),
then iTerm2 or capability availability (503), then semantics (422), then the staleness guard
(409).

## 3. Actions and the `action` event

Anything that goes through the iTerm2 worker (or launches iTerm2) returns
**`202 {"ok": true, "action_id": "a-17"}`** right away. The result arrives later as an SSE
`action` event with the same `id`:

```json
{"id": "a-17", "kind": "goto", "uid": "AAAA…", "ok": true, "detail": "→ tab 1.2"}
```

| `kind` | Endpoint | `detail` on success | typical `detail` on failure |
|---|---|---|---|
| `goto` | `POST /sessions/{uid}/goto` | `→ tab <tab_label>` | `session not found`, osascript error |
| `close` | `POST /sessions/{uid}/close` | `""` | `session not found` |
| `reply` | `POST /sessions/{uid}/reply` | `""` | `session not found` |
| `new_tab` | `POST /tabs/new` | `opening new tab…` | osascript error |
| `probe` | `POST /diagnostics/probe-automation` | `""` | e.g. `Not authorized to send Apple events… (-1743)` |
| `launch` | `POST /iterm/launch` | `launching iTerm2…` | `open` error |
| `color` | `PUT /sessions/{uid}/color` | `tab 1.2 → purple (billing)` / `tab 1.2 → orange` / `tab 1.2: color cleared` | never; setting a color is best-effort, and the next colors poll shows what actually applied |
| `reveal` | `POST /sessions/{uid}/reveal` | `revealed ~/src/api in Finder` / `opened ~/src/api in code` / `copied ~/src/api` | `not found: subl` (editor binary missing), `open -R failed`, `pbcopy failed` |

A failure toast in the UI is usually rendered as `"{kind} failed: {detail}"` (P-71).

## 4. REST endpoints

`{uid}` is one path segment; percent-encode it (`encodeURIComponent`). Unless noted, a request
body is optional and ignored, but if one is sent it must be a JSON object.

### Reads

| Method & path | Response `200` |
|---|---|
| `GET /api/v1/health` | `{"ok":true,"version":"1.0.0","demo":false,"pid":1234,"uptime_s":12.345}` |
| `GET /api/v1/state` | the full **State** (§5), with `server_time` refreshed |
| `GET /api/v1/summary` | `{"tabs":9,"agents":4,"waiting":2,"busy":1,"stalled":1,"waiting_sessions":[{"uid":"…","title":"refactor","since":1789999820.0,"agent":"claude"}],"stats":Stats}`. `waiting_sessions` is ordered longest wait first |
| `GET /api/v1/stats` **(P1→v1)** | the **Stats** object (§5) |
| `GET /api/v1/sessions/{uid}/history?hours=8` **(P1→v1)** | the **History** object (§5). `hours` is optional, in (0, 8], default 8. A bad `hours` → 400; an unknown uid → 404 |
| `GET /api/v1/usage/history?hours=24` **(P1→v1)** | the **UsageHistory** object (§5). `hours` is optional, in (0, 168], default 24. A bad `hours` → 400 |
| `GET /api/v1/diagnostics` | `{"python":{"path":"/usr/bin/python3","version":"3.9.6"},"iterm":{"status":"ok","error":""},"automation":"ok"\|"denied"\|"unknown","tab_colors":{"package":true,"reachable":true\|false\|null},"claude_credentials":true\|false\|null,"codex_credentials":true\|false\|null,"config_dir":"…","log_path":"…","demo":false}`. `null` means unknown. The Claude credential check may run `security` (Keychain). `automation` is derived from `iterm.status`: `ok`→`ok`, `not_authorized`→`denied`, anything else→`unknown` |
| `GET /api/v1/prefs` | the bare **Prefs** object (§5) |
| `GET /api/v1/events` | the SSE stream (§6) |

### Sessions

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/v1/sessions/{uid}/goto` | — | `202 {ok, action_id}` | 404, 503 `iterm_unavailable` |
| `POST /api/v1/sessions/{uid}/visit` | — | `200 {"ok":true}`, clears `attention` | 404 |
| `PUT /api/v1/sessions/{uid}/label` | `{"label":"deploy-fix"}`. It's trimmed, `""` removes the label, Unicode is allowed, ≤ 80 characters, no control characters | `200 {"ok":true,"label":"deploy-fix"}` | 400 (missing / not a string), 422 (too long / control characters), 404 |
| `PUT /api/v1/sessions/{uid}/color` | `{"project":1..5}` (maps to blue, purple, green, red, yellow), or `{"color":"red"\|"orange"\|"yellow"\|"green"\|"blue"\|"purple"\|"gray"}`, or `{"color":null}` to clear | `202 {ok, action_id}` plus an immediate `action` event (kind `color`) | 400 (neither key / wrong type / `project` is a bool), 422 (project outside 1–5 / unknown color), 404, 503 `tab_colors_unavailable` |
| `PUT /api/v1/sessions/{uid}/mute` | `{"muted":true}` | `200 {"ok":true,"muted":true}` | 400 (not a bool), 404 |
| `POST /api/v1/sessions/{uid}/close` | `{"confirm":true}` | `202 {ok, action_id}`. The tab is found by uid inside the AppleScript | 400 without `confirm:true`, 404, 503 |
| `POST /api/v1/sessions/{uid}/reply` | `{"text":"1","submit":false,"expect_hash":"9f3a01bc"}` | `202 {ok, action_id}` | see below |
| `POST /api/v1/sessions/{uid}/reveal` **(P1→v1)** | `{"target":"finder"\|"editor"\|"copy_path"}` | `202 {ok, action_id}`; the result comes as an `action` event with kind `reveal` | 400 (`target` missing / not a string), 422 (unknown target, or no known path for the session), 404 |

**Reveal / Open in.** The path is always the session's own (shell-integration path, else
lsof cwd), resolved on the server. A `path` in the body is ignored. Every effect goes
through the Opener provider, and nothing uses a shell:

| `target` | effect (real providers) |
|---|---|
| `finder` | `open -R <path>` |
| `editor` | `argv + [path]`, launched detached. `argv` comes from `shlex.split` of the first usable command among `prefs.editor`, `$VISUAL`, `$EDITOR`, then `code`. Terminal-only editors (`vi`, `vim`, `nvim`, `nano`, `pico`, `emacs`, `micro`, `hx`, `helix`, `kak`, `ne`, `joe`, `ed`, `mg`, `jed`) are skipped, because they'd hang with no terminal. Examples that work: `code -w`, `zed`, `cursor`, `open -a "Sublime Text"` |
| `copy_path` | `pbcopy` with the path. This is the server's clipboard, which is the same Mac |

Demo mode records these calls and never runs anything.

**Quick reply** checks, in order:

| Status | Condition |
|---|---|
| 400 | `text` isn't a string; `submit` is present but not a bool (it defaults to `false`); `expect_hash` is missing or empty |
| 422 | `text` is empty, longer than 2000 characters, or contains control characters other than `\n` |
| 404 | unknown uid |
| 422 | `prefs.quick_reply` is `false` ("turned off in Settings") |
| 503 | `iterm.status` isn't `ok` |
| 422 | the session isn't an agent session, or its `state` isn't `waiting` |
| 409 `stale_screen` | `expect_hash` (compared case-insensitively) ≠ the session's current `screen_hash`, or the last good snapshot is more than 5 s old |

`submit:false` types the text with no newline (single-key menu answers). `submit:true`
presses Enter after the text.

### Other actions

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/v1/tabs/new` | — | `202` | 503 `iterm_unavailable` |
| `POST /api/v1/iterm/launch` | — | `202` (runs `open -a iTerm`; demo mode uses a fake) | — |
| `POST /api/v1/diagnostics/probe-automation` | — | `202`. It's allowed in any iTerm2 status. If iTerm2 isn't running, the probe script (`tell application "iTerm2" to count windows`) will launch it | — |
| `POST /api/v1/refresh` | — | `200 {"ok":true}`. Kicks every poller and forces a usage refetch. Emits `toast {"level":"info","message":"refreshing…"}` | — |
| `POST /api/v1/plugin/focus` | `{"uid":"…"}` | `200 {"ok":true}`, same as `visit` | 400 (no uid), 404 |
| `POST /api/v1/shutdown` | — | `200 {"ok":true}`, sent before the process starts exiting. The process saves state, removes `runtime.json` and exits **0**, well within 2 s | — |

### Prefs and projects

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `PATCH /api/v1/prefs` | a partial Prefs object | `200` the bare full Prefs object, plus a `prefs` SSE event to every client | 422 for an unknown key or a bad value. Validation is atomic: one bad key rejects the whole patch |
| `PUT /api/v1/projects/{n}` | `{"name":"api"}`, trimmed, ≤ 80 characters, no control characters | `200 {"ok":true,"project":{"slot":1,"name":"api","color":"blue"}}` | 404 (n outside 1–5 or not a number), 400 (missing / not a string), 422 |
| `DELETE /api/v1/projects` | `{"confirm":true}` | `200 {"ok":true}` (clears all 5 names) | 400 without `confirm:true` |

Pref whitelist and allowed values:

| key | type / allowed values | default |
|---|---|---|
| `view` | `split` \| `list` \| `grid` | `split` |
| `sort` | `natural` \| `attention` \| `agents` \| `activity` \| `path` | `natural` |
| `show_dollars` | bool | `false` |
| `sound` | bool | `false` |
| `split_ratio` | number 0.2–0.8, rounded to 2 decimals | `0.42` |
| `projects_open` | bool | `false` |
| `grid_all` | bool | `false` |
| `usage_strip` | `expanded` \| `collapsed` | `expanded` |
| `theme` | `system` \| `dark` \| `light` \| `high-contrast` | `system` |
| `font_scale` | number 0.5–2.0, rounded to 2 decimals, always returned as a float | `1.0` |
| `notifications` | object, merged partially: `{"enabled": bool, "click": "goto"\|"show", "stall": bool}` | `{"enabled":true,"click":"goto","stall":true}` |
| `quick_reply` | bool (also sets `capabilities.reply`) | `true` |
| `keep_on_top` | bool | `false` |
| `close_window_on_q` | bool | `true` |
| `hint_bar` | bool | `true` |
| `debug_rule` | bool (adds `rule` to sessions) | `false` |
| `onboarding_done` | bool | `false` |
| `stall_minutes` **(P1→v1)** | integer 0–240 (not a bool, not a float); `0` turns stall detection off | `10` |
| `editor` **(P1→v1)** | string ≤ 200 characters, no control characters, must split with shlex; `""` means auto (`$VISUAL`/`$EDITOR`/`code`) | `""` |

Booleans must be JSON booleans; `1` is rejected. Invalid values already in `state.json` are
reset to their defaults at startup, except `notifications`: each of its keys is normalized
individually (a missing or invalid key falls back to its own default), so a value stored
before a key like `stall` existed keeps its other valid values instead of being wiped.
Changing `show_dollars` also emits a `usage` event. Changing `quick_reply` or `debug_rule`
also emits `capabilities`, and `debug_rule` also emits `sessions`.

### Quota email

| Method & path | Success | Errors |
|---|---|---|
| `POST /api/v1/quota-email/draft` | `200 {"ok":true,"opened":true\|false}`. Opens the Gmail compose URL from `~/.claude/quota-email/config.json` (demo mode uses a fake opener), marks the month as notified, clears `quota_prompt`, and broadcasts a full `state` event | 404 when no prompt is pending |
| `POST /api/v1/quota-email/skip` | `200 {"ok":true}`. Marks the month as notified, clears the prompt, and broadcasts a full `state` event | 404 when no prompt is pending |

A prompt is raised at most once per backend run, when the Claude monthly extra-usage
percentage reaches the configured threshold and it hasn't been shown this month
(`notifier.check`). In demo mode an in-memory stand-in is used (threshold 90,
`to: you@example.com`) and `~/.claude` is never touched.

## 5. JSON shapes

### State (`GET /state`, the SSE `state` event)

```json
{
  "version": "1.0.0", "seq": 812, "server_time": 1790000000.12, "demo": false,
  "iterm": {"status": "ok", "error": "", "last_poll_at": 1790000000.0, "poll_ms": 240, "stale": false},
  "summary": {"tabs": 9, "agents": 4, "waiting": 2, "busy": 1, "waiting_uids": ["A1…", "B2…"]},
  "windows": [{"id": 104, "number": 1}, {"id": 311, "number": 2}],
  "sessions": [Session, …],
  "screens": {"<uid>": {"hash": "9f3a01bc", "text": "…full screen text…"}},
  "usage": {"claude": UsageBlock, "codex": UsageBlock},
  "prefs": Prefs,
  "projects": [{"slot": 1, "name": "api", "color": "blue"}, … 5 entries, colors blue/purple/green/red/yellow],
  "capabilities": {"tab_colors": true, "reply": true, "debug_rule": false},
  "quota_prompt": null,
  "stats": Stats
}
```

- `server_time` and every timestamp come from the provider clock. That's wall time normally,
  and the demo clock in demo mode (§9). Compute ages as `server_time - state_since`, adjusted
  for local clock skew, not with `Date.now()` alone.
- `iterm.status`:
  - `connecting`: no snapshot yet.
  - `ok`.
  - `not_running`: `sessions` is `[]`.
  - `not_authorized`: `error` holds the osascript text; the last good sessions stay.
  - `error`: the last good sessions stay, and `stale` is `true`.
- `iterm.stale` is also `true` when `status` is `ok` but the last good snapshot is more than
  4× the snapshot interval old (8 s by default).
- `iterm.poll_ms` is always `0` in demo mode.
- `summary.stalled` **(P1→v1)** counts stalled sessions.
- `stats` **(P1→v1)**: see Stats below.
- `summary.tabs` counts sessions. `summary.waiting` counts sessions whose `state` is
  `waiting`. `summary.waiting_uids` is ordered longest wait first.
- `quota_prompt` is `null` or `{"pct": 91.0, "to": "you@example.com"}`.
- `capabilities.tab_colors` is `true` once a colors poll succeeds, `false` when the `iterm2`
  package or API is permanently unavailable, and `null` while unknown.
- `capabilities.debug_rule` is `OW_DEBUG_STATE=1`/`UW_DEBUG_STATE=1` or `prefs.debug_rule`.

### Session (natural snapshot order; screen text is in `screens`)

```json
{
  "uid": "AAAAAAAA-0002-…", "window_id": 104, "window_number": 1, "tab_index": 2,
  "session_index": 1, "tab_label": "1.2", "tty": "/dev/ttys001", "name": "✳ Refactor parser",
  "is_processing": false, "path": "/Users/me/src/billing", "path_display": "~/src/billing",
  "agent": "claude", "agents": ["claude"],
  "state": "waiting", "state_since": 1789999820.0, "attention": true,
  "last_change": 1789999990.4, "fresh_until": null,
  "label": "refactor", "display_name": "refactor", "title": "refactor",
  "tab_color": "blue", "project": 1, "muted": false, "is_dashboard": false,
  "screen_hash": "9f3a01bc",
  "prompt": {"question": "Do you want to proceed?",
             "options": [{"key": "1", "label": "Yes", "selected": true}, …],
             "free_text": false},
  "stalled": false, "stalled_since": null,
  "ribbon": {"end": 1790000400, "bucket_s": 600,
             "codes": "iiiibbbwbbbbbwwbbbbbbbiibbbbbbbbbbbbbbbbbbbibbbw"}
}
```

- `tab_label` is `"3"` with one window and `"2.3"` with several.
- `path` is the shell-integration path, else the `lsof` cwd of the TTY.
- `agent` is `claude` wins over `codex` on a shared TTY. `agents` is the sorted list.
- `state` is one of `busy | waiting | idle | active | quiet` (agents use the first three,
  plain shells the last two), or `null` before the first classification, in which case
  `state_since` is `null` too.
- `attention` means waiting and not yet visited; `visit`/`plugin/focus` clear it, `goto`
  doesn't.
- `fresh_until` is `last_change + 30` when the session isn't busy or waiting, the change
  happened more than 5 s after backend start, and it hasn't expired; otherwise `null`. The
  server publishes the flip to `null` too, but clients can expire it locally.
- `display_name` is `label || name`. `title` is `label || path_display || name || uid[:8]`.
- `project` is the slot (1–5) whose color equals `tab_color`, regardless of whether that
  slot has a name.
- `is_dashboard` is true when the session's first screen line shows the banner of a terminal
  dashboard, such as the legacy Ultrawatch TUI running in a tab.
- `screen_hash` is the CRC32 of the screen with spinner glyphs stripped and trailing blanks
  trimmed, as 8 lowercase hex digits. It's the value to send as `expect_hash`.
- `prompt` is only present (non-null) for agent sessions in `waiting` whose screen parses.
- `rule` (the classifier rule name) is present only when `capabilities.debug_rule`.
- `stalled` **(P1→v1)**: `true` when `state` is `busy` and the screen hash (spinners
  stripped) hasn't changed for at least `prefs.stall_minutes` (default 10; `0` = off).
  `stalled_since` is the time of the last screen change (the session has been stuck since
  then), else `null`. When a session becomes stalled, an SSE `stall` event is sent once per
  episode.
- `ribbon` **(P1→v1)**: the compact activity timeline. It's 48 buckets of 10 minutes
  (8 h), aligned to wall-clock 10-minute boundaries. `end` is the end of the bucket that
  contains `server_time`; bucket *i* covers `[end − (48−i)·600, end − (47−i)·600)`. Each
  letter is the state that held longest in that bucket: `w` waiting, `b` busy, `i` idle,
  `a` active, `q` quiet, `-` no data. Ties go to w > b > i > a > q. It changes only on a state
  change or a bucket rollover. It's `null` before the session is first classified.

### UsageBlock

```json
{"status": "ok", "fetched_at": 1789999700.0, "stale_since": null,
 "limits": [
   {"id": "claude.five_hour", "label": "Session", "window": "5h", "pct": 62.0, "level": "yellow",
    "resets_at": 1790008140, "reset_text": "2h 15m (Today at 5:59pm)",
    "projection": {"kind": "pace", "at": 1790006400, "text": "on pace to hit session limit Today at 5:30pm"}},
   {"id": "claude.monthly", "label": "Monthly cap", "window": "month", "pct": 91.0, "level": "red",
    "resets_at": 1790812800, "reset_text": "9d 6h (Oct 1 at 12:00am)", "has_cap": true,
    "limit_display": null, "projection": {"kind": "pace", "at": 1790500000, "text": "…"},
    "burn": Burn}
 ]}
```

Each limit also has `burn` **(P1→v1)**: a Burn object (see UsageHistory) or `null`.

`status` values:

- `inactive`: no matching agent is running, or nothing has been fetched yet. `limits` is
  `[]` and `fetched_at` is `null`.
- `ok`.
- `stale`: the last fetch failed but last-good `limits` are kept; `stale_since` is when the
  failures started.
- `error`: the fetch failed with no data.
- `no_credentials`: the fetch failed with no data and the provider reports no credentials.
  This is checked off-thread, so the status reads `error` first, then `no_credentials`.

Other fields:

- `level` is `green` (<50), `yellow` (50–79) or `red` (≥80).
- `projection` is `null` or `{kind: "hit"|"pace", at: epoch|null, text}`.
- Limit IDs: `claude.five_hour`, `claude.seven_day`, `claude.seven_day_sonnet`,
  `claude.monthly` (with label `Monthly cap` when there's a cap, else `Extra usage`),
  `codex.five_hour`, `codex.seven_day`, `codex.other`.
- `limit_display` (e.g. `"$200"`) is non-null only when `prefs.show_dollars` is on and there's
  a cap.
- `reset_text` and `projection` are computed **when the snapshot arrives**, not on every
  tick. Tick countdowns client-side from `resets_at`.

### Prefs

See the table in §4. `GET`/`PATCH /prefs` return exactly these 19 keys.

### Stats **(P1→v1)**: "blocked on you", today

```json
{"day": "2026-09-21", "waiting_seconds": 4980, "longest_wait_s": 780, "answered": 14, "waits": 16,
 "active": [{"uid": "DEMO-0001", "since": 1789999760.0}, {"uid": "DEMO-0007", "since": 1789999880.0}]}
```

- `day` is the local calendar date. The counters reset at local midnight; a wait in progress
  across midnight counts from 00:00.
- `waiting_seconds` is the total of *finished* waits today, for agent sessions only.
  `longest_wait_s` is the longest finished wait. A live total is `waiting_seconds + Σ(now −
  active[].since)`.
- `waits` counts waits started today. `answered` counts waits that ended because the session
  left `waiting` while still open. A session closing, or iTerm2 quitting, ends a wait
  unanswered.
- `active` lists the waits in progress, oldest first.
- The object only changes on a transition or at midnight, never every second.
- It's in the State (`stats`), in `/summary` (`stats`), at `GET /stats`, and pushed as the
  SSE `stats` event.
- The day's totals are persisted to `<config dir>/stats.json`, so a restart keeps them. A
  file from another day is ignored.

### History **(P1→v1)**: `GET /sessions/{uid}/history`

```json
{"uid": "DEMO-0001", "from": 1789971200.0, "to": 1790000000.0, "hours": 8,
 "segments": [{"state": "idle", "start": 1789971200.0, "end": 1789974200.0},
              {"state": "busy", "start": 1789974200.0, "end": 1789975880.0},
              …,
              {"state": "waiting", "start": 1789999760.0, "end": null}],
 "totals": {"busy": 22320.0, "idle": 4500.0, "waiting": 1980.0},
 "transitions": 14}
```

- `segments` are clipped to `[from, to]`. The last one is ongoing (`end: null`).
- `state` values are the Session states, plus `null` while unclassified. `totals` uses the
  key `unknown` for `null`.
- `transitions` counts state changes inside the window.
- Only published (debounced) states are recorded. A session's timeline starts when it's
  first seen and is dropped when it disappears. The log isn't persisted: it's 8 h in memory
  per session, capped at 512 entries.

### UsageHistory **(P1→v1)**: `GET /usage/history`

```json
{"from": 1789913600.0, "to": 1790000000.0, "hours": 24,
 "limits": {
   "claude.five_hour": {"provider": "claude",
                        "points": [[1789913600.0, 41.3], …, [1790000000.0, 62.0]],
                        "latest": {"t": 1790000000.0, "pct": 62.0, "resets_at": 1790008130},
                        "burn": Burn},
   "codex.seven_day": {…}}}
```

- `points` are `[epoch, pct]`, oldest first: one per usage snapshot (about every 300 s while
  an agent of that kind runs). They're ready to feed a sparkline.
- There's one key per limit id seen in the window; ids are as in UsageBlock.
- The history comes from `<config dir>/usage-history.jsonl`. It's append-only, one line per
  provider snapshot: `{"t":…, "p":"claude", "l":{"claude.five_hour":[62.0,1790008130],…}}`.
  It's pruned to 7 days / 10 000 lines, and malformed lines are dropped at load.

**Burn** (also on every UsageBlock limit as `burn`; `null` until there's enough data):

```json
{"rate_per_hour": 23.76, "eta": 1790005758, "before_reset": true, "at_reset_pct": null,
 "text": "at this rate: 100% Today at 11:49am"}
```

- Burn is a least-squares slope over the current reset cycle's points from the last 2 h. It
  needs at least 2 points spanning at least 10 minutes.
- `eta` is when 100 % is reached at that rate, and `before_reset` is `true` if that happens
  before `resets_at`.
- When the window resets first: `eta: null`, `before_reset: false`, `at_reset_pct: 48.0`,
  `text: "at this rate: ~48% at reset"`.
- Other `text` values: `"not rising"` (rate ≤ 0) and `"limit hit"` (≥ 100 %).

## 6. Server-sent events: `GET /api/v1/events`

Every message looks like this:

```
id: <seq>
event: <type>
data: <one line of JSON>

```

- **Connect and reconnect.** The stream always starts with `hello`, then a full `state`, both
  carrying the current seq as `id`. The last seen id is accepted as the `Last-Event-ID` header
  or as the query parameter `?last_event_id=<id>` (for `EventSource`). It's parsed but
  **nothing is replayed**: the full `state` is the resync. No event is lost between that
  snapshot and the live events, because subscription and the snapshot happen atomically with
  respect to publishing.
- **Heartbeat.** A `: ping` comment follows every 15 s of silence.
- **Backpressure.** Each client has a queue of 256 messages. A client that overflows it is
  dropped (its stream ends), and it should reconnect.
- **Headers.** `200`, `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-store`, `X-Accel-Buffering: no`. Auth failures return JSON errors (401,
  403) instead of a stream. A connect during shutdown gets `503`. The server never sends
  `retry:`.
- **Seq.** `seq` goes up by 1 per emitted event. The `sessions`, `screens`, `usage` and
  `prefs` payloads also carry `seq` (equal to their `id`). A backend restart resets seq, so
  treat a restart as a fresh connection.

| event | data | when |
|---|---|---|
| `hello` | `{version, server_time, demo}` | first message on every connect |
| `state` | State | second message on every connect; **also** broadcast after a quota draft/skip and after a demo scenario reset |
| `sessions` | `{seq, sessions, summary, windows, iterm}` | any change to sessions/summary/windows, or to `iterm` apart from `last_poll_at`/`poll_ms` (those two ride along but don't trigger an event) |
| `screens` | `{seq, screens:{uid:{hash,text}}, removed:[uid]}` | only uids whose **raw** text changed (so spinner-only frames still animate), plus removals |
| `usage` | `{seq, usage}` | a new usage snapshot, a `show_dollars` change, or a credentials answer |
| `prefs` | `{seq, prefs, projects}` | any pref or project change (every client stays in sync) |
| `capabilities` | Capabilities (`{tab_colors, reply, debug_rule}`, no seq field) | any change |
| `transition` | `{uid, from, to, at, title, agent, prompt, muted}` | each published tracker transition (after the two-snapshot debounce). It follows the `sessions` event of the same publish. No transition is sent for a session's first observation, even if it's already waiting |
| `action` | `{id, kind, uid, ok, detail}` | results of iTerm2 actions (§3) |
| `toast` | `{level:"info"\|"warn"\|"error", message}` | server toasts (currently only `refreshing…`) |
| `quota` | `{pct, to}` | a quota prompt becomes pending (clearing it is done with a full `state`, see above) |
| `stats` **(P1→v1)** | `{seq, stats: Stats}` | a wait starts or ends, or the day rolls over |
| `stall` **(P1→v1)** | `{uid, title, agent, since, minutes, muted}` (`since` is the last screen change) | a busy session becomes stalled; once per episode. The event is always sent (its payload doesn't depend on prefs); the Swift shell and web UI each check `prefs.notifications.stall` themselves and skip the banner/toast when it's `false` (also skipped when `muted`) |

Within one publish the order is: `sessions`, `screens`, `usage`, `prefs`, `capabilities`,
`stats`, then `transition`s, then `stall`s, then queued `action`/`toast`/`quota`, then
(if any) `state`. The `sessions`, `screens`, `usage`, `prefs` and `stats` payloads carry
`seq`.

## 7. `runtime.json`

Path: `<config dir>/runtime.json`, usually `~/.config/omniwatch/runtime.json`. It's written
atomically with mode `0600` once the server is listening:

```json
{"port": 53817, "token": "…", "pid": 1234, "version": "1.0.0", "started_at": 1790000000.1, "demo": false}
```

It's removed on a clean exit, but only by the process whose pid is in the file. To discover
a backend, read the file, check the pid is alive, and then check
`GET /api/v1/health` with the Bearer token. Bare `omniwatch` / `omniwatch --browser` do
exactly this before starting a second backend. In demo mode the file lives in the demo's
temporary config dir.

### Other files in the config dir **(P1→v1)**

| File | Content |
|---|---|
| `stats.json` | `{"day","waiting_seconds","longest_wait_s","answered","waits"}` for today (atomic write) |
| `usage-history.jsonl` | usage history (see UsageHistory), append-only, pruned to 7 days / 10 000 lines |

## 8. CLI

```
omniwatch                         app installed (~/Applications or /Applications/Omniwatch.app, no args)
                                  → open -a Omniwatch; else browser mode (reuses a running backend)
omniwatch --browser [serve flags] serve + open the default browser at the /auth URL
omniwatch demo [serve flags]      serve --demo --browser
omniwatch serve [flags]
omniwatch doctor [--json] [--demo …] [--config-dir DIR]
omniwatch --version               → "omniwatch 1.0.0"
```

| serve flag | meaning |
|---|---|
| `--port N` | TCP port on 127.0.0.1 (default 0 = random) |
| `--demo` | demo providers (`omniwatch.demo`); sets `OMNIWATCH_DEMO=1` first, so nothing can reach iTerm2 |
| `--demo-scenario NAME` | one of `default`, `empty`, `not-running`, `not-authorized`, `many`, `usage-errors`. An unknown name → exit 1 with a message |
| `--demo-seed N` | cosmetic jitter (default 0) |
| `--demo-clock EPOCH` | freeze the demo clock at EPOCH; it then moves only via `/demo/step` |
| `--config-dir DIR` | state dir. Otherwise `$OMNIWATCH_CONFIG_DIR`, else a fresh temp dir in demo mode (deleted on exit), else `$XDG_CONFIG_HOME/omniwatch` (`~/.config/omniwatch`) |
| `--ready-json` | print exactly one line on stdout once listening, and nothing after it: `{"event":"ready","port":N,"token":"…","pid":N,"version":"1.0.0","demo":bool}` |
| `--parent-pid PID` | exit 0 when `getppid() != PID` (checked every 2 s) |
| `--log-file PATH` | log there (the previous one is kept as `PATH.1`) and redirect fd 2 into it. `--browser` without `--ready-json` defaults this to `~/Library/Logs/Omniwatch/backend.log`. Otherwise logs go to stderr |
| `--browser` / `--no-open` | open / don't open a browser |

Other behavior:

- **Orphan guard:** exit 0 on stdin EOF. This applies only when `--ready-json` or
  `--parent-pid` is given **and** stdin is a pipe or socket; `/dev/null` and a terminal are
  ignored.
- **Clean exit (status 0):** `POST /api/v1/shutdown`, SIGTERM or SIGINT. It saves
  `state.json`, removes `runtime.json` and deletes a demo temp dir.
- **Exit codes:** startup failure (e.g. port in use, demo package missing) → 1, with the
  message on stderr and no ready line. Bad CLI usage → 2.
- Without `--ready-json`, stdout gets one human-readable line with the auth URL.
- In demo mode, the one-time state import from `~/.config/ultrawatch/state.json` is disabled,
  so your real labels never leak into a demo.
- `doctor` takes one iTerm2 snapshot (which may trigger the Automation prompt the first time)
  and reports python, the `iterm2` package, iTerm2 status, automation, Claude/Codex
  credentials, config dir, log path, and any running backend.

## 9. Demo mode: control endpoints, threading and clock

Enabled with `--demo`. `health.demo`, `state.demo` and `hello.demo` are then `true`.

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/v1/demo/step` | `{"seconds": 6}` (number 0–86400, default 0) | `200 {"ok":true,"seq":N}`. `seq` is the published seq after the step, so it matches `GET /state` | 400 (not a number), 422 (out of range), 404 outside demo mode |
| `POST /api/v1/demo/scenario` | `{"name":"empty"}` | `200 {"ok":true,"seq":N,"scenario":"empty"}`, and a full `state` event is broadcast | 400 (not a string), 422 (unknown), 404 outside demo mode |

How demo mode runs:

- **No background pollers.** The fake world isn't thread-safe, so the engine thread drives
  the demo providers synchronously: polls, iTerm2 actions (`goto`, `reply`, `close`,
  `new_tab`, `probe`, `launch`), color sets and refreshes. Every action is followed by an
  immediate re-poll, so its effect and its `action` event arrive together.
- **Clock.** The demo clock only moves when `demo.step()` is called.
  - Without `--demo-clock`, the engine calls `step(<elapsed real seconds>)` about every 2 s,
    so the scripted timeline plays in real time (e.g. at t+6 s the busy Claude session flips
    to waiting).
  - With `--demo-clock EPOCH`, time is frozen and only `/demo/step` advances it. Use this for
    E2E tests and screenshots: two runs with the same seed and clock produce the same State,
    apart from `seq` ordering under concurrent requests.
- **Step semantics.** `/demo/step` advances the clock, then polls **twice at the same
  instant**, so a scripted change clears the two-snapshot debounce and its `transition` is
  published within that one request.
- **Startup.** The first poll happens before the ready line, so the first `state` is already
  populated. The default scenario has `summary.waiting ≥ 1` immediately.
- **Scenario reset.** A reset rebuilds the providers and resets the tracker and all
  snapshots. Prefs, labels and projects in the store are kept, and an optional
  `providers.demo.initial_state` (`{labels, projects, muted, prefs}`) is re-applied if the
  demo package provides one. The current demo package doesn't, so demo labels and project
  names start empty.
- **Usage in sync polls.** Usage is fetched on the first poll, on `refresh`, and whenever the
  demo clock has moved on by ≥ the usage interval (300 s).
- **Seed data (P1→v1 showcase).** Right after the first poll, and after every scenario
  reset, the engine calls `Engine.apply_demo_seed()`, which reads these optional hooks from
  `providers.demo`:
  - `initial_state`: labels and project names. In the default scenario these are
    `deploy-fix` / `nightly-log`, and projects `api-gateway`, `billing`, `tools`.
  - `seed_history()`: 8 h of per-session timelines. The default scenario's are hand-written
    (the ribbons end in each session's live state, and ages such as "idle 22m" are real).
    Other scenarios get deterministic random walks derived from `--demo-seed`. The same
    history is replayed into Stats: the default scenario starts at 83 min blocked, longest
    13 min, 14 answered, 16 waits, 2 active.
  - `seed_last_change()`: screen-unchanged-since times. `DEMO-0003` (default) and
    `DEMO-MANY-004` (many) start out **stalled**.
  - `seed_usage_history()`: 7 days of usage points (hourly, then every 15 min for the last
    24 h), shaped as a sawtooth that ends at today's percentages. This gives rich
    sparklines and burn texts like "at this rate: 100% Today at 11:49am" and
    "~48% at reset". The `empty`, `not-running`, `not-authorized` and `usage-errors`
    scenarios seed no usage history.
- The same seed, scenario and `--demo-clock` always produce identical seeds.

## 10. Differences from DESIGN.md §4.4

1. **Response bodies.** Every non-prefs success body includes `"ok": true`.
   `PUT /sessions/{uid}/label` returns `{ok, label}`; `PUT /sessions/{uid}/mute` returns
   `{ok, muted}`; `PUT /projects/{n}` returns `{ok, project:{slot,name,color}}` (§4.4 says only
   "200"); `POST /quota-email/draft` returns `{ok, opened}`. `GET` and `PATCH /prefs` return
   the **bare** Prefs object (no `ok`).
2. **`PUT …/color`** returns `202 {ok, action_id}` and immediately emits an `action` event with
   `kind: "color"` and a human-readable `detail` (§4.4 doesn't define this event kind).
3. **Action kinds** are `goto`, `close`, `new_tab`, `reply`, `probe`, `launch`, `color`
   (§4.4.2 doesn't list them). A successful `goto` has detail `→ tab <label>`, `new_tab` has
   `opening new tab…`, and `launch` has `launching iTerm2…`.
4. **The 409 code is `stale_screen`**, never the generic `conflict` from the §4.4 error list.
   A disabled quick reply is **422 `invalid`**, and so are text-length and control-character
   failures. Wrong body types are **400**.
5. **New status codes:** `405 method_not_allowed` (the path exists, the method doesn't),
   `500 internal`, and `503 unavailable` (the engine didn't answer in 2 s, or SSE during
   shutdown).
6. **New 404 cases:** `quota-email/draft` and `/skip` with nothing pending; demo routes
   outside demo mode; a project slot that isn't 1–5 or isn't a number.
7. **Extra endpoint:** `POST /api/v1/plugin/focus {"uid"}`. §4.8 specifies it; it behaves
   like `visit`.
8. **Diagnostics** includes an extra `demo` field. The credential fields and
   `tab_colors.reachable` can be `null` (unknown).
9. **`state` is also a broadcast event**, not only the second message on connect. It's sent
   after a quota draft/skip (because a `quota` event can't clear the prompt, and the web
   reducer turns `quota` with null data into `{}`) and after a demo scenario reset.
10. **No gap replay.** `Last-Event-ID` and `?last_event_id=` are accepted but only ever yield
    `hello` plus a full `state`. This matches §4.4.2 and SHELL_CONTRACT §5.
11. **`sessions` is not emitted for `last_poll_at`/`poll_ms`-only changes.** Those two values
    update in the next real `sessions` event, and always in `GET /state`. A change in
    `stale` does trigger an event.
12. **`usage` blocks are computed once per snapshot.** `reset_text` and `projection` are as of
    the fetch; countdowns must tick client-side from `resets_at`.
13. **Allowed pref values** are stricter than §4.4.1 implies: `usage_strip` is only
    `expanded` or `collapsed`, `font_scale` 0.5–2.0, `split_ratio` 0.2–0.8 (rounded to 2
    decimals). `notifications` is merged partially, and one bad key rejects the whole PATCH.
14. **Demo mode:** `poll_ms` is always `0`. `/demo/step` polls twice (the debounce clears in
    one step). The default body is `{"seconds": 0}`. Timestamps and `server_time` follow the
    demo clock, not wall time.
15. **`/auth`** also checks the Host header (403) and answers 405 to non-GET methods.
16. **Static files** are served for anything under `web/` (not just `/css/*`, `/js/*`,
    `/assets/*`). Traversal attempts and directory paths get a plain-text `404`, not JSON.
17. **`runtime.json`** has an extra `demo` field and is only removed by the pid that wrote it.
18. **P1 features promoted into v1 (T014). None of these are in §4.4; all are additions.**
    - Endpoints: `GET /sessions/{uid}/history`, `GET /usage/history`, `GET /stats`,
      `POST /sessions/{uid}/reveal`.
    - Session fields: `stalled`, `stalled_since`, `ribbon`.
    - State `stats`, `summary.stalled`, and `/summary` `stalled` + `stats`.
    - `burn` on every usage limit.
    - Prefs `stall_minutes` and `editor`.
    - SSE events `stats` and `stall`.
    - Action kind `reveal`.
    - Files `stats.json` and `usage-history.jsonl`.
    - DESIGN §3 P1 sketched `GET /sessions/{uid}/history` as a raw ring buffer. The real
      endpoint returns clipped segments + totals over ≤ 8 h, and the per-session summary is
      the fixed-resolution `ribbon`.
19. **CLI:**
    - The stdin-EOF guard needs `--ready-json` or `--parent-pid`, and stdin must be a pipe or
      socket.
    - Demo mode skips the one-time `~/.config/ultrawatch/` state import.
    - `--browser` defaults the log file to `~/Library/Logs/Omniwatch/backend.log`.
    - There's a hidden `--providers-factory MODULE:FUNC` (tests only; forces
      `OMNIWATCH_DEMO=1`).
