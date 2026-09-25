# Troubleshooting

Start here for anything that isn't working right:

```bash
omniwatch doctor          # human-readable
omniwatch doctor --json   # machine-readable
```

It reports the Python interpreter in use, whether `iterm2` can be imported
and from where (vendor dir vs. site-packages; tab colors), one live
iTerm2 snapshot and its status, the Automation
permission, whether Claude/Codex credentials are present, the config
directory, the log path, and any backend already running. Most of the
sections below start by looking at its output.

## Automation denied ("iTerm2 query failed" / permission card)

Omniwatch controls iTerm2 through AppleScript (`osascript`), which needs
**Automation** access, requested the first time Omniwatch tries to talk to
iTerm2 (onboarding step 1, or `omniwatch doctor`).

- If you dismissed or denied the prompt: **System Settings → Privacy &
  Security → Automation**, find the entry for Omniwatch (or your terminal,
  in browser mode) and enable the iTerm2 toggle. In-app, the empty-state
  permission card's **Open Automation settings** button goes straight
  there.
- `omniwatch doctor` reports `automation: denied` and `iterm: not_authorized`
  when this is the problem specifically (osascript error `-1743`, "Not
  authorized to send Apple events").
- After changing the toggle, click **Try again** in the app, or just
  restart Omniwatch — it re-probes on its own poll cycle too.
- **Which process asks for permission** depends on how you're running it:
  the native app (`Omniwatch.app`) is the process AppleScript sees, so the
  prompt should name **Omniwatch**. *I believe this is also true for the
  ad-hoc-signed build's python child process, but I haven't independently
  confirmed the exact prompt text for that case — if you see a prompt
  naming `python3` instead, that's expected in `--browser` mode (your
  terminal or python is then the calling process), not in the app.* In
  browser mode (`omniwatch --browser`) or from a plain terminal, the
  prompt names whatever process ran `python3` — typically your terminal
  app.

## Stale permission rows after rebuilding the app

`Omniwatch.app` is ad-hoc signed (`codesign --force -s -`), so **every
rebuild gets a new code identity (cdhash)**. macOS's permission database
(TCC) keys Automation grants to that identity, so a rebuild can:

- silently lose the grant (you'll see the Automation prompt again), or
- leave a stale, unusable row for the old build sitting in **System
  Settings → Privacy & Security → Automation** alongside the new one.

This is expected with local ad-hoc builds, not a bug. If Automation looks
"granted" in System Settings but Omniwatch still reports `not_authorized`:

1. Remove the Omniwatch entry from System Settings → Privacy & Security →
   Automation (the `-` button) — this clears out any stale row.
2. Relaunch Omniwatch and grant the prompt again.
3. Only rebuild the app when the Swift source actually changes, to avoid
   re-prompting unnecessarily.

A future signed/notarized build (see `docs/DESIGN.md` §6, the Homebrew
cask) would have a stable identity and avoid this entirely; that isn't
implemented yet.

## Tab colors / the Python API

The colored dot next to sessions, and the Projects panel's `1`–`5`/`0`
tab-color keys, need iTerm2's separate Python API (not exposed over plain
AppleScript). `install.sh` installs the `iterm2` package for this by
default, into Omniwatch's own vendor directory
(`~/.local/share/omniwatch/vendor`, or the prefix's equivalent) — never
the system or Homebrew Python's site-packages, so it never trips PEP
668's "externally managed environment" pip refusal. All that's left:

1. In iTerm2: **Settings → General → Magic → Enable Python API.**
2. Launch (or relaunch) Omniwatch. The first connection shows a one-time
   iTerm2 approval dialog for the script.

If it's still unavailable after that, `omniwatch doctor`'s `iterm2
package` line reports whether the package was found and where (`vendor`
or `site-packages`):

- **`no`** — the vendor install didn't happen or failed (e.g. no network
  during `install.sh`, or `--no-colors` was passed). Re-run it:
  ```bash
  make install-colors                 # re-installs into the vendor dir
  # or: VENDOR_DIR=/some/other/dir make install-colors
  ```
- **`yes (vendor)`** — working as intended.
- **`yes (site-packages)`** — an older install put `iterm2` directly on
  some interpreter's site-packages (e.g. `make install-colors` from
  before this vendoring existed); harmless, but `$OMNIWATCH_VENDOR_DIR`
  can point at a specific directory instead if you need to override it.

Without any of this, Omniwatch runs exactly the same — no error — just
without the colored dot, and `1`–`5`/`0` toast "tab colors unavailable"
(with a link back to this section).

## Keychain prompts (Claude usage)

Claude usage numbers come from the OAuth token in your macOS Keychain
item **"Claude Code-credentials"**, read with:

```
security find-generic-password -s 'Claude Code-credentials' -w
```

The first time Omniwatch's backend runs this, macOS may show a keychain
access prompt naming that item and the requesting process. Choose **Always
Allow** to stop it from asking again on every backend restart (each
restart is a new process, so "Allow" without "Always" will re-prompt).

If there's no Claude Code login on this machine, the usage card reads
"Sign in to Claude Code to see limits" (`no_credentials`) instead of
erroring — that's expected, not a bug. Codex usage reads `~/.codex/auth.json`
directly and doesn't touch the Keychain, so it has no equivalent prompt;
its own missing-file case reads similarly ("Codex auth not found").

## Where the logs live

```
~/Library/Logs/Omniwatch/
├── backend.log      # current run; truncated/rotated each start
├── backend.log.1    # the previous run's backend.log
└── shell.log        # native shell; catches only pre-redirect failures
```

`omniwatch doctor`'s `log file` line and the native error view (shown
after repeated backend crashes) both print the exact path, with an
**Open Log** button in the app. In demo mode nothing is written to these
paths — the ready line and diagnostics report the ordinary path anyway,
but a demo backend's actual logging target depends on how you launched it
(`--log-file`, if given).

If a backend won't start, run it directly to see the error instead of
digging through logs:

```bash
omniwatch serve --port 0
```

## The iTerm2 status-bar plugin

- **Not installed / installed to the wrong place:** `make install-plugin`
  copies `omniwatch_status.py` and `omniwatch_plugin_lib.py` into
  `~/Library/Application Support/iTerm2/Scripts/AutoLaunch` (override with
  `PLUGIN_DEST=… make install-plugin`, or `./install.sh --with-plugin
  --prefix DIR`). `make uninstall-plugin` removes them. AutoLaunch scripts
  are picked up when iTerm2 (re)starts, so install it before launching
  iTerm2, or use iTerm2's own **Scripts** menu to re-run AutoLaunch
  scripts if it's already running.
- **The component doesn't appear in "Configure Status Bar":** confirm
  **iTerm2 → Settings → General → Magic → Enable Python API** is checked
  first — the plugin needs it as much as tab colors do.
- **It shows "Omniwatch off":** no backend is running (or `runtime.json`
  is stale/unreadable); clicking it launches Omniwatch. Run
  `omniwatch doctor` to check for a `running_backend` entry.
- **It shows `◉ N` that disagrees with the app:** both read the same
  `GET /api/v1/summary`; if they disagree briefly, it's poll timing (the
  plugin polls every 2 seconds) — it should settle within a couple of
  seconds. A persistent mismatch across a backend restart usually means
  the plugin is talking to a stale port; check `runtime.json`.

## Something else

`docs/API.md` documents every endpoint, error code, and SSE event if
you're scripting against the backend directly, and `docs/DESIGN.md` §8
lists known open risks and unconfirmed behaviors (heuristic drift as
Claude Code/Codex UIs change, quick-reply keystroke semantics, and
notification permissions on an ad-hoc-signed build) that are worth
checking before assuming a bug.
