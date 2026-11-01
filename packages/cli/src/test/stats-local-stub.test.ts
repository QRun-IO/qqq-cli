/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** table stats against a stub: without QUERY_STATS (or on a 403/404) the statistics are computed from the matching records. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { TEST_SOURCE, runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, StubResponse, type J, type Stub } from './stub.js'

const GOLDEN = join(TEST_SOURCE, 'golden')

const PEOPLE = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, firstName: i % 3 ? 'Avery' : 'Blair', isEmployed: i % 4 === 0 ? null : i % 2 === 0, age: 20 + i }))
const field = (name: string, label: string, type: string) => ({ name, label, type })
const personMeta = (capabilities: string[]) => ({ name: 'person', label: 'Person', primaryKeyField: 'id', capabilities, insertPermission: true, fields: { id: field('id', 'Id', 'INTEGER'), firstName: field('firstName', 'First Name', 'STRING'), isEmployed: field('isEmployed', 'Is Employed', 'BOOLEAN'), age: field('age', 'Age', 'INTEGER') } })

describe('table stats without server statistics', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let refuse = 0
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  const golden = (name: string, r: { stdout: string; stderr: string; code: number | null }) => {
    const actual = `${r.stdout}--- stderr ---\n${r.stderr}--- exit ${r.code}\n`
    const file = join(GOLDEN, `${name}.txt`)
    if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
      mkdirSync(GOLDEN, { recursive: true })
      writeFileSync(file, actual)
      if (!process.env.UPDATE_GOLDEN) assert.fail(`wrote missing golden ${name}.txt; check it and run again`)
      return
    }
    assert.equal(actual, readFileSync(file, 'utf8'), `golden ${name}.txt (UPDATE_GOLDEN=1 rewrites it)`)
  }
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { person: { name: 'person', label: 'Person' }, acct: { name: 'acct', label: 'Acct' } }, processes: { columnStats: { name: 'columnStats' } }, apps: {} })],
      [/^GET \/metaData\/table\/person$/, () => personMeta(['TABLE_QUERY'])],
      [/^GET \/metaData\/table\/acct$/, () => ({ ...personMeta(['TABLE_QUERY', 'QUERY_STATS']), name: 'acct', label: 'Acct' })],
      [/^POST \/table\/(person|acct)\/query$/, (r) => {
        const { skip = 0, limit = 50 } = (r.json as { filter: { skip?: number; limit?: number } }).filter
        return { records: PEOPLE.slice(skip, skip + limit).map((p) => ({ values: p as J })) }
      }],
      [/^POST \/processes\/columnStats\/init$/, () => (refuse ? new StubResponse(refuse, { code: 'X', message: 'no' }) : { type: 'COMPLETE', values: { statsFields: [{ name: 'count', label: 'Count' }], statsRecord: { values: { count: 7 } }, valueCounts: [] } })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('a table without QUERY_STATS computes the statistics from its records (golden)', async () => {
    const r = await qqq(['-O', 'table', 'table', 'stats', 'person', 'isEmployed'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /^from 21 matching records \(the server offers no column statistics for Person\)/)
    golden('stats-local-fallback', r)
    assert.ok(!stub.requests.some((q) => q.path === '/processes/columnStats/init'))
  })

  test('numbers get sum, mean and median; --json carries the kernel statistics', async () => {
    const r = await qqq(['table', 'stats', 'person', 'age', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout) as { source: string; loaded: { sum: number; mean: number; median: number; nulls: number } }
    assert.equal(out.source, 'matching records')
    assert.deepEqual([out.loaded.sum, out.loaded.mean, out.loaded.median, out.loaded.nulls], [630, 30, 30, 0])
  })

  test('--no-local keeps the old error; --max-records caps the read', async () => {
    const no = await qqq(['table', 'stats', 'person', 'age', '--no-local'])
    assert.equal(no.code, 2)
    assert.match(no.stderr, /No column statistics: Person does not offer column statistics \(no QUERY_STATS capability\)/)
    const capped = await qqq(['table', 'stats', 'person', 'age', '--max-records', '5', '--json'])
    assert.match(capped.stderr, /from 5 matching records .* stopped at --max-records 5/)
    assert.equal((JSON.parse(capped.stdout) as { loaded: { count: number } }).loaded.count, 5)
  })

  test('a table with QUERY_STATS uses the server; a 404 from it falls back; --local forces local', async () => {
    const server = await qqq(['table', 'stats', 'acct', 'age', '--json'])
    assert.equal(server.code, 0, server.stderr)
    assert.equal((JSON.parse(server.stdout) as { stats: { values: { count: number } } }).stats.values.count, 7)
    refuse = 404
    const fallback = await qqq(['table', 'stats', 'acct', 'age', '--json'])
    assert.equal(fallback.code, 0, fallback.stderr)
    assert.match(fallback.stderr, /from 21 matching records/)
    const strict = await qqq(['table', 'stats', 'acct', 'age', '--no-local'])
    assert.notEqual(strict.code, 0)
    refuse = 0
    const before = stub.requests.length
    const forced = await qqq(['table', 'stats', 'acct', 'age', '--local', '--json'])
    assert.equal(forced.code, 0, forced.stderr)
    assert.ok(!stub.requests.slice(before).some((q) => q.path === '/processes/columnStats/init'))
  })
})
