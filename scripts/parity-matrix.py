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
 'PRC-015': (P, 'step helpContents shown on the screen, process help at start and in describe; none in the sample'), 'PRC-016': (N, 'b at the prompt when the step reports backStep (isStepBack=true); no sample process declares one, verified by tests'), 'PRC-017': (P, 'updatedFrontendStepList followed'), 'PRC-018': (P, 'updatedFields applied'),
 'PRC-019': (P, 'message, N/M, elapsed on stderr'), 'PRC-020': (P, 'Ctrl-C during a job or a prompt calls POST …/cancel, exit 130'), 'PRC-021': (P, 'userFacingError shown'), 'PRC-022': (X, 'retry is re-running the command'),
 'PRC-023': (X, 'screen labels'), 'PRC-024': (X, 'stepper; step names printed'), 'PRC-025': (P, 'GET …/records paged into a table, --record-limit'), 'PRC-026': (P, 'count and preview; asks validate or skip on a terminal, --validate / --skip-validation; Submit? after validation'),
 'PRC-027': (P, 'status, count, message lines'), 'PRC-028': (P, ''), 'PRC-029': (T, 'bulk edit'), 'PRC-030': (T, 'bulk delete'), 'PRC-031': (T, 'bulk insert'), 'PRC-032': (T, ''),
 'PRC-033': (T, ''), 'PRC-034': (T, ''), 'PRC-035': (P, 'named widget with the process UUID and values, kernel render model; none in the sample, verified by tests'), 'PRC-036': (P, 'seeded from the process value of the widget name'), 'PRC-037': (N, 'ad hoc blocks rendered with interpolation; buttons and inputs not offered'), 'PRC-038': (X, 'Google Drive is web-only'), 'PRC-039': (X, 'Google Drive is web-only'),
 'PRC-040': (X, 'no reload'), 'PRC-041': (P, 'UNAUTHENTICATED exits 3 with the sign-in hint'), 'PRC-042': (P, 'server-enforced'), 'PRC-043': (P, '-v values seed every step'),
 'PRC-044': (X, 'scanner screens are interactive'), 'PRC-045': (P, 'the runner follows nextStep whatever the flow'), 'PRC-046': (T, 'saved bulk load profiles'), 'PRC-047': (P, 'completes on init'),
 'PRC-048': (P, 'searchProcessPossibleValues'), 'PRC-049': (P, 'v1 routes only'), 'PRC-050': (X, 'Material-specific'), 'PRC-051': (P, 'dependent choices narrow after each answer'),
 'PRC-058': (T, ''), 'PRC-059': (T, ''), 'PRC-060': (T, ''), 'PRC-061': (T, ''), 'PRC-062': (X, 'composite editors'), 'PRC-063': (X, ''), 'PRC-064': (P, 'process values typed local, sent UTC; screens show the local zone'), 'PRC-065': (X, 'Google Drive'), 'PRC-066': (P, 'field behaviors applied before submit'),
 # QRY
 'QRY-001': (P, 'default order by primary key'), 'QRY-002': (P, '--limit, --skip, --all'), 'QRY-003': (P, '--order, -field for descending'), 'QRY-004': (T, '--fields per call; no persistence'),
 'QRY-005': (X, 'grid presentation'), 'QRY-006': (X, ''), 'QRY-007': (P, 'error with code, status and trace id'), 'QRY-010': (P, 'all operators and shorthand'), 'QRY-011': (P, 'BETWEEN, IN lists'),
 'QRY-012': (P, 'now(), now(-7d), thisPeriod(), startOf()'), 'QRY-013': (P, '--where/--group DATE_TIME values local to UTC (a date is local midnight); expressions as before'), 'QRY-014': (P, 'IS_BLANK, TRUE, FALSE'), 'QRY-015': (T, 'filters take ids; labels in filters todo'),
 'QRY-016': (P, '--group with parentheses'), 'QRY-017': (P, '--print-filter gives the JSON the web links accept'), 'QRY-018': (P, 'any operator in --where'), 'QRY-019': (P, '--search on query, count and export: CONTAINS over the shown text fields, ORed, ANDed with the filter'),
 'QRY-020': (N, '--join and table.field in --fields/--where/--order, labelled "Join: Field"; the sample exposes no joins, verified through an association join (person to pet)'), 'QRY-021': (P, 'a many-side join repeats rows; count and --count add the distinct count (person --join pet: 21 rows, 16 distinct)'), 'QRY-022': (N, 'qqq table stats <t> <field> [-w …] through the columnStats process; the sample has neither QUERY_STATS nor the process, so --local (same figures from the matching rows) is what was verified'), 'QRY-023': (P, 'without QUERY_STATS (or the process) table stats exits 2 with the reason; --local is an explicit opt-in'), 'QRY-030': (P, '-r ids, --filter-json, --limit'), 'QRY-031': (T, 'bulk edit'), 'QRY-032': (T, 'bulk delete'),
 'QRY-033': (P, 'process run --filter-json with limit'), 'QRY-034': (T, 'process list --table'), 'QRY-035': (P, 'server refuses; exit 3'), 'QRY-040': (P, 'table export: filtered (--where, --group, --search), sorted (--order), --fields in column order, --limit, --out -'), 'QRY-041': (P, 'csv, xlsx, json, tsv; format from --out extension; --no-header; bad format or field exit 2 before the request'),
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
 'REC-053': (T, 'developer view'), 'REC-054': (T, ''), 'REC-055': (X, ''), 'REC-056': (X, ''), 'REC-057': (X, ''), 'REC-058': (X, ''), 'REC-059': (X, ''), 'REC-060': (T, 'adjusters wired, no sample to test'), 'REC-061': (T, ''), 'REC-062': (P, 'inline enums'), 'REC-063': (N, 'get, copy and update -i read with --variant; v1 writes ignore it (server finding #19)'), 'REC-064': (N, 'table get --join adds joined fields (queryJoins); verified with an association join'), 'REC-065': (P, 'an unchanged wall-clock time keeps the original instant and its precision'),
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

rows = []
for line in open(SRC, encoding='utf-8', errors='replace'):
    m = re.match(r'^\|\s*([A-Z]{3}-\d{3})\s*\|\s*(.*?)\s*\|', line)
    if m:
        rows.append((m.group(1), m.group(2)))

fam_counts = collections.defaultdict(collections.Counter)
out = ['# Terminal clients parity matrix', '',
       'Generated by `scripts/parity-matrix.py` from the Next UI acceptance matrix (`qqq-frontend-next/docs/acceptance/feature-matrix.md`,',
       f'{len(rows)} rows). Same ids; two columns added. **pass** = verified against the local sample server in this repo\'s',
       'development; **partial** = works with the noted gap; **todo** = planned; **n/a** = browser-only, with the reason.',
       'The TUI column fills in during M3.', '']
lines = []
for rid, feature in rows:
    fam = rid[:3]
    cli, note = STATUS.get(rid, (T, ''))
    # the TUI column: browser-only rows stay n/a; everything else is M3 work
    tui = X if cli == X and (fam in ('INT', 'SEC') or 'phone' in note or 'browser' in note or 'chrome' in note or 'theme' in note or 'Google' in note or 'web-only' in note) else T
    fam_counts[fam][cli] += 1
    lines.append(f'| {rid} | {feature[:110].replace("|", "/")} | {cli} | {tui} | {note.replace("|", "/")} |')
out.append('## Summary (CLI column)'); out.append('')
out.append('| Family | rows | pass | todo | partial | n/a |'); out.append('|---|---|---|---|---|---|')
total = collections.Counter()
for fam in sorted(fam_counts):
    c = fam_counts[fam]; total.update(c)
    out.append(f'| {fam} | {sum(c.values())} | {c[P]} | {c[T]} | {c[N]} | {c[X]} |')
out.append(f'| **all** | {sum(total.values())} | {total[P]} | {total[T]} | {total[N]} | {total[X]} |'); out.append('')
out.append('## Rows'); out.append(''); out.append('| ID | Feature | CLI | TUI | Note |'); out.append('|---|---|---|---|---|')
out.extend(lines); out.append('')
open(OUT, 'w', encoding='utf-8').write('\n'.join(out))
print(f'{len(rows)} rows -> {OUT}; CLI: ' + ', '.join(f'{k} {v}' for k, v in sorted(total.items())))
