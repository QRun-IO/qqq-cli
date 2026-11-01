# @qrun-io/qqq-core

The client kernel the QQQ terminal clients build on: everything that is not a terminal. The `qqq` CLI
prints what it produces; the terminal UI (`qqq ui`) draws it. Use it to build another client of the
[QQQ](https://github.com/QRun-IO/qqq) UI API (a CLI, a TUI, an editor plugin, a bot) without
re-implementing the filter grammar, forms, the process runner or sign-in storage.

## Install

Published to GitHub Packages (a GitHub token with `read:packages` is needed even for public packages):

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install @qrun-io/qqq-core
```

ESM only, Node.js 20 or later (it uses Node built-ins for files, the keyring and the terminal check).
It depends on [`@qrun-io/qqq-ui-api-client`](https://github.com/QRun-IO/qqq-cli/tree/main/packages/ui-api-client#readme)
for the typed API and sign-in.

## Quick start

Parse the filter grammar, call any operation by id, render the result as the CLI does (against the QQQ
sample server on `http://localhost:8077`, MOCK authentication):

```js
import { createSession } from '@qrun-io/qqq-ui-api-client'
import { parseFilter, printFilter, callOperation, render } from '@qrun-io/qqq-core'

const filter = parseFilter('lastName STARTS_WITH S AND (firstName = Avery OR firstName = Blair)')
console.log(printFilter(filter))
// lastName STARTS_WITH S AND (firstName EQUALS Avery OR firstName EQUALS Blair)

const baseUrl = 'http://localhost:8077'
const { sessionUUID } = await createSession(baseUrl)
const authed = (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, Cookie: `sessionUUID=${sessionUUID}` } })

const result = await callOperation(baseUrl, 'queryTable', { path: { tableName: 'person' }, json: { filter: { ...parseFilter('id <= 3'), limit: 3 } } }, authed)
console.log(render({ data: result.data.records.map((r) => r.values), columns: ['id', 'firstName', 'lastName'] }, 'table'))
// id  firstName  lastName
// --  ---------  --------
// 1   Avery      Sample
// ...
```

For a real client, `loginFetch` (with `resolveProfile` and `defaultSecretStore`) gives a fetch that
sends the stored sign-in of a `qqq` profile, refreshing OAuth2 tokens as needed, so sign-ins made with
`qqq login` work in your tool too.

## Modules

Everything is exported from the package root.

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
| `records/associations` | related records: association labels, the values binding a child to its parent (composite joins too), child-list filters, the association tree of a record read with `includeAssociations`, child pages with counts |
| `records/record-view` | the record view as text: sections without hidden sections or fields, adornments (LINK, CHIP, REVEAL, RENDER_HTML, CODE_EDITOR, ERROR, FILE_DOWNLOAD, WIDGET, TOOLTIP), view-screen help by role |
| `widgets/render-model` | any widget payload to neutral blocks (heading, stat, table, series, pairs, steps, alert, link, rule, children) and blocks to text |
| `metadata/cache` | on-disk cache of `GET /metaData` and table definitions per server, with a TTL and offline reads |
| `extensions/registry` | every extension the client document carries (operations, documented minimum version, realtime channels), joined with the server's `GET /version`: `has`, `require` (typed `ExtensionNotInstalledError`), unknown extensions kept; see [`src/extensions/README.md`](https://github.com/QRun-IO/qqq-cli/blob/main/packages/core/src/extensions/README.md) |
| `extensions/collaboration` | the collaboration qbit: live presence (`joinPresence`, a no-op without the extension), comments, favorites, recents, follow, people, my work |
| `session/profiles`, `session/keyring` | named profiles and an OS keyring without native modules (Keychain, Secret Service, DPAPI, file) |
| `session/login` | a profile's stored sign-in and the fetch that sends it (`loginFetch`): server sessions as a cookie, OAuth2 tokens as a bearer refreshed when expiring, `QQQ_TOKEN` over everything; TABLE_BASED password sign-in |
| `session/local-state` | command histories, recently viewed records and the screen-lock PIN hash (`QQQ_STATE_DIR`) |
| `filter/complete` | completion for the filter grammar: what can come next at the cursor (field, operator for its type, value, AND/OR) |
| `metadata/index`, `metadata/navigation` | a search index over apps, tables, processes, reports and widgets for palettes on large instances; app homes and runnable reports from the metadata |
| `query/quick-search`, `query/joins`, `query/column-stats`, `query/saved-views` | quick search as the web UI does it, exposed joins (`joinTable.field`), column statistics, saved views shared with the web UIs |
| `records/result-cursor` | a position in a query result with page caching, for grid paging and next/previous record |
| `records/goto`, `records/copy`, `records/variants` | go to a record by a unique key, copy a record, table variants (`tableVariant`) |
| `records/audits`, `records/sharing`, `records/developer` | audit history, record sharing, developer mode (associated scripts, developer panels, application APIs) |
| `bulk/mapping`, `bulk/run` | bulk-load column and value mappings (mapping documents), and bulk insert, edit and delete through the process runner |
| `forms/dynamic-form` | the `dynamicForm` widget on record forms |
| `reports/reports` | reports, saved reports (filter, columns, pivot), report schedules |
| `widgets/controls`, `widgets/loader` | widget dropdowns and parameters; loading widgets (and their children) into render blocks as the web does |
| `help/help-content` | help content from the metadata as plain text, filtered by screen role |
| `render/files`, `files/navigator` | safe saving of server-named downloads; directory listings and file preferences for a file chooser |
| `env/doctor` | the terminal and tmux check behind `qqq doctor` and `qqq ui --check` |

Rules the kernel keeps for both heads: every call is a spec operation named by `operationId`; text comes from the
server (labels, never names); unknown enum values and extra fields are tolerated; no table, process or capability
name is hard-coded; no Bun-only or terminal API is used.

## Compatibility and versioning

- Servers: UI API 1.6.0 up to 2.0, the same range as the CLI. Features that need a newer server are
  gated on `GET /qqq/v1/version` (features and extensions) and fall back or report what is missing.
- The package follows semver from 1.0.0 and is released together with the CLI; it pins
  `@qrun-io/qqq-ui-api-client` exactly.

## Building and testing

In the [qqq-cli repository](https://github.com/QRun-IO/qqq-cli):

```sh
npm run build -w @qrun-io/qqq-ui-api-client && npm run build -w @qrun-io/qqq-core && npm test -w @qrun-io/qqq-core
```

Apache-2.0
