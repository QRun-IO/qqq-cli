/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResultCursor } from '../records/result-cursor.js'

function fakeServer(total: number) {
  const calls: Array<{ path: string; body: { filter: { skip?: number; limit?: number; orderBys?: unknown } } }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const body = await request.json() as { filter: { skip?: number; limit?: number } }
    const path = new URL(request.url).pathname
    calls.push({ path, body: body as never })
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/count')) return json({ count: total })
    const skip = body.filter.skip ?? 0
    const ids = Array.from({ length: Math.max(0, Math.min(body.filter.limit ?? 10, total - skip)) }, (_, i) => skip + i + 1)
    return json({ records: ids.map((id) => ({ values: { id }, recordLabel: `R${id}` })) })
  }
  return { calls, fetchImpl }
}

test('the cursor steps across pages and stops at the ends', async () => {
  const { calls, fetchImpl } = fakeServer(7)
  const cursor = new ResultCursor({ baseUrl: 'http://h', fetch: fetchImpl, table: 't', filter: { criteria: [], booleanOperator: 'AND' }, pageSize: 3, index: 2 })
  assert.equal((await cursor.current())!.recordLabel, 'R3')
  assert.equal(cursor.describe(), 'record 3 of 7')
  assert.equal((await cursor.next())!.recordLabel, 'R4')
  assert.equal(calls.filter((c) => c.path.endsWith('/query')).at(-1)!.body.filter.skip, 3)
  assert.deepEqual(calls[0]!.body.filter.orderBys, [{ fieldName: 'id', isAscending: true }])
  cursor.index = 6
  assert.equal(await cursor.next(), undefined)
  assert.equal(cursor.index, 6)
  cursor.index = 0
  assert.equal(await cursor.previous(), undefined)
  assert.equal(cursor.indexOfKey(4), 3)
})

test('after a delete the cursor shows the next record and reloads pages', async () => {
  const { calls, fetchImpl } = fakeServer(5)
  const cursor = new ResultCursor({ baseUrl: 'http://h', fetch: fetchImpl, table: 't', filter: { criteria: [], booleanOperator: 'AND' }, pageSize: 2, index: 4 })
  cursor.seed(2, [{ values: { id: 5 } }], 5)
  assert.equal(cursor.keyOf(await cursor.current()), 5)
  assert.equal(calls.length, 0, 'a seeded page needs no request')
  cursor.removed(4)
  assert.equal(cursor.total, 4)
  assert.equal(cursor.index, 3)
})

test('joins go with query and count; a many-side join asks for the distinct count', async () => {
  const seen: Array<{ path: string; query: string; body: { joins?: unknown } }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    seen.push({ path: url.pathname, query: url.search, body: await request.json() as { joins?: unknown } })
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
    return url.pathname.endsWith('/count') ? json({ count: 21, distinctCount: 16 }) : json({ records: [] })
  }
  const cursor = new ResultCursor({ baseUrl: 'http://h', fetch: fetchImpl, table: 'person', filter: { criteria: [], booleanOperator: 'AND' }, pageSize: 10, joins: [{ joinTable: 'pet', select: true, type: 'LEFT' }], includeDistinct: true })
  await cursor.page(0)
  assert.equal(cursor.total, 21)
  assert.equal(cursor.distinct, 16)
  assert.ok(seen.every((s) => JSON.stringify(s.body.joins) === '[{"joinTable":"pet","select":true,"type":"LEFT"}]'))
  assert.equal(seen.find((s) => s.path.endsWith('/count'))!.query, '?includeDistinct=true')
})
