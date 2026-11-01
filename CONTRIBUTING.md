# Contributing to qqq-cli

Thanks for helping. This repository holds `qqq` (the CLI and the terminal UI) and the TypeScript packages
it is built on. Bugs and ideas go in [issues](https://github.com/QRun-IO/qqq-cli/issues); problems in the
QQQ server or the UI API itself belong in [QRun-IO/qqq](https://github.com/QRun-IO/qqq/issues).
Security problems: see [SECURITY.md](SECURITY.md), never a public issue.

## Layout

| Path | What | Toolchain |
|---|---|---|
| `packages/ui-api-client` | the typed client, generated from `openapi/qqq-v1.json` | npm workspace, TypeScript |
| `packages/core` | the client kernel (no terminal code) | npm workspace, TypeScript |
| `packages/conformance` | the conformance suite and `qqq-dev-idp` | npm workspace, TypeScript |
| `packages/cli` | `qqq` | npm workspace, TypeScript, commander |
| `packages/tui` | `qqq ui` (OpenTUI on Bun); private, bundled into the binaries | Bun, its own `bun.lock` |
| `scripts/` | spec merging, code generation, lint, binaries, release, packaging, install | Node, sh |
| `docs/` | see [docs/README.md](docs/README.md) | |

## Setup

- Node.js 20 or later (CI runs 22) and npm. The workspaces share the root `package-lock.json`.
- Bun 1.4 or later, for the TUI and for building binaries (`brew install bun`, or https://bun.sh).
- For trying changes against a real server: the QQQ sample server (Java 21, Maven), see [TRY-IT.md](TRY-IT.md).
  `npm run mock` serves the API document with Prism on http://127.0.0.1:4010 when no server is at hand.

```sh
git clone https://github.com/QRun-IO/qqq-cli && cd qqq-cli
npm ci
npm run build
node packages/cli/dist/main.js --help        # the CLI from the checkout
node packages/cli/dist/main.js ui            # the TUI from source (runs Bun)
```

## Checks

Every pull request must pass, locally and in CI:

```sh
npm run build && npm test && npm run lint    # lint: license headers, no cross-package src imports, version consistency
npm run test:tui                             # when packages/tui or the kernel changed
npm run typecheck:tui                        # likewise
```

When the API document changes (`npm run spec:merge` or `npm run spec:merge-extensions`), run
`npm run generate` and commit the regenerated `packages/ui-api-client/src/schema.ts` and
`packages/core/src/api/operations.ts`; CI fails when `schema.ts` drifts and `scripts/release.mjs` checks both. Do not edit generated files by hand.

## Code

- TypeScript, ESM, strict. Each package imports the others by package name, never from another package's
  `src/` (lint enforces it).
- Every source file starts with the license header lint checks:
  `Copyright 2026 QRun.IO, Inc.` / `Licensed under the Apache License, Version 2.0 (see LICENSE).`
- Nothing about an application is hard-coded: tables, processes, labels and capabilities come from the
  server's metadata, and unknown enum values or fields are tolerated. Every call is a spec operation.
- `@qrun-io/qqq-core` and the CLI use no Bun-only API; the TUI uses OpenTUI and only draws what the
  kernel produces.
- Tests sit next to the code in `src/test` (`node --test`) and `packages/tui/test` (`bun test`). New
  behaviour comes with a test; a bug fix with a test that failed before it.
- Commands, output shapes and exit codes are a public interface. Changing one is a breaking change: say
  so in the pull request and the CHANGELOG.

## Commits and pull requests

- **Signed commits are required on `main`** (`git commit -S`; set up SSH or GPG signing in GitHub). Unsigned
  commits cannot be merged.
- Conventional-commit subjects (`feat(cli): ...`, `fix(core): ...`, `docs: ...`), with a body that says why.
- Branch from `main`; one topic per pull request. Fill in the pull request template, including how you
  tested against a server.
- User-visible changes get a line in [CHANGELOG.md](CHANGELOG.md) under the next version, and new or
  changed commands are documented in the README, TRY-IT.md or the package README.
  `node scripts/readiness.mjs` checks that every `qqq` command in README.md and TRY-IT.md exists.
- Do not bump package versions in a feature pull request; releases do that
  ([docs/release-runbook.md](docs/release-runbook.md)).
- [CODEOWNERS](.github/CODEOWNERS) requests the maintainer's review on every pull request.

## License

By contributing you agree that your contribution is your own work and is licensed under the
[Apache License 2.0](LICENSE), the license of this repository.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
