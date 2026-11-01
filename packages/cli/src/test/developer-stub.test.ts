/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Developer tools against a stub (the sample has no application APIs and no script tests): api-call, script test. */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, StubResponse, startStub, type Stub } from './stub.js'

describe('developer tools against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { order: { name: 'order', label: 'Order' } }, processes: { testScript: { name: 'testScript' } }, apps: {} })],
      [/^GET \/table\/order\/apis$/, () => ({ apis: [{ name: 'public', label: 'Public API', path: '/api/', versions: [{ version: '2026.Q1' }] }] })],
      [/^GET \/api\/2026\.Q1\/order\/7$/, (r) => ({ id: 7, auth: String(r.headers.authorization ?? '') })],
      [/^POST \/api\/2026\.Q1\/order\/query$/, (r) => new StubResponse(400, { error: 'bad filter', got: r.json })],
      [/^GET \/table\/order\/7\/developer$/, () => ({ associatedScripts: [{ associatedScript: { fieldName: 'checkScriptId' }, script: { values: { id: 3, name: 'check', currentScriptRevisionId: 30 } }, scriptRevisions: [{ values: { id: 30, sequenceNo: 2, apiName: 'public', apiVersion: '2026.Q1' } }], testInputFields: [{ name: 'orderId', label: 'Order', isRequired: true }], testOutputFields: [{ name: 'ok', label: 'Ok' }] }] })],
      [/^POST \/table\/scriptRevisionFile\/query$/, () => ({ records: [{ values: { fileName: 'main.js', contents: 'return true' } }] })],
      [/^POST \/processes\/testScript\/init$/, (r) => ({ type: 'COMPLETE', processUUID: 't', values: { ok: r.values.orderId === '7' ? 'yes' : 'no', outputObject: { checked: r.values['fileContents:main.js'] }, scriptLogLines: [{ values: { timestamp: '2026-10-31T00:00:00Z', text: 'ran' } }] } })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('api-call sends the request with the session and prints the answer', async () => {
    const r = await qqq(['table', 'api-call', 'order', 'public', '2026.Q1', 'GET', 'order/7', '-O', 'json'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { id: 7, auth: 'Bearer t' })
    assert.match(r.stderr, /GET \/api\/2026\.Q1\/order\/7: HTTP 200/)
    const bad = await qqq(['table', 'api-call', 'order', 'public', '2026.Q1', 'POST', 'order/query', '-b', '{"filter":1}', '-O', 'json'])
    assert.equal(bad.code, 6)
    assert.deepEqual(JSON.parse(bad.stdout), { error: 'bad filter', got: { filter: 1 } })
    const unknown = await qqq(['table', 'api-call', 'order', 'nope', '1', 'GET'])
    assert.match(unknown.stderr, /no application API "nope" \(APIs: public\)/)
  })

  test('script test runs the current revision with the test inputs', async () => {
    const missing = await qqq(['script', 'test', 'order', '7', 'checkScriptId'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /-v orderId=…/)
    const r = await qqq(['script', 'test', 'order', '7', 'checkScriptId', '-v', 'orderId=7', '-O', 'table'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /output +\{"checked":"return true"\}/)
    assert.match(r.stdout, /Ok +yes/)
    assert.match(r.stdout, /log: 2026-10-31T00:00:00Z ran/)
    const init = stub.requests.find((q) => q.path === '/processes/testScript/init')!
    assert.equal(init.values.scriptId, '3')
    assert.equal(init.values.apiName, 'public')
    assert.equal(init.values.fileNames, 'main.js')
  })
})
