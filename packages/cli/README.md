# @qrun-io/qqq-cli

`qqq`, the command-line client for [QQQ](https://github.com/QRun-IO/qqq) applications. It talks to a QQQ
server only through the UI API (`/qqq/v1`), the same API the web UI uses, so every app, table, field,
process and extension comes from the server's metadata: one CLI for any QQQ application.

This npm package is **the CLI only**. The full-screen terminal UI (`qqq ui`) ships in the single-file
`qqq` binaries (curl installer, Homebrew, Scoop or the
[GitHub releases](https://github.com/QRun-IO/qqq-cli/releases)); run from this package, `qqq ui` says
where to get it.

## Install

The package is published to GitHub Packages, which needs a GitHub token with `read:packages` even for
public packages:

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm login --registry=https://npm.pkg.github.com      # once, with that token
npm install -g @qrun-io/qqq-cli
qqq --version
```

Requires Node.js 20 or later. Without Node, use a binary:
`curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh`,
`brew install qrun-io/tap/qqq`, or `scoop bucket add qrun https://github.com/QRun-IO/scoop-bucket; scoop install qqq`.

## Quick start

Against the QQQ sample server on `http://localhost:8077` (MOCK authentication):

```console
$ qqq login --server http://localhost:8077 --profile sample
Signed in to http://localhost:8077 (mock authentication) as profile "sample"; sign-in kept in the macos-keychain.

$ qqq table query person -w "id <= 3" --fields id,firstName,lastName
Id  First Name  Last Name
--  ----------  ---------
1   Avery       Sample
2   Blair       Sample
3   Casey       Sample
(3 records; filter: id LESS_THAN_OR_EQUALS 3)
```

```sh
qqq whoami                                           # the user, server, UI API version and extensions
qqq home                                             # what you may open, with the command for each
qqq table get person 1                               # one record, by section
qqq table query person -g "(firstName = Avery OR firstName = Blair) AND birthDate > now(-40y)"
qqq table create pet --set name=Pixel --set personId=2 --set speciesId=Dog
qqq table export person -w "id <= 5" --order -id --fields id,firstName,email -o people.xlsx
qqq table export person    # no -o: person_2026-11-01_102316.csv in the download directory (local time)
qqq alerts get-inbox --columns id,severity,title    # extension lists print as sub-tables
qqq process run greetInteractive -r 1,2 -v greetingPrefix=Hi
qqq api getTableMetaData --path tableName=person -Q 'fields.*.label'
qqq doctor                                           # connection, sign-in and terminal checks
```

## Commands

`qqq <noun> <verb> [arguments] [options]`; `qqq <noun> --help` lists the verbs and `qqq <noun> <verb> --help`
the options.

| Noun | Verbs |
|---|---|
| `table` | `list`, `describe`, `query`, `count`, `stats`, `get`, `create`, `copy`, `update`, `delete`, `export`, `children`, `download`, `variants`, `columns`, `actions`, `bulk-insert`, `bulk-edit`, `bulk-delete`, `apis`, `api-doc`, `api-call`, `developer`, `widget-form` |
| `process` | `list`, `describe`, `run` (every step screen, async jobs with progress, Ctrl-C cancels on the server) |
| `home`, `find`, `apps`, `search`, `tail`, `whoami` | landing page, command palette, app homes, global search, live event stream, current user |
| `report`, `saved-report`, `saved-view`, `share`, `bulk-profile`, `audit`, `widget`, `script`, `job`, `prefs`, `help-search` | reports, saved reports, saved views, sharing, bulk-load mappings, audits, widgets as text, scripts, jobs, preferences, help |
| `api <operationId>` | any UI API operation by id |
| `extensions`, `esb`, `collab`, `health`, `alerts`, ... | one noun per extension, run when the server has it installed |
| `print`, `printer` | print records, table lists and text through the printing extension, follow print jobs; printers and print agents |
| `login`, `logout`, `profile`, `config`, `cache`, `completion`, `doctor` | sign-in, saved server profiles (`profile list|add|edit|use|remove`), settings, the metadata cache, shell completion (bash, zsh, fish, PowerShell), checks |

Global options, anywhere on the line: `--server <url>`, `-p, --profile <name>`, `-O, --output
json|table|text|csv|yaml`, `--json`, `-Q, --query <jmespath>`, `--fields <names>`, `-y, --yes`, `--utc`,
`--trace`. Output is a table on a terminal and JSON in a pipe; extension results print their scalars as
key/value rows and each list as a sub-table fitted to the terminal (`--columns` chooses, `--json` shows
everything). `table stats` computes from the matching records (up to `--max-records`, 10,000) when the server offers no column statistics (`--no-local` makes that an error); a pipe whose reader exits early (`| head -1`) ends the command quietly with status 0.

Flag convention: `-o, --out <file>` is the output file on every command that writes one; the sort is
`--order <field...>` (prefix `-` for descending; no short form). Until 1.1, `-o` still sorts on `table query`,
`saved-view save` and `saved-report preview/set`, with a deprecation note.

Exit codes: 0 ok, 1 error, 2 usage or bad filter, 3 auth, 4 server unreachable or rate limited,
5 not found, 6 validation, 70 server error, 130 interrupted.

## Sign-in

| Server authentication | What `qqq login` does |
|---|---|
| OAUTH2, AUTH_0 | OAuth2 device-authorization grant (RFC 8628); `--browser` uses the authorization code with PKCE on a loopback redirect. Tokens are refreshed before they expire; `qqq logout --provider-logout` revokes them at the provider. |
| TABLE_BASED | `--username <user>`; the password is asked for, or read from `QQQ_PASSWORD`. |
| MOCK, FULLY_ANONYMOUS | a server session from `POST /qqq/v1/manageSession`. |

Sign-ins are stored per profile in the OS keyring (macOS Keychain, Secret Service on Linux, DPAPI on
Windows), or in a 0600 file with `QQQ_KEYRING=file`. `QQQ_TOKEN` overrides the stored sign-in with a
bearer token, for scripts and CI.

## Configuration and environment

| Variable | Effect |
|---|---|
| `QQQ_SERVER`, `QQQ_PROFILE` | the server or profile when `--server` / `--profile` are not given |
| `QQQ_TOKEN` | a bearer token instead of the stored sign-in |
| `QQQ_PASSWORD` | the TABLE_BASED password, instead of a prompt |
| `QQQ_OUTPUT` | the default output format |
| `QQQ_KEYRING=file` | keep sign-ins in a 0600 file instead of the OS keyring |
| `QQQ_CONFIG_DIR`, `QQQ_STATE_DIR`, `QQQ_CACHE_DIR` | profiles and settings (`~/.config/qqq`), histories (`~/.local/state/qqq`), metadata cache (`~/.cache/qqq`) |
| `QQQ_EXTENSION_CHECK=off` | skip the installed-extension check (for a mock server) |

## Use it as a library

The package also exports the program, so a tool can run CLI command lines in-process (the terminal UI's
`:` line does this):

```js
import { runCli } from '@qrun-io/qqq-cli/program'

let out = ''
const code = await runCli(['table', 'count', 'person', '-w', 'id <= 3', '-O', 'json'], {
  stdout: (text) => { out += text },
  stderr: (text) => process.stderr.write(text),
})
console.log(code, JSON.parse(out))   // 0 { count: 3 }
```

`runCli` uses the same profiles and sign-ins as `qqq`; prompts are off, so pass every value or `--yes`.
`createProgram()` returns the commander program itself. For building a client of your own, use
[`@qrun-io/qqq-core`](https://github.com/QRun-IO/qqq-cli/tree/main/packages/core#readme) and
[`@qrun-io/qqq-ui-api-client`](https://github.com/QRun-IO/qqq-cli/tree/main/packages/ui-api-client#readme)
directly.

## Compatibility and versions

- Servers: UI API 1.6.0 up to, not including, 2.0 (QQQ 4.1.0-RC.15 or later). `qqq --version` prints the
  supported range and `qqq doctor` checks the server.
- The CLI follows semver. Its workspace dependencies (`@qrun-io/qqq-core`, `@qrun-io/qqq-ui-api-client`,
  `@qrun-io/qqq-ui-api-conformance`) are pinned exactly and released together with it.

## More

- [Repository README](https://github.com/QRun-IO/qqq-cli#readme): install paths, the terminal UI, all packages
- [TRY-IT.md](https://github.com/QRun-IO/qqq-cli/blob/main/TRY-IT.md): every command against the sample server
- [CHANGELOG](https://github.com/QRun-IO/qqq-cli/blob/main/CHANGELOG.md) and
  [issues](https://github.com/QRun-IO/qqq-cli/issues)

Apache-2.0
