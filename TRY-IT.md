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

## M0 shell (2026-10-31): classic TUI against the sample server

```sh
qqq-tui-spike            # the shell: app tree, tables, records, processes, live footer
qqq-tui-spike test       # in-memory renderer tests
```

Keys (the function-key bar at the bottom is the truth):

| Key | Does | Key | Does |
|---|---|---|---|
| F1 | help | Esc | back a screen, or back to the Apps tree |
| F2 | go to any table or process by name | Tab | switch between the Apps tree and the content |
| F3 | view the record under the cursor | Enter | open (tree item, table row) |
| F4 | edit (M3) | ↑ ↓ PgUp PgDn Home End | move and page, server-side paging on tables |
| F5 | refresh | ← → | scroll columns; expand or collapse tree nodes |
| F6 | filter a table: `field OPERATOR value[,value]` | `s` | sort by the bracketed column |
| F7 | new record (M3) | `:` | command line: `table person lastName STARTS_WITH S`, `record pet 3`, `process sleepInteractive`, `home`, `quit` |
| F8 | delete the record under the cursor, with confirm | F9 | menu |
| F10 | quit | Ctrl+C | quit immediately |

Footer status line, live: server, auth and session, UI API version, ping (every 5 s), realtime stream state
(reconnects on its own), job count (`n/a` when the server has no `/jobs`), last stream event, clock.

Things to try: open Person, PgDn through Pets or Cities, F6 with `birthDate GREATER_THAN 1990-01-01`,
delete a pet with F8 and watch the count, restart the server with `qqq-sample-server restart` and watch
the footer go to `reconnecting` and back.

## M0 legacy screens: generated grid and form

```sh
QQQ_SPIKE_SCREEN=legacy qqq-tui-spike    # Ctrl+G grid, Ctrl+F form, Ctrl+P process, Ctrl+Q quit
qqq-tui-spike binary                      # the compiled macOS binary (legacy screens)
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
