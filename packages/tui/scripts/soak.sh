#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Soak test: drives the real TUI in tmux with random keys from the keymap (F-keys, arrows, paging,
# Tab, Esc, Enter, Space, single-key shortcuts, `:` commands from a list) and fails when the process
# exits or a screen's error boundary shows. The last 20 frames are kept on failure.
#   packages/tui/scripts/soak.sh [server] [minutes]      SEED=n KEYS_PER_SEC=8 OUT=dir W=200 H=50
# Defaults: http://localhost:8077 for 10 minutes. It signs in with a fresh config and file keyring
# (MOCK servers), so your own profiles and settings are not touched. Keys that quit (F10, Ctrl+C,
# :quit), lock, sign out, confirm (y), save (Ctrl+S) and export are left out, so nothing on the server or
# disk changes (every 60 keys F10 › Reset goes home, confirming only that a half-typed form is dropped);
# QQQ_UI_NO_QUIT=1 ignores a Quit chosen from a menu, so only a crash ends the run.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
server="${1:-http://localhost:8077}"
minutes="${2:-10}"
seed="${SEED:-$$}"
rate="${KEYS_PER_SEC:-8}"
w="${W:-200}"; h="${H:-50}"
out="${OUT:-$(mktemp -d)}"
cfg="$(mktemp -d)"
s="qqq-soak-$$"
RANDOM=$seed
mkdir -p "$out/frames"
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; }
trap cleanup EXIT
tmux new-session -d -s "$s" -x "$w" -y "$h" "cd '$pkg' && QQQ_CONFIG_DIR='$cfg' QQQ_KEYRING=file QQQ_STATE_DIR='$cfg/state' QQQ_CACHE_DIR='$cfg/cache' QQQ_UI_NO_BROWSER=1 QQQ_UI_NO_QUIT=1 bun run src/main.tsx --no-check --server '$server' 2> '$out/stderr.txt'; echo \"SOAK-EXITED \$?\"; sleep 3600"
for _ in $(seq 1 80); do tmux capture-pane -t "$s" -p | grep -q 'Applications\|Apps' && break; sleep 0.25; done

keys=(Up Down Left Right Up Down Up Down PageUp PageDown Home End Tab BTab Escape Escape Enter Enter Space F1 F2 F3 F4 F5 F6 F7 F8 F9 s v '?' / . r f g n e c q A D t l ']' '[' S C-f C-b C-a Escape)
commands=('table query person' 'table query city' 'table query sales_order' 'table get person 1' 'app peopleApp' 'app SampleWidgetsDashboard' 'home' 'back' 'help' 'jobs' 'connection' 'filter firstName = Avery' 'filter clear' 'views' 'theme classic' 'theme high-contrast' 'table query nosuchtable' 'record person 2' 'audits' 'dev')
frame=0
sent=0
end=$(( $(date +%s) + minutes * 60 ))
delay=$(python3 -c "print(1/$rate)")
fail() {
  echo "FAIL: $1 (seed $seed, after $sent keys)"
  ls -1 "$out/frames" | sort -n | tail -20 | while read -r f; do echo "== frame $f"; cat "$out/frames/$f"; done > "$out/last-20-frames.txt"
  echo "last 20 frames: $out/last-20-frames.txt; keys: $out/keys.txt; stderr: $out/stderr.txt"
  exit 1
}
while (( $(date +%s) < end )); do
  if (( sent > 0 && sent % 60 == 0 )); then
    # every 60 keys: F10 › Reset to home, confirming the discard of a half-typed form (local only)
    echo 'RESET' >> "$out/keys.txt"
    tmux send-keys -t "$s" Escape; sleep 0.2; tmux send-keys -t "$s" F10; sleep 0.3; tmux send-keys -t "$s" Down; sleep 0.1; tmux send-keys -t "$s" Enter; sleep 0.3
    tmux capture-pane -t "$s" -p | grep -q 'anyway?' && tmux send-keys -t "$s" -l -- y
    sleep 0.3
  fi
  if (( RANDOM % 25 == 0 )); then
    c=${commands[$((RANDOM % ${#commands[@]}))]}
    echo ":$c" >> "$out/keys.txt"
    tmux send-keys -t "$s" -l -- ':'; sleep 0.1; tmux send-keys -t "$s" -l -- "$c"; tmux send-keys -t "$s" Enter
  else
    k=${keys[$((RANDOM % ${#keys[@]}))]}
    echo "$k" >> "$out/keys.txt"
    if [[ ${#k} == 1 ]]; then tmux send-keys -t "$s" -l -- "$k"; else tmux send-keys -t "$s" "$k"; fi
  fi
  sent=$((sent + 1))
  sleep "$delay"
  if (( sent % 4 == 0 )); then
    frame=$((frame + 1))
    tmux capture-pane -t "$s" -p > "$out/frames/$frame"
    # keep the last 40 frames on disk
    old=$((frame - 40)); (( old > 0 )) && rm -f "$out/frames/$old"
    grep -q 'SOAK-EXITED' "$out/frames/$frame" && fail 'the TUI exited'
    grep -q 'this is a bug in the screen' "$out/frames/$frame" && fail 'an error boundary showed'
  fi
done
tmux capture-pane -t "$s" -p | grep -q 'SOAK-EXITED' && fail 'the TUI exited'
echo "soak: ok ($sent keys in $minutes min, seed $seed; keys in $out/keys.txt)"
