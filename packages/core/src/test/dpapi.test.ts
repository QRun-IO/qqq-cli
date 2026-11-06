/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DpapiFileStore } from '../session/keyring.js'

test('Windows DPAPI preserves JSON, shell syntax, Unicode and whitespace without plaintext storage', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-dpapi-fixture-'))
  const file = join(dir, 'secrets.dpapi.json')
  const secret = '  ' + JSON.stringify({ token: 'obviously-fake-credential', syntax: '\"\'`$(){}\\', text: 'héllo 世界\nsecond line' }) + '\n '
  try {
    const store = new DpapiFileStore(file)
    await store.set('fixture', secret)
    assert.equal(readFileSync(file, 'utf8').includes('obviously-fake-credential'), false)
    assert.equal(await new DpapiFileStore(file).get('fixture'), secret)
    assert.equal(await store.delete('fixture'), true)
    assert.equal(await store.get('fixture'), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Windows credential failure does not expose subprocess arguments or credential material', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-dpapi-failure-'))
  const file = join(dir, 'secrets.dpapi.json')
  try {
    writeFileSync(file, JSON.stringify({ fixture: 'obviously-fake-invalid-dpapi-value' }))
    await assert.rejects(new DpapiFileStore(file).get('fixture'), error => {
      assert.equal(String(error), 'Error: Windows credential protection failed; check PowerShell and your Windows profile')
      return true
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
