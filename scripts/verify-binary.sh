#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Smoke test of one qqq binary (or any qqq on the PATH): version and build, completion, the terminal
# UI's check, and with --server the commands a user runs first: login, whoami, a query and a process
# run. CI lanes run it on the binary they built; run it by hand after a release on what was downloaded.
#
#   scripts/verify-binary.sh dist/qqq-darwin-arm64
#   scripts/verify-binary.sh dist/qqq-linux-x64 --server http://localhost:8077
#   scripts/verify-binary.sh qqq --server https://qqq.example.com --profile prod --keyring os
#
# Options:
#   --server URL      also sign in and run whoami, query and process run against this server
#                     (MOCK and anonymous servers sign in without a browser; others need --profile of
#                     an existing sign-in)
#   --profile NAME    use this existing profile instead of a temporary one
#   --keyring os      keep the temporary sign-in in the OS keyring (removed again at the end) instead of
#                     a file in a temporary config directory
#   --cli-only        the binary is a CLI-only build: do not expect "with ui" or run ui --check
#   QQQ_VERIFY_TABLE (person), QQQ_VERIFY_PROCESS (sleepInteractive), QQQ_VERIFY_VALUES (sleepMillis=500)
#                     what to query and run; the defaults fit the QQQ sample app
# Exit 0 when every step passed; the failing steps are listed otherwise.

set -uo pipefail

bin="${1:?usage: verify-binary.sh <qqq binary> [--server URL] [--profile NAME] [--keyring os] [--cli-only]}"
shift
server=""; profile=""; keyring="file"; ui=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) server="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --keyring) keyring="$2"; shift 2 ;;
    --cli-only) ui=0; shift ;;
    *) echo "verify-binary: unknown option $1" >&2; exit 2 ;;
  esac
done
table="${QQQ_VERIFY_TABLE:-person}"
process_name="${QQQ_VERIFY_PROCESS:-sleepInteractive}"
values="${QQQ_VERIFY_VALUES:-sleepMillis=500}"

if [[ -z "$profile" ]]; then
  work="$(mktemp -d)"
  export QQQ_CONFIG_DIR="$work/config" QQQ_CACHE_DIR="$work/cache"
  [[ "$keyring" == file ]] && export QQQ_KEYRING=file
  profile="verify-$$"
  temporary=1
else
  temporary=0
fi
export QQQ_OUTPUT=json

failed=()
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; failed+=("$1"); }
# step NAME EXPECTED-REGEX COMMAND...: runs the command, checks exit 0 and that the output matches
step() {
  local name="$1" want="$2"; shift 2
  local out
  if out="$("$@" 2>&1)" && grep -Eq -- "$want" <<<"$out"; then pass "$name"; else fail "$name" "$(head -c 400 <<<"$out")"; fi
}

step "version" '^qqq [0-9]+\.[0-9]+\.[0-9]+' "$bin" --version
if [[ $ui == 1 ]]; then
  step "version says with ui" 'binary with ui' "$bin" --version
else
  pass "version (CLI-only build, ui not expected)"
fi
step "completion candidates" '^table$' "$bin" __complete -- ta
for shell in bash zsh fish pwsh; do step "completion $shell" 'qqq' "$bin" completion "$shell"; done
if [[ $ui == 1 ]]; then
  step "ui --check names the build" 'binary with ui.*runtime \(embedded\)' "$bin" ui --check
else
  # shellcheck disable=SC2016  # $0 is expanded by the inner bash
  step "ui says how to get the UI" 'not part of this installation' bash -c '"$0" ui; true' "$bin"
fi

if [[ -n "$server" ]]; then
  if [[ $temporary == 1 ]]; then
    step "login (session)" 'Signed in' "$bin" login --server "$server" --profile "$profile"
  fi
  step "doctor build line" '"build": "qqq ' "$bin" --profile "$profile" doctor
  step "whoami" '"apiVersion"' "$bin" --profile "$profile" whoami
  step "table query $table" '"values"' "$bin" --profile "$profile" table query "$table" -l 2
  args=(); IFS=',' read -ra pairs <<<"$values"; for p in "${pairs[@]}"; do args+=(-v "$p"); done
  step "process run $process_name" '"type": "COMPLETE"' "$bin" --profile "$profile" process run "$process_name" "${args[@]}"
  if [[ $temporary == 1 ]]; then
    step "logout" 'Signed out' "$bin" --profile "$profile" logout
    "$bin" config profile remove "$profile" >/dev/null 2>&1 || true
  fi
fi
[[ $temporary == 1 ]] && rm -rf "$work"

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "verify-binary: ${#failed[@]} failed: ${failed[*]}"
  exit 1
fi
echo "verify-binary: ok"
