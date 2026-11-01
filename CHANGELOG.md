# Changelog

All notable changes to the qqq CLI and its packages. Versions follow [semver](https://semver.org);
`@qrun-io/qqq-ui-api-client` follows the UI API version of the document it is generated from.

## [1.0.0-rc.1] - 2026-10-31

First release candidate of `qqq` 1.0: the command-line client and the full-screen terminal UI
(`qqq ui`), shipped together as one binary per platform. Packages: `@qrun-io/qqq-cli` 1.0.0-rc.1,
`@qrun-io/qqq-core` 1.0.0-rc.1 (new), `@qrun-io/qqq-ui-api-client` 1.8.0-rc.2,
`@qrun-io/qqq-ui-api-conformance` 1.6.0-rc.2. Servers: UI API 1.6.0 up to 2.0. This entry becomes the
1.0.0 entry.

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
- The hardening review (`docs/review-2026-10-31.md`): option collisions, `table update` on contingent
  fields, corrupt config and secrets files no longer overwritten, awaited 0.1 imports, Ctrl-C and Ctrl-D at
  prompts, REVEAL values masked in query cells, one DATE_TIME, help and download path, checked numeric
  options and file arguments.

### Known limitations

- Bulk load is not in the CLI yet; jobs need a durable-jobs server; TABLE_BASED sign-in is refused (no
  documented native recipe). See `docs/server-findings.md`.
- The binaries are not Developer ID signed or notarized (macOS: Gatekeeper prompt for browser downloads,
  `xattr -d com.apple.quarantine` clears it) nor Authenticode signed (Windows: SmartScreen warning). The
  Windows and macOS x64 binaries are cross-compiled and were not run before this candidate.
- The npm package is the CLI only; `qqq ui` comes with the binaries.
- Parity with the web UI is not complete in either the CLI or the TUI (`docs/parity/feature-matrix.md`;
  `npm run release -- --check` lists what is open). 1.0.0 final waits for it.

## [0.1.0]

The first CLI: device-code sign-in, apps, tables, filtered queries, records, processes, jobs and a live
event stream, on the generated UI API client.
