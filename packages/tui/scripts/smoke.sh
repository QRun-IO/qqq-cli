#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux smoke test of qqq ui against a running server (default: the sample server, profile "sample").
# Drives the real TUI with per-key pauses and checks each screen's text; captures go to $OUT.
#   packages/tui/scripts/smoke.sh [profile]                    a profile of your own config
#   packages/tui/scripts/smoke.sh --server URL [--profile NAME]  any server, in an isolated config
#                                                              (MOCK or anonymous sign-in; your
#                                                              config, keyring and cache untouched)
#   OUT=dir WIDTH=160 HEIGHT=45
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
profile=""; server=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server|-s) server="$2"; shift 2 ;;
    --server=*) server="${1#*=}"; shift ;;
    --profile|-p) profile="$2"; shift 2 ;;
    --profile=*) profile="${1#*=}"; shift ;;
    -h|--help) sed -n '4,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) profile="$1"; shift ;;
  esac
done
out="${OUT:-$(mktemp -d)}"
env_prefix=""
if [[ -n "$server" ]]; then
  # an isolated config with one profile for the server, so the TUI signs in there instead of showing the picker
  profile="${profile:-smoke}"
  cfg="$(mktemp -d)"
  mkdir -p "$cfg/config"
  printf '{"profiles":{"%s":{"server":"%s"}},"defaultProfile":"%s"}\n' "$profile" "${server%/}" "$profile" > "$cfg/config/config.json"
  env_prefix="QQQ_CONFIG_DIR='$cfg/config' QQQ_CACHE_DIR='$cfg/cache' QQQ_STATE_DIR='$cfg/state' QQQ_KEYRING=file"
fi
profile="${profile:-sample}"
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
echo "smoke: profile $profile${server:+ at $server (isolated config)}; captures in $out"
tmux new-session -d -s "$s" -x "$w" -y "$h" "cd '$pkg' && $env_prefix bun run src/main.tsx --no-check --profile '$profile'; sleep 5"
expect 01-home 'Apps' 'UI API' 'Recently viewed' 'Quick actions'
keys T:: 'T:table query person' Enter
expect 02-grid 'records ·' 'First Name'
keys Down Down Down Enter
expect 03-record 'record 4 of'
keys PageDown
expect 04-record-next 'record 5 of'
keys Escape
expect 05-grid-row 'row 5 '
keys F6
expect 06-filter 'Filter Person' 'Guided' 'quick and First Name' 'matches'
keys Down T:Av Enter
expect 06b-filter-text 'firstName CONTAINS Av' 'First Name: type text'
keys F2
expect 06c-filter-advanced 'cheat sheet' 'firstName CONTAINS Av'
keys C-u 'T:lastName STARTS_WITH S' Enter
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
expect 12-help 'Keys  (F1' 'Anywhere' 'F2 search records'
keys Escape F2
expect 12b-search 'Search ▸'
keys Escape T:: 'T:app SampleWidgetsDashboard' Enter
expect 13-dashboard 'Sample Widgets Dashboard'
if [[ -z "$server" || "${SAMPLE:-}" == 1 ]]; then
  # the sample server's data: person 12 and its ESB events (another server: --server skips these, SAMPLE=1 keeps them)
  keys Escape T:: 'T:table get person 12' Enter
  expect 13b-record-12 'Person ›' 'Identity'
  keys D
  expect 13c-developer '1 Security' 'Record Security' '3Record'
  keys 2
  expect 13d-developer-events 'ESB Events' 'Published to' 'v view'
else
  echo "skip 13b-13d (sample data: person 12 and its ESB events)"
fi
keys Escape
keys T:: 'T:saver flip' Enter
expect 13e-saver 'preview: flip' 'Server' 'any key returns'
keys T:x
keys F10
expect 14-quit-confirm 'Quit qqq?' 'Reset: go to the home screen'
keys Enter
sleep 1
echo "captures in $out"
[[ $fails == 0 ]] && echo "smoke: ok" || { echo "smoke: $fails failed"; exit 1; }
