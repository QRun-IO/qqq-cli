#!/usr/bin/env bash
# Tests the enterprise server script's file checks and credential parsing with throwaway files.
# Starts and stops nothing (the script is sourced for its functions only). Usage: scripts/enterprise-server.test.sh
# shellcheck disable=SC2016  # the single-quoted $( ) in the test data is data, not code
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export XDG_STATE_HOME="$work/state" QQQ_ENTERPRISE_MINIO_ENV="$work/state/qqq-enterprise/minio.env"
fails=0
# runs a command in a subshell (the script's checks exit); prints PASS/FAIL against the expected status
check() { local want="$1" name="$2"; shift 2; ( "$@" ) > "$work/out" 2>&1; local got=$?
   if [[ ( $want == ok && $got -eq 0 ) || ( $want == fail && $got -ne 0 ) ]]; then echo "PASS $name"; else echo "FAIL $name (status $got): $(cat "$work/out")"; fails=$((fails+1)); fi; }
# shellcheck source=scripts/enterprise-server.sh disable=SC1091,SC2154
source "$here/enterprise-server.sh"
set +e   # the sourced script turns errexit on; check() reads statuses itself
env="$minio_env"

check ok   "state root is private"      test "$(file_mode "$state_root")" = 700
check ok   "creates the env file"       load_minio_env
check ok   "created file is 0600"       test "$(file_mode "$env")" = 600
parsed_keys() { load_minio_env && [[ -n "$S3_ACCESS_KEY" && -n "$S3_SECRET_KEY" ]]; }
check ok   "parses generated keys"      parsed_keys
printf 'S3_ACCESS_KEY=abc\nS3_SECRET_KEY=def-_9\nEVIL=$(touch %s/pwned)\n' "$work" > "$env"; chmod 600 "$env"
check ok   "valid file, extra key ignored" load_minio_env
check ok   "nothing executed"           test ! -e "$work/pwned"
chmod 644 "$env";                       check fail "mode 0644 refused" load_minio_env
chmod 600 "$env"
printf 'S3_ACCESS_KEY=\nS3_SECRET_KEY=def\n' > "$env";             check fail "empty value refused" load_minio_env
printf 'S3_ACCESS_KEY=a b\nS3_SECRET_KEY=def\n' > "$env";          check fail "space in value refused" load_minio_env
printf 'S3_ACCESS_KEY=a$(x)\nS3_SECRET_KEY=def\n' > "$env";        check fail "shell syntax refused" load_minio_env
printf 'S3_ACCESS_KEY=abc\n' > "$env";                             check fail "missing key refused" load_minio_env
printf 'S3_ACCESS_KEY=abc\nS3_SECRET_KEY=def\n' > "$work/real"; chmod 600 "$work/real"
rm -f "$env"; ln -s "$work/real" "$env";                           check fail "symlink refused" load_minio_env
rm -f "$env"; ln -s "$work/missing" "$env";                        check fail "dangling symlink not followed" load_minio_env
check ok   "dangling symlink not written through" test ! -e "$work/missing"
rm -f "$env"

pid_file="$work/server.pid"
check fail "no pid file"                read_pid
echo 12345 > "$pid_file";               check ok   "numeric pid" test "$(read_pid)" = 12345
echo '1; rm -rf x' > "$pid_file";       check fail "non-numeric pid refused" read_pid
: > "$pid_file";                        check fail "empty pid refused" read_pid
rm -f "$pid_file"; ln -s "$work/real" "$pid_file"; check fail "pid symlink refused" read_pid

if [[ $fails -eq 0 ]]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
