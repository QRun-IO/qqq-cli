#!/usr/bin/env bash
# CLI sweep of every qbit surface on the enterprise test server (scripts/enterprise-server.sh).
# Runs each command, records its exit code and the first lines of output; non-zero lines are the gaps.
#   scripts/enterprise-smoke.sh            QQQ="qqq --profile enterprise" OUT=file N=8
# Writes a few records (an audit probe customer, a comment, a follow, a saved view) on the test server.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QQQ_CMD=(${QQQ:-node $here/../packages/cli/dist/main.js})
OUT=${OUT:-${TMPDIR:-/tmp}/qqq-enterprise-smoke.txt}; : > "$OUT"
DL=${DL:-$(mktemp -d)}
run() { local label="$1"; shift; local o; o=$("${QQQ_CMD[@]}" "$@" 2>&1); local rc=$?; { echo "### [$rc] $label :: qqq $*"; echo "$o" | head -${N:-8} | cut -c1-240; } >> "$OUT"; }
run whoami whoami
run "apps list" apps list -O text
run home home -O json
run "process list count" process list -O json -Q 'length(@)'
run "widget list count" widget list -O json -Q 'length(@)'
run "find customer" find customer
run "search (global)" search Chicago
run "doctor" doctor
# ESB
run "esb overview" esb overview
run "esb table order" esb table order
run "esb process syncOrder" esb process syncOrder
run "esb messages" esb messages orderEvents --trigger syncOrder.orderEvents
# health (not installed on 8078)
run "health summary" health get-summary
# alerts
run "alerts inbox" alerts get-inbox
run "alerts summary" alerts get-inbox-summary
run "alerts record panel" alerts get-record-panel -q tableName=customer recordId=1
# assistant
run "assistant config" assistant get-config
run "assistant conversations" assistant get-conversations
run "assistant access" assistant get-access
# collaboration
run "collab presence table" collab presence customer
run "collab presence record" collab presence customer 1
run "collab favorites" collab favorites list
run "collab recents" collab recents
run "collab people" collab people admin
run "collab my-work" collab my-work
run "collab comments list" collab comments list customer 1
run "collab comments add" collab comments add customer 1 "enterprise smoke comment"
run "collab tags record" collab tags list customer 1
run "collab follow" collab follow customer 1
run "collab timeline" collab get-records-timeline customer 1
run "collab attachments" collab get-records-attachments customer 1
run "collab share preview" collab post-records-shares-preview customer 1 -b '{"toUserIds":["core:admin"],"message":"look"}'
# data analysis
run "da capabilities customer" data-analysis get-tables-capabilities customer
run "da table profile customer" data-analysis post-tables-table-profile customer -b '{}'
run "da column profile customer.name" data-analysis post-tables-column-profile customer -b '{"fieldName":"name"}'
run "da distinct" data-analysis post-tables-distinct-values order -b '{"fieldName":"status"}'
run "da saved" data-analysis get-saved
# db performance
run "dbperf overview" db-performance get-overview
run "dbperf activity" db-performance get-activity
# qa capture
run "qa capability" qa-capture get-capability
# quick search
run "qs status" quick-search get-status
run "qs suggest" quick-search get-suggest -q q=a
run "table query --search" table query customer --search a
# release notes
run "rn releases" release-notes get-releases
run "rn summary" release-notes get-summary
# secured data
run "sd status" secured-data get-status
run "sd reveal options" secured-data get-reveal-options -q tableName=customer fieldName=email
# sql workbench
run "sqlwb capabilities" sql-workbench get-capabilities
run "sqlwb schema h2" sql-workbench get-schema h2
run "sqlwb execute" sql-workbench post-execute -b '{"backendName":"h2","sql":"select id, name from customer"}'
run "sqlwb history" sql-workbench get-history
run "sqlwb notebooks" sql-workbench get-notebooks
# jobs
run "job list" job list
run "job list --all" job list --all
# reports / saved reports / views / bulk profiles
run "report list" report list
run "saved-report list" saved-report list
run "saved-view list" saved-view list customer
run "bulk-profile list" bulk-profile list customer
# prefs, help
run "prefs list" prefs list
run "help-search" help-search order
# webhooks (tables)
run "webhook query" table query webhook
run "webhook subscription query" table query webhookSubscription
run "webhook actions" table actions webhook
# scripts
run "script tables" table query script --limit 3
# exports
run "export customer csv" table export customer --format csv --out $DL/customer.csv
run "export order xlsx" table export order --format xlsx --out $DL/order.xlsx
run "export person json" table export person --format json --out $DL/person.json
run "qs reindex process" process run quickSearchFullReindex --yes
run "qs suggest after reindex" quick-search get-suggest -q q=ada
run "search after reindex" search ada
run "audit create" table create customer --set name="Audit Probe" --set email=probe@example.test
run "audit update" table update customer 1 --set email=ada2@example.test
run "audit list" audit list customer 1
run "saved view save" saved-view save customer -n "Enterprise smoke" -w "name ~ a" --replace
run "saved view list" saved-view list customer
run "process run calculateOrderTotal" process run calculateOrderTotal -v quantity=3 unitPriceCents=1250
run "process run greet" process run greet -r 1,2 --yes
run "process describe syncOrder" process describe syncOrder
run "webhook test event" process run SendTestEventToWebhook -r 1 --yes
run "widget get first" widget list -O json -Q '[0:5].name'
echo "done: $(grep -c "^### \[0\]" "$OUT") passed, $(grep -c "^### \[[1-9]" "$OUT") non-zero; $OUT"
