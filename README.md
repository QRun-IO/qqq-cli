# qqq-cli

`qqq` is the command-line client for [QQQ](https://github.com/QRun-IO/qqq) applications. It talks to a
QQQ server only through the **UI API** (`/qqq/v1`), the API the web UI uses too. Nothing about an
application is built in: apps, tables, fields, processes, widgets and extensions all come from the
server's metadata, so the same binary works against any QQQ application.

This is **1.0.0-rc.1**, the first release candidate. It works with servers that serve UI API 1.6.0 up to
2.0 (QQQ 4.1.0-RC.15 or later); `qqq --version` prints the range.

The repository also holds the libraries the CLI is built on, for anyone writing a CLI, TUI or native client:

| Package | Version | What it is |
|---|---|---|
| [`@qrun-io/qqq-cli`](packages/cli) | 1.0.0-rc.1 | `qqq`, the CLI |
| [`@qrun-io/qqq-core`](packages/core) | 1.0.0-rc.1 | the client kernel: sessions and keyring, metadata cache, filter grammar, forms, processes, records, render model, output formats. No terminal code |
| [`@qrun-io/qqq-ui-api-client`](packages/ui-api-client) | 1.8.0-rc.2 | a typed TypeScript client generated from the merged UI API document (core plus 13 extensions), with OAuth2 device-flow and PKCE sign-in, token refresh and the realtime (SSE) stream |
| [`@qrun-io/qqq-ui-api-conformance`](packages/conformance) | 1.6.0-rc.2 | a read-only conformance suite for any UI API server, and `qqq-dev-idp`, a local OIDC provider for testing native clients |
| [`packages/tui`](packages/tui) | in the binaries | `qqq ui`, the full-screen terminal UI (OpenTUI on Bun), bundled into every `qqq` binary; not an npm package |

## Install

A single-file binary with the CLI and the terminal UI (`qqq ui`), no Node or Bun needed, for macOS
(arm64, x64), Linux (x64, arm64; glibc, and musl for Alpine) or Windows (x64), from the
[releases](https://github.com/QRun-IO/qqq-cli/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh   # to ~/.local/bin
```

The installer picks the right build and checks it against the release's `SHA256SUMS`
(`--version 1.0.0-rc.1`, `--dir /usr/local/bin`). Homebrew (`brew install qrun-io/tap/qqq`) and Scoop
packages are prepared in [`docs/packaging`](docs/packaging/README.md) and land with the release.

**macOS, downloaded with a browser:** until the binaries are notarized, Gatekeeper stops a binary that a
browser downloaded ("cannot be opened because Apple cannot check it for malicious software"). Clear the
download flag once with `xattr -d com.apple.quarantine ./qqq-darwin-arm64` (or right-click, Open, in
Finder). Homebrew and the installer above are not affected. On Windows, SmartScreen may warn about the
unsigned `.exe` on first run (More info, Run anyway).

Or the CLI alone from npm (GitHub Packages), with Node.js 20 or later (no `qqq ui`; it says where to get it):

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli@rc
```

## First sign-in

```console
$ qqq login --server https://admin.example.com --profile prod
To sign in to https://admin.example.com, open:

  https://auth.example.com/device?code=ED84-CC03

and confirm the code ED84-CC03 (it expires in 10 minutes).
Signed in to https://admin.example.com as darin@example.com; sign-in kept in the macos-keychain.

$ qqq whoami
$ qqq table query person -w "lastName STARTS_WITH S" -o -id -l 5
```

- **OAuth2 and Auth0** servers use the device flow; `--browser` uses the authorization code with PKCE on
  a loopback redirect. Tokens are refreshed before they expire; `qqq logout --provider-logout` also
  revokes them at the provider. **MOCK** and fully anonymous servers get a server session.
- **Profiles** name servers, as `aws --profile`: `qqq --profile prod …`, `QQQ_PROFILE`, `qqq config profile
  list|use|remove`. The first sign-in becomes the default.
- **Sign-ins** live in the OS keyring: macOS Keychain, Secret Service on Linux, DPAPI on Windows, or a
  0600 file with `QQQ_KEYRING=file` (headless hosts). `QQQ_TOKEN` overrides everything with a bearer token.
- `qqq doctor` checks the connection, the sign-in and the terminal, and its first line names the build
  (version, binary with or without the UI, runtime, platform) for support.
- `qqq ui` opens the full-screen terminal UI on the same profile (`qqq ui table query person`, `qqq ui --check`).

## The grammar

`qqq <noun> <verb> [arguments] [options]`, with global options anywhere.

| Noun | Verbs |
|---|---|
| `table` | `list`, `describe`, `query`, `count`, `stats`, `get`, `create`, `copy`, `update`, `delete`, `export`, `children`, `download`, `variants`, `actions`, `bulk-insert`, `bulk-edit`, `bulk-delete` |
| `process` | `list`, `describe`, `run` (every step screen, async jobs with progress, Ctrl-C cancels on the server) |
| `apps`, `search`, `tail`, `whoami` | app homes, global search, the live event stream |
| `saved-view`, `bulk-profile`, `audit`, `report`, `widget`, `job`, `prefs`, `help-search` | saved views, saved bulk-load mappings, audit history, reports, dashboard widgets as text, jobs, preferences, help |
| `api <operationId>` | any of the 202 UI API operations by id: the escape hatch |
| `extensions`, and one noun per extension | `esb`, `collab`, `health`, `alerts`, `assistant`, `sql-workbench`, … gated on what the server has installed |
| `login`, `logout`, `config`, `cache`, `completion`, `doctor` | sign-in, profiles and settings, the metadata cache, shell completion (bash, zsh, fish, PowerShell) |

```sh
qqq table query person -g "(firstName = Avery OR firstName = Blair) AND birthDate > now(-40y)"
qqq table create pet --set name=Pixel --set personId=2 --set speciesId=Dog
qqq table export person -w "id <= 5" --fields id,firstName,email --out people.xlsx
qqq table bulk-insert person --file people.csv --dry-run          # map, validate and review; --yes loads
qqq process run greetInteractive -r 1,2,3 -v greetingPrefix=Hi
qqq api getTableMetaData --path tableName=person -Q 'fields.*.label'
eval "$(qqq completion zsh)"
```

Output is a table on a terminal and JSON in a pipe; `-O json|table|text|csv|yaml` (or `QQQ_OUTPUT`)
chooses, and `-Q` reshapes it with JMESPath. Values are labels and display values from the server;
DATE_TIME values are shown in your zone (`--utc` for raw). Exit codes: 0 ok, 1 error, 2 usage or bad
filter, 3 auth, 4 server unreachable or rate limited, 5 not found, 6 validation, 70 server error,
130 interrupted. Every request carries `X-QQQ-Client: cli/qqq-cli <version>` for the server's audits.

[TRY-IT.md](TRY-IT.md) walks through every command against the QQQ sample server.

## Documentation

- [TRY-IT.md](TRY-IT.md): the CLI (and the TUI as it is built) against the local sample server
- [`docs/parity/feature-matrix.md`](docs/parity/feature-matrix.md): CLI status of every row of the web UI's acceptance matrix
- [`docs/extensions.md`](docs/extensions.md): the extension documents merged into the client
- [`docs/server-findings.md`](docs/server-findings.md): UI API issues found while building the clients
- [`docs/review-2026-10-31.md`](docs/review-2026-10-31.md): the hardening review of the CLI and kernel
- [`docs/release-runbook.md`](docs/release-runbook.md), [`docs/packaging`](docs/packaging/README.md) and [`docs/ci-lanes.md`](docs/ci-lanes.md): releasing, install paths and CI
- [`packages/core/README.md`](packages/core/README.md): the kernel's modules
- QQQ's [`UI-API-CLIENTS.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CLIENTS.md) and
  [`UI-API-CHANGELOG.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CHANGELOG.md): the API itself
- [CHANGELOG.md](CHANGELOG.md)

## Writing a client

```ts
import { createUiApiClient, unwrap, getNativeSignInConfig, deviceSignIn } from '@qrun-io/qqq-ui-api-client'

const config = await getNativeSignInConfig('https://admin.example.com')
const tokens = await deviceSignIn(config, (p) => console.log(`Open ${p.verificationUriComplete}`))
const api = createUiApiClient({ baseUrl: 'https://admin.example.com', token: () => tokens.accessToken, clientChannel: 'tui/my-tui 1.0' })

const page = await unwrap(api.POST('/qqq/v1/table/{tableName}/query', {
  params: { path: { tableName: 'person' } },
  body: { filter: { criteria: [{ fieldName: 'lastName', operator: 'STARTS_WITH', values: ['K'] }], limit: 20 } },
}))
```

Paths, parameters, bodies and responses are typed from the document. `@qrun-io/qqq-core` adds the
pieces every client needs above that (filter grammar, forms with contingent fields, the process runner,
record view, output formats); see its README.

`npm run mock` serves the merged document with [Prism](https://github.com/stoplightio/prism) on
http://127.0.0.1:4010, to build against without a server. To check a server:

```sh
qqq-ui-api-conformance --server https://admin.example.com              # public checks only
qqq-ui-api-conformance --server https://admin.example.com --token "$T"  # all read-only checks
```

`qqq-dev-idp` is a local OIDC provider (device grant, PKCE, refresh, revocation, RS256 JWTs) for testing
OAuth2 sign-in against a local QQQ server; TRY-IT.md has the recipe.

## Development

```sh
npm ci
npm run build && npm test && npm run lint
npm run test:tui                     # the TUI's tests (Bun 1.4+)
npm run generate                     # regenerate the client and the operations index from the document
npm run spec:merge-extensions        # remerge the extension documents (sample server running)
npm run binaries                     # dist/qqq-<os>-<arch>[.exe] with the UI, and SHA256SUMS (Bun 1.4+); --host, --musl, --cli-only
npm run release                      # every release check, then the tag and publish commands (prints only)
scripts/verify-binary.sh dist/qqq-darwin-arm64 --server http://localhost:8077   # smoke a binary
```

The CLI runs on Node 20 and later and uses no Bun-only API; Bun is needed only to build the binaries
and for the TUI. CI is the qqq-orb `cli` profile (`.qqq-ci.yml`); a tag `v<client version>` publishes the
packages to GitHub Packages (see `docs/ci-lanes.md` for what it does and does not cover).

## License

Apache-2.0
