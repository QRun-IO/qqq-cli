#!/usr/bin/env bash
# Start, stop or inspect the local "enterprise" QQQ test server: qqq-all's enterprise profile
# (every locally runnable qbit + the qqq sample app) on port 8078, MOCK auth (any user, admin).
#
#   enterprise-server.sh [--start] | --status | --stop | --build | --log
#
# It only ever signals the pid it started (pid file in the state dir) and the two Docker
# containers it names (qqq-enterprise-redis, qqq-enterprise-opensearch). It never touches the
# 8077 sample server.
#
# Env:
#   QQQ_ALL_ENTERPRISE_DIR  qqq-all checkout on feat/enterprise-terminal-test
#                           (default ../.worktrees/qqq-all-enterprise next to this repo's parent)
#   QQQ_ENTERPRISE_M2       Maven local repo holding the qqq build to run against
#                           (default ../.worktrees/qqq-fixes-m2: UI API 1.9.0 fix branch)
#   QQQ_SAMPLE_CLASSES      compiled qqq-sample-project classes to merge in
#                           (default ../.worktrees/qqq-fixes/qqq-sample-project/target/classes;
#                           missing = the sample app is left out)
#   QQQ_ENTERPRISE_STATE    pid, log and data directory (default ${TMPDIR:-/tmp}/qqq-enterprise-8078)
#   QQQ_ENTERPRISE_PORT     HTTP port (default 8078)
#   QQQ_ENTERPRISE_DOCKER   0 = do not start Redis/OpenSearch containers (quick search and redis are
#                           then left out of the instance)
#   QQQ_ALL_ENTERPRISE_EXCLUDE  comma-separated feature names to leave out (see EnterpriseFeatures)
set -euo pipefail

self="${BASH_SOURCE[0]}"; while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
here="$(cd "$(dirname "$self")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
# worktrees live in <QRun-IO>/.worktrees; this repo is either <QRun-IO>/qqq-cli or <QRun-IO>/.worktrees/<name>
qrun_root="$(cd "$repo_root/.." && pwd)"; [[ "$(basename "$qrun_root")" == ".worktrees" ]] && qrun_root="$(cd "$qrun_root/.." && pwd)"
qqq_all="${QQQ_ALL_ENTERPRISE_DIR:-$qrun_root/.worktrees/qqq-all-enterprise}"
m2="${QQQ_ENTERPRISE_M2:-$qrun_root/.worktrees/qqq-fixes-m2}"
sample_classes="${QQQ_SAMPLE_CLASSES:-$qrun_root/.worktrees/qqq-fixes/qqq-sample-project/target/classes}"
port="${QQQ_ENTERPRISE_PORT:-8078}"
tmp_root="${TMPDIR:-/tmp}"; state_dir="${QQQ_ENTERPRISE_STATE:-${tmp_root%/}/qqq-enterprise-$port}"
state_dir="${state_dir%/}"
pid_file="$state_dir/server.pid"
log_file="$state_dir/server.log"
data_dir="$state_dir/data"
jar="$qqq_all/qqq-all-app/target/qqq-all-app.jar"
redis_name="qqq-enterprise-redis";        redis_port=6390
search_name="qqq-enterprise-opensearch";  search_port=9210
mkdir -p "$state_dir"

running() { [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }
use_docker() { [[ "${QQQ_ENTERPRISE_DOCKER:-1}" != "0" ]] && command -v docker > /dev/null && docker info > /dev/null 2>&1; }

container_up() # name image port container-port [docker args...]
{
   local name="$1" image="$2" host_port="$3" container_port="$4"; shift 4
   if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == "true" ]]; then return 0; fi
   if docker inspect "$name" > /dev/null 2>&1; then docker start "$name" > /dev/null; return 0; fi
   docker run -d --name "$name" -p "127.0.0.1:$host_port:$container_port" "$@" "$image" > /dev/null
}

build()
{
   [[ -f "$qqq_all/pom.xml" ]] || { echo "no qqq-all checkout at $qqq_all (set QQQ_ALL_ENTERPRISE_DIR)"; exit 1; }
   echo "building qqq-all-app (enterprise profile) against $m2 …"
   mvn -B -q -f "$qqq_all/pom.xml" -Dmaven.repo.local="$m2" -DskipTests -pl qqq-all-app -am package
   echo "built $jar"
}

case "${1:---start}" in
   --build|build) build ;;
   --start|start)
      if running; then echo "already running (pid $(cat "$pid_file")) on http://localhost:$port"; exit 0; fi
      if curl -sf -m 2 "http://localhost:$port/qqq/v1/version" > /dev/null 2>&1; then
         echo "port $port is already serving something that this script did not start; not starting"; exit 1
      fi
      [[ -f "$jar" ]] || build
      env_args=(QQQ_ALL_PROFILE=enterprise QQQ_ALL_PORT="$port" QQQ_ALL_DATA_DIR="$data_dir")
      if use_docker; then
         echo "starting Redis ($redis_name, :$redis_port) and OpenSearch ($search_name, :$search_port) containers"
         container_up "$redis_name" redis:7.4-alpine "$redis_port" 6379
         container_up "$search_name" opensearchproject/opensearch:2.19.1 "$search_port" 9200 \
            -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true -e "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"
         for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$search_port/_cluster/health" > /dev/null 2>&1 && break; sleep 2; done
         env_args+=(QQQ_ALL_OPENSEARCH_HOST=127.0.0.1 QQQ_ALL_OPENSEARCH_PORT="$search_port"
            QQQ_ALL_REDIS_HOST=127.0.0.1 QQQ_ALL_REDIS_PORT="$redis_port")
      else
         echo "Docker not used: quick search and redis are left out"
      fi
      classpath="$jar"
      if [[ -d "$sample_classes" ]]; then classpath="$jar:$sample_classes"; else echo "no sample classes at $sample_classes: sample app left out"; fi
      echo "starting enterprise server on port $port (log: $log_file, data: $data_dir)"
      nohup env "${env_args[@]}" java -cp "$classpath" com.kingsrook.qqq.all.ProfileLauncher > "$log_file" 2>&1 &
      echo $! > "$pid_file"
      for _ in $(seq 1 90); do
         if curl -sf -m 2 "http://localhost:$port/qqq/v1/version" > /dev/null 2>&1; then
            echo "ready: http://localhost:$port  (UI API $(curl -s "http://localhost:$port/qqq/v1/version" | sed 's/.*"apiVersion":"\([^"]*\)".*/\1/'))"
            echo "login: qqq login --server http://localhost:$port   (mock auth: any user is an all-access admin)"
            exit 0
         fi
         if ! running; then echo "server exited early; see $log_file"; tail -20 "$log_file"; rm -f "$pid_file"; exit 1; fi
         sleep 2
      done
      echo "timed out waiting for the server; see $log_file"; exit 1
      ;;
   --stop|stop)
      if running; then
         kill "$(cat "$pid_file")" 2>/dev/null || true
         for _ in $(seq 1 15); do running || break; sleep 1; done
         running && kill -9 "$(cat "$pid_file")" 2>/dev/null || true
         echo "stopped pid $(cat "$pid_file")"
      else
         echo "not running (no live pid in $pid_file)"
      fi
      rm -f "$pid_file"
      if use_docker; then docker stop "$redis_name" "$search_name" > /dev/null 2>&1 && echo "stopped containers $redis_name $search_name" || true; fi
      ;;
   --status|status)
      if running; then
         echo "running: pid $(cat "$pid_file") on http://localhost:$port"
         curl -s -m 3 "http://localhost:$port/qqq/v1/version" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UI API", d["apiVersion"]); print("extensions:", ", ".join(e["name"]+" "+e.get("version","?") for e in d.get("extensions",[])))' 2>/dev/null || echo "(not answering on /qqq/v1/version)"
      else
         echo "not running"
      fi
      echo "log: $log_file"
      ;;
   --log|log) tail -n 100 -f "$log_file" ;;
   *) echo "usage: $0 [--start] | --status | --stop | --build | --log"; exit 2 ;;
esac
