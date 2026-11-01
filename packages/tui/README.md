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
qqq ui --theme light | --ascii | --linear | --no-mouse | --check | --no-check
bun run packages/tui/src/main.tsx --profile sample        # the same without the CLI
```

Options: `--profile|-p <name>`, `--server|-s <url>` (a profile named after the host is made), `--theme
<name>`, `--ascii` (ASCII glyphs), `--linear` (one region, no Apps pane), `--no-mouse` / `--mouse` (the
mouse for this run; the saved Mouse setting is on by default, see [Mouse](#mouse)),
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
| F2 | **Search**: records across tables (quick search), the main way into the data; `:search <text>`; typing on Home starts it (see below) | Tab | Apps pane / content |
| `/`, `.`, Ctrl+K | find anything: apps, tables, processes, widgets, reports, records, commands and help, grouped, best match first; `:find <text>` | | |
| F3, Enter | view, open | ↑ ↓ PgUp PgDn Home End | move and page |
| F4, `e` | edit | Ctrl+F, Ctrl+B | page forward and back (always works) |
| F5, `r` | refresh | Space, Shift+Space | page lists (on a grid Space selects) |
| F6, `f` | filter: condition rows (field, operator, value) with a live match count; F2 types the grammar | ← → | columns, tree |
| F7, `n` | new record (on a child list: a child of this record) | `s` | sort by the column under the cursor |
| F8, `d` | delete, after a question | `]` `[`, PgDn PgUp (Ctrl+N: next) in a record | next and previous record of the list it came from |
| F9 | the menu in two levels: the areas (Context, Go to, Work, Connection, Settings, Help), then an area's entries; places and records are found with `/` | `b` | run a table process on the selection |
| F10, `:quit` | Quit, Reset (home screen, metadata refreshed, session kept) or Cancel; `:reset` and `:home` reset | `x`, `g`, `v` | export, go to by key, view settings |
| `:` | command line (history ↑↓, Ctrl+R reverse search, Tab completes) | Ctrl+S | save a form, continue a process step |
| Ctrl+O, `:servers` | Servers: switch to another saved profile, add, edit | | |
| Ctrl+C | quit at once (the terminal is restored) | `c` | copy a record |
| `a` | actions here (the F9 Context entries) | `A`, `D` | audits, developer view (record or grid) |
| `t` | tags of a record (collaboration extension) | Esc then 1..0, Ctrl+1..0 | F1..F10 when the terminal takes the F-keys |
| Ctrl+P, `p`, PrtSc | print what you see: record sheet, table list (all rows or this page), or the screen (printing extension; else save as a file) | | |

Keys on one screen:

| Screen | Keys |
|---|---|
| Grid | `q` quick search, `S` column statistics (from the loaded rows when the server offers none; `a` there loads up to 10,000 rows and recomputes), `l` follow the link in the cell, Ctrl+A select (page, whole result, first N), Space select row, `b` run on the selection, `a` bulk actions and processes |
| Record | `l` open the row under the cursor, `Z` share (shareable tables), `t` tags, `A` audits, `D` developer, `c` copy; with the collaboration extension `C` comments, `P` attachments, `K` tasks, `T` timeline, `W` follow / stop following |
| Comments, attachments, tasks | `n` adds (a comment, an upload from the file navigator, a task); Enter replies, downloads (file navigator) or deletes, marks a task done or open |
| `:` output | `J` switches an extension operation's JSON between rows and sub-tables and the raw JSON |
| Form | Tab and ↑↓ move, Enter or typing opens a picker, Ctrl+S save, Esc asks before dropping changes |
| Process | Ctrl+S continue, F4 back (when the step allows), Esc cancel, `w` save the step's file, `n` `p` page the records |
| Bulk wizard | Space switch a field on (bulk edit), Enter choose, `h` header row, `l` layout, `k` key fields, `P` saved profiles, `v` validate, Ctrl+S next, F4 back |
| Widget | Enter on its heading: reload, dropdowns, export CSV, run, versions, setup editors |
| Developer (`D`) | ←→ or 1-9 sections, ↑↓ PgUp PgDn scroll, Enter follow the line, `v` view the value in full, `y` copy it, F3 the record (or the grid), Esc back; see [Developer view](#developer-view) |
| Command line | ↑↓ history, Ctrl+R reverse search (as bash: type to narrow, Ctrl+R or ↑ older, ↓ newer, Enter runs, Esc or ←→ edits, Ctrl+G cancels; searches the activity log's commands, CLI ones too), Tab complete, Enter run, Esc close |
| History (`:history`) | type to filter, Enter does the entry again, `y` copies the CLI equivalent, `c` or F8 clears (asks), `t` relative or absolute times, `/` starts a filter beginning with `y` or `c`, Esc clears the filter, then back |
| Filter (F6) | ↑↓ rows, ←→ Tab cells, Enter or typing edits the focused cell (text and numbers in place, choices from a list, Space cycles true/false), Backspace clears it to `(any)`, Ctrl+N add, Ctrl+D remove, Ctrl+O AND/OR, Ctrl+G group, F2 Advanced (grammar, cheat sheet, caret under errors), F10 apply, Esc cancel; see [docs/filter-dialog.md](docs/filter-dialog.md) |

Printing: **Ctrl+P prints what you see, on every screen** (also `p` on records and grids, Print… in `a`
and F9, F8 where the screen has no Delete for it, `:print`, and the Print Screen key where the terminal
passes it on — most do not, so Ctrl+P is the key to rely on):

- a record view prints its **record sheet** (the record's sections in tier order and a summary of each
  child list);
- a grid prints a **table list** with the columns, widths, filter and sort you see. It asks what: **all N
  rows (current filter and sort)** — the first choice when the grid is filtered or has at most 2,000 rows —
  or **this page**, and with a Space selection the **selected rows as a list** or **a record sheet for each
  selected row**. The server prints up to 10,000 rows (more prints the first 10,000 and says so), repeats
  the header on every page, turns the page landscape when the columns need it and puts the table, filter,
  sort, row count, user and time in the header and footer;
- any other screen (home, dashboards, the developer view, SQL results, process results, output) prints the
  **screen as text**: a monospace PDF of what is drawn, without the status line and F-key bar, sized so a
  wide terminal keeps its lines.

Then the printer picker: printers that can print now (approved, exposed by a connected print agent, PDF)
come first, the others are listed with the reason and cannot be picked; the printer chosen is remembered
per profile and preselected next time, marked "(last used)". `:print <printer>` skips the picker (name,
unique prefix or id). The title bar and status line show `print 1/3 RECEIVED` while jobs run, and a flash
says when they have printed (or which state stopped them, or the row-limit note). `:printjobs` (F9 › Work ›
Print jobs) lists recent jobs. Without the printing extension (or on a server older than printing 2.1 for
lists and screens) Ctrl+P saves instead: a grid opens its export, other screens save their text as a file.
The CLI forms still work on the command line: `:print person 1 2`, `:print job list`. Record sheets and
table lists need qbit-printing 2.1 (`registerAll` puts Print on every table).

Single-key shortcuts follow the server preference `keyboard.singleKeyShortcuts` and can be switched in F9
Settings; every F-key action is also in the F9 menu and on the `:` line.

## Mouse

The mouse works everywhere and adds to the keys; nothing needs it, and every click does what a key does.
It follows the classic full-screen conventions (Midnight Commander, Turbo Vision):

| Where | Click | Double-click | Right click | Wheel | Drag |
|---|---|---|---|---|---|
| Grid | row and cell under the cursor | opens the record | the actions (`a`) at that row | 3 rows; Shift+wheel 3 columns | header: at a column's right edge resizes it, elsewhere moves it (saved as the view settings save widths and order) |
| Apps tree | selects; on ▸/▾ opens or closes | opens or closes a node, opens a table, process or app | | 3 lines | |
| Lists (home panels, app home, record child lists, `:` results, sign-in) | selects | runs the entry (Enter) | the actions there | 3 lines | |
| Record, form, process, bulk wizard | focuses the field or line | opens a choice list or file dialog, toggles a check box | the actions | 3 lines | |
| Developer view | a section tab switches to it; a line selects it | follows the line (Enter) | | 3 lines | |
| SQL Runner | focuses the editor (and puts the caret there), the results or the schema; a result row and cell; a notebook cell tab; the `g grid` `c chart` `p plan` tabs | whole value of a result cell; inserts a schema name | | 3 lines; Shift+wheel result columns | |
| Completion popups (SQL editor, `:` line) | selects a line | inserts it (Tab) | | moves the choice | |
| Date picker | picks the day; ◂ ▸ page the month | picks the day and accepts | | moves by weeks | |
| Dialogs (F9 menu, Servers, `/` search, F1 keys, pickers, files, tags, view settings, filter, notebooks, cells, history) | selects an entry or cell; `[ Yes ]` `[ No ]` `[ Apply ]` `[ Cancel ]` answer; in F9 the `Menu › Area` line goes back a level | opens an F9 area, runs or picks (Enter); switches to a server | | scrolls the dialog | |
| F-key bar | presses that key (also with a dialog open, as the key would) | | | | |
| Footer | the server and profile open the Servers dialog (Ctrl+O) | | | | |
| Screen saver, lock | wakes it, as a key does (then the PIN, when one is set) | | | | |

A click on the screen or the Apps pane focuses it; a click beside a dialog does nothing (it does not close
it); hovering does nothing. The terminal reports presses, drags and the wheel only (button-event tracking
with SGR 1006 coordinates, which iTerm2, Terminal.app, Windows Terminal, kitty, WezTerm and tmux all speak);
there is no motion tracking.

**Selecting text.** While the TUI has the mouse, the terminal selects text only with a modifier: Shift+drag
in most terminals (Windows Terminal, tmux, kitty, most Linux terminals), Option/Alt+drag in some (iTerm2);
Terminal.app toggles mouse reporting with View › Allow Mouse Reporting (⌘R). Help (`?`) and the dialogs
that show text to copy say so in their footer. F9 › Settings › **Mouse: off** (or `:mouse off`, saved in `ui.mouse`; `--no-mouse` for one run)
gives the terminal plain selection back; `:mouse on` or Settings again turns it on.

**tmux.** With `set -g mouse on`, tmux passes clicks and the wheel to the TUI while it has the mouse (and
selects text with Shift+drag); with `mouse off`, tmux sends nothing and the TUI is keyboard-only. In tmux's own
copy-mode the wheel scrolls tmux's history, as usual.

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
| Work | jobs, print jobs, history, notifications, my work, extensions |
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
follow the sections, and a child's own child lists come last. The record view settings (`v`) are a form
like the grid's View settings, saved per table in `ui.views.record:<table>`: Columns (auto, 1, 2 with Space or
←→), Label width (`labelWidth`, 8 to 60: type digits, `+`/`-` or ←→ step by one, Backspace returns to auto),
Child list rows (`childRows`, 1 to 50, the same keys; Backspace returns to the default, `ui.childRows` of the
profile, else the global `ui.childRows`, else 5), the Collaboration panel when the extension is present, and
Reset to defaults (`r`, with a confirm). `*` marks a value changed from the default; Enter saves, Esc cancels.

Nothing is drawn outside its container: every line is cut to the cells it has (measured in terminal cells,
so wide characters count double) and a cut ends in `…`; dialogs never extend past the screen, and key help
lines break between keys (at ` · `), dropping the least important keys first when they do not fit. Long
values in grid cells and record fields are cut with `…` to the column; `V` on the grid (or "Whole value" in
`a` / F9) shows the whole value of the cell under the cursor, wrapped in a dialog, and `V` on a field row of
the record view does the same for its field (both fields of a two-column row). A column width saved wider than the terminal is held to the grid's width.

Widgets (home, app homes, record sections) have their actions on Enter: reload, the payload's dropdowns
(possible values or a date; kept per widget when it asks), export CSV, run a process widget, data bag
versions, script revisions, and on a saved report the filter/columns and pivot setup editors (API-versioned
setups go through the application API). Denied widgets are not requested; a parent widget loads its
children in a grid or one tab at a time. A dynamicForm section has "Edit these fields".

**Search** (F2, everywhere; on Home the search line is first and typing starts it): a search line with
results as you type, grouped by table with the table's label and count; each hit shows the record label,
its key and the highlighted snippet with the matched field. ↑↓ move, ←→ or Tab go to the next or previous
table, Enter opens the record (Esc comes back to the same hit), `o` opens the table's grid filtered to the
hits, Space marks hits and `a` offers the grid (export, print, bulk there) and the table's processes for
them, `f` searches one table, `h` the recent searches of the profile, `?` the quick search syntax. The status
line reads "N matches in M tables · 42 ms · index 1,234 records · last reindex 10:12" (from the quick search
status). Quick search matches every word (AND) from the start of words, case-insensitively; it has no
phrases, `field:value`, wildcards or OR (`status:new` searches `new`, with a note). Without the quick search
extension F2 still opens Search, finding tables, apps and processes by name and the records of the table
it was opened from ("quick search not installed: searching names only").

**Collaboration** (collaboration extension) lives at the bottom of the record view, never above its
sections: the record starts right under its title and the cursor on its first field. A strip directly above
the key line shows the tags, the counts of comments, files and open tasks, the timeline, whether you follow
the record and who is viewing it (`Tags: rush, vip (t) · 3 comments (C) · 1 file (P) · 0 tasks (K) ·
timeline (T) · following (W) · viewing: Admin (you)`); when others are on the record their names and what
they do (`Pat (editing email)`) replace "(you)" and the strip takes an accent colour. When the strip does not
fit, timeline and the follow state go first, the viewers and the tags last. On terminals of 140 columns or
more a Collaboration panel on the right (36 columns) shows the tags, the latest two comments (author, age,
first line), the open tasks and the next due date, the files, the followers and everyone viewing now with
what they are doing; the strip is then the keys only. The panel is a record view setting (`v`:
Collaboration panel row: auto, on or off; on shows it whenever the record keeps 60 columns). Presence changes
redraw the strip and the panel live. Every strip segment and panel row is a click zone that presses its key
(`t` `C` `P` `K` `T` `W`; the panel's heading lists everything, a viewer shows who is here). `a` and F9 list
comments (list, add, reply), follow or stop following, attachments (list, download, upload, delete), the
timeline, tasks (list, add, done) and the share preview (find people or type user ids, see who could read
the record, then send). Without the extension neither the strip nor the panel is drawn and F9 shows
"Collaboration: needs the collaboration extension".

**Text and HTML widgets** are drawn as a document: headings (HTML h1-h4, markdown `#`, or a short line
before a block) in the accent colour with a blank line before, status badges (OK green, WARN/DEGRADED
yellow, FAIL/DOWN red) at a fixed width, `Label: value` lists aligned, dates in your date format (`:dates`),
paragraphs at ~100 cells, enumerations as bullets (`src/text-doc.ts`).

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

## Assistant

With the `assistant` UI API extension (qbit-assistant), **F12** shows and hides the Assistant panel on
every screen (also `Ctrl+G`, `:ask [question]`, F9 › Work › Assistant, or a click on `12Ask`). It is a
chat pane on the right of the screen (40 to 64 columns), or the whole body on terminals narrower than 110
columns. The question line is at the bottom and the conversation above it. Answers are read-only and use
your permissions.

Hiding the panel keeps the conversation, its context and the draft on the question line; the next F12
shows them again. When the panel is shown but the screen beside it has the focus (after opening a link),
F12 goes back to the question line. F11 is reserved.

Answers are drawn from their markdown: entities decoded, headings in the accent colour, paragraphs
wrapped to the pane, bullet and numbered lists, **bold** and `code`, and pipe tables laid out like the
grid (columns that do not fit are named underneath, cells cut with `…`). A link shows as `label ↗`, never
its address; each is a Tab target in reading order, once per target. Records and tables the tool results
refer to that the text does not show are listed under `→`. Exact duplicate paragraphs are shown once;
the timing and token line stays, dimmed.

Questions carry the screen the panel was shown over as context, the way the Next UI's panel sends it: a
record (`/app/{table}/{id}`) or a grid with its filter; the first line of the panel says which
(`on: Person #3`). While the panel is beside the screen, a record or grid you open becomes the context.

| Key | Does |
|---|---|
| Enter | ask the question; on a link, open it (a record or a grid, beside the panel; a full-width panel hides so the screen shows) |
| Tab, Shift+Tab | move over the answer's links; typing returns to the question line |
| u | on a link: show its address |
| ↑ ↓ | the questions you asked on this profile (on the links: previous and next link) |
| PgUp PgDn, wheel | scroll the conversation |
| Ctrl+D | send without (or again with) the page context |
| Ctrl+L | a new conversation |
| Ctrl+X | stop the answer being written |
| F12, Ctrl+G | hide the panel (again: show it) |
| Esc | hide the panel (with text on the question line too: nothing is asked, the draft stays); on a link, back to the question line |

**F12 in your terminal.** The F-key bar shows `11` (blank, reserved) and `12Ask` from 120 columns;
narrower, the `?` help and F9 › Work say "F12 assistant". The TUI reads F12 both as the legacy sequence
(`ESC [24~`, also with modifiers, as tmux and iTerm2 send it by default) and as the kitty keyboard
protocol's key (57375). macOS may take F12 for Mission Control or Dashboard, or send it only with `fn`
(System Settings › Keyboard › Keyboard Shortcuts, or "Use F1, F2, etc. keys as standard function keys");
Ctrl+G is the fallback everywhere.

Without the extension the menu entry is disabled, `12Ask` is dimmed and F12 says what is missing. When
the assistant is off for you (no model provider on the server, no permission, the kill switch) the panel
shows the server's reason and what to configure; F5 checks again. The command line has the same:
`qqq assistant ask`, `qqq assistant config`.

## SQL Runner

With the `sql-workbench` UI API extension (qbit-sql-workbench), the SQL Runner is the terminal face of the
Next UI's Runner page (a `SQL_WORKBENCH` widget). Open it from the SQL Workbench app's Runner in the Apps
tree, `/` (type "sql"), F9 › Work › SQL Runner, or `:sql` (`:sql SELECT …` opens and runs a statement,
`:sql open <id>` opens a notebook). Without the extension the Runner app and the entries are hidden and
`:sql` says the extension is missing. The SQL Workbench app's home is the usual app dashboard (notebooks and
the execution audit), and its tables open as tables.

The layout is a classic database TUI: the SQL editor on top (line numbers, syntax tint, the server's
keywords), the result grid below drawn like the main grid (columns in the server's order, a row-number
gutter, a header rule, dates at seconds precision, grouped numbers right-aligned, NULL as a dim `—`, zebra
per the `sql:results` view setting), then a status line (rows, elapsed, backend, read-only, row limit,
sorted by) and the key line,
an error under the editor with its SQL position marked in the text, and the schema browser on the right.

| Key | Does |
|---|---|
| F5, Ctrl+Enter (Ctrl+J) | run the statement under the cursor (the whole cell when it has one); `:name` parameters are asked for, bound as values and remembered |
| F6 | EXPLAIN: the plan as an indented tree with cost, rows and a relative cost bar; ←→ or Enter fold, `r` the raw text |
| F3 | schema browser: backends › tables › columns, type to filter, → unfolds, Enter inserts the name (on a backend: run this cell there) |
| Tab | the completion popup, also with nothing typed: after FROM / JOIN every table (with its column count), after SELECT / WHERE / ON or `alias.` the statement's columns (with types), at the start the statement keywords and recent statements; typing filters, ↑↓ Enter or Tab inserts, Esc closes |
| Ctrl+↑ Ctrl+↓ | earlier and later SQL from your run history (kept on disk) |
| F2 | notebooks, Mine and Shared: open, `s` save (a new version), `a` save as, `n` new, `u` duplicate, `d` delete, `p` publish |
| F4 | cells: Enter edits one, `a` add SQL, `m` add notes, K J (Shift+↑↓) move, `t` title, `b` backend, `d` delete, `R` run all |
| F7 | your audited runs (status, time, rows, SQL); type to filter, Enter opens the SQL in the editor, Ctrl+R re-runs it |
| Shift+Tab, Esc | to the results and back; Esc also cancels a running statement and, from the editor, leaves (asking about unsaved changes) |
| results: ↑↓ PgUp PgDn ←→ | move; rows load page by page from the server's cached result |
| F8, results: `x` | the export dialog: csv, tsv, xlsx or json of every row of the result (the server writes csv/xlsx/json from its cached result; tsv is read page by page) through the file navigator and the download-folder preference (the name is pre-filled and editable, e.g. `sql-result-1a2b3c4d_2026-11-01_102316.csv`), or copy to the clipboard for small results |
| results: `s` `V` `y` `Y` Ctrl+Y | sort by the column (the server sorts: asc, desc, off), the whole value, copy the cell, the row (TSV), the whole result (TSV) |
| results: Shift+←→, `a` | scroll the columns (◂ ▸ show more off screen); the actions menu (export, copy, chart…) |
| results: `g` `c` `p` | grid, quick chart (text bars of a number column; ←→ value column, `l` label column), plan |

Markdown cells are edited as text and shown rendered below. Runs are read-only (one statement, the server's
row limit and timeout; every run is audited). The capabilities decide the backends offered, the row limit
shown and whether EXPLAIN ANALYZE is offered (it needs the write permission). `scripts/smoke-sql.sh [server]`
drives it in tmux at 80x24 and 120x36 against a server with the extension (default `http://localhost:8078`).

## The `:` command line

TUI commands: `home`, `back`, `quit`, `reset`, `refresh`, `help`, `helpkeys`, `menu`, `search <text>` (also `find`, `goto`, `palette`), `view`,
`views`, `share`, `actions`, `audits`, `dev`, `tags`, `report run <name>`, `theme <name>`, `ascii on|off`,
`linear on|off`, `shortcuts on|off`, `dates [order ymd|mdy|dmy] [clock 24h|12h] [week monday|sunday] [weeknumbers on|off] [enter picker|next]`, `lock`, `saver [style|style <s>|refresh <s>|tables <a,b>|burnin on|off|dim <minutes|off>]`, `pin`, `pin remove`, `idle <minutes>`, `filter [clear|<grammar>]`,
`export <format>`, `jobs`, `history`, `profile [name]`, `servers`, `server <url>`, `signout`, `connection`, `doctor`, `open <table>`,
`app <name>`, `record <table> <key>`, `sql [statement | open <id>]`. Tab on an empty line lists every
command with a one-line description; after a command it lists its arguments (tables, processes, apps,
profiles, subcommands), in the same popup as the SQL editor. `table query|get|create|update|delete` and `process run` open screens;
any other CLI command runs in-process (`runCli` from `@qrun-io/qqq-cli/program`) and shows its output;
an extension operation (`:alerts get-inbox`, `:collab get-records-tasks customer 1`, `:api <operationId>`)
shows its JSON as key/value rows and sub-tables, with `J` for the raw JSON.

### History

`:history` (or F9 › Work › History) opens everything done on this profile, in the TUI and with the CLI
(`qqq history` lists the same log): number, time, client, kind (100 columns and wider) and summary, newest
at the bottom with the cursor there; the line under the list shows the entry's command. Typing filters
(every word must match the summary, command, kind or client). Enter does the entry again: a `:` command
runs, a record, app or process opens, a query opens the table with its filter, a CLI command runs on the
`:` line (asking first when it changes data). `y` copies the CLI equivalent, `c` or F8 clears the history
after a question. The screen fits 80×24.

What the TUI records: `:` commands; opened apps, tables, records and processes (with the CLI equivalent,
e.g. `qqq table get person 3`); queries with filters (`qqq table query person -g "…"`, values of password
fields as `***`); records created, edited and deleted (which record and fields, never values); process
runs with their outcome and time; exports with the file; prints with the job ids; server switches; sign-in
and sign-out. Ctrl+R on the `:` line searches these commands too.

## Screen saver and lock

`:lock`, F9 › Settings › Screen saver / lock, or the idle timeout (`:idle <minutes>`) shows the screen
saver; any key wakes it. With a PIN set (`:pin`) the PIN prompt opens over the saver, which keeps
animating; Esc goes back to the saver. `:saver` previews it at once (no PIN asked), `:saver bounce`,
`starfield`, `flip` or `big` previews one style.

Live tiles, refreshed every 10 to 30 s (`:saver refresh <seconds>`, F9 › Settings) and only while the
saver shows. A tile whose extension is missing or that answers 403/404 is hidden, so the saver works on
the plain sample server; one that fails shows `…`, then its last value dimmed as stale, and backs off
(interval × 2ⁿ, at most five minutes).

| Tile | Needs | Shows |
|------|-------|-------|
| Online | collaboration | people in presence across a few tables per refresh (favourites and recents first), who and on what; the signed-in user's other sessions as "you elsewhere" |
| Jobs | `durableJobs` | running, queued and recently failed jobs (all users with jobs_admin, else yours) |
| Health | health | the summary status and up / degraded / down / unknown counts |
| Database | db-performance | live sessions, connections of the maximum, cache hit ratio, blocking chains |
| ESB | esb | queue depth, dead letters, in flight, broker down |
| Alerts | alerts | unread notifications and the latest one |
| Events | `realtime` | events per minute on the stream the TUI keeps open, with a ten-minute sparkline |
| Server | — | ping and UI API version (no request) |
| *table* | — | record counts of up to three favourite tables: `:saver tables person,order` (per profile) |

Styles (F9 › Settings › Screen saver style, `:saver style <s>`; `auto` cycles every three minutes):
**Bounce** (Query, the qrun.io mascot, and the name of the profile you are connected to in block letters
drift DVD-style and change colour at every wall, with the tiles in a panel riding beside them),
**Starfield** (stars fly out of the centre, Query drifts through, the tiles float), **Flip clock** (big
flip digits, the date and server, tiles beneath, Query peeking from a corner) and **Big numbers** (the most
interesting metric in block digits with Query beside it, or below it on a narrow terminal, the caption and
the other tiles under it as one centred stack, rotating every 8 s). In a tall narrow terminal Bounce stacks
the tile panel under Query. The block letters say the profile's
short name when it has 6 characters or fewer (else the profile name), with the server host in plain text
beneath; letters, digits, `-`, `_` and `.` are drawn in block letters, anything else falls back to plain
text. Query blinks, wags and hops every ten seconds and faces the way he drifts; the art (braille, with a
line-art version for `--ascii`) is in `src/saver/query-art.ts`.

Burn-in guard (F9 › Settings › Screen saver burn-in guard, `:saver burnin on|off`, default on): nothing
stays put, so an OLED or CRT does not keep a ghost of the saver. The clock · server · profile line and the
"locked · any key to unlock" line move to a new place every 30 s (a random column, the top and bottom rows
swapping); Bounce's tile panel follows the logo, on the side with room (if Query and the panel do not fit
together, the panel shows for 20 s and then Query for 20 s, both drifting); the flip clock's cards and tiles
drift a cell every few seconds inside a small box; Big numbers moves its whole stack to another spot near the centre at each rotation;
Starfield's tiles keep floating. Each style is one compact group (Big numbers and Flip clock are at most about
90 columns wide however wide the terminal, the tiles in one or two adjacent columns), and the clock line and
the lock line sit just above and below it, swapping every 30 s. The clock stays visible throughout. `off` keeps the fixed layout (clock
and server on the top row, the hint on the last, tiles in the bottom-right corner).

Dimming (F9 › Settings › Screen saver dim, `:saver dim <minutes|off>`, default 10): once the saver has been
up that long, every colour fades toward the background. Both settings are saved in the `saver` section.
Animation runs at 4 frames a second at most and about one when nothing moves; only the saver repaints.

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
  - `ui.theme`: the theme for every profile without its own; `ui.mouse`: `false` when the mouse is off.
  - `ui.dates` (global, or in a profile's `ui`): date order (`YMD`, `MDY`, `DMY`), `clock` (`24h`, `12h`),
    `weekStart`, `weekNumbers`, `pickerOnEnter`, set with `:dates`. Without them the clock and the first day
    of the week follow the locale (`LC_ALL`, `LC_TIME`, `LANG`), else 24-hour and Monday; the order is ISO.
  - `ui.views`: per screen. `table:<name>` columns (in order), widths, fit (content or fill), stripes,
    header rule, density, sort, pinned columns; `record:<name>` one or two columns and the label width;
    `app:<name>` widget order; `widget:<name>` dropdown choices of widgets that ask to keep them.
  - `ui.files`: download and upload folders and whether a download asks or saves silently.
  - `ui.lock`: the screen-lock PIN (a salted hash, never the PIN) and the idle minutes (0 = off).
  - `saver`: the screen saver style, refresh seconds, `burnin` (default on) and `dimMinutes` (default 10, 0 off); `profiles.<name>.saver.tables`: favourite tables.
  - `ui.doctor`: the answers to the terminal check; `ui.recents`: recently viewed, per server.
- `~/.local/state/qqq/` (`QQQ_STATE_DIR`): the `:` and filter histories (`history-commands`,
  `history-filters`); lines that look like secrets are not kept. `activity/<profile>.jsonl`: the activity
  log the History screen and `qqq history` read (one JSON event per line, rotated once to `.1` at 5 MB;
  secrets are written as `***`; `QQQ_HISTORY=off` stops it).
- `~/.cache/qqq/` (`QQQ_CACHE_DIR`): the metadata cache.

Themes: `high-contrast` (the default: bright text on black, strong selection), `classic` (the blue
function-key look), `light` (dark text on a light background). Choose with `:theme <name>`, F9 › Settings ›
Theme (for this profile or for all), or `--theme`; the option wins over the profile, the profile over the
global choice. `--ascii` replaces box drawing and symbols. Colours come only from the tokens in
`src/theme.ts`.

The CLI equivalent dialog copies its command with `y` (or Enter); F9 › Settings can copy it automatically, and Shift+drag selects it with the terminal.

F9 › Settings also holds the mouse on/off, single-key shortcuts on/off (default: the server preference
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
  (`set -as terminal-overrides ',*:Tc'`); `set -g mouse on` lets clicks and the wheel through to the TUI
  (see [Mouse](#mouse)).
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
packages/tui/scripts/mouse-smoke.sh  # the mouse in tmux: SGR 1006 clicks, drags and wheel written into the pane
packages/tui/scripts/smoke-widths.sh # fixed grid widths across pages (fake large-instance server)
packages/tui/scripts/smoke-sql.sh [server]  # SQL Runner at 80x24 and 120x36 (default the enterprise server on 8078)
packages/tui/scripts/overflow-sweep.sh [server]  # every screen and dialog at 80/100/120/200 x 24/50: no text past a border
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
