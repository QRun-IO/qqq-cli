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

## Try the release binary (`qqq-bin`)

`qqq-bin` on this machine (`~/.local/bin/qqq-bin`) is the darwin-arm64 release binary: the CLI
and the terminal UI in one file, no Node or Bun. It is the same build a user downloads; `qqq` stays the
from-source launcher. Both use the same profiles and keychain items.

```sh
qqq-bin --version                 # qqq 1.0.0 (darwin-arm64 binary with ui, <commit>, bun 1.4.4)
qqq-bin doctor                    # first line: the build, runtime and platform; then server, sign-in, terminal
qqq-bin --profile sample ui       # the terminal UI from the binary
qqq-bin ui --check                # the terminal check, with the build line support asks for
qqq-bin --profile sample table query person -l 3
scripts/verify-binary.sh ~/.local/bin/qqq-bin --server http://localhost:8077   # the whole smoke
```

A binary you download with a browser (from a GitHub release) is quarantined, and until the binaries are
notarized macOS refuses to open it ("Apple cannot check it for malicious software"). Clear the flag once:
`xattr -d com.apple.quarantine ./qqq-darwin-arm64`. `qqq-bin` was copied, not downloaded, so it has no flag;
Homebrew and `scripts/install.sh` do not set it either.

## Sample server (UI API 1.8.0, mock auth, in-memory data)

```sh
qqq-sample-server start      # http://localhost:8077  (web UI at /, API at /qqq/v1)
qqq-sample-server status | log | restart | stop
```

Data resets on every restart. Mock auth means no sign-in; `POST /qqq/v1/manageSession` gives a session.

## TUI (`qqq ui`, M3)

```sh
qqq ui                         # default profile; qqq --profile sample ui
qqq ui table query person -w "lastName STARTS_WITH S"     # straight to a screen
qqq ui --check                 # terminal and tmux check with fixes (also runs quickly at startup)
npm run test:tui               # in-memory renderer tests; packages/tui/scripts/smoke.sh drives it in tmux
```

Keys (the function-key bar is the truth; F1 or `?` lists them; every action is also in F9 and on `:`):

| Key | Does | Key | Does |
|---|---|---|---|
| F1 `?` | help, what you can do here, help search | Esc | back; the grid keeps its row, filter and page |
| F2 `/` `.` Ctrl+K | go to anything (apps, tables, processes, recents, commands) | Tab | Apps pane / content |
| F3 Enter | view / open | PgUp PgDn, Ctrl+F Ctrl+B | page (Ctrl+F/B work even when tmux takes PgUp) |
| F4 `e` | edit | `]` `[` (PgDn PgUp in a record) | next / previous record of the list |
| F5 `r` | refresh | `s` | sort by the column under the cursor |
| F6 `f` | filter: guided builder or the grammar with completion | Space / `b` | select rows / run a process on them |
| F7 `n` | new (a child on a child list) | `x` `g` `v` | export, go to by key, view settings |
| F8 `d` | delete, asks | Ctrl+S | save a form or continue a process step |
| F9 | menu: every command, searchable | `:` | command line, history and completion |
| F10 | Quit, Reset to home, or Cancel (`:reset`) | Ctrl+C | quit now |
| `a` | actions: bulk insert/edit/delete, processes, saved views | `A` `D` `t` `Z` | audits, developer, tags, share (record) |
| `q` `S` `l` | quick search, column statistics, follow a link (grid) | Esc 1..0, Ctrl+1..0 | F1..F10 when the terminal takes them |

Things to try: `:table query person`, Enter on a row, PgDn through records, Esc (same row); F6, add a
condition, Tab to the grammar and type `AND (fi` then Tab; `:table create placeAddress` (country, state, city
narrow); Space on two people, `b`, Bulk edit (Space switches a field on, Ctrl+S, review, submit); on the person
grid `a` › Bulk insert from a file (a CSV with firstName,lastName,email: the mapping grid, review, result) and
Bulk delete to remove those rows again; `:app SampleWidgetsDashboard`, Enter on a widget heading for its
actions (export CSV, dropdowns); F9 Settings for themes
(per profile or for all), single-key shortcuts, download folder, PIN and the screen lock; `:theme light`,
`:theme classic`, `:theme high-contrast` (the default). Sign-in follows the server: MOCK and FULLY_ANONYMOUS
get a session, TABLE_BASED asks for a username and password, OAUTH2 and AUTH_0 sign in in the browser (OAUTH2
can use a device code instead). See `packages/tui/README.md` for every key, the settings file and the keys
your terminal or tmux may take (`qqq ui --check` finds them).

The M0 spike (`qqq-tui-spike`, `packages/tui-spike`) stays in the repo for reference.

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
qqq table developer person 1                    # developer view: associated scripts and panels (record security, ESB)
qqq table apis person ; qqq table api-doc <t> <api> <version> [--out f]   # application APIs (none in the sample)
qqq script list|show|store|logs <t> <pk> …      # associated scripts: show [--revision n], store --file f | --editor -m msg, logs <field> <revisionId>
qqq apps show greetingsApp                      # an app's home: actions, reports, tables with record counts, widgets
qqq report list                                 # the sample app has no reports
qqq help show table person ; qqq help show table person firstName ; qqq help show process greet   # help content from the metadata (none in the sample)
qqq table query person --join pet --select -l 4      # joins: exposed joins (none in the sample), else the table's associations
qqq table query person --fields id,firstName,pet.name -w "pet.name STARTS_WITH C" -o pet.name
qqq table count person --join pet                     # many-side join: count and distinctCount
qqq table get person 1 --join pet
qqq table variants person                             # none in the sample; --variant <id|name|type:id> on table commands and process run
qqq table stats person annualSalary --local -l 3     # column statistics; the sample has no columnStats process, --local computes them
qqq saved-view list person ; qqq saved-view open person <view> ; qqq table query person --view <view> -w …   # saved views (none in the sample)
qqq saved-view save person --name Mine -w "lastName = Sample" -o -id --fields id,firstName -l 50   # -l is the view's page size
qqq saved-view rename person Mine Mine2 ; qqq saved-view delete person Mine2 --yes
qqq audit list person 1                               # audit history (the sample audits nothing: exit 2 with the reason)
qqq process list ; qqq process describe sleepInteractive
qqq process run sleepInteractive -v sleepMillis=1500     # async job, polled, progress on stderr
qqq process run clonePeople -r 1,2                       # records by primary key
qqq api --list ; qqq api getTableMetaData --path tableName=person -Q 'fields.*.label'
qqq widget list ; qqq widget get SampleLineChartWidget         # bars in the terminal; --csv for the numbers
qqq widget get SampleStackedBarChartWidget --output json      # the raw payload
qqq prefs list ; qqq prefs get regional ; qqq prefs set regional --set weekStartsOn=MONDAY
qqq help-search person ; qqq report run <name> --format xlsx
qqq search Avery ; qqq tail
qqq extensions ; qqq esb table person           # extensions (qbits): see "Extensions (qbits)" below
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
qqq cache show ; qqq cache refresh ; qqq cache clear   # the metadata cache behind listings and completion (5 minutes, ~/.cache/qqq)
```

Global options go anywhere: `--server`, `--profile` (`-p`), `--output json|table|text|csv|yaml` (`-O`), `--json`,
`--query` (`-Q`), `--fields`, `--yes` (`-y`), `--utc`, `--trace`, `--version`. Table on a terminal, JSON in a pipe,
`QQQ_OUTPUT` overrides. `--server` and `--path` have no short form (`-s` is `--set`, `-p` is `--profile`), and `-V`
is `--view` on `table query` (the version is `--version`). The same option names mean the same thing on every noun:
`--where/-w`, `--group/-g`, `--order/-o`, `--limit/-l`, `--skip`, `--fields/-f`, `--join/-j`, `--variant`,
`--reveal`, `--yes`; numbers are checked before anything is sent (`-l many` exits 2). Every list ends with the same
footer, `(3 records; joined: pet; more may exist: --limit, --skip or --all)`. Exit codes: 0 ok (also "Not deleted."
and "Not submitted." after a no), 1 error, 2 usage or bad filter (also Ctrl-D at a question), 3 auth, 4 server
unreachable, rate limited or a 502/503/504, 5 not found, 6 validation, 70 server error, 130 Ctrl-C (a run cancelled,
`tail` stopped). `qqq job …` says this sample server has no jobs operations.

Downloads (`table download`, `table export`, `report run`, `widget get --csv`, process files) go where `--out` or
`--out-dir` says (`-` is stdout), else into the download directory when one is set, else the current directory;
a default name never replaces a file (`name-1.ext`). The settings live in the `ui` section of
`~/.config/qqq/config.json` and are the same ones the TUI's F9 Settings change:

```sh
qqq config set download-dir ~/Downloads/qqq     # created when missing; an empty value removes it
qqq config get ; qqq config get download-dir    # also upload-dir, download-mode (ask|silent, the TUI) and theme
qqq config set theme classic ; qqq -p sample config set theme light   # globally, or for one profile
qqq table export person                         # wrote ~/Downloads/qqq/person.csv
```

Is everything in order? `qqq doctor` checks the profile, the server (reachable, UI API version within 1.6.0 to
1.8.0, authentication type, the sign-in accepted, extensions), the keyring and the metadata cache, and exits 1 with
what failed. `--conformance` adds the read-only conformance checks. The terminal rows come from the same check as
`qqq ui --check` (tmux bindings that take PageUp/PageDown and F-keys, alternate screen, colour, unicode, size);
`--fix` offers each live tmux fix (`--yes` answers those) and appends them to `~/.tmux.conf` only after a y typed at
the terminal.

```sh
qqq doctor ; qqq doctor --conformance ; qqq doctor --fix
```

Contingent fields (field 1 narrows field 2) are handled by the kernel's form session, for tables and process
steps alike. The sample's Address book is country → state → city:

```sh
qqq table create placeAddress --set label=Home --set countryId=USA --set stateId=Missouri --set cityId="St. Louis"
qqq table create placeAddress --set label=X --set stateId=Missouri      # exit 2: set Country first
qqq table create placeAddress -i                                        # prompts; choices narrow after each answer
qqq table update placeAddress 3 --set cityId="Kansas City"              # narrowed by the record's own state (Missouri), no -i needed
qqq table update placeAddress 3 --set stateId=Illinois                  # clears and sends the city that depended on it
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

Related records and the record view. `table get` shows sections in metadata order (hidden sections and fields never),
empty values as `--`, and adornments as text: a record link names its table and key (`Avery Sample → person 1`),
a chip is `[value]`, a REVEAL value is masked until `--reveal`, an error value starts with `!`, a tooltip follows in
parentheses, HTML is shown as text, a stored file shows its size or name and the download command.

```sh
qqq table get person 1 --associations          # every association as tables, all levels: Pet [pets], then each pet's notes
qqq table get pet 1 --links                    # the records this one links to, with the command that opens each
qqq table get pet 1 --follow personId          # open the related record (LINK adornment or possible-value table)
qqq table children person 1                    # the record's associations and how many children each has
qqq table children person 1 pets --limit 2 --skip 2    # one page of a child list, with the count and the next --skip
qqq table children pet 1 notes --all
qqq table create pet --parent person=2 --set name=Rexley --set speciesId=Dog    # a child linked to its parent
qqq table create petNote --parent pet=5 --set "note=Vet visit"                 # then: qqq table get person 2 --associations
echo hello > notes.txt ; echo other > other.txt
qqq table create fieldLab --set name=withfile --upload blobValue=./notes.txt   # multipart/form-data; note the id it prints
qqq table update fieldLab 1 --upload blobValue=./other.txt ; qqq table update fieldLab 1 --set blobValue=   # replace, remove
qqq table download fieldLab 1 blobValue -o copy.txt                            # -o - for stdout; without -o, the download directory
qqq table get person 1 --help-content          # table, section and field help inline (this sample app declares none; qqq help show for help alone)
```

DATE_TIME values are typed and shown in your zone (the `TZ` environment) and sent as UTC instants, as the web
UI does; `--utc` shows the raw instants. A time skipped by a spring-forward change moves forward by the gap; a
time repeated by a fall-back change means its first occurrence. In filters, a date alone on a DATE_TIME field
means local midnight. Fields the server formats in a declared zone (fixed or per-record) keep its text.

```sh
TZ=America/Chicago qqq table create fieldLab --set name=tz --set dateTimeValue=2026-10-31T14:30   # stored 19:30Z; use the id it prints below
qqq table get fieldLab 4                          # Date Time Value  2026-10-31 14:30:00 CDT
qqq --utc table get fieldLab 4                    # Date Time Value  2026-10-31T19:30:00Z
TZ=Asia/Tokyo qqq table get fieldLab 4            # 2026-11-01 04:30:00 GMT+9
qqq table query fieldLab -w "dateTimeValue BETWEEN 2026-10-31,2026-10-31T23:59" --print-filter
qqq process run fieldLab.bulkEdit -r 4 -v bulkEditEnabledFields=dateTimeValue -v dateTimeValue=2026-10-31T09:15 -v name=tz --validate
```

Filter values can be expressions: `now()`, `now(-7d)`, `thisPeriod(month)`, `lastPeriod(week)`,
`startOf(quarter,-1)`, `me()`, `${variable.x}`; quote values with commas: `city IN "St. Louis, MO",Chicago`.

Bulk load and bulk changes run the table's bulk processes with every screen the web shows: upload, column
mapping, value mapping, the review (record count, preview, full validation) and the result. Loading or changing asks
first unless `--yes`; without a terminal and without `--yes` the run is cancelled and the command exits 2. The
mapping comes from the server's suggestion, a mapping document (`--mapping m.yaml`), `--column field=column` and
`--default field=value`, or `-i` (questions for the header row, layout, each field's column, fields to add, values to
map; `b` goes back). Use your own file, or save a template first.

```sh
qqq table actions person                                       # what you can do: bulk load, bulk edit/delete, processes
qqq table bulk-insert person --template flat                   # saves "Person - Flat.csv" (the upload instructions' template)
printf 'First Name,Last Name,Email,Employed\nTry,Bulk,try@example.com,yes\n' > try.csv
qqq table bulk-insert person --file try.csv --column isEmployed=Employed --dry-run   # validates, shows, changes nothing
qqq table bulk-insert person --file try.csv --column isEmployed=Employed --save-mapping try.yaml --yes
qqq table bulk-insert person --file try.csv -i                 # edit the mapping on the terminal; asks before loading
qqq table bulk-edit person -w "lastName = Bulk" --set daysWorked=5 --clear birthDate --yes   # only these fields change
printf 'Id,Last Name\n<id from the insert>,Bulk2\n' > edit.csv
qqq table bulk-edit person --file edit.csv --key id --yes      # rows find their records by the key field
qqq table bulk-delete person -w "lastName STARTS_WITH Bulk"    # review and validation, then "Delete the records? [y/N]"
qqq bulk-profile list person ; qqq table bulk-insert person --file try.csv --saved <name>   # saved profiles (none in the sample)
qqq bulk-profile save person -n Mine --mapping try.yaml --file try.csv ; qqq bulk-profile rename person Mine Mine2 ; qqq bulk-profile delete person Mine2 --yes
```

A mapping document names fields (name, `child.field`, or the label) and where their values come from:

```yaml
layout: TALL                  # FLAT (default), TALL or WIDE; tables with child tables only
hasHeaderRow: true
fields:
  firstName: First Name       # a column by header name (or a letter: B)
  lastName: { column: B }
  isEmployed: { column: Employed, values: { Y: yes, N: no } }   # value mapping
  pets.name: Pet Name
  pets.speciesId: { column: Species, values: { Dog: Dog, Cat: Cat } }   # labels resolve to ids
  annualSalary: { default: 50000 }
keyFields: id                 # bulk edit with a file
```

Records, queries and developer tools added for parity:

```sh
qqq table columns person id lastName email      # the columns table query shows, kept per table (shared with the TUI); --reset
qqq table query pet -w "speciesId = Cat"        # possible-value labels in filters are sent as ids
qqq table query person -w "weekday(birthDate) IN 1,7" --print-filter   # ISO weekdays; the sample's H2 fails it (finding 24)
qqq table update fieldLab 3 -e htmlValue        # edit an HTML or code field in $VISUAL/$EDITOR; HTML shows as text
qqq table get person 1 --copy email             # copy a value (REVEAL values unmasked) to the clipboard
qqq table query <variant table> --variant -     # the variant chosen for a table is remembered; - forgets it
qqq table api-call <t> <api> <version> GET <path>   # try a request against an application API (none in the sample)
qqq script test <t> <pk> <field> -v input=value     # run a script against test inputs (no scripts in the sample)
qqq table widget-form <t> <pk> <widget> --set f=v   # edit a dynamicForm widget on a record form (none in the sample)
```

Dashboards, navigation, reports, sharing and sign-in added for parity:

```sh
qqq home                                        # counts, quick actions, one card per app
qqq find person                                 # the palette: apps, tables, processes, reports by label, with the command
qqq apps show SampleWidgetsDashboard --widgets  # every widget once, in declared order, sized in twelfths
qqq widget get SampleMultiStatisticsWidget      # groups with icon, header and values
qqq widget get <widget> --record <table>=<id>   # widgets on a record (cronUI, pivot and filter setups read it)
qqq widget get <process widget> --run           # run a process widget's process here
qqq report run <report> --format xlsx -v name=value --out-dir .   # through the report's process; no process: the report route (--out)
qqq saved-report list ; qqq saved-report show <r> ; qqq saved-report preview <r> -l 10
qqq saved-report set <r> -w "state = ${variable.state}" -o -total --columns id,total
qqq saved-report pivot <r> --rows state --values SUM:total ; qqq saved-report pivot <r> --clear
qqq saved-report run <r> --format csv ; qqq saved-report schedule <r> --cron "0 0 7 ? * MON-FRI" --time-zone America/Chicago --to me@example.com
qqq share list savedReport <id> ; qqq share add savedReport <id> user:<id> --scope read-only ; qqq share scope savedReport <id> <share> read-write
qqq login --username <name>                     # TABLE_BASED servers (password asked, or QQQ_PASSWORD); the sample uses MOCK
qqq table query person -w "lastName ~ sample"   # text matches send CASE_INSENSITIVE (the server drops it until qqq#1358); ~= matches case
```

Where M1 stands: `docs/parity/feature-matrix.md` has the CLI status of every Next UI acceptance row. Not yet verifiable here: jobs on a durable-jobs server, TABLE_BASED and AUTH_0 sign-in (stub-tested). Built but not verifiable against this sample, which has none of them:
saved views, server-side column statistics (columnStats), audits, a variant-backed table, exposed joins (joins were
checked through an association join instead); node tests and a local stub server cover those.

## Extensions (qbits)

An extension is a qbit or module that adds UI API operations. The CLI knows every extension whose
document was merged into the client (13 today, listed in `docs/extensions.md`); a server installs
some of them and lists them in `GET /version`. Each has a noun:

| Noun | Extension | First-class verbs | Generated verbs (one per operation) |
|---|---|---|---|
| `qqq esb` | esb (qqq) | `overview`, `table <t>`, `process <p>`, `dead-letters <trigger>`, `messages <destination> [--trigger t]` | `get-overview`, `get-table`, ... |
| `qqq collab` | collaboration | `presence <table> [pk] [--watch\|--observe]`, `comments list\|add`, `favorites list\|add\|remove`, `recents`, `follow [--status]`, `unfollow`, `my-work`, `people [q]` | `get-records-timeline <table> <pk>`, `get-records-tags`, `put-records-assignment`, ... (45) |
| `qqq health`, `alerts`, `assistant`, `data-analysis`, `db-performance`, `edi`, `qa-capture`, `quick-search`, `release-notes`, `secured-data`, `sql-workbench` | the qbit of that name | none yet | every operation, e.g. `qqq sql-workbench get-capabilities` |

Generated verbs are the method plus the literal path segments after the extension's prefix. They take
path parameters as arguments or `--path name=value`, plus `--param`, `--body-json`, `--form` and `--out`.
`qqq <noun> --help` lists them with the operation behind each.

What happens:

- **Installed.** The command runs. `qqq whoami` and `qqq extensions` show it with its version.
- **Not installed.** Every verb of the noun, and `qqq api <operation>` for any of its operations, stops
  before calling the server, with exit 5: `extension collaboration is not installed on this server
  (installed: esb 1.1.0)`.
- **Installed below the minimum the client needs** (esb, health and collaboration need 1.1.0): exit 5,
  `this client needs extension esb 1.1.0 or later; this server has 1.0.0`.
- **Installed but unknown to this client** (a newer qbit): listed by `qqq whoami` and `qqq extensions`
  as `unknown to this client`, never dropped. It has no noun until the client document is regenerated.

The installed list comes from `GET /version`, cached with the metadata for five minutes (`qqq cache
refresh` rereads it). `QQQ_EXTENSION_CHECK=off` skips the check, for a Prism mock whose `/version` is
only an example.

```sh
qqq extensions                                   # known vs installed, versions, minimums, operations
qqq api --list --extension collaboration         # an extension's operations (the list has an extension column)
qqq esb table person                             # sample server: what person publishes, which processes it triggers
qqq esb process syncPerson ; qqq esb messages personEvents --trigger syncPerson.personEvents
qqq collab presence person 1                     # sample server: exit 5, collaboration is not installed
```

Collaboration needs a server with qbit-collaboration. Its repo has a demo server (memory backend, MOCK
users alice, bob and admin); it runs on port 8098 beside the sample server:

```sh
cd ../qbit-collaboration && ./mvnw -q test-compile dependency:build-classpath -Dmdep.includeScope=test -Dmdep.outputFile=target/demo-classpath.txt
mkdir -p /tmp/fe/next-dashboard && echo '<html></html>' > /tmp/fe/next-dashboard/index.html   # it insists on a Next export
java -Dqqq.javalin.frontend=next -Dcollab.dev.port=8098 -cp "target/test-classes:target/classes:$(cat target/demo-classpath.txt):/tmp/fe" \
  com.kingsrook.qbits.collaboration.devserver.CollaborationDevServer

qqq login --server http://localhost:8098 --profile collab        # alice
qqq --profile collab collab presence person 1 --watch            # join; prints each change until Ctrl+C
qqq --profile collab collab presence person --observe            # watch the table without appearing
qqq --profile collab collab comments list person 1 ; qqq --profile collab collab comments add person 1 "Looks right"
qqq --profile collab collab favorites list ; qqq --profile collab collab favorites add person 4
qqq --profile collab collab follow person 2 --comments off ; qqq --profile collab collab my-work
```

To see someone else, open `http://localhost:8098/?createMockSession=true&user=bob` in a browser on a
person (needs a real Next export), or hold a lease as bob with curl (`POST /qqq/v1/qbit/collaboration/presence?user=bob`).
Presence lists everyone holding a lease on the record or table, you included while you `--watch`;
`since` is when the CLI first saw them.

## Reporting what you find

Say which screen, what you pressed, what you expected. If the TUI crashes, the terminal should be restored;
if it is not, `reset` fixes it and the stack trace is in the launching terminal.
