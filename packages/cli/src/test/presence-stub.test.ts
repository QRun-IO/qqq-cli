/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq collab presence` against a stub: the connections column for two terminals of one user
 * (collaboration 1.2.0), `--per-connection` rows, and a 1.1.0 server that sends no connections.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { startStub, type Stub } from './stub.js'

describe('qqq collab presence against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let version = '1.2.0'
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  const admin = { userId: 'admin', displayName: 'Admin', mode: 'VIEWING' }
  before(async () => {
    box = sandbox()
    stub = await startStub([
      [/^GET \/version$/, () => ({ apiVersion: '1.8.0', supportedMajorVersions: [1], features: [], extensions: [{ name: 'collaboration', version }] })],
      [/^GET \/qbit\/collaboration\/presence$/, (r) => {
        if (version === '1.1.0') return { table: 'person', viewers: [admin, { userId: 'bob', displayName: 'Bob', mode: 'EDITING' }] }
        const leases = [
          { ...admin, connections: 1, connectionId: 'c0000000000000001', sessionId: 's1', since: '2026-11-01T12:00:00Z' },
          { ...admin, mode: 'EDITING', fieldName: 'name', connections: 1, connectionId: 'c0000000000000002', sessionId: 's2', since: '2026-11-01T12:00:05Z' },
        ]
        return { table: 'person', viewers: [{ ...admin, mode: 'EDITING', connections: 2 }], leaseCount: 2, ...(r.query.get('perConnection') === 'true' ? { leases } : {}) }
      }],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('two terminals of one user: one person with 2 connections', async () => {
    version = '1.2.0'
    const r = await qqq(['collab', 'presence', 'person', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^name,user,mode,field,connections\r?\nAdmin,admin,EDITING,,2/m)
    const json = JSON.parse((await qqq(['collab', 'presence', 'person', '-O', 'json'])).stdout)
    assert.deepEqual([json.count, json.connections, json.viewers[0].connections], [1, 2, 2])
    assert.equal(stub.requests.filter((q) => q.path === '/qbit/collaboration/presence').at(-1)!.query.get('perConnection'), null)
  })

  test('--per-connection lists each terminal with its mode, field and start', async () => {
    version = '1.2.0'
    const r = await qqq(['collab', 'presence', 'person', '--per-connection', '-O', 'json'])
    assert.equal(r.code, 0, r.stderr)
    const json = JSON.parse(r.stdout)
    assert.deepEqual(json.leases.map((l: { mode: string; field: string; connection: string }) => [l.mode, l.field, l.connection]), [['VIEWING', '', 'c0000000000000001'], ['EDITING', 'name', 'c0000000000000002']])
    assert.equal(stub.requests.at(-1)!.query.get('perConnection'), 'true')
  })

  test('a collaboration 1.1.0 server without connections: each person counts once', async () => {
    version = '1.1.0'
    const r = await qqq(['collab', 'presence', 'person', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Admin,admin,VIEWING,,1\r?\nBob,bob,EDITING,,1/)
    const per = JSON.parse((await qqq(['collab', 'presence', 'person', '--per-connection', '-O', 'json'])).stdout)
    assert.deepEqual([per.count, per.connections, per.leases.length], [2, 2, 2])
  })
})
