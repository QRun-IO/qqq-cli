# @qrun-io/qqq-core

The client kernel the QQQ terminal clients build on: everything that is not a terminal. The CLI prints
what it produces; the TUI draws it.

| Module | What it does |
|---|---|
| `render/output` | json, table, text, csv and yaml output, JMESPath `--query`, tty-aware default format |
| `filter/grammar` | the filter grammar: criteria with shorthand operators, quoted values, AND/OR groups with parentheses, expression values (`now(-7d)`, `thisPeriod(month)`, `startOf(quarter,-1)`, `me()`, `${variable.x}`), parsed to a `QueryFilter` and printed back |
| `api/operations`, `api/call` | the operation index generated from the OpenAPI document, and `callOperation(baseUrl, id, input, fetch)` to call any operation by id |
| `forms/fields` | field metadata helpers: contingent-field dependencies and the DISABLE_UNTIL_SET rule, behaviors, validation that mirrors the server's rules |
| `forms/possible-values` | possible-value search with dependency values; resolution of typed text by id, exact label or unique partial |
| `forms/adjuster` | form adjusters (`onLoad`, `onChange`; 404 means none) and how their output is applied |
| `forms/datetime` | DATE_TIME between people and the server: local wall-clock text to UTC instants in a zone (DST gaps forward, repeated hours first), instants shown in the zone, server zoned display kept, filter criteria converted |
| `forms/form-session` | one form being filled: values, display values, clearing dependents, adjusters, validation, submission |
| `process/runner` | init, step until complete, poll asynchronous jobs, apply metadata adjustments, ask a provider for each step's input, go back (`BACK`), cancel on an abort signal (`POST …/cancel`), check min/max input records |
| `process/screen` | each step's components as neutral screen blocks: help, HTML as text, view pairs, process records (paged), validation review, summary lines, downloads (`GET /download`), widgets |
| `widgets/render-model` | any widget payload to neutral blocks (heading, stat, table, series, pairs, steps, alert, link, rule, children) and blocks to text |
| `metadata/cache` | on-disk cache of `GET /metaData` and table definitions per server, with a TTL and offline reads |
| `extensions/registry` | every extension the client document carries (operations, documented minimum version, realtime channels), joined with the server's `GET /version`: `has`, `require` (typed `ExtensionNotInstalledError`), unknown extensions kept; see `src/extensions/README.md` |
| `extensions/collaboration` | the collaboration qbit: live presence (`joinPresence`, a no-op without the extension), comments, favorites, recents, follow, people, my work |
| `session/profiles`, `session/keyring` | named profiles and an OS keyring without native modules (Keychain, Secret Service, DPAPI, file) |

Rules the kernel keeps for both heads: every call is a spec operation named by `operationId`; text comes from the
server (labels, never names); unknown enum values and extra fields are tolerated; no table, process or capability
name is hard-coded; no Bun-only or terminal API is used.

```sh
npm run build -w @qrun-io/qqq-core && npm test -w @qrun-io/qqq-core
```
