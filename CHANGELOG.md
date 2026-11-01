# Changelog

All notable changes to the qqq CLI and its packages. Versions follow [semver](https://semver.org);
`@qrun-io/qqq-ui-api-client` follows the UI API version of the document it is generated from.

## [Unreleased]

### Changed

- TypeScript 5.8.3 to 7.0.2 (the Go-based compiler) and `@types/node` 22.15.3 to 26.6.6 across the workspace, `packages/tui` and `packages/tui-spike`. TypeScript 7 no longer loads every `@types/*` package implicitly, so `tsconfig.base.json` now lists `"types": ["node"]`; `@types/node` 26 no longer accepts an `undefined` assertion message, so one conformance test passes a real fallback message. No behaviour change.

### Fixed

- The screen saver's Online tile said "nobody around" with two terminals signed in. It now counts signed-in sessions first (the session store's table: sessions active in the last 10 minutes and their users, your own included, "2 sessions · 1 user (you ×2)"), else you plus the people in collaboration presence; it never says nobody is around while you are signed in. The saver also keeps its presence lease on the screen under it (the extension has no idle state), so other clients see you still viewing it instead of gone. A server that stores no sessions and merges presence per user (mock auth) shows both terminals as "1 online · you".
- Query in the screen saver looked like a different dog. All sizes are now generated from the drawing on https://www.qrun.io/query/ (`scripts/gen-query-art.mjs`) in its indigo, with a new medium size (25×13 cells, used where there is room) between the large (42×22) and the small (17×9).
### Added

- **F12 shows and hides the Assistant panel** on every screen (Ctrl+G, `:ask` and a click on `12Ask` do
  the same). Hiding keeps the conversation, its context and the draft; Esc hides too (with a draft,
  nothing is asked). The F-key bar has `11` (reserved, blank) and `12Ask` from 120 columns (dimmed
  without the extension); narrower, the `?` help and F9 › Work say "F12 assistant". F12 is read as the
  legacy `ESC [24~` and as the kitty keyboard protocol key; README notes macOS's F12 mapping.
- Assistant panel: `u` on a link shows its address.
- Kernel: `parseMarkdown`, `markdownText`, `answerDocument` and `linkTargetKey` (render/markdown.ts): the
  assistant's markdown as blocks with numbered links, one per target (a filter on the primary key is
  that record; JSON and base64 filters compare by content).
- **`qqq ui`: the Shift bank.** Shift+F1…F10 are a second row of function keys: Keys (the `?`
  reference), Servers, SQL (SQL Runner), Bulk, Metadata (refresh), Views (saved views), Copy (into a new
  record), Export, History and Assistant (the same toggle as F12 and Ctrl+G). Like the primary bar they follow the
  screen: keys that do not apply are dimmed and say why when pressed. The assignments are one table bound to
  named actions (`assistant.toggle` and the rest), so other keys can bind the same actions.
- **The F-key bar in two rows** (primary, then the Shift row marked `⇧`) on terminals of 30 lines or more;
  `:fkeys one|two|auto` and F9 › Settings › F-key bar choose (saved as `ui.fkeyBar`). In one-row mode the
  Shift row replaces the primary row for 2 seconds after a Shift+F press. Clicks on the Shift row run its
  keys; `?` lists the bank.
- **One decoder for modified function keys** across terminals: xterm modifier forms (tmux, iTerm2, Windows
  Terminal), the kitty keyboard protocol, the legacy `ESC [25~`…`ESC [34~` numbering (VT220, rxvt and
  the Linux console, macOS Terminal.app; `QQQ_FKEYS` overrides the detection) and rxvt's `$ ^ @`
  suffixes. Ctrl+F-keys are decoded too (no bindings yet).

- **Save as PDF…** is the first entry of the UI's printer picker (record `p`, grid Ctrl+P, `:print`; `:print pdf`
  saves straight away): the server renders the same record sheet, table list or page (printing
  `printingRenderToPdf`) and the PDF is saved the way downloads and exports are — the save dialog or, with
  silent downloads, the download folder, the stamped name (`Customer-Ada-Lovelace_2026-11-01_120301.pdf`), no
  silent overwrite. The CLI's `qqq print`, `qqq print list` and `qqq print text` take `--to-file [path]` (a
  folder, a file, or the download folder by default).
- Ctrl+P on screens that are not records or grids asks **Print what?**: **Content** (the default: the screen's
  panels as a document with their titles, without navigation or borders) or **Screen** (the terminal as drawn).
- Every printed or saved page carries the app's header (instance name, breadcrumb, server, user, time in the
  profile's date format) and footer (`qqq ui <version> · <server>` or `qqq <version> · <server>`, a grid's filter
  and sort, page n of m); the CLI sends the same.
- `scripts/print-agent.sh` prints to `~/Downloads` unless `QQQ_PRINT_OUT` says otherwise (`--dir` reports it).
- The kernel adds `renderToPdf`, `renderValues`, `canSaveAsPdf`, `chromeValues` and content sections on text
  prints; the TUI's breadcrumbs moved to `breadcrumbs.ts`.
- **`qqq ui` starts on a splash**: Query (the qrun.io mascot) blinking and wagging while it boots, the `qqq`
  wordmark, the version and a status line that follows the boot (reading profiles, connecting, signing in,
  loading metadata with the table count). Large Query from about 34 rows, the small one beside the
  wordmark at 80×24, plain characters under `--ascii`; any key stops the animation, not the boot; shown at
  least 600 ms. `--no-splash`, `QQQ_UI_NO_SPLASH=1` or F9 › Settings › Splash on start (`:splash on|off`,
  saved as `ui.splash`) skip it.
- **A profile picker on start**: with several profiles and none named (`--profile`, `QQQ_PROFILE`,
  `--server`, `QQQ_SERVER`), the Servers picker opens over the splash with the last used profile selected;
  Enter connects, `n` adds, the server status fills in as the probes answer, Esc quits with a one-line hint
  about `--profile`. With no profile at all the add form opens directly; with exactly one, it connects.
- **Connection failures stay on the splash** with the reason: Enter retries, `c` chooses another profile, `n`
  adds one, Esc quits (instead of the bare error on the sign-in screen).

### Changed

- With several profiles and none named, `qqq ui` asks which to connect to instead of using the default
  profile (`--profile` or `QQQ_PROFILE` keeps the old behaviour).

### Fixed

- **The assistant's answers render** instead of showing raw markdown, in the TUI panel and in
  `qqq assistant ask`: HTML entities decoded (`healthy&#58;` was shown as is), headings, wrapped
  paragraphs, lists, bold and code, and pipe tables laid out as a grid (CLI: sub-tables) instead of `| --- |`
  rows. Links show as `label ↗` (CLI: `label (qqq table get …)` or `label [n]` with the command under
  Links), never their URL-encoded `/app/...?filter=` targets; the tool results' links are listed only
  when the text does not already show the same target, so `db_performance` no longer appears three times.
  Exact duplicate paragraphs are shown once; the timing and token line stays, dimmed.
- **Shift+F3 and the other modified F3s** (`ESC [1;2R`) no longer vanish: OpenTUI took them for cursor
  position reports. They are rewritten on the input stream into `ESC [13;2~` outside the startup
  cursor-query window.

## [1.0.0] - 2026-11-01

`qqq` 1.0: the command-line client and the full-screen terminal UI (`qqq ui`), shipped together as one
binary per platform. Packages: `@qrun-io/qqq-cli` 1.0.0, `@qrun-io/qqq-core` 1.0.0 (new),
`@qrun-io/qqq-ui-api-client` 1.8.0, `@qrun-io/qqq-ui-api-conformance` 1.6.0. Servers: UI API 1.6.0 up
to 2.0 (QQQ 4.1.0-RC.15 or later). Released as 1.0.0-rc.1 first (tags `v1.8.0-rc.2`,
`cli-v1.0.0-rc.1`); this entry is that candidate's plus everything that landed after it. Short commit ids
in parentheses mark the changes made after the candidate.

### Added

#### Command line

- **The grammar** is `qqq <noun> <verb>` (`table query`, `process run`, ...); the 0.1 flat commands
  (`apps`, `tables`, `query`, `get`, `run`, `jobs`, `tail`) still work as aliases.
- **Sign-in**: session sign-in for MOCK and anonymous servers; OAuth2 device flow and browser sign-in with
  PKCE on a loopback redirect; TABLE_BASED `qqq login --username` (password asked, or `QQQ_PASSWORD`; only
  the server session is kept, a refused password stores nothing); refresh before expiry; `logout
  --provider-logout` revokes (RFC 7009) and opens the end-session page; refused refreshes exit 3. Sign-ins
  live in the macOS Keychain, Linux Secret Service, Windows DPAPI or a 0600 file.
- **Profiles** (`--profile`, `QQQ_PROFILE`) with a **short name** (2 to 6 characters, for the footer and
  Home), a **description**, a **sign-in mode** for OAuth2 servers (`auto` asks, `browser`, `device`) and
  the last use and user; all additive in `config.json`, so files written by 1.0.0-rc.1 load unchanged and
  keep their `note` (shown when there is no description). `qqq profile list|add|edit|use|remove` (also
  under `qqq config profile`): `add` and `edit` take `--short`, `--description`, `--auth-mode` and
  `--check` (refuse unless the server answers), `edit` takes `--server` and `--rename`, an empty value
  removes a field, `list --probe` adds each server's status (d9317f5).
- **Tables**: `list`, `describe`, `query` (filters, sort, paging, `--search`, `--join` and `table.field`
  columns, `--count`, `--print-filter`, saved views with `--view`), `count`, `stats` (server columnStats, else
  computed from the matching records with a note on stderr; `--local` forces it, `--no-local` restores the
  error, `--max-records` caps the read at 10,000 by default; 7c66b16), `get` (sections, adornments, `--associations`, `--links`, `--follow`, `--key`, `--copy`),
  `create`, `copy`, `update` (`-e` edits HTML and code fields in `$EDITOR`), `delete`, `children`,
  `export` (csv, tsv, xlsx, json), `download` and `--upload` for file fields, `variants` and `--variant`
  everywhere (the chosen variant is remembered per server), `columns`, `actions` (what you can do to a
  table, with the command for each), `api-call` and `widget-form`.
- **Forms**: contingent fields (country, state, city) with narrowing possible values, labels or unique
  partial labels for ids (also in `--where`), local validation with the server's codes, form adjusters,
  interactive `-i`, CHIP values in their colours.
- **Filters**: the grammar (shorthand operators, quoting, AND/OR groups, expression values such as
  `now(-7d)`, `thisPeriod(month)`, `me()`). Text filters ask for case-insensitive matching (`CONTAINS`,
  `STARTS_WITH`, `ENDS_WITH`, quick search); `~=`, `OPERATOR:CS` or `--case-sensitive` ask for a
  case-sensitive match. The server does not read the option over the UI API yet (finding 27), so matching
  stays case-sensitive until it does.
- **Processes**: `list`, `describe`, `run` with every step component (help, HTML as text, view pairs,
  process records, the validation review, summary lines, downloads, widgets), asynchronous jobs with
  progress, `--file` for BLOB fields, back steps, min/max input records, and Ctrl-C that cancels the run on
  the server (exit 130).
- **Bulk load and bulk changes**: `table bulk-insert` from a CSV or Excel file (the upload template, the
  server's column suggestion, a mapping document, flags or `-i`, value mapping, the validation review,
  `--dry-run`), `table bulk-edit` of chosen records or by key rows from a file, `table bulk-delete` with
  review and confirmation, and `bulk-profile list | save | rename | delete` for saved mappings.
- **Dates**: DATE_TIME typed and shown in the local zone (`TZ`), sent as UTC instants; `--utc` for raw.
- **More nouns**: `apps show` (app homes with counts, `--widgets`), `home` (counts, quick actions, recent
  records), `find` (the command palette: an app, table, process or report by label), `tail`, `saved-view`,
  `audit list`, `report run` and `saved-report list | show | preview | run | set | pivot | schedules |
  schedule`, `share` (records of shareable tables), `widget` (charts and tables as text, `--record`,
  `--run`), `job`, `prefs`, `help show`, `help-search`, and `api <operationId>` for any of the 219
  operations.
- **Search**: `qqq search` shows the matched field and snippet (`match`), takes `--table` repeated or as a
  comma list, `--limit` per table, names the tables and the total in the footer, searches `field:value`
  with a note, lists the quick search syntax in `--help` and prints the whole response with `--json`
  (0e07f8a).
- **Developer mode and scripts**: `table apis`, `table api-doc`, `table developer`, and `script list | show
  | store | test | logs`.
- **Extensions**: a noun per extension the client document knows (14: esb, collab, health, alerts,
  assistant, sql-workbench, ...), gated on the server's installed extensions and documented minimum
  versions; first-class verbs for `esb` and `collab` (presence, comments, favorites, follow, my work, tags
  by id or label). Results print scalars as aligned key/value rows (nested objects as dotted keys) and each
  list of objects as a sub-table fitted to the terminal width, with default columns for the inbox,
  notebooks, SQL history, comments, tasks, favorites and recents and `--columns a,b` (or `--fields`) to
  choose; `--json`, yaml, csv and text are unchanged (5e34433).
- **Printing** (the printing extension, qbit-printing 2.x): `qqq print <table> <id...>` renders each record
  as a record sheet through the table's Print process, queues one job per record and follows the jobs until
  they have printed (`--printer`, `--copies`, `--no-wait`, `--timeout`; exit 1 when a job failed, 4 when
  jobs are still running at the timeout); `qqq print list <table>` prints a table list (criteria, order,
  columns, `--page`, paper and orientation; up to 10,000 rows); `qqq print text [file|-]` prints text as a
  monospace PDF; `qqq print job list|status [--watch]|cancel`; `qqq printer list|use|show|forget|devices`.
  The printer chosen is remembered per profile (`printing.printers` in config.json). Without the extension
  the commands exit 5 with the installed list (c1e7bf9, 4bd62b7, d632987, d81c053).
- **Disabled tables and processes** are listed with the reason, and queries, writes, copies, bulk commands
  and runs on them are refused before any request, as the web explains the denial.
- **Shell completion** for bash, zsh, fish and PowerShell from the local metadata cache; `cache show |
  refresh | clear`; `config set theme` and `download-dir`.
- **Diagnostics and conventions**: `qqq doctor`, `qqq --version` (the build and the supported UI API
  range), build lines in `qqq doctor` and `qqq ui --check`, consistent exit codes (2 usage, 3 auth, 4
  unreachable or 502/503/504, 5 not found, 6 validation, 70 server error), downloads that never overwrite a
  file or leave `--out-dir`.
- **History**: `qqq history` lists everything you did with the CLI and the TUI on the profile in use,
  like a shell history (number, relative or `--absolute` time, client, kind, summary; `--limit`, `--since
  2h|2026-11-01`, `--grep`, `--kind`, `--all-profiles`, `--commands`, `--format`); `qqq history rerun <n>`
  runs a line again (asking first for commands that change data), `qqq history clear` empties it. The
  activity log is one JSONL file per profile in `~/.local/state/qqq/activity/`, rotated once at 5 MB;
  secrets (token, password and PIN flags, secret pairs and filter values, Authorization headers) are
  written as `***`; `QQQ_HISTORY=off` turns it off (0bcc735).
- Uploading an attachment to a server without the Object Storage QBit says "This server cannot store
  attachments: the Object Storage QBit is not installed."; any server failure naming a missing QBit gets one
  such line (437ed3c).
- **Assistant** (assistant extension, qbit-assistant): `qqq assistant ask "<question>"` streams the
  answer as the model writes it, then prints its numbers (counts, metrics) and the records and tables it
  refers to as a table with the command that opens each; `--table <t> [--record <id>]` sends that page as
  context the way the Next UI's panel does, `-c <id>` continues a conversation, `--json` prints the whole
  answer. `qqq assistant config` shows whether it answers and with which model, or the reason
  (`NOT_CONFIGURED`: no model provider, with what to configure). The generated operation subcommands stay
  (a5e0cf4).

#### Terminal UI (`qqq ui`)

- **A classic full-screen UI** in the same binary and on the same profiles and sign-ins as the CLI:
  function-key bar (F1 Help to F10 Quit, with Esc+digit for terminals that take the F-keys), PgUp/PgDn
  everywhere, Esc back with the screen below keeping its place, a `:` command line that speaks the CLI
  grammar (history, Ctrl+R, Tab completion listing every command with a description, then its arguments),
  and a live footer (server and profile, sign-in, UI API version, ping, realtime stream, jobs, clock).
  `qqq ui table query person -w ...` opens a screen directly.
- **Home**: greeting and connection, counts, recently viewed records, quick actions, favorites,
  application cards (each with the app's icon as a glyph, an ASCII stand-in under the ASCII-glyphs
  setting), work (jobs, alerts, my work, release notes) and the instance's home widgets. F10 offers Quit,
  Reset (back to Home with fresh metadata) or Cancel. Home starts with the search line (0691e6f, ef2b554).
- **Search (F2)**, the main way into the data: a full screen with a search line, quick search results as you
  type grouped by table, each hit's label, key and highlighted snippet with the matched field; ←→/Tab
  cycle the tables, Enter opens the record (Esc returns to the hit), `o` opens the table's grid filtered to
  the hits, Space marks hits for `a` (grid, export, print, bulk, processes), `f` narrows to one table, `h`
  recent searches (per profile), `?` the quick search syntax. The status line shows matches, tables, time,
  index size and the last reindex. Without quick search F2 searches names and the records of the current
  table. `:search <text>` opens it. When nothing matches it explains the coverage ("Quick search indexes 17 of 189
  tables (Customer, Order, … and 12 more) · 57 records · last reindex 10:38. Tables not indexed cannot be
  found here; add them in Quick Search Admin › Quick Search Index, or press `o` to search Person by name"),
  and the status line names the indexed tables (ef2b554, d76fb03, 81a044f).
- **`/` finds anything**, one search over apps, tables, processes, widgets, reports, records (quick
  search, debounced as you type), commands and help, grouped under headers with the best match first
  (`.`, Ctrl+K and `:find <text>` too). **F1 and `?`** are only the keyboard reference of the screen: keys
  grouped by what they do, the screen's help text and a pointer to `/`, F9 and `:` (70c064e). A metadata search index keeps both fast on large instances.
- **F9, the command center, in two levels**: first the areas (Context, Go to, Work, Connection, Settings,
  Help) with a count and a one-line summary each, then one area's entries with their keys. ↑↓ moves, Enter
  or → opens an area, its first letter jumps to it, ← or Esc goes back, Tab steps to the next area; two
  characters search every entry, listed by area; it fits 80x24 (13c020f).
- **Servers dialog** (Ctrl+O, `:servers`, F9 › Connection › Servers): every saved profile with its short
  name, server, status (UI API version, probed in the background with a 2.5 s timeout), last use, who is
  signed in, the sign-in and its description. Enter switches (the stored sign-in is reused, else the
  sign-in runs) and Home opens on that server with fresh metadata; `n` adds, `e` edits, `d` removes, `*`
  makes the default, `r` probes again, typing filters. Adding or editing checks that the server answers
  `/qqq/v1/version` (3c45c8e).
- **Tables**: a server-paged grid with columns sized to the screen, fixed rows that never vanish when a
  screen overflows, horizontal scroll, sort, view settings, quick search, column statistics, saved views,
  table variants, selection with a bulk bar, export and go-to by key. Large tables stay quick (a 10,000 x
  40 table draws its first page in about 100 ms).
- **The filter dialog (F6)**: every condition is a row of field, operator and value, edited the way its
  type asks (text and numbers in place, choices from a searchable list, Space cycles true/false, dates
  with presets or typed, operators that fit the field); a row without a value shows `(any)` and is not
  applied; AND/OR and groups are drawn as structure; the help and key lines follow the focus; the footer
  shows a live match count. Advanced mode (the grammar, with completion) adds a cheat sheet, a caret under
  parse errors and says why it cannot switch back to Guided. Commands are on Ctrl and F keys so letters
  always type (Ctrl+N add, Ctrl+D remove, Ctrl+O AND/OR, Ctrl+G group, F2 mode, F10 apply); Esc asks
  before discarding changes (067d97c).
- **Records**: sections by tier, links, child lists, next and previous through the list a record came
  from, create, edit and copy forms with an editor per field type, contingent pickers that narrow, local and
  server validation by field, file uploads and BLOB downloads through a file navigator, audits (`A`) and
  tags (`t`).
- **Record collaboration** (collaboration extension), at the bottom of the record view so the record starts
  right under its title with the cursor on its first field: a dim strip above the key line with the tags,
  comments, attachments, open tasks, whether you follow it and who is viewing now with their keys (`Tags: none
  (t) · 0 comments (C) · … · viewing: Admin (you)`; others viewing or editing replace "(you)" with an accent;
  segments drop whole when the width is short), and from 140 columns a right-hand Collaboration panel (view
  setting `collaboration panel: auto/on/off`) with the latest comments, the next due task, the followers and
  each viewer's state. In `a`/F9 (keys `C` `P` `K` `T` `W`): comments (list, add, reply), follow and stop
  following, attachments (list, download through the file navigator, upload, delete), the timeline, tasks
  (list, add, done) and the share preview (who could read the record, then send). Strip segments and panel
  rows are click zones. Without the extension F9 says "needs the collaboration extension" (b782812, 3e80043).
- **Developer view** (`D` on a record or a grid) in sections (Security, Events, Scripts, JSON, Metadata,
  Audits, APIs, then any further developer panel; ←→ or 1-9) over a scrollable pane: tables in the grid's
  column layout, JSON pretty-printed and tinted (`v` opens the value viewer, `y` copies), web links turned
  into TUI actions or shown as browser only, a record's field values, API endpoints, audits and script test
  runs, a table's ESB counters, metadata and JSON; F3 goes to the record or the grid (f236c7b).
- **Processes**: the wizard draws every step as the web does (help, HTML, view values, records, the
  validation review, widgets, downloads), with back steps, record limits, progress with elapsed time and
  cancel.
- **Bulk load and bulk changes**: a wizard for bulk insert and bulk edit from a file (upload through the
  file navigator, a column mapping grid with typed defaults and field help, value mapping, review with
  optional validation, result), bulk edit of switched-on fields, bulk delete, saved bulk-load profiles and
  the upload template.
- **Reports, saved reports and sharing**: run reports (process reports and streaming ones), edit a saved
  report's filter, columns and pivot, and share records of shareable tables (`Z`, `:share`) with users or
  groups.
- **Sign-in in the UI**: TABLE_BASED username and password, OAuth2 in the browser (authorization code with
  PKCE, the device flow as the alternative) and Auth0; sign-out ends the server or provider session; a
  session that expires mid-use opens sign-in on top and returns to the screen.
- **Widgets that act**: dropdowns and date pickers, parent widgets with children in a grid or tabs, process
  widgets, data bag versions, script revisions, export, ad hoc buttons and inputs, dynamicForm editing and
  composite widgets; dashboards and widgets drawn in block characters (stats, bar charts, sparklines,
  percentage bars, tables, steppers); the ESB overview as `:esb overview` shows it (destinations,
  publishers, triggers, counters; Enter on a destination offers its table's ESB, messages and dead
  letters); disabled tables, processes and apps explain the denial, and capabilities gate new, edit,
  delete and copy (19cc3ec). Text and HTML widgets (Quick Search Admin's Search Diagnostics, the SQL Workbench
  summary, the alerts cards) are drawn as a document with the web's hierarchy: headings in the accent colour,
  leading status words (OK, WARN, FAIL, DEGRADED, DOWN, ...) as fixed-width coloured badges, `Label: value`
  items as an aligned two-column list, ISO timestamps in the profile's date format, paragraphs wrapped at
  about 100 cells, enumerations as bullets, button rows of links as items that Enter follows (ASCII badges
  and bullets under the ASCII setting) (d7c6e65).
- **Extension operations on the `:` line** (`:alerts get-inbox`, `:api <operationId>`); widget payloads
  without a terminal block show their JSON as key/value rows and sub-tables, and `J` shows the raw JSON.
- **Dates: type them or pick them**: one date control for DATE and DATE_TIME fields in create and edit
  forms, process forms, bulk edit and the filter dialog's value cell. Typed entry shows the value in the
  profile's display format with the format hint (and zone), and reads ISO, the display format, partial
  dates (`2026-3-5`, `3/5`), `t`/`today`, `n`/`now` and the filter grammar's `now(-7d)` and
  `startOf(month)`; a date that does not exist is refused with the reason and the field keeps the focus.
  F2 or Ctrl+Space opens a month calendar anchored to the field (arrows, PgUp/PgDn, Shift a year, Home/End,
  `t` today) with a time row for DATE_TIME. `:dates order ymd|mdy|dmy clock 24h|12h week monday|sunday
  weeknumbers on|off enter picker|next` sets the format per profile. Values go out as before: `YYYY-MM-DD`
  and DATE_TIME as the UTC instant of the local time, bulk edit included (ad4001d).
- **Printing**: **Ctrl+P prints what you see on every screen** (also `p` on records and grids, F8 where the
  screen has no Delete, `:print [printer]`, `a`, F9 and the Print Screen key where the terminal passes it
  on). A record view prints its record sheet; a grid prints a table list with the columns, widths, filter
  and sort shown, choosing all rows, this page, or the selection as a list or as record sheets; any other
  screen prints its text as a monospace PDF. A printer picker shows unprintable printers with the reason
  and preselects the last used one; jobs are followed in the title bar and status line, and `:printjobs`
  lists recent jobs. Without printing, Ctrl+P saves instead (the grid's export, else the screen text). No
  Print action is offered without the extension (acfb090, 555c434).
- **SQL Runner** (sql-workbench extension), from the SQL Workbench app, `/`, F9 › Work and `:sql`: an SQL
  editor with syntax tint, F5 / Ctrl+Enter running the statement under the cursor, completion popups
  (tables after FROM, columns after SELECT, keywords and recent SQL), history; a server-paged,
  server-sorted result grid drawn like the main grid; F8 / `x` export every row as csv, tsv, xlsx or json
  or copy it, `y` `Y` Ctrl+Y copy the cell, row or result; errors inline with their SQL position; EXPLAIN as
  a plan tree (F6); a schema browser (F3); notebooks with SQL and markdown cells (F2, F4); quick text bar
  charts; the audited run history with re-run (F7). Read-only runs; hidden, and `:sql` explains why, when
  the server lacks the extension (cc78396, efc202a). The completion popups of the SQL Runner and the `:` line take the width they need, in two
  columns, with wrapped descriptions (70b6fa1).
- **The mouse, everywhere** (on by default; F9 › Settings › Mouse, `:mouse on|off`, saved in `ui.mouse`;
  `--no-mouse` / `--mouse` for one run): a click selects or focuses, a double-click activates, a right
  click opens the actions at that row, the wheel scrolls the pane under the pointer, a drag on a grid
  column's edge resizes it and on its header moves it, the F-key bar and the footer's server are
  clickable, dialogs, menus, the SQL Runner and the date picker take clicks. With the mouse on, the
  terminal selects text with Shift+drag (cbabc31).
- **A live screen saver** (`:lock`, the idle timeout, `:saver [style]`): tiles refreshed every 10 to 30 s
  for people online, jobs, health, database sessions, ESB depth and dead letters, unread alerts, realtime
  events per minute, ping and favorite table counts, each hidden when its extension is absent and dimmed
  when stale; four styles (Bounce, Starfield, Flip clock, Big numbers, or auto) starring Query, the qrun.io
  mascot, whose block-letter logo says the connected profile's name (short name up to 6 characters) with
  the server host beneath; at most 4 frames a second; with a PIN set the prompt opens over the saver
  (c22ae75, 899326a). Each style is one compact group at most about 90 columns wide that moves as a unit
  (Big numbers: number, Query, caption and tiles as one centred stack; Flip clock: tiles and Query with the
  clock; Bounce: tiles beside the logo, stacked under it on a narrow terminal), with the clock line and the
  lock line just above and below it (aff2b00, 98d2076). Against burn-in every element moves (the header and
  lock line change place every 30 s, the flip clock drifts, Big numbers changes corners) and the screen dims
  after 10 minutes (`:saver burnin on|off`, `:saver dim <minutes|off>`) (899326a).
- **Clipboard copy of CLI equivalents**: the "CLI equivalent" dialog copies its command with `y`, `c` or
  Enter, the filter dialog has Ctrl+Y, and F9 › Settings › "Copy CLI commands to the clipboard
  automatically" (`ui.copyCliCommands`, default off) copies as soon as the dialog opens (e8f075a).
- **History screen** (`:history`, F9 › Work › History): the activity log of the profile, newest at the
  bottom; typing filters, Enter does an entry again (runs the `:` command, opens the record, the table with
  its filter, the process), `y` copies the CLI equivalent, `c` or F8 clears. The TUI records its `:`
  commands, opened apps, tables and records, queries with filters, record creates, edits and deletes (no
  values), process runs and outcomes, exports, prints, server switches, sign-in and sign-out. Ctrl+R on the
  `:` line is a bash-style reverse search over these commands (Ctrl+R again for older matches, Enter runs,
  Esc edits) (0bcc735).
- **Column statistics fallback**: `S` on a table without the server capability (or when the server
  answers 403 or 404) computes count, nulls, distinct, min, max, sum, mean, median, text lengths and top
  values from the rows the grid has loaded; the dialog says so and `a` loads up to 10,000 rows (e5d6c92).
- **Help and care**: F1 shows the application's help for the app, widget, table, process or step you are
  on, and the grid footer shows the column's help; searching ignores case (a term starting with `=`, or
  Match exact case, asks for exact case); themes per profile (high-contrast, classic, light); `qqq ui
  --check` (and a quick check at startup) finds tmux key and colour problems and offers fixes; `--ascii`,
  `--linear`; Ctrl+C or a crash always restores the terminal. A soak test drives the real UI in tmux with
  random keys.
- `packages/tui/scripts/smoke.sh --server URL [--profile NAME]` runs the tmux smoke test against any
  server in an isolated config (6950e9d, f149a47).
- **Assistant panel** (assistant extension): `Ctrl+G`, `:ask [question]` or F9 › Work › Assistant opens a
  chat pane on the right (the whole body below 110 columns): the question line at the bottom, the
  conversation above with each answer's numbers and links; Tab moves over the links and Enter opens the
  record or grid (beside the panel; a full-width panel closes so the screen shows). Questions carry the
  record or grid (with its filter) under the panel as context, as the Next UI sends it (Ctrl+D drops it);
  ↑↓ recall this profile's questions; Ctrl+L starts a new conversation, Ctrl+X stops an answer, Esc closes
  (the conversation is kept). Without the extension the entry is disabled and Ctrl+G says what is missing;
  when the assistant is off the panel shows the server's reason and what to configure (2c70c3c).

#### Kernel, client and conformance

- **`@qrun-io/qqq-core`** (new): everything that is not a terminal, shared by the CLI and the UI: output
  formats with JMESPath `--query`, the filter grammar, an operation index generated from the OpenAPI
  document, the form engine, the process runner, records and associations, the widget render model, the
  metadata cache, the extension registry, profiles and the keyring, `Printing` (printers, devices, jobs,
  print, cancel, watch; `printTableList`, `printText`), `formatDocument` for extension output, and the
  date parser and formatter.
- **`@qrun-io/qqq-ui-api-client`** is generated from UI API 1.8.0 merged with 14 extension documents (219
  operations, each tagged with its extension, including the 17 printing 2.0.0 operations, which are the generated `qqq
  printing ...` subcommands for print agents; printing 2.1's table-list and text printing are processes the kernel
  runs, reached as `qqq print list` and `qqq print text`, not as `qqq printing` subcommands), and gains PKCE, revocation and end-session helpers (5cf6243).
- **Conformance**: the suite checks `GET /qbit/printing/session` and the printing tables when a server
  lists printing (05f467c); `qqq-dev-idp` gains the authorization code with PKCE (Approve/Deny page),
  revocation and end-session.
- **Assistant** (`extensions/assistant.ts`): `Assistant.config()` (the feature probe, `installed: false`
  without the extension) and `Assistant.ask(question, { context, conversationId, onEvent, signal })`,
  which creates a conversation with the page context, reads the turn's server-sent events as they arrive
  (`SseParser`) and folds them into an answer (text, numbers, links, tools, usage); `parseAppHref` and
  `assistantContextFor` map app paths and pages both ways (a5e0cf4, e5327b2).

#### Packaging, CI and development

- **Distribution**: one single-file `qqq` binary per platform with the terminal UI bundled, for macOS arm64
  and x64, Linux x64 and arm64 (glibc and musl) and Windows x64 (`npm run binaries`, `--cli-only` without
  the UI); a curl installer that verifies `SHA256SUMS` and installs the newest stable `cli-v*` release
  (`--pre` or `QQQ_PRE=1` takes prereleases, `--dry-run` prints the download, `--help` works piped from
  curl) (a14cd5c); a Homebrew tap and a Scoop manifest that pass their CI and lint (5563f2f); `npm run
  release` with the readiness gate, `scripts/verify-binary.sh`/`.ps1` and `docs/release-runbook.md`.
- CI turns on the macOS arm64 and Windows x64 lanes of qqq-orb 0.8.33 (0d62416); the package tests run
  without shell globs for the Windows lane (5dd5e2d).
- **Enterprise test server**: `scripts/enterprise-server.sh` starts a local enterprise QQQ server with a
  MinIO container for object storage (6018cdf), and `scripts/enterprise-smoke.sh` sweeps the CLI over its
  qbits (cf0e610); `scripts/print-agent.sh` runs qqq-print-agent's virtual file printer against a local
  server (fc47cb8). The enterprise profile gives the assistant a model provider: Claude when `ANTHROPIC_API_KEY` is
  set in the private env file `~/.local/state/qqq-enterprise/assistant.env` (yours, not a symlink, mode 0600; read
  by name, never sourced or printed, exported only into the server's environment), else a local Ollama; `--status`
  and `--assistant-status` show which model answers or why none does (29f3559).
- **Documentation**: npm READMEs for every package, a rewritten repository README, `docs/README.md`,
  CONTRIBUTING, SECURITY and CODE_OF_CONDUCT, issue and pull request templates, CODEOWNERS and Dependabot
  (e46bc6b, 1b0d547, ac86860, 7fed559); TRY-IT as the 1.0.0 walkthrough (cddbea7).

### Changed

- **Default export names carry the local date and time**: `person_2026-11-01_102316.csv`, not `person.csv`,
  for `table export`, `widget --csv`, report downloads, field saves from a record, and every TUI export, save
  dialog and screen-text capture (`<name>_<YYYY-MM-DD>_<HHmmss>.<ext>`, 24-hour, no colons). A name you give
  (`-o`, a name typed in the file dialog) is used exactly as given, and a name the server chooses is kept
  unless it is taken, when the stamp goes before the extension (c201f92).
- **One meaning for `-o` across the CLI: `-o`/`--out` is always the output file; the sort is `--order`**
  (no short form). `table export -o people.csv` used to sort by a field named `people.csv` (the server
  answered 403); it now writes the file. Migration: write `--order` wherever `-o` meant the sort. On the
  commands that write no file (`table query`, `saved-view save`, `saved-report preview` and `set`), `-o`
  still sorts until 1.1, with a deprecation note on stderr; a sort field that looks like a file path
  (`out.csv`, `./x`) is warned about; completion offers fields after `--order` only (0687083).
- Changed from 0.1: sign-ins move from `~/.config/qqq-cli/credentials.json` to named profiles
  (`~/.config/qqq/config.json`) with secrets in the OS keyring; 0.1 sign-ins are imported once, and the old
  file is renamed only after the keyring took every entry. The global `--server` and `--version` have no
  short form any more (`-s` and `-V` collided with `--set` and `--view`).
- `qqq login --server URL` against an existing profile now asks first (see Fixed). `qqq doctor` words its
  UI API support from the same range as `--version` (1fd06db).
- The UI's search and help are separate: F2 is Search, `/` finds anything, F1/`?` is only the keyboard
  reference, and F9 no longer lists every app, recent record and metadata match (70c064e, ef2b554).
- The UI's F9 menu, filter dialog, developer view, date entry and record view were redesigned (see Added
  and Fixed); Ctrl+P no longer steps to the previous record (PgUp and `[` still do; Ctrl+N still steps to
  the next) because it prints (555c434).
- The conformance suite authenticates every authenticated check the same way, as the CLI does: a JWT as a
  bearer token, a session UUID also as the `sessionUUID` cookie, and on MOCK and FULLY_ANONYMOUS servers
  without a token a server session from `manageSession`; its metaData check names the authentication used
  (e7108ad).
- `fast-uri` 3.1.9 (transitive, through ajv in the conformance package) for four URI parsing advisories
  (0845036).

### Fixed

- Links with a base64 `filter` parameter (the form the web UI and the assistant write) opened the whole table:
  the UI's link reader and the kernel's `parseAppHref` now decode it, JSON still works, and a filter without
  criteria counts as an empty one (e5327b2).
- Output piped into a reader that exits early (`qqq table query person | head -1`, exports, process logs,
  `assistant ask`) ends quietly with status 0 instead of an unhandled `write EPIPE` stack trace (7c66b16).
- `qqq login --server URL` with `QQQ_PROFILE` (or `--profile`) naming an existing profile of another
  server silently pointed that profile at the new server. It now warns and needs `--yes` (or a yes at the
  question on a terminal); `--profile <new-name>` adds a profile instead. A token refresh under a one-off
  `--server` no longer moves the profile either (a10c834).
- `qqq esb messages <topic>` without `--trigger` names the topic's triggers in the error, and `--trigger`
  takes the process name too; before, the server's "name one of the triggers" did not say which and a
  process name answered 404 (248f30f).
- `qqq health get-summary` on a server that serves `/health` without advertising the health extension shows
  that endpoint's checks in the summary shape, with a note, instead of "not installed" (248f30f).
- The UI's record view keeps its layout when paging record to record: each child list is a box of fixed
  height (5 data rows by default, padded when shorter, scrolled inside with "rows 1-5 of 12" when longer),
  empty lists still draw their box, fields and columns are placed from the metadata, and the row count is a
  per-table view setting (`v`, `childRows`) with a default in `ui.childRows`. The `v` dialog is a settings
  form like the grid's View settings: Columns cycles auto, 1, 2; Label width (8-60) and Child list rows (1-50) take typed
  digits or +/- and Backspace returns them to auto or the profile default; one Collaboration panel row cycles auto, on,
  off; `r` resets with a confirm; `*` marks values changed from the default An association a section's
  `childRecordList` widget lists shows once, in the widget's place and under its label (0f7f536).
- The UI's filter dialog reads escaped quotes like core's grammar (213c605); before the redesign a
  true/false quick filter could be set to true but not changed from the quick row (067d97c).
- The UI's jobs widgets showed each statistic's web address; the alerts setup widget ran its columns
  together; HTML entities such as `&middot;` were not decoded; the ESB app showed "(ESB_OVERVIEW: no
  terminal rendering yet)" (19cc3ec).
- No text in the UI runs outside its container. Lines are cut to the cells they have, measured in terminal
  cells (wide characters count double), with `…` at the cut; dialogs are held inside the screen and their
  lines default to the dialog's inner width. View settings shows only the value in each row (Pinned columns
  `0`, not the explanation) and explains the selected row on a help line; its key help breaks between keys
  in at most three lines, dropping the least important first; `+`/`-` change Pinned columns as the help
  said. Screen footers, the record view's, F9's, the Servers dialog's, the SQL Runner's, the date picker's
  and message dialogs' included, drop whole keys instead of cutting one in the middle. Process errors wrap
  to the pane, the home screen's header lines end in `…`, and a column width saved wider than the terminal
  is held to the grid. `V` shows the whole value of the grid cell, or of the record view field row, under
  the cursor. `packages/tui/scripts/overflow-sweep.sh` checks every screen and dialog at 80/100/120/200
  columns by 24/50 rows, and `smoke.sh` checks its captures the same way (4abfd8d, c94499c, 0e4716a,
  da76a35, c2a9e98, 3bc2179).
- App cards showed the app's Material icon name instead of a glyph (0691e6f).
- Quitting the UI after the terminal was gone printed "setRawMode failed with errno: 2" and a native
  shutdown error (e13e7bf).
- A record found by the UI's search opened with an empty key (the server's field is `recordId`) and was
  listed last (70c064e).
- Process help markup is stripped with the core `stripTags` (c5b4b47).
- The developer view drew the ESB sample event as broken fragments (minified JSON went through the prose
  word-wrap); code blocks are pretty-printed and drawn one source line per screen line.
- `npm test` runs on Node 20; a question closed with Ctrl-D no longer hangs on Node 22.12; presence tests
  wait on state and have deadlines (16be5c2); the PIN storage test no longer flakes (7d754bf); the metadata index test guards by scaling and the dashboard
  widget test asserts concurrency, not wall-clock bounds (e3822d2, 508ddc0).
- The UI's grid draws adorned cells like the record view (REVEAL values stay masked, HTML as text, chips in
  brackets); the create form asks for a text primary key and leaves out generated numeric keys.
- The hardening review (`docs/review-2026-10-31.md`): option collisions, `table update` on contingent
  fields, corrupt config and secrets files no longer overwritten, awaited 0.1 imports, Ctrl-C and Ctrl-D at
  prompts, REVEAL values masked in query cells, one DATE_TIME, help and download path, checked numeric
  options and file arguments.
- `smoke.sh` skips the sample-only record steps against another server (f149a47).

### Security

- Links in the UI's widgets and server HTML are content: Enter opens a table (with a filter that has the
  shape of a query filter), a record (a plain key), a process or an app only when the metadata knows it, and
  shows the address of anything else without opening a browser. Text starting with `:` in a server link is
  shown, never run. Only links the TUI builds itself (ESB destination rows, keyed so server JSON cannot
  forge them) run commands; the command is shown first, server names are quoted, and a command that changes
  data asks first (c35def5).
- `scripts/enterprise-server.sh` keeps its MinIO credentials, pid file, log and data in a private state
  directory (`${XDG_STATE_HOME:-~/.local/state}/qqq-enterprise`, mode 0700), uses an existing file only if
  you own it, it is not a symlink and the credentials are 0600, checks that a pid file holds a number before
  signalling it, and parses the credentials file for its two keys instead of sourcing it (3fa81bf).
- Fixes for the 21 CodeQL alerts raised on the release pull request:
  - `qqq table edit` and `qqq developer` no longer build the editor's shell command from the file name; a
    primary key holding shell syntax (such as `$(...)`) ran as a command when `$EDITOR` opened. The path is
    passed to the shell as `$1` (POSIX) or as a quoted variable (Windows) (4d13ba9).
  - `qqq-dev-idp` end-session redirects only to a loopback `post_logout_redirect_uri`, rebuilt from its
    parts, and answers 400 for any other (9609acf).
  - Filter values escape backslashes as well as double quotes when printed or completed, and the parser
    and tokenizers read `\\` and `\"` back (e1694d4).
  - HTML help and widget text becomes terminal text in one linear pass; entities are decoded once, so
    `&amp;lt;` shows as `&lt;` (e1694d4).
  - Regular expressions that took quadratic time on long input are replaced with linear scans: slash
    trimming in API paths, BLOB sizes, `${name}` interpolation and `${input.x}` dependencies, filter error
    positions, `tmux list-keys` parsing (e1694d4), the search screen's status-line clock time and the date
    parser's split of a date from its time (9535e3a).
  - The release helper escapes every sed metacharacter in the version it puts into its notes command
    (d749f14).

### Known limitations

- Jobs need a durable-jobs server. Auth0 sign-in (CLI and UI) is built but has not met a real Auth0
  tenant (finding 28, qqq-cli#10). See `docs/server-findings.md` for the server-side issues the clients
  work around, including case-insensitive text filters (finding 27).
- The binaries are not Developer ID signed or notarized (macOS: Gatekeeper prompt for browser downloads,
  `xattr -d com.apple.quarantine` clears it) nor Authenticode signed (Windows: SmartScreen warning). The
  Windows and macOS x64 binaries are cross-compiled and were not run before this release.
- The npm package is the CLI only; `qqq ui` comes with the binaries.
- Printing needs the printing extension (qbit-printing 2.x) and Search the quick search extension;
  without them the UI offers no Print action and F2 searches names and the current table.
- Parity with the web UI (`docs/parity/feature-matrix.md`): the CLI has no open row (290 pass, 107 n/a, 4
  blocked on cited server findings) and the UI has none open (331 pass, 67 n/a, 3 blocked, SEC-030 on
  qqq-cli#10 and qqq#1359 among them). `npm run release -- --check` reports READY.

## [0.1.0]

The first CLI: device-code sign-in, apps, tables, filtered queries, records, processes, jobs and a live
event stream, on the generated UI API client.
