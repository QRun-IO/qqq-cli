# qqq ui: the QQQ terminal UI

A classic full-screen terminal UI for QQQ applications: function-key bar, PgUp/PgDn everywhere, Esc back,
a `:` command line that speaks the CLI grammar, and a live footer. OpenTUI 0.8.1 (React 19) on Bun 1.4.4.
Everything that is not drawing comes from the client kernel (`@qrun-io/qqq-core`): sign-ins and profiles,
the metadata cache, the filter grammar and its completion, FormSession, runProcess, the widget render
model, the record-view and association helpers, the result cursor, file and terminal checks.

## Run it

`qqq ui` is bundled into every `qqq` release binary (curl installer, Homebrew, Scoop); `qqq --version`
says `binary with ui`. The npm package `@qrun-io/qqq-cli` does not carry it. From a source checkout,
`node packages/cli/dist/main.js ui` starts this package with Bun (`QQQ_BUN` names another `bun`):

```sh
npm ci && npm run build                 # once, at the repo root (the kernel and CLI are used built)
(cd packages/tui && bun install --frozen-lockfile)   # once
qqq ui                                  # the default profile; or: qqq --profile sample ui
qqq ui table query person -w "lastName STARTS_WITH S"     # open a screen directly (CLI grammar)
qqq ui --theme light | --ascii | --linear | --mouse | --check | --no-check
bun run packages/tui/src/main.tsx --profile sample        # the same without the CLI
```

Options: `--profile|-p <name>`, `--server|-s <url>` (a profile named after the host is made), `--theme
<name>`, `--ascii` (ASCII glyphs), `--linear` (one region, no Apps pane), `--mouse` (off by default),
`--check` (the full terminal check, then exit), `--no-check` (skip the quick check at startup). Anything
after the options is a route in the CLI grammar.

Environment: `QQQ_UI_LINEAR=1`, `QQQ_UI_ASCII=1` (as the options); `QQQ_UI_SIGN_IN=browser|device` (skip the
OAUTH2 choice); `QQQ_UI_NO_BROWSER=1` (show the sign-in address without opening a browser);
`QQQ_PROFILE`, `QQQ_SERVER`, `QQQ_TOKEN` (a bearer token instead of the stored sign-in), `QQQ_CONFIG_DIR`,
`QQQ_STATE_DIR`, `QQQ_CACHE_DIR`, `QQQ_KEYRING=file` (keep sign-ins in a file instead of the OS keychain),
shared with the CLI. `QQQ_UI_NO_QUIT=1` is for the soak test only.

## Keys

| Key | Does | Key | Does |
|---|---|---|---|
| F1, `?` | keyboard reference for this screen: keys grouped by what they do, the screen's help text, and a pointer to `/`, F9 and `:` (no commands or places) | Esc | back (the screen below keeps its cursor and filter) |
| F2, `/`, `.`, Ctrl+K | search everything: apps, tables, processes, widgets, reports, records (quick search, as you type), commands and help, grouped under headers, best match first; Enter opens or runs; `:search <text>` opens it with text | Tab | Apps pane / content |
| F3, Enter | view, open | ↑ ↓ PgUp PgDn Home End | move and page |
| F4, `e` | edit | Ctrl+F, Ctrl+B | page forward and back (always works) |
| F5, `r` | refresh | Space, Shift+Space | page lists (on a grid Space selects) |
| F6, `f` | filter: condition rows (field, operator, value) with a live match count; F2 types the grammar | ← → | columns, tree |
| F7, `n` | new record (on a child list: a child of this record) | `s` | sort by the column under the cursor |
| F8, `d` | delete, after a question | `]` `[`, Ctrl+N Ctrl+P, PgDn PgUp in a record | next and previous record of the list it came from |
| F9 | the menu in two levels: the areas (Context, Go to, Work, Connection, Settings, Help), then an area's entries; places and records are found with `/` | `b` | run a table process on the selection |
| F10, `:quit` | Quit, Reset (home screen, metadata refreshed, session kept) or Cancel; `:reset` and `:home` reset | `x`, `g`, `v` | export, go to by key, view settings |
| `:` | command line (history ↑↓, Ctrl+R, Tab completes) | Ctrl+S | save a form, continue a process step |
| Ctrl+O, `:servers` | Servers: switch to another saved profile, add, edit | | |
| Ctrl+C | quit at once (the terminal is restored) | `c` | copy a record |
| `a` | actions here (the F9 Context entries) | `A`, `D` | audits, developer view (record or grid) |
| `t` | tags of a record (collaboration extension) | Esc then 1..0, Ctrl+1..0 | F1..F10 when the terminal takes the F-keys |
| `p` | Print… a record, or the grid's selection (printing extension) | | |

Keys on one screen:

| Screen | Keys |
|---|---|
| Grid | `q` quick search, `S` column statistics, `l` follow the link in the cell, Ctrl+A select (page, whole result, first N), Space select row, `b` run on the selection, `a` bulk actions and processes |
| Record | `l` open the row under the cursor, `Z` share (shareable tables), `t` tags, `A` audits, `D` developer, `c` copy; with the collaboration extension `C` comments, `P` attachments, `K` tasks, `T` timeline, `W` follow / stop following |
| Comments, attachments, tasks | `n` adds (a comment, an upload from the file navigator, a task); Enter replies, downloads (file navigator) or deletes, marks a task done or open |
| `:` output | `J` switches an extension operation's JSON between rows and sub-tables and the raw JSON |
| Form | Tab and ↑↓ move, Enter or typing opens a picker, Ctrl+S save, Esc asks before dropping changes |
| Process | Ctrl+S continue, F4 back (when the step allows), Esc cancel, `w` save the step's file, `n` `p` page the records |
| Bulk wizard | Space switch a field on (bulk edit), Enter choose, `h` header row, `l` layout, `k` key fields, `P` saved profiles, `v` validate, Ctrl+S next, F4 back |
| Widget | Enter on its heading: reload, dropdowns, export CSV, run, versions, setup editors |
| Developer (`D`) | ←→ or 1-9 sections, ↑↓ PgUp PgDn scroll, Enter follow the line, `v` view the value in full, `y` copy it, F3 the record (or the grid), Esc back; see [Developer view](#developer-view) |
| Command line | ↑↓ history, Ctrl+R search the history, Tab complete, Enter run, Esc close |
| Filter (F6) | ↑↓ rows, ←→ Tab cells, Enter or typing edits the focused cell (text and numbers in place, choices from a list, Space cycles true/false), Backspace clears it to `(any)`, Ctrl+N add, Ctrl+D remove, Ctrl+O AND/OR, Ctrl+G group, F2 Advanced (grammar, cheat sheet, caret under errors), F10 apply, Esc cancel; see [docs/filter-dialog.md](docs/filter-dialog.md) |

Printing (printing extension, qbit-printing 2.x): on a table the server enabled Print for, `p` (or
Print… in `a` and F9) on a record, or on a grid with records selected with Space (else the record under
the cursor), opens the printer picker. Printers that can take a record print now (approved, exposed by a
connected print agent, PDF) come first; the others are listed with the reason and cannot be picked. The
printer chosen is remembered per profile and preselected next time, marked "(last used)". The records are
queued as one job each; the title bar and status line show `print 1/3 RECEIVED` while they run, and a
flash says when they have printed (or which state stopped them). `:printjobs` (F9 › Work › Print jobs)
lists the recent print jobs; Enter shows one. Without the extension there is no Print action and
`:printjobs` says what is missing. The qbit's own Print process is not listed again under Run.

Single-key shortcuts follow the server preference `keyboard.singleKeyShortcuts` and can be switched in F9
Settings; every F-key action is also in the F9 menu and on the `:` line.

## Developer view

`D` on a record opens its developer view, `D` on a grid the table's. Each is a row of sections (←→ or
the digits switch) over a scrollable pane with a scroll bar and a "lines a–b of n" counter:

- Record: **Security** (record security locks), **Events** (CloudEvents attributes, where the table
  publishes, its subscribers, a sample event), **Scripts** (associated scripts and their revisions:
  Enter shows the code, the run logs or test-runs a revision; a line stores a new version from
  `$EDITOR`), **JSON** (API endpoints, each field's display and raw value, the raw values), **Metadata**
  (summary, fields, sections), **Audits** (Enter shows an entry's changes), **APIs** (application APIs;
  Enter on a version opens its OpenAPI document), then one section per further developer panel the
  server adds (Quick Search, SQL Workbench, Assistant...).
- Table: **Events** (publications and subscribers with their message counters; Enter on a row shows
  every counter), **JSON** (the full table metadata), **Metadata**, **APIs**.

Tables use the grid's column layout (cells cut with `…`, `—` for no value, with a line saying why when
a whole column is empty). JSON is pretty-printed and tinted; a long line is cut in the pane, and `v`
opens the value viewer, which wraps it in full. `y` copies the selected value (pbcopy, wl-copy, xclip or
xsel when present, else the terminal's OSC 52). Links of the web UI become TUI actions (the table
developer view, a record, a grid, a process); those with no TUI screen, such as the ESB overview, show
their URL marked "browser only". Design notes: [docs/developer-view.md](docs/developer-view.md).

## The F9 menu

Two levels, as a menu bar. Level 1 lists the areas with a count and what each holds:

| Area | Holds |
|---|---|
| Context | the actions of the screen you are on (record, grid, process, form, app), and Back |
| Go to | Reset (home), search (`/`), the apps and the recent records (groups: five and `more…`), favorites |
| Work | jobs, notifications, my work, extensions |
| Connection | the server in use (short name and host), Servers (Ctrl+O), profile, stream, metadata, sign out |
| Settings | theme, view settings, shortcuts, layout, ASCII, lock, PIN, idle timeout, folders, server preferences |
| Help | keys and help, search help, check the terminal, help-authoring mode, about, quit |

↑↓ moves, Enter or → opens an area, a letter jumps to the area starting with it (again: the next one, so
`c` `c` is Connection). In an area: ↑↓ and Enter run an entry (its key is on the right), ← or Esc go back
to the areas, Tab and Shift+Tab step to the next and previous area, a letter jumps to the entry starting
with it. Go to lists the apps and the recent records as groups; a group of more than 5 entries (any entry
can name its `group`) shows its first 5 and `more…`, which opens the whole group.

Two or more typed characters search every entry of every area (labels, details, `:` commands, keys;
`/` is the search over tables, processes, widgets and records) and list the matches by area; Tab jumps between areas, Backspace back to nothing
returns to the areas, Esc or F9 closes. An entry that opens a dialog leaves the menu underneath and comes
back to the same entry; an entry that navigates closes it. The menu fits 80×24.

## Servers

Ctrl+O (also `:servers`, F9 › Connection › Servers) opens the saved profiles, one per two lines:

```
    Name       Short  Server                 Status       Last used
▶*● sample     sample http://localhost:8077  UI API 1.8.0 just now
     Tester · mock session · QQQ sample server
    enterprise ent    http://localhost:8078  UI API 1.9.0 2 h ago
     Admin · mock session · Enterprise demo: 22 apps, 182 tables
```

`*` is the default profile, `●` the one in use. Status is probed in the background (GET `/qqq/v1/version`
and the authentication metadata, 2.5 s timeout): `…` while probing, the UI API version, or `unreachable`.
The second line is who is signed in (the keyring's sign-in, else who signed in last), the sign-in, and
the description.

| Key | Does |
|---|---|
| ↑↓ PgUp PgDn | move |
| Enter | switch: the stored sign-in is reused when it is still valid, else the sign-in runs; Home opens on that server with its metadata fetched again |
| `n`, F7 | add a profile: name, short name, description, server, sign-in mode (`auto`, `browser`, `device`); saving checks the server answers `/qqq/v1/version` (Ctrl+S again saves an unreachable one anyway) |
| `e`, F4 | edit the profile (a new name keeps its sign-in; a new server drops it) |
| `d`, F8 | remove the profile and its sign-in, after a question (not the one in use) |
| `*` | make it the default (what `qqq` and `qqq ui` use without `--profile`) |
| `r`, F5 | probe every server again |
| typing | filter on name, short name, description and server; `/` first to filter by a word starting with n, e, d or r |
| Esc | clear the filter, then close |

The **short name** (2 to 6 characters) is what the footer's connection segment (`localhost:8077 · sample ·
mock session`), the Home header and the F9 Connection line show; without one it is the name up to 6
characters, else the initials of a name in parts (`acme-prod-eu` › `ape`) or its first 3 characters
(`enterprise` › `ent`). The CLI edits the same file: `qqq profile list [--probe]`, `qqq profile add <name>
<url> [--short s] [--description d] [--auth-mode m] [--check] [--default]`, `qqq profile edit <name>
[--server url] [--short s] [--description d] [--auth-mode m] [--rename new]`, `qqq profile use <name>`,
`qqq profile remove <name>` (also as `qqq config profile …`).

## Screens

Home is the landing page (and the target of F10 › Reset): greeting and connection, counts, recently viewed
records, quick actions (runnable processes, new records, favorites with collaboration), application cards,
work (jobs, alerts, my work, release notes, extensions) when present, and the instance home app's widgets
when the metadata declares `homeAppName`. Tab moves between panels; `v` orders them.


Sign-in (profiles; MOCK and FULLY_ANONYMOUS get a server session; TABLE_BASED asks for a username and a
masked password, sent once and never stored; OAUTH2 signs in in the browser with authorization code + PKCE
on a loopback redirect, or with the device flow; AUTH_0 uses the browser with the API audience and keeps the
server session; a 401 mid-use opens sign-in on top and returns to the same screen; sign-out can end the
provider session too; the sign-in is shared with the CLI), home (apps with counts, recently viewed), app home
(widgets drawn from render blocks: stats, bar charts in block characters, sparklines, percentage bars,
tables, steppers, then sections with record counts), table grid (server paging, sort, columns that use the
width, horizontal scroll, selection with Space and a bulk bar, export, go to by key), record view (sections
by tier, links, child lists, next and previous through the list it came from), create/edit/copy forms
(editors per type, a picker that narrows for contingent fields, local and server validation by field,
DATE_TIME in the local zone), the process wizard (each step's form, validation review, progress with N/M
and elapsed, summary, cancel; ad hoc widget inputs and buttons), and the output pane of `:` commands run
through the CLI in-process.

Record view: the sections in tier order, then the child lists. The layout is the same for every record of
a table, so paging with PgDn/PgUp moves nothing: field columns are placed from the metadata, and each child
list is a box of fixed height (heading, column header, 5 data rows, a count line). A shorter list pads with
blank rows, an empty one still shows its box, and a longer one scrolls inside the box ("rows 1-5 of 12"):
on a list, PgDn/PgUp scroll it a box at a time and Down/Up (`j`/`k`) a row at its edges, while `]` `[`
still step records; Enter opens the child under the cursor. A section whose `childRecordList` widget lists
an association (by `manageAssociationName` or the association's `joinName`, as the Next UI binds it) shows
that association there, once, under the section's label and with the widget's columns; other associations
follow the sections, and a child's own child lists come last. The row count is a per-table view setting
(`v`, saved as `childRows` in `ui.views.record:<table>`), defaulting to `ui.childRows` of the profile, else
the global `ui.childRows`, else 5.

Widgets (home, app homes, record sections) have their actions on Enter: reload, the payload's dropdowns
(possible values or a date; kept per widget when it asks), export CSV, run a process widget, data bag
versions, script revisions, and on a saved report the filter/columns and pivot setup editors (API-versioned
setups go through the application API). Denied widgets are not requested; a parent widget loads its
children in a grid or one tab at a time. A dynamicForm section has "Edit these fields".

**Collaboration** (collaboration extension): under a record's tags a line shows its comments,
attachments and open tasks with their keys, whether you follow it, and below it who is viewing the record
now (everyone the server reports, you marked "(you)"; the title bar counts the others). `a` and F9 list
comments (list, add, reply), follow or stop following, attachments (list, download, upload, delete), the
timeline, tasks (list, add, done) and the share preview (find people or type user ids, see who could read
the record, then send). Without the extension the line is not drawn and F9 shows "Collaboration: needs the
collaboration extension".

**Widgets** the kernel has no block for are drawn by the TUI: the ESB overview (destinations with their
publishers, triggers and counters, as `:esb overview`; Enter on a destination offers the ESB of its table
and processes, its messages and dead letters), statistics that link to a filtered grid (the label and
count; Enter opens the grid), row-shaped HTML (the alerts setup checklist) in aligned columns, and any
other payload as key/value rows and sub-tables. App cards show the app's Material icon as a glyph (an
ASCII stand-in under the ASCII setting; unknown icons get the app mark).

Dates and date-times use one control everywhere they are edited (forms, process forms, bulk edit, the
filter dialog's value cell). Typed entry shows the value in the profile's display format, with the format
hint (`YYYY-MM-DD`, `MM/DD/YYYY hh:mm AM CST`) dim on the right, and accepts:

| Typed | DATE | DATE_TIME |
| --- | --- | --- |
| `2026-03-05`, `2026-3-5`, `2026/3/5`, `20260305` | 2026-03-05 | 2026-03-05 00:00 |
| `2026-03-05T14:30`, `2026-03-05 14:30:15`, `2026-3-5 2:30pm` | refused (a date has no time) | that time |
| `2026-03-05T20:30:00Z`, `…+02:00` (an instant) | refused | read in the local zone |
| `03/05/2026`, `3/5`, `3/5/26` (order MDY), `05/03/2026`, `5.3` (order DMY) | the date; the current year when left out | the date (and a time after it) |
| `t`, `today` / `n`, `now` | today | today 00:00 / now |
| `14:30`, `2:30 pm` (a time alone) | refused | today at that time |
| `now()`, `now(-7d)`, `now(+2h)`, `startOf(month)`, `startOf(month, -1)` | resolved to a date | resolved to a date and time |
| empty, or Backspace on a whole value (when the field may be empty) | no value | no value |

Slash dates are refused under the ISO order (`01/02/2026 could be month/day or day/month`): `:dates order
mdy` or `dmy` says which. A date that does not exist is refused with the reason (`February 2026 has 28
days`, `hour 25 is out of range (0-23)`), shown in red beside the field, which keeps the focus. F2 or
Ctrl+Space opens the calendar under the field (above it when there is no room): ←→ a day, ↑↓ a week,
PgUp/PgDn a month, Shift+PgUp/PgDn a year, Home/End the first or last of the month, `t` today, `n` now, Tab to
the time row (hour, minute, seconds when the value has them, AM/PM on a 12-hour clock; digits or ↑↓, Tab or
←→ between parts), Enter accepts, Esc cancels, and a digit typed on the calendar goes back to typed entry.
For a DATE_TIME it shows the local zone, the UTC instant that is sent, and the server's zone when the
instance declares one. In the filter dialog Enter on a date value opens the calendar (one for from and one
for to with between) and `p` there opens the presets (`now(-7d)`, `thisPeriod(month)` … kept as
expressions); typed values are read the same way. Enter on an empty date field opens the calendar when
`:dates enter picker` is set. Values go out as before: `YYYY-MM-DD`, and DATE_TIME as the UTC instant of the
local time.

The bulk wizard (`a` on a grid: bulk insert, bulk edit with a file, bulk edit, bulk delete, the upload
template) runs on the kernel's `runBulkProcess`: the file from the file navigator, the column mapping as a
grid (Enter chooses a column, a typed default or value mapping; `h` header row, `l` layout, `k` key fields,
`P` saved profiles, yours and shared), value mapping with the picker, the review with optional validation,
and the result. Shareable records (saved reports, saved views) have Share (`Z`, `:share`): add a user or
group Read-Only or Read and Edit, change, remove; only the owner may share. `:helpkeys` turns on
help-authoring mode (F1 shows every help slot key).

## SQL Runner

With the `sql-workbench` UI API extension (qbit-sql-workbench), the SQL Runner is the terminal face of the
Next UI's Runner page (a `SQL_WORKBENCH` widget). Open it from the SQL Workbench app's Runner in the Apps
tree, `/` (type "sql"), F9 › Work › SQL Runner, or `:sql` (`:sql SELECT …` opens and runs a statement,
`:sql open <id>` opens a notebook). Without the extension the Runner app and the entries are hidden and
`:sql` says the extension is missing. The SQL Workbench app's home is the usual app dashboard (notebooks and
the execution audit), and its tables open as tables.

The layout is a classic database TUI: the SQL editor on top (line numbers, syntax tint, the server's
keywords), the result grid below with a status line (rows, elapsed, backend, read-only, row limit, sort),
an error under the editor with its SQL position marked in the text, and the schema browser on the right.

| Key | Does |
|---|---|
| F5, Ctrl+Enter (Ctrl+J) | run the statement under the cursor (the whole cell when it has one); `:name` parameters are asked for, bound as values and remembered |
| F6 | EXPLAIN: the plan as an indented tree with cost, rows and a relative cost bar; ←→ or Enter fold, `r` the raw text |
| F3 | schema browser: backends › tables › columns, type to filter, → unfolds, Enter inserts the name (on a backend: run this cell there) |
| Tab | complete table and column names from the schema endpoint (after `alias.` the columns of that table); Tabs again cycle |
| Ctrl+↑ Ctrl+↓ | earlier and later SQL from your run history (kept on disk) |
| F2 | notebooks, Mine and Shared: open, `s` save (a new version), `a` save as, `n` new, `u` duplicate, `d` delete, `p` publish |
| F4 | cells: Enter edits one, `a` add SQL, `m` add notes, K J (Shift+↑↓) move, `t` title, `b` backend, `d` delete, `R` run all |
| F7 | your audited runs (status, time, rows, SQL); type to filter, Enter opens the SQL in the editor, Ctrl+R re-runs it |
| Shift+Tab, Esc | to the results and back; Esc also cancels a running statement and, from the editor, leaves (asking about unsaved changes) |
| results: ↑↓ PgUp PgDn ←→ | move; rows load page by page from the server's cached result |
| results: `s` `V` `x` | sort by the column (the server sorts: asc, desc, off), the whole value, export (csv, xlsx, json through the file flow) |
| results: `g` `c` `p` | grid, quick chart (text bars of a number column; ←→ value column, `l` label column), plan |

Markdown cells are edited as text and shown rendered below. Runs are read-only (one statement, the server's
row limit and timeout; every run is audited). The capabilities decide the backends offered, the row limit
shown and whether EXPLAIN ANALYZE is offered (it needs the write permission). `scripts/smoke-sql.sh [server]`
drives it in tmux at 80x24 and 120x36 against a server with the extension (default `http://localhost:8078`).

## The `:` command line

TUI commands: `home`, `back`, `quit`, `reset`, `refresh`, `help`, `helpkeys`, `menu`, `search <text>` (also `find`, `goto`, `palette`), `view`,
`views`, `share`, `actions`, `audits`, `dev`, `tags`, `report run <name>`, `theme <name>`, `ascii on|off`,
`linear on|off`, `shortcuts on|off`, `dates [order ymd|mdy|dmy] [clock 24h|12h] [week monday|sunday] [weeknumbers on|off] [enter picker|next]`, `lock`, `pin`, `pin remove`, `idle <minutes>`, `filter [clear|<grammar>]`,
`export <format>`, `jobs`, `profile [name]`, `servers`, `server <url>`, `signout`, `connection`, `doctor`, `open <table>`,
`app <name>`, `record <table> <key>`, `sql [statement | open <id>]`. `table query|get|create|update|delete` and `process run` open screens;
any other CLI command runs in-process (`runCli` from `@qrun-io/qqq-cli/program`) and shows its output;
an extension operation (`:alerts get-inbox`, `:collab get-records-tasks customer 1`, `:api <operationId>`)
shows its JSON as key/value rows and sub-tables, with `J` for the raw JSON.

## Large instances

Palettes, F9 and the Apps-pane filter search a kernel index built once per metadata document
(`MetaDataIndex`): nothing lists every table. App dashboards load widgets only as they come into view, four
requests at a time, cancelled when the screen is left. `bun run packages/tui/scripts/fake-big-server.ts`
serves a generated 1000-table, 500-process, 3000-widget instance on port 8099 to try it
(`qqq ui --server http://localhost:8099`).

## Settings kept locally

Everything below is local to the machine and shared with the CLI; nothing is sent to the server.

- `~/.config/qqq/config.json` (`QQQ_CONFIG_DIR`), owned by the kernel:
  - `profiles` (`server`; optional `short`, `description`, `authMode` (`auto`, `browser`, `device`), the
    1.0.0-rc.1 `note`, `lastUsedAt` and `user` recorded by the UI, and `ui.theme` for that profile only)
    and `defaultProfile`. Fields are only ever added: a 1.0.0-rc.1 file loads unchanged.
    Sign-ins themselves are in the OS keychain (or the file keyring), one per profile.
  - `ui.theme`: the theme for every profile without its own.
  - `ui.dates` (global, or in a profile's `ui`): date order (`YMD`, `MDY`, `DMY`), `clock` (`24h`, `12h`),
    `weekStart`, `weekNumbers`, `pickerOnEnter`, set with `:dates`. Without them the clock and the first day
    of the week follow the locale (`LC_ALL`, `LC_TIME`, `LANG`), else 24-hour and Monday; the order is ISO.
  - `ui.views`: per screen. `table:<name>` columns (in order), widths, fit (content or fill), stripes,
    header rule, density, sort, pinned columns; `record:<name>` one or two columns and the label width;
    `app:<name>` widget order; `widget:<name>` dropdown choices of widgets that ask to keep them.
  - `ui.files`: download and upload folders and whether a download asks or saves silently.
  - `ui.lock`: the screen-lock PIN (a salted hash, never the PIN) and the idle minutes (0 = off).
  - `ui.doctor`: the answers to the terminal check; `ui.recents`: recently viewed, per server.
- `~/.local/state/qqq/` (`QQQ_STATE_DIR`): the `:` and filter histories (`history-commands`,
  `history-filters`); lines that look like secrets are not kept.
- `~/.cache/qqq/` (`QQQ_CACHE_DIR`): the metadata cache.

Themes: `high-contrast` (the default: bright text on black, strong selection), `classic` (the blue
function-key look), `light` (dark text on a light background). Choose with `:theme <name>`, F9 › Settings ›
Theme (for this profile or for all), or `--theme`; the option wins over the profile, the profile over the
global choice. `--ascii` replaces box drawing and symbols. Colours come only from the tokens in
`src/theme.ts`.

The CLI equivalent dialog copies its command with `y` (or Enter); F9 › Settings can copy it automatically, and Shift+drag selects it with the terminal.

F9 › Settings also holds single-key shortcuts on/off (default: the server preference
`keyboard.singleKeyShortcuts`), the download and upload folders, the PIN and idle lock, and the terminal check.

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
- Whatever the terminal does, Ctrl+F / Ctrl+B page and the F9 menu and `:` line reach every action; Esc then
  a digit (or Ctrl+digit) stands for F1..F10.

## Tests

```sh
cd packages/tui && bun test          # or npm run test:tui at the root: the whole TUI against a fake server in memory
packages/tui/scripts/smoke.sh        # tmux against a running server (profile "sample"); captures kept
packages/tui/scripts/smoke-widths.sh # fixed grid widths across pages (fake large-instance server)
packages/tui/scripts/smoke-sql.sh [server]  # SQL Runner at 80x24 and 120x36 (default the enterprise server on 8078)
packages/tui/scripts/perf-large-table.sh  # PRF-001: 10,000 rows x 40 columns, timings against a 2 s budget
packages/tui/scripts/soak.sh [server] [minutes]  # random keys for 10 min; fails on an exit or an error boundary
```

## Layout of the code

`src/store.ts` holds all state and dispatches every key (lock, overlay, global F-keys, focused pane, fallbacks),
so handlers read live state, never a stale closure. Screens (`src/screens/*`) are route entries that keep their
own state (grid cursor, filter, selection, scroll), which is why Esc finds them as they were. Overlays
(`src/overlays/*`) are modal. Text fields are `LineEditor` objects driven by keys, not OpenTUI's focused
input, so a burst of keys lands in the field that had focus. Shared controls (`src/controls/*`) are the date control:
`DateEditor` (typed entry, a `LineEditor`), `DatePickerOverlay` (the calendar) and their wiring for forms,
bulk edit and the filter cell; a screen whose field wants F2 says so with `claimsKey`. `src/app.tsx` draws the frame with an error
boundary around every screen and overlay; `src/main.tsx` restores the terminal on any crash.
