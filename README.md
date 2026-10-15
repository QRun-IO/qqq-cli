# qqq-cli

The reference command-line client for [QQQ](https://github.com/QRun-IO/qqq) applications, and the kit for writing your own CLI, TUI or native client. Everything here talks to a QQQ server only through the **UI API** (`/qqq/v1`), the API the web UI uses too.

| Package | What it is |
|---|---|
| [`@qrun-io/qqq-cli`](packages/cli) | `qqq`, the reference CLI: device-code sign-in, apps, tables, filtered queries, records, processes, jobs, and a live event stream |
| [`@qrun-io/qqq-ui-api-client`](packages/ui-api-client) | A typed TypeScript client, generated from the merged UI API document (core plus extensions). It also does OAuth2 device-flow sign-in, token refresh, and reads the realtime (SSE) stream |
| [`@qrun-io/qqq-ui-api-conformance`](packages/conformance) | A black-box conformance suite you can run against any server, plus `qqq-dev-idp`, a local OIDC provider for testing native clients |

The packages are published to GitHub Packages:

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-cli@rc
```

Requires Node.js 20 or later and a QQQ server with UI API 1.6.0 or later (QQQ 4.1.0-RC.14 or later).

## The CLI

```console
$ qqq login --server https://admin.example.com
To sign in to https://admin.example.com, open:

  https://auth.example.com/device?code=ED84-CC03

and confirm the code ED84-CC03 (it expires in 10 minutes).
Waiting for approval...
Signed in to https://admin.example.com as darin@example.com.

$ qqq tables --app peopleApp
name     label     insert  edit  delete
-------  --------  ------  ----  ------
person   Person    yes     yes   yes
pet      Pet       yes     yes   yes

$ qqq query person --where "firstName ~ a" --where "id < 100" --order -id --limit 5
Id  First Name  Last Name  Annual Salary  ...
5   Morgan      Sample     $1,500,000.00
3   Casey       Sample     $300,000.00
(2 records)

$ qqq get person 1
$ qqq run greetInteractive --records 1,2 --value greetingPrefix=Hi
$ qqq jobs --all
$ qqq tail --channel table:person
```

| Command | UI API operations |
|---|---|
| `login` | `getAuthenticationMetaData`, then the provider's device-authorization grant with `values.nativeClientId` |
| `whoami` | `getVersion`, `getMetaData` |
| `apps`, `tables [--app]` | `getMetaData` |
| `query <table> [--where "field OP value"]... [--or] [--order [-]field] [--limit n] [--fields a,b]` | `getTableMetaData`, `queryTable` |
| `get <table> <pk>` | `getTableMetaData`, `getRecord` |
| `run <process> [--value k=v]... [--records ids]` | `getProcessMetaData`, `initProcess`, `stepProcess`, `getProcessStatus` |
| `jobs [--all]` | `listJobs` |
| `tail [--channel ...]` | `openRealtimeStream`, `updateRealtimeSubscriptions` (`user:me`, plus your channels) |

Add `--json` for machine-readable output. Errors print the server's `message`, `code` and `traceId`.

Where things are kept:
- **Tokens** go in `~/.config/qqq-cli/credentials.json` (mode 0600), one entry per server. The CLI refreshes the access token at the provider before it expires, and once more on a 401.
- **`QQQ_TOKEN`** overrides the stored token with any bearer token, such as a QQQ access token exchanged for a JWT, or a session UUID.
- **`QQQ_SERVER`** sets the default server.

Every request carries `X-QQQ-Client: cli/qqq-cli <version>`, so the server's audits attribute it to the CLI.

## Writing a client

```ts
import { createUiApiClient, unwrap, getNativeSignInConfig, deviceSignIn } from '@qrun-io/qqq-ui-api-client'

const config = await getNativeSignInConfig('https://admin.example.com')
const tokens = await deviceSignIn(config, (p) => console.log(`Open ${p.verificationUriComplete}`))
const api = createUiApiClient({ baseUrl: 'https://admin.example.com', token: () => tokens.accessToken, clientChannel: 'tui/my-tui 1.0' })

const page = await unwrap(api.POST('/qqq/v1/table/{tableName}/query', {
  params: { path: { tableName: 'person' } },
  body: { filter: { criteria: [{ fieldName: 'lastName', operator: 'STARTS_WITH', values: ['K'] }], limit: 20 } },
}))
```

Paths, parameters, bodies and responses are typed from the document. Read the QQQ docs before you write a client:
- [`UI-API-CLIENTS.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CLIENTS.md) covers authentication, errors, widgets, processes, capabilities and validation.
- [`UI-API-CHANGELOG.md`](https://github.com/QRun-IO/qqq/blob/develop/docs/UI-API-CHANGELOG.md) covers versioning.

## Mock server

`npm run mock` serves the merged document with [Prism](https://github.com/stoplightio/prism) on http://127.0.0.1:4010, so you can build a client without a server. Responses come from the document's examples and schemas.

## Conformance suite

```sh
qqq-ui-api-conformance --server https://admin.example.com              # public checks only
qqq-ui-api-conformance --server https://admin.example.com --token "$T"  # all read-only checks
```

The suite only reads. It never writes. It checks that:
- the version and the served document agree;
- every operation has a unique operationId and every `$ref` resolves;
- every extension the server lists has operations;
- requests without credentials or with forged tokens (`alg: none`, garbage) get a 401 with the error schema;
- metadata, table metadata (with `clientCapabilities`), query, count, record, jobs and realtime responses validate against the document;
- a 404 has the error schema, and `X-Request-Id` comes back as `traceId`.

## Testing a client locally

`qqq-dev-idp` is a small OIDC provider for **local development only**: device grant, refresh and RS256 JWTs, with one issuer per client, as Authentik does it. Run it with the QQQ sample app:

```sh
npx qqq-dev-idp --port 9400 --client sample-app --client sample-cli --user you@example.com --groups admins --auto-approve

# in a qqq checkout (QQQ 4.1.0-RC.14 or later)
export OAUTH2_BASE_URL=http://localhost:9400/application/o/sample-app/ OAUTH2_CLIENT_ID=sample-app OAUTH2_CLIENT_SECRET=dev \
       OAUTH2_SCOPES="openid profile email offline_access" \
       OAUTH2_NATIVE_CLIENT_ID=sample-cli OAUTH2_NATIVE_CLIENT_BASE_URL=http://localhost:9400/application/o/sample-cli/
./mvnw -f qqq-sample-project/pom.xml compile exec:java -Dexec.mainClass=com.kingsrook.sampleapp.SampleJavalinServer -Dqqq.sample.port=8077

qqq login --server http://localhost:8077
```

## Development

```sh
npm ci
npm run spec:merge -- <core openapi.yaml> <extension yaml>...   # or a server's /qqq/v1/openapi.json
npm run generate        # regenerate packages/ui-api-client/src/schema.ts
npm run build && npm test
```

Releases: push a tag `v<client version>`. The `publish` workflow publishes the three packages to GitHub Packages.

## License

Apache-2.0
