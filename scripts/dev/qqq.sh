#!/usr/bin/env bash
# Run the qqq CLI from this checkout (source, via Bun), so every commit is the latest without a build.
#   qqq <command> ...       e.g. qqq login --server http://localhost:8077 ; qqq whoami ; qqq query person
set -euo pipefail
self="${BASH_SOURCE[0]}"; while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
here="$(cd "$(dirname "$self")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"
[[ -d node_modules ]] || npm install --silent
# the CLI imports the client package by name, which resolves to its built dist
if [[ ! -f packages/ui-api-client/dist/index.js || packages/ui-api-client/src/index.ts -nt packages/ui-api-client/dist/index.js || packages/ui-api-client/src/client.ts -nt packages/ui-api-client/dist/index.js || packages/ui-api-client/src/auth.ts -nt packages/ui-api-client/dist/index.js ]]; then
   npm run build -w @qrun-io/qqq-ui-api-client --silent >&2
fi
exec bun run packages/cli/src/main.ts "$@"
