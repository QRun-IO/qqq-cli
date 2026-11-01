/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProgram, runCli } from '../program.js'

test('createProgram builds every noun, including ui', () => {
  const names = createProgram().commands.map((c) => c.name())
  for (const n of ['table', 'process', 'widget', 'login', 'ui']) assert.ok(names.includes(n), n)
})

test('runCli sends output to the writers and returns the exit code', async () => {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: (t: string) => { out.push(t) }, stderr: (t: string) => { err.push(t) } }
  assert.equal(await runCli(['nope'], io), 2)
  assert.match(err.join(''), /unknown command 'nope'/)
  assert.equal(await runCli(['completion', 'bash'], io), 0)
  assert.match(out.join(''), /complete/, 'a command that writes to process.stdout directly is captured')
  assert.equal(process.exitCode, undefined)
})
