/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUrl, callOperation } from '../api/call.js'
import { OPERATIONS, operation } from '../api/operations.js'

test('the operations index knows every core operation', () => {
  assert.ok(OPERATIONS.length >= 60)
  const q = operation('queryTable')!
  assert.deepEqual([q.method, q.path, q.pathParams, q.bodyTypes], ['POST', '/qqq/v1/table/{tableName}/query', ['tableName'], ['application/json']])
})

test('buildUrl fills path parameters and the query string, and rejects unknown ones', () => {
  const op = operation('getRecord')!
  assert.equal(buildUrl('http://h/', op, { path: { tableName: 'person', primaryKey: 'a b' }, query: { includeAssociations: 'true' } }), 'http://h/qqq/v1/table/person/a%20b?includeAssociations=true')
  assert.throws(() => buildUrl('http://h', op, { path: { tableName: 'person' } }), /needs path parameter "primaryKey"/)
  assert.throws(() => buildUrl('http://h', op, { path: { tableName: 'p', primaryKey: '1', nope: 'x' } }), /no path parameter nope/)
})

test('callOperation sends JSON bodies and throws UiApiError on failures', async () => {
  const seen: Request[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    seen.push(request)
    if (request.url.endsWith('/count')) return new Response(JSON.stringify({ count: 3 }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  const result = await callOperation('http://h', 'countTable', { path: { tableName: 'person' }, json: { filter: { criteria: [] } } }, fetchImpl)
  assert.deepEqual(result.data, { count: 3 })
  assert.equal(seen[0]!.method, 'POST')
  assert.equal(seen[0]!.headers.get('content-type'), 'application/json')
  await assert.rejects(callOperation('http://h', 'getRecord', { path: { tableName: 'person', primaryKey: '9' } }, fetchImpl), (e: Error & { code?: string }) => e.code === 'NOT_FOUND')
  assert.throws(() => buildUrl('http://h', operation('bogus') as never, {}), TypeError)
})
