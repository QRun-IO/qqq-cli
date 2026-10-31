#!/bin/sh
# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Installs the qqq CLI single-file binary for this machine from the GitHub releases of
# QRun-IO/qqq-cli, after checking it against the release's SHA256SUMS.
#
#   curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 1.0.0-rc.1 --dir /usr/local/bin
#
# Options (or environment):
#   --version V   (QQQ_VERSION)      a release such as 1.0.0-rc.1; default: the newest cli-v* release,
#                                    prereleases included
#   --dir D       (QQQ_INSTALL_DIR)  where qqq goes; default: ~/.local/bin
#   --musl                           take the musl build on Linux (detected on Alpine and other musl hosts)
#   QQQ_DOWNLOAD_BASE                release download root (default https://github.com/QRun-IO/qqq-cli/releases/download),
#                                    for mirrors and testing
# Supported: macOS arm64 and x64, Linux x64 and arm64 (glibc and musl). On Windows use Scoop or the .exe.

set -eu

repo="QRun-IO/qqq-cli"
version="${QQQ_VERSION:-}"
dir="${QQQ_INSTALL_DIR:-$HOME/.local/bin}"
base="${QQQ_DOWNLOAD_BASE:-https://github.com/$repo/releases/download}"
musl=""

say() { printf '%s\n' "$*" >&2; }
die() { say "qqq install: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; dir="$2"; shift 2 ;;
    --musl) musl="-musl"; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
  fetch_text() { curl -fsSL --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_text() { wget -q -O - "$1"; }
else
  die "needs curl or wget"
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows install with Scoop (scoop install qqq) or download qqq-windows-x64.exe from https://github.com/$repo/releases" ;;
  *) die "unsupported operating system $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64   # a shell running under Rosetta on Apple silicon: install the native build
fi
if [ "$os" = linux ] && [ -z "$musl" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then musl="-musl"; fi
fi
[ "$os" = linux ] || musl=""

if [ -z "$version" ]; then
  version="$(fetch_text "https://api.github.com/repos/$repo/releases?per_page=30" \
    | grep -o '"tag_name": *"cli-v[^"]*"' | head -n 1 | sed 's/.*"cli-v\([^"]*\)"/\1/')" \
    || true
  [ -n "$version" ] || die "could not find a cli-v* release of $repo; pass --version"
fi
version="${version#v}"
version="${version#cli-v}"

file="qqq-$os-$arch$musl"
url="$base/cli-v$version/$file"
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t qqq)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

say "Downloading qqq $version ($file)"
fetch "$url" "$tmp/$file" || die "download failed: $url"
fetch "$base/cli-v$version/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/cli-v$version/SHA256SUMS"

expected="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for $file"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$file" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')"
else
  die "needs sha256sum or shasum to check the download"
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $file (expected $expected, got $actual)"

mkdir -p "$dir"
chmod 755 "$tmp/$file"
mv "$tmp/$file" "$dir/qqq"
say "Installed $dir/qqq"
"$dir/qqq" --version >&2 || die "$dir/qqq does not run on this machine${musl:+ (musl builds need libstdc++ and libgcc: apk add libstdc++ libgcc)}"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
say "Next: qqq login --server https://your-qqq-server"
