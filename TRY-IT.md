# Try the terminal clients as they are built

Updated with every milestone. Each entry says what exists today and the one command that runs it.

## Prerequisites (once)

- Java 21 and Maven (for the sample server), Bun 1.4+ (`brew install bun`), Node 20+ (existing CLI).
- A `qqq` checkout on `develop` at `../.worktrees/qqq-develop` (relative to this repo's parent), or set
  `QQQ_DEV_WORKTREE`. Then `qqq-sample-server build` once (about two minutes), and after every pull of qqq.
- Launchers: `scripts/dev/sample-server.sh` and `scripts/dev/tui-spike.sh` are linked as
  `~/.local/bin/qqq-sample-server` and `~/.local/bin/qqq-tui-spike`.

## Staying on the latest build

There is no install step. `qqq-tui-spike` runs the source checked out in this repo with Bun, so after
any commit the next launch is the latest; quit with F10 and start it again. The launcher prints the
branch and commit it is running (`spike/m0-opentui@6d68084`, with `+local` when there are uncommitted
changes) and the status line shows the same build id. I keep this checkout on the branch being built
and say when a new build is ready. After a reboot, `qqq-sample-server start` again; after pulling qqq
`develop`, `qqq-sample-server build` then `restart`.

## Sample server (UI API 1.8.0, mock auth, in-memory data)

```sh
qqq-sample-server start      # http://localhost:8077  (web UI at /, API at /qqq/v1)
qqq-sample-server status | log | restart | stop
```

Data resets on every restart. Mock auth means no sign-in; `POST /qqq/v1/manageSession` gives a session.

## M0 shell (2026-10-31): classic TUI against the sample server

```sh
qqq-tui-spike            # the shell: app tree, tables, records, processes, live footer
qqq-tui-spike test       # in-memory renderer tests
```

Keys (the function-key bar at the bottom is the truth):

| Key | Does | Key | Does |
|---|---|---|---|
| F1 | help | Esc | back a screen, or back to the Apps tree |
| F2 | go to any table or process by name | Tab | switch between the Apps tree and the content |
| F3 | view the record under the cursor | Enter | open (tree item, table row) |
| F4 | edit (M3) | ↑ ↓ PgUp PgDn Home End | move and page, server-side paging on tables |
| F5 | refresh | ← → | scroll columns; expand or collapse tree nodes |
| F6 | filter a table: `field OPERATOR value[,value]` | `s` | sort by the bracketed column |
| F7 | new record (M3) | `:` | command line: `table person lastName STARTS_WITH S`, `record pet 3`, `process sleepInteractive`, `home`, `quit` |
| F8 | delete the record under the cursor, with confirm | F9 | menu |
| F10 | quit | Ctrl+C | quit immediately |

Footer status line, live: server, auth and session, UI API version, ping (every 5 s), realtime stream state
(reconnects on its own), job count (`n/a` when the server has no `/jobs`), last stream event, clock.

Things to try: open Person, PgDn through Pets or Cities, F6 with `birthDate GREATER_THAN 1990-01-01`,
delete a pet with F8 and watch the count, restart the server with `qqq-sample-server restart` and watch
the footer go to `reconnecting` and back.

## M0 legacy screens: generated grid and form

```sh
QQQ_SPIKE_SCREEN=legacy qqq-tui-spike    # Ctrl+G grid, Ctrl+F form, Ctrl+P process, Ctrl+Q quit
qqq-tui-spike binary                      # the compiled macOS binary (legacy screens)
```

What to look at:
- Grid: 10,000 generated rows x 40 columns. Arrows, PageUp/Down, Home/End, Left/Right scroll columns,
  `s` sorts the cursor column. The status line shows key-to-frame latency. Resize the window.
- Form: Tab between every field type, type into the Home State field to filter the picker, Enter to
  pick, Ctrl+S validates and shows errors beside fields.
- Process: runs the sample's Sleep Interactive process on the server with an async job and polling.
  Change the milliseconds, press Enter. Watch the log lines at the bottom.

Known: typing in the same instant as Tab (paste, automation) lands in the previous field; a human does
not hit this. Windows binary is cross-compiled and unverified.

## CLI (`qqq`, M1 in progress)

`qqq` on your PATH runs the CLI from this checkout with Bun (no build step; the client and kernel packages
are rebuilt when their source changed). Grammar is `qqq <noun> <verb>`; the 0.1 flat commands (`apps`,
`tables`, `query`, `get`, `run`, `jobs`, `tail`) still work as aliases.

```sh
qqq login --server http://localhost:8077        # MOCK: server session (cookie). OAUTH2/AUTH_0: device flow.
qqq whoami
qqq apps
qqq table list --app peopleApp
qqq table describe person
qqq table query person -w "lastName STARTS_WITH S" -o -id -l 5
qqq table query person -g "(firstName = Avery OR firstName = Blair) AND birthDate > now(-40y)"
qqq table query person -w "annualSalary >= 300000" --count
qqq table query person -w "createDate > thisPeriod(month)" --print-filter     # the QueryFilter JSON
qqq table query person -l 2 --output csv --fields id,firstName,email
qqq table query person --output yaml -Q '[].{id: values.id, name: recordLabel}'  # JMESPath, as aws --query
qqq table get pet 3
qqq table create pet --generate-input-skeleton
qqq table create pet --set name=Pixel --set personId=2 --set speciesId=2
qqq table update pet 7 --set name=Pixel2
qqq table delete pet 7            # asks; --yes skips
qqq table export person --format xlsx --out people.xlsx
qqq table export person -w "id <= 5" -o -id --fields id,firstName,email --format tsv --out -   # stdout; format also from --out
qqq table query person --search lair            # quick search: CONTAINS over the text fields, ANDed with -w/-g
qqq table get country --key name=Canada         # Go To by a unique key (exit 5 none, exit 2 several)
qqq table copy pet 1 --set name=Copycat         # copy a record (--dry-run shows the values first)
qqq apps show greetingsApp                      # an app's home: actions, reports, tables with record counts, widgets
qqq report list                                 # the sample app has no reports
qqq help show table person [field] ; qqq help show process greet   # help content from the metadata (none in the sample)
qqq process list ; qqq process describe sleepInteractive
qqq process run sleepInteractive -v sleepMillis=1500     # async job, polled, progress on stderr
qqq process run clonePeople -r 1,2                       # records by primary key
qqq api --list ; qqq api getTableMetaData --path tableName=person -Q 'fields.*.label'
qqq widget list ; qqq widget get SampleLineChartWidget         # bars in the terminal; --csv for the numbers
qqq widget get SampleStackedBarChartWidget --output json      # the raw payload
qqq prefs list ; qqq prefs get regional ; qqq prefs set regional --set weekStartsOn=MONDAY
qqq help-search person ; qqq report run <name> --format xlsx
qqq search Avery ; qqq tail
```

Profiles name servers, as `aws --profile`; sign-ins live in the OS keyring (macOS Keychain here, Secret Service on
Linux, DPAPI on Windows; `QQQ_KEYRING=file` for a 0600 file). The first sign-in becomes the default profile.

```sh
qqq login --server http://localhost:8077 --profile sample   # creates the profile; the Keychain gets an item "qqq"
qqq config profile list ; qqq config profile use sample ; qqq config show
qqq --profile sample table count person ; QQQ_PROFILE=sample qqq whoami
```

OAuth2 sign-in (an OAUTH2 server with a native client): the device flow is the default, `--browser` signs in with the
authorization code and PKCE on a loopback redirect (`http://127.0.0.1:{port}/callback`; `--port`, `--redirect-host
localhost` and `--no-open` when the provider needs an exact registered URI or there is no browser). Tokens are
refreshed at the provider before they expire; a refresh the provider refuses (revoked, expired) exits 3 with "sign in
again". `qqq logout --provider-logout` also revokes the refresh token (RFC 7009) and opens the provider's end-session
URL. Try it with a second sample instance and the dev provider (leave the 8077 instance alone):

```sh
node packages/conformance/dist/dev-idp.js --port 9400 --client sample-app --client sample-cli --user you@example.com --groups admins
# in ../.worktrees/qqq-develop/qqq-sample-project:
OAUTH2_BASE_URL=http://localhost:9400/application/o/sample-app/ OAUTH2_CLIENT_ID=sample-app OAUTH2_CLIENT_SECRET=dev \
OAUTH2_SCOPES="openid profile email offline_access" OAUTH2_NATIVE_CLIENT_ID=sample-cli \
OAUTH2_NATIVE_CLIENT_BASE_URL=http://localhost:9400/application/o/sample-cli/ \
mvn -q -DskipTests -Dcheckstyle.skip=true compile exec:java -Dexec.mainClass=com.kingsrook.sampleapp.SampleJavalinServer \
  -Dqqq.sample.port=8078 -Dqqq.sample.esb.port=61617

qqq login --server http://localhost:8078 --profile oauth            # device flow: open the printed URL, it approves
qqq login --server http://localhost:8078 --profile oauth --browser  # browser: Approve or Deny on the provider page
qqq -p oauth whoami ; qqq -p oauth process run sleepInteractive -v sleepMillis=500
qqq -p oauth logout --provider-logout                              # revoke, then the end-session page
```

A denied request, a redirect whose `state` does not match, and a code the provider will not exchange each exit 3 and
save nothing; the new token is also checked against the server before the sign-in is kept.

Shell completion (nouns, verbs, options, and table, process, widget, field and operation names from the local
metadata cache):

```sh
eval "$(qqq completion zsh)"      # or bash; fish: qqq completion fish | source; pwsh: see qqq completion pwsh
qqq cache show | refresh | clear  # the metadata cache behind listings and completion (5 minutes, ~/.cache/qqq)
```

Global options go anywhere: `--server`, `--output json|table|text|csv|yaml` (`-O`), `--json`, `--query` (`-Q`),
`--fields`, `--yes`, `--trace`. Table on a terminal, JSON in a pipe, `QQQ_OUTPUT` overrides. Exit codes:
0 ok, 1 error, 2 usage or bad filter, 3 auth, 4 server unreachable or rate limited, 5 not found,
6 validation, 70 server error. `qqq job …` says this sample server has no jobs operations.

Contingent fields (field 1 narrows field 2) are handled by the kernel's form session, for tables and process
steps alike. The sample's Address book is country → state → city:

```sh
qqq table create placeAddress --set label=Home --set countryId=USA --set stateId=Missouri --set cityId="St. Louis"
qqq table create placeAddress --set label=X --set stateId=Missouri      # exit 2: set Country first
qqq table create placeAddress -i                                        # prompts; choices narrow after each answer
qqq table update placeAddress 3 -i                                      # prompts with the current values
qqq process run placeAddressPick                                        # asks for what the step lacks, same narrowing
qqq process run placeAddressPick -v countryId=USA -v stateId=Illinois -v cityId=spring   # labels, ids or unique partials
qqq table create pet --set name=Rex --set personId=1 --set speciesId=1 --set birthDate=2020-13-40   # exit 6, checked locally
```

Processes show every screen as the web does, in component order: help text, HTML as text, `label: value` pairs
(on every step, not only the last), the process records as a table (paged through `GET …/records`, `--record-limit`),
the validation review (count, preview, then the validation lines), the summary lines, files to download (saved to
`--out-dir` with the path printed) and widgets in steps. Intermediate screens go to stderr; the last screen is the
command's output (`--output json` gives the raw response).

```sh
qqq process run greetInteractive -r 1,2,3 -v greetingPrefix=Hi       # results: values, then the greeted records
qqq process run clonePeople -r 1,2                  # on a terminal: "Validate fully … or skip validation? [v/S]"
qqq process run clonePeople -r 1,2 --validate       # validation lines, then "Submit? [Y/n]" (n cancels the run)
qqq process run sleepInteractive -v sleepMillis=8000   # press Ctrl-C while it runs: POST …/cancel, exit 130
qqq process describe person.bulkEdit                # steps, fields, and the process and step help
```

Ctrl-C during a run (while a job runs or at a prompt) asks the server to cancel it (`POST …/cancel`) and exits 130;
a second Ctrl-C leaves at once. When a step reports a `backStep`, the terminal offers `b` to go back to it with the
values entered so far (none of the sample's processes declares one). A process's `minInputRecords` and
`maxInputRecords` are checked before `init` (a filter is counted first).

Possible-value fields take an id, an exact label, or a partial label that matches one choice; an ambiguous partial
lists the candidates. Validation (required, type, length, range, pattern) runs locally before the request, with the
same codes and messages the server would give. Form adjusters (on-load and on-change rules an application declares)
are called when the server has them; this sample app has none.

DATE_TIME values are typed and shown in your zone (the `TZ` environment) and sent as UTC instants, as the web
UI does; `--utc` shows the raw instants. A time skipped by a spring-forward change moves forward by the gap; a
time repeated by a fall-back change means its first occurrence. In filters, a date alone on a DATE_TIME field
means local midnight. Fields the server formats in a declared zone (fixed or per-record) keep its text.

```sh
TZ=America/Chicago qqq table create fieldLab --set name=tz --set dateTimeValue=2026-10-31T14:30   # stored 19:30Z
qqq table get fieldLab 4                          # Date Time Value  2026-10-31 14:30:00 CDT
qqq --utc table get fieldLab 4                    # Date Time Value  2026-10-31T19:30:00Z
TZ=Asia/Tokyo qqq table get fieldLab 4            # 2026-11-01 04:30:00 GMT+9
qqq table query fieldLab -w "dateTimeValue BETWEEN 2026-10-31,2026-10-31T23:59" --print-filter
qqq process run fieldLab.bulkEdit -r 4 -v bulkEditEnabledFields=dateTimeValue -v dateTimeValue=2026-10-31T09:15 -v name=tz --validate
```

Filter values can be expressions: `now()`, `now(-7d)`, `thisPeriod(month)`, `lastPeriod(week)`,
`startOf(quarter,-1)`, `me()`, `${variable.x}`; quote values with commas: `city IN "St. Louis, MO",Chicago`.

Where M1 stands: `docs/parity/feature-matrix.md` has the CLI status of every Next UI acceptance row. Not yet in
the CLI: bulk load (the sample server cannot accept uploads, see `docs/server-findings.md` #10), saved views,
column statistics, joins, variants, audits, jobs on a durable-jobs server,
TABLE_BASED sign-in.

## Reporting what you find

Say which screen, what you pressed, what you expected. If the TUI crashes, the terminal should be restored;
if it is not, `reset` fixes it and the stack trace is in the launching terminal.
