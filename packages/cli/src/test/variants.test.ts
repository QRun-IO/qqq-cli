/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Table variants against a stub (the sample has no variant table): asked, sent, remembered, forgotten. */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type Stub } from './stub.js'

describe('table variants', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { order: { name: 'order', label: 'Order' } }, processes: {}, apps: {} })],
      [/^GET \/metaData\/table\/order$/, () => ({ name: 'order', label: 'Order', primaryKeyField: 'id', usesVariants: true, variantTableLabel: 'Store', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' } } })],
      [/^GET \/table\/order\/variants$/, () => ({ variants: [{ id: '1', type: 'store', name: 'North' }, { id: '2', type: 'store', name: 'South' }] })],
      [/^POST \/table\/order\/query$/, () => ({ records: [{ values: { id: 9 } }] })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('without a variant and without a terminal nothing is queried', async () => {
    const r = await qqq(['table', 'query', 'order'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Order needs a Store: --variant <id\|name> \(North \(1\), South \(2\)\)/)
    assert.ok(!stub.requests.some((q) => q.path === '/table/order/query'))
  })

  test('a chosen variant is sent, then remembered for the table; --variant - forgets it', async () => {
    const first = await qqq(['table', 'query', 'order', '--variant', 'South', '-O', 'json'])
    assert.equal(first.code, 0, first.stderr)
    assert.deepEqual((stub.requests.at(-1)!.json as { tableVariant: unknown }).tableVariant, { type: 'store', id: '2' })
    const again = await qqq(['table', 'query', 'order', '-O', 'json'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stderr, /Store: South \(chosen before; --variant to change, --variant - to forget\)/)
    assert.deepEqual((stub.requests.at(-1)!.json as { tableVariant: unknown }).tableVariant, { type: 'store', id: '2' })
    const forgot = await qqq(['table', 'query', 'order', '--variant', '-'])
    assert.equal(forgot.code, 2)
  })
})
