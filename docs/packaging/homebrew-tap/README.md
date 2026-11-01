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
`docs/packaging/homebrew-tap/Formula/qqq.rb` here. CI (qqq-orb `homebrew-tap` profile) fetches every
platform's download, installs the formula and runs its test, which fails on a wrong or all-zero sum, but
only once the pull request here is opened and its checks are read. The script refuses to write missing or
malformed sums; still compare the sums in the diff with the release's `SHA256SUMS` before opening the PR.

Apache-2.0
