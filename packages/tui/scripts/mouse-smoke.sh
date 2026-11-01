#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# tmux smoke test of the mouse in qqq ui: writes SGR 1006 mouse sequences into the pane (what a
# terminal sends for a click, a drag or the wheel) and checks each screen's text; captures go to $OUT.
# Runs with an isolated config directory against a server with MOCK sign-in (default: the sample server).
#   packages/tui/scripts/mouse-smoke.sh [server]      OUT=dir WIDTH=120 HEIGHT=34
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
server="${1:-http://localhost:8077}"
out="${OUT:-$(mktemp -d)}"
w="${WIDTH:-120}"; h="${HEIGHT:-34}"
s="qqq-mouse-$$"
cfg="$(mktemp -d)"
fails=0
mkdir -p "$out"
cleanup() { tmux kill-session -t "$s" 2>/dev/null || true; rm -rf "$cfg"; }
trap cleanup EXIT
keys() { for k in "$@"; do if [[ $k == T:* ]]; then tmux send-keys -t "$s" -l -- "${k#T:}"; else tmux send-keys -t "$s" "$k"; fi; sleep 0.25; done; }
# SGR 1006: ESC [ < button ; column ; row M (press) / m (release); columns and rows count from 1.
# These helpers take 0-based cells, as the captures show them.
sgr() { tmux send-keys -t "$s" -l -- $'\e'"[<$1;$(($2 + 1));$(($3 + 1))$4"; }
click() { sgr 0 "$1" "$2" M; sgr 0 "$1" "$2" m; sleep 0.3; }
double() { sgr 0 "$1" "$2" M; sgr 0 "$1" "$2" m; sgr 0 "$1" "$2" M; sgr 0 "$1" "$2" m; sleep 0.4; }
right() { sgr 2 "$1" "$2" M; sgr 2 "$1" "$2" m; sleep 0.3; }
wheel() { sgr "$1" "$2" "$3" M; sleep 0.3; }   # 64 up, 65 down; +4 with Shift
drag() { sgr 0 "$1" "$2" M; local x; for ((x = $1 + 1; x <= $3; x++)); do sgr 32 "$x" "$2" M; done; sgr 0 "$3" "$2" m; sleep 0.4; }
cap() { tmux capture-pane -t "$s" -p > "$out/$1.txt"; }
# the 0-based column and row where text first appears in the last capture
# (in characters, not bytes: the box-drawing borders are several bytes each)
at() { python3 -c 'import sys
t = sys.argv[2]
for y, line in enumerate(open(sys.argv[1], encoding="utf-8")):
    x = line.find(t)
    if x >= 0:
        print(x, y)
        break
else:
    print(-1, -1)' "$out/$1.txt" "$2"; }
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
tmux new-session -d -s "$s" -x "$w" -y "$h" "cd '$pkg' && QQQ_CONFIG_DIR='$cfg/config' QQQ_STATE_DIR='$cfg/state' QQQ_CACHE_DIR='$cfg/cache' QQQ_KEYRING=file bun run src/main.tsx --no-check --server '$server'; sleep 5"
expect 01-home 'Apps' 'UI API'
read -r x y < <(at 01-home '▸ People App')
click "$x" "$y"
expect 02-tree-open '▾ People App'
read -r x y < <(at 02-tree-open 'Clone People')
double "$((x + 1))" "$y"
expect 02b-tree-double-opens '› Clone People'
keys Escape
keys T:: 'T:table query person' Enter
expect 03-grid 'records ·' 'row 1 '
# the fourth data row: header and rule above the rows, the first row two lines under the header
read -r hx hy < <(at 03-grid 'First Name')
click "$((hx + 1))" "$((hy + 5))"
expect 04-grid-click 'row 4 '
wheel 65 "$((hx + 1))" "$((hy + 5))"
expect 05-grid-wheel 'row 7 '
wheel 69 "$((hx + 1))" "$((hy + 5))"
expect 06-grid-shift-wheel 'row 7 ' 'col 5/'
double "$((hx + 1))" "$((hy + 3))"
expect 07-record 'record 2 of'
keys Escape
expect 08-back 'row 2 '
right "$((hx + 1))" "$((hy + 4))"
expect 09-actions 'Actions'
keys Escape
# the grid's status line can sit under the dialog (the F-key bar takes two rows from 30 lines): checked after it closes
expect 09b-before-drag 'row 3 '
read -r x y < <(at 09b-before-drag 'First Name')
read -r lx _ < <(at 09b-before-drag 'Last Name')
drag "$((lx - 1))" "$y" "$((lx + 6))"
expect 10-header-resize 'width'
read -r x y < <(at 10-header-resize '9Menu')
click "$((x + 1))" "$y"
expect 11-fkey-menu 'Menu  (F9)'
keys Escape
expect 11b-footer ' · ping '   # the flash from the resize has faded
read -r x y < <(at 11b-footer ' · ping ')
click 2 "$y"
expect 12-footer-servers 'Servers'
# the Shift row of the F-key bar (two rows from 30 lines): a click on Shift+F2 opens the same dialog
keys Escape
cap 12c-bar
read -r x y < <(at 12c-bar '2Servers')
click "$((x + 1))" "$y"
expect 12d-shift-servers 'Servers  (Ctrl+O)'
keys Escape F9 T:mouse
expect 12b-menu 'Mouse: on'
read -r x y < <(at 12b-menu 'Mouse: on')
double "$((x + 1))" "$y"
expect 13-mouse-off 'Mouse: off'
keys Escape   # the menu stays open after a setting
expect 14-grid-again 'row 3 '
cap 14b
read -r hx hy < <(at 14b 'First Name')
click "$((hx + 1))" "$((hy + 8))"
sleep 0.3
expect 15-off-ignores-click 'row 3 '
keys T:: 'T:mouse on' Enter
expect 16-mouse-on 'mouse on (saved)'
keys F10
expect 17-quit 'Quit qqq?'
read -r x y < <(at 17-quit 'end the program')
double "$x" "$y"
sleep 1
cap 18-ended
if tmux list-sessions 2>/dev/null | grep -q "^$s:" && grep -qF 'records ·' "$out/18-ended.txt"; then echo "FAIL 18-ended (still running)"; fails=$((fails + 1)); else echo "ok   18-ended"; fi
echo "captures in $out"
[[ $fails == 0 ]] || { echo "$fails failed"; exit 1; }
