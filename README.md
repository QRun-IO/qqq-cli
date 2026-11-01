# qqq

`qqq` is the command-line client and full-screen terminal UI for [QQQ](https://github.com/QRun-IO/qqq)
applications. It talks to a QQQ server only through the **UI API** (`/qqq/v1`), the same API the web UI
uses, so apps, tables, fields, processes, widgets and extensions all come from the server's metadata and
one binary works against any QQQ application.

This repository also holds the TypeScript libraries `qqq` is built on, for anyone writing their own CLI,
TUI or native client. Current release: **1.0.0** ([release notes](docs/release-notes/1.0.0.md),
[CHANGELOG](CHANGELOG.md)).

- [Install](#install)
- [The CLI in 60 seconds](#the-cli-in-60-seconds)
- [The terminal UI in 60 seconds](#the-terminal-ui-in-60-seconds)
- [Compatibility](#compatibility)
- [Packages](#packages)
- [Documentation](#documentation)
- [Development](#development)

## Install

Every install path below except npm ships the same single-file binary with the CLI and the terminal UI
(`qqq ui`); no Node or Bun is needed. Builds exist for macOS (arm64, x64), Linux (x64, arm64; glibc, and
musl for Alpine) and Windows (x64).

**macOS and Linux, curl installer** (to `~/.local/bin`; checks the download against the release's
`SHA256SUMS`). It installs the newest stable release, the same channel as Homebrew and Scoop;
`--version` pins one, `--pre` takes prereleases too, and `--dry-run` shows what it would download:

```sh
curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh -s -- --version 1.0.0 --dir /usr/local/bin
```

**Homebrew** (macOS and Linux, from [`QRun-IO/homebrew-tap`](https://github.com/QRun-IO/homebrew-tap);
installs bash, zsh and fish completions too):

```sh
brew install qrun-io/tap/qqq
```

**Scoop** (Windows, from [`QRun-IO/scoop-bucket`](https://github.com/QRun-IO/scoop-bucket)):

```powershell
scoop bucket add qrun https://github.com/QRun-IO/scoop-bucket
scoop install qqq
```

**Direct download**: pick `qqq-<os>-<arch>[-musl][.exe]` from the
[releases](https://github.com/QRun-IO/qqq-cli/releases) and check it against `SHA256SUMS`. On Alpine,
the musl build needs `apk add libstdc++ libgcc`.

**npm, CLI only** (GitHub Packages, Node.js 20 or later; no `qqq ui`, which says where to get it):

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli
```

GitHub Packages asks for a token even for public packages: `npm login --registry=https://npm.pkg.github.com`
with a GitHub token that has `read:packages`.

**macOS, downloaded with a browser:** the binaries are not notarized yet, so Gatekeeper stops a binary a
browser downloaded ("cannot be opened because Apple cannot check it for malicious software"). Clear the
download flag once with `xattr -d com.apple.quarantine ./qqq-darwin-arm64` (or right-click, Open, in
Finder). Homebrew and the curl installer do not set the flag and are not affected.
**Windows:** the `.exe` is not Authenticode-signed yet, so SmartScreen may warn on first run (More info,
Run anyway). Scoop installs are not affected.

Check the install with `qqq --version` (it names the UI API range and whether the binary has the UI) and
`qqq doctor`.

## The CLI in 60 seconds

The grammar is `qqq <noun> <verb> [arguments] [options]`, with global options anywhere. The examples run
against the QQQ sample server on `http://localhost:8077` (MOCK authentication, so no password); point
`--server` at your own server instead.

**Sign in.** OAuth2 and Auth0 servers use the device flow (or `--browser` for authorization code with
PKCE on a loopback redirect), TABLE_BASED servers ask for a username and password, MOCK and fully
anonymous servers get a server session. The first sign-in becomes the default profile.

```console
$ qqq login --server http://localhost:8077 --profile sample
Signed in to http://localhost:8077 (mock authentication) as profile "sample"; sign-in kept in the macos-keychain.
$ qqq whoami
key           value
------------  ------------------------------------------------------------
profile       sample (default)
server        http://localhost:8077
auth          mock session
apiVersion    1.8.0
extensions    esb 1.1.0
apps          6
...
```

**Query a table with a filter**, then **read one record**:

```console
$ qqq table query person -w "id <= 3" --fields id,firstName,lastName,email
Id  First Name  Last Name  Email
--  ----------  ---------  ---------------------
1   Avery       Sample     avery@example.invalid
2   Blair       Sample     blair@example.invalid
3   Casey       Sample     casey@example.invalid
(3 records; filter: id LESS_THAN_OR_EQUALS 3)

$ qqq table get person 1
Section          Field          Value
---------------  -------------  ---------------------
Identity         Id             1
Identity         First Name     Avery
Basic Info       Email          avery@example.invalid
Employment Info  Annual Salary  $75,003.50
...
associations: pets (--associations lists the child records)
```

**Run a process** (every step screen is supported; values come from `-v`, records from `-r`, and
anything missing is asked for):

```console
$ qqq process run greetInteractive -r 1,2 -v greetingPrefix=Hi
Greet Interactive: starting
No Of People Greeted:  2

Id  First Name  Greeting Message
--  ----------  ----------------
1   Avery       Hi Avery null
2   Blair       Hi Blair null
(2 records)
```

**Export** to CSV, XLSX, JSON or TSV:

```console
$ qqq table export person -w "id <= 5" --fields id,firstName,email --out people.csv
wrote people.csv (206 bytes, text/csv;charset=utf-8)
```

More of the grammar:

```sh
qqq table query person -g "(firstName = Avery OR firstName = Blair) AND birthDate > now(-40y)"
qqq table query person -w "lastName STARTS_WITH S" -o -id -l 5   # order by id descending, 5 rows
qqq table create pet --set name=Pixel --set personId=2 --set speciesId=Dog
qqq table bulk-insert person --file people.csv --dry-run          # map, validate and review; --yes loads
qqq home                                                          # what you may open, with the command for each
qqq find person                                                   # the command palette as a command
qqq api getTableMetaData --path tableName=person -Q 'fields.*.label'   # any of the 202 operations by id
eval "$(qqq completion zsh)"                                      # also bash, fish and PowerShell
```

| Noun | Verbs |
|---|---|
| `table` | `list`, `describe`, `query`, `count`, `stats`, `get`, `create`, `copy`, `update`, `delete`, `export`, `children`, `download`, `variants`, `columns`, `actions`, `bulk-insert`, `bulk-edit`, `bulk-delete`, `apis`, `api-doc`, `api-call`, `developer`, `widget-form` |
| `process` | `list`, `describe`, `run` (every step screen, async jobs with progress, Ctrl-C cancels on the server) |
| `home`, `find`, `apps`, `search`, `tail`, `whoami` | the landing page, the command palette, app homes (`--widgets`), global search, the live event stream, who you are |
| `report`, `saved-report`, `saved-view`, `share`, `bulk-profile`, `audit`, `widget`, `script`, `job`, `prefs`, `help-search` | reports and saved reports (pivots, schedules), saved views, sharing, saved bulk-load mappings, audit history, dashboard widgets as text, associated scripts, jobs, preferences, help |
| `api <operationId>` | any UI API operation by id: the escape hatch |
| `extensions`, and one noun per extension | `esb`, `collab`, `health`, `alerts`, `assistant`, `sql-workbench`, ..., offered when the server has the extension installed |
| `login`, `logout`, `config`, `cache`, `completion`, `doctor`, `ui` | sign-in, profiles and settings, the metadata cache, shell completion, the environment check, the terminal UI |

**Output** is a table on a terminal and JSON in a pipe; `-O json|table|text|csv|yaml` (or `QQQ_OUTPUT`)
chooses, and `-Q` reshapes it with JMESPath, as `aws --query` does. Values are the server's labels and
display values; DATE_TIME values are shown in your zone (`--utc` for raw instants). Text filters (`~`,
`STARTS_WITH`, `ENDS_WITH`, quick search) ask for case-insensitive matching; `--case-sensitive` asks for
an exact-case match.

**Profiles and sign-ins.** Profiles name servers, as `aws --profile` does: `qqq --profile prod ...`,
`QQQ_PROFILE`, `qqq config profile list|use|remove`. Sign-ins live in the OS keyring (macOS Keychain,
Secret Service on Linux, DPAPI on Windows) or a 0600 file with `QQQ_KEYRING=file` for headless hosts.
OAuth2 tokens are refreshed before they expire; `qqq logout --provider-logout` also revokes them at the
provider. `QQQ_TOKEN` overrides everything with a bearer token, and `QQQ_PASSWORD` answers a
TABLE_BASED password prompt.

**Exit codes:** 0 ok, 1 error, 2 usage or bad filter, 3 auth, 4 server unreachable or rate limited,
5 not found, 6 validation, 70 server error, 130 interrupted. Every request carries
`X-QQQ-Client: cli/qqq-cli <version>` for the server's audit trail.

[TRY-IT.md](TRY-IT.md) walks through every command against the sample server.

## The terminal UI in 60 seconds

`qqq ui` opens a classic full-screen terminal UI on the same profiles and sign-ins as the CLI:

```sh
qqq ui                                                    # the default profile; qqq --profile sample ui
qqq ui table query person -w "lastName STARTS_WITH S"     # open a screen directly, in the CLI grammar
qqq ui --check                                            # check the terminal and tmux setup, offer fixes
qqq ui --theme light                                      # high-contrast (default), classic or light
```

- **Home** is the landing screen: greeting and connection, counts, recently viewed records, quick actions,
  application cards, your work (jobs, alerts) and the instance's home widgets. F10, Reset comes back here.
- **The function-key bar** at the bottom is always right for the current screen: F1 Help, F2 Go to,
  F3 View, F4 Edit, F5 Refresh, F6 Filter, F7 New, F8 Delete, F9 Menu, F10 Quit. When the terminal takes
  the F-keys, Esc then a digit (or Ctrl+digit) stands for F1 to F10.
- **`/`** (or F2, Ctrl+K) is the go-to palette: any app, table, process, report or record, searched as you
  type, fast on instances with thousands of tables.
- **F9 is the command center**: every action of the current screen and of the application, searchable.
- **`:`** opens a command line that speaks the CLI grammar (`:table query person -w "id <= 3"`,
  `:theme classic`, `:quit`), with history (Up, Down, Ctrl+R) and Tab completion. Commands that are not
  screens run in-process and show their output.
- Esc goes back, and the screen below keeps its cursor, filter and page. PgUp and PgDn page everywhere;
  Ctrl+F and Ctrl+B always work.

Grids page on the server, sort, filter with a guided builder or the grammar, quick search, show column
statistics and export; records open with their sections, child lists and next/previous; forms handle
contingent fields, uploads and validation; processes run as a wizard with progress and cancel. Keys, screens
and settings: [`packages/tui/README.md`](packages/tui/README.md).

## Compatibility

| | Supported |
|---|---|
| QQQ servers | UI API 1.6.0 up to, not including, 2.0 (QQQ 4.1.0-RC.15 or later). `qqq --version` prints the range; `qqq doctor` checks the server's version. |
| Extensions | Extension commands run when the server reports the extension in `GET /qqq/v1/version`; when it is missing, or older than the client needs, they exit 5 and say which. `qqq extensions` lists both sides. |
| Binaries | macOS arm64 and x64; Linux x64 and arm64, glibc and musl; Windows x64 (`qqq ui` needs Windows Terminal or another ConPTY terminal). The Windows and Intel macOS builds are cross-compiled and not yet exercised in CI ([docs/ci-lanes.md](docs/ci-lanes.md)). |
| npm packages | Node.js 20 or later. `@qrun-io/qqq-ui-api-client` needs only `fetch` and Web Crypto (no Node built-ins), so it runs on Bun and Deno too; `@qrun-io/qqq-core` and the CLI use Node built-ins (files, keyring). |

Versioning: `qqq` and `@qrun-io/qqq-core` follow semver from 1.0.0. `@qrun-io/qqq-ui-api-client`
follows the UI API version of the document it is generated from (1.8.0 here), and
`@qrun-io/qqq-ui-api-conformance` has its own version. All four are released together; see
[CHANGELOG.md](CHANGELOG.md).

## Packages

| Package | Version | What it is |
|---|---|---|
| [`@qrun-io/qqq-cli`](packages/cli) | 1.0.0 | `qqq`, the CLI, and its program as a library (`runCli`) |
| [`@qrun-io/qqq-core`](packages/core) | 1.0.0 | the client kernel: sessions and keyring, metadata cache, filter grammar, forms, processes, records, render model, output formats. No terminal code |
| [`@qrun-io/qqq-ui-api-client`](packages/ui-api-client) | 1.8.0 | a typed TypeScript client generated from the merged UI API document (core plus 13 extensions), with OAuth2 device-flow and PKCE sign-in, token refresh and the realtime (SSE) stream |
| [`@qrun-io/qqq-ui-api-conformance`](packages/conformance) | 1.6.0 | a read-only conformance suite for any UI API server, and `qqq-dev-idp`, a local OIDC provider for testing native clients |
| [`packages/tui`](packages/tui) | in the binaries | `qqq ui`, the full-screen terminal UI (OpenTUI on Bun), bundled into every `qqq` binary; not an npm package |

All npm packages are published to GitHub Packages under `@qrun-io`.

A minimal client on the generated API, against the sample server:

```ts
import { createUiApiClient, createSession, unwrap } from '@qrun-io/qqq-ui-api-client'

const baseUrl = 'http://localhost:8077'
const { sessionUUID } = await createSession(baseUrl)          // MOCK; OAuth2 servers: deviceSignIn
const api = createUiApiClient({ baseUrl, sessionCookie: () => sessionUUID, clientChannel: 'tui/my-tui 1.0' })

const page = await unwrap(api.POST('/qqq/v1/table/{tableName}/query', {
  params: { path: { tableName: 'person' } },
  body: { filter: { criteria: [{ fieldName: 'id', operator: 'LESS_THAN_OR_EQUALS', values: [3] }], limit: 20 } },
}))
console.log(page.records?.map((r) => r.values.firstName))  // [ 'Avery', 'Blair', 'Casey' ]
```

`npm run mock` serves the merged document with [Prism](https://github.com/stoplightio/prism) on
http://127.0.0.1:4010, to build against without a server, and `qqq-ui-api-conformance --server <url>`
checks a server against the document.

## Documentation

| Document | What it covers |
|---|---|
| [TRY-IT.md](TRY-IT.md) | every CLI command and the TUI against the local sample server |
| [packages/cli/README.md](packages/cli/README.md) | the CLI package: install, configuration, environment, embedding `runCli` |
| [packages/tui/README.md](packages/tui/README.md) | `qqq ui`: keys, screens, the `:` line, settings, terminals that take keys |
| [packages/core/README.md](packages/core/README.md) | the client kernel's modules |
| [packages/ui-api-client/README.md](packages/ui-api-client/README.md) | the typed client: calls, sign-in, errors, realtime |
| [packages/conformance/README.md](packages/conformance/README.md) | the conformance suite and `qqq-dev-idp` |
| [docs/README.md](docs/README.md) | index of everything under `docs/` |
| [docs/extensions.md](docs/extensions.md) | the extension documents merged into the client |
| [docs/parity/feature-matrix.md](docs/parity/feature-matrix.md) | CLI and TUI status of every row of the web UI's acceptance matrix |
| [docs/server-findings.md](docs/server-findings.md) | UI API issues found while building the clients |
| [docs/release-runbook.md](docs/release-runbook.md) | how a release is cut, signed, published and packaged |
| [docs/packaging/README.md](docs/packaging/README.md) | the curl installer, Homebrew formula, Scoop manifest and platform notes |
| [docs/ci-lanes.md](docs/ci-lanes.md) | what CI runs: Linux verify and publish, macOS arm64 and Windows x64 lanes |
| [CHANGELOG.md](CHANGELOG.md) | every change by version |

The UI API itself is documented in QQQ:
[`UI-API-CLIENTS.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CLIENTS.md) and
[`UI-API-CHANGELOG.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CHANGELOG.md).

## Development

Node 20+ (CI uses 22) and npm workspaces for the four packages; Bun 1.4+ for the TUI and the binaries.

```sh
npm ci
npm run build && npm test && npm run lint
npm run test:tui                     # the TUI's tests (Bun)
node packages/cli/dist/main.js --help   # the CLI from the checkout; `... ui` runs the TUI from source with Bun
npm run generate                     # regenerate the client and the operations index from the document
npm run spec:merge-extensions        # remerge the extension documents (sample server running)
npm run binaries                     # dist/qqq-<os>-<arch>[.exe] with the UI, and SHA256SUMS; --host, --musl, --cli-only
npm run release                      # every release check, then the tag and publish commands (prints only)
scripts/verify-binary.sh dist/qqq-darwin-arm64 --server http://localhost:8077   # smoke a binary
```

The CLI runs on Node 20 and later and uses no Bun-only API; Bun is needed only for the TUI and the
binaries. CI is the qqq-orb `cli` profile (`.qqq-ci.yml`); a tag `v<client version>` publishes the
packages to GitHub Packages ([`docs/ci-lanes.md`](docs/ci-lanes.md) says what it does and does not cover).

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, checks, commit and pull request rules (signed commits on `main`).
- [SECURITY.md](SECURITY.md): report vulnerabilities privately, never in a public issue.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Bugs and feature requests: [issues](https://github.com/QRun-IO/qqq-cli/issues).

Licensed under the [Apache License 2.0](LICENSE). QQQ itself is a separate project with its own license.
