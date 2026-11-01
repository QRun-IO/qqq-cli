# Changelog

All notable changes to the qqq CLI and its packages. Versions follow [semver](https://semver.org);
`@qrun-io/qqq-ui-api-client` follows the UI API version of the document it is generated from.

## [1.0.0] - YYYY-MM-DD

`qqq` 1.0: the command-line client and the full-screen terminal UI (`qqq ui`), shipped together as one
binary per platform. Packages: `@qrun-io/qqq-cli` 1.0.0, `@qrun-io/qqq-core` 1.0.0 (new),
`@qrun-io/qqq-ui-api-client` 1.8.0, `@qrun-io/qqq-ui-api-conformance` 1.6.0. Servers: UI API 1.6.0 up
to 2.0. Released as 1.0.0-rc.1 first (tags `v1.8.0-rc.2`, `cli-v1.0.0-rc.1`); this entry is that
candidate's, unchanged in content.

### Changed from 0.1

- The grammar is `qqq <noun> <verb>` (`table query`, `process run`, ...). The 0.1 flat commands (`apps`,
  `tables`, `query`, `get`, `run`, `jobs`, `tail`) still work as aliases.
- Sign-ins move from `~/.config/qqq-cli/credentials.json` to named profiles (`~/.config/qqq/config.json`)
  with secrets in the OS keyring. 0.1 sign-ins are imported once, and the old file is renamed only after
  the keyring took every entry.
- The global `--server` and `--version` have no short form any more (`-s` and `-V` collided with `--set`
  and `--view`).

### Added: the terminal UI (`qqq ui`)

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
- **Help**: F1 shows the application's help for the app, widget, table, process or step you are on, and
  the grid footer shows the column's help. Large tables stay quick: on a 10,000 x 40 table the first page
  draws in about 100 ms. A soak test (`packages/tui/scripts/soak.sh`) drives the real UI in tmux with
  random keys from the keymap and fails on any exit or error.
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
