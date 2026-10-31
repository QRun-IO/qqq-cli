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
[[ -d node_modules ]] || bun install
case "${1:-run}" in
   run) exec bun run src/main.tsx ;;
   binary) [[ -x dist/qqq-tui-spike-darwin-arm64 ]] || bun run build.ts darwin; exec ./dist/qqq-tui-spike-darwin-arm64 ;;
   test) exec bun test ;;
   *) echo "usage: $0 [run|binary|test]"; exit 2 ;;
esac
