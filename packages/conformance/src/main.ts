#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq-ui-api-conformance --server https://app.example.com [--token <bearer>] [--table person] [--json]
 *
 * Runs the black-box UI API conformance suite against a server (or the Prism mock). Exit code 1
 * when any check fails.
 */

import { runConformance } from './conformance.js'

const args = process.argv.slice(2)
const value = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const server = value('--server') ?? process.env.QQQ_SERVER
if (!server) {
  console.error('usage: qqq-ui-api-conformance --server <url> [--token <bearer>] [--table <name>] [--json]')
  process.exit(2)
}

const asJson = args.includes('--json')
const results = await runConformance({
  baseUrl: server,
  token: value('--token') ?? process.env.QQQ_TOKEN,
  table: value('--table'),
  log: asJson ? undefined : (r) => console.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`),
})
const failed = results.filter((r) => !r.ok)
if (asJson) console.log(JSON.stringify({ server, passed: results.filter((r) => r.ok && !r.skipped).length, skipped: results.filter((r) => r.skipped).length, failed: failed.length, results }, null, 2))
else console.log(`\n${results.filter((r) => r.ok && !r.skipped).length} passed, ${results.filter((r) => r.skipped).length} skipped, ${failed.length} failed`)
process.exitCode = failed.length ? 1 : 0
