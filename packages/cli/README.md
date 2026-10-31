# @qrun-io/qqq-cli

`qqq`, the command-line client for [QQQ](https://github.com/QRun-IO/qqq) applications. It talks to a
QQQ server only through the UI API (`/qqq/v1`), the same API the web UI uses, so every app, table,
field and process comes from the server's metadata.

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli@rc
qqq login --server https://admin.example.com
qqq table query person -w "lastName STARTS_WITH S" -o -id -l 5
```

Requires Node.js 20 or later, or use a single-file binary from the
[releases](https://github.com/QRun-IO/qqq-cli/releases) (no Node needed). Servers: UI API 1.6.0 up to
2.0 (`qqq --version` prints the range).

Grammar, sign-in, profiles, output formats and exit codes: see the
[repository README](https://github.com/QRun-IO/qqq-cli#readme) and
[TRY-IT.md](https://github.com/QRun-IO/qqq-cli/blob/main/TRY-IT.md).

Apache-2.0
