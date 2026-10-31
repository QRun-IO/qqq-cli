/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { UsageError } from '../context.js'
import { ask } from '../prompt.js'

function terminal(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true })
}

test('ask returns the trimmed answer', async () => {
  const input = terminal()
  const answer = ask('Delete? ', { input, out: new PassThrough() })
  input.write('  yes \r')
  assert.equal(await answer, 'yes')
})

test('ask without a terminal is a usage error, never a hang', async () => {
  await assert.rejects(ask('Delete? ', { input: new PassThrough(), out: new PassThrough() }), UsageError)
})

test('Ctrl-D at a question is a usage error, not a bare AbortError', async () => {
  const input = terminal()
  const answer = ask('Delete? ', { input, out: new PassThrough() })
  input.write('\x04')
  await assert.rejects(answer, (error: unknown) => error instanceof UsageError && /end of input/.test(error.message))
})

test('Ctrl-C at a question is passed on as SIGINT (process run cancels; others exit 130)', async () => {
  const input = terminal()
  const controller = new AbortController()
  let signalled = false
  const onSigint = () => {
    signalled = true
    controller.abort()
  }
  process.on('SIGINT', onSigint)
  try {
    const answer = ask('Submit? ', { input, out: new PassThrough(), signal: controller.signal })
    input.write('\x03')
    await assert.rejects(answer, (error: unknown) => (error as Error).name === 'AbortError')
    assert.equal(signalled, true)
  } finally {
    process.off('SIGINT', onSigint)
  }
})
