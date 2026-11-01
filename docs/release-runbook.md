# Release runbook: qqq 1.0.0

From "the branch is green" to "1.0.0 is published and installable everywhere". It is written for
1.0.0 but holds for any release; replace the versions. Nothing in the repository tags, pushes or
publishes by itself: `scripts/release.mjs` checks and prints, people run the commands.

What ships:

| Artifact | Version for 1.0 | Where | Made by |
|---|---|---|---|
| `qqq` binaries with the terminal UI, 7 targets, plus `SHA256SUMS` | 1.0.0 | GitHub release `cli-v1.0.0` | `scripts/build-binaries.mjs` (via `release.mjs`) |
| `@qrun-io/qqq-cli` (CLI only, Node 20+) | 1.0.0 | GitHub Packages | the orb, on tag `v<client version>` |
| `@qrun-io/qqq-core` | 1.0.0 | GitHub Packages | the orb once it publishes core, else by hand |
| `@qrun-io/qqq-ui-api-client` | 1.8.0 | GitHub Packages | the orb |
| `@qrun-io/qqq-ui-api-conformance` | 1.6.0 | GitHub Packages | the orb |
| Homebrew formula `qqq` | 1.0.0 | `QRun-IO/homebrew-tap` | `scripts/update-packaging.mjs`, then a PR |
| Scoop manifest `qqq` | 1.0.0 | a QRun-IO Scoop bucket | `scripts/update-packaging.mjs`, then a PR |

## Checklist: what needs James

Nobody else can do these; each says what happens without it.

- [ ] **Orb changes merged and released** (0.8.x patch of `kingsrook/qqq-orb`, proposal in
      `docs/ci-lanes.md`): publish `@qrun-io/qqq-core`, run lint, the macOS arm64 and Windows x64 lanes,
      and publish a final version with the `latest` dist-tag (today the orb always uses `rc`).
      Without it: publish core by hand (step 5) and move `latest` by hand (step 5).
- [ ] **CircleCI plan** includes the `m4pro.medium` (macOS) and `windows.medium` resource classes, for
      the lanes. Without it: Windows x64 and macOS x64 ship unverified (see "Not verified" below).
- [ ] **Apple Developer ID and notarization**: a "Developer ID Application" certificate and a notary
      credential (App Store Connect API key) on the release machine. Without it the macOS binaries are
      only ad-hoc signed. Homebrew and the curl installer are not affected (they do not set the
      quarantine flag), but a binary downloaded with a browser is stopped by Gatekeeper ("Apple cannot
      check it for malicious software"). Workaround, documented in the README and the packaging notes:
      `xattr -d com.apple.quarantine ./qqq-darwin-arm64`, or Finder, right-click, Open.
- [ ] **Windows Authenticode certificate** (the KofTwentyTwo release standard). Without it SmartScreen
      warns on first run ("Windows protected your PC", More info, Run anyway); Scoop installs still work.
- [ ] **Create `QRun-IO/homebrew-tap`** by copying `docs/packaging/homebrew-tap/` into a new public
      repository (main branch) and following it in CircleCI (the qqq-orb `homebrew-tap` profile is
      already in `.qqq-ci.yml`). Without it: no `brew install`; the curl installer still works.
- [ ] **Create the Scoop bucket** (`QRun-IO/scoop-bucket` with `bucket/qqq.json`), or decide to put the
      manifest next to qctl's. Without it: Windows users download the `.exe` from the release.
- [ ] **CircleCI context** `qqq-maven-registry-credentials` holds a `GITHUB_TOKEN` that can write the
      four `@qrun-io` packages (the orb checks it authenticates; write access is only proven by a publish).
- [ ] **Go for 1.0.0 final** after the release candidate has been used (rc.1 tagged, installed, no
      blocker open).

## Not verified before 1.0 (unless the lanes run first)

- `qqq-windows-x64.exe` (CLI and UI) has never run; the Windows lane runs `scripts/verify-binary.ps1`.
- `qqq-darwin-x64` has never run (no Intel Mac or Rosetta on the build machine).
- Windows Terminal rendering of `qqq ui`, and the DPAPI keyring outside unit tests.

Verified on the build machine: darwin-arm64 (CLI, keyring, completion, `qqq ui` tmux smoke and width
smoke against the sample server), linux-x64 glibc, linux-arm64 glibc and linux-arm64-musl in Docker
(CLI and `qqq ui` in tmux), the npm tarballs installed on Node 20, the Homebrew formula in the
`homebrew/brew` container, and the curl installer from a local mirror.

## 1. Branch green

- `feat/m5-cli-release` (and whatever else is in the release) is merged to `main`; the orb pipeline on
  `main` is green on its Node 22.12 image, and so are the platform lanes once they exist.
- Locally on `main`, clean tree: `npm ci && npm run build && npm test && npm run lint && npm run test:tui`.

## 2. Versions: release candidate to final

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

Then `npm install` (refreshes `package-lock.json`) and `npm run lint`, which fails if any version
disagrees. Commit (`git commit -S -m "release: 1.0.0"`), merge to `main` through a pull request.

## 3. Release check and binaries

On `main` at the release commit, clean tree:

```sh
node scripts/release.mjs        # npm ci, generate drift, build, test, lint, TUI tests and type check,
                                # pack dry runs, the 7 binaries with the UI and dist/SHA256SUMS
scripts/verify-binary.sh dist/qqq-darwin-arm64 --server http://localhost:8077   # sample server running
```

`release.mjs` prints the commands for steps 5 and 6 with the right versions.

## 4. Sign (James's credentials)

Signing changes the files, so it comes before the checksums are final.

```sh
# macOS, both binaries. Bun's JIT needs these entitlements; OpenTUI loads its native library at run time.
cat > /tmp/qqq.entitlements <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
XML
for f in dist/qqq-darwin-arm64 dist/qqq-darwin-x64; do
  codesign --force --timestamp --options runtime --entitlements /tmp/qqq.entitlements \
    --sign "Developer ID Application: <team>" "$f"
  ditto -c -k "$f" "$f.zip" && xcrun notarytool submit "$f.zip" --keychain-profile qqq-notary --wait && rm "$f.zip"
done
# a bare executable cannot be stapled: Gatekeeper looks the ticket up online on first run

# Windows (signtool on Windows, or osslsigncode elsewhere)
osslsigncode sign -pkcs12 <cert.p12> -pass "$PASS" -h sha256 -t http://timestamp.digicert.com \
  -in dist/qqq-windows-x64.exe -out dist/qqq-windows-x64.signed.exe && mv dist/qqq-windows-x64.signed.exe dist/qqq-windows-x64.exe

(cd dist && shasum -a 256 qqq-* > SHA256SUMS)          # recompute after signing
scripts/verify-binary.sh dist/qqq-darwin-arm64         # still runs after signing
spctl --assess --type execute -vv dist/qqq-darwin-arm64  # "accepted, source=Notarized Developer ID"
```

The entitlements are the ones Bun documents for signed executables plus library validation for the
embedded native library; check them on the first signed build (`qqq ui` must start).

## 5. Tags and packages

```sh
git tag -s v1.8.0 -m "UI API client 1.8.0, qqq 1.0.0"     # the orb publishes on v<client version>
git tag -s cli-v1.0.0 -m "qqq 1.0.0"                      # the GitHub release with the binaries
git push origin v1.8.0 cli-v1.0.0
```

The tag `v1.8.0` makes the orb's `cli` profile verify the commit again and publish the client,
conformance and CLI (and core, once the orb change is released) to GitHub Packages. Watch the
`publish_release` workflow. Until the orb publishes core and final dist-tags, finish by hand:

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
candidate use `--prerelease` instead of `--latest`. The curl installer takes the newest `cli-v*`
release, prereleases included.

## 7. Homebrew tap and Scoop bucket

```sh
gh release download cli-v1.0.0 --repo QRun-IO/qqq-cli -p SHA256SUMS -D /tmp/qqq-1.0.0
node scripts/update-packaging.mjs /tmp/qqq-1.0.0/SHA256SUMS
git commit -S -am "packaging: qqq 1.0.0" && git push      # in qqq-cli, through a pull request
```

Then copy `docs/packaging/homebrew-tap/Formula/qqq.rb` to `Formula/qqq.rb` in `QRun-IO/homebrew-tap`
and `docs/packaging/qqq.json` to `bucket/qqq.json` in the Scoop bucket, a pull request on each. The tap's
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
