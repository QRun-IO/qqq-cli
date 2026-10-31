# Changelog

All notable changes to the qqq CLI and its packages. Versions follow [semver](https://semver.org);
`@qrun-io/qqq-ui-api-client` follows the UI API version of the document it is generated from.

## [1.0.0-rc.1] - 2026-10-31

First release candidate of `qqq` 1.0 (M1: the kernel and the CLI). Packages: `@qrun-io/qqq-cli`
1.0.0-rc.1, `@qrun-io/qqq-core` 1.0.0-rc.1 (new), `@qrun-io/qqq-ui-api-client` 1.8.0-rc.2,
`@qrun-io/qqq-ui-api-conformance` 1.6.0-rc.2. Servers: UI API 1.6.0 up to 2.0.

### Changed from 0.1

- The grammar is `qqq <noun> <verb>` (`table query`, `process run`, ...). The 0.1 flat commands (`apps`,
  `tables`, `query`, `get`, `run`, `jobs`, `tail`) still work as aliases.
- Sign-ins move from `~/.config/qqq-cli/credentials.json` to named profiles (`~/.config/qqq/config.json`)
  with secrets in the OS keyring. 0.1 sign-ins are imported once, and the old file is renamed only after
  the keyring took every entry.
- The global `--server` and `--version` have no short form any more (`-s` and `-V` collided with `--set`
  and `--view`).

### Added

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
- **Distribution**: single-file binaries for macOS arm64 and x64, Linux x64 and arm64 (glibc and musl)
  and Windows x64 (`npm run binaries`); a curl installer that verifies `SHA256SUMS`; Homebrew and Scoop
  drafts; `npm run release`.

### Client and conformance

- `@qrun-io/qqq-ui-api-client` is generated from UI API 1.8.0 merged with 13 extension documents (202
  operations, each tagged with its extension), and gains PKCE, revocation and end-session helpers.
- `qqq-dev-idp` gains the authorization code with PKCE (Approve/Deny page), revocation and end-session.

### Fixed

- `npm test` runs on Node 20 (the test glob is expanded by the shell; `node --test` only expands globs
  from Node 21).
- The hardening review (`docs/review-2026-10-31.md`): option collisions, `table update` on contingent
  fields, corrupt config and secrets files no longer overwritten, awaited 0.1 imports, Ctrl-C and Ctrl-D at
  prompts, REVEAL values masked in query cells, one DATE_TIME, help and download path, checked numeric
  options and file arguments.

### Known limitations

- Bulk load is not in the CLI yet; jobs need a durable-jobs server; TABLE_BASED sign-in is refused (no
  documented native recipe). See `docs/server-findings.md`.
- The binaries are not Developer ID signed or notarized (macOS) nor Authenticode signed (Windows). The
  Windows and macOS x64 binaries are cross-compiled and were not run before this candidate.
- The TUI (`qqq ui`) is not part of this release; the binaries say so when asked.

## [0.1.0]

The first CLI: device-code sign-in, apps, tables, filtered queries, records, processes, jobs and a live
event stream, on the generated UI API client.
