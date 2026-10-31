#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux smoke test of qqq ui against a running server (default: the sample server, profile "sample").
# Drives the real TUI with per-key pauses and checks each screen's text; captures go to $OUT.
#   packages/tui/scripts/smoke.sh [profile]      OUT=dir WIDTH=160 HEIGHT=45
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
profile="${1:-sample}"
out="${OUT:-$(mktemp -d)}"
w="${WIDTH:-160}"; h="${HEIGHT:-45}"
s="qqq-smoke-$$"
fails=0
mkdir -p "$out"
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; }
trap cleanup EXIT
keys() { for k in "$@"; do if [[ $k == T:* ]]; then tmux send-keys -t "$s" -l -- "${k#T:}"; else tmux send-keys -t "$s" "$k"; fi; sleep 0.25; done; }
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
tmux new-session -d -s "$s" -x "$w" -y "$h" "cd '$pkg' && bun run src/main.tsx --no-check --profile '$profile'; sleep 5"
expect 01-home 'Apps' 'UI API' 'Quick actions' 'Applications'
keys T:: 'T:table query person' Enter
expect 02-grid 'records ·' 'First Name'
keys Down Down Down Enter
expect 03-record 'record 4 of'
keys PageDown
expect 04-record-next 'record 5 of'
keys Escape
expect 05-grid-row 'row 5 '
keys F6
expect 06-filter 'Filter Person' 'Guided'
keys Tab 'T:lastName STARTS_WITH S' Enter
expect 07-filtered 'lastName STARTS_WITH S'
keys T:: 'T:table create placeAddress' Enter
expect 08-form 'New Address book' 'set Country first'
keys Escape
keys T:: 'T:process run sleepInteractive' Enter
expect 09-process 'Sleep duration'
keys C-u T:500 C-s
expect 10-process-done 'Finished in' 'Slept for 500'
keys Escape F9
expect 11-menu 'Menu  (F9)' 'Context' 'Go to'
keys Escape 'T:?'
expect 12-help 'Help  (F1' 'Keys'
keys Escape T:: 'T:app SampleWidgetsDashboard' Enter
expect 13-dashboard 'Sample Widgets Dashboard'
keys F10
expect 14-quit-confirm 'Quit qqq?' 'Reset: go to the home screen'
keys Enter
sleep 1
echo "captures in $out"
[[ $fails == 0 ]] && echo "smoke: ok" || { echo "smoke: $fails failed"; exit 1; }
