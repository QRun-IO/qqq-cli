#!/usr/bin/env python3
"""Generates docs/parity/feature-matrix.md: the Next UI acceptance matrix rows with a CLI and a TUI column.

Usage: python3 scripts/parity-matrix.py <next-feature-matrix.md> [out.md]

Statuses: pass (verified against the sample server), partial (works with gaps, noted), todo (planned),
n/a (browser-only, noted). Edit STATUS below when a row changes; the summary counts are computed.
"""
import re, sys, collections

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else 'docs/parity/feature-matrix.md'

# id -> (cli, note) ; family default is todo
P, T, N, X = 'pass', 'todo', 'partial', 'n/a'  # T is the default and the common case
B = 'blocked'  # waits on a server finding or issue, named in the note
STATUS = {
 # NAV: the CLI has no shell; the TUI covers these in M3
 **{f'NAV-{i:03d}': (X, 'browser shell') for i in (1,2,3,4,5,12,13,14,15,16,18,19,20,21,22,26,29,32,33,34,35,36,37,38,55,56)},
 'NAV-006': (P, 'hidden tables and processes are not listed; direct use is refused by the server'),
 'NAV-007': (P, 'qqq table get on a hidden table the user may read'),
 'NAV-008': (P, 'qqq apps show <app>: sections of processes, reports, tables and child apps, then widgets'),
 'NAV-009': (P, 'qqq apps show counts each table with TABLE_COUNT (--no-counts skips)'),
 'NAV-010': (X, 'app home rendering'), 'NAV-011': (T, 'widgets per app'),
 'NAV-017': (T, 'whoami shows counts; dashboard landing is the TUI'),
 'NAV-023': (P, 'qqq table get <t> --key field=value: one match shows the record, none exits 5, several exit 2'),
 'NAV-024': (T, 'shell completion covers names; a palette is the TUI'),
 'NAV-025': (P, 'qqq search'), 'NAV-027': (P, 'qqq whoami: apiVersion, features, counts'),
 'NAV-028': (N, 'qqq report list (reports with their app); the sample app has no reports to verify'), 'NAV-030': (P, 'qqq search over POST /search'), 'NAV-031': (P, 'server-enforced; refusals shown'),
 # PRF
 'PRF-001': (P, '10,000 rows with --all and --page-size'), 'PRF-002': (P, '--limit/--skip paging'), 'PRF-003': (P, 'server sort and filter'),
 'PRF-004': (T, 'one widget per call today'), 'PRF-005': (P, 'process run polls every 500 ms and prints progress'),
 # PRC
 'PRC-001': (P, 'process run -r ids'), 'PRC-002': (P, '--filter-json'), 'PRC-003': (P, ''), 'PRC-004': (P, ''), 'PRC-005': (X, 'grid selection; use -r'),
 'PRC-006': (P, 'checked before init (filters counted); the sample declares no limits, verified by tests'), 'PRC-007': (P, 'every component in order as text (kernel screen model); bulk load forms belong to qqq bulk'),
 'PRC-008': (P, 'text with line breaks; previewText printed above it'), 'PRC-009': (P, 'includeFieldNames and values kept across steps'), 'PRC-010': (P, 'required checked locally and by the server'),
 'PRC-011': (P, 'labels or ids, prompts list choices'), 'PRC-012': (P, 'label: value on every step'), 'PRC-013': (P, '{step}.html as text (tags stripped)'), 'PRC-014': (P, 'GET /download/{file} saved to --out-dir, else the download directory; no sample process offers one, verified by tests'),
 'PRC-015': (P, 'step helpContents shown on the screen, process help at start and in describe; none in the sample'), 'PRC-016': (P, 'b at a prompt when the step reports backStep (isStepBack=true); verified live: bulk insert -i back from the mapping to the upload and from the review to the mapping'), 'PRC-017': (P, 'updatedFrontendStepList followed'), 'PRC-018': (P, 'updatedFields applied'),
 'PRC-019': (P, 'message, N/M, elapsed on stderr'), 'PRC-020': (P, 'Ctrl-C during a job or a prompt calls POST …/cancel, exit 130'), 'PRC-021': (P, 'userFacingError shown'), 'PRC-022': (X, 'retry is re-running the command'),
 'PRC-023': (X, 'screen labels'), 'PRC-024': (X, 'stepper; step names printed'), 'PRC-025': (P, 'GET …/records paged into a table, --record-limit'), 'PRC-026': (P, 'count and preview; asks validate or skip on a terminal, --validate / --skip-validation; Submit? after validation'),
 'PRC-027': (P, 'status, count, message lines'), 'PRC-028': (P, ''), 'PRC-029': (P, 'qqq table bulk-edit <t> -r ids|-w ... --set f=v --clear f (-i chooses fields): only the switched-on fields are sent (bulkEditEnabledFields), review, result; verified live on person'), 'PRC-030': (P, 'qqq table bulk-delete <t> -r ids|-w ...: review with count and preview, validation, result; asks unless --yes (exit 2 without a terminal); verified live'), 'PRC-031': (P, 'qqq table bulk-insert <t> --file x.csv: upload, column mapping (server suggestion cleaned per finding 11, --mapping document, --column/--default, -i), value mapping, review preview and validation, result; FLAT and TALL verified live'), 'PRC-032': (P, 'mapping checked before submit (unmapped field, unknown column, layout, WIDE repetition, key fields, repeated header); Back from mapping to upload and from review to mapping verified live with -i'),
 'PRC-033': (P, 'qqq table bulk-edit <t> --file x.csv --key id [--mapping]: rows matched by the key, value mapping; verified live on person'), 'PRC-034': (P, 'upload instructions printed as text; --template [flat|tall|wide] [--out] saves the data: templates; verified live'), 'PRC-035': (P, 'named widget with the process UUID and values, kernel render model; none in the sample, verified by tests'), 'PRC-036': (P, 'seeded from the process value of the widget name'), 'PRC-037': (N, 'ad hoc blocks rendered with interpolation; buttons and inputs not offered'), 'PRC-038': (X, 'Google Drive is web-only'), 'PRC-039': (X, 'Google Drive is web-only'),
 'PRC-040': (X, 'no reload'), 'PRC-041': (P, 'UNAUTHENTICATED exits 3 with the sign-in hint'), 'PRC-042': (P, 'server-enforced'), 'PRC-043': (P, '-v values seed every step'),
 'PRC-044': (X, 'scanner screens are interactive'), 'PRC-045': (P, 'the runner follows nextStep whatever the flow'), 'PRC-046': (P, 'qqq bulk-profile list|show|save|rename|delete <t> [--edit], bulk-insert --saved <name> and --save-profile; unit-tested and stub-server CLI tests: the sample has no saved-profile processes'), 'PRC-047': (P, 'completes on init'),
 'PRC-048': (P, 'searchProcessPossibleValues'), 'PRC-049': (P, 'v1 routes only'), 'PRC-050': (X, 'Material-specific'), 'PRC-051': (P, 'dependent choices narrow after each answer'),
 'PRC-058': (P, 'bulk-profile save --replace prints the changes and asks (--yes), rename, delete; stub-server CLI tests (the sample has no saved-profile processes)'), 'PRC-059': (P, 'profiles listed as yours, then shared by their owner; save over, rename and delete refused for a profile you do not own; stub-server CLI tests'), 'PRC-060': (P, "-i lists columns with preview values and the step's field help, asks for the header row (--no-header), warns on repeated headers (only the first is read); header toggle and previews verified live, help and repeated headers unit-tested"), 'PRC-061': (P, 'defaults typed per field (--default f=label resolves possible values; yes/no booleans), value mapping by label or id with choices listed, -i add-fields list grouped by table; verified live (Dog/Cat to species ids, yes/no to booleans)'), 'PRC-062': (X, 'composite editors'), 'PRC-063': (X, ''), 'PRC-064': (P, 'process values typed local, sent UTC; screens show the local zone'), 'PRC-065': (X, 'Google Drive'), 'PRC-066': (P, 'field behaviors applied before submit'),
 # QRY
 'QRY-001': (P, 'default order by primary key'), 'QRY-002': (P, '--limit, --skip, --all'), 'QRY-003': (P, '--order, -field for descending'), 'QRY-004': (T, '--fields per call; no persistence'),
 'QRY-005': (X, 'grid presentation'), 'QRY-006': (X, ''), 'QRY-007': (P, 'error with code, status and trace id'), 'QRY-010': (P, 'all operators and shorthand'), 'QRY-011': (P, 'BETWEEN, IN lists'),
 'QRY-012': (P, 'now(), now(-7d), thisPeriod(), startOf()'), 'QRY-013': (P, '--where/--group DATE_TIME values local to UTC (a date is local midnight); expressions as before'), 'QRY-014': (P, 'IS_BLANK, TRUE, FALSE'), 'QRY-015': (T, 'filters take ids; labels in filters todo'),
 'QRY-016': (P, '--group with parentheses'), 'QRY-017': (P, '--print-filter gives the JSON the web links accept'), 'QRY-018': (P, 'any operator in --where'), 'QRY-019': (P, '--search on query, count and export: CONTAINS over the shown text fields, ORed, ANDed with the filter'),
 'QRY-020': (N, '--join and table.field in --fields/--where/--order, labelled "Join: Field"; the sample exposes no joins, verified through an association join (person to pet)'), 'QRY-021': (P, 'a many-side join repeats rows; count and --count add the distinct count (person --join pet: 21 rows, 16 distinct)'), 'QRY-022': (N, 'qqq table stats <t> <field> [-w …] through the columnStats process; the sample has neither QUERY_STATS nor the process, so --local (same figures from the matching rows) is what was verified'), 'QRY-023': (P, 'without QUERY_STATS (or the process) table stats exits 2 with the reason; --local is an explicit opt-in'), 'QRY-030': (P, '-r ids, --filter-json, --limit'), 'QRY-031': (P, 'table bulk-edit -r ids; verified live'), 'QRY-032': (P, 'table bulk-delete -w ... (or --filter-json, --all-records) sends the whole filter; verified live'),
 'QRY-033': (P, 'process run --filter-json with limit'), 'QRY-034': (P, 'qqq table actions <t>: bulk load, bulk edit/delete and the table processes with the command for each; verified live'), 'QRY-035': (P, 'server refuses; exit 3'), 'QRY-040': (P, 'table export: filtered (--where, --group, --search), sorted (--order), --fields in column order, --limit, --out -'), 'QRY-041': (P, 'csv, xlsx, json, tsv; format from --out extension; --no-header; bad format or field exit 2 before the request'),
 'QRY-042': (X, 'nothing to disable'), 'QRY-043': (P, 'server refuses'), 'QRY-050': (N, 'qqq saved-view list <t>, open <t> <view>, table query --view; the sample has no saved views; verified with node tests and a local stub server'), 'QRY-051': (N, 'saved-view save --name: filter, sort, columns and page size as the Material RecordQueryView'), 'QRY-052': (N, 'saved-view save --replace, rename, delete (asks; --yes)'), 'QRY-053': (N, 'a name in use is refused before any change; an unknown view exits 2 with the list'), 'QRY-054': (N, 'views shared with you are listed as shared by their owner; changes to them are the server\'s to refuse, its message shown'),
 'QRY-060': (N, 'table variants; --variant on query, count, get, copy, export, writes and process run; a terminal asks; not remembered between commands; no variant table in the sample'), 'QRY-061': (N, 'no --variant and no terminal (or no answer): exit 2, nothing queried; no variant table in the sample'), 'QRY-062': (P, 'describe shows capabilities; server refuses'), 'QRY-063': (P, 'server refuses writes'), 'QRY-064': (P, ''), 'QRY-065': (P, 'POST /table/{t}/export'),
 'QRY-066': (N, 'GET /table/{t}/variants (called live; the sample lists none)'), 'QRY-067': (P, 'table get --key; the primary key and Material gotoFieldNames are the declared keys, other fields looked up with a note'), 'QRY-068': (P, 'default columns follow sections by tier'), 'QRY-069': (X, 'locale formatting'), 'QRY-070': (X, 'shortcuts'), 'QRY-071': (N, 'process run --variant: tableVariant on init, every step and status; sent live, no variant table to observe'),
 'QRY-080': (X, 'quick filters UI'), 'QRY-081': (X, ''), 'QRY-082': (X, ''), 'QRY-083': (X, ''), 'QRY-084': (X, ''), 'QRY-085': (T, 'weekday criteria'), 'QRY-086': (P, 'expressions'), 'QRY-087': (P, 'IN lists; quoted values'), 'QRY-088': (X, ''), 'QRY-089': (P, 'behaviors'),
 **{f'QRY-{i:03d}': (X, 'saved views and column UI') for i in (90,91,92,93,94,95,96)}, **{f'QRY-{i:03d}': (X, 'phone layout') for i in (8,9,24,36,55)},
 # REL
 'REL-001': (P, 'display values; table get shows the target (Avery Sample → person 1), --links lists them, --follow opens one'), 'REL-002': (P, 'table get --associations lists exactly the record\'s children; table children pages a list with its count (View All)'), 'REL-003': (P, 'table create <child> --parent table=pk; table get --associations shows it at once'), 'REL-004': (P, 'person > pets > notes: each pet lists only its own notes'), 'REL-005': (P, 'records are never cached: update or delete a child, the next get/children shows the current rows'), 'REL-006': (N, 'unreadable child tables shown as unavailable without data; table children shows the server message; the sample has no denied child table (unit-tested)'), 'REL-007': (N, 'composite joins and widget-section labels in the kernel, unit-tested; the sample declares none'), 'REL-008': (N, '--parent sets every join value of a composite association, unit-tested; the sample declares none'), 'REL-009': (P, 'table delete of a parent: its pets are gone, other parents keep theirs'),
 # REC
 'REC-001': (P, 'table get by section and tier'), 'REC-002': (N, 'empty values show --; hidden sections and fields are dropped by the kernel record view (unit-tested; the sample has none)'), 'REC-003': (P, 'exit 5'), 'REC-004': (X, 'tabs'), 'REC-005': (P, 'validated locally before any request'), 'REC-006': (P, ''), 'REC-007': (P, ''), 'REC-008': (X, 'guard'),
 'REC-009': (P, 'update sends only changed fields'), 'REC-010': (P, 'non-editable fields excluded'), 'REC-011': (P, ''), 'REC-012': (P, 'confirm unless --yes'), 'REC-013': (P, 'qqq table copy <t> <pk> [--set f=v] [-i] [--dry-run]: primary key, non-editable and file fields dropped'), 'REC-014': (P, ''), 'REC-015': (P, ''), 'REC-016': (P, 'defaults applied'),
 'REC-017': (P, ''), 'REC-018': (P, 'typed and shown in TZ, stored UTC, --utc for raw; DST edges tested'), 'REC-019': (X, 'display zones'), 'REC-020': (T, 'raw HTML; $EDITOR todo'), 'REC-021': (P, 'server masks'), 'REC-022': (P, 'table create/update --upload and table download (base64 BLOB value) verified on fieldLab; default name into the download directory'), 'REC-023': (P, 'server'),
 'REC-024': (P, 'maxLength checked locally'), 'REC-025': (P, 'behaviors'), 'REC-026': (P, 'ranges checked locally'), 'REC-027': (P, 'server message'), 'REC-028': (P, 'record links name table and key, --follow opens them; URL links show the URL'), 'REC-029': (N, 'chip as [value]; colors and icons not shown (unit-tested; none in the sample)'), 'REC-030': (X, ''), 'REC-031': (N, 'raw code on view; no code editor (unit-tested)'), 'REC-032': (N, 'HTML shown as text (unit-tested)'),
 'REC-033': (N, 'masked until --reveal in the record view and in query and child-list cells; no copy (unit-tested; none in the sample)'), 'REC-034': (N, 'name plus qqq table download via the field route (unit-tested); live only for BLOB values, server finding 16'), 'REC-035': (N, 'create/update --upload field=path as multipart, replace and remove verified on a BLOB; FILE_UPLOAD formats not in the sample'), 'REC-036': (N, 'tooltip text in parentheses after the value (unit-tested)'), 'REC-037': (N, 'value rendered through the widget render model as text (unit-tested)'), 'REC-038': (N, 'value marked with ! (unit-tested)'), 'REC-039': (N, 'table get --help-content: view-screen roles, HTML/MARKDOWN as text (unit-tested; the sample has no help); qqq help show lists help alone'), 'REC-040': (N, 'section help with --help-content (unit-tested)'), 'REC-041': (N, 'table helpContent and helpContents slots with --help-content (unit-tested)'), 'REC-042': (N, 'qqq audit list <t> <pk> [--asc]: entries newest first with field changes; the sample audits no table, verified with node tests and a local stub server'), 'REC-043': (N, 'without the audit process the audit table is queried with its auditTable and auditDetail joins (node tests)'),
 'REC-044': (P, 'recordLabel'), 'REC-045': (P, 'labels resolved, defaults looked up'), 'REC-046': (P, 'server'), 'REC-047': (X, ''), 'REC-048': (P, 'fieldErrors by field'), 'REC-049': (X, ''), 'REC-050': (P, ''), 'REC-051': (P, ''), 'REC-052': (P, 'contingent fields'),
 'REC-053': (N, 'qqq table apis <t> and table api-doc <t> <api> <version> (saved as JSON); no playground; the sample exposes no application APIs (verified: none listed, an unknown API exits 5)'), 'REC-054': (N, 'qqq script list|show [--revision]|store --file/--editor|logs, and table developer <t> <pk> with the developer panels (verified live on person 1); no test runs; the sample has no associated scripts, so scripts are covered by node tests'), 'REC-055': (X, ''), 'REC-056': (X, ''), 'REC-057': (X, ''), 'REC-058': (X, ''), 'REC-059': (X, ''), 'REC-060': (T, 'adjusters wired, no sample to test'), 'REC-061': (T, ''), 'REC-062': (P, 'inline enums'), 'REC-063': (N, 'get, copy and update -i read with --variant; v1 writes ignore it (server finding #19)'), 'REC-064': (N, 'table get --join adds joined fields (queryJoins); verified with an association join'), 'REC-065': (P, 'an unchanged wall-clock time keeps the original instant and its precision'),
 # SEC
 'SEC-001': (P, ''), 'SEC-002': (T, 'disabled tables listed with a reason'), 'SEC-003': (P, ''), 'SEC-004': (P, ''), 'SEC-005': (P, ''), 'SEC-006': (T, 'copy'), 'SEC-007': (P, ''), 'SEC-008': (T, ''), 'SEC-009': (P, 'widget get shows the refusal'), 'SEC-010': (P, ''),
 'SEC-011': (T, 'saved views and reports'), 'SEC-012': (P, 'server'), 'SEC-013': (P, 'server'), 'SEC-014': (P, ''), 'SEC-015': (P, ''), 'SEC-020': (P, 'qqq login on a MOCK server'), 'SEC-021': (P, 'qqq logout calls POST /logout'), 'SEC-022': (P, 'exit 3 with the sign-in hint'),
 'SEC-023': (P, ''), 'SEC-024': (X, ''), 'SEC-025': (P, 'device flow and --browser (code + PKCE, loopback) verified against a sample on OAUTH2 with qqq-dev-idp'), 'SEC-026': (P, 'denial, forged state and a refused code exchange exit 3 and save nothing; the token is checked against the server first'), 'SEC-027': (P, 'logout --provider-logout: refresh token revoked (RFC 7009), end-session URL opened; bearer sign-ins have no server session'), 'SEC-028': (P, 'a refresh the provider refuses exits 3 with sign in again; refresh before expiry verified'), 'SEC-029': (T, ''), 'SEC-030': (T, ''), 'SEC-031': (P, ''), 'SEC-032': (P, 'unknown type refused'),
 'SEC-033': (X, ''), 'SEC-034': (T, 'TABLE_BASED sign-in (no API recipe yet)'), 'SEC-035': (T, ''), 'SEC-036': (T, ''), 'SEC-037': (T, ''), **{f'SEC-{i:03d}': (X, 'browser security') for i in (38,39,40,41,42,43,44,48,49,50)},
 # INT
 **{f'INT-{i:03d}': (X, 'browser accessibility and layout') for i in (1,2,3,4,5,6,8,9,11)}, 'INT-007': (P, 'field named in every message'), 'INT-010': (P, 'exit 4 and a message; rerun'), 'INT-012': (P, 'no client cache of records'), 'INT-013': (P, '(no records)'), 'INT-014': (P, 'cannot reach the server'),
 # WID
 **{f'WID-{i:03d}': (P, 'rendered as text') for i in (1,2,3,4,5,7,8,9,10,13,14,16,17,18,19,23,24,46,51,54,59,61)},
 'WID-006': (T, 'generic'), 'WID-011': (T, 'location'), 'WID-012': (T, 'multiStatistics untested'), 'WID-015': (P, 'prints the URL'), 'WID-020': (T, 'usaMap markers'), 'WID-021': (T, 'process widget'), 'WID-022': (T, 'parent widget children'),
 'WID-025': (X, 'customComponent is web-only'), **{f'WID-{i:03d}': (T, 'developer and editor widgets') for i in (26,27,28,29,30,31,32,70,71,72,73,74,75)}, 'WID-033': (X, 'QuickSight'), 'WID-040': (T, 'widgets per app'), 'WID-041': (T, 'footer text'),
 **{f'WID-{i:03d}': (X, 'card chrome') for i in (42,43,44,45,55,58,62,64,65)}, 'WID-047': (P, '--input name=value'), 'WID-048': (P, '--input'), 'WID-049': (T, 'required dropdowns'), 'WID-050': (X, ''), 'WID-052': (T, 'empty states'), 'WID-053': (P, 'unknown shapes shown raw'),
 'WID-056': (T, ''), 'WID-057': (T, 'every block type'), 'WID-060': (P, '--input id=…'), 'WID-063': (P, ''), 'WID-066': (P, ''), 'WID-067': (T, ''), 'WID-068': (T, ''), 'WID-069': (X, 'theme colors'),
 # RPT
 'RPT-001': (T, 'report run exists; no sample report to verify'), 'RPT-002': (T, ''), 'RPT-003': (T, ''), 'RPT-004': (T, ''), 'RPT-005': (T, ''), 'RPT-006': (T, 'report inputs'), 'RPT-007': (P, 'server'), 'RPT-008': (T, 'report list'),
 **{f'RPT-{i:03d}': (T, 'saved reports, schedules, sharing') for i in (9,10,11,12,13,14,15,16,17,18,19)}, 'RPT-020': (T, ''),
 # HLP
 'HLP-001': (N, 'qqq help show app|widget|instance; the sample carries no help content'), 'HLP-002': (N, 'qqq help show table <t> [field]: table, section and field help; no sample content'), 'HLP-003': (N, 'field help is the column help; table action help slots print with their slot name; no sample content'), 'HLP-004': (N, 'qqq help show process <p>: process, step, HELP_TEXT and step field help; no sample content'), 'HLP-005': (P, 'qqq help-search'),
 'QRY-093': (X, 'no screen state to keep: views are opened by name'), 'QRY-094': (N, 'saved-view list counts quick views with doCount (--counts counts all)'), 'QRY-096': (N, 'opening a view drops removed fields with Material\'s warnings on stderr'), 'HLP-006': (X, 'author affordance'),
}

# TUI column (M3, qqq ui): rows verified in tmux against the sample server or by the in-memory tests in
# packages/tui/test. Rows not listed fall back to n/a for browser-only rows and todo for the rest.
TUI = {
 'NAV-001': (P, 'qqq ui table query <t>; :table query <t>'), 'NAV-002': (P, 'Apps tree, backend order'), 'NAV-003': (P, 'nested apps in the tree'),
 'NAV-004': (P, 'Enter opens; current entry marked; arrows expand and collapse'), 'NAV-005': (N, 'markers for processes and reports; icons not drawn'),
 'NAV-006': (P, 'hidden tables and processes are not listed'), 'NAV-007': (P, ':table query and :record open hidden tables the user may read'),
 'NAV-008': (P, 'app home: sections with tables, processes, reports'), 'NAV-009': (P, 'record counts beside tables'), 'NAV-010': (P, ''),
 'NAV-011': (P, 'dashboard apps draw their widgets'), 'NAV-012': (N, 'app name in the title bar'), 'NAV-014': (P, 'title-bar path: apps, table, record or form'),
 'NAV-017': (N, 'home: counts and app list; no quick actions'), 'NAV-018': (P, 'qqq ui <route in the CLI grammar>'), 'NAV-023': (P, 'g: primary key or a configured unique key (kernel gotoKeys)'),
 'NAV-024': (P, 'F2, /, ., Ctrl+K palette with type and app context'), 'NAV-025': (N, 'palette lists recents; no search page'), 'NAV-027': (N, 'F9 Connection: versions, features, extensions, metadata generation'),
 'NAV-028': (N, 'reports listed; run through :report run'), 'NAV-030': (N, 'palette calls POST /search; the sample has no provider'), 'NAV-035': (P, 'Esc returns to the record or query, cursor kept'),
 'PRF-002': (P, 'server-paged grid, page = visible rows'), 'PRF-003': (P, 'server sort and filter'), 'PRF-005': (P, 'progress N/M, elapsed, 250 ms polling'),
 'PRC-001': (P, 'grid selection or record, ids sent'), 'PRC-002': (P, 'without a selection: the grid filter'), 'PRC-004': (P, ''), 'PRC-005': (P, 'Space selects, b runs a table process'),
 'PRC-007': (N, 'EDIT_FORM, BULK_EDIT_FORM, VIEW_FORM, HELP_TEXT, VALIDATION_REVIEW_SCREEN, PROCESS_SUMMARY_RESULTS'), 'PRC-008': (N, 'HELP_TEXT shown above the form'),
 'PRC-009': (P, 'includeFieldNames via the kernel runner'), 'PRC-010': (P, 'required checked by field before submit'), 'PRC-011': (P, 'picker'), 'PRC-012': (P, 'summary shows view fields'),
 'PRC-017': (P, 'kernel runner'), 'PRC-018': (P, 'kernel runner'), 'PRC-019': (P, 'bar, N/M, message, elapsed'), 'PRC-020': (N, 'Esc asks, then POST cancel; the sample keeps the run'),
 'PRC-021': (P, 'failure message shown; F5 re-runs'), 'PRC-022': (P, 'F5 or r runs again with the same records'), 'PRC-024': (P, 'step list with marks'),
 'PRC-026': (P, 'validate or skip, then run'), 'PRC-027': (P, 'summary lines colored by status'), 'PRC-028': (P, ''), 'PRC-029': (P, 'Ctrl+T marks fields; bulkEditEnabledFields'),
 'PRC-031': (X, 'bulk load parked for the TUI'), 'PRC-032': (X, 'bulk load parked for the TUI'), 'PRC-033': (X, 'bulk load parked for the TUI'), 'PRC-047': (P, ''), 'PRC-048': (P, ''), 'PRC-051': (P, 'contingent picker narrows'),
 'QRY-001': (P, ''), 'QRY-002': (P, 'PgUp/PgDn, Ctrl+F/B, Home/End across pages'), 'QRY-003': (P, 's cycles asc, desc, default'), 'QRY-004': (P, 'v: columns on/off and order, kept per table in the config file'),
 'QRY-005': (P, 'v: widths, fit or fill, zebra, density'), 'QRY-006': (P, 'Esc lands on the row last viewed, filter and page kept'), 'QRY-007': (P, 'error shown in the grid; F5 retries'),
 'QRY-010': (P, 'operators by field type in the filter dialog'), 'QRY-011': (P, ''), 'QRY-012': (P, 'date presets: now(-7d), thisPeriod(month) …'), 'QRY-015': (P, 'labels in the picker, ids sent; typed labels resolved'),
 'QRY-016': (P, 'AND/OR and groups, guided and advanced'), 'QRY-017': (N, 'the grammar and the CLI command are shown; no URL'), 'QRY-030': (N, 'Space and Ctrl+A (page)'), 'QRY-031': (P, ''), 'QRY-034': (N, 'F9 lists table processes; bulk load parked'),
 'QRY-040': (P, 'x: visible columns, filter and sort, file dialog'), 'QRY-041': (P, ''), 'QRY-050': (N, 'F9 runs saved-view list in a pane'), 'QRY-062': (P, 'F-keys hidden without permission'),
 'QRY-065': (P, ''), 'QRY-067': (P, 'g'), 'QRY-068': (P, ''), 'QRY-070': (P, 'n r f s and the F-keys; off with keyboard.singleKeyShortcuts'), 'QRY-083': (P, 'guided builder edits and removes conditions'), 'QRY-084': (P, 'sort in the builder; c clears'), 'QRY-086': (P, ''),
 'REC-001': (P, 'sections by tier, two columns when they fit'), 'REC-003': (P, 'error shown in the record pane'), 'REC-005': (P, 'local validation by field'), 'REC-006': (P, 'new record replaces the form'),
 'REC-008': (P, 'Esc asks when there are unsaved changes; F10 warns too'), 'REC-009': (P, 'only changed fields sent'), 'REC-010': (P, 'non-editable fields read-only'), 'REC-012': (P, 'F8 asks; the grid moves on to the next record'),
 'REC-013': (P, 'c: copyRecordValues'), 'REC-014': (N, 'TEXT single line with $EDITOR on Ctrl+E'), 'REC-015': (P, ''), 'REC-016': (P, 'Space toggles'), 'REC-017': (P, ''), 'REC-018': (P, 'local zone in and out (kernel datetime)'),
 'REC-021': (P, 'masked'), 'REC-028': (P, 'links marked, Enter follows (kernel record-view)'), 'REC-033': (N, 'masked; Enter reveals'), 'REC-034': (N, 'Enter saves through the file dialog; no sample field'),
 'REC-042': (N, 'F9 runs audit list in a pane'), 'REC-044': (P, ''), 'REC-045': (P, 'picker by keyboard'), 'REC-048': (P, 'fieldErrors by field'), 'REC-050': (P, ''), 'REC-051': (P, ''), 'REC-052': (P, 'contingent fields wait and narrow'), 'REC-055': (P, 'n e c d; F-keys'),
 'REL-001': (N, 'labels with links in the record view'), 'REL-002': (P, 'child lists; F9 Query all opens the filtered list'), 'REL-003': (P, 'F7 on a child list prefills the parent'), 'REL-004': (N, 'one level shown; open a child for its own'),
 'REL-005': (P, 'the parent reloads on return'), 'REL-006': (P, 'unavailable panel (kernel associationGroups)'),
 'SEC-003': (P, 'F7 hidden without insert permission'), 'SEC-004': (P, ''), 'SEC-005': (P, ''), 'SEC-020': (P, 'MOCK session, shared with the CLI keyring'), 'SEC-021': (P, 'F9 Sign out'), 'SEC-025': (N, 'device flow screen; not tried against a provider'), 'SEC-031': (P, ''), 'SEC-032': (P, 'unknown type refused with a message'),
 'INT-001': (P, 'keyboard only by design'), 'INT-002': (P, ''), 'INT-003': (P, 'modal dialogs, Esc closes'), 'INT-004': (P, ''), 'INT-007': (P, ''), 'INT-009': (P, 'loading lines'), 'INT-010': (P, 'F5 retries'), 'INT-012': (P, 'F5 and on return'), 'INT-013': (N, 'no records message; F7 offered'), 'INT-014': (P, 'sign-in screen shows the failure'),
 'WID-001': (P, ''), 'WID-002': (P, 'bars in block characters'), 'WID-004': (P, ''), 'WID-009': (P, 'sparkline and table'), 'WID-012': (P, ''), 'WID-014': (P, 'percentage bars'), 'WID-016': (P, ''), 'WID-017': (P, 'segments per dataset'),
 'WID-018': (P, ''), 'WID-019': (P, ''), 'WID-023': (P, 'big numbers, up/down'), 'WID-040': (N, 'declared order, v reorders; one column'), 'WID-051': (P, 'error contained to the widget'), 'WID-053': (P, ''), 'WID-060': (N, 'record section widgets get the id'),
 'HLP-002': (N, 'F1 shows table and field help; the sample has none'), 'HLP-005': (P, 'type in F1'),
}

# Re-scored after the Home, F9-stack, uploads, quick search, variants and process-screen work (TUI only).
TUI.update({
 'NAV-012': (N, 'app name in the title bar and Home; no logo or banners in a terminal'), 'NAV-017': (P, 'Home: greeting, counts, recents, quick actions, app cards, work'),
 'NAV-025': (N, 'palette: recents and navigation targets; no separate search page'), 'NAV-028': (N, 'reports listed in the tree, Home and palette; run through :report run'),
 'NAV-030': (N, 'palette calls POST /search when the server lists recordSearch; the sample answers provider NONE'),
 'NAV-031': (P, 'server-enforced; the palette shows only what the server returns'),
 'PRF-001': (N, 'server paging opens the first page; the column layout scrolls horizontally rather than fitting 40 columns'),
 'PRF-004': (P, 'dashboards load widgets as they come into view, 4 at a time (fake 3000-widget instance)'),
 'PRC-003': (P, 'a filter that matches nothing runs as the server decides (zero records)'), 'PRC-006': (P, 'kernel checkInputRecords before init'),
 'PRC-007': (P, 'kernel screen blocks: forms, view, records, review, summary, help, HTML, widgets, downloads'), 'PRC-008': (P, 'HELP_TEXT and its preview from the kernel screen'),
 'PRC-013': (P, 'HTML component as text from the kernel screen'), 'PRC-014': (N, 'w saves the DOWNLOAD_FORM file; no sample process offers one'),
 'PRC-015': (P, 'step and process help in the screen'), 'PRC-016': (N, 'F4 Back resolves the runner BACK; no sample process declares a back step'),
 'PRC-020': (N, 'Esc asks, then POST cancel; the sample keeps the run'), 'PRC-023': (P, 'Ctrl+S continues; the last screen closes with Enter or Esc'),
 'PRC-025': (N, 'RECORD_LIST shows the first page of records; no paging inside the step'), 'PRC-030': (P, 'Person Bulk Delete from the bulk bar runs through review and result'),
 'PRC-034': (X, 'bulk load parked for the TUI'), 'PRC-035': (N, 'named WIDGET blocks drawn from the kernel screen; no sample step uses one'),
 'PRC-036': (N, 'composite widget blocks drawn as text'), 'PRC-037': (N, 'ad hoc widget blocks drawn; no action buttons'),
 'PRC-040': (X, 'no reload in a terminal; F5 re-runs'), 'PRC-041': (P, 'a 401 shows the error; :signout and F9 sign in again'),
 'PRC-042': (P, 'hidden processes are not offered; the server refuses the rest'), 'PRC-043': (P, ':process run P -v name=value seeds the values'),
 'PRC-044': (T, 'scanner-format screens'), 'PRC-045': (P, 'the runner follows nextStep whatever the flow'), 'PRC-046': (X, 'bulk load parked for the TUI'),
 'PRC-049': (P, 'v1 process routes through the kernel'), 'PRC-050': (P, 'every process the metadata gives the table is in the bulk bar and F9'),
 'PRC-058': (X, 'bulk load parked'), 'PRC-059': (X, 'bulk load parked'), 'PRC-060': (X, 'bulk load parked'), 'PRC-061': (X, 'bulk load parked'),
 'PRC-062': (T, 'composite INPUT_FIELD editors'), 'PRC-063': (P, 'the first field has focus; behaviors trim on set'), 'PRC-064': (P, 'step DATE_TIME inputs edited in the local zone, sent as UTC (kernel datetime)'), 'PRC-066': (P, 'field behaviors via FormSession'),
 'PRC-031': (X, 'bulk load parked'), 'PRC-032': (X, 'bulk load parked'), 'PRC-033': (X, 'bulk load parked'),
 'QRY-013': (N, 'date-time criteria take expressions; typed local times are sent as typed'), 'QRY-014': (P, 'TRUE/FALSE/EQUALS on booleans, blank tests, text operators on long text'),
 'QRY-017': (N, 'the grammar and the CLI command are shown and copied; no URL'), 'QRY-018': (P, 'More operators… offers every operator'),
 'QRY-019': (P, 'q quick search ANDed onto the filter (kernel)'), 'QRY-020': (T, 'exposed joins in the grid'), 'QRY-021': (T, 'exposed joins in the grid'),
 'QRY-022': (N, 'S runs kernel column statistics; the sample has no QUERY_STATS table'), 'QRY-023': (P, 'the refusal says why'),
 'QRY-030': (N, 'Space, Ctrl+A for the page; no full-result or first-N selection'), 'QRY-032': (N, 'bulk delete on the selection; without a selection the process gets the filter'),
 'QRY-033': (T, 'first-N selection'), 'QRY-034': (N, 'F9 and b list table processes; bulk load parked'), 'QRY-035': (P, 'F-keys and entries hidden without permission; the server refuses'),
 'QRY-042': (P, 'an empty result exports an empty file; the server decides'), 'QRY-043': (P, 'server refuses; the message is shown'),
 'QRY-050': (N, 'F9 Saved views lists and opens (kernel); no sample table has saved views'), 'QRY-051': (N, 'save the current query as a view; unverified live'),
 'QRY-052': (N, 'delete from F9; no rename'), 'QRY-053': (P, 'server messages shown'), 'QRY-054': (P, 'server refuses changes'),
 'QRY-060': (P, 'the variant prompt before the first query; tableVariant on query and count (test)'), 'QRY-061': (P, 'dismissing queries nothing'),
 'QRY-063': (P, 'no write F-keys without permission'), 'QRY-064': (P, 'server refuses; shown'), 'QRY-066': (P, 'v1 variants route (kernel)'),
 'QRY-069': (P, 'counts with en-US separators'), 'QRY-071': (N, 'processes from a variant grid get tableVariant through the runner; no sample variant table'),
 'QRY-080': (T, 'basic-mode quick filters'), 'QRY-081': (T, 'quick filter fields'), 'QRY-082': (X, 'the guided builder shows every condition; no basic mode'),
 'QRY-085': (T, 'weekday criteria'), 'QRY-087': (P, 'IN takes a pasted comma list'), 'QRY-088': (T, 'bulk paste help'), 'QRY-089': (P, 'behaviors applied to typed values'),
 'QRY-090': (N, 's sorts, v hides and orders columns, F6 filters; no pinning'), 'QRY-091': (X, 'clipboard copy of column values'),
 'QRY-092': (N, 'v lists every column with on/off; no grouping or counts'), 'QRY-093': (P, 'view settings (columns, widths, sort) persist per table'),
 'QRY-094': (T, 'counted quick views'), 'QRY-095': (X, 'page size follows the terminal height'), 'QRY-096': (N, 'viewToQuery warnings flashed'),
 'REL-001': (N, 'labels with links in the record view; grid cells show labels without links'), 'REL-004': (N, 'one level shown; open a child for its own children'),
 'REL-007': (P, 'kernel associationGroups binds aliased associations to their widgets'), 'REL-008': (N, 'create child prefills every join value; composite untested live'),
 'REL-009': (P, 'server cascade; the list reloads'),
 'REC-002': (P, 'hidden fields and sections are left out; empty values blank'), 'REC-004': (X, 'one scrolling view, no tabs'), 'REC-007': (P, 'server message by field'),
 'REC-011': (P, 'the load failure shows instead of the form'), 'REC-014': (N, 'TEXT single line, $EDITOR on Ctrl+E'), 'REC-019': (N, 'kernel displayDateTime; fixed and per-record zones as the server formats them'),
 'REC-020': (N, 'HTML edited as text or in $EDITOR'), 'REC-022': (P, 'BLOB upload through the file dialog and save from the record (Field Lab, live)'),
 'REC-023': (P, 'defaults applied by FormSession and the server'), 'REC-024': (P, 'local check and server policy'), 'REC-025': (P, 'behaviors on save'), 'REC-026': (P, 'local range check and server policy'),
 'REC-027': (P, 'server message shown'), 'REC-029': (N, 'kernel valueText renders CHIP as text'), 'REC-030': (P, 'saved widths per column; SIZE as text width'),
 'REC-031': (N, 'code shown as text; $EDITOR to edit'), 'REC-032': (N, 'HTML shown as text'), 'REC-033': (P, 'masked; Enter reveals'), 'REC-034': (P, 'Enter saves through the save dialog'),
 'REC-035': (P, 'FILE_UPLOAD fields choose a file; Backspace clears'), 'REC-036': (P, 'tooltip text appended by valueText'), 'REC-037': (N, 'WIDGET adornment as text'), 'REC-038': (P, 'marked by valueText'),
 'REC-039': (N, 'F1 shows field help; no sample content'), 'REC-040': (N, 'section help via F1; no sample content'), 'REC-041': (P, 'table help in F1'),
 'REC-042': (N, 'A opens the audit history (kernel); the sample has no audit source'), 'REC-043': (N, 'kernel reads the audit table when there is no process; unverified live'),
 'REC-046': (P, 'write keys hidden without permission; server refuses'), 'REC-047': (P, 'keyboard only, labels on every field'), 'REC-049': (P, 'breadcrumb uses the table label'),
 'REC-053': (N, 'D on a grid lists the table APIs and their OpenAPI documents; the sample has none'), 'REC-054': (N, 'D on a record: panels live; scripts, versions, logs (kernel-tested)'),
 'REC-056': (X, 'hash links'), 'REC-057': (P, ':table create T --set parent=… and F7 on a child list'), 'REC-058': (X, 'phone layout'), 'REC-059': (X, 'phone layout'),
 'REC-060': (N, 'adjusters wired through FormSession; no sample adjuster'), 'REC-061': (T, 'dynamicForm widget editing'), 'REC-062': (P, 'inline enums filter locally'),
 'REC-063': (T, 'record view and forms with the grid variant'), 'REC-064': (T, 'exposed-join fields in sections'), 'REC-065': (P, 'DATE_TIME edited in local zone, unchanged instants kept'),
})

# Batch: the 13 priority todos.
TUI.update({
 'PRC-044': (P, 'scanner-format steps: no heading or step list, Enter in the input submits (unit-tested only; no sample scanner process)'),
 'QRY-094': (P, 'doCount views show their record counts in F9 Saved views (unit-tested only; no sample saved views)'),
 'QRY-020': (P, 'joined columns and filters, labelled "Join: Field", joins planned by the kernel (unit-tested only; the sample exposes no joins)'),
 'QRY-021': (P, 'many-side join: rows repeat and the status shows the distinct count (unit-tested only)'),
 'REC-064': (P, 'section fields of readable exposed joins read through a joined query (unit-tested only)'),
 'QRY-033': (P, 'run a table process on the first N records of the result (filter with a limit; unit-tested only)'),
 'QRY-080': (P, 'the filter dialog starts with the quick filter fields (defaultQuickFilterFieldNames, else T1); live on person'),
 'QRY-081': (P, 'add a quick filter field; kept per table in the local view settings'),
 'QRY-085': (B, 'weekday(field) IN days sent as the WeekdayOf fieldFunction; the sample H2 backend fails it (server finding 24, qqq#1355)'),
 'QRY-088': (P, 'paste values split on commas, tabs, semicolons, new lines; the instance bulkAddFilterValues help shown (unit-tested only; the sample has no such help)'),
 'REC-063': (P, 'records and forms opened from a variant grid read with tableVariant (unit-tested only; writes ignore it, finding 19)'),
})

# Batch: the partials.
TUI.update({
 'NAV-005': (X, 'icon glyphs are a browser icon font; the TUI marks processes and reports and shows the icon name on app cards'),
 'NAV-012': (X, 'logo, favicon and accent images are browser-only; the app name is in the title bar and on Home'),
 'NAV-025': (P, 'the palette (F2, /, ., Ctrl+K) jumps to navigation targets and recently viewed records; live'),
 'NAV-027': (P, 'F9 › Connection: UI API version, features, extensions, metadata generation and age, client build; live'),
 'NAV-030': (B, 'the palette calls POST /search; the sample lists recordSearch with no provider (server finding 21)'),
 'PRC-014': (P, 'w saves the DOWNLOAD_FORM file through the save dialog (unit-tested only)'),
 'PRC-016': (P, 'F4 goes back to the backend back step with the entered values (isStepBack; unit-tested only)'),
 'PRC-020': (B, 'Esc asks, then POST cancel; the sample accepts the cancel and keeps the run (server finding 13)'),
 'PRC-025': (P, 'RECORD_LIST pages with n / p through getProcessRecords (unit-tested only)'),
 'PRC-035': (P, 'named WIDGET fetched with the process UUID and values, drawn from the kernel screen (unit-tested only)'),
 'PRC-036': (P, 'composite widget blocks seeded from process values drawn as text (kernel screen; unit-tested only)'),
 'QRY-013': (P, 'DATE_TIME criteria typed in the local zone go out as UTC instants; expressions pass through (unit-tested)'),
 'QRY-017': (X, 'URL state is browser-only; the TUI shows the grammar and the CLI command, and qqq ui accepts the command as a route'),
 'QRY-022': (P, 'S: kernel column statistics of the column under the cursor with the filter (unit-tested only; no sample QUERY_STATS table)'),
 'QRY-030': (P, 'Ctrl+A: this page, the full result, the first N, clear (unit-tested)'),
 'QRY-032': (P, 'with the full result selected, bulk delete gets the whole filter (unit-tested)'),
 'QRY-050': (P, 'F9 › Saved views lists and opens views (kernel; unit-tested only)'),
 'QRY-051': (P, 'save the current filter, sort, columns and page size as a view (unit-tested only)'),
 'QRY-052': (P, 'rename, update with the current query, delete (unit-tested only)'),
 'QRY-071': (P, 'processes from a variant grid carry tableVariant through the runner (unit-tested only)'),
 'QRY-090': (P, 's sorts, v hides, orders, sizes and pins columns, F6 filters; live on person'),
 'QRY-092': (P, 'v: / searches, columns grouped by table and join with shown counts, * marks changes; live'),
 'QRY-096': (P, 'opening a view drops removed fields and flashes the kernel warnings (unit-tested only)'),
 'REL-001': (P, 'labels with ↗ links in the record view; l opens a grid cell\'s linked record; live'),
 'REL-004': (P, 'child lists three levels deep (a pet\'s notes under the pet); live on person 1'),
 'REL-008': (P, 'a new child through a composite association gets every join value (unit-tested only)'),
 'REC-014': (P, 'single-line text inline; multi-line through $EDITOR (Ctrl+E) round-trips'),
 'REC-019': (P, 'DATE_TIME through the kernel displayDateTime: server-zoned display values as sent, else the viewer\'s zone; live on Field Lab'),
 'REC-020': (X, 'the rich-text editor is a browser component; HTML is edited as source in $EDITOR and shown as text'),
 'REC-029': (P, 'CHIP values bracketed and colored by the adornment color (unit-tested only)'),
 'REC-031': (X, 'the code editor is a browser component; code is shown as text and edited in $EDITOR'),
 'REC-032': (P, 'RENDER_HTML shown as text with the markup stripped (kernel htmlToText)'),
 'REC-037': (P, 'a WIDGET-adorned field\'s value drawn as its widget (unit-tested only)'),
 'REC-039': (P, 'field help by screen role in F1 and in the form\'s field hint (unit-tested only)'),
 'REC-040': (P, 'section help under the section heading and in F1 (unit-tested only)'),
 'REC-042': (P, 'A: audits newest first, who, when, what, changes (unit-tested only; the sample has no audit source)'),
 'REC-043': (P, 'without the audit process the kernel reads the audit table (kernel-tested; the TUI uses it)'),
 'REC-053': (P, 'D on a grid: the table\'s APIs and their OpenAPI documents, view or save (unit-tested only)'),
 'REC-054': (P, 'D on a record: panels (live), scripts, revisions, code, logs, store a new version (unit-tested)'),
 'REC-060': (P, 'form adjusters run on change through FormSession (unit-tested only; the sample has none)'),
 'INT-013': (P, 'no records explains it and offers F7 when the user may create; live'),
 'WID-040': (P, 'widgets in declared order, laid out side by side by gridColumns on wide terminals, v reorders; live'),
 'WID-060': (P, 'record section widgets get the record id and table (unit-tested)'),
 'HLP-002': (P, 'table, field and section help by screen role in F1 (unit-tested only; the sample has none)'),
})

rows = []
for line in open(SRC, encoding='utf-8', errors='replace'):
    m = re.match(r'^\|\s*([A-Z]{3}-\d{3})\s*\|\s*(.*?)\s*\|', line)
    if m:
        rows.append((m.group(1), m.group(2)))

fam_counts = collections.defaultdict(collections.Counter)
tui_counts = collections.defaultdict(collections.Counter)
out = ['# Terminal clients parity matrix', '',
       'Generated by `scripts/parity-matrix.py` from the Next UI acceptance matrix (`qqq-frontend-next/docs/acceptance/feature-matrix.md`,',
       f'{len(rows)} rows). Same ids; two columns added. **pass** = verified against the local sample server in this repo\'s',
       'development; **partial** = works with the noted gap; **todo** = planned; **n/a** = browser-only, with the reason; **blocked** = needs a server change (the note cites the finding in docs/server-findings.md). "unit-tested" in a note: the sample has no fixture, so node tests (and stub-server CLI tests) verify it.',
       'The TUI column is `qqq ui` (M3); its notes start with "TUI:".', '']
lines = []
for rid, feature in rows:
    fam = rid[:3]
    cli, note = STATUS.get(rid, (T, ''))
    # the TUI column: browser-only rows stay n/a; everything else is M3 work
    tui = X if cli == X and (fam in ('INT', 'SEC') or 'phone' in note or 'browser' in note or 'chrome' in note or 'theme' in note or 'Google' in note or 'web-only' in note) else T
    tnote = ''
    if rid in TUI:
        tui, tnote = TUI[rid]
    fam_counts[fam][cli] += 1
    tui_counts[fam][tui] += 1
    both = note if not tnote else (f'{note}; TUI: {tnote}' if note else f'TUI: {tnote}')
    lines.append(f'| {rid} | {feature[:110].replace("|", "/")} | {cli} | {tui} | {both.replace("|", "/")} |')
out.append('## Summary (CLI column)'); out.append('')
out.append('| Family | rows | pass | todo | partial | blocked | n/a |'); out.append('|---|---|---|---|---|---|---|')
total = collections.Counter()
for fam in sorted(fam_counts):
    c = fam_counts[fam]; total.update(c)
    out.append(f'| {fam} | {sum(c.values())} | {c[P]} | {c[T]} | {c[N]} | {c[B]} | {c[X]} |')
out.append(f'| **all** | {sum(total.values())} | {total[P]} | {total[T]} | {total[N]} | {total[B]} | {total[X]} |'); out.append('')
out.append('## Summary (TUI column)'); out.append('')
out.append('| Family | rows | pass | todo | partial | blocked | n/a |'); out.append('|---|---|---|---|---|---|---|')
ttotal = collections.Counter()
for fam in sorted(tui_counts):
    c = tui_counts[fam]; ttotal.update(c)
    out.append(f'| {fam} | {sum(c.values())} | {c[P]} | {c[T]} | {c[N]} | {c[B]} | {c[X]} |')
out.append(f'| **all** | {sum(ttotal.values())} | {ttotal[P]} | {ttotal[T]} | {ttotal[N]} | {ttotal[B]} | {ttotal[X]} |'); out.append('')
out.append('## Rows'); out.append(''); out.append('| ID | Feature | CLI | TUI | Note |'); out.append('|---|---|---|---|---|')
out.extend(lines); out.append('')
open(OUT, 'w', encoding='utf-8').write('\n'.join(out))
print(f'{len(rows)} rows -> {OUT}; CLI: ' + ', '.join(f'{k} {v}' for k, v in sorted(total.items())) + '; TUI: ' + ', '.join(f'{k} {v}' for k, v in sorted(ttotal.items())))
