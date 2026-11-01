#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux smoke test of the SQL Runner against a server with the sql-workbench extension (default: the
# enterprise test server on 8078, MOCK sign-in). Uses its own config, state and cache directories, so
# no profile of yours is touched. At 80x24 and 120x36: SELECT 1, a real table query (paging, sort),
# a SQL error with its position, EXPLAIN, the schema browser and history; captures go to $OUT.
#   packages/tui/scripts/smoke-sql.sh [server]   OUT=dir SQL_TABLE=CUSTOMER
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/../.." && pwd)"
server="${1:-http://localhost:8078}"
table="${SQL_TABLE:-CUSTOMER}"
out="${OUT:-$(mktemp -d)}"
cfg="$(mktemp -d)"
export QQQ_CONFIG_DIR="$cfg/config" QQQ_STATE_DIR="$cfg/state" QQQ_CACHE_DIR="$cfg/cache" QQQ_KEYRING=file
s="qqq-sql-$$"
fails=0
mkdir -p "$out"
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; rm -rf "$cfg"; }
trap cleanup EXIT
login="$(node "$root/packages/cli/dist/main.js" --server "$server" login 2>&1)"
profile="$(sed -n 's/.*as profile "\([^"]*\)".*/\1/p' <<< "$login")"
[[ -n $profile ]] || { echo "sign-in failed: $login"; exit 1; }
keys() { for k in "$@"; do if [[ $k == T:* ]]; then tmux send-keys -t "$s" -l -- "${k#T:}"; else tmux send-keys -t "$s" "$k"; fi; sleep 0.3; done; }
cap() { tmux capture-pane -t "$s" -p > "$out/$1.txt"; }
expect() { # name text...
  local name=$1; shift
  for _ in $(seq 1 40); do
    cap "$name"
    local ok=1
    for t in "$@"; do grep -qF -- "$t" "$out/$name.txt" || ok=0; done
    [[ $ok == 1 ]] && { echo "ok   $name"; return 0; }
    sleep 0.25
  done
  echo "FAIL $name (wanted: $*)"; fails=$((fails + 1))
}
# no line wider than the terminal (the clipping rule)
fits() { local name=$1 w=$2; if node -e 'const [f, w] = process.argv.slice(1); process.exit(require("fs").readFileSync(f, "utf8").split("\n").some((l) => [...l].length > Number(w)) ? 1 : 0)' "$out/$name.txt" "$w"; then :; else echo "FAIL $name: a line is wider than $w"; fails=$((fails + 1)); fi; }

run_at() { # width height suffix
  local w=$1 h=$2 x=$3
  # the environment goes in the command: a running tmux server does not pass this shell's exports on
  tmux new-session -d -s "$s" -x "$w" -y "$h" "cd '$pkg' && QQQ_CONFIG_DIR='$QQQ_CONFIG_DIR' QQQ_STATE_DIR='$QQQ_STATE_DIR' QQQ_CACHE_DIR='$QQQ_CACHE_DIR' QQQ_KEYRING=file bun run src/main.tsx --no-check --profile '$profile'; sleep 5"
  expect "$x-00-home" 'Home' 'Recently viewed'
  keys T:: 'T:sql SELECT 1' Enter
  expect "$x-01-select-1" 'SQL · cell 1/1' '1 row ·' 'read-only' 'limit '
  fits "$x-01-select-1" "$w"
  keys Escape End C-u "T:SELECT * FROM $table" F5
  expect "$x-02-table" 'rows ·' 'col 1/'
  fits "$x-02-table" "$w"
  keys Right T:s T:s
  expect "$x-03-sorted" 'desc'
  keys End
  expect "$x-04-last-row" 'row '
  keys Escape End C-u 'T:SELECT * FRM X' F5
  expect "$x-05-error" 'FAILED' 'at line 1, col 10'
  fits "$x-05-error" "$w"
  keys End C-u "T:SELECT * FROM $table WHERE 1 = 1" F6
  expect "$x-06-explain" 'Plan' 'EXPLAIN'
  fits "$x-06-explain" "$w"
  keys Escape F3
  expect "$x-07-schema" 'Schema' "$table"
  fits "$x-07-schema" "$w"
  keys F3 F7
  expect "$x-08-history" 'History' 'SELECT 1'
  fits "$x-08-history" "$w"
  keys Escape
  tmux kill-session -t "$s" 2>/dev/null || true
}

run_at 80 24 80
run_at 120 36 120
echo "captures in $out"
[[ $fails == 0 ]] || { echo "$fails failed"; exit 1; }
echo "sql smoke: ok"
