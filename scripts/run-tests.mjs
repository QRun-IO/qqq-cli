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
 * Every test gets a deadline (`--test-timeout`, 2 minutes unless the caller passes one) and the whole run
 * is killed after 8 minutes, so a hang on one platform fails a test (or the step) with a message
 * instead of leaving CI silent until its no-output limit kills the job.
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
const timeoutOption = options.some((option) => option.startsWith('--test-timeout')) ? [] : ['--test-timeout=120000']
const RUN_LIMIT_MS = 8 * 60 * 1000
const result = spawnSync(process.execPath, ['--test', ...timeoutOption, ...options, ...files], { stdio: 'inherit', timeout: RUN_LIMIT_MS, killSignal: 'SIGKILL' })
if (result.error) {
  if ('code' in result.error && result.error.code === 'ETIMEDOUT') {
    console.error(`run-tests: killed after ${RUN_LIMIT_MS / 1000}s; a test file kept the process alive (an unclosed server, stream or timer)`)
    process.exit(1)
  }
  throw result.error
}
process.exit(result.status ?? 1)
