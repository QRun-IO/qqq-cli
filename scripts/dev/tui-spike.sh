#!/usr/bin/env bash
# Run the M0 OpenTUI spike from source against the local sample server.
#   tui-spike.sh            run from source with bun
#   tui-spike.sh binary     run the compiled macOS binary (bun run build.ts darwin first)
#   tui-spike.sh test       run the in-memory tests
set -euo pipefail
self="${BASH_SOURCE[0]}"; while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
here="$(cd "$(dirname "$self")" && pwd)"
pkg="$(cd "$here/../../packages/tui-spike" && pwd)"
export QQQ_SERVER="${QQQ_SERVER:-http://localhost:${QQQ_SAMPLE_PORT:-8077}}"
export QQQ_SPIKE_REPORT="${QQQ_SPIKE_REPORT:-${XDG_STATE_HOME:-$HOME/.local/state}/qqq-dev/spike-perf.json}"
mkdir -p "$(dirname "$QQQ_SPIKE_REPORT")"
cd "$pkg"
bun install --silent 2>/dev/null || bun install
build="$(git -C "$pkg" rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git -C "$pkg" rev-parse --short HEAD 2>/dev/null)"
[[ -n "$(git -C "$pkg" status --porcelain -- . 2>/dev/null)" ]] && build="$build+local"
export QQQ_SPIKE_BUILD="$build"
echo "qqq-tui-spike: $build ($(git -C "$pkg" log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M' 2>/dev/null)) · server $QQQ_SERVER"
case "${1:-run}" in
   run) exec bun run src/main.tsx ;;
   binary) [[ -x dist/qqq-tui-spike-darwin-arm64 ]] || bun run build.ts darwin; exec ./dist/qqq-tui-spike-darwin-arm64 ;;
   test) exec bun test ;;
   *) echo "usage: $0 [run|binary|test]"; exit 2 ;;
esac
