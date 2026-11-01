/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Repository lint: every TypeScript and script source carries the license header, no file under
 * packages/* /src imports from another package's src (only from its built entry point), and the
 * release versions agree: the CLI's compiled-in version with its package.json, the client's
 * UI_API_VERSION with its OpenAPI document, and every workspace dependency with the version of the
 * workspace it names.
 *
 * Usage: node scripts/lint.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HEADER = 'Copyright 2026 QRun.IO, Inc.'
const roots = ['packages/ui-api-client/src', 'packages/core/src', 'packages/conformance/src', 'packages/cli/src', 'packages/tui/src', 'packages/tui/test', 'packages/tui/scripts', 'scripts']
const problems = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'dist') continue
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith('.d.ts') && name !== 'schema.ts' && name !== 'operations.ts') check(path)
  }
}

function check(path) {
  const text = readFileSync(path, 'utf8')
  if (!text.slice(0, 400).includes(HEADER)) problems.push(`${relative('.', path)}: missing license header`)
  const cross = text.match(/from '(\.\.\/)+(ui-api-client|core|conformance|cli)\/src\//)
  if (cross) problems.push(`${relative('.', path)}: imports another package's src (${cross[0]}); import the package by name`)
}

function checkVersions() {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const workspaces = Object.fromEntries(read('package.json').workspaces.map((dir) => {
    const pkg = read(join(dir, 'package.json'))
    return [pkg.name, { dir, pkg }]
  }))
  const cli = workspaces['@qrun-io/qqq-cli'].pkg
  const cliConstant = readFileSync('packages/cli/src/version.ts', 'utf8').match(/export const CLI_VERSION = '([^']+)'/)?.[1]
  if (cliConstant !== cli.version) problems.push(`packages/cli/src/version.ts: CLI_VERSION ${cliConstant} != packages/cli/package.json ${cli.version}`)
  const uiApiConstant = readFileSync('packages/ui-api-client/src/index.ts', 'utf8').match(/export const UI_API_VERSION = '([^']+)'/)?.[1]
  const documentVersion = read('packages/ui-api-client/openapi/qqq-v1.json').info?.version
  if (uiApiConstant !== documentVersion) problems.push(`packages/ui-api-client/src/index.ts: UI_API_VERSION ${uiApiConstant} != document info.version ${documentVersion}`)
  for (const { dir, pkg } of Object.values(workspaces)) {
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const target = workspaces[name]
      if (target && range !== target.pkg.version) problems.push(`${dir}/package.json: depends on ${name} ${range}, the workspace is ${target.pkg.version}`)
    }
  }
}

for (const root of roots) walk(root)
checkVersions()
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('lint: ok')
