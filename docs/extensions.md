# Extension documents in the client

The client document (`packages/ui-api-client/openapi/qqq-v1.json`) is qqq's committed core document
(`qqq-middleware-javalin/src/main/resources/openapi/v1/openapi.yaml`, qqq `develop` 7825261ab, UI API
1.10.0) merged with the extension document each repository commits at `src/main/resources/openapi/qqq-v1/`
(esb and health from the same qqq commit). Rebuild it from checkouts at the refs below:

```sh
npm run spec:merge-extensions -- --core <qqq>/qqq-middleware-javalin/src/main/resources/openapi/v1/openapi.yaml
npm run generate                                       # writes openapi/extension-sources.json too
```

Without `--core` the script reads the sample server's live document (`http://localhost:8077`), which is
only as new as the server that is running. For 1.10.0 the documents were exported (`git archive`) from
each repository's `origin/develop` (`origin/main` for qbit-printing, which has no `develop`) into one
directory passed as `--root`, and `extension-sources.json` records those refs.

Versions merged on 2026-11-05 (machine-readable copy: `packages/ui-api-client/openapi/extension-sources.json`):

| Extension | Version | Prefix | Operations | Repository at | Minimum the client needs |
|---|---|---|---|---|---|
| esb | 1.1.0 | `/esb` | 5 | qqq `develop` 7825261ab (qqq-esb) | 1.1.0 (operationIds, UI-API-CHANGELOG) |
| health | 1.1.0 | `/health` | 4 | qqq `develop` 7825261ab (qqq-middleware-javalin) | 1.1.0 (same) |
| alerts | 1.2.0 | `/alerts` | 6 | qbit-alerts `develop` 420cc69 | |
| assistant | 1.7.0 | `/assistant` | 16 | qbit-assistant `develop` 67bdd32 | |
| collaboration | 1.2.0 | `/qbit/collaboration` | 45 | qbit-collaboration `develop` 7d61f29 (per-session presence is merged there) | 1.1.0 (presence schemas, error contract); 1.2.0 adds per-connection presence (`connections`, `leaseCount`, `perConnection`), used when present |
| data-analysis | 1.5.0 | `/qbit/data-analysis` | 21 | qbit-data-analysis `develop` f2fd8b1 | |
| db-performance | 1.0.0 | `/qbit/db-performance` | 4 | qbit-db-performance `develop` b70c234 | |
| edi | 1.1.0 | `/qbit/edi` | 4 | qbit-edi `develop` 683995c | |
| printing | 2.3.0 | `/qbit/printing` | 20 | qbit-printing `main` 0ab07fc | 2.0.0 (realtime-v1); 2.1.0 adds the table-list and text prints Ctrl+P uses |
| qa-capture | 1.0.0 | `/qbit/qa-capture` | 2 | qbit-qa-capture `develop` 8ca3fd7 | |
| quick-search | 1.1.0 | `/qbit/quick-search` | 2 | qbit-quick-search `develop` e3aa05e | |
| release-notes | 1.0.0 | `/qbit/release-notes` | 3 | qbit-release-notes `develop` 8abbe6f | |
| secured-data | 1.1.0 | `/qbit/secured-data` | 3 | qbit-secured-data `develop` 5987cb5 | |
| sql-workbench | 1.1.0 | `/sql-workbench` | 21 | qbit-sql-workbench `develop` 1784a5b | |

222 operations in all, 156 from extensions. Shared schemas are identical (such as `BasicErrorResponseV1`)
except one: data-analysis 1.5.0 still carries `FilterCriteria` as it was before UI API 1.9.0 (without
`options`). `scripts/merge-spec.mjs` accepts an extension's older copy of a schema (the same schema
without the properties and enum values added since) and keeps the newer core one, with a warning; a copy
that differs in any other way still fails the merge. There is no `qbit-middleware-health`: the
health extension lives in qqq's `qqq-middleware-javalin`. Other qbits in the workspace (authentik,
jobs, help, middleware-mcp, ...) register no UI API extension.

Minimums are only set where an extension's own docs state one; the rest accept any version the
server lists. Each extension's minimum and realtime channels live in
`packages/core/src/extensions/registry.ts` (`FACTS`).
