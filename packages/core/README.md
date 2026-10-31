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
| `forms/form-session` | one form being filled: values, display values, clearing dependents, adjusters, validation, submission |
| `process/runner` | init, step until complete, poll asynchronous jobs, apply metadata adjustments, ask a provider for each step's input |
| `records/associations` | related records: association labels, the values binding a child to its parent (composite joins too), child-list filters, the association tree of a record read with `includeAssociations`, child pages with counts |
| `records/record-view` | the record view as text: sections without hidden sections or fields, adornments (LINK, CHIP, REVEAL, RENDER_HTML, CODE_EDITOR, ERROR, FILE_DOWNLOAD, WIDGET, TOOLTIP), view-screen help by role |
| `widgets/render-model` | any widget payload to neutral blocks (heading, stat, table, series, pairs, steps, alert, link, rule, children) and blocks to text |
| `metadata/cache` | on-disk cache of `GET /metaData` and table definitions per server, with a TTL and offline reads |
| `session/profiles`, `session/keyring` | named profiles and an OS keyring without native modules (Keychain, Secret Service, DPAPI, file) |

Rules the kernel keeps for both heads: every call is a spec operation named by `operationId`; text comes from the
server (labels, never names); unknown enum values and extra fields are tolerated; no table, process or capability
name is hard-coded; no Bun-only or terminal API is used.

```sh
npm run build -w @qrun-io/qqq-core && npm test -w @qrun-io/qqq-core
```
