# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x (`qqq` 1.1, `@qrun-io/qqq-core` 1.1, `@qrun-io/qqq-ui-api-client` 1.10, `@qrun-io/qqq-ui-api-conformance` 1.6) | yes |
| 1.0.x, 1.0.0 release candidates, 0.x | no; upgrade to the latest 1.1.x |

Fixes are released as a new patch version of the affected packages and binaries.

## Reporting a vulnerability

**Do not report security problems in public issues, pull requests or discussions.**

Email **security@qrun.io** with:

- what is affected (the CLI, `qqq ui`, a package, the installer or the packaging) and its version
  (the first line of `qqq doctor`);
- how to reproduce it, and what an attacker gains;
- whether the problem is in this client or in the QQQ server (server problems are handled through
  [QRun-IO/qqq](https://github.com/QRun-IO/qqq/security)).

When private vulnerability reporting is enabled on this repository, you can also use
[Report a vulnerability](https://github.com/QRun-IO/qqq-cli/security/advisories/new).

We acknowledge reports within three business days, keep you informed while we fix it, and credit you in
the advisory unless you ask us not to.

## Scope notes

Things in scope include: how sign-ins and tokens are stored (OS keyring, the `QQQ_KEYRING=file` store),
OAuth2 device and PKCE flows, handling of server-supplied file names and content, the curl installer and
its checksum verification, and the release binaries.

`qqq-dev-idp` (in `@qrun-io/qqq-ui-api-conformance`) approves sign-ins without a password by design. It
is for local development and tests only; running it where others can reach it is not a vulnerability in
this project.

## Dependencies

Dependabot watches the npm workspaces and the TUI's Bun lockfile ([.github/dependabot.yml](.github/dependabot.yml)).
Never commit secrets: use `QQQ_TOKEN` or the keyring, and keep tokens and private hostnames out of
issues and logs you share.
