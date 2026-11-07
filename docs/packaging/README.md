# Packaging qqq

The release artifact is **one `qqq` binary per platform with the terminal UI bundled** (`qqq ui`),
built by `npm run binaries` (`scripts/build-binaries.mjs`; `--cli-only` leaves the UI out) into
`dist/qqq-<os>-<arch>[.exe]` and uploaded to a GitHub release tagged `cli-v<version>` with
`SHA256SUMS`. `qqq --version` says `binary with ui`. Every install path below ships those files; there
is no separate `qqq-ui` binary. The npm package `@qrun-io/qqq-cli` (GitHub Packages, Node 20+) is the
CLI only and tells you where to get the UI. The full release sequence is in
[`docs/release-runbook.md`](../release-runbook.md).

| File | What | Where it goes |
|---|---|---|
| `scripts/install.sh` | curl installer: picks `qqq-<os>-<arch>[-musl]` of the newest stable `cli-v*` release (`--pre` for prereleases, `--version` to pin), checks it against `SHA256SUMS`, installs `qqq` to `~/.local/bin` (`--dir`; `--dry-run` prints the URL; `--help`) | served from `main`: `curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh \| sh` |
| `homebrew-tap/` | the whole `QRun-IO/homebrew-tap` repository, ready to copy: `Formula/qqq.rb` (macOS arm64 and x64, Linux arm64 and x64; installs only `bin/qqq` plus bash, zsh and fish completions; its test insists on `binary with ui`), README, LICENSE, and the qqq-orb `homebrew-tap` CI profile | a new repository `QRun-IO/homebrew-tap` (`brew install qrun-io/tap/qqq`) |
| `qqq.json` | Scoop manifest for the with-UI Windows x64 binary, same shape as qctl's, `checkver` and `autoupdate` reading `SHA256SUMS` | `bucket/qqq.json` in `QRun-IO/scoop-bucket` (`scoop bucket add qrun https://github.com/QRun-IO/scoop-bucket; scoop install qqq`) |
| `scripts/update-packaging.mjs` | fills version and sha256 in `homebrew-tap/Formula/qqq.rb` and `qqq.json` from a release's `SHA256SUMS` | run after each release |
| `scripts/verify-binary.sh`, `scripts/verify-binary.ps1` | smoke of an installed or downloaded binary: version (with ui), whoami, query, process run, `ui --check` | CI lanes and after-publish checks |

The formula was installed and tested with the linux-x64 with-UI binary in the `homebrew/brew` container
(install, `brew test`, the three completion files); it has not been installed on macOS (that would
change this machine's Homebrew).

## Release steps

See [`docs/release-runbook.md`](../release-runbook.md). In short: `node scripts/release.mjs`, tag, GitHub
release with `dist/qqq-*` and `dist/SHA256SUMS`, `node scripts/update-packaging.mjs <that SHA256SUMS>`,
copy `homebrew-tap/Formula/qqq.rb` to the tap and `qqq.json` to the bucket (the bucket's Excavator
also picks up new releases by itself). Use the uploaded sums, not a
local rebuild: each build stamps its commit, so checksums differ between builds. The script exits 1 and writes
nothing when a sum is missing or malformed, and never writes zeros; check the result anyway with
`git diff` and `grep -c 0000000000000000 docs/packaging/qqq.json docs/packaging/homebrew-tap/Formula/qqq.rb`
(both must print 0) before copying the files out. The tap's CI and the bucket's manifest tests would catch
zeros (a download that does not match) only if their pull requests are opened and their checks are read;
checkpoint the sums here first, not there.

## Where the formula and manifest live

- **`QRun-IO/homebrew-tap`** is laid out under `homebrew-tap/` here (the repository is created by copying
  that directory). Its old CI (the qqq-orb `homebrew-tap` profile on CircleCI) was retired on
  2026-11-07 and the seed no longer carries CI files; tap CI on Gitea is not decided yet. qctl stays in `QRun-IO/homebrew-qctl` until it
  moves over.
- **`QRun-IO/scoop-bucket`** is created from
  [ScoopInstaller/BucketTemplate](https://github.com/ScoopInstaller/BucketTemplate), with `qqq.json` as
  `bucket/qqq.json`. Its CI is the template's GitHub Actions (manifest tests), and the template's
  Excavator workflow runs `checkver`/`autoupdate` on a schedule, so a new `cli-v*` release updates the
  manifest (version and hash from `SHA256SUMS`) without a manual pull request.

## Platform notes

- **macOS**: Bun signs the binaries ad hoc; there is no Developer ID signature or notarization yet (it needs
  James's Apple Developer account, see the runbook). Homebrew and the curl installer do not set the
  quarantine flag, so they just work. A binary downloaded with a browser is quarantined, and Gatekeeper
  refuses it ("qqq cannot be opened because Apple cannot check it for malicious software" or "... is
  damaged"). Clear the flag once: `xattr -d com.apple.quarantine ./qqq-darwin-arm64` (or right-click,
  Open, in Finder; or System Settings, Privacy and Security, Open Anyway).
- **Linux musl** (Alpine): `qqq-linux-<arch>-musl` needs `apk add libstdc++ libgcc`. The installer picks
  the musl build on Alpine and other musl hosts.
- **x64**: built on Bun's baseline runtime, so the binaries run on CPUs without AVX2 and under Rosetta 2
  or QEMU.
- **Windows**: `qqq-windows-x64.exe` is cross-compiled and not Authenticode-signed (James's certificate,
  see the runbook), so SmartScreen warns on first run ("More info", "Run anyway"); Scoop installs are not
  affected. Sign-ins use DPAPI through PowerShell. **Unverified**: it has never run; the Windows CI lane
  (`docs/ci-lanes.md`, `scripts/verify-binary.ps1`) is the first place it will.
- **macOS x64**: cross-compiled and **unverified** (no Intel Mac or Rosetta here) until the CI lanes run.
- Binaries with the UI are 100.6 MB (darwin-arm64) to 129.2 MB (windows-x64); the Bun runtime is embedded.

## The terminal UI (`qqq ui`)

The TUI (`packages/tui`) runs on Bun only: OpenTUI loads a native Zig library through `bun:ffi`, and
the React renderer sits on top. Three ways to ship it were tried on 2026-10-31 (Bun 1.4.4, OpenTUI
0.8.1) against the sample server:

| Option | Result |
|---|---|
| **One `qqq` binary with the UI** (`npm run binaries -- --with-tui`) | **Works.** Entry `scripts/binary-with-tui.ts`; `qqq ui` runs the bundled TUI in the same process. `bun build --compile` embeds OpenTUI's native library for the target (installed for every platform with `bun install --os='*' --cpu='*'`). The full tmux smoke (`packages/tui/scripts/smoke.sh`: home, grid, record paging, filter, contingent form, async process, menu, help, dashboard, quit) passed with the darwin-arm64 binary; `qqq ui table get person 3` opened the record in tmux in Docker with the linux-x64 (glibc, under emulation) and linux-arm64-musl binaries, and quit with exit 0. The CLI commands of the same binary behave as before. |
| A second binary `qqq-ui` (entry `packages/tui/src/main.tsx`) | Works too (same smoke passed), 103 MB on darwin-arm64. It already contains the whole CLI program (the TUI's command line runs `runCli`), so a second binary is almost a second copy of the first. |
| npm only, Bun as a prerequisite | Possible but the weakest: the TUI package is private today, `bun` must be installed, and OpenTUI's native package comes from the optional dependencies at install time. |

Sizes, CLI only → with the UI: darwin-arm64 84.8 → 100.8 MB, darwin-x64 95.1 → 111.8 MB, linux-x64
105.5 → 123.3 MB, linux-arm64 105.6 → 122.3 MB, windows-x64 111.4 → 129.5 MB, linux musl about 98 →
122 to 125 MB. The UI adds 16 to 18 MB (the native library is 6.6 MB on darwin-arm64; the rest is React,
OpenTUI and its React renderer).

Not verified: the Windows and macOS x64 builds with the UI (cross-compiled, never run; Windows Terminal
was never checked even for the spike). Linux glibc arm64 with the UI passed the Docker tmux check before
the 98e426b merge, linux-x64 and linux-arm64-musl after it.

**Decision (James, 2026-10-31):** one `qqq` binary per platform with the UI is the release artifact,
from the same release, Homebrew formula, Scoop manifest and installer. `npm run binaries` and
`release.mjs` bundle the UI by default (`--cli-only` is the escape hatch). Both binary entries start the
built CLI (`packages/cli/dist`), the module the TUI imports as `@qrun-io/qqq-cli/program`, so the CLI
program is bundled once; that saved only 0.3 MB (darwin-arm64 100.8 → 100.5 MB), because the program
is small next to React, OpenTUI and its native library. After the TUI batch merge (98e426b) the with-UI
darwin-arm64 binary is 100.6 MB and passes `smoke.sh` and `smoke-widths.sh`.
