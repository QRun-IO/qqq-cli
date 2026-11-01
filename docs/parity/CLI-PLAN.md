# CLI parity plan (to 1.0)

Goal (James, 2026-10-31): every row of the CLI column in `feature-matrix.md` is **pass**, **n/a** (with the
browser-only reason) or **blocked** (citing a server finding in `docs/server-findings.md`). No `partial` or
`todo` at the end. The status source is `STATUS` in `scripts/parity-matrix.py`; regenerate with
`python3 scripts/parity-matrix.py docs/parity/next-feature-matrix.md`.

Start: 173 pass / 42 partial / 80 todo / 106 n/a of 401.
Checkpoint 1 (bulk load): 188 pass / 41 partial / 66 todo / 106 n/a.
Checkpoint 2 (records, queries, processes, help): 232 pass / 1 partial / 60 todo / 106 n/a / 2 blocked.
Checkpoint 3 (navigation, widgets, reports, security): 290 pass / 0 partial / 0 todo / 107 n/a / 4 blocked. Blocked: QRY-085 (finding 24, qqq#1355), REC-063 (finding 19, qqq#1351), SEC-029 and SEC-030 (finding 28: no AUTH_0 server; SEC-030 needs tenant credentials from James). New n/a: WID-074 (standalone composite controls are browser input editors). (branch `feat/m1-cli-parity` from `feat/m1-kernel-cli` 6c56b89).

"unit-tested" in a row note means the sample at :8077 cannot exercise the row (no fixture); the kernel and the
command are covered by node tests (and a local stub server where a command is involved). Everything else is
verified live against :8077.

Status column: **plan** = what the row becomes; **done** once the STATUS source says so.

## Bulk load, bulk edit, bulk delete (first)

| Row | Plan | Status |
|---|---|---|
| PRC-029 Bulk edit, switched-on fields | `qqq table bulk-edit <t> -r ids\|-w … --set f=v --clear f`; kernel `bulkEditValues` sends `bulkEditEnabledFields`; review shown, `--yes` | done (pass) |
| PRC-030 Bulk delete | `qqq table bulk-delete <t> -r ids\|-w …`: review, validation, result; asks unless `--yes` | done (pass) |
| PRC-031 Bulk insert | `qqq table bulk-insert <t> --file x.csv [--mapping m.yaml] [-i]`: upload, mapping (server suggestion cleaned, finding 26), value mapping, review preview, result | done (pass) |
| PRC-032 Mapping validation, Back | local mapping checks before submit (unmapped column, required without value, layout, key fields); `b` at a mapping or review prompt goes back (isStepBack) | done (pass) |
| PRC-016 Back (moved here) | verified on bulk insert -i | done (pass) |
| PRC-033 Bulk edit with a file by key fields | `qqq table bulk-edit <t> --file x.csv --key f[,g]` runs `bulkEditWithFile` | done (pass) |
| PRC-034 Upload instructions and template | instructions printed as text; `--template flat\|tall\|wide [--out]` saves the data: URI template | done (pass) |
| PRC-046 Saved profiles | `qqq bulk-profile list\|show\|save\|rename\|delete <t>`, `--saved <name>` on bulk-insert/bulk-edit; sample has no saved-profile processes: unit-tested with a stub | done (pass) |
| PRC-058 Saved profile menu | new, update after confirm (diff of changes printed), rename, delete | done (pass) |
| PRC-059 Ownership | yours vs shared; only the owner may save, rename, delete (checked before the call) | done (pass) |
| PRC-060 File mapping fidelity | field help, column preview values, repeated-header warning, `--no-header` | done (pass) |
| PRC-061 Typed defaults, searchable value mapping, add fields | defaults typed per field (`--default f=v`, labels resolved), value mapping by label search, `-i` add-fields list grouped by table | done (pass) |
| QRY-031 Bulk edit with checked ids | `-r ids` | done (pass) |
| QRY-032 Bulk delete of the whole query result | `-w`/`--filter-json` sends the filter | done (pass) |
| QRY-034 Actions menu | `qqq table actions <t>`: bulk load, bulk edit/delete, table processes, with the command for each | done (pass) |

## Records, forms, adornments

| Row | Plan | Status |
|---|---|---|
| REC-002 placeholders, hidden | unit-tested (finding 17) → pass | done |
| REC-020 HTML field editing | `table update --editor <field>` opens $EDITOR; HTML shown as sanitized text | done |
| REC-029 CHIP colors and icons | color (ANSI on a terminal) and icon name shown; unit-tested | done |
| REC-031 CODE_EDITOR | code shown verbatim (indent kept); `--editor <field>` edits it; unit-tested | done |
| REC-032 RENDER_HTML | HTML to sanitized text; unit-tested | done |
| REC-033 REVEAL | masked, `--reveal`, `--copy <field>` copies the value (OSC 52 / pbcopy); unit-tested | done |
| REC-034 FILE_DOWNLOAD | name and `table download`; unit-tested (finding 16 for BLOBs without adornments) | done |
| REC-035 FILE_UPLOAD formats | accepted formats checked before upload; unit-tested | done |
| REC-036..041 tooltip, widget, error, help | unit-tested → pass | done |
| REC-042/043 audits | unit-tested with a stub → pass | done |
| REC-053 API docs & playground | `table apis`, `api-doc`; playground: `table api-call` against the application API, or n/a | done |
| REC-054 scripts | add test runs if the server offers the test process; else note | done |
| REC-060 adjusters | unit-tested → pass | done |
| REC-061 dynamicForm widget on a record form | edit the JSON field through the widget's fields | done |
| REC-063 variant writes | blocked: finding 19 (qqq#1351) | done (blocked) |
| REC-064 joined sections | verified with an association join → pass | done |
| REL-006/007/008 | unit-tested → pass | done |

## Query, filters, saved views, variants

| Row | Plan | Status |
|---|---|---|
| QRY-004 column persistence | `qqq table columns <t> [--set a,b \| --reset]`, kept per table in the config the TUI uses; queries default to it | done |
| QRY-015 labels in filters | `-w "homeCityId = 'New York'"` resolved to ids by possible values | done |
| QRY-020/022 joins, stats | unit-tested → pass | done |
| QRY-050..054, 094, 096 saved views | unit-tested with a stub (sample has no saved views) → pass | done |
| QRY-060 variant remembered | last variant per table kept in local state | done |
| QRY-061/066/071 variants | unit-tested → pass | done |
| QRY-085 weekday criteria | grammar sends WeekdayOfDate; blocked on finding 24 (qqq#1355) | done (blocked) |

## Processes

| Row | Plan | Status |
|---|---|---|
| PRC-037 ad hoc composite actions and inputs | buttons offered as a choice, inputs prompted, submit-on-enter | done |

## Navigation, widgets, dashboards

| Row | Plan | Status |
|---|---|---|
| NAV-011, WID-040, PRF-004 | `qqq apps show <app> --widgets`: every widget once, declared order, gridColumns noted | done |
| NAV-017 | `qqq home`: counts, quick actions, app cards | done |
| NAV-024 | `qqq find <text>`: apps, tables, processes, reports by label with type and app | done |
| NAV-028 | reports under their app; unit-tested | done |
| WID-006/011/012/020/022/026/027/028/031/032/041/052/056/057/067/068 | render model per type, unit-tested and live where the sample has one | done |
| WID-021 process widget | runs its process through the runner | done |
| WID-029/030/070..075 editors | read-only rendering where it is display; editing through the host record field; grid-only rows n/a | done |
| WID-049 required dropdowns | prompt or refuse with the backend message | done |

## Reports (sample has none)

| Row | Plan | Status |
|---|---|---|
| RPT-001..006, 008, 019, 020 | `report run` formats csv/xlsx/json, inputs, summary/pivot files, navigation; stub server tests | done |
| RPT-009..018 | saved reports (`qqq saved-report list\|show\|run`), schedules, sharing (`share list\|add\|scope\|remove`); stub server tests | done |
| RPT-011 | streaming report route | done |

## Security and sign-in

| Row | Plan | Status |
|---|---|---|
| SEC-002/008 DISABLED tables and processes | listed with the reason; use refused before the call; unit-tested | done |
| SEC-006 copy needs insert | `table copy` refused without insert permission | done |
| SEC-011 record-level security | server-enforced; listed as returned | done |
| SEC-029/030 AUTH_0 | same device/PKCE code as OAUTH2 (verified with qqq-dev-idp); real tenant needs credentials | done |
| SEC-034..037 TABLE_BASED | `qqq login` with username/password over HTTP Basic (the server's TableBasedAuthenticationModule creates the session and sets the cookie); unit-tested with a stub | done |

## Help

| Row | Plan | Status |
|---|---|---|
| HLP-001..004 | unit-tested (finding 17) → pass | done |
