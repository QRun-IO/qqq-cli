# @qrun-io/qqq-ui-api-client

A typed TypeScript client for the [QQQ](https://github.com/QRun-IO/qqq) UI API (`/qqq/v1`), generated
from the merged OpenAPI document (core plus the extension documents of the qbits), with OAuth2
device-flow and PKCE sign-in, token refresh and a realtime (SSE) reader.

```ts
import { createUiApiClient, unwrap } from '@qrun-io/qqq-ui-api-client'

const api = createUiApiClient({ baseUrl: 'https://admin.example.com', token: () => process.env.QQQ_TOKEN!, clientChannel: 'tui/my-tui 1.0' })
const page = await unwrap(api.POST('/qqq/v1/table/{tableName}/query', {
  params: { path: { tableName: 'person' } },
  body: { filter: { criteria: [{ fieldName: 'lastName', operator: 'STARTS_WITH', values: ['K'] }], limit: 20 } },
}))
```

The package version follows the UI API version of the document it was generated from (`UI_API_VERSION`);
the document itself is exported as `@qrun-io/qqq-ui-api-client/openapi/qqq-v1.json`. Node.js 20 or later,
or any runtime with `fetch`.

More: the [repository README](https://github.com/QRun-IO/qqq-cli#readme) and QQQ's
[`UI-API-CLIENTS.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CLIENTS.md).

Apache-2.0
