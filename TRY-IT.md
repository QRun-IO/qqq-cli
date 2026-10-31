# Try the terminal clients as they are built

Updated with every milestone. Each entry says what exists today and the one command that runs it.

## Prerequisites (once)

- Java 21 and Maven (for the sample server), Bun 1.4+ (`brew install bun`), Node 20+ (existing CLI).
- A `qqq` checkout on `develop` at `../.worktrees/qqq-develop` (relative to this repo's parent), or set
  `QQQ_DEV_WORKTREE`. Then `qqq-sample-server build` once (about two minutes), and after every pull of qqq.
- Launchers: `scripts/dev/sample-server.sh` and `scripts/dev/tui-spike.sh` are linked as
  `~/.local/bin/qqq-sample-server` and `~/.local/bin/qqq-tui-spike`.

## Sample server (UI API 1.8.0, mock auth, in-memory data)

```sh
qqq-sample-server start      # http://localhost:8077  (web UI at /, API at /qqq/v1)
qqq-sample-server status | log | restart | stop
```

Data resets on every restart. Mock auth means no sign-in; `POST /qqq/v1/manageSession` gives a session.

## M0 spike (2026-10-31): OpenTUI feasibility

```sh
qqq-tui-spike            # from source: Ctrl+G grid, Ctrl+F form, Ctrl+P process, Ctrl+Q quit
qqq-tui-spike binary     # the compiled macOS binary
qqq-tui-spike test       # in-memory renderer tests
```

What to look at:
- Grid: 10,000 generated rows x 40 columns. Arrows, PageUp/Down, Home/End, Left/Right scroll columns,
  `s` sorts the cursor column. The status line shows key-to-frame latency. Resize the window.
- Form: Tab between every field type, type into the Home State field to filter the picker, Enter to
  pick, Ctrl+S validates and shows errors beside fields.
- Process: runs the sample's Sleep Interactive process on the server with an async job and polling.
  Change the milliseconds, press Enter. Watch the log lines at the bottom.

Known: typing in the same instant as Tab (paste, automation) lands in the previous field; a human does
not hit this. Windows binary is cross-compiled and unverified.

## Existing CLI (`@qrun-io/qqq-cli` 0.1.0-rc.1, UI API 1.6.0 client)

```sh
npm install && npm run build
node packages/cli/dist/main.js --help
```

It targets bearer auth, which the mock-auth sample server does not accept for async processes yet; use it
against an OAuth2 server, or wait for M1 where the kernel adds the session-cookie fallback.

## Reporting what you find

Say which screen, what you pressed, what you expected. If the TUI crashes, the terminal should be restored;
if it is not, `reset` fixes it and the stack trace is in the launching terminal.
