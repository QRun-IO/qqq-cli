/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Security rows the sample cannot exercise, against a stub: TABLE_BASED sign-in (username and
 * password over HTTP Basic, the sessionId cookie, refusal, expiry, logout) and DISABLED tables
 * and processes (listed with the reason, refused before any request).
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, StubResponse, startStub, type Stub } from './stub.js'

describe('TABLE_BASED sign-in and DISABLED objects against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let sessions = new Set<string>()
  const qqq = (args: string[], env: Record<string, string> = {}) => runCli(['--server', stub.url, ...args], { ...box.env, ...env })
  const authorized = (cookie: string | undefined) => [...sessions].some((s) => (cookie ?? '').includes(`sessionId=${s}`))
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData\/authentication$/, () => ({ type: 'TABLE_BASED', name: 'tableBased', values: {} })],
      [/^GET \/metaData$/, (r) => {
        const basic = String(r.headers.authorization ?? '')
        if (basic.startsWith('Basic ')) {
          const [user, password] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')
          if (user !== 'ann' || password !== 's3cret') return new StubResponse(401, { code: 'UNAUTHENTICATED', message: 'Incorrect username or password.' })
          const id = `sess-${sessions.size + 1}`
          sessions.add(id)
          return new StubResponse(200, { tables: {} }, { 'set-cookie': `sessionId=${id}; Path=/; HttpOnly` })
        }
        if (!authorized(r.headers.cookie as string | undefined)) return new StubResponse(401, { code: 'UNAUTHENTICATED', message: 'Session not found.' })
        return {
          tables: { order: { name: 'order', label: 'Order', readPermission: true, insertPermission: false, editPermission: true, deletePermission: true }, ledger: { name: 'ledger', label: 'Ledger', readPermission: false, insertPermission: false, editPermission: false, deletePermission: false } },
          processes: { closeBooks: { name: 'closeBooks', label: 'Close Books', hasPermission: false } }, apps: {},
        }
      }],
      [/^GET \/metaData\/table\/order$/, () => ({ name: 'order', label: 'Order', primaryKeyField: 'id', readPermission: true, insertPermission: false, editPermission: true, deletePermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, name: { name: 'name', label: 'Name', type: 'STRING' } } })],
      [/^GET \/metaData\/table\/ledger$/, () => ({ name: 'ledger', label: 'Ledger', primaryKeyField: 'id', readPermission: false, insertPermission: false, editPermission: false, deletePermission: false, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' } } })],
      [/^GET \/metaData\/process\/closeBooks$/, () => ({ name: 'closeBooks', label: 'Close Books', hasPermission: false, frontendSteps: [] })],
      [/^POST \/table\/order\/count$/, (r) => (authorized(r.headers.cookie as string | undefined) ? { count: 2 } : new StubResponse(401, { code: 'UNAUTHENTICATED', message: 'Session expired.' }))],
      [/^POST \/logout$/, (r) => { for (const s of [...sessions]) if (String(r.headers.cookie ?? '').includes(`sessionId=${s}`)) sessions.delete(s); return {} }],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('a wrong password is refused with one message and nothing is stored', async () => {
    const r = await qqq(['login', '--username', 'ann'], { QQQ_PASSWORD: 'nope' })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /Incorrect username or password\./)
    const after = await qqq(['table', 'count', 'order'])
    assert.equal(after.code, 3)
  })

  test('sign in with username and password; the sessionId cookie is sent, the password is not kept', async () => {
    const r = await qqq(['login', '--username', 'ann'], { QQQ_PASSWORD: 's3cret' })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /Signed in .* as ann \(table-based authentication\)/)
    const count = await qqq(['table', 'count', 'order', '-O', 'json'])
    assert.equal(count.code, 0, count.stderr)
    const sent = stub.requests.filter((q) => q.path === '/table/order/count').at(-1)!
    assert.match(String(sent.headers.cookie), /sessionId=sess-1/)
    assert.equal(sent.headers.authorization, undefined)
    assert.ok(!stub.requests.some((q) => q.path !== '/metaData' && String(q.headers.authorization ?? '').startsWith('Basic')))
  })

  test('DISABLED objects are listed with the reason and refused before any request', async () => {
    const list = await qqq(['table', 'list', '-O', 'csv'])
    assert.match(list.stdout, /ledger,Ledger,,,,You do not have permission to view Ledger\./)
    const before = stub.requests.length
    const read = await qqq(['table', 'query', 'ledger'])
    assert.equal(read.code, 3)
    assert.match(read.stderr, /You do not have permission to view Ledger\./)
    const copy = await qqq(['table', 'copy', 'order', '1'])
    assert.equal(copy.code, 3)
    assert.match(copy.stderr, /permission to create records in Order/)
    const procs = await qqq(['process', 'list', '--all', '-O', 'csv'])
    assert.match(procs.stdout, /closeBooks,Close Books,,,You do not have permission to run Close Books\./)
    const run = await qqq(['process', 'run', 'closeBooks'])
    assert.equal(run.code, 3)
    assert.match(run.stderr, /permission to run Close Books/)
    assert.ok(!stub.requests.slice(before).some((q) => /\/table\/ledger\/query|\/processes\/closeBooks\/init|\/table\/order\/1/.test(q.path)))
  })

  test('an expired session asks to sign in again; logout ends the session and forgets it', async () => {
    sessions = new Set()
    const expired = await qqq(['table', 'count', 'order'])
    assert.equal(expired.code, 3)
    assert.match(expired.stderr, /Sign in again with `qqq login`/)
    await qqq(['login', '--username', 'ann'], { QQQ_PASSWORD: 's3cret' })
    const out = await qqq(['logout'])
    assert.equal(out.code, 0, out.stderr)
    assert.ok(stub.requests.some((q) => q.path === '/logout' && /sessionId=/.test(String(q.headers.cookie))))
    assert.equal(sessions.size, 0)
    const after = await qqq(['table', 'count', 'order'])
    assert.equal(after.code, 3)
  })
})
