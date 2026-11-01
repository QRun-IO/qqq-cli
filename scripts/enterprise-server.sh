#!/usr/bin/env bash
# Start, stop or inspect the local "enterprise" QQQ test server: qqq-all's enterprise profile
# (every locally runnable qbit + the qqq sample app) on port 8078, MOCK auth (any user, admin).
#
#   enterprise-server.sh [--start] | --status | --stop | --build | --log | --dir
#
# It only ever signals the pid it started (pid file in the state dir) and the two Docker
# containers it names (qqq-enterprise-redis, qqq-enterprise-opensearch). It never touches the
# 8077 sample server. A MinIO container (qqq-enterprise-minio, :9310) backs the Object Storage qbit
# (collaboration attachments); its credentials are generated into a private state directory on first start.
#
# Everything the script writes and reads back (pid file, log, data, MinIO credentials) lives under
# ${XDG_STATE_HOME:-$HOME/.local/state}/qqq-enterprise (mode 0700, owned by you), never in a shared temp dir.
# A file that already exists is used only if you own it, it is not a symlink and (for the credentials)
# its mode is 0600; the credentials file is parsed for its two keys, never sourced. Files that an earlier
# version left under ${TMPDIR} are not migrated or read: delete them, and the MinIO container
# (docker rm -f qqq-enterprise-minio) if it should get new credentials.
#
# Env:
#   QQQ_ALL_ENTERPRISE_DIR  qqq-all checkout on feat/enterprise-terminal-test
#                           (default ../.worktrees/qqq-all-enterprise next to this repo's parent)
#   QQQ_ENTERPRISE_M2       Maven local repo holding the qqq build to run against
#                           (default ../.worktrees/qqq-fixes-m2: UI API 1.9.0 fix branch)
#   QQQ_SAMPLE_CLASSES      compiled qqq-sample-project classes to merge in
#                           (default ../.worktrees/qqq-fixes/qqq-sample-project/target/classes;
#                           missing = the sample app is left out)
#   QQQ_ENTERPRISE_STATE    pid, log and data directory (default <state root>/<port>, e.g. ~/.local/state/qqq-enterprise/8078)
#   QQQ_ENTERPRISE_MINIO_ENV  MinIO credentials file (default <state root>/minio.env)
#   QQQ_ENTERPRISE_PORT     HTTP port (default 8078)
#   QQQ_ENTERPRISE_DOCKER   0 = do not start the Redis/OpenSearch/MinIO containers (quick search, redis
#                           and object storage are then left out of the instance)
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
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/qqq-enterprise"
state_dir="${QQQ_ENTERPRISE_STATE:-$state_root/$port}"
state_dir="${state_dir%/}"
pid_file="$state_dir/server.pid"
log_file="$state_dir/server.log"
data_dir="$state_dir/data"
jar="$qqq_all/qqq-all-app/target/qqq-all-app.jar"
redis_name="qqq-enterprise-redis";        redis_port=6390
search_name="qqq-enterprise-opensearch";  search_port=9210
minio_name="qqq-enterprise-minio";        minio_port=9310
minio_env="${QQQ_ENTERPRISE_MINIO_ENV:-$state_root/minio.env}"   # generated credentials for the shared container, 0600, never in git
minio_bucket="qqq-enterprise-attachments"
umask 077

die() { echo "$*" >&2; exit 1; }

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }   # GNU, then BSD/macOS

# a directory we create (mode 0700) or already own and that is not a symlink; group/other get no access
private_dir()
{
   # shellcheck disable=SC2174  # parents keep the default mode; the leaf is checked and chmod-ed below
   mkdir -p -m 700 "$1"
   [[ -d "$1" && -O "$1" && ! -L "$1" ]] || die "refusing untrusted state directory: $1"
   chmod 700 "$1"
}

# an existing file we own, that is not a symlink, and (optionally) has exactly the given mode
trusted_file() # path [mode]
{
   [[ -O "$1" && ! -L "$1" && -f "$1" ]] || die "refusing untrusted file: $1"
   [[ -z "${2:-}" || "$(file_mode "$1")" == "$2" ]] || die "refusing file with mode $(file_mode "$1") (want $2): $1"
}

private_dir "$state_root"
private_dir "$state_dir"
[[ "$(dirname "$minio_env")" == "$state_root" ]] || mkdir -p "$(dirname "$minio_env")"

# the pid in the pid file: status 1 = no pid file, 2 = file untrusted or not a number (message on stderr)
read_pid()
{
   [[ -e "$pid_file" || -L "$pid_file" ]] || return 1
   if [[ ! -O "$pid_file" || -L "$pid_file" || ! -f "$pid_file" ]]; then echo "refusing untrusted pid file: $pid_file" >&2; return 2; fi
   local pid; pid="$(head -n 1 "$pid_file")"
   if [[ ! "$pid" =~ ^[0-9]+$ ]]; then echo "refusing pid file that does not hold a number: $pid_file" >&2; return 2; fi
   echo "$pid"
}

# value of KEY in the credentials file: first "KEY=" line, letters, digits, _ and - only, never empty
env_value() # file key
{
   local value; value="$(grep -m1 "^$2=" "$1" | cut -d= -f2-)" || true
   [[ -n "$value" && "$value" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid or missing $2 in $1"
   echo "$value"
}

# create the credentials file if it is absent (noclobber: never follows a pre-planted symlink), then
# check it and read its two values into S3_ACCESS_KEY and S3_SECRET_KEY
load_minio_env()
{
   if [[ ! -e "$minio_env" && ! -L "$minio_env" ]]; then
      ( set -C; printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\n' "qqq-$(openssl rand -hex 6)" "$(openssl rand -hex 24)" > "$minio_env" ) \
         || die "could not create $minio_env"
   fi
   [[ -O "$minio_env" && ! -L "$minio_env" ]] || die "refusing untrusted env file: $minio_env"
   trusted_file "$minio_env" 600
   S3_ACCESS_KEY="$(env_value "$minio_env" S3_ACCESS_KEY)" || exit 1
   S3_SECRET_KEY="$(env_value "$minio_env" S3_SECRET_KEY)" || exit 1
}

running()
{
   local pid status=0
   pid="$(read_pid)" || status=$?
   [[ $status -ne 2 ]] || exit 1
   [[ $status -eq 0 ]] && kill -0 "$pid" 2>/dev/null
}
use_docker() { [[ "${QQQ_ENTERPRISE_DOCKER:-1}" != "0" ]] && command -v docker > /dev/null && docker info > /dev/null 2>&1; }

container_up() # name image port container-port [docker args...] [-- command args...]
{
   local name="$1" image="$2" host_port="$3" container_port="$4"; shift 4
   local run_args=() command_args=()
   while [[ $# -gt 0 && "$1" != "--" ]]; do run_args+=("$1"); shift; done
   [[ "${1:-}" == "--" ]] && { shift; command_args=("$@"); }
   if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == "true" ]]; then return 0; fi
   if docker inspect "$name" > /dev/null 2>&1; then docker start "$name" > /dev/null; return 0; fi
   docker run -d --name "$name" -p "127.0.0.1:$host_port:$container_port" "${run_args[@]}" "$image" "${command_args[@]}" > /dev/null
}

build()
{
   [[ -f "$qqq_all/pom.xml" ]] || { echo "no qqq-all checkout at $qqq_all (set QQQ_ALL_ENTERPRISE_DIR)"; exit 1; }
   echo "building qqq-all-app (enterprise profile) against $m2 …"
   mvn -B -q -f "$qqq_all/pom.xml" -Dmaven.repo.local="$m2" -DskipTests -pl qqq-all-app -am package
   echo "built $jar"
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0   # sourced (by the test): definitions only

case "${1:---start}" in
   --build|build) build ;;
   --start|start)
      if running; then echo "already running (pid $(read_pid)) on http://localhost:$port"; exit 0; fi
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
         load_minio_env
         echo "starting MinIO ($minio_name, :$minio_port) with bucket $minio_bucket"
         container_up "$minio_name" minio/minio:latest "$minio_port" 9000 \
            -e "MINIO_ROOT_USER=$S3_ACCESS_KEY" -e "MINIO_ROOT_PASSWORD=$S3_SECRET_KEY" -- server /data
         if [[ "$(docker inspect -f '{{.State.Running}}' "$minio_name" 2>/dev/null)" != "true" ]]; then echo "MinIO did not start"; exit 1; fi
         for _ in $(seq 1 30); do curl -sf -m 2 "http://127.0.0.1:$minio_port/minio/health/live" > /dev/null 2>&1 && break; sleep 1; done
         docker exec "$minio_name" sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" > /dev/null && mc mb -p "local/$1" > /dev/null' sh "$minio_bucket"
         env_args+=(S3_ENDPOINT="http://127.0.0.1:$minio_port" S3_ACCESS_KEY="$S3_ACCESS_KEY" S3_SECRET_KEY="$S3_SECRET_KEY"
            S3_ATTACHMENTS_BUCKET="$minio_bucket")
      else
         echo "Docker not used: quick search, redis and object storage are left out"
      fi
      classpath="$jar"
      if [[ -d "$sample_classes" ]]; then classpath="$jar:$sample_classes"; else echo "no sample classes at $sample_classes: sample app left out"; fi
      echo "starting enterprise server on port $port (log: $log_file, data: $data_dir)"
      nohup env "${env_args[@]}" java -cp "$classpath" com.kingsrook.qqq.all.ProfileLauncher > "$log_file" 2>&1 &
      echo $! > "$pid_file"; chmod 600 "$pid_file"
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
         pid="$(read_pid)"
         kill "$pid" 2>/dev/null || true
         for _ in $(seq 1 15); do running || break; sleep 1; done
         running && kill -9 "$pid" 2>/dev/null || true
         echo "stopped pid $pid"
      else
         echo "not running (no live pid in $pid_file)"
      fi
      rm -f "$pid_file"
      if use_docker; then docker stop "$redis_name" "$search_name" "$minio_name" > /dev/null 2>&1 && echo "stopped containers $redis_name $search_name $minio_name" || true; fi
      ;;
   --status|status)
      if running; then
         echo "running: pid $(read_pid) on http://localhost:$port"
         curl -s -m 3 "http://localhost:$port/qqq/v1/version" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UI API", d["apiVersion"]); print("extensions:", ", ".join(e["name"]+" "+e.get("version","?") for e in d.get("extensions",[])))' 2>/dev/null || echo "(not answering on /qqq/v1/version)"
      else
         echo "not running"
      fi
      echo "log: $log_file"
      echo "state: $state_dir"
      ;;
   --dir|dir) echo "$state_dir" ;;
   --log|log) tail -n 100 -f "$log_file" ;;
   *) echo "usage: $0 [--start] | --status | --stop | --build | --log | --dir"; exit 2 ;;
esac
