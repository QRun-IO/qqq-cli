#!/usr/bin/env bash
# Start, stop or inspect a virtual print agent for a local QQQ server with the printing qbit (the
# enterprise test server on port 8078 by default). It runs qqq-print-agent's virtual file printer
# (tools/virtual-agent, Node.js 24+): it enrolls itself the first time (native "Enroll a print
# device" process), exposes one printer ("Virtual PDF printer", PDF and ZPL), approves it (local
# testing only), and writes every print job it receives to a directory instead of paper.
#
#   print-agent.sh [--start] | --status | --stop | --log | --dir
#
# It only ever signals the pid it started (pid file in the state dir).
#
# Env:
#   QQQ_PRINT_SERVER     the QQQ server (default http://localhost:8078)
#   QQQ_PRINT_AGENT_DIR  qqq-print-agent checkout with tools/virtual-agent
#                        (default <QRun-IO>/qqq-print-agent next to this repo)
#   QQQ_PRINT_STATE      pid, log and device identity (default ${TMPDIR:-/tmp}/qqq-print-agent-<port>)
#   QQQ_PRINT_OUT        where printed documents go (default ~/Downloads, as downloads and exports;
#                        the agent's own default too); --dir prints the folder in use
#   QQQ_PRINT_PRINTER_NAME, QQQ_PRINT_DEVICE_NAME   names shown in QQQ
#
# Then, from the CLI:   qqq printer list; qqq print person 1 --printer "Virtual PDF printer"
# or in qqq ui: open a person, press p (Print…), choose the printer.
set -euo pipefail

self="${BASH_SOURCE[0]}"; while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
here="$(cd "$(dirname "$self")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
qrun_root="$(cd "$repo_root/.." && pwd)"; [[ "$(basename "$qrun_root")" == ".worktrees" ]] && qrun_root="$(cd "$qrun_root/.." && pwd)"
server="${QQQ_PRINT_SERVER:-http://localhost:8078}"
agent_dir="${QQQ_PRINT_AGENT_DIR:-$qrun_root/qqq-print-agent}"
agent="$agent_dir/tools/virtual-agent/virtual-agent.mjs"
port="$(node -e 'const u=new URL(process.argv[1]); console.log(u.port || (u.protocol === "https:" ? 443 : 80))' "$server")"
tmp_root="${TMPDIR:-/tmp}"; state_dir="${QQQ_PRINT_STATE:-${tmp_root%/}/qqq-print-agent-$port}"
state_dir="${state_dir%/}"
out_dir="${QQQ_PRINT_OUT:-$HOME/Downloads}"
pid_file="$state_dir/agent.pid"
log_file="$state_dir/agent.log"
identity="$state_dir/device.json"
mkdir -p "$state_dir"

running() { [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }

case "${1:---start}" in
   --start|start)
      if running; then echo "already running (pid $(cat "$pid_file")) against $server; printing to $out_dir"; exit 0; fi
      [[ -f "$agent" ]] || { echo "no virtual agent at $agent (check out qqq-print-agent with tools/virtual-agent, or set QQQ_PRINT_AGENT_DIR)"; exit 1; }
      curl -sf -m 3 "$server/qqq/v1/version" | grep -q '"name":"printing"' || { echo "$server does not list the printing extension (is it the enterprise server with printing?)"; exit 1; }
      first=(); [[ -f "$identity" ]] || first=(--enroll --approve)
      echo "starting the virtual print agent against $server (log: $log_file, printing to: $out_dir)"
      nohup node "$agent" --server "$server" --out "$out_dir" --state "$identity" "${first[@]}" > "$log_file" 2>&1 &
      echo $! > "$pid_file"
      for _ in $(seq 1 30); do
         if grep -q '^.* ready ' "$log_file" 2>/dev/null; then
            sleep 1
            echo "ready: $(grep -c . "$log_file") log lines; printer \"${QQQ_PRINT_PRINTER_NAME:-Virtual PDF printer}\""
            echo "try:   qqq --server $server printer list    then   qqq --server $server print person 1"
            exit 0
         fi
         if ! running; then echo "the agent exited; see $log_file"; tail -20 "$log_file"; rm -f "$pid_file"; exit 1; fi
         sleep 1
      done
      echo "timed out waiting for the agent; see $log_file"; exit 1
      ;;
   --stop|stop)
      if running; then kill "$(cat "$pid_file")" 2>/dev/null || true; echo "stopped pid $(cat "$pid_file")"; else echo "not running"; fi
      rm -f "$pid_file"
      ;;
   --status|status)
      if running; then echo "running: pid $(cat "$pid_file") against $server"; else echo "not running"; fi
      echo "printed: $(find "$out_dir" -maxdepth 1 \( -name '*.pdf' -o -name '*.zpl' \) 2>/dev/null | wc -l | tr -d ' ') documents in $out_dir"
      echo "log: $log_file"
      ;;
   --log|log) tail -n 100 -f "$log_file" ;;
   --dir|dir) echo "$out_dir" ;;
   *) echo "usage: $0 [--start] | --status | --stop | --log | --dir"; exit 2 ;;
esac
