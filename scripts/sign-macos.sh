#!/usr/bin/env bash
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Signs the macOS qqq binaries with a Developer ID under the hardened runtime, notarizes them, and
# recomputes SHA256SUMS. Run after scripts/build-binaries.mjs and before the GitHub release.
#
#   scripts/sign-macos.sh [dist] [--dry-run]
#
# Environment (nothing set: prints what is missing and exits 0 without touching a file):
#   QQQ_MACOS_SIGN_IDENTITY   "Developer ID Application: <name> (<team id>)" in the keychain
#                             ("-" signs ad hoc with the same options, for testing; never notarized)
#   QQQ_MACOS_KEYCHAIN        optional keychain file holding the identity (CI)
#   notarization, one of:
#   QQQ_NOTARY_PROFILE        a notarytool keychain profile (xcrun notarytool store-credentials)
#   QQQ_NOTARY_KEY, QQQ_NOTARY_KEY_ID, QQQ_NOTARY_ISSUER   an App Store Connect API key (.p8 path, key id,
#                             issuer id)
#   Without notarization credentials the binaries are signed but not notarized.
#
# A bare executable cannot be stapled. Gatekeeper checks the notarization ticket online the first
# time a quarantined (browser-downloaded) binary runs; offline it refuses until the network is back.
# Homebrew and scripts/install.sh downloads are not quarantined, so they run either way.

set -euo pipefail

dist="dist"; dry=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    -*) echo "sign-macos: unknown option $a" >&2; exit 2 ;;
    *) dist="$a" ;;
  esac
done
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entitlements="$here/macos-entitlements.plist"
identity="${QQQ_MACOS_SIGN_IDENTITY:-}"

if [[ -z "$identity" ]]; then
  echo "sign-macos: not signing: set QQQ_MACOS_SIGN_IDENTITY to a \"Developer ID Application: ...\" identity"
  echo "            (and QQQ_NOTARY_PROFILE, or QQQ_NOTARY_KEY/QQQ_NOTARY_KEY_ID/QQQ_NOTARY_ISSUER, to notarize)."
  echo "            The binaries stay ad-hoc signed: browser downloads meet a Gatekeeper prompt"
  echo "            (xattr -d com.apple.quarantine <file> clears it)."
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || { echo "sign-macos: needs macOS (codesign, notarytool)" >&2; exit 1; }

notary=()
if [[ "$identity" == "-" ]]; then
  echo "sign-macos: ad-hoc identity: signing for testing only, no notarization"
elif [[ -n "${QQQ_NOTARY_PROFILE:-}" ]]; then
  notary=(--keychain-profile "$QQQ_NOTARY_PROFILE")
elif [[ -n "${QQQ_NOTARY_KEY:-}" && -n "${QQQ_NOTARY_KEY_ID:-}" && -n "${QQQ_NOTARY_ISSUER:-}" ]]; then
  notary=(--key "$QQQ_NOTARY_KEY" --key-id "$QQQ_NOTARY_KEY_ID" --issuer "$QQQ_NOTARY_ISSUER")
else
  echo "sign-macos: no notarization credentials: signing only (Gatekeeper will still prompt for browser downloads)"
fi
keychain=()
[[ -n "${QQQ_MACOS_KEYCHAIN:-}" ]] && keychain=(--keychain "$QQQ_MACOS_KEYCHAIN")

run() {
  if [[ $dry == 1 ]]; then printf '  would run:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

shopt -s nullglob
binaries=("$dist"/qqq-darwin-*)
[[ ${#binaries[@]} -gt 0 ]] || { echo "sign-macos: no $dist/qqq-darwin-* binaries" >&2; exit 1; }

for bin in "${binaries[@]}"; do
  [[ "$bin" == *.zip ]] && continue
  echo "sign-macos: $bin"
  run codesign --force --timestamp --options runtime --entitlements "$entitlements" ${keychain[@]+"${keychain[@]}"} --sign "$identity" "$bin"
  run codesign --verify --strict --verbose=2 "$bin"
  if [[ ${#notary[@]} -gt 0 ]]; then
    run ditto -c -k --keepParent "$bin" "$bin.zip"
    run xcrun notarytool submit "$bin.zip" "${notary[@]}" --wait --timeout 30m
    run rm -f "$bin.zip"
    run spctl --assess --type execute --verbose=2 "$bin"
  fi
done

sums() {
  (cd "$dist" && if command -v sha256sum >/dev/null; then sha256sum qqq-*; else shasum -a 256 qqq-*; fi) > "$dist/SHA256SUMS.new"
  mv "$dist/SHA256SUMS.new" "$dist/SHA256SUMS"
}
if [[ $dry == 1 ]]; then echo "  would recompute $dist/SHA256SUMS"; else sums; echo "sign-macos: recomputed $dist/SHA256SUMS"; fi
