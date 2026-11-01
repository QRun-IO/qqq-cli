#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux check that grid column widths stay fixed across pages: starts the fake large-instance server
# (rows after 20 have much longer values), opens a table, and compares the header and the column
# offsets of page 1 and page 2.   packages/tui/scripts/smoke-widths.sh [port]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
port="${1:-8099}"
s="qqq-widths-$$"
cfg="$(mktemp -d)"
out="${OUT:-$cfg}"
bun run "$pkg/scripts/fake-big-server.ts" "$port" > "$cfg/server.log" 2>&1 &
server=$!
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; kill "$server" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 40); do curl -sf "http://localhost:$port/qqq/v1/version" > /dev/null && break; sleep 0.25; done
tmux new-session -d -s "$s" -x 120 -y 30 "cd '$pkg' && QQQ_CONFIG_DIR='$cfg' QQQ_KEYRING=file QQQ_CACHE_DIR='$cfg/cache' bun run src/main.tsx --no-check --server http://localhost:$port; sleep 5"
keys() { for k in "$@"; do if [[ $k == T:* ]]; then tmux send-keys -t "$s" -l -- "${k#T:}"; else tmux send-keys -t "$s" "$k"; fi; sleep 0.25; done; }
waitfor() { for _ in $(seq 1 40); do tmux capture-pane -t "$s" -p > "$out/$1.txt"; grep -qF -- "$2" "$out/$1.txt" && return 0; sleep 0.25; done; echo "FAIL waiting for $2"; exit 1; }
waitfor home 'Applications'
keys T:: 'T:table query order_0' Enter
waitfor page1 'order_0 1 '
keys End
waitfor page2 'a much longer'
h1="$(grep -m1 ' Id ' "$out/page1.txt" | sed 's/.*││//')"
h2="$(grep -m1 ' Id ' "$out/page2.txt" | sed 's/.*││//')"
r1="$(grep -m1 'order_0 1 ' "$out/page1.txt")"
r2="$(grep -m1 'order_0 40' "$out/page2.txt")"
# offset of the name column inside the grid pane (after the pane border), so the Apps pane does not count
off() { local pane="${1#*││}"; local before="${pane%%order_0*}"; echo "${#before}"; }
echo "page 1 header: $h1"
echo "page 2 header: $h2"
if [[ "$h1" == "$h2" && "$(off "$r1")" == "$(off "$r2")" && "$r2" == *"…"* ]]; then echo "widths: ok (header and offsets identical; long values cut with …)"; else echo "widths: FAIL"; exit 1; fi
