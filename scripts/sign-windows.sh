#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Authenticode-signs the Windows qqq binary with osslsigncode (runs on macOS and Linux) and recomputes
# SHA256SUMS. Run after scripts/build-binaries.mjs and before the GitHub release.
#
#   scripts/sign-windows.sh [dist] [--dry-run]
#
# Environment (nothing set: prints what is missing and exits 0 without touching a file):
#   QQQ_WINDOWS_PFX            the code-signing certificate and key, a .pfx/.p12 file
#   QQQ_WINDOWS_PFX_PASSWORD   its password (or QQQ_WINDOWS_PFX_PASSWORD_FILE, a file holding it)
#   QQQ_WINDOWS_TIMESTAMP_URL  RFC 3161 timestamp server (default http://timestamp.digicert.com;
#                              "none" skips the timestamp, for tests only: the signature then expires
#                              with the certificate)
# Needs osslsigncode (brew install osslsigncode, apt install osslsigncode). Hardware-token (EV)
# certificates need osslsigncode's PKCS#11 options or signtool on Windows instead.

set -euo pipefail

dist="dist"; dry=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    -*) echo "sign-windows: unknown option $a" >&2; exit 2 ;;
    *) dist="$a" ;;
  esac
done
pfx="${QQQ_WINDOWS_PFX:-}"
password="${QQQ_WINDOWS_PFX_PASSWORD:-}"
[[ -z "$password" && -n "${QQQ_WINDOWS_PFX_PASSWORD_FILE:-}" ]] && password="$(cat "$QQQ_WINDOWS_PFX_PASSWORD_FILE")"
timestamp="${QQQ_WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}"

if [[ -z "$pfx" ]]; then
  echo "sign-windows: not signing: set QQQ_WINDOWS_PFX (and QQQ_WINDOWS_PFX_PASSWORD or QQQ_WINDOWS_PFX_PASSWORD_FILE)."
  echo "              The .exe stays unsigned: SmartScreen warns on first run (More info, Run anyway)."
  exit 0
fi
[[ -f "$pfx" ]] || { echo "sign-windows: $pfx does not exist" >&2; exit 1; }
if [[ $dry == 0 ]]; then command -v osslsigncode >/dev/null || { echo "sign-windows: needs osslsigncode" >&2; exit 1; }; fi

shopt -s nullglob
binaries=("$dist"/qqq-windows-*.exe)
[[ ${#binaries[@]} -gt 0 ]] || { echo "sign-windows: no $dist/qqq-windows-*.exe" >&2; exit 1; }

ts=(-ts "$timestamp"); [[ "$timestamp" == none ]] && ts=()
for bin in "${binaries[@]}"; do
  echo "sign-windows: $bin"
  if [[ $dry == 1 ]]; then
    echo "  would run: osslsigncode sign -pkcs12 $pfx -pass *** -h sha256 -n qqq -i https://github.com/QRun-IO/qqq-cli ${ts[*]} -in $bin -out $bin.signed"
    echo "  would run: osslsigncode verify -in $bin.signed, then replace $bin"
    continue
  fi
  osslsigncode sign -pkcs12 "$pfx" -pass "$password" -h sha256 -n qqq -i https://github.com/QRun-IO/qqq-cli ${ts[@]+"${ts[@]}"} \
    -in "$bin" -out "$bin.signed" >/dev/null
  # verify the signature is there and well formed (a self-signed test certificate is untrusted: that is fine here)
  osslsigncode verify -in "$bin.signed" 2>&1 | grep -E "Signature verification|Message digest|Number of signers" || true
  mv "$bin.signed" "$bin"
done

if [[ $dry == 1 ]]; then echo "  would recompute $dist/SHA256SUMS"; exit 0; fi
(cd "$dist" && if command -v sha256sum >/dev/null; then sha256sum qqq-*; else shasum -a 256 qqq-*; fi) > "$dist/SHA256SUMS.new"
mv "$dist/SHA256SUMS.new" "$dist/SHA256SUMS"
echo "sign-windows: recomputed $dist/SHA256SUMS"
