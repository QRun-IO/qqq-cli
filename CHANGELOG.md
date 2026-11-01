# Changelog

All notable changes to the qqq CLI and its packages. Versions follow [semver](https://semver.org);
`@qrun-io/qqq-ui-api-client` follows the UI API version of the document it is generated from.

## [1.0.0] - 2026-11-01

`qqq` 1.0: the command-line client and the full-screen terminal UI (`qqq ui`), shipped together as one
binary per platform. Packages: `@qrun-io/qqq-cli` 1.0.0, `@qrun-io/qqq-core` 1.0.0 (new),
`@qrun-io/qqq-ui-api-client` 1.8.0, `@qrun-io/qqq-ui-api-conformance` 1.6.0. Servers: UI API 1.6.0 up
to 2.0. Released as 1.0.0-rc.1 first (tags `v1.8.0-rc.2`, `cli-v1.0.0-rc.1`); this entry is that
candidate's, plus the changes since it listed first.

### Added since 1.0.0-rc.1

- Printing (the printing extension, qbit-printing 2.x). The CLI: `qqq print <table> <id...>` renders each
  record as a record sheet through the table's Print process, queues one job per record and follows them
  until they have printed (`--printer`, `--copies`, `--no-wait`, `--timeout`; exit 1 when a job failed, 4
  when they are still running at the timeout); `qqq print job list|status [--watch]|cancel`; `qqq printer
  list|use|show|forget|devices` (printers with approval, exposure and formats; print agents with their
  health). The printer chosen is remembered per profile (`printing.printers` in config.json). The UI: `p`
  (Print…) on a record or a grid selection opens a printer picker (unprintable printers shown with the
  reason, the last used one preselected), the jobs are followed in the title bar and status line, and
  `:printjobs` lists recent jobs. The kernel: `Printing` (printers, devices, jobs, print, cancel, watch)
  and the remembered-printer helpers. Without the extension the commands exit 5 with the installed list
  and the UI offers no Print action. The client document carries the printing 2.0.0 operations
  (219 operations; `qqq printing ...` for the agent-side ones), and the conformance suite checks
  `GET /qbit/printing/session` and the printing tables when a server lists printing.
  `scripts/print-agent.sh` runs qqq-print-agent's virtual file printer against a local server.

### Changed since 1.0.0-rc.1

- **One meaning for `-o` across the CLI: `-o`/`--out` is always the output file; the sort is `--order`**
  (no short form). `table export -o people.csv` used to sort by a field named `people.csv` (the server
  answered 403); it now writes the file. Migration: write `--order` wherever `-o` meant the sort. On the
  commands that write no file (`table query`, `saved-view save`, `saved-report preview` and `set`), `-o`
  still sorts until 1.1, with a deprecation note on stderr; on `table export` it is the output file now. A
  sort field that looks like a file path (`out.csv`, `./x`) is warned about. Completion offers fields after
  `--order` only and no longer offers the hidden `-o`.
- Extension (QBit) results in table output: the generated commands (`qqq alerts get-inbox`,
  `qqq sql-workbench get-capabilities`, `qqq collab get-...`, and `qqq api`) print scalars as aligned
  key/value rows (nested objects as dotted keys) and each list of objects as a sub-table under its key,
  with columns from the union of the row keys in first-seen order, nested objects flattened one level
  (`owner.name`), lists in a cell joined, and the table fitted to the terminal width (cells cut with `…`,
  columns that do not fit named under the table). Before, lists were one line of JSON (`items [{"id":5,…`).
  The inbox, notebooks, SQL history, comments, tasks, favorites and recents get default columns, and
  `--columns a,b` (or the global `--fields`) chooses; the first-class `collab comments list`,
  `favorites list`, `recents`, `tags list` and `people` take `--columns` too. `--json`, `--output json`,
  yaml, csv and text are unchanged. The layout is the kernel's (`formatDocument` in `@qrun-io/qqq-core`).
- The UI's search and help are separate: `/` (F2, `.`, Ctrl+K, and `:search <text>`) is the one search
  over apps, tables, processes, widgets, reports, records (quick search, debounced as you type),
  commands and help, grouped under headers with the best match first; its placeholder says when quick
  search is there, the Records group reads "quick search: N matches" with the table and record label of
  each hit (the highlighted name when the label is only the key), and without record search it says once,
  dimmed, "records: install the quick search extension". F1/`?` is only the keyboard reference of the
  screen (keys grouped by what they do, the screen's help text and a pointer to `/`, F9 and `:`); F9 no
  longer lists every app, recent record and metadata match (they are found with `/`).
- The UI's F9 menu has two levels, like a menu bar: first the areas (Context, Go to, Work, Connection,
  Settings, Help) with a count and a one-line summary each (Connection names the server in use), then one
  area's entries with their keys. ↑↓ moves, Enter or → opens an area, its first letter jumps to it (`c`
  twice reaches Connection), ← or Esc goes back, Tab steps to the next area. Go to holds the apps and the
  recent records as groups (the first 5 and `more…`, which opens the whole list), and favorites. Typing two
  or more characters searches every menu entry, listed by area; clearing the search returns to the areas.
  It fits 80×24.
- The UI's filter dialog (F6) was reworked for clarity: every condition is a row of three cells (field,
  operator, value) edited the way its type asks (text and numbers in place, choices from a searchable
  list, Space cycles true/false, dates with presets or typed, operators from a list that fits the field),
  a row without a value shows `(any)` and is not applied, Backspace clears any cell, quick filter fields
  are the same rows, AND/OR and groups are drawn as structure, the help and key lines follow the focus,
  and the footer shows a live match count. Advanced mode adds a cheat sheet, a caret under parse errors
  that follows the scrolled text, and says why it cannot switch back to Guided. Commands moved to Ctrl and
  F keys so letters always type (Ctrl+N add, Ctrl+D remove, Ctrl+O AND/OR, Ctrl+G group, F2 mode, F10
  apply); Esc asks before discarding changes. Before, a true/false quick filter could be set to true but
  not changed from the quick row.
- The UI's developer view (`D` on a record or a grid) was redesigned: sections (Security, Events,
  Scripts, JSON, Metadata, Audits, APIs, then any further developer panel; ←→ or 1-9) over a scrollable
  pane with a scroll bar; tables in the grid's column layout with `—` for no value and a line saying why
  a column is empty; JSON pretty-printed and tinted, `v` opens the value viewer and `y` copies; web links
  become TUI actions (the table developer view, records, grids, processes) or show their URL as browser
  only; the record view adds field values, API endpoints, audits and script test runs, and the table view
  the ESB counters, the table metadata and its JSON; F3 goes to the record or the grid.
- The curl installer (`scripts/install.sh`) installs the newest **stable** `cli-v*` release, the channel
  Homebrew and Scoop follow; `--pre` (or `QQQ_PRE=1`) takes prereleases, `--dry-run` prints what it would
  download, and `--help` works when piped from curl.
- `fast-uri` 3.1.9 (transitive, through ajv in the conformance package) for four URI parsing advisories.
- Documentation: npm READMEs for every package (new for `@qrun-io/qqq-ui-api-conformance`), a rewritten
  repository README, `docs/README.md`, CONTRIBUTING, SECURITY and CODE_OF_CONDUCT, issue and pull request
  templates, CODEOWNERS and Dependabot.

### Fixed since 1.0.0-rc.1

- `qqq esb messages <topic>` without `--trigger` names the topic's triggers in the error, and `--trigger`
  takes the process name too (`--trigger syncOrder` reads `syncOrder.orderEvents`; a process with several
  triggers on the topic lists them; an unknown name lists the valid ones). Before, the server's "name one
  of the triggers" did not say which, and a process name answered 404.
- `qqq login --server URL` with `QQQ_PROFILE` (or `--profile`) naming an existing profile of another
  server silently pointed that profile at the new server. It now warns and needs `--yes` (or a yes at the
  question on a terminal); `--profile <new-name>` adds a profile instead. A token refresh under a one-off
  `--server` no longer moves the profile either.
- `qqq health get-summary` on a server that serves `/health` without advertising the health extension in
  GET /version (qqq-all) shows that endpoint's checks in the summary shape, with a note that the extension
  is unadvertised, instead of "not installed".
- The conformance suite authenticates every authenticated check the same way, as the CLI does: a JWT as a
  bearer token, a session UUID also as the `sessionUUID` cookie, and on MOCK and FULLY_ANONYMOUS servers
  without a token a server session from `manageSession`; `GET /jobs` and the realtime check used to differ
  (a token alone could report "no jobs permission" where a session worked). The metaData check's detail
  names the authentication used.
- The UI's jobs widgets showed each statistic's web address (`Running: 0 </jobs/jobs_job?filter=…>`):
  they show the label and count, and Enter opens the filtered grid in the TUI (links in widgets are read
  for their table, filter, record, process or app).
- The UI's alerts setup widget ran its columns together ("Channels Set up1 channel…"): row-shaped HTML is
  drawn in aligned columns with the last one wrapping under itself. HTML entities such as `&middot;` and
  numeric ones are decoded (the kernel knew only six).
- The UI's ESB app showed "(ESB_OVERVIEW: no terminal rendering yet)".
- Quitting the UI after the terminal was gone printed "setRawMode failed with errno: 2" and a native
  shutdown error with stack traces; those messages are dropped.
- A record found by the UI's search opened with an empty key (the server's field is `recordId`) and was
  listed last, below every metadata match.

### Added since 1.0.0-rc.1

- **Servers dialog** in the UI (Ctrl+O, `:servers`, F9 › Connection › Servers): every saved profile with
  its short name, server, status (UI API version, probed in the background with a 2.5 s timeout; `…`
  while probing), last use, who is signed in, the sign-in and its description. Enter switches (the stored
  sign-in is reused, else the sign-in runs) and Home opens on that server with fresh metadata; `n` adds,
  `e` edits, `d` removes (asks), `*` makes the default, `r` probes again, typing filters on name, short
  name, description and server. Adding or editing checks that the server answers `/qqq/v1/version`.
  Home shows the server and "Ctrl+O switch"; the footer shows the profile's short name.
- Profiles gain a **short name** (2 to 6 characters, for the footer and the Home header; by default the
  name itself up to 6 characters, else initials or its first 3), a **description**, a **sign-in mode**
  for OAuth2 servers (`auto` asks, `browser`, `device`), and the last use and user. All additive in
  `config.json`: files written by 1.0.0-rc.1 load unchanged and keep their `note` (shown when there is no
  description).
- `qqq profile list|add|edit|use|remove` (also under `qqq config profile`): `add` and `edit` take
  `--short`, `--description`, `--auth-mode` and `--check` (refuse unless the server answers); `edit`
  takes `--server` and `--rename`, and an empty value removes a field; `list --probe` adds each server's
  status. `use` sets the default, as `*` does in the dialog.
- The UI's record view has the collaboration extension's features: a line with the record's comments,
  attachments and open tasks and whether you follow it, the people viewing it now, and in `a`/F9 (keys
  `C` `P` `K` `T` `W`): comments (list, add, reply), follow and stop following, attachments (list,
  download through the file navigator, upload, delete), the timeline, tasks (list, add, done) and the
  share preview (who could read the record, then send). Without the extension F9 says "needs the
  collaboration extension".
- The UI draws the ESB overview widget as `:esb overview` does (destinations, publishers, triggers,
  counters); Enter on a destination offers the ESB of its table and processes, its messages and dead
  letters.
- Extension operations run on the UI's `:` line (`:alerts get-inbox`, `:api <operationId>`) and widget
  payloads without a terminal block show their JSON as key/value rows and sub-tables instead of one-line
  JSON; `J` shows the raw JSON.
- App cards show the app's Material icon as a glyph (bell, chart, database, people, settings, …), with an
  ASCII stand-in under the ASCII-glyphs setting; unknown icons are left out.
- `packages/tui/scripts/smoke.sh --server URL [--profile NAME]` runs the tmux smoke test against any
  server in an isolated config (it landed on the profile picker before).

### Changed from 0.1

- The grammar is `qqq <noun> <verb>` (`table query`, `process run`, ...). The 0.1 flat commands (`apps`,
  `tables`, `query`, `get`, `run`, `jobs`, `tail`) still work as aliases.
- Sign-ins move from `~/.config/qqq-cli/credentials.json` to named profiles (`~/.config/qqq/config.json`)
  with secrets in the OS keyring. 0.1 sign-ins are imported once, and the old file is renamed only after
  the keyring took every entry.
- The global `--server` and `--version` have no short form any more (`-s` and `-V` collided with `--set`
  and `--view`).

### Added: the terminal UI (`qqq ui`)

- **The "CLI equivalent" dialog can be copied**: `y`, `c` or Enter copies the command to the clipboard (Esc closes without copying), the filter dialog has Ctrl+Y for its command, Shift+drag still selects with the terminal, and F9 › Settings › "Copy CLI commands to the clipboard automatically" (`ui.copyCliCommands`, default off) copies as soon as the dialog opens.
- **A classic full-screen UI** in the same binary and on the same profiles and sign-ins as the CLI:
  function-key bar (F1 help to F10 quit, with Esc+digit for terminals that take the F-keys), PgUp/PgDn
  everywhere, Esc back with the screen below keeping its place, a `:` command line that speaks the CLI
  grammar (history, Ctrl+R, Tab completion), and a live footer (server, sign-in, UI API version, ping,
  realtime stream, jobs, clock). `qqq ui table query person -w …` opens a screen directly.
- **Home**: greeting and connection, counts, recently viewed records, quick actions (processes, new
  records, favorites), application cards, work (jobs, alerts, my work, release notes) and the instance's
  home widgets. F10 offers Quit, Reset (back to Home with fresh metadata) or Cancel.
- **F9, the command center**: every action of the current screen and the application, searchable, opened
  as a stack; F2 goes to any table, process or record; a metadata search index keeps both fast on large
  instances.
- **Tables**: a server-paged grid with columns sized to the screen, fixed rows that never vanish when a
  screen overflows, horizontal scroll, sort, view settings, the guided filter builder or the filter
  grammar with completion, quick search, column statistics, saved views, table variants, selection with a
  bulk bar, export and go-to by key.
- **Records**: sections by tier, links, child lists, next and previous through the list a record came
  from, create, edit and copy forms with an editor per field type, contingent pickers that narrow,
  local and server validation by field, DATE_TIME in the local zone, file uploads and BLOB downloads
  through a file navigator, audits (`A`), and tags (`t`) with the collaboration extension.
- **Processes**: the wizard draws every step as the web does (help, HTML, view values, records, the
  validation review, widgets, downloads), with back steps, record limits, progress with elapsed time and
  cancel.
- **Developer mode** (`D`): a record's associated scripts, revisions and logs; a table's APIs.
- **Bulk load and bulk changes**: a wizard for bulk insert and bulk edit from a file (upload through the
  file navigator, a column mapping grid with typed defaults and field help, value mapping, review with
  optional validation, result), bulk edit of switched-on fields, bulk delete, saved bulk-load profiles and
  the upload template.
- **Reports and saved reports**: run reports (process reports and streaming ones), and edit a saved
  report's filter, columns and pivot, including through an application API.
- **Sharing** (`Z`, `:share`): share records of shareable tables (saved reports, saved views) with users
  or groups.
- **Sign-in in the UI**: TABLE_BASED username and password, OAuth2 in the browser (authorization code with
  PKCE, the device flow as the alternative) and Auth0; sign-out ends the server or provider session; a
  session that expires mid-use opens sign-in on top and returns to the screen.
- **Widgets that act**: dropdowns and date pickers, parent widgets with children in a grid or tabs,
  process widgets, data bag versions, script revisions, export, ad hoc buttons and inputs, dynamicForm
  editing and composite widgets; disabled tables, processes and apps explain the denial, and
  capabilities gate new, edit, delete and copy.
- **Searching ignores case**: quick search, the palette and the guided filter's text conditions ask for
  case-insensitive matches; a term starting with `=` (or Match exact case in the condition menu) asks for
  exact case. As in the CLI, the server applies it once it reads the option (finding 27).
- **Themes per profile**: the theme picker keeps a theme for every profile or just this one.
- **Dates: type them or pick them**: one date control for DATE and DATE_TIME fields in create and edit
  forms, process forms, bulk edit and the filter dialog's value cell. Typed entry shows the value in the
  profile's display format with the format hint (and zone) beside it, and reads ISO, the display format,
  partial dates (`2026-3-5`, `3/5` in the current year), `t`/`today`, `n`/`now` and the filter grammar's
  `now(-7d)` and `startOf(month)`; a date that does not exist is refused with the reason
  (`February 2026 has 28 days`) and the field keeps the focus. F2 or Ctrl+Space opens a month calendar
  anchored to the field (arrows a day or a week, PgUp/PgDn a month, Shift a year, Home/End, `t` today) with
  a time row for DATE_TIME (hour, minute, seconds when the value has them, AM/PM on a 12-hour clock) and
  the local zone, the UTC instant sent and the server's declared zone. In the filter, Enter on a date
  value opens the calendar (from and to for between) and `p` the presets. `:dates order ymd|mdy|dmy clock
  24h|12h week monday|sunday weeknumbers on|off enter picker|next` sets the format per profile; slash
  dates are accepted only when the order says which part is the month. Values go out exactly as before:
  `YYYY-MM-DD`, and DATE_TIME as the UTC instant of the local time (bulk edit now converts too). The
  kernel's `parseDateInput`, `formatDateValue`, `monthGrid` and the date settings live in
  `forms/dates.ts`.
- **Help**: F1 shows the application's help for the app, widget, table, process or step you are on, and
  the grid footer shows the column's help. Large tables stay quick: on a 10,000 x 40 table the first page
  draws in about 100 ms. A soak test (`packages/tui/scripts/soak.sh`) drives the real UI in tmux with
  random keys from the keymap and fails on any exit or error.
- **SQL Runner** (with the sql-workbench extension): the Next UI Runner in the terminal, from the SQL
  Workbench app, `/`, F9 › Work and `:sql`. A SQL editor with syntax tint, F5 / Ctrl+Enter running the
  statement under the cursor, Tab completion of tables and columns from the schema endpoint, Ctrl+↑↓
  history; a server-paged, server-sorted result grid with typed column widths, whole values and export;
  errors inline with their SQL position; EXPLAIN as an indented plan tree (F6); a schema browser (F3);
  notebooks with SQL and markdown cells, run all, save, save as, duplicate, delete and publish (F2, F4);
  quick text bar charts; the audited run history with re-run (F7). Hidden, and `:sql` explains why, when
  the server lacks the extension. Read-only runs only.
- **Dashboards and widgets** in block characters: stats, bar charts, sparklines, percentage bars, tables
  and steppers.
- **Terminal care**: `qqq ui --check` (and a quick check at startup) finds tmux key and colour problems and
  offers fixes; mouse off by default (`--mouse`), `--ascii`, `--linear` and light, classic and
  high-contrast themes; Ctrl+C or a crash always restores the terminal.

### Added: the CLI and the kernel

- **Kernel package `@qrun-io/qqq-core`**: everything that is not a terminal, shared by the CLI and the
  coming TUI: output formats with JMESPath `--query`, the filter grammar (shorthand operators, quoting,
  AND/OR groups, expression values such as `now(-7d)`, `thisPeriod(month)`, `me()`), an operation index
  generated from the OpenAPI document, the form engine, the process runner, records and associations,
  the widget render model, the metadata cache, the extension registry, profiles and the keyring.
- **Sign-in**: session sign-in for MOCK and anonymous servers; OAuth2 device flow and browser sign-in
  with PKCE on a loopback redirect; refresh before expiry; `logout --provider-logout` revokes (RFC 7009)
  and opens the end-session page; refused refreshes exit 3. Profiles (`--profile`, `QQQ_PROFILE`,
  `config profile`) and the macOS Keychain, Linux Secret Service, Windows DPAPI or a 0600 file.
- **Tables**: `list`, `describe`, `query` (filters, sort, paging, `--search`, `--join` and `table.field`
  columns, `--count`, `--print-filter`, saved views with `--view`), `count`, `stats` (server columnStats
  or `--local`), `get` (sections, adornments, `--associations`, `--links`, `--follow`, `--key`), `create`,
  `copy`, `update`, `delete`, `children`, `export` (csv, tsv, xlsx, json), `download` and `--upload` for
  file fields, `variants` and `--variant` everywhere.
- **Forms**: contingent fields (country → state → city) with narrowing possible values, labels or unique
  partial labels for ids, local validation with the server's codes, form adjusters, interactive `-i`.
- **Processes**: `list`, `describe`, `run` with every step component (help, HTML as text, view pairs,
  process records, the validation review, summary lines, downloads, widgets), asynchronous jobs with
  progress, `--file` for BLOB fields, back steps, min/max input records, and Ctrl-C that cancels the
  run on the server (exit 130).
- **DATE_TIME** typed and shown in the local zone (`TZ`), sent as UTC instants; `--utc` for raw.
- **More nouns**: `apps show` (app homes with counts), `search`, `tail`, `saved-view`, `audit list`,
  `report`, `widget` (charts and tables as text), `job`, `prefs`, `help show`, `help-search`, and
  `api <operationId>` for any of the 202 operations.
- **Developer mode**: `table apis`, `table api-doc`, `table developer`, and `script list | show | store |
  logs` for associated scripts.
- **Tags**: `collab tags list | add | remove | create`, by id or label.
- **Home, find and dashboards**: `qqq home` (the landing page: counts, quick actions, recent records),
  `qqq find` (the command palette: an app, table, process or report by label), `apps show --widgets`, and
  `widget get --record` / `--run`, with widgets rendered as the web renders them (statistics, maps,
  pivots, forms, composite blocks, empty states).
- **Reports**: `report run` (through the report's process or the report route, with its input fields),
  and `saved-report list | show | preview | run | set | pivot | schedules | schedule` (filter, sort and
  columns, pivots, schedules).
- **Sharing**: `qqq share` for any record of a shareable table (saved reports, saved views).
- **TABLE_BASED sign-in**: `qqq login --username` (password asked, or `QQQ_PASSWORD`) keeps only the
  server session; a refused password stores nothing.
- **Record, query and process details**: `table columns` (the query columns per table, shared with the
  UI), `table api-call` (the API playground), `script test`, `table widget-form` (a dynamicForm on a record
  form), `table get --copy`, `table update -e` (edit HTML and code fields in `$EDITOR`), labels accepted
  for possible-value fields in `--where`, the chosen table variant remembered per server, and CHIP values
  in their colours.
- **Text filters ask for case-insensitive matching** (`CONTAINS`, `STARTS_WITH`, `ENDS_WITH` and the quick
  search); `~=`, `OPERATOR:CS` or `--case-sensitive` ask for a case-sensitive match. The server does not
  read the option over the UI API yet (finding 27), so matching stays case-sensitive until it does.
- **Disabled tables and processes** are listed with the reason, and queries, writes, copies, bulk commands
  and runs on them are refused before any request, as the web explains the denial.
- **Bulk load and bulk changes**: `table bulk-insert` from a CSV or Excel file (the upload template,
  the server's column suggestion, a mapping document, flags or `-i`, value mapping, the validation
  review, `--dry-run`), `table bulk-edit` of chosen records or by key rows from a file (only the fields
  you set change), `table bulk-delete` with review and confirmation, `table actions` (what you can do to
  a table, with the command for each), and `bulk-profile list | save | rename | delete` for saved
  mappings.
- **Extensions**: a noun per extension the client document knows (13: esb, collab, health, alerts,
  assistant, sql-workbench, ...), gated on the server's installed extensions and documented minimum
  versions; first-class verbs for `esb` and `collab` (presence, comments, favorites, follow, my work).
- **Shell completion** for bash, zsh, fish and PowerShell from the local metadata cache; `cache show |
  refresh | clear`.
- `qqq doctor`; `config set theme` and `download-dir`; downloads never overwrite a file or leave
  `--out-dir`; consistent exit codes (2 usage, 3 auth, 4 unreachable or 502/503/504, 5 not found,
  6 validation, 70 server error).
- `qqq --version` prints the build (`node` or the binary's target and commit) and the supported UI API
  range.
- **Distribution**: one single-file `qqq` binary per platform with the terminal UI (`qqq ui`) bundled,
  for macOS arm64 and x64, Linux x64 and arm64 (glibc and musl) and Windows x64 (`npm run binaries`,
  `--cli-only` without the UI); a curl installer that verifies `SHA256SUMS`; a ready-to-copy Homebrew tap
  and a Scoop manifest; `npm run release`, `scripts/verify-binary.sh`/`.ps1` and
  `docs/release-runbook.md`.
- `qqq doctor` and `qqq ui --check` start with a build line (version, binary with or without the UI,
  commit, runtime, platform); `qqq ui` in an installation without the UI says how to get it.

### Client and conformance

- `@qrun-io/qqq-ui-api-client` is generated from UI API 1.8.0 merged with 13 extension documents (202
  operations, each tagged with its extension), and gains PKCE, revocation and end-session helpers.
- `qqq-dev-idp` gains the authorization code with PKCE (Approve/Deny page), revocation and end-session.

### Fixed

- The UI's developer view drew the ESB sample event as broken fragments that looked duplicated (`…/table/pe`,
  `of:`, `Blair","lastName"…` twice): the event's minified JSON went through the prose word-wrap, which
  split it at the spaces inside its string values (`"Clone of: Blair"`, in both `record` and `oldRecord`)
  and cut every piece longer than the width. Code blocks are now pretty-printed and drawn one source line
  per screen line, cut with `…`, never wrapped as prose.
- `npm test` runs on Node 20 (the test glob is expanded by the shell; `node --test` only expands globs
  from Node 21).
- A question closed with Ctrl-D no longer hangs on Node 22.12 (readline left the question pending).
- In the UI's grid, adorned cells are drawn like the record view: REVEAL values stay masked, HTML shows
  as text and chips in brackets (they showed secrets and raw HTML before).
- The UI's create form asks for a text primary key (such as a file name) and leaves out generated
  numeric keys.
- The hardening review (`docs/review-2026-10-31.md`): option collisions, `table update` on contingent
  fields, corrupt config and secrets files no longer overwritten, awaited 0.1 imports, Ctrl-C and Ctrl-D at
  prompts, REVEAL values masked in query cells, one DATE_TIME, help and download path, checked numeric
  options and file arguments.
- The UI's record view keeps its layout when paging record to record (PgDn/PgUp): each child list is a
  box of fixed height (5 data rows by default, padded when shorter, scrolled inside the box with
  "rows 1-5 of 12" when longer), empty lists still draw their box, and field and child-list columns are
  placed from the metadata instead of the current record's values. The row count is a per-table view
  setting (`v`, saved as `childRows` under `ui.views.record:<table>`) with a default in `ui.childRows`
  (globally or per profile).
- The UI's record view showed an association twice when a section's `childRecordList` widget lists it
  (the sample's sales order "Lines" and "Tags"): it now shows once, in the widget section's place and under
  its label, with the widget's columns (Next's binding: `manageAssociationName`, or the association's
  `joinName`).

### Security

- Links in the UI's widgets and server HTML are content: Enter opens a table (with a filter that has
  the shape of a query filter), a record (a plain key), a process or an app only when the metadata knows
  it, and shows the address of anything else (another site included) without opening a browser. Text
  starting with `:` in a server link is shown, never run. Only links the TUI builds itself (ESB destination
  rows, keyed so that server JSON cannot forge them) run commands; the command is shown in the status line
  first, server names in it are quoted as single arguments, and a command that changes data asks first.

Fixes for the 19 CodeQL alerts raised on the release pull request:

- `qqq table edit` and `qqq developer` no longer build the editor's shell command from the file
  name. A primary key holding shell syntax (such as `$(...)`) ran as a command when `$EDITOR` opened.
  The path is now passed to the shell as `$1` (POSIX) or as a quoted variable (Windows), and the name
  keeps only letters, digits and `._-`.
- `qqq-dev-idp` end-session redirects only to a loopback `post_logout_redirect_uri`, rebuilt from its
  parts, and answers 400 for any other one. Before, it showed the signed-out page instead.
- Filter values escape backslashes as well as double quotes when printed or completed, and the
  parser and tokenizers read `\\` and `\"` back. A value ending in a backslash no longer swallows its
  closing quote.
- HTML help and widget text is turned into terminal text in one linear pass. Entities are decoded
  once, so `&amp;lt;` shows as `&lt;`, not `<`, and upload template names are decoded the same way.
- Regular expressions that took quadratic time on long server- or user-supplied input are replaced
  with linear scans: slash trimming in API paths, BLOB sizes, `${name}` interpolation and
  `${input.x}` dependencies, filter error positions, and `tmux list-keys` parsing.
- The release helper escapes every sed metacharacter in the version it puts into its notes command.

### Known limitations

- Jobs need a durable-jobs server. Auth0 sign-in (CLI and UI) is built but has not met a real Auth0
  tenant (finding 28). See `docs/server-findings.md` for the server-side issues the clients work around.
- The binaries are not Developer ID signed or notarized (macOS: Gatekeeper prompt for browser downloads,
  `xattr -d com.apple.quarantine` clears it) nor Authenticode signed (Windows: SmartScreen warning). The
  Windows and macOS x64 binaries are cross-compiled and were not run before this candidate.
- The npm package is the CLI only; `qqq ui` comes with the binaries.
- Parity with the web UI (`docs/parity/feature-matrix.md`): the CLI has no open row (290 pass, 107 n/a,
  4 blocked on cited server findings) and neither has the UI (SEC-030, Auth0 against a real tenant, is
  blocked on qqq-cli#10 and qqq#1359). `npm run release -- --check` reports READY.

## [0.1.0]

The first CLI: device-code sign-in, apps, tables, filtered queries, records, processes, jobs and a live
event stream, on the generated UI API client.
