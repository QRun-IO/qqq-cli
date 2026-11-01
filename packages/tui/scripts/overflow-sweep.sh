#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux sweep for text outside its container: drives the real TUI against a running server (default
# the shared sample server, MOCK auth) through every screen and dialog, captures each at
# 80/100/120/200 columns by 24 and 50 rows, and checks every capture with overflow-check.ts (no line
# wider than the terminal, every box border intact: text past a border breaks it).
#   packages/tui/scripts/overflow-sweep.sh [server-url]      OUT=dir SIZES="80x24 120x50"
# Expects the sample app's tables and processes (the sample server, or the enterprise server that includes them).
# Uses an isolated config directory; never touches the server beyond reads and cancelled dialogs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
server="${1:-http://localhost:8077}"
cfg="$(mktemp -d)"
out="${OUT:-$cfg/captures}"
sizes="${SIZES:-80x24 80x50 100x24 100x50 120x24 120x50 200x24 200x50}"
s="qqq-overflow-$$"
fails=0
mkdir -p "$out"
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; }
trap cleanup EXIT
curl -sf "$server/qqq/v1/metaData" > /dev/null || { echo "overflow-sweep: no server at $server"; exit 1; }

keys() { for k in "$@"; do if [[ $k == T:* ]]; then tmux send-keys -t "$s" -l -- "${k#T:}"; elif [[ $k == S:* ]]; then sleep "${k#S:}"; else tmux send-keys -t "$s" "$k"; fi; sleep 0.2; done; }
size() { tmux resize-window -t "$s" -x "$1" -y "$2"; }
# a fresh TUI for each scenario (the same config, so recently viewed and view settings carry over)
start() {
  tmux kill-session -t "$s" 2>/dev/null || true
  tmux new-session -d -s "$s" -x 120 -y 36 "cd '$pkg' && QQQ_CONFIG_DIR='$cfg/config' QQQ_STATE_DIR='$cfg/state' QQQ_KEYRING=file QQQ_CACHE_DIR='$cfg/cache' bun run src/main.tsx --no-check --server '$server'; sleep 30"
  tmux set-option -t "$s" window-size manual > /dev/null
  # a large instance can take a while to load its metadata
  for _ in 1 2 3; do wait_for start 'Quick actions' && return 0; done
  echo "FAIL start: the home screen never showed"; fails=$((fails + 1)); return 0
}
# waits for every text to be on screen (at the base size)
wait_for() {
  local name=$1; shift
  for _ in $(seq 1 40); do
    tmux capture-pane -t "$s" -p > "$out/_wait.txt"
    local ok=1
    for t in "$@"; do grep -qF -- "$t" "$out/_wait.txt" || ok=0; done
    [[ $ok == 1 ]] && return 0
    sleep 0.25
  done
  return 1
}
# shot NAME TEXT...: once every TEXT is on screen, captures the state at every size and checks each
# capture; a state that never appears counts as a failure (the sweep must not pass by missing screens)
shot() {
  local name=$1 bad=0; shift
  if ! wait_for "$name" "$@"; then
    cp "$out/_wait.txt" "$out/$name-NOTREACHED.txt"
    echo "FAIL $name: never showed: $*"; fails=$((fails + 1)); return 0
  fi
  for wh in $sizes; do
    local w=${wh%x*} h=${wh#*x}
    size "$w" "$h"; sleep 0.6
    tmux capture-pane -t "$s" -p > "$out/$name-$wh.txt"
    if ! bun run "$here/overflow-check.ts" "$w" "$h" "$out/$name-$wh.txt"; then bad=1; fi
  done
  size 120 36; sleep 0.4
  shots=$((shots + 1))
  if [[ $bad == 0 ]]; then echo "ok   $name"; else fails=$((fails + 1)); fi
}
cmd() { keys T:: "T:$1" Enter; }
# start_splash NAME CONFIG-JSON: a fresh TUI on its own config, no --server (the start-up splash, picker or add form)
start_splash() {
  tmux kill-session -t "$s" 2>/dev/null || true
  mkdir -p "$cfg/$1/config"
  printf '%s\n' "$2" > "$cfg/$1/config/config.json"
  tmux new-session -d -s "$s" -x 120 -y 36 "cd '$pkg' && QQQ_CONFIG_DIR='$cfg/$1/config' QQQ_STATE_DIR='$cfg/$1/state' QQQ_KEYRING=file QQQ_CACHE_DIR='$cfg/$1/cache' bun run src/main.tsx --no-check; sleep 30"
  tmux set-option -t "$s" window-size manual > /dev/null
}
long="$(printf 'Long value %.0s' $(seq 1 30))"
shots=0

# the start-up splash: the picker (two profiles), a failed connection (retry / choose another), the add form (no profile)
start_splash picker "{\"profiles\":{\"sweep\":{\"server\":\"$server\",\"description\":\"the sweep server\"},\"other\":{\"server\":\"$server\"}}}"; shot 00a-splash-picker 'Connect to a server' 'Terminal client for QQQ'
start_splash failed '{"profiles":{"down":{"server":"http://127.0.0.1:9"}}}'; shot 00b-splash-failed 'Enter retries' 'Terminal client for QQQ'
start_splash add '{"profiles":{}}'; shot 00c-splash-add 'Add a server profile'
keys Escape; shot 00d-splash-no-profile 'n adds a server profile'
start; shot 01-home 'Quick actions' 'Recently viewed'
keys T:?; shot 02-help 'Keys'
start; keys T:/; shot 03-search 'Search'
start; keys T:: 'T:table q'; shot 04-command-line ': table q'
start; keys F9; shot 05-command-center 'Menu' 'Go to'
keys T:job; shot 05b-command-center-search 'Menu'
start; keys F9 Enter; shot 05c-command-center-context 'Menu'
keys Escape Down Down Enter; shot 05d-command-center-area 'Menu'
start; keys C-o; shot 05e-servers 'Servers'
keys T:n; shot 05f-servers-add 'Add a server profile'
start; cmd 'app peopleApp'; shot 06-app-home 'People App'
start; cmd 'table query person'; keys S:1 Tab Down Right Down Down Right; shot 07-app-tree '▾'
start; cmd 'table query person'; shot 08-grid 'First Name' 'records'
keys v; shot 09-view-settings 'View settings'
keys Down Down Down Down Down Down Down Down Down Down Down; shot 10-view-settings-pinned 'columns that stay left while scrolling'
# the widest table there is with records (39 columns on the enterprise server), else the widest at all
wide="$(curl -sf "$server/qqq/v1/metaData" | python3 -c 'import json,sys; t=json.load(sys.stdin)["tables"]; print(next((n for n in ["db_perf_snapshot", "fieldLab"] if n in t), ""))')"
if [[ -n $wide ]]; then
  start; cmd "table query $wide"; shot 11a-grid-many-columns 'records'
  keys Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right Right; shot 11b-grid-many-columns-right 'records'
  keys v; shot 11c-view-settings-many-columns 'View settings'
fi
start; cmd 'table query person'; keys S:1 v S:0.5 T:w C-u T:120 Enter Down T:w C-u T:120 Enter Enter; shot 11-grid-wide-columns 'records'
keys End; shot 12-grid-wide-columns-scrolled 'records'
keys T:v T:r
start; cmd 'table query person'; keys S:1 Down Enter; shot 13-record 'record 2 of'
keys T:A; shot 14-audits 'udit'
start; cmd 'table query person'; keys S:1 Down Enter S:1 T:D; shot 15-developer 'eveloper'
keys Right Right; shot 15b-developer-section 'eveloper'
keys T:4; shot 15c-developer-json 'Record JSON'
keys Down Down Down Down Down Down Down T:v; shot 15d-developer-view-value 'Field ·'
start; cmd 'table query person'; keys S:1 T:D; shot 15e-table-developer 'eveloper'
keys Right Right Right; shot 15f-table-developer-section 'eveloper'
start; cmd 'table query person'; keys S:1 Down Enter S:1 F8; shot 16-delete-confirm 'Confirm'
keys T:n; keys F4; shot 17-edit-form 'Ctrl+S save'
keys C-u "T:$long"; shot 18-edit-form-long-value 'Long value Long value'
keys Escape; shot 19-discard-confirm 'Confirm'
start; cmd 'table create person'; keys S:1 Down Down Down Enter; shot 19b-date-picker 'Esc cancel'
start; cmd 'table query person'; keys S:1 F6; shot 20-filter 'Filter Person'
start; cmd 'table query person'; keys S:1 T:x; shot 21-export 'Export'
start; cmd 'table query person'; keys S:1 Space Down Space T:b; shot 22-bulk-choose 'Run on'
keys T:'Bulk edit' Enter; shot 23-bulk-wizard 'Esc cancel'
start; cmd 'table query person'; keys S:1 T:a; shot 24-actions 'Actions'
start; cmd 'table query person'; keys S:1 T:g; shot 25-prompt 'Go to'
start; cmd 'table create placeAddress'; shot 26-create-form 'New Address book' 'set Country first'
keys T:"$long"; shot 27-create-form-long-value 'Long value Long value'
start; cmd 'process run sleepInteractive'; shot 28-process-step 'Sleep duration'
keys C-u T:200 C-s; shot 29-process-done 'Finished'
start; cmd 'process run greetInteractive'; shot 30-process-greet 'Greet'
start; cmd 'process run simpleThrow'; shot 31-process-error 'rror'
start; cmd 'record person 999999'; shot 32-record-not-found 'Could not find'
start; cmd 'table create person'; keys S:1 C-s; shot 33-form-errors 'is required'
start; cmd 'app SampleWidgetsDashboard'; shot 34-dashboard 'Sample Widgets Dashboard'
keys F10; shot 35-quit-confirm 'Quit qqq?'
start; cmd 'table query person'; keys S:1 F9; keys T:'CLI' Enter; shot 36-message 'CLI equivalent'

# the SQL Runner, where the server has the sql-workbench extension (the enterprise server)
if curl -sf "$server/qqq/v1/metaData" | grep -q 'sql-workbench\|sqlWorkbench'; then
  table="${SQL_TABLE:-CUSTOMER}"
  start; cmd 'sql SELECT 1'; shot 40-sql-select-1 'SQL · cell'
  keys Escape End C-u "T:SELECT * FROM $table" F5; shot 41-sql-table 'col 1/'
  keys Escape End C-u 'T:SELECT * FRM X' F5; shot 42-sql-error 'FAILED'
  keys End C-u "T:SELECT * FROM $table WHERE 1 = 1" F6; shot 43-sql-explain 'Plan'
  keys Escape F3; shot 44-sql-schema 'Schema'
  keys F3 F7; shot 45-sql-history 'History'
fi

echo "captures in $out"
if [[ $fails == 0 ]]; then echo "overflow-sweep: ok ($shots states x $(wc -w <<< "$sizes" | tr -d ' ') sizes)"; else echo "overflow-sweep: $fails failed"; exit 1; fi
