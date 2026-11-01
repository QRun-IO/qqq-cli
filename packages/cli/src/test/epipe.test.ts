/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** A reader that leaves early (`qqq table query person | head -1`) is not an error: quiet exit 0. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { exitOnBrokenPipe, isBrokenPipe } from '../context.js'
import { CLI, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type Stub } from './stub.js'

describe('broken pipes', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { big: { name: 'big', label: 'Big' } }, processes: {}, apps: {} })],
      [/^GET \/metaData\/table\/big$/, () => ({ name: 'big', label: 'Big', primaryKeyField: 'id', capabilities: ['TABLE_QUERY'], fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, note: { name: 'note', label: 'Note', type: 'STRING' } } })],
      [/^POST \/table\/big\/query$/, () => ({ records: Array.from({ length: 2000 }, (_, i) => ({ values: { id: i, note: 'x'.repeat(200) } })) })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('the helper exits 0 on EPIPE and rethrows anything else', () => {
    assert.ok(isBrokenPipe(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    assert.ok(!isBrokenPipe(new Error('other')))
    const listeners: Array<(e: Error) => void> = []
    const exits: number[] = []
    exitOnBrokenPipe([{ on: (_: string, f: (e: Error) => void) => listeners.push(f) } as never], (code) => exits.push(code))
    listeners[0]!(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    assert.deepEqual(exits, [0])
    assert.throws(() => listeners[0]!(new Error('disk full')), /disk full/)
  })

  test('a closed stdout ends the command quietly with status 0 and no stack trace', async () => {
    const env = { ...process.env, ...box.env, QQQ_TOKEN: 't', NO_COLOR: '1' }
    const child = spawn(process.execPath, [CLI, '--server', stub.url, 'table', 'query', 'big', '-O', 'json', '-l', '2000'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.stdout.once('data', () => child.stdout.destroy())
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    assert.equal(code, 0)
    assert.doesNotMatch(stderr, /EPIPE|at .*\.js/)
  })
})
