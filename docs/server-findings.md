# UI API server findings from the terminal clients

Observed while building the CLI and TUI against QQQ 4.1.0-SNAPSHOT (`develop` 6ac64fc66, UI API 1.8.0) with
the sample app and MOCK authentication. Each is a candidate issue for `QRun-IO/qqq`; none is filed yet.

| # | Finding | How to reproduce | Client workaround |
|---|---|---|---|
| 1 | A bearer session UUID cannot continue an asynchronous process step: the job fails with `Permission denied for process state`. The same UUID as the `sessionUUID` cookie works. | `POST /manageSession` (MOCK), then `init` and `step` `sleepInteractive` with `stepTimeoutMillis=0` using `Authorization: Bearer {uuid}`; poll status. | Session sign-ins are sent as a cookie (`sessionCookie` option of the client). |
| 2 | Process `init` and `step` silently ignore a url-encoded `values` JSON field; only `multipart/form-data` is read. No 400. | `curl -d 'values={"sleepMillis":4000}'` runs with the default 1000 ms. | Clients always send multipart. A 415 or 400 would help. |
| 3 | `GET /jobs` answers 404 although `/version` lists `durableJobs` in `features`. | Sample server, `qqq job list`. | The CLI explains; the TUI footer shows `jobs n/a`. Either drop the feature flag when no job store exists, or serve an empty list. |
| 4 | `searchTablePossibleValues` with `ids: ["Narnia"]` on an INTEGER possible-value field returns 500 `QException (Error executing query)`. | `qqq api searchTablePossibleValues --path tableName=placeAddress --path fieldName=countryId --body-json '{"ids":["Narnia"]}'` | Clients only send ids that can parse for the field type. A 400 with `fieldErrors` would be right. |
| 5 | `searchTablePossibleValues` with `searchTerm` matches case-sensitively (or by prefix) on this source: `can` does not find `Canada`. | Same table, `{"searchTerm":"can"}` on `countryId`. | Clients fetch the first page and match client-side when the search returns nothing. Document the matching rule in the spec. |
| 6 | `GET /table/{t}/{pk}` returns `{ record: {...} }` while `query` returns `{ records: [...] }` with bare records; the design doc and the 0.1 CLI expected a bare record. | Any record. | Clients unwrap both. Worth a note in `UI-API-CLIENTS.md`. |
| 7 | Process `init` on `clonePeople` without records answers `ERROR` with `No records were selected…` only after `init`; `getProcessMetaData` says `minInputRecords` 0. | `qqq process run clonePeople`. | Clients show the message. The metadata could carry the real minimum. |
| 8 | `manageSession` has no documented username and password fields for `TABLE_BASED`, so a native client cannot sign in to such an app without the browser. | Spec `manageSession` request body. | `qqq login` refuses TABLE_BASED with a message. The design doc's nice-to-have "documented TABLE_BASED bearer recipe". |
| 9 | `searchRecords` returned no results for `Avery` although `person` has search fields; unclear whether the sample app configures a search provider. | `qqq search Avery`. | None; needs a look at the sample's search setup. |
