# Omniwatch shell contract (Swift shell ↔ backend, Swift shell ↔ web UI)

What `shell/` (WP7) implements against, as of T015. DESIGN.md §4.3–§4.7 is the parent spec;
deviations and additions are marked **[+]** (added) or **[≠]** (differs). Reconciled with the
real backend's `docs/API.md` (including its §10 differences). Source of truth in code:
`shell/Core/{ReadyLine,BackendProcess,BackendAPI,EventStreamClient,Models,ShellModel,Bridge,LoginItem}.swift`.
The stub `shell/Tests/fake_backend.py` implements the backend side of this document. The
real backend's payloads are pinned in `shell/Tests/fixtures/real/` (regenerate with
`python3 shell/Tests/capture_fixtures.py`, always `--demo`).

## 1. Launch

```
<python> <program> serve --ready-json --parent-pid <shell pid> --log-file <path> [--demo] [$OMNIWATCH_BACKEND_ARGS…]
```

- `<python>`: PythonLocator (§4.7.1). **[≠]** Explicit choices (`config.json` `python` →
  `$OMNIWATCH_PYTHON` → `Resources/python-path`) win as long as they are ≥3.9, even without
  `iterm2`. The `iterm2` preference applies only among the defaults (`/opt/homebrew/bin/python3`,
  `/usr/local/bin/python3`, `/usr/bin/python3`). Probe: `-c`, 3 s timeout.
- `<program>` **[+]**: `--backend X` flag, else `$OMNIWATCH_BACKEND`, else
  `Contents/Resources/omniwatch.pyz` (copied from `dist/omniwatch` by `build.sh app`).
  `X` is a script/zipapp path (a relative path is resolved against the shell's cwd) or
  `-m <module>` (e.g. `-m omniwatch` with `PYTHONPATH=<repo>`).
- `--log-file`: `~/Library/Logs/Omniwatch/backend.log` (app); a temp file (self-test).
- `--demo`: app launched with `--demo` or `OMNIWATCH_DEMO=1`, after a bridge `restartBackend`
  with `demo:true`, and always in `--self-test`.
- Env: the shell's own environment, plus `PYTHONUNBUFFERED=1`; `OMNIWATCH_DEMO=1` when demo.
  The self-test also sets `OMNIWATCH_CONFIG_DIR=<fresh temp dir>` **[+]**.
- stdin: a pipe the shell keeps open. stdout: the ready line, and nothing after it (any
  later lines are logged to `shell.log`). stderr: appended to `shell.log`. The real backend
  redirects fd 2 into `--log-file` early (API.md §8), so `shell.log` only catches failures
  before that; the previous `backend.log` is kept as `backend.log.1`.
- Verified against the real backend (T015): the bundled zipapp
  (`dist/Omniwatch.app/Contents/MacOS/Omniwatch --self-test`), `-m omniwatch` with
  `PYTHONPATH=<repo>`, and `/usr/bin/python3` 3.9.

## 2. Ready line (stdout, one line, within 10 s)

`{"event":"ready","port":53817,"token":"<43 chars>","pid":1234,"version":"1.0.0","demo":false}`

| field | rule |
|---|---|
| `event` | must be `"ready"` |
| `port` | integer 1–65535 |
| `token` | non-empty, only `[A-Za-z0-9_-]` (`secrets.token_urlsafe`); it goes unescaped into a URL and a header |
| `pid` | integer > 0; the self-test checks it equals the child's pid |
| `version` | string, optional |
| `demo` | JSON bool, optional (default false) |

Unknown fields are ignored. The handshake fails on a non-JSON first line, a wrong/missing
field, exit before the line, or a 10 s timeout. After a failure the shell sends SIGTERM,
then SIGKILL 2 s later, and the failure counts as a crash for the restart policy.

## 3. Lifecycle

- **Orphan guard (backend must implement):** exit when stdin reaches EOF, or when
  `os.getppid() != --parent-pid` (checked every 2 s). The real backend applies the stdin
  guard only when stdin is a pipe or socket; the shell always passes a pipe.
  **Python pitfall:** don't block in `sys.stdin.buffer.read()` in a daemon thread. On 3.13
  it aborts at interpreter shutdown ("Fatal Python error: _enter_buffered_busy", exit 134).
  Use `os.read(0, 4096)`.
- **Supervision:** an unexpected exit (or a failed handshake) triggers a restart after 1 s,
  2 s, then 5 s. The 4th unexpected exit within 60 s shows the native error view (log path,
  **Retry**, **Open Log**). Retry resets the count. Each restart gets a new port and token,
  so the web view reloads `/auth` and the SSE client reconnects.
- **Quit** (⌘Q, menu, restartBackend): `POST /api/v1/shutdown` → wait 2 s → close stdin +
  SIGTERM → wait 2 s → SIGKILL. The backend must answer 200 and **exit 0** within 2 s (the
  self-test checks the exit status). The app's quit has a 6 s hard cap.

## 4. Auth & HTTP

- The shell only talks to `http://127.0.0.1:<port>`, so its `Host` is `127.0.0.1:<port>`.
- Shell REST calls send `Authorization: Bearer <token>`, no `Origin`, and no cookies. The
  backend must accept Bearer without Origin on non-GET requests (§4.5).
- Web view: loads `GET /auth?token=<token>`. The backend must respond **302**,
  `Location: /`, `Set-Cookie: ow_session=<token>; HttpOnly; SameSite=Strict; Path=/`
  (the self-test checks the 302 and `ow_session=<token>` + `HttpOnly`).
- `/api/*` without a valid token → **401** (the SSE client reports `unauthorized` and
  keeps retrying at the backoff ceiling).

REST calls the shell makes:

| call | when | expects |
|---|---|---|
| `GET /api/v1/health` | self-test | 200 `{"ok":true,…}` |
| `GET /api/v1/summary` **[+]** | self-test | 200 `{tabs,agents,waiting,busy,stalled,waiting_sessions:[{uid,title,since,agent}]}`; `waiting` must equal the SSE `state` summary |
| `POST /api/v1/sessions/{uid}/goto` | status-item click (waiting or stalled row), notification action, next-waiting hotkey/menu | 202 (anything else is logged: 404 unknown uid, 503 `iterm_unavailable`); `uid` is percent-encoded as one path segment. If the backend isn't up yet (app launched by a notification click), the goto is sent once it is |
| `PATCH /api/v1/prefs` body `{"keep_on_top":bool}` | native Keep-on-Top toggle | 200 with the **bare** Prefs object (API.md §10.1) + a `prefs` SSE echo |
| `POST /api/v1/shutdown` | quit / restartBackend / self-test | 200, then exit 0 |

The shell doesn't call `/visit`. Going to a session from a notification or the menu bar
doesn't clear attention; API.md §5 confirms `goto` doesn't either.

## 5. SSE (`GET /api/v1/events`)

- Request headers: `Authorization: Bearer`, `Accept: text/event-stream`,
  `Cache-Control: no-cache`, and `Last-Event-ID: <id>` on reconnect.
- The response must be 200 with `Content-Type: text/event-stream…`. Anything else counts
  as a disconnect.
- Idle timeout is 45 s, so the backend's `: ping` every 15 s is required.
- Reconnect backoff is 0.5, 1, 2, 4, 8 s (8 s ceiling), reset on each 200. A server
  `retry:` would raise the delay but never lower it (the real backend never sends one).
  The server speaks HTTP/1.0, so a stream ends when the connection closes; a backlogged
  client is dropped and reconnects (API.md §6).
- The first event must be `hello`, then `state` (§4.4.2). The self-test fails otherwise.
- **Backend requirement [+]:** the web UI's `EventSource` can't set headers, so on reconnect
  it sends the last id as the query parameter **`?last_event_id=<id>`**
  (`omniwatch/web/js/sse.js`). The backend must accept either that parameter or the
  `Last-Event-ID` header (the shell uses the header). Either way it replies `hello` + full
  `state` and replays nothing. The real backend does this (API.md §6, §10.10).
- **Clock [+]:** backend timestamps use the provider clock, which is the demo clock in demo
  mode (API.md §5). The shell keeps `server_time − local time` from each `hello`/`state`
  and computes menu ages and stall durations in server time.

Events the shell consumes (it ignores unknown fields and tolerates missing ones):

| event | fields read | shell effect |
|---|---|---|
| `hello` | `version`, `server_time`, `demo` | log |
| `state` | `seq`, `server_time`, `demo`, `summary{tabs,agents,waiting,busy,stalled,waiting_uids}`, `sessions[]` (below), `screens{uid:{hash,text}}`, `prefs` (below) | badge/menu/title, prefs, clock offset. It can also arrive mid-stream (API.md §10.9); it's handled the same way |
| `sessions` | `seq`, `sessions[]`, `summary` | badge/menu/title; prunes stale notifications |
| `screens` | `screens{uid:{hash,text}}`, `removed[]` | notification body fallback (last meaningful line) |
| `prefs` | `prefs` | keep-on-top, theme (only until the web posts `theme`) |
| `transition` | `uid`, `from`, `to`, `at`, `title`, `agent`, `prompt{question,options[{key,label,selected}],free_text}`, `muted` | only `to=="waiting"` (and `from!="waiting"`): sound + notification |
| `stall` **[+]** | `uid` (required), `title`, `agent`, `since`, `minutes`, `muted` | stall notification (below). It's the backend's in-progress P1 event (`engine._stall_events`), sent once when a session becomes stalled; none is sent for sessions already stalled at startup. The shell also accepts `stalled` as the event name and a `transition` with `to:"stalled"` |
| `action` | `id`, `kind`, `uid`, `ok`, `detail` | `ok:false` is logged |
| `usage`, `toast`, `quota`, `capabilities`, `stats` | — | ignored (the web UI handles them) |

- Session fields: `uid` (required), `title`, `display_name`, `tab_label`, `path_display`,
  `agent`, `state`, `state_since`, `attention`, `muted`, `prompt`, `stalled`,
  `stalled_since`. Others (`ribbon`, `rule`, …) are ignored.
- Prefs fields: `theme`, `sound`, `keep_on_top`, `close_window_on_q`,
  `notifications{enabled,click,stall}`, `stall_minutes`.
  **Backend request:** `notifications.stall` (bool, default true: stall banners on/off) is
  read tolerantly, but the backend's `NOTIFICATION_RULES` rejects it today. Until that's
  added, `stall_minutes: 0` is the only switch.
- Menu dropdown: sessions with `state=="waiting"`, sorted by `state_since` ascending
  (longest wait first), then a "may be stalled" section (sessions with `stalled:true`).
  "Next waiting" cycles through the waiting order.
- Notification: title `"<title> needs you"`. Body is `prompt.question`, else the last
  meaningful screen line, else "Waiting for your input". Suppressed when
  `prefs.notifications.enabled` is false, when the session is muted, or when the app is
  active, the window is key, and the uid is in the web's `visible` set.
- Stall notification **[+]**: title `"<title> may be stalled"`, body `"Busy with no screen
  change for 12m. Check on it?"`. The duration is server-now minus `since` (or
  `stalled_since`), falling back to `minutes` or `prefs.stall_minutes`. Suppressed like
  waiting notifications, and also when `stall_minutes == 0` or `notifications.stall == false`.
  It makes no sound.
- Sound: NSSound "Glass" when `prefs.sound` is on and the session isn't muted (waiting only).

## 6. WKWebView bridge

- Handler name: **`omniwatch`**. Messages are accepted only from the main frame whose origin
  host is `127.0.0.1` or `localhost`.
- Navigation stays on `http://127.0.0.1|localhost:<current port>`. `http(s)`, `mailto:`, and
  `x-apple.systempreferences:` links open with NSWorkspace; anything else is cancelled.
  `target=_blank` and `window.open` go to NSWorkspace, never a second web view.
- The web view's cookies and storage aren't kept on disk between runs (prefs live in the
  backend).

**Injected by native** at document start, main frame only **[+]**:
`window.__OMNIWATCH_NATIVE__ = Object.freeze({"app":"Omniwatch","bridge":1,"platform":"macos","version":"1.0.0"})`

**Web → native:** `webkit.messageHandlers.omniwatch.postMessage(msg)`

| msg | meaning |
|---|---|
| `{type:"ready"}` **[+]** | **required.** Post it once `window.omniwatch` is installed. Native queues `command`/`nativeEvent` calls until then (keeping the latest 32), and replies with `nativeEvent({type:"notifyPermission",status})` |
| `{type:"theme", value:"dark"\|"light"\|"system"}` | sets `NSApp.appearance`; after the first one, `prefs.theme` is no longer applied natively |
| `{type:"keepOnTop", value:bool}` | sets the window level at once. The web should still PATCH `keep_on_top` |
| `{type:"notifyPermission"}` | asks macOS for permission; the result comes back as a `nativeEvent` |
| `{type:"visible", uids:[…]}` **[+]** | uids currently on screen (preview/zoom/visible tiles); used for notification suppression |
| `{type:"closeWindow"}` **[+]** | `q` (P-73): hide the window; the app stays in the menu bar |
| `{type:"restartBackend", demo:bool}` **[+]** | onboarding "Try the demo": clean shutdown, then relaunch with/without `--demo` |
| `{type:"launchAtLogin", value:bool}` **[+]** | Settings toggle (§7); native replies with `nativeSettings` |
| `{type:"menuBarOnly", value:bool}` **[+]** | Settings toggle (§7); native replies with `nativeSettings` |

Malformed messages (a wrong value type, an unknown theme) are dropped. Unknown types are logged.

**Native → web:** the page must expose:

- `window.omniwatch.command(id, args?)`. **[≠]** §4.7.6 shows one argument; `session.select`
  passes `{uid}`. IDs: `view.split`, `view.list`, `view.grid`, `usage.open`, `palette.open`,
  `settings.open`, `shortcuts.open`, `onboarding.open`, `filter.focus`, `refresh`,
  `session.nextWaiting`, `session.select {uid}`, `font.increase`, `font.decrease`, `font.reset`.
- `window.omniwatch.nativeEvent(event)` **[+]**. Two event types:
  - `{type:"notifyPermission", status:"granted"|"denied"|"notDetermined"|"error", error?:string}`
  - `{type:"nativeSettings", launchAtLogin:bool, menuBarOnly:bool, launchAtLoginError?:string}`,
    sent after `ready` and after every change from either side (menu or web). These two
    settings are native-only, not backend prefs, so the web must not PATCH them.

Both calls are guarded (`window.omniwatch && window.omniwatch.command && …`), so a missing
function is a silent no-op.

**App-mode behavior the web must follow:** when `__OMNIWATCH_NATIVE__` is present:
- Don't play the WebAudio chime and don't use the Web Notification API; native does both.
- `q` posts `closeWindow`.
- "Open Automation settings" can be a plain `x-apple.systempreferences:` link.

`omniwatch/web/js/native.js` now implements `ready`, `command(id, args?)`, `nativeEvent`,
`visible`, `closeWindow` and `restartBackend` (checked read-only, T015). Not yet wired:
`launchAtLogin`, `menuBarOnly`, and the `nativeSettings` event.

Native menu shortcuts that map to commands: ⌘1/⌘2/⌘3, ⌘U, ⌘K, ⌘R, ⌘F, ⌘, (Settings), ⌘/,
⌘= / ⌘− / ⌘0, and ⌥⌘T (Keep on Top, native). **Unverified:** whether WKWebView gives the page
first refusal on these key equivalents. The web should `preventDefault()` any it handles
itself, so a command doesn't fire twice.

## 7. Other native behavior

- Menu bar: `○` with no one waiting, `◉ N` in amber when N > 0 (99+ cap), `◌` while the
  backend is down.
- Dock badge: `N` / `99+` / none. Window title: `Omniwatch — N waiting`.
- Notification actions: **Go to session** (goto) and **Show in Omniwatch**
  (`session.select`). A plain click follows `prefs.notifications.click` (`goto` default,
  or `show`). There is one notification per uid (id `waiting-<uid>`), removed once the
  session stops waiting.
- Hotkeys (Carbon; config.json `hotkeys`): `toggle` defaults to `ctrl+opt+cmd+o` (explicit
  `null` turns it off). `next_waiting` defaults to off. A hotkey must include cmd, ctrl, or opt.
- Window frame is autosaved as `OmniwatchMain`; minimum size 640×420.
- **Launch at login [+]:** Omniwatch menu / status-item menu / bridge toggle. Writes
  `~/Library/LaunchAgents/com.burnsbert.omniwatch.login.plist` (`RunAtLoad`,
  `LimitLoadToSessionType Aqua`, `ProcessType Interactive`, `AssociatedBundleIdentifiers
  [com.burnsbert.omniwatch]`, ProgramArguments `/usr/bin/open -a <app> --args
  --launched-at-login`). Turning it off removes the file.
  - It isn't `launchctl`-loaded on enable (RunAtLoad would start a second copy). launchd
    picks it up at the next login.
  - With `--launched-at-login` the app starts without showing its window.
  - At launch, if the plist points at an app path that no longer exists, it's retargeted at
    the running bundle. A same-named file that isn't Omniwatch's is never touched.
  - I chose this over `SMAppService`: ad-hoc builds have no Team ID and change cdhash on
    every rebuild, and I couldn't verify registration without touching the real system.
- **Menu bar only [+]:** a toggle in the same three places, stored in UserDefaults
  (`menuBarOnly`) and applied before launch finishes (`.accessory`, so no Dock icon or dock
  badge; the menu-bar count remains). Toggling it re-shows the window if it was open.
- `--self-test` covers the Info.plist keys, handshake, `/auth` cookie, `/health`,
  `/summary` decode, `hello`→`state`, `summary.waiting > 0`, 0 SSE decode errors, `/summary`
  vs SSE agreement, and `/shutdown` → exit 0. It doesn't open a window, a Dock icon, or
  notifications. It forces `OMNIWATCH_CONFIG_DIR` and the log into a temp dir, and passes
  `$OMNIWATCH_BACKEND_ARGS` through (e.g. `--demo-clock 1790000000 --demo-seed 7`).

## 8. Manual checks left for the user (not automatable here)

1. Launch `build/Omniwatch.app` normally: the UI loads through `/auth`. This confirms the
   `SameSite=Strict` cookie survives the app-initiated redirect in WKWebView.
2. The Automation prompt names **Omniwatch** (python child of an ad-hoc app, §4.7.7).
3. The notification permission prompt appears, and a waiting transition shows a banner.
   Clicking it goes to the session in iTerm2; **Show in Omniwatch** selects it. If
   authorization fails for the ad-hoc build, note it (§8 fallback).
4. The dock badge, menu-bar count, and web waiting pill agree.
5. ⌃⌥⌘O shows/hides the window; Keep on Top works from the menu and from the web; the
   window frame is restored after relaunch.
6. ⌘Q leaves no python process (`pgrep -fl omniwatch`).
7. Killing the backend 4× within a minute shows the error view; **Retry** recovers.
8. Menu shortcuts (⌘K etc.) fire once, not twice.
9. Launch at Login: toggle it on, and check that the plist appears and System Settings ›
   General › Login Items lists Omniwatch (macOS may show a "Background item added" notice).
   Log out and in: Omniwatch starts in the menu bar with no window. Toggle it off: the
   plist is gone.
10. Menu Bar Only: the Dock icon disappears and reappears when toggled. Check that ⌘-key
    menu shortcuts still work while the app has no Dock icon (unverified for `.accessory`
    apps), and that the window can still be reached via the status item and hotkey.
11. Stall banner: set `stall_minutes` to 1 and leave an agent busy with an unchanged screen.
    One "may be stalled" banner should appear, and it should clear when the session changes.
