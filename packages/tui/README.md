# qqq ui: the QQQ terminal UI

A classic full-screen terminal UI for QQQ applications: function-key bar, PgUp/PgDn everywhere, Esc back,
a `:` command line that speaks the CLI grammar, and a live footer. OpenTUI 0.8.1 (React 19) on Bun 1.4.4.
Everything that is not drawing comes from the client kernel (`@qrun-io/qqq-core`): sign-ins and profiles,
the metadata cache, the filter grammar and its completion, FormSession, runProcess, the widget render
model, the record-view and association helpers, the result cursor, file and terminal checks.

## Run it

```sh
npm install && npm run build            # once, at the repo root (the kernel and CLI are used built)
(cd packages/tui && bun install)        # once
qqq ui                                  # the default profile; or: qqq --profile sample ui
qqq ui table query person -w "lastName STARTS_WITH S"     # open a screen directly (CLI grammar)
qqq ui --theme light | --ascii | --linear | --mouse | --check | --no-check
bun run packages/tui/src/main.tsx --profile sample        # the same without the CLI
```

`QQQ_UI_LINEAR=1` gives the one-region layout (no Apps pane), `QQQ_UI_ASCII=1` the ASCII glyphs.

## Keys

| Key | Does | Key | Does |
|---|---|---|---|
| F1, `?` | help: keys, what you can do here, help search | Esc | back (the screen below keeps its cursor and filter) |
| F2, `/`, `.`, Ctrl+K | go to anything; record search when the server has a provider | Tab | Apps pane / content |
| F3, Enter | view, open | ↑ ↓ PgUp PgDn Home End | move and page |
| F4, `e` | edit | Ctrl+F, Ctrl+B | page forward and back (always works) |
| F5, `r` | refresh | Space, Shift+Space | page lists (on a grid Space selects) |
| F6, `f` | filter: guided builder or the grammar with completion | ← → | columns, tree |
| F7, `n` | new record (on a child list: a child of this record) | `s` | sort by the column under the cursor |
| F8, `d` | delete, after a question | `]` `[`, Ctrl+N Ctrl+P, PgDn PgUp in a record | next and previous record of the list it came from |
| F9 | the command center: every action, searchable | `b` | run a table process on the selection |
| F10, `:quit` | Quit, Reset (home screen, metadata refreshed, session kept) or Cancel; `:reset` and `:home` reset | `x`, `g`, `v` | export, go to by key, view settings |
| `:` | command line (history ↑↓, Ctrl+R, Tab completes) | Ctrl+S | save a form, continue a process step |
| Ctrl+C | quit at once (the terminal is restored) | `c` | copy a record |

Single-key shortcuts follow the server preference `keyboard.singleKeyShortcuts` and can be switched in F9
Settings; every F-key action is also in the F9 menu and on the `:` line.

## Screens

Sign-in (profiles; MOCK and FULLY_ANONYMOUS get a server session, OAUTH2 and AUTH_0 the device flow with the
code on screen; the sign-in is shared with the CLI), home (apps with counts, recently viewed), app home
(widgets drawn from render blocks: stats, bar charts in block characters, sparklines, percentage bars,
tables, steppers, then sections with record counts), table grid (server paging, sort, columns that use the
width, horizontal scroll, selection with Space and a bulk bar, export, go to by key), record view (sections
by tier, links, child lists, next and previous through the list it came from), create/edit/copy forms
(editors per type, a picker that narrows for contingent fields, local and server validation by field,
DATE_TIME in the local zone), the process wizard (each step's form, validation review, progress with N/M
and elapsed, summary, cancel), and the output pane of `:` commands run through the CLI in-process.

## The `:` command line

TUI commands: `home`, `back`, `quit`, `help`, `menu`, `goto`, `view`, `theme <name>`, `ascii on|off`,
`linear on|off`, `shortcuts on|off`, `lock`, `pin`, `pin remove`, `idle <minutes>`, `filter [clear|<grammar>]`,
`export <format>`, `jobs`, `profile [name]`, `server <url>`, `signout`, `connection`, `doctor`, `open <table>`,
`app <name>`, `record <table> <key>`. `table query|get|create|update|delete` and `process run` open screens;
any other CLI command runs in-process (`runCli` from `@qrun-io/qqq-cli/program`) and shows its output.

## Settings kept locally

In `~/.config/qqq/config.json` (the kernel owns the file), section `ui`: `theme` (also per profile),
`views["table:person"]` (columns, widths, fit, zebra, header rule, density), `views["record:…"]`
(columns, label width), `views["app:…"]` (widget order), `files` (download and upload folders, ask or save
silently), `lock` (screen-lock PIN as a salted hash, idle minutes), `doctor` (terminal check choices),
`recents`. Command histories live in `~/.local/state/qqq/history-commands` and `history-filters`.

Themes: `high-contrast` (default), `classic`, `light`; tokens in `src/theme.ts`, no color elsewhere.

## Keys that your terminal may intercept

The TUI runs in the alternate screen and reads PgUp/PgDn itself, but a terminal or tmux can take a key
before any program sees it. `qqq ui --check` (and the quick check at startup) finds these and offers fixes.

- **tmux.** A root binding such as `bind -n PageUp if-shell -F "#{pane_in_mode}" "send-keys PageUp" "copy-mode -eu"`
  enters copy-mode on every PgUp, full-screen program or not. Let full-screen programs have the keys and keep
  scrollback in the shell:

  ```tmux
  bind -n PageUp   if-shell -F "#{alternate_on}" "send-keys PageUp"   "copy-mode -eu"
  bind -n PageDown if-shell -F "#{alternate_on}" "send-keys PageDown" ""
  ```

  Keep `set -g alternate-screen on`, `set -g default-terminal "tmux-256color"` and true color
  (`set -as terminal-overrides ',*:Tc'`).
- **iTerm2.** If PgUp/PgDn scroll the window, map Page Up/Down in Profiles › Keys › Key Mappings to "Send Escape
  Sequence" `[5~` and `[6~`; "Scroll wheel sends arrow keys in alternate screen mode" affects the wheel only.
- **Terminal.app.** F1 to F10 go to macOS unless "Use F1, F2, etc. keys as standard function keys" is on
  (System Settings › Keyboard), or hold fn.
- Whatever the terminal does, Ctrl+F / Ctrl+B page and the F9 menu and `:` line reach every action.

## Tests

```sh
cd packages/tui && bun test          # or npm run test:tui at the root: the whole TUI against a fake server in memory
packages/tui/scripts/smoke.sh        # tmux against a running server (profile "sample"); captures kept
```

## Layout of the code

`src/store.ts` holds all state and dispatches every key (lock, overlay, global F-keys, focused pane, fallbacks),
so handlers read live state, never a stale closure. Screens (`src/screens/*`) are route entries that keep their
own state (grid cursor, filter, selection, scroll), which is why Esc finds them as they were. Overlays
(`src/overlays/*`) are modal. Text fields are `LineEditor` objects driven by keys, not OpenTUI's focused
input, so a burst of keys lands in the field that had focus. `src/app.tsx` draws the frame with an error
boundary around every screen and overlay; `src/main.tsx` restores the terminal on any crash.
