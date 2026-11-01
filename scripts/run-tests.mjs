#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Runs a package's built tests: `node --test` on every `*.test.js` directly in `dist/test` (or the
 * directory given), from the package directory npm runs scripts in. A shell glob such as
 * `node --test dist/test/*.test.js` is not expanded by cmd.exe on Windows, and Node 20 does not glob
 * its own arguments; `node --test` without arguments would also run helpers such as `test/harness.js`
 * (Node 20's default patterns include every file under a `test` directory). So the list is made here.
 *
 * Usage: node ../../scripts/run-tests.mjs [dir]   (extra node --test options may follow the dir)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [dirArg = 'dist/test', ...options] = process.argv.slice(2)
const dir = resolve(dirArg)
if (!existsSync(dir)) {
  console.error(`run-tests: ${dir} does not exist; run npm run build first`)
  process.exit(1)
}
const files = readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort().map((name) => join(dir, name))
if (!files.length) {
  console.error(`run-tests: no *.test.js in ${dir}`)
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...options, ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
