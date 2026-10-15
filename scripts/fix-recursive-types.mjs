#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

// openapi-typescript emits a directly self-recursive union (e.g. SqlWorkbenchValueV1, whose arrays
// hold more values) as a one-line member that TypeScript rejects (TS2502). Replace the self
// reference on such a line with `unknown`, keeping the rest of the type.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
const lines = readFileSync(file, 'utf8').split('\n')
let fixed = 0
for (let i = 0; i < lines.length; i++) {
  const match = /^(\s+)([A-Za-z0-9_]+): (.*);$/.exec(lines[i])
  if (!match) continue
  const self = `components["schemas"]["${match[2]}"]`
  if (match[3].includes(self)) {
    lines[i] = `${match[1]}${match[2]}: ${match[3].split(self).join('unknown')};`
    fixed++
  }
}
writeFileSync(file, lines.join('\n'))
console.log(`fixed ${fixed} self-recursive type(s) in ${file}`)
