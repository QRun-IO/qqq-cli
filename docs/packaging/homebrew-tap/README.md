# QRun-IO Homebrew tap

Homebrew formulae for QRun-IO command-line tools.

```sh
brew install qrun-io/tap/qqq        # taps QRun-IO/homebrew-tap on first use
qqq --version                       # "... binary with ui ..."
qqq login --server https://your-qqq-server
qqq ui                              # the terminal UI, in the same binary
```

| Formula | What | Source |
|---|---|---|
| `qqq` | the QQQ command-line client and terminal UI, one binary (macOS arm64 and x64, Linux arm64 and x64) | [QRun-IO/qqq-cli](https://github.com/QRun-IO/qqq-cli) |

`qctl` lives in [QRun-IO/homebrew-qctl](https://github.com/QRun-IO/homebrew-qctl) for now; it can move
here (`Formula/qctl.rb`) once this tap exists, with `homebrew-qctl` kept as a pointer.

## Updating

The formula is generated in qqq-cli: after a `cli-v<version>` GitHub release, run
`node scripts/update-packaging.mjs <release SHA256SUMS>` there and copy
`docs/packaging/homebrew-tap/Formula/qqq.rb` here. The tap's old CI (qqq-orb `homebrew-tap` profile,
which installed the formula and ran its test) was retired on 2026-11-07; Gitea CI for the tap is not
decided yet, so check the formula by hand (`brew install --build-from-source ./Formula/qqq.rb && brew test qqq`). The script refuses to write missing or
malformed sums; still compare the sums in the diff with the release's `SHA256SUMS` before opening the PR.

Apache-2.0
