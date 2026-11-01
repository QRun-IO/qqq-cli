#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# PRF-001 measurement: the fake large-instance server's 10,000-row, 40-column table (bigwide) in
# tmux at 160x45. Times `:table query bigwide` to the exact first page, End (the last page,
# record 10,000), and moving to column 40; prints milliseconds and fails over the budget
# (BUDGET_MS, default 2000 per step).   packages/tui/scripts/perf-large-table.sh [port]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
port="${1:-8096}"
budget="${BUDGET_MS:-2000}"
s="qqq-perf-$$"
cfg="$(mktemp -d)"
bun run "$pkg/scripts/fake-big-server.ts" "$port" 50 20 > "$cfg/server.log" 2>&1 &
server=$!
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; kill "$server" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 40); do curl -sf "http://localhost:$port/qqq/v1/version" > /dev/null && break; sleep 0.25; done
tmux new-session -d -s "$s" -x 160 -y 45 "cd '$pkg' && QQQ_CONFIG_DIR='$cfg' QQQ_KEYRING=file QQQ_CACHE_DIR='$cfg/cache' bun run src/main.tsx --no-check --server http://localhost:$port; sleep 5"
now() { python3 -c 'import time; print(int(time.time()*1000))'; }
waitfor() { for _ in $(seq 1 400); do tmux capture-pane -t "$s" -p > "$cfg/$1.txt"; grep -qF -- "$2" "$cfg/$1.txt" && return 0; sleep 0.02; done; echo "FAIL waiting for $2"; cat "$cfg/$1.txt"; exit 1; }
waitfor home 'Applications'
fail=0
step() { # name start
  local ms=$(( $(now) - $2 ))
  local verdict=ok; (( ms > budget )) && { verdict=OVER; fail=1; }
  echo "$1: ${ms} ms ($verdict, budget ${budget} ms)"
}
tmux send-keys -t "$s" -l -- ':'; sleep 0.3; tmux send-keys -t "$s" -l -- 'table query bigwide'
t=$(now); tmux send-keys -t "$s" Enter
waitfor first 'r1c1'
waitfor first2 '10,000 records'
step 'first page (rows 1-, 40 columns available)' "$t"
grep -q 'col 1/40' "$cfg/first2.txt" && echo "columns: 40 (col 1/40)" || { echo "columns: not 40"; grep -o 'col [0-9]*/[0-9]*' "$cfg/first2.txt" || true; fail=1; }
t=$(now); tmux send-keys -t "$s" End
waitfor last 'r10000c1'
step 'last page (record 10,000)' "$t"
t=$(now); for _ in $(seq 1 39); do tmux send-keys -t "$s" Right; done
waitfor col40 'col 40/40'
step 'to column 40' "$t"
exit $fail
