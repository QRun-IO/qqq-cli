/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PasswordRefusedError, readLogin, signInWithPassword } from '../session/login.js'

function memoryStore() {
  const m = new Map<string, string>()
  return { kind: 'memory', get: async (k: string) => m.get(k), set: async (k: string, v: string) => { m.set(k, v) }, delete: async (k: string) => m.delete(k), size: () => m.size }
}

test('TABLE_BASED sign-in sends Basic credentials once and keeps only the session', async () => {
  process.env.QQQ_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qqq-pw-'))
  const seen: string[] = []
  const f: typeof fetch = async (input, init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    seen.push(auth)
    if (auth !== `Basic ${Buffer.from('pat:secret').toString('base64')}`) return new Response(JSON.stringify({ message: 'denied' }), { status: 401 })
    return new Response(JSON.stringify({ uuid: 's-1', values: { user: { username: 'pat' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const store = memoryStore()
  const target = { name: 't', server: 'http://q.test' }
  await assert.rejects(signInWithPassword(store, target, 'pat', 'wrong', 'qqq-tui', f), PasswordRefusedError)
  assert.equal(store.size(), 0, 'a refused sign-in stores nothing')
  await assert.rejects(signInWithPassword(store, target, 'a:b', 'x', 'qqq-tui', f), /colon/)
  const login = await signInWithPassword(store, target, 'pat', 'secret', 'qqq-tui', f)
  assert.equal(login.sessionUUID, 's-1')
  const kept = JSON.stringify(await readLogin(store, target))
  assert.ok(!kept.includes('secret'), 'the password is never stored')
  assert.equal(seen.length, 2)
})
