# Release runbook

From "main is green" to "qqq X.Y.Z is published and installable everywhere". A release is one tag,
`v<CLI version>`, on the merge commit; Gitea CI (`.gitea/workflows/release.yaml`) does the rest. Nothing
publishes from a branch.

> **Since 2026-11-08** releases run on Gitea. The CircleCI/qqq-orb path (npm packages on a
> `v<client version>` tag, binaries on a GitHub release `cli-v<version>`, hand-made tap and bucket pull
> requests) is retired. Older releases (1.0.0 and before) stay on GitHub.

What ships:

| Artifact | Where | Made by |
|---|---|---|
| `qqq` binaries with the terminal UI, 7 targets, plus `SHA256SUMS` | Gitea release `v<version>` of `QRun-IO/qqq-cli` | `release.yaml`: Linux targets and darwin-x64 (cross) in the container, darwin-arm64 on the macOS runner, windows-x64 on the Windows runner |
| `@qrun-io/qqq-ui-api-client`, `qqq-core`, `qqq-ui-api-conformance`, `qqq-cli` | QRun-IO Gitea npm registry, `https://git.kof22.com/api/packages/QRun-IO/npm/` | `release.yaml` publish job |
| Homebrew formula `qqq` | `QRun-IO/homebrew-tap`, `Formula/qqq.rb` | `release.yaml` (final versions), else a pull request |
| Scoop manifest `qqq` | `QRun-IO/scoop-bucket`, `bucket/qqq.json` | `release.yaml` (final versions), else a pull request |

## 1. Versions

On a branch from `main`:

| File | Change |
|---|---|
| `packages/cli/package.json`, `packages/cli/src/version.ts` (`CLI_VERSION`) | the CLI version, e.g. `1.1.0-rc.1` or `1.1.0` |
| `packages/core/package.json`, `packages/conformance/package.json` | bump any package whose content changed |
| `packages/ui-api-client/package.json` | follows the UI API version of `openapi/qqq-v1.json` |
| workspace dependencies in `packages/cli` and `packages/core` | the same versions, exact |
| `CHANGELOG.md` | a `## [X.Y.Z] - <date>` entry (it becomes the release notes; `docs/release-notes/X.Y.Z.md` wins if present) |

Then `npm install` (refreshes `package-lock.json`), `npm run lint` (fails if any version disagrees) and
`node scripts/release.mjs` (the same gate CI runs; add `--skip-binaries` to save time). A final version
must pass the readiness gate (`npm run release -- --check`: parity, findings filed, CHANGELOG entry,
documented commands, all four packages final); a prerelease is not gated. Merge through a pull request.

Each package version is published once. The publish job skips a package whose exact version is already
in the registry (unchanged packages ride along), so bump every package whose content changed.

## 2. Tag

```sh
git checkout main && git pull --ff-only
git tag -s v1.1.0 -m "qqq 1.1.0" && git push origin v1.1.0
```

Or create the tag on the merge commit through the Gitea API (`POST /repos/QRun-IO/qqq-cli/tags`). The tag
must equal `packages/cli/package.json` or the release fails at once. A version with a `-` (`-rc.N`) is a
prerelease: npm dist-tag `next` for prerelease packages, a Gitea prerelease, and no tap or bucket update.

## 3. What CI does

`.gitea/workflows/release.yaml`, in order; any failure stops it:

1. **linux** (`container-build`, `node:22.23.4-bookworm`, Bun 1.4.4 checksum-pinned):
   `scripts/release.mjs --skip-binaries` (npm ci, generate drift, build, readiness for finals, tests, lint,
   TUI tests and type check, pack dry runs), then the linux-x64, linux-arm64, both musl and darwin-x64
   binaries (`scripts/build-binaries.mjs`), the `scripts/verify-binary.sh` smoke on linux-x64, and a
   **draft** Gitea release with those binaries. An existing release for the tag fails the run.
2. **macos** (`qqq-macos-arm64`) and **windows** (`qqq-windows-vm6218`), in parallel: pinned Node.js
   (`SHASUMS256.txt`) and Bun (pinned sha256), `npm ci`, build, test, lint, the native binary
   (`--host`), the `verify-binary.sh` / `verify-binary.ps1` smoke, and the upload to the draft.
3. **publish** (`container-build`): `SHA256SUMS` from the three jobs' checksums, uploaded; the release is
   published and every download is checked against `SHA256SUMS`; the four packages go to the Gitea npm
   registry with `PACKAGES_TOKEN`; `scripts/update-packaging.mjs` fills the formula and the manifest.
   For a final version they are pushed to `QRun-IO/homebrew-tap` and `QRun-IO/scoop-bucket` when
   `PACKAGES_TOKEN` can write those repositories; otherwise `qqq.rb` and `qqq.json` are attached to the
   release (step 4).

Watch it under Actions in `QRun-IO/qqq-cli`. The release page is
`https://git.kof22.com/QRun-IO/qqq-cli/releases/tag/v<version>`.

## 4. Homebrew tap and Scoop bucket (when CI could not push)

`PACKAGES_TOKEN` is the package-scoped publisher token; unless it is granted write on the tap and the
bucket, CI attaches the filled files to the release instead. For a final version, download them and open a
pull request on each:

```sh
curl -fsSLO https://git.kof22.com/QRun-IO/qqq-cli/releases/download/v1.1.0/qqq.rb
curl -fsSLO https://git.kof22.com/QRun-IO/qqq-cli/releases/download/v1.1.0/qqq.json
# QRun-IO/homebrew-tap: Formula/qqq.rb   QRun-IO/scoop-bucket: bucket/qqq.json
```

Compare each sum with the release's `SHA256SUMS`. A wrong sum makes `brew install` and `scoop install`
fail their checksum; the curl installer and direct downloads are unaffected.

## 5. Signing (not automated)

The binaries are not signed by CI: there is no Apple Developer ID / notary credential or Authenticode
certificate on the runners. Homebrew and the curl installer do not quarantine, so they work unsigned; a
browser-downloaded macOS binary needs `xattr -d com.apple.quarantine ./qqq-darwin-arm64`, and Windows
SmartScreen warns on first run. `scripts/sign-macos.sh` and `scripts/sign-windows.sh` remain for a manual
signed release (they recompute `dist/SHA256SUMS`); wiring them into the native jobs needs the credentials
as runner-side secrets (owner decision).

Gitea has no equivalent of GitHub's artifact attestations; `SHA256SUMS` on the release and the signed tag
are the provenance.

## 6. Smoke after publishing

Against a real server (`--server`), from clean machines or containers:

```sh
# curl installer (macOS, Linux)
curl -fsSL https://git.kof22.com/QRun-IO/qqq-cli/raw/branch/main/scripts/install.sh | sh -s -- --version 1.1.0
scripts/verify-binary.sh ~/.local/bin/qqq --server https://<server>

# Homebrew
brew install qrun-io/tap/qqq && brew test qrun-io/tap/qqq

# npm, Node 20+
echo "@qrun-io:registry=https://git.kof22.com/api/packages/QRun-IO/npm/" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli@1.1.0 && scripts/verify-binary.sh qqq --cli-only --server https://<server>
```

```powershell
scoop bucket add qrun https://git.kof22.com/QRun-IO/scoop-bucket; scoop install qqq
pwsh scripts\verify-binary.ps1 -Binary (Get-Command qqq).Source -Server https://<server>
```

Users who added the tap or the bucket from GitHub re-add them from Gitea
(`brew tap qrun-io/tap https://git.kof22.com/QRun-IO/homebrew-tap`).

## When something goes wrong

- **The run fails before the publish job**: nothing is public. Delete the draft release (and the tag, if
  the version must change), fix, and tag again.
- **A package is broken**: `npm deprecate @qrun-io/<pkg>@<version> "<reason>"` against the Gitea registry
  and publish a new version; a version is never republished.
- **A binary is broken**: delete the release, bump the version and release again; the formula and the
  manifest carry the sums, so never replace an asset in place.
- **The tap's or bucket's check fails on the new file**: do not merge; users keep the previous version.
