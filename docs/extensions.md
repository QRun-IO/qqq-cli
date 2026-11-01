# Extension documents in the client

The client document (`packages/ui-api-client/openapi/qqq-v1.json`) is the sample server's live
document for core (QQQ 4.1.0-SNAPSHOT, `develop` 6ac64fc66, UI API 1.8.0, which already carries esb)
merged with the extension document each repository commits at `src/main/resources/openapi/qqq-v1/`.
Rebuild it with the sample server running:

```sh
npm run spec:merge-extensions && npm run generate     # writes openapi/extension-sources.json too
```

Versions merged on 2026-10-31 (machine-readable copy: `packages/ui-api-client/openapi/extension-sources.json`):

| Extension | Version | Prefix | Operations | Repository at | Minimum the client needs |
|---|---|---|---|---|---|
| esb | 1.1.0 | `/esb` | 5 | qqq `develop` 6ac64fc66 (qqq-esb) | 1.1.0 (operationIds, UI-API-CHANGELOG) |
| health | 1.1.0 | `/health` | 4 | qqq `develop` 6ac64fc66 (qqq-middleware-javalin) | 1.1.0 (same) |
| alerts | 1.2.0 | `/alerts` | 6 | qbit-alerts `develop` a3fc6ac | |
| assistant | 1.6.0 | `/assistant` | 16 | qbit-assistant `develop` bcf173f | |
| collaboration | 1.2.0 | `/qbit/collaboration` | 45 | qbit-collaboration `feat/per-session-presence` 0ae1e62 (local worktree `.worktrees/qbit-collab-sessions`, not yet on `develop`) | 1.1.0 (presence schemas, error contract); 1.2.0 adds per-connection presence (`connections`, `leaseCount`, `perConnection`), used when present |
| data-analysis | 1.5.0 | `/qbit/data-analysis` | 21 | qbit-data-analysis `develop` 368d2c0 | |
| db-performance | 1.0.0 | `/qbit/db-performance` | 4 | qbit-db-performance `develop` 4fd2c30 | |
| edi | 1.1.0 | `/qbit/edi` | 4 | qbit-edi `develop` 75a4e6b | |
| qa-capture | 1.0.0 | `/qbit/qa-capture` | 2 | qbit-qa-capture `develop` 1aee6cb | |
| quick-search | 1.1.0 | `/qbit/quick-search` | 2 | qbit-quick-search `develop` bd50e1f | |
| release-notes | 1.0.0 | `/qbit/release-notes` | 3 | qbit-release-notes `develop` 8fed18e | |
| secured-data | 1.1.0 | `/qbit/secured-data` | 3 | qbit-secured-data `develop` 7b302ed | |
| sql-workbench | 1.1.0 | `/sql-workbench` | 21 | qbit-sql-workbench `develop` a182076 | |
| printing | 2.1.0 | `/qbit/printing` | 17 | qbit-printing `feat/print-anything` | 2.0.0 (realtime-v1); 2.1.0 adds the table-list and text prints Ctrl+P uses |

219 operations in all, 153 from extensions (printing was appended on 2026-11-01 with
`scripts/merge-spec.mjs`, keeping the other documents as they were). No extension document conflicted with core or another
(identical shared schemas such as `BasicErrorResponseV1`). There is no `qbit-middleware-health`: the
health extension lives in qqq's `qqq-middleware-javalin`. Other qbits in the workspace (authentik,
jobs, help, middleware-mcp, ...) register no UI API extension.

Minimums are only set where an extension's own docs state one; the rest accept any version the
server lists. Each extension's minimum and realtime channels live in
`packages/core/src/extensions/registry.ts` (`FACTS`).
