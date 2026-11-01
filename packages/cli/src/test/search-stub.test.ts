/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type J, type Stub } from './stub.js'

describe('qqq search against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^POST \/search$/, () => ({
        results: [
          { recordId: '1', tableName: 'customer', tableLabel: 'Customer', recordLabel: 'Ada Lovelace', highlights: [{ text: 'ada@example.test', fieldName: 'email', fieldLabel: 'Email' }] },
          { recordId: '9', tableName: 'order', tableLabel: 'Order', recordLabel: '9', highlights: [{ text: 'for Ada', fieldName: 'notes', fieldLabel: 'Notes' }] },
        ],
        tables: [{ tableName: 'customer', tableLabel: 'Customer', totalCount: 1 }, { tableName: 'order', tableLabel: 'Order', totalCount: 4, hasMore: true }],
        provider: { status: 'OK' },
      })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('table output has the matched field; --table repeats and comma-separates; --limit is per table; --json is the response', async () => {
    const r = await qqq(['-O', 'table', 'search', 'ada', '-t', 'customer', '-t', 'order,tag', '-l', '5'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /customer\s+1\s+Ada Lovelace\s+Email: ada@example.test/)
    assert.match(r.stdout, /order\s+9\s+for Ada\s+Notes: for Ada/)
    assert.match(r.stdout, /\(2 results; 2 tables; 5 matches in all, --limit shows more per table\)/)
    const body = stub.requests.at(-1)!.json as J
    assert.deepEqual(body, { searchTerm: 'ada', tableNames: ['customer', 'order', 'tag'], limitPerTable: 5 })
    const j = await qqq(['search', 'ada', '--json'])
    assert.equal((JSON.parse(j.stdout) as { results: unknown[] }).results.length, 2)
    const f = await qqq(['-O', 'table', 'search', 'name:ada'])
    assert.match(f.stdout, /name:ada is not a field search: searched for ada/)
    assert.equal((stub.requests.at(-1)!.json as J).searchTerm, 'ada')
  })
})
