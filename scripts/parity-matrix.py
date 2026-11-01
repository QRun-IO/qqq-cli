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
P, T, N, X, B = 'pass', 'todo', 'partial', 'n/a', 'blocked'  # T is the default; B (blocked) notes cite a server finding
B = 'blocked'  # waits on a server finding or issue, named in the note
STATUS = {
 # NAV: the CLI has no shell; the TUI covers these in M3
 **{f'NAV-{i:03d}': (X, 'browser shell') for i in (1,2,3,4,5,12,13,14,15,16,18,19,20,21,22,26,29,32,33,34,35,36,37,38,55,56)},
 'NAV-006': (P, 'hidden tables and processes are not listed; direct use is refused by the server'),
 'NAV-007': (P, 'qqq table get on a hidden table the user may read'),
 'NAV-008': (P, 'qqq apps show <app>: sections of processes, reports, tables and child apps, then widgets'),
 'NAV-009': (P, 'qqq apps show counts each table with TABLE_COUNT (--no-counts skips)'),
 'NAV-010': (X, 'app home rendering'), 'NAV-011': (P, 'qqq apps show <app> --widgets: one labelled section per permitted declared widget, loaded once each; verified live on SampleWidgetsDashboard'),
 'NAV-017': (P, 'qqq home: counts of what you may open, quick actions (permitted processes in your apps, with the command) and one card per app; verified live'),
 'NAV-023': (P, 'qqq table get <t> --key field=value: one match shows the record, none exits 5, several exit 2'),
 'NAV-024': (P, "qqq find <text> [--type]: apps, tables, processes and reports by label with type, app and the command that opens each (the terminal's palette); verified live; shell completion covers names"),
 'NAV-025': (P, 'qqq search'), 'NAV-027': (P, 'qqq whoami: apiVersion, features, counts'),
 'NAV-028': (P, "qqq report list (with app) and apps show list reports in the app's Reports group, report run opens them; unit-tested and stub-server tested (the sample has no reports)"), 'NAV-030': (P, 'qqq search over POST /search'), 'NAV-031': (P, 'server-enforced; refusals shown'),
 # PRF
 'PRF-001': (P, '10,000 rows with --all and --page-size'), 'PRF-002': (P, '--limit/--skip paging'), 'PRF-003': (P, 'server sort and filter'),
 'PRF-004': (P, 'apps show --widgets loads every widget once, all at once, in declared order: 24 widgets (statistics, charts, 100-row tables) answering in 150 ms each finish well under 3 s; stub-server tested'), 'PRF-005': (P, 'process run polls every 500 ms and prints progress'),
 # PRC
 'PRC-001': (P, 'process run -r ids'), 'PRC-002': (P, '--filter-json'), 'PRC-003': (P, ''), 'PRC-004': (P, ''), 'PRC-005': (X, 'grid selection; use -r'),
 'PRC-006': (P, 'checked before init (filters counted); the sample declares no limits, verified by tests'), 'PRC-007': (P, 'every component in order as text (kernel screen model); bulk load forms belong to qqq bulk'),
 'PRC-008': (P, 'text with line breaks; previewText printed above it'), 'PRC-009': (P, 'includeFieldNames and values kept across steps'), 'PRC-010': (P, 'required checked locally and by the server'),
 'PRC-011': (P, 'labels or ids, prompts list choices'), 'PRC-012': (P, 'label: value on every step'), 'PRC-013': (P, '{step}.html as text (tags stripped)'), 'PRC-014': (P, 'GET /download/{file} saved to --out-dir, else the download directory; no sample process offers one, verified by tests'),
 'PRC-015': (P, 'step helpContents shown on the screen, process help at start and in describe; none in the sample'), 'PRC-016': (P, 'b at a prompt when the step reports backStep (isStepBack=true); verified live: bulk insert -i back from the mapping to the upload and from the review to the mapping'), 'PRC-017': (P, 'updatedFrontendStepList followed'), 'PRC-018': (P, 'updatedFields applied'),
 'PRC-019': (P, 'message, N/M, elapsed on stderr'), 'PRC-020': (P, 'Ctrl-C during a job or a prompt calls POST …/cancel, exit 130'), 'PRC-021': (P, 'userFacingError shown'), 'PRC-022': (X, 'retry is re-running the command'),
 'PRC-023': (X, 'screen labels'), 'PRC-024': (X, 'stepper; step names printed'), 'PRC-025': (P, 'GET …/records paged into a table, --record-limit'), 'PRC-026': (P, 'count and preview; asks validate or skip on a terminal, --validate / --skip-validation; Submit? after validation'),
 'PRC-027': (P, 'status, count, message lines'), 'PRC-028': (P, ''), 'PRC-029': (P, 'qqq table bulk-edit <t> -r ids|-w ... --set f=v --clear f (-i chooses fields): only the switched-on fields are sent (bulkEditEnabledFields), review, result; verified live on person'), 'PRC-030': (P, 'qqq table bulk-delete <t> -r ids|-w ...: review with count and preview, validation, result; asks unless --yes (exit 2 without a terminal); verified live'), 'PRC-031': (P, 'qqq table bulk-insert <t> --file x.csv: upload, column mapping (server suggestion cleaned per finding 26, --mapping document, --column/--default, -i), value mapping, review preview and validation, result; FLAT and TALL verified live'), 'PRC-032': (P, 'mapping checked before submit (unmapped field, unknown column, layout, WIDE repetition, key fields, repeated header); Back from mapping to upload and from review to mapping verified live with -i'),
 'PRC-033': (P, 'qqq table bulk-edit <t> --file x.csv --key id [--mapping]: rows matched by the key, value mapping; verified live on person'), 'PRC-034': (P, 'upload instructions printed as text; --template [flat|tall|wide] [--out] saves the data: templates; verified live'), 'PRC-035': (P, 'named widget with the process UUID and values, kernel render model; none in the sample, verified by tests'), 'PRC-036': (P, 'seeded from the process value of the widget name'), 'PRC-037': (P, 'ad hoc composite: ${} interpolation, conditional blocks left out, INPUT_FIELD blocks asked as step fields (submitOnEnter submits), BUTTON actionCodes offered as a choice (-v actionCode=…), controlCode buttons change only what shows; unit-tested (the sample has no ad hoc widget)'), 'PRC-038': (X, 'Google Drive is web-only'), 'PRC-039': (X, 'Google Drive is web-only'),
 'PRC-040': (X, 'no reload'), 'PRC-041': (P, 'UNAUTHENTICATED exits 3 with the sign-in hint'), 'PRC-042': (P, 'server-enforced'), 'PRC-043': (P, '-v values seed every step'),
 'PRC-044': (X, 'scanner screens are interactive'), 'PRC-045': (P, 'the runner follows nextStep whatever the flow'), 'PRC-046': (P, 'qqq bulk-profile list|show|save|rename|delete <t> [--edit], bulk-insert --saved <name> and --save-profile; unit-tested and stub-server CLI tests: the sample has no saved-profile processes'), 'PRC-047': (P, 'completes on init'),
 'PRC-048': (P, 'searchProcessPossibleValues'), 'PRC-049': (P, 'v1 routes only'), 'PRC-050': (X, 'Material-specific'), 'PRC-051': (P, 'dependent choices narrow after each answer'),
 'PRC-058': (P, 'bulk-profile save --replace prints the changes and asks (--yes), rename, delete; stub-server CLI tests (the sample has no saved-profile processes)'), 'PRC-059': (P, 'profiles listed as yours, then shared by their owner; save over, rename and delete refused for a profile you do not own; stub-server CLI tests'), 'PRC-060': (P, "-i lists columns with preview values and the step's field help, asks for the header row (--no-header), warns on repeated headers (only the first is read); header toggle and previews verified live, help and repeated headers unit-tested"), 'PRC-061': (P, 'defaults typed per field (--default f=label resolves possible values; yes/no booleans), value mapping by label or id with choices listed, -i add-fields list grouped by table; verified live (Dog/Cat to species ids, yes/no to booleans)'), 'PRC-062': (X, 'composite editors'), 'PRC-063': (X, ''), 'PRC-064': (P, 'process values typed local, sent UTC; screens show the local zone'), 'PRC-065': (X, 'Google Drive'), 'PRC-066': (P, 'field behaviors applied before submit'),
 # QRY
 'QRY-001': (P, 'default order by primary key'), 'QRY-002': (P, '--limit, --skip, --all'), 'QRY-003': (P, '--order, -field for descending'), 'QRY-004': (P, 'qqq table columns <t> [fields…|--reset]: kept per table in the config the TUI column chooser uses; table query defaults to them, --fields wins; verified live'),
 'QRY-005': (X, 'grid presentation'), 'QRY-006': (X, ''), 'QRY-007': (P, 'error with code, status and trace id'), 'QRY-010': (P, 'all operators and shorthand; text matches (~, CONTAINS, STARTS_WITH, …) carry CASE_INSENSITIVE by default, ~= / OPERATOR:CS / --case-sensitive match case (finding 11 is by design; the v1 route drops the option until finding 27, qqq#1358)'), 'QRY-011': (P, 'BETWEEN, IN lists'),
 'QRY-012': (P, 'now(), now(-7d), thisPeriod(), startOf()'), 'QRY-013': (P, '--where/--group DATE_TIME values local to UTC (a date is local midnight); expressions as before'), 'QRY-014': (P, 'IS_BLANK, TRUE, FALSE'), 'QRY-015': (P, 'labels in --where/--group for possible-value fields resolved to ids (speciesId = Cat sends 2; unknown or ambiguous labels exit 2 with the choices); verified live'),
 'QRY-016': (P, '--group with parentheses'), 'QRY-017': (P, '--print-filter gives the JSON the web links accept'), 'QRY-018': (P, 'any operator in --where'), 'QRY-019': (P, '--search on query, count and export: CONTAINS over the shown text fields, ORed, ANDed with the filter; sent with CASE_INSENSITIVE (--case-sensitive to match case; the v1 route drops the option until finding 27, qqq#1358)'),
 'QRY-020': (P, '--join and table.field in --fields/--where/--order, labelled "Join: Field"; verified live through an association join (person to pet); exposed joins unit-tested (the sample exposes none)'), 'QRY-021': (P, 'a many-side join repeats rows; count and --count add the distinct count (person --join pet: 21 rows, 16 distinct)'), 'QRY-022': (P, 'qqq table stats <t> <field> [-w …] through the columnStats process when offered (unit-tested; the sample has neither QUERY_STATS nor the process); --local computes the same figures and was verified live'), 'QRY-023': (P, 'without QUERY_STATS (or the process) table stats exits 2 with the reason; --local is an explicit opt-in'), 'QRY-030': (P, '-r ids, --filter-json, --limit'), 'QRY-031': (P, 'table bulk-edit -r ids; verified live'), 'QRY-032': (P, 'table bulk-delete -w ... (or --filter-json, --all-records) sends the whole filter; verified live'),
 'QRY-033': (P, 'process run --filter-json with limit'), 'QRY-034': (P, 'qqq table actions <t>: bulk load, bulk edit/delete and the table processes with the command for each; verified live'), 'QRY-035': (P, 'server refuses; exit 3'), 'QRY-040': (P, 'table export: filtered (--where, --group, --search), sorted (--order), --fields in column order, --limit, --out -'), 'QRY-041': (P, 'csv, xlsx, json, tsv; format from --out extension; --no-header; bad format or field exit 2 before the request'),
 'QRY-042': (X, 'nothing to disable'), 'QRY-043': (P, 'server refuses'), 'QRY-050': (P, 'qqq saved-view list <t>, open <t> <view>, table query --view; unit-tested and stub-server tested (the sample has no saved views)'), 'QRY-051': (P, 'saved-view save --name: filter, sort, columns and page size as the Material RecordQueryView; unit-tested and stub-server tested'), 'QRY-052': (P, 'saved-view save --replace, rename, delete (asks; --yes); unit-tested and stub-server tested'), 'QRY-053': (P, 'a name in use is refused before any change; an unknown view exits 2 with the list; unit-tested and stub-server tested'), 'QRY-054': (P, 'views shared with you are listed as shared by their owner; changes to them are refused by the server, its message shown; unit-tested and stub-server tested'),
 'QRY-060': (P, '--variant on query, count, get, copy, export, writes and process run; a terminal asks; the chosen variant is remembered per server and table (--variant - forgets it); stub-server tested (the sample has no variant table)'), 'QRY-061': (P, 'no --variant, none remembered and no terminal (or no answer): exit 2, nothing queried; stub-server tested'), 'QRY-062': (P, 'describe shows capabilities; server refuses'), 'QRY-063': (P, 'server refuses writes'), 'QRY-064': (P, ''), 'QRY-065': (P, 'POST /table/{t}/export'),
 'QRY-066': (P, 'GET /table/{t}/variants (called live; the sample lists none; the listing is stub-server tested)'), 'QRY-067': (P, 'table get --key; the primary key and Material gotoFieldNames are the declared keys, other fields looked up with a note'), 'QRY-068': (P, 'default columns follow sections by tier'), 'QRY-069': (X, 'locale formatting'), 'QRY-070': (X, 'shortcuts'), 'QRY-071': (P, 'process run --variant (or the remembered one): tableVariant on init, every step and status; sent live, unit-tested (no variant table to observe)'),
 'QRY-080': (X, 'quick filters UI'), 'QRY-081': (X, ''), 'QRY-082': (X, ''), 'QRY-083': (X, ''), 'QRY-084': (X, ''), 'QRY-085': (B, "weekday(field) IN 1,7 sends the WeekdayOfDate fieldFunction with ISO weekdays (--print-filter); the sample's H2 backend answers 500 (server finding 24, qqq#1355)"), 'QRY-086': (P, 'expressions'), 'QRY-087': (P, 'IN lists; quoted values'), 'QRY-088': (X, ''), 'QRY-089': (P, 'behaviors'),
 **{f'QRY-{i:03d}': (X, 'saved views and column UI') for i in (90,91,92,93,94,95,96)}, **{f'QRY-{i:03d}': (X, 'phone layout') for i in (8,9,24,36,55)},
 # REL
 'REL-001': (P, 'display values; table get shows the target (Avery Sample → person 1), --links lists them, --follow opens one'), 'REL-002': (P, 'table get --associations lists exactly the record\'s children; table children pages a list with its count (View All)'), 'REL-003': (P, 'table create <child> --parent table=pk; table get --associations shows it at once'), 'REL-004': (P, 'person > pets > notes: each pet lists only its own notes'), 'REL-005': (P, 'records are never cached: update or delete a child, the next get/children shows the current rows'), 'REL-006': (P, 'unreadable child tables shown as unavailable without data or actions; table children shows the server message; unit-tested (the sample has no denied child table, finding 17)'), 'REL-007': (P, 'aliased and composite associations bound to their widget sections, members by every join value; unit-tested (the sample declares none, finding 17)'), 'REL-008': (P, 'table create --parent sets every join value of a composite association; unit-tested (the sample declares none)'), 'REL-009': (P, 'table delete of a parent: its pets are gone, other parents keep theirs'),
 # REC
 'REC-001': (P, 'table get by section and tier'), 'REC-002': (P, 'empty values show --; hidden sections and fields never shown; unit-tested (the sample has none, finding 17)'), 'REC-003': (P, 'exit 5'), 'REC-004': (X, 'tabs'), 'REC-005': (P, 'validated locally before any request'), 'REC-006': (P, ''), 'REC-007': (P, ''), 'REC-008': (X, 'guard'),
 'REC-009': (P, 'update sends only changed fields'), 'REC-010': (P, 'non-editable fields excluded'), 'REC-011': (P, ''), 'REC-012': (P, 'confirm unless --yes'), 'REC-013': (P, 'qqq table copy <t> <pk> [--set f=v] [-i] [--dry-run]: primary key, non-editable and file fields dropped'), 'REC-014': (P, ''), 'REC-015': (P, ''), 'REC-016': (P, 'defaults applied'),
 'REC-017': (P, ''), 'REC-018': (P, 'typed and shown in TZ, stored UTC, --utc for raw; DST edges tested'), 'REC-019': (X, 'display zones'), 'REC-020': (P, 'HTML fields shown as text (sanitized); table update -e <field> edits the HTML source in $VISUAL/$EDITOR; verified live on fieldLab htmlValue'), 'REC-021': (P, 'server masks'), 'REC-022': (P, 'table create/update --upload and table download (base64 BLOB value) verified on fieldLab; default name into the download directory'), 'REC-023': (P, 'server'),
 'REC-024': (P, 'maxLength checked locally'), 'REC-025': (P, 'behaviors'), 'REC-026': (P, 'ranges checked locally'), 'REC-027': (P, 'server message'), 'REC-028': (P, 'record links name table and key, --follow opens them; URL links show the URL'), 'REC-029': (P, 'CHIP as [value] colored by color.<value> (or colorMap) on a terminal, icon named in the record view; unit-tested (none in the sample)'), 'REC-030': (X, ''), 'REC-031': (P, "CODE_EDITOR values shown verbatim; table update -e <field> opens the code in $EDITOR with the language's extension; unit-tested (none in the sample; -e verified live on an HTML field)"), 'REC-032': (P, 'RENDER_HTML shown as sanitized text; unit-tested (none in the sample)'),
 'REC-033': (P, 'REVEAL masked in the record view, query and child lists until --reveal; table get --copy <field> copies the value (pbcopy/clip/wl-copy/xclip, else OSC 52); masking unit-tested, --copy verified live'), 'REC-034': (P, 'FILE_DOWNLOAD shows the file name and qqq table download saves it through the field route; unit-tested (none in the sample); BLOB values without the adornment are decoded locally (server finding 16)'), 'REC-035': (P, "create/update --upload field=path replaces the file, --set field= removes it (verified live on a BLOB); FILE_UPLOAD's format (button or drag and drop) is presentation only"), 'REC-036': (P, 'tooltip text in parentheses after the value; unit-tested (none in the sample)'), 'REC-037': (P, "the value rendered through the named widget's render model; unit-tested (none in the sample)"), 'REC-038': (P, 'ERROR values marked with !; unit-tested (none in the sample)'), 'REC-039': (P, 'table get --help-content: field help by view-screen role, HTML/MARKDOWN as text; qqq help show lists help alone; unit-tested (the sample has no help, finding 17)'), 'REC-040': (P, 'section help under the section with --help-content; unit-tested (finding 17)'), 'REC-041': (P, 'table helpContent and helpContents slots printed with --help-content; unit-tested (finding 17)'), 'REC-042': (P, 'qqq audit list <t> <pk> [--asc]: newest first with field changes; node tests and a stub server (the sample audits no table)'), 'REC-043': (P, 'without the audit process the audit table is read with its auditTable and auditDetail joins; node tests'),
 'REC-044': (P, 'recordLabel'), 'REC-045': (P, 'labels resolved, defaults looked up'), 'REC-046': (P, 'server'), 'REC-047': (X, ''), 'REC-048': (P, 'fieldErrors by field'), 'REC-049': (X, ''), 'REC-050': (P, ''), 'REC-051': (P, ''), 'REC-052': (P, 'contingent fields'),
 'REC-053': (P, 'qqq table apis <t>, api-doc <t> <api> <version> (saved as JSON), api-call <t> <api> <version> <method> [path] (the playground: sends the request with your session, prints status and answer); none in the sample (verified: none listed), api-call stub-server tested'), 'REC-054': (P, 'qqq script list|show [--revision]|store --file/--editor|test -v input=…|logs, and table developer <t> <pk> (panels verified live on person 1); scripts and test runs stub-server tested (the sample has no associated scripts or testScript process)'), 'REC-055': (X, ''), 'REC-056': (X, ''), 'REC-057': (X, ''), 'REC-058': (X, ''), 'REC-059': (X, ''), 'REC-060': (P, 'form adjusters (onLoad, onChange) and field behaviors run through the kernel FormSession for create, update and copy; unit-tested (the sample declares none)'), 'REC-061': (P, "qqq table widget-form <t> <pk> <widget> --set|-i: the dynamicForm's fields validated (required) and saved in its merged JSON field (or as record fields); stub-server tested (the sample has no dynamicForm)"), 'REC-062': (P, 'inline enums'), 'REC-063': (B, 'get, copy and update -i read with --variant; the v1 insert, update and delete routes ignore it (server finding 19, qqq#1351)'), 'REC-064': (P, 'table get --join adds joined fields (queryJoins); verified live through an association join; exposed-join sections unit-tested'), 'REC-065': (P, 'an unchanged wall-clock time keeps the original instant and its precision'),
 # SEC
 'SEC-001': (P, ''), 'SEC-002': (P, 'a DISABLED table (permissions false in the metadata) is listed by table list with the reason; query, get, create, edit, delete, export and bulk commands refuse with it (exit 3) before any request; stub-server tested (the sample has no DISABLED table)'), 'SEC-003': (P, ''), 'SEC-004': (P, ''), 'SEC-005': (P, ''), 'SEC-006': (P, 'table copy needs insert permission: refused with the reason (exit 3) before reading the record; stub-server tested'), 'SEC-007': (P, ''), 'SEC-008': (P, 'a DISABLED process (hasPermission false) is listed by process list and table actions with the reason; process run refuses (exit 3) before init; stub-server tested'), 'SEC-009': (P, 'widget get shows the refusal'), 'SEC-010': (P, ''),
 'SEC-011': (P, "server-enforced: saved views (and bulk load profiles) are listed as the server returns them, yours first, others as shared by their owner; changing someone else's is refused locally or by the server; stub-server tested"), 'SEC-012': (P, 'server'), 'SEC-013': (P, 'server'), 'SEC-014': (P, ''), 'SEC-015': (P, ''), 'SEC-020': (P, 'qqq login on a MOCK server'), 'SEC-021': (P, 'qqq logout calls POST /logout'), 'SEC-022': (P, 'exit 3 with the sign-in hint'),
 'SEC-023': (P, ''), 'SEC-024': (X, ''), 'SEC-025': (P, 'device flow and --browser (code + PKCE, loopback) verified against a sample on OAUTH2 with qqq-dev-idp'), 'SEC-026': (P, 'denial, forged state and a refused code exchange exit 3 and save nothing; the token is checked against the server first'), 'SEC-027': (P, 'logout --provider-logout: refresh token revoked (RFC 7009), end-session URL opened; bearer sign-ins have no server session'), 'SEC-028': (P, 'a refresh the provider refuses exits 3 with sign in again; refresh before expiry verified'), 'SEC-029': (B, 'qqq login on an AUTH_0 server: tenant from values.baseUrl, values.nativeClientId (else clientId), the audience sent so the token is a JWT; device flow and --browser (PKCE) unit-tested; no AUTH_0 server to run against: the sample configures only OAUTH2 (server finding 28, qqq#1359)'), 'SEC-030': (B, 'same sign-in as SEC-029; a real Auth0 tenant needs tenant credentials from James (qqq-cli#10; server finding 28, qqq#1359)'), 'SEC-031': (P, ''), 'SEC-032': (P, 'unknown type refused'),
 'SEC-033': (X, ''), 'SEC-034': (P, "qqq login --username (password asked, or QQQ_PASSWORD): HTTP Basic once, the server's sessionId cookie kept, never the password; stub-server tested (the sample uses MOCK, so it cannot exercise TABLE_BASED; finding 8 is the missing manageSession recipe)"), 'SEC-035': (P, "a wrong password or unknown user: one message (the server's), exit 3, nothing stored; stub-server tested"), 'SEC-036': (P, "an expired or idle session answers 401: exit 3 with 'Sign in again with qqq login'; stub-server tested"), 'SEC-037': (P, 'qqq logout calls POST /qqq/v1/logout with the sessionId cookie and forgets the sign-in; later commands are unauthenticated; stub-server tested'), **{f'SEC-{i:03d}': (X, 'browser security') for i in (38,39,40,41,42,43,44,48,49,50)},
 # INT
 **{f'INT-{i:03d}': (X, 'browser accessibility and layout') for i in (1,2,3,4,5,6,8,9,11)}, 'INT-007': (P, 'field named in every message'), 'INT-010': (P, 'exit 4 and a message; rerun'), 'INT-012': (P, 'no client cache of records'), 'INT-013': (P, '(no records)'), 'INT-014': (P, 'cannot reach the server'),
 # WID
 **{f'WID-{i:03d}': (P, 'rendered as text') for i in (1,2,3,4,5,7,8,9,10,13,14,16,17,18,19,23,24,46,51,54,59,61)},
 'WID-006': (P, 'generic: its html as text, plus label, sublabel and footer; unit-tested (none in the sample)'), 'WID-011': (P, 'location: image link, title, description, address and footer text; unit-tested (none in the sample)'), 'WID-012': (P, 'multiStatistics: groups with icon, header and subheader, statisticList values with separators (links shown); verified live on SampleMultiStatisticsWidget'), 'WID-015': (P, 'prints the URL'), 'WID-020': (P, "usaMap: each marker with name and coordinates as a table, 'No locations to show' when none; unit-tested"), 'WID-021': (P, "a process widget names its process; widget get --run runs it here with the widget's default values; stub-server tested (no process widget in the sample)"), 'WID-022': (P, 'parentWidget: children loaded and shown in order, each sized n/12 (gridColumns; TABS as tab headings); unit-tested'),
 'WID-025': (X, 'customComponent is web-only'), **{f'WID-{i:03d}': (T, 'developer and editor widgets') for i in (26,27,28,29,30,31,32,70,71,72,73,74,75)}, 'WID-033': (X, 'QuickSight'), 'WID-040': (P, 'apps show --widgets: app widgets in declared order, each marked with its width in twelfths (gridColumns); verified live'), 'WID-041': (P, "chrome: a card widget's title framed (== label ==), plain (isCard=false) without; sublabel; payload or metadata footer HTML as text; unit-tested and verified live"),
 **{f'WID-{i:03d}': (X, 'card chrome') for i in (42,43,44,45,55,58,62,64,65)}, 'WID-047': (P, '--input name=value'), 'WID-048': (P, '--input'), 'WID-049': (P, "a widget waiting for a required dropdown shows the server's dropdownNeedsSelectedText in place of its body; selections given with --input name=id; unit-tested"), 'WID-050': (X, ''), 'WID-052': (P, "every display type shows the web's empty state (No rows found, No chart data available, No statistics available, …); unit-tested"), 'WID-053': (P, 'unknown shapes shown raw'),
 'WID-056': (P, 'parent widgets skip unknown and denied (hasPermission false) children without a request and say which; unit-tested'), 'WID-057': (P, 'composite: TEXT (icons, alert/banner), NUMBER_ICON_BADGE, UP_OR_DOWN_NUMBER, TABLE_SUB_ROW_DETAIL_ROW, PROGRESS_BAR, DIVIDER, BIG_NUMBER, INPUT_FIELD, BUTTON, AUDIO, IMAGE, ICON, nested COMPOSITE, tooltips; unit-tested, BIG_NUMBER and UP_OR_DOWN verified live'), 'WID-060': (P, '--input id=…'), 'WID-063': (P, ''), 'WID-066': (P, ''), 'WID-067': (P, 'a payload that is one leaf block renders that block; unit-tested'), 'WID-068': (P, 'table extras: hidden columns dropped, numbers with separators, html, htmlAndTooltip, image cells, composite cells, sub-rows, sticky last (totals) row, link and noRowsFoundHTML; unit-tested, sticky row verified live on SampleTableWidget'), 'WID-069': (X, 'theme colors'),
 # RPT
 'RPT-001': (P, "report run <r>: through the report's process (reportName, reportFormat), the file from GET /download saved (--out-dir); stub-server tested (the sample has no reports)"), 'RPT-002': (P, 'report run --format xlsx: the same process, the XLSX file as the server writes it; stub-server tested'), 'RPT-003': (P, 'report run --format json: the same process, the JSON file; stub-server tested (format path shared with csv/xlsx)'), 'RPT-004': (P, "SUMMARY reports: the server's grouped rows with counts and totals saved as sent (process or report route); stub-server tested"), 'RPT-005': (P, 'PIVOT reports: the server writes the native XLSX pivot; the CLI saves the file unchanged; stub-server tested'), 'RPT-006': (P, 'report input fields asked on a terminal or given with -v; a missing required one exits 2 naming it before the report runs; the value is sent to the step; stub-server tested'), 'RPT-007': (P, 'server'), 'RPT-008': (P, 'reports listed by report list and under their app in apps show; report run opens them; stub-server tested'),
 **{f'RPT-{i:03d}': (T, 'saved reports, schedules, sharing') for i in (9,10,11,12,13,14,15,16,17,18,19)}, 'RPT-020': (P, 'report files come from GET /download (process reports) or GET /reports/{name} (route); stub-server tested'),
 # HLP
 'HLP-001': (P, 'qqq help show app|widget|instance; unit-tested (the sample carries no help content, finding 17)'), 'HLP-002': (P, 'qqq help show table <t> [field]: table, section and field help; unit-tested (finding 17)'), 'HLP-003': (P, 'field help is the column help; table action help slots printed with their slot name; unit-tested (finding 17)'), 'HLP-004': (P, 'qqq help show process <p>: process, step, HELP_TEXT and step field help; unit-tested (finding 17)'), 'HLP-005': (P, 'qqq help-search'),
 'QRY-093': (X, 'no screen state to keep: views are opened by name'), 'QRY-094': (P, 'saved-view list counts quick views with doCount (--counts counts all); unit-tested (no sample saved views)'), 'QRY-096': (P, "opening a view drops removed fields with Material's warnings on stderr; unit-tested (no sample saved views)"), 'HLP-006': (X, 'author affordance'),
 'WID-026': (P, "cronUI: the record's cron expression, the payload's description and the time zone (widget get --record t=pk); 'No schedule set'; unit-tested"),
 'WID-027': (P, 'dynamicForm: labeled values (display values first, or the merged JSON field); noFieldsMessage; unit-tested'),
 'WID-028': (P, "dataBagViewer: the bag's versions newest first (current marked) and the current version's data as JSON; unit-tested"),
 'WID-029': (P, "qqq saved-report show prints the pivot definition (rows, columns, 'Sum of Total'); saved-report pivot sets it (--rows/--columns/--values FUNCTION:field) or --clear clears it; stub-server tested"),
 'WID-030': (P, 'qqq saved-report show: filter (match all/any), sort and visible columns as the setup widget words them; stub-server tested'),
 'WID-031': (P, 'rowBuilder without association binding: its rows read-only in a table (declared fields, display values); unit-tested'),
 'WID-032': (P, "scriptViewer: the script's revisions (current marked) and the current revision's files; unit-tested"),
 'WID-070': (P, 'qqq saved-report set: filter and sort (--where/--group/--order, ${variable.x} filter variables), visible columns (--columns), name; written to queryFilterJson/columnsJson as the setup does; stub-server tested'),
 'WID-071': (P, 'a process field drawn by a filterAndColumnsSetup widget takes the filter grammar (-v field="a = 1 AND b > 2") and writes its QueryFilter JSON; stub-server tested'),
 'WID-072': (P, 'qqq saved-report preview --api-path/--api-version queries and counts through the application API, as API-versioned setups preview; stub-server tested'),
 'WID-073': (P, 'qqq saved-report preview pages, sorts and counts on the server (-l, --skip, -o); columns fit their content (dragging widths is a browser grid control); stub-server tested'),
 'WID-074': (X, 'standalone composite controls are browser input editors (caret, IME, widths) whose drafts stay on the page; the CLI shows the controls and their values (WID-057), and process-hosted inputs go through the form session (PRC-037)'),
 'WID-075': (P, 'a seeded DATE_TIME input block is shown in the local zone with its seconds (kernel displayDateTime); unit-tested'),
 'RPT-009': (P, 'qqq saved-report show: filter, sort, columns and pivot setup; stub-server tested'),
 'RPT-010': (P, 'qqq saved-report run <r> [--format]: renderSavedReport with the record, the file downloaded; stub-server tested'),
 'RPT-011': (P, 'report run on a report without a process (or --route) streams from GET /reports/{name}; stub-server tested'),
 'RPT-012': (P, "qqq saved-report schedule <r> --cron --time-zone --to [--format]; saved-report schedules lists them with the server's cron description; stub-server tested"),
 'RPT-013': (P, 'qqq share add savedReport <id> user:<id> --scope read-only (insertSharedRecord); stub-server tested'),
 'RPT-014': (P, 'qqq share scope savedReport <id> <share> read-write (editSharedRecord); stub-server tested'),
 'RPT-015': (P, 'qqq share remove savedReport <id> <share> (asks; --yes); stub-server tested'),
 'RPT-016': (P, 'server-enforced record security: saved-report list shows only what the server returns (yours, shared with you); stub-server tested'),
 'RPT-017': (P, "only the owner may share: the server's refusal shown (exit 2); stub-server tested"),
 'RPT-018': (P, 'qqq share … savedView <id>: the same sharing processes for saved views; stub-server tested with saved reports'),
 'RPT-019': (P, "the render step shows only its fields (kernel screen model); a step without fields shows no 'no fields' message; unit-tested"),
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

# Batch: the bulk wizard (kernel runBulkProcess) and reports.
TUI.update({
 'QRY-034': (P, 'a lists bulk insert, bulk edit with a file, bulk edit, bulk delete, the template and the table processes, with each CLI command; live'),
 'QRY-031': (P, 'bulk edit on the checked records sends their ids; live: 2 person records edited and verified'),
 'QRY-032': (P, 'bulk delete of the selected/full result sends the filter; live: 2 person records deleted'),
 'PRC-016': (P, 'F4 goes back to the backend back step (process screen and bulk wizard); live'),
 'PRC-029': (P, 'bulk edit: Space switches fields on, Enter sets typed values (picker, yes/no), review, result; live on person'),
 'PRC-030': (P, 'bulk delete: review with count and preview, validation choice, confirm, result; live on person'),
 'PRC-031': (P, 'bulk insert: file navigator upload, column mapping grid, value mapping, review preview, result; live: 2 person rows from CSV (then deleted)'),
 'PRC-032': (P, 'mapping checked before Ctrl+S (kernel checkMapping), F4 back through mapping and upload (unit-tested only)'),
 'PRC-033': (P, 'bulk edit with a file: key fields (k) from the server, mapping, review, result (unit-tested only)'),
 'PRC-034': (P, 'a: save the bulk insert template file(s) from the upload instructions; live on person (3 templates)'),
 'PRC-046': (P, 'P on the mapping screen: use, save, update, delete saved profiles (unit-tested only; the sample has none)'),
 'PRC-058': (P, 'update a saved profile after a confirm listing the changes (kernel diffMappings), new profile, delete (unit-tested only)'),
 'PRC-059': (P, 'profiles listed as yours or shared by their owner; update and delete only for the owner (unit-tested only)'),
 'PRC-060': (P, 'mapping grid: field help of the row, column previews, required marks, repeated-header warnings, header row toggle h; live'),
 'PRC-061': (P, 'typed defaults (picker for possible values, yes/no), searchable value mapping picker, searchable field source menu (unit-tested)'),
 'NAV-028': (P, 'reports listed under their app and in the tree, palette and F9; Enter runs one (format chosen, process screens, file saved) (unit-tested only; the sample has no reports)'),
 'RPT-008': (P, 'reports appear in app navigation and run from there (unit-tested only)'),
 'RPT-011': (P, 'a report without a process streams from GET /reports/{name}?format= into the save dialog (unit-tested only)'),
 'RPT-020': (P, 'report files download from the report route and the process DOWNLOAD_FORM (unit-tested only)'),
})

# Batch: widgets, saved reports, sharing, sign-in, permissions, help, the large table.
TUI.update({
 'PRF-001': (P, 'fake big server 10,000 rows x 40 columns at 160x45 (scripts/perf-large-table.sh): first page 95-100 ms with col 1/40, End to record 10,000 in 39-45 ms, to column 40 in 343-364 ms; budget 2,000 ms per step'),
 'PRC-037': (P, 'ad hoc composite widgets: interpolation, conditional blocks hidden, INPUT_FIELD inputs (Enter submits when asked), BUTTON actionCode sent with the step (unit-tested only)'),
 'PRC-062': (P, 'composite INPUT_FIELD editors are step fields: required checks before sending, a BLOB input goes as a multipart file (unit-tested only)'),
 'REC-061': (P, 'record view: a dynamicForm widget section has "Edit these fields": FormEditor editors, required checked, saved into the named JSON field or record fields (unit-tested only)'),
 'SEC-001': (P, 'a hidden table is not in the metadata: absent from the tree, palette and index; a direct :table query names no such table and loads nothing (unit-tested only)'),
 'SEC-002': (P, 'a disabled table (hasPermission false) is listed with "(no access)"; opening it explains the denial and requests nothing (unit-tested only)'),
 'SEC-006': (P, 'copy disabled with the reason without insert permission; c and :table copy are refused (unit-tested only)'),
 'SEC-007': (P, 'a hidden process is not offered (tree, palette, actions) and :process run names no such process (unit-tested only)'),
 'SEC-008': (P, 'a disabled process is listed "(no access)" and refused with the reason; table actions show it disabled (unit-tested only)'),
 'SEC-009': (P, 'hidden widgets are absent; a disabled widget shows the permission state without a request; children of a parent skip denied ones (unit-tested only)'),
 'SEC-010': (P, 'hidden apps are absent and unknown by name; a disabled app explains the denial (unit-tested only)'),
 'SEC-011': (P, 'saved views and reports: the TUI lists what the server returns; sharing through the share dialog; a refused direct link shows the server message (unit-tested only)'),
 'SEC-012': (P, 'record security is server-side: grids show the server\'s rows; a record the server refuses shows its message (403) (unit-tested only)'),
 'SEC-013': (P, 'hidden fields never shown (grid, record, form); PASSWORD values masked; edits send only changed fields, never the masked value (unit-tested only)'),
 'SEC-014': (P, 'without TABLE_INSERT/UPDATE/DELETE capabilities the F-keys, menu entries and copy are off and n/e/d are refused (unit-tested only)'),
 'SEC-015': (P, 'a save refused mid-session keeps the form with what was typed and shows the server message (unit-tested only)'),
 'SEC-022': (P, 'a 401 mid-use opens sign-in on top of the screens; after signing in the same screen is back and refreshed (unit-tested only)'),
 'SEC-023': (P, 'a refused sign-in (TABLE_BASED 401) shows the reason, stores nothing, no anonymous fallback (unit-tested only)'),
 'SEC-025': (P, 'OAUTH2 sign-in in the browser: discovery, S256 PKCE authorize address shown, loopback callback, code exchanged with the verifier; device flow as the alternative (unit-tested only)'),
 'SEC-026': (P, 'tampered state, provider denial and a refused code exchange are reported and store nothing (unit-tested only)'),
 'SEC-027': (P, 'sign out: here, or also revoke the refresh token and open the provider end-session address (unit-tested only)'),
 'SEC-028': (P, 'a 401 after the refresh opens sign-in (browser or device) on top and returns to the refreshed screen (unit-tested only)'),
 'SEC-029': (P, 'AUTH_0: authorize at baseUrl with the audience (PKCE), code exchanged at /oauth/token, the token handed to manageSession, the session kept; sign-out offers v2/logout (unit-tested only)'),
 'SEC-034': (P, 'TABLE_BASED: username then password (masked) under the app name, POST manageSession with Basic credentials, the session cookie kept, the password never stored (unit-tested only)'),
 'SEC-035': (P, 'a wrong password or unknown user: one message, no session stored, Enter tries again (unit-tested only)'),
 'SEC-036': (P, 'an expired session gets a 401: sign-in on top, then back to the refreshed screen (unit-tested only)'),
 'SEC-037': (P, 'sign out sends POST /logout with the session cookie, forgets the sign-in and shows sign-in (unit-tested only)'),
 'WID-003': (P, 'a payload with chartData and no type is drawn as a bar chart (unit-tested only)'),
 'WID-005': (P, 'fieldValueList: labels, display values, prefix icon marks, indentation; empty state (unit-tested only)'),
 'WID-006': (P, 'generic widget: label, sublabel, text from HTML, footer (unit-tested only)'),
 'WID-007': (P, 'horizontal bars around a zero axis: negative values left, positive right; live structure in the fake dashboard (unit-tested only)'),
 'WID-008': (P, 'html widget as text: tags and scripts dropped, links kept as text (unit-tested only)'),
 'WID-010': (P, 'smallLineChart: title, HTML description as the subtitle, sparkline (unit-tested only)'),
 'WID-011': (P, 'location: image address, title, description, address, footer (unit-tested only)'),
 'WID-013': (P, 'multiTable: each table with its label and rows (unit-tested only)'),
 'WID-015': (X, 'embedding the QuickSight dashboard needs a browser frame; the TUI shows its address to open'),
 'WID-020': (P, 'usaMap: each marker with name and coordinates in a table, the count; the map itself is browser-only (unit-tested only)'),
 'WID-021': (P, 'process widget: Enter runs its process in the process screen with the payload default values (unit-tested only)'),
 'WID-022': (P, 'parent widget: children loaded with the parent\'s selections, stacked (tabs layout: one tab at a time, switch from the menu) (unit-tested only)'),
 'WID-024': (P, 'childRecordList without an association: its rows and count from the payload (unit-tested only)'),
 'WID-026': (P, 'cronUI: the record\'s cron expression, the server description, the time zone; "No schedule set" (unit-tested only)'),
 'WID-027': (P, 'dynamicForm: labeled values, required marks, the no-fields message (unit-tested only)'),
 'WID-028': (P, 'dataBagViewer: versions newest first (sequence, message, when, author) and the chosen version\'s contents pretty-printed (unit-tested only)'),
 'WID-029': (P, 'pivotTableSetup: rows, columns, values shown; add rows/columns/values from the report columns; clear (unit-tested only)'),
 'WID-030': (P, 'filterAndColumnsSetup: table, filter, sort and visible columns of the saved report (unit-tested only)'),
 'WID-070': (P, 'edit the report filter and sort in the TUI filter dialog and the columns in a chooser; saved to the record (unit-tested only)'),
 'WID-071': (P, 'a WIDGET-adorned process field with a filter setup: Enter opens the filter dialog for the form\'s table and writes the filter JSON (unit-tested only)'),
 'WID-072': (P, 'API-versioned setup: fields from the application API metadata, preview rows and count through its query (unit-tested only)'),
 'WID-073': (P, 'Preview opens the report filter in the full grid (server paging, sort, view settings) (unit-tested only)'),
 'WID-031': (P, 'rowBuilder without an association: rows read-only as a table (unit-tested only)'),
 'WID-032': (P, 'scriptViewer: Enter opens the developer view of the script (revisions, files, logs) (unit-tested only)'),
 'WID-033': (X, 'a real AWS QuickSight dashboard is an embedded browser page'),
 'WID-041': (P, 'label, sublabel, footer text or footer HTML as text; card vs plain is drawing only (unit-tested only)'),
 'WID-046': (P, 'Export as CSV: the payload csvData (else the table rows) through the save dialog (unit-tested only)'),
 'WID-047': (P, 'payload dropdowns in the widget menu: the choice is sent as a parameter and the widget reloads (unit-tested only)'),
 'WID-048': (P, 'DATE_PICKER dropdown: a date typed as YYYY-MM-DD is sent as the web sends it (M/D/YYYY) (unit-tested only)'),
 'WID-049': (P, 'required dropdowns: the server message shows until a choice is made, then the data loads (unit-tested only)'),
 'WID-050': (P, 'storeDropdownSelections: choices kept per widget in the shared config; a stale stored option is dropped (unit-tested only)'),
 'WID-052': (P, 'empty states: no rows, no data to chart, no value, no values, no child widgets, no dashboard, no schedule (unit-tested only)'),
 'WID-054': (P, 'a denied widget is drawn with the permission state and never requested (unit-tested only)'),
 'WID-056': (P, 'a parent widget skips denied and unknown children without requests (unit-tested only)'),
 'WID-057': (P, 'composite blocks: TEXT, BIG_NUMBER, NUMBER_ICON_BADGE, UP_OR_DOWN_NUMBER, PROGRESS_BAR, DIVIDER, TABLE_SUB_ROW_DETAIL_ROW, INPUT_FIELD, BUTTON, IMAGE, AUDIO, ICON (unit-tested only)'),
 'WID-059': (P, 'an unsupported block type shows a contained warning (unit-tested only)'),
 'WID-061': (P, 'a process widget whose process the user may not run offers Run disabled with the reason (unit-tested only)'),
 'WID-063': (P, 'an alert with hideWidget or without content draws nothing (unit-tested only)'),
 'WID-066': (P, 'widget metadata from /metaData and data from POST /qqq/v1/widget/{name} (unit-tested only)'),
 'WID-067': (P, 'a payload that is one block draws that block (unit-tested only)'),
 'WID-068': (P, 'table cells typed: numbers with separators, html and htmlAndTooltip as text, images, composites (unit-tested only)'),
 'WID-074': (P, 'standalone composite INPUT_FIELD blocks show their seeded values read-only by type (no standalone input target in a terminal) (unit-tested only)'),
 'WID-075': (P, 'standalone DATE_TIME blocks show seeded instants in the local zone with seconds (unit-tested only)'),
 'RPT-001': (P, 'a report with a process runs its screens and saves the file it produces (CSV chosen) (unit-tested only)'),
 'RPT-002': (P, 'XLSX chosen from the report formats; the server\'s file saved as is (unit-tested only)'),
 'RPT-003': (P, 'JSON chosen from the report formats; the server\'s file saved as is (unit-tested only)'),
 'RPT-004': (P, 'SUMMARY reports: the grouped file with totals is the server\'s; the TUI runs and saves it (unit-tested only)'),
 'RPT-005': (P, 'PIVOT reports: the XLSX pivot is the server\'s; the TUI runs and saves it (unit-tested only)'),
 'RPT-006': (P, 'report input fields are the report process\'s form: required checks, values sent with the run (unit-tested only)'),
 'RPT-007': (P, 'a restricted report is marked (no access) and refused with the reason; the server refuses too (unit-tested only)'),
 'RPT-009': (P, 'saved report record: filter, sort, columns and pivot setup drawn (unit-tested only)'),
 'RPT-010': (P, 'the record actions list the table processes (renderSavedReport) and run them on the record; the DOWNLOAD_FORM file is saved (process downloads unit-tested only)'),
 'RPT-012': (P, 'scheduled report: created on its form; the record shows the cron schedule (cronUI) (unit-tested only)'),
 'RPT-013': (P, 'share a saved report with a user Read-Only (Z, :share) (unit-tested only)'),
 'RPT-014': (P, 'change a share to Read and Edit (unit-tested only)'),
 'RPT-015': (P, 'remove a share after a confirm (unit-tested only)'),
 'RPT-016': (P, 'unshared reports are the server\'s to hide; the TUI lists what it returns and shows a refused link\'s message (unit-tested only)'),
 'RPT-017': (P, 'only the owner may share: others see Share disabled with the reason (unit-tested only)'),
 'RPT-018': (P, 'saved views share through the same dialog (Saved views menu) (unit-tested only)'),
 'RPT-019': (P, 'a report input step shows only its fields; a step without fields continues with no message (unit-tested only)'),
 'HLP-001': (P, 'F1 on an app home: app help and each widget\'s help (slot maps) (unit-tested only)'),
 'HLP-003': (P, 'the grid footer shows the help of the column under the cursor; table help slots in F1 (unit-tested only)'),
 'HLP-004': (P, 'F1 on a process: process, step and step field help; on a record: table, section and field help for the view role (unit-tested only)'),
 'HLP-006': (P, ':helpkeys (F9 Help) turns on help-authoring mode: F1 shows every slot key, with or without content (unit-tested only)'),
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
