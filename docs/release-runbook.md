# Release runbook: qqq 1.0.0

From "the branch is green" to "1.0.0 is published and installable everywhere". It is written for
1.0.0 but holds for any release; replace the versions. Nothing in the repository tags, pushes or
publishes by itself: `scripts/release.mjs` checks and prints, people run the commands.

What ships:

| Artifact | Version for 1.0 | Where | Made by |
|---|---|---|---|
| `qqq` binaries with the terminal UI, 7 targets, plus `SHA256SUMS` | 1.0.0 | GitHub release `cli-v1.0.0` | `scripts/build-binaries.mjs` (via `release.mjs`) |
| `@qrun-io/qqq-cli` (CLI only, Node 20+) | 1.0.0 | GitHub Packages | the orb, on tag `v1.8.0` |
| `@qrun-io/qqq-core` | 1.0.0 | GitHub Packages | the orb (with PR #165), else by hand |
| `@qrun-io/qqq-ui-api-client` | 1.8.0 | GitHub Packages | the orb |
| `@qrun-io/qqq-ui-api-conformance` | 1.6.0 | GitHub Packages | the orb |

**All four npm packages go final together.** The orb (PR #165) derives the dist-tag from all four
versions: if any of client, core, conformance or CLI has a prerelease part, all four are published as
`rc`; only when all four are final do they go out as `latest`. So 1.0.0 ships client 1.8.0 and
conformance 1.6.0 as finals beside CLI and core 1.0.0, under the tags `v1.8.0` (orb publish) and
`cli-v1.0.0` (GitHub release). `release.mjs` refuses a final CLI version while any of the four is still a
prerelease (the readiness gate's "package versions" line).
| Homebrew formula `qqq` | 1.0.0 | `QRun-IO/homebrew-tap` | `scripts/update-packaging.mjs`, then a PR |
| Scoop manifest `qqq` | 1.0.0 | `QRun-IO/scoop-bucket` | `scripts/update-packaging.mjs`, then a PR |

## Checklist: what needs James

Nobody else can do these; each says what happens without it.

- [x] **Orb changes released** in `kingsrook/qqq-orb` 0.8.33 (`docs/ci-lanes.md`): publishing
      `@qrun-io/qqq-core`, lint, the `operations.ts` drift check, the dist-tag rule above (PR #165), and
      the macOS arm64 and Windows x64 lanes, which `.qqq-ci.yml` turns on (`platforms:`) and a release tag
      requires before publishing.
- [ ] **CircleCI plan** includes the `m4pro.medium` (macOS) and `windows.medium` resource classes. Without
      them the platform lanes cannot start, and because a release tag requires them, the publish waits;
      remove `platforms:` from `.qqq-ci.yml` to publish without them.
- [ ] **Apple Developer ID and notarization**: a "Developer ID Application" certificate and a notary
      credential (App Store Connect API key) on the release machine. Without it the macOS binaries are
      only ad-hoc signed. Homebrew and the curl installer are not affected (they do not set the
      quarantine flag), but a binary downloaded with a browser is stopped by Gatekeeper ("Apple cannot
      check it for malicious software"). Workaround, documented in the README and the packaging notes:
      `xattr -d com.apple.quarantine ./qqq-darwin-arm64`, or Finder, right-click, Open.
- [ ] **Windows Authenticode certificate** (the KofTwentyTwo release standard). Without it SmartScreen
      warns on first run ("Windows protected your PC", More info, Run anyway); Scoop installs still work.
- [x] **`QRun-IO/homebrew-tap` and `QRun-IO/scoop-bucket` exist** (created from `docs/packaging/homebrew-tap/` and
      `docs/packaging/qqq.json`). After the GitHub release, run `scripts/update-packaging.mjs` on the uploaded
      `SHA256SUMS` and commit the filled `Formula/qqq.rb` and `bucket/qqq.json` to them. Without that commit
      `brew install` and `scoop install` fail their checksum (the curl installer and the download still work).
- [ ] **CircleCI context** `qqq-maven-registry-credentials` holds a `GITHUB_TOKEN` that can write the
      four `@qrun-io` packages (the orb checks it authenticates; write access is only proven by a publish).
- [ ] **Go for 1.0.0 final**: the 1.0.0-rc.1 feedback is accepted and no blocker is open.

## Not verified before 1.0

The platform lanes run the Node packages' build, tests and lint on macOS arm64 and Windows x64 (Node
20), which covers the keyring code paths there, but they do not build or run the binaries.

- `qqq-windows-x64.exe` (CLI and UI) has never run; `scripts/verify-binary.ps1` is the smoke to run on
  a Windows machine.
- `qqq-darwin-x64` has never run (no Intel Mac or Rosetta on the build machine).
- Windows Terminal rendering of `qqq ui`, and the DPAPI keyring outside unit tests.

Verified on the build machine: darwin-arm64 (CLI, keyring, completion, `qqq ui` tmux smoke and width
smoke against the sample server), linux-x64 glibc, linux-arm64 glibc and linux-arm64-musl in Docker
(CLI and `qqq ui` in tmux), the npm tarballs installed on Node 20, the Homebrew formula in the
`homebrew/brew` container, and the curl installer from a local mirror.

## 1. Branch green

- `feat/m5-cli-release` (and whatever else is in the release) is merged to `main`; the orb pipeline on
  `main` is green: `cli_verify_publish` (Linux, `cimg/node:22.23`) and the `cli-macos-arm64` and
  `cli-windows-x64` lanes.
- Locally on `main`, clean tree: `npm ci && npm run build && npm test && npm run lint && npm run test:tui`.

## 2. Versions: release candidate to final

**For 1.0.0 this step is done** on the branch `release/1.0.0` (34bbd2a, on top of the rc.1 commit
6517373): all four packages final, the exact workspace pins, the `## [1.0.0]` CHANGELOG entry,
`docs/release-notes/1.0.0.md`, and the READMEs at 1.0.0. That branch (with the release docs merged into
it) is fast-forwarded onto `main`; nothing else changes versions:

```sh
git checkout main && git pull --ff-only
git merge --ff-only release/1.0.0      # fails if main moved: rebase release/1.0.0 onto main first
git push origin main
```

For later releases, the table below is the recipe.

On a branch `release/1.0.0` from `main`:

| File | Change |
|---|---|
| `packages/cli/package.json`, `packages/cli/src/version.ts` (`CLI_VERSION`) | `1.0.0-rc.N` → `1.0.0` |
| `packages/core/package.json` | `1.0.0-rc.N` → `1.0.0` |
| `packages/ui-api-client/package.json` | `1.8.0-rc.N` → `1.8.0` (the client follows the UI API version) |
| `packages/conformance/package.json` | `1.6.0-rc.N` → `1.6.0` |
| workspace dependencies in `packages/cli` and `packages/core` | the same versions, exact |
| `CHANGELOG.md` | a `## [1.0.0] - <date>` entry above the rc entries |
| `README.md`, `packages/cli/README.md` | the version and `@rc` in the npm command (`@latest`, or no tag) |

All four packages move to finals in the same commit; none may stay `-rc` (the orb would then publish all
four as `rc`, and `release.mjs` refuses). Then `npm install` (refreshes `package-lock.json`),
`npm run lint`, which fails if any version disagrees, and `npm run release -- --check`, which must say
READY (parity 100% in both columns, every finding filed, the CHANGELOG entry, documented commands,
package versions). Commit (`git commit -S -m "release: 1.0.0"`), merge to `main` through a pull request.

## 3. Release check and binaries

On `main` at the release commit, clean tree:

```sh
node scripts/release.mjs        # the readiness gate (final versions), npm ci, generate drift, build, test,
                                # lint, TUI tests and type check, pack dry runs, the 7 binaries with the UI
                                # and dist/SHA256SUMS
scripts/verify-binary.sh dist/qqq-darwin-arm64 --server http://localhost:8077   # sample server running
```

`release.mjs` prints the commands for steps 5 and 6 with the right versions.

## 4. Sign (James's credentials)

Signing changes the files, so it comes before the checksums are final. Each script reads its
credentials from the environment, does nothing (and says what is missing) without them, has
`--dry-run`, and recomputes `dist/SHA256SUMS`.

```sh
QQQ_MACOS_SIGN_IDENTITY="Developer ID Application: <name> (<team>)" QQQ_NOTARY_PROFILE=qqq-notary \
  scripts/sign-macos.sh            # codesign, hardened runtime + scripts/macos-entitlements.plist, notarytool --wait
QQQ_WINDOWS_PFX=<cert.pfx> QQQ_WINDOWS_PFX_PASSWORD_FILE=<file> \
  scripts/sign-windows.sh          # osslsigncode with an RFC 3161 timestamp
scripts/verify-binary.sh dist/qqq-darwin-arm64 --server http://localhost:8077   # still runs after signing
spctl --assess --type execute -vv dist/qqq-darwin-arm64   # "accepted, source=Notarized Developer ID"
```

A bare executable cannot be stapled: Gatekeeper fetches the notarization ticket online the first time a
quarantined (browser-downloaded) copy runs, and refuses offline until it can. Homebrew and the curl
installer do not quarantine, so they work signed or not. Tried here without real credentials: an ad-hoc
hardened-runtime signature with the entitlements (the CLI and the `qqq ui` smoke still pass), and an
osslsigncode signature with a throwaway certificate that verifies. A real Developer ID, notarization
and an Authenticode certificate are untried until James's credentials are used.

## 5. Tags and packages

```sh
git tag -s v1.8.0 -m "UI API client 1.8.0, qqq 1.0.0"     # the orb publishes on v<client version>
git tag -s cli-v1.0.0 -m "qqq 1.0.0"                      # the GitHub release with the binaries
git push origin v1.8.0 cli-v1.0.0
```

The tag `v1.8.0` makes the orb's `cli` profile verify the commit again and publish client, core,
conformance and CLI to GitHub Packages, all as `latest` because all four are final. Watch the
`publish_release` workflow. Only if the orb release with PR #165 is not out yet, finish by hand:

```sh
npm publish -w @qrun-io/qqq-core --registry https://npm.pkg.github.com --tag latest
for p in qqq-ui-api-client qqq-core qqq-ui-api-conformance qqq-cli; do
  npm dist-tag add "@qrun-io/$p@<its version>" latest --registry https://npm.pkg.github.com
done
```

A version can never be published twice: if the orb job fails after publishing some packages, bump the
patch version of the rest instead of retrying the same one.

## 6. GitHub release

```sh
gh release create cli-v1.0.0 --repo QRun-IO/qqq-cli --latest --title "qqq 1.0.0" \
  --notes-file <(sed -n '/^## \[1\.0\.0\]/,/^## \[/p' CHANGELOG.md | sed '$d') \
  dist/qqq-* dist/SHA256SUMS
```

`dist/qqq-*` is the seven binaries (source maps are in `dist/sourcemaps/`, not uploaded). For a release
candidate use `--prerelease` instead of `--latest`. The curl installer takes the newest stable `cli-v*`
release (the channel Homebrew and Scoop follow); a release candidate is reached with `--pre` or
`--version 1.x.y-rc.N`.

## 7. Homebrew tap and Scoop bucket

```sh
gh release download cli-v1.0.0 --repo QRun-IO/qqq-cli -p SHA256SUMS -D /tmp/qqq-1.0.0
node scripts/update-packaging.mjs /tmp/qqq-1.0.0/SHA256SUMS
git diff docs/packaging                                  # every sha256 differs from the placeholder, none is all zeros
git commit -S -am "packaging: qqq 1.0.0" && git push      # in qqq-cli, through a pull request
```

The script exits 1 and writes nothing if `SHA256SUMS` lacks a target or has a malformed sum. Compare each sum
in the diff with the release's `SHA256SUMS` by eye before committing: the tap's CI and the bucket's manifest
tests catch a wrong sum (the download will not match) only when someone opens those pull requests and reads
their checks.

Then copy `docs/packaging/homebrew-tap/Formula/qqq.rb` to `Formula/qqq.rb` in `QRun-IO/homebrew-tap`
and `docs/packaging/qqq.json` to `bucket/qqq.json` in `QRun-IO/scoop-bucket`, a pull request on each. The tap's
CI fetches every platform's download, installs the formula and runs its test (which insists on
`binary with ui`). Scoop's `checkver`/`autoupdate` can take later versions from `SHA256SUMS` by itself.

## 8. Smoke after publishing

Against a real server (`--server`), from clean machines or containers:

```sh
# curl installer (macOS, Linux)
curl -fsSL https://raw.githubusercontent.com/QRun-IO/qqq-cli/main/scripts/install.sh | sh -s -- --version 1.0.0
scripts/verify-binary.sh ~/.local/bin/qqq --server https://<server>

# Homebrew
brew install qrun-io/tap/qqq && brew test qrun-io/tap/qqq && scripts/verify-binary.sh "$(brew --prefix)/bin/qqq"

# npm, Node 20
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli@1.0.0 && scripts/verify-binary.sh qqq --cli-only --server https://<server>

# Docker (glibc and musl)
docker run --rm --platform linux/amd64 -v "$PWD/dist:/d:ro" -v "$PWD/scripts:/s:ro" debian:bookworm-slim bash /s/verify-binary.sh /d/qqq-linux-x64
```

```powershell
# Windows, PowerShell
scoop bucket add qrun https://github.com/QRun-IO/scoop-bucket; scoop install qqq
pwsh scripts\verify-binary.ps1 -Binary (Get-Command qqq).Source -Server https://<server>
```

And by hand once: download `qqq-darwin-arm64` with a browser on a Mac and run it (notarized: it runs;
not notarized: the Gatekeeper prompt, cleared by `xattr -d com.apple.quarantine`), then `qqq ui` in
Windows Terminal.

## 9. After

- Merge `main` back into the development branch; the next development version can stay at 1.0.0 until
  the next bump (lint keeps the versions consistent either way).
- Announce with the release link and the install commands from the README.

## When something goes wrong

- **A package is broken**: `npm deprecate @qrun-io/<pkg>@<version> "<reason>"` and publish a patch; a
  version cannot be unpublished from GitHub Packages without breaking installs that pinned it.
- **A binary is broken**: delete the asset from the GitHub release, rebuild, re-sign, upload, recompute
  `SHA256SUMS` and rerun step 7 (the formula and manifest carry the sums).
- **The tap's CI fails on the new formula**: do not merge its pull request; `brew install` keeps
  serving the previous version.
