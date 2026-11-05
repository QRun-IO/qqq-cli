# @qrun-io/qqq-ui-api-client

A typed TypeScript client for the [QQQ](https://github.com/QRun-IO/qqq) UI API (`/qqq/v1`), the API the
QQQ web UI, the `qqq` CLI and the terminal UI all use. It is generated from the merged OpenAPI document
(the core API plus the extension documents of 14 QBits) and adds what a native client needs around it:
OAuth2 device-flow and PKCE sign-in, token refresh, server sessions, typed errors and a realtime (SSE)
reader.

## Install

Published to GitHub Packages (a GitHub token with `read:packages` is needed even for public packages):

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install @qrun-io/qqq-ui-api-client
```

ESM only. Runs on Node.js 20 or later, Bun and Deno: it needs only `fetch` and Web Crypto. The one
runtime dependency is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/).

## Quick start

Against the QQQ sample server on `http://localhost:8077` (MOCK authentication):

```ts
import { createUiApiClient, createSession, unwrap, UiApiError } from '@qrun-io/qqq-ui-api-client'

const baseUrl = 'http://localhost:8077'
const { sessionUUID } = await createSession(baseUrl)
const api = createUiApiClient({ baseUrl, sessionCookie: () => sessionUUID, clientChannel: 'tui/my-tui 1.0' })

const version = await unwrap(api.GET('/qqq/v1/version'))
console.log(version.apiVersion)                              // '1.8.0'

const page = await unwrap(api.POST('/qqq/v1/table/{tableName}/query', {
  params: { path: { tableName: 'person' } },
  body: { filter: { criteria: [{ fieldName: 'id', operator: 'LESS_THAN_OR_EQUALS', values: [3] }], limit: 20 } },
}))
console.log(page.records?.map((r) => r.values.firstName))    // [ 'Avery', 'Blair', 'Casey' ]

try {
  await unwrap(api.GET('/qqq/v1/metaData/table/{tableName}', { params: { path: { tableName: 'nope' } } }))
} catch (e) {
  if (e instanceof UiApiError) console.log(e.status, e.code, e.message)   // 404 'NOT_FOUND' 'Table [nope] was not found.'
}
```

Paths, path and query parameters, request bodies and responses are all typed from the document, for the
core API and every extension. Without `unwrap`, a call resolves to openapi-fetch's
`{ data, error, response }`.

## Signing in

`GET /qqq/v1/metaData/authentication` (`getAuthenticationMetaData`) says how a server authenticates.

| Type | How to get a credential | Pass it as |
|---|---|---|
| `OAUTH2`, `AUTH_0` | `getNativeSignInConfig(baseUrl)`, then `deviceSignIn(config, onPrompt)` (RFC 8628), or the PKCE pieces `createPkce`, `createState`, `authorizationUrl`, `readAuthorizationCallback`, `exchangeAuthorizationCode` for a loopback redirect (RFC 8252). Keep the session fresh with `isExpiring` and `refreshTokens`; sign out with `revokeToken` and `endSessionUrl`. | `token: () => tokens.accessToken` (bearer) |
| `TABLE_BASED` | a username and password; `@qrun-io/qqq-core` has the flow (`signInWithPasswordCookie`, `loginFetch`) | the `sessionId` cookie, through a `fetch` that adds it |
| `MOCK`, `FULLY_ANONYMOUS` | `createSession(baseUrl)` | `sessionCookie` |

Device flow against an OAuth2 server:

```ts
import { createUiApiClient, getNativeSignInConfig, deviceSignIn, isExpiring, refreshTokens } from '@qrun-io/qqq-ui-api-client'

const baseUrl = 'https://<your-qqq-server>'
const config = await getNativeSignInConfig(baseUrl)          // the app's public native client and issuer
let tokens = await deviceSignIn(config, (p) => console.log(`Open ${p.verificationUriComplete ?? p.verificationUri} and enter ${p.userCode}`))

const api = createUiApiClient({
  baseUrl,
  token: async () => {
    if (isExpiring(tokens) && tokens.refreshToken) tokens = await refreshTokens(config, tokens.refreshToken)
    return tokens.accessToken
  },
  clientChannel: 'tui/my-tui 1.0',
})
```

`onUnauthorized` (return `true` after refreshing) retries a request once after a 401.

## API surface

| Export | What it is |
|---|---|
| `createUiApiClient(options)` | the typed client (`GET`, `POST`, `PUT`, `DELETE`, ... on every path). Options: `baseUrl`, `token` or `sessionCookie`, `onUnauthorized`, `clientChannel` (sent as `X-QQQ-Client`), `headers`, `fetch` |
| `unwrap(call)` | the call's data, or throws `UiApiError` |
| `UiApiError`, `codeForStatus` | an error answer: `status`, `code` (`NOT_FOUND`, `PERMISSION_DENIED`, ...), `message`, `fieldErrors`, `traceId`, raw `body` |
| `getAuthenticationMetaData`, `createSession` | pre-sign-in metadata; server sessions (`POST /qqq/v1/manageSession`) |
| `getNativeSignInConfig`, `auth0SignInConfig`, `discoverProvider`, `deviceSignIn`, `createPkce`, `createState`, `authorizationUrl`, `readAuthorizationCallback`, `exchangeAuthorizationCode`, `refreshTokens`, `keepIdToken`, `isExpiring`, `revokeToken`, `endSessionUrl`, `decodeJwtClaims` | OAuth2 / OIDC sign-in for native clients |
| `openRealtimeStream(options)`, `parseEventBlock` | an async iterator over `GET /qqq/v1/realtime/stream` that works with bearer tokens (unlike the browser `EventSource`); the first event is `hello` with the connection id to subscribe with |
| `UI_API_VERSION` | the UI API version the client was generated from |
| `paths`, `components`, `operations` (types) | the generated OpenAPI types, for your own wrappers |
| `@qrun-io/qqq-ui-api-client/openapi/qqq-v1.json` | the merged OpenAPI document itself |
| `@qrun-io/qqq-ui-api-client/openapi/extension-sources.json` | where each merged extension document came from |

Realtime:

```ts
import { openRealtimeStream } from '@qrun-io/qqq-ui-api-client'

for await (const message of openRealtimeStream({ baseUrl, token: () => tokens.accessToken, signal })) {
  console.log(message.event, message.data)
}
```

## Compatibility and versioning

- The package version follows the UI API version of the document it was generated from
  (`UI_API_VERSION`, 1.10.0 for this release). The client works with any server on UI API 1.6.0 up to 2.0:
  operations newer than a server answer 404, and unknown enum values and extra fields are tolerated.
  `GET /qqq/v1/version` tells you the server's version, features and installed extensions.
- A new UI API minor version means a new minor version of this package; a 2.0 UI API would be a new major.
- Errors carry `code`, `fieldErrors` and `traceId` from servers on UI API 1.6.0 and later; for older
  servers `code` is derived from the HTTP status.

## More

- [`@qrun-io/qqq-core`](https://github.com/QRun-IO/qqq-cli/tree/main/packages/core#readme): the client
  kernel built on this package (filter grammar, forms, processes, output formats)
- [`@qrun-io/qqq-ui-api-conformance`](https://github.com/QRun-IO/qqq-cli/tree/main/packages/conformance#readme):
  check a server against the document, and a local OIDC provider to test sign-in
- QQQ's [`UI-API-CLIENTS.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CLIENTS.md) (the
  API and the native-client sign-in contract) and
  [`UI-API-CHANGELOG.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CHANGELOG.md)
- [Repository](https://github.com/QRun-IO/qqq-cli), [CHANGELOG](https://github.com/QRun-IO/qqq-cli/blob/main/CHANGELOG.md),
  [issues](https://github.com/QRun-IO/qqq-cli/issues)

Apache-2.0
