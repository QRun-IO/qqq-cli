# @qrun-io/qqq-ui-api-conformance

A black-box, read-only conformance suite for servers of the [QQQ](https://github.com/QRun-IO/qqq) UI API
(`/qqq/v1`), and `qqq-dev-idp`, a local OpenID Connect provider for testing native-client sign-in
without an identity-provider account.

## Install

Published to GitHub Packages (a GitHub token with `read:packages` is needed even for public packages):

```sh
echo "@qrun-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install -g @qrun-io/qqq-ui-api-conformance      # or npx, or as a dev dependency
```

Node.js 20 or later. Two commands: `qqq-ui-api-conformance` and `qqq-dev-idp`.

## Check a server

```sh
qqq-ui-api-conformance --server http://localhost:8077                       # public checks; MOCK servers run all
qqq-ui-api-conformance --server http://localhost:8077 --token "$QQQ_TOKEN"  # all read-only checks
qqq-ui-api-conformance --server http://localhost:8077 --table person --json # a chosen table, JSON report
qqq-ui-api-conformance --server http://127.0.0.1:4010                       # the Prism mock (npm run mock)
```

`--server` defaults to `QQQ_SERVER` and `--token` (an OAuth2 access token or a session UUID) to
`QQQ_TOKEN`. Every authenticated check authenticates the same way, as the CLI does: a JWT as a bearer token,
a session UUID also as the `sessionUUID` cookie, and on MOCK and FULLY_ANONYMOUS servers without a token a
server session from `manageSession`. The exit code is 1 when any check fails, 2 on a usage error. Against the QQQ sample server:

```text
PASS  GET /qqq/v1/metaData/authentication validates  (type MOCK)
SKIP  a request without credentials answers 401 with the error schema  (authentication type MOCK)
PASS  POST /qqq/v1/table/{tableName}/query validates  (2 records)
PASS  X-Request-Id is echoed as the error traceId (UI API >= 1.6.0)
SKIP  GET /qqq/v1/jobs validates  (jobs are not enabled on this server (no durable jobs tables))
PASS  GET /qqq/v1/realtime/stream opens with a hello event
...
14 passed, 3 skipped, 0 failed
```

What it checks, without writing anything:

- `GET /qqq/v1/version` answers a 1.x semantic version; the served `openapi.json` is the merged document,
  every operation has a unique `operationId` (1.6.0+), every `$ref` resolves, and every extension in
  `/version` has operations in the document.
- Authentication metadata validates; requests without credentials and with a forged bearer token answer
  401 with the error schema (skipped on MOCK and anonymous servers).
- With credentials: `GET /metaData`, a table's metadata (with `clientCapabilities` and field validation,
  1.6.0+), query, count and get of a record validate against the document's schemas; an unknown table
  answers 404 with the error schema; `X-Request-Id` comes back as the error `traceId` (1.6.0+);
  `GET /jobs` validates when the server has durable jobs; the realtime stream opens with `hello`.

Responses are validated with [Ajv](https://ajv.js.org) against the schemas of the document the server
serves. Checks that do not apply (an older server, a missing feature) are reported as SKIP with the
reason, not as failures.

## Use it from code

```js
import { runConformance } from '@qrun-io/qqq-ui-api-conformance'

const results = await runConformance({ baseUrl: 'http://localhost:8077', table: 'person' })
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} ok, ${failed.length} failed`)
```

`runConformance(options)` resolves with `{ name, ok, skipped?, detail? }` per check. Options: `baseUrl`,
`token`, `table`, `fetch`, `log` (called with each result as it completes). `SchemaValidator` is
exported for validating payloads against the document yourself.

## `qqq-dev-idp`: a local OIDC provider

For **local development and tests only**: it approves sign-ins for one configured user without a
password. Never expose it.

```sh
qqq-dev-idp --port 9400 --client sample-app --client sample-cli --user dev@example.com --groups admins
qqq-dev-idp --auto-approve            # approve device codes and authorization requests at once (CI)
```

Each client gets its own issuer, `http://localhost:9400/application/o/<client>/`, with OIDC discovery and
JWKS (RS256 JWTs). It supports the device-authorization grant (approve a code at
`GET /device?code=...`), the authorization code with S256 PKCE on loopback redirects (127.0.0.1 or
localhost, any port) with an Approve / Deny page, refresh tokens, revocation and end-session. Options:
`--port` (9400), `--client` (repeatable; default `sample-app` and `sample-cli`), `--user`, `--name`,
`--groups` (comma-separated), `--token-seconds` (600), `--auto-approve`.

Point a local QQQ server's OAUTH2 authentication at that issuer, and `qqq login` (or any client using
`@qrun-io/qqq-ui-api-client`'s `deviceSignIn`) runs the whole native-client flow.
[TRY-IT.md](https://github.com/QRun-IO/qqq-cli/blob/main/TRY-IT.md) has the recipe for the sample server.
In tests, `startDevIdp(options)` from `@qrun-io/qqq-ui-api-conformance/dist/dev-idp.js` starts it
in-process and returns `{ issuer(clientId), approve(userCode), close() }`.

## Versioning

The suite has its own version (1.6.0 for this release, the UI API version whose rules it checks). It
accepts servers on UI API 1.x and gates newer checks on the server's version. Released together with the
`qqq` CLI from the [qqq-cli repository](https://github.com/QRun-IO/qqq-cli);
[CHANGELOG](https://github.com/QRun-IO/qqq-cli/blob/main/CHANGELOG.md),
[issues](https://github.com/QRun-IO/qqq-cli/issues).

Apache-2.0
