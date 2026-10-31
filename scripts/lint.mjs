/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Repository lint: every TypeScript and script source carries the license header, and no file under
 * packages/* /src imports from another package's src (only from its built entry point).
 *
 * Usage: node scripts/lint.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HEADER = 'Copyright 2026 QRun.IO, Inc.'
const roots = ['packages/ui-api-client/src', 'packages/core/src', 'packages/conformance/src', 'packages/cli/src', 'scripts']
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

for (const root of roots) walk(root)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('lint: ok')
