#!/usr/bin/env bash
# Start, stop or inspect the QQQ sample server (UI API, mock auth) used to try the terminal clients.
#
#   sample-server.sh start|stop|restart|status|log|build
#
# Env: QQQ_DEV_WORKTREE (qqq checkout on develop; default ../.worktrees/qqq-develop next to this repo's parent)
#      QQQ_SAMPLE_PORT (default 8077)
set -euo pipefail

self="${BASH_SOURCE[0]}"; while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
here="$(cd "$(dirname "$self")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
worktree="${QQQ_DEV_WORKTREE:-$(cd "$repo_root/.." && pwd)/.worktrees/qqq-develop}"
port="${QQQ_SAMPLE_PORT:-8077}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/qqq-dev"
pid_file="$state_dir/sample-server.pid"
log_file="$state_dir/sample-server.log"
mkdir -p "$state_dir"

running() { [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }

case "${1:-status}" in
   build)
      echo "Installing qqq modules from $worktree into ~/.m2 (tests skipped)…"
      mvn -B -q -f "$worktree/pom.xml" -DskipTests -Dmaven.javadoc.skip=true -Dcheckstyle.skip=true install
      echo "done"
      ;;
   start)
      if running; then echo "already running (pid $(cat "$pid_file")) on http://localhost:$port"; exit 0; fi
      [[ -d "$worktree/qqq-sample-project" ]] || { echo "no qqq checkout at $worktree (set QQQ_DEV_WORKTREE)"; exit 1; }
      echo "starting sample server from $worktree on port $port (log: $log_file)"
      cd "$worktree/qqq-sample-project"
      nohup mvn -B -q -f "$worktree/qqq-sample-project/pom.xml" -DskipTests -Dcheckstyle.skip=true compile exec:java \
         -Dexec.mainClass=com.kingsrook.sampleapp.SampleJavalinServer \
         -Dqqq.sample.mockAuthentication=true -Dqqq.sample.port="$port" > "$log_file" 2>&1 &
      echo $! > "$pid_file"
      for _ in $(seq 1 120); do
         if curl -sf -m 2 "http://localhost:$port/qqq/v1/version" > /dev/null 2>&1; then
            echo "ready: http://localhost:$port  (UI API $(curl -s "http://localhost:$port/qqq/v1/version" | sed 's/.*"apiVersion":"\([^"]*\)".*/\1/'))"
            echo "web UI: http://localhost:$port/   mock auth, in-memory H2, data resets on restart"
            exit 0
         fi
         if ! running; then echo "server exited early; see $log_file"; tail -20 "$log_file"; exit 1; fi
         sleep 2
      done
      echo "timed out waiting for the server; see $log_file"; exit 1
      ;;
   stop)
      if running; then
         pkill -P "$(cat "$pid_file")" 2>/dev/null || true
         kill "$(cat "$pid_file")" 2>/dev/null || true
         pkill -f "com.kingsrook.sampleapp.SampleJavalinServer" 2>/dev/null || true
         rm -f "$pid_file"; echo "stopped"
      else
         pkill -f "com.kingsrook.sampleapp.SampleJavalinServer" 2>/dev/null && echo "stopped (stray process)" || echo "not running"
         rm -f "$pid_file"
      fi
      ;;
   restart) "$0" stop; "$0" start ;;
   status)
      if running; then echo "running (pid $(cat "$pid_file")) on http://localhost:$port"; curl -s -m 2 "http://localhost:$port/qqq/v1/version" | cut -c1-120; echo; else echo "not running"; fi
      ;;
   log) tail -f "$log_file" ;;
   *) echo "usage: $0 start|stop|restart|status|log|build"; exit 2 ;;
esac
