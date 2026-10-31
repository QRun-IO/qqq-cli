# Packaging the qqq CLI

Every install path ships the same single-file binaries that `npm run binaries`
(`scripts/build-binaries.mjs`) writes to `dist/`, uploaded to a GitHub release tagged `cli-v<version>`
together with `SHA256SUMS`. The npm packages (`@qrun-io/qqq-cli` on GitHub Packages) are the other
route, for machines that already have Node 20+.

| File | What | Where it goes |
|---|---|---|
| `scripts/install.sh` | curl installer: picks `qqq-<os>-<arch>[-musl]`, checks it against `SHA256SUMS`, installs to `~/.local/bin` (`--dir`, `--version`) | served from `main`: `curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh \| sh` |
| `qqq.rb` | Homebrew formula draft (macOS arm64 and x64, Linux arm64 and x64), same shape as `qctl.rb`, with bash, zsh and fish completions | `Formula/qqq.rb` in a QRun-IO tap |
| `qqq.json` | Scoop manifest draft (Windows x64), same shape as qctl's, with `checkver` and `autoupdate` reading `SHA256SUMS` | `bucket/qqq.json` in a QRun-IO Scoop bucket |

## Release steps

1. `node scripts/release.mjs` on a clean tree; it prints the tag and publish commands.
2. Tag `cli-v<version>` and create the GitHub release with `dist/qqq-*` and `dist/SHA256SUMS`
   (`gh release create`, printed by step 1).
3. Download that release's `SHA256SUMS` and run `node scripts/update-packaging.mjs <path>`; it writes
   the version and the checksums into `qqq.rb` and `qqq.json`. Use the uploaded sums, not a local
   rebuild: each build stamps its commit into the binary, so checksums differ between builds.
4. Copy `qqq.rb` to the tap and `qqq.json` to the bucket and open a pull request on each.

## Where the formula and manifest live

QRun-IO has one tap today, [`QRun-IO/homebrew-qctl`](https://github.com/QRun-IO/homebrew-qctl)
(`brew tap QRun-IO/qctl`), and qctl's Scoop manifest lives in `qctl/packaging/scoop`. Two options:

- **Add `qqq` to the existing tap**: `brew install qrun-io/qctl/qqq`. No new repository; the tap name
  reads oddly.
- **A general tap and bucket** (`QRun-IO/homebrew-tap`, `QRun-IO/scoop-bucket`) holding both qctl and
  qqq: `brew install qrun-io/tap/qqq`, `scoop bucket add qrun https://github.com/QRun-IO/scoop-bucket`.
  The qqq-orb already has a `homebrew-tap` profile for such a repository. Recommended before 1.0 final.

## Platform notes

- **macOS**: Bun signs the binaries ad hoc, which is enough for Homebrew and curl installs (neither sets
  the quarantine flag). A binary downloaded with a browser is quarantined; `xattr -d com.apple.quarantine qqq`
  clears it. Developer ID signing and notarization are not done yet.
- **Linux musl** (Alpine): `qqq-linux-<arch>-musl` needs `apk add libstdc++ libgcc`. The installer picks
  the musl build on Alpine and other musl hosts.
- **x64**: built on Bun's baseline runtime, so the binaries run on CPUs without AVX2 and under Rosetta 2
  or QEMU.
- **Windows**: `qqq-windows-x64.exe` is cross-compiled and not signed (Authenticode, per the KofTwentyTwo
  release standard, is a follow-up). Sign-ins use DPAPI through PowerShell. No Windows CI lane runs it
  yet; see `docs/ci-lanes.md`.
- Binaries are 85 to 111 MB (the Bun runtime is embedded); about 37 to 53 MB gzipped.
