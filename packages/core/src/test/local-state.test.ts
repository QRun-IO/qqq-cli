/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { History, addRecent, readRememberedVariant, rememberVariant, hasPin, hashPin, pinDelayMillis, readRecents, removePin, setPin, verifyPin } from '../session/local-state.js'
import { readConfig } from '../session/profiles.js'

test('the PIN is stored as a salted hash and verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-pin-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    assert.equal(hasPin(env), false)
    assert.equal(verifyPin('anything', env), true, 'no PIN: nothing to check')
    assert.throws(() => setPin('12', env), /at least 4/)
    setPin('2468', env)
    const text = readFileSync(join(dir, 'config.json'), 'utf8')
    assert.ok(!text.includes('2468'), 'the PIN itself is never written')
    const lock = (readConfig(env).ui as { lock: { pinSalt: string; pinHash: string } }).lock
    assert.equal(lock.pinHash, hashPin('2468', lock.pinSalt))
    assert.equal(verifyPin('2468', env), true)
    assert.equal(verifyPin('1357', env), false)
    assert.equal(removePin('0000', env), false)
    assert.equal(removePin('2468', env), true)
    assert.equal(hasPin(env), false)
    assert.deepEqual([1, 2, 3, 10].map(pinDelayMillis), [500, 1000, 2000, 30000])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('histories persist, skip repeats and secrets, and search newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-hist-'))
  const prev = process.env.QQQ_STATE_DIR
  process.env.QQQ_STATE_DIR = dir
  try {
    const h = new History('cmd', 3)
    for (const l of ['table query person', 'table query person', 'login --password x', 'table get pet 3', 'home', 'quit']) h.add(l)
    assert.deepEqual(new History('cmd', 3).entries(), ['quit', 'home', 'table get pet 3'])
    assert.deepEqual(h.search('e'), ['home', 'table get pet 3'])
    const env = { QQQ_CONFIG_DIR: dir }
    addRecent('http://h', { kind: 'record', table: 'person', key: '1', label: 'Avery' }, 30, env)
    addRecent('http://h', { kind: 'record', table: 'person', key: '2', label: 'Blair' }, 30, env)
    addRecent('http://h', { kind: 'record', table: 'person', key: '1', label: 'Avery' }, 30, env)
    assert.deepEqual(readRecents('http://h', env).map((r) => r.key), ['1', '2'])
  } finally {
    if (prev === undefined) delete process.env.QQQ_STATE_DIR
    else process.env.QQQ_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a table variant is remembered per server and table, and forgotten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-variant-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    assert.equal(readRememberedVariant('http://a', 'order', env), undefined)
    rememberVariant('http://a', 'order', { id: '7', type: 'store', name: 'North' }, env)
    assert.deepEqual(readRememberedVariant('http://a', 'order', env), { id: '7', type: 'store', name: 'North' })
    assert.equal(readRememberedVariant('http://b', 'order', env), undefined)
    rememberVariant('http://a', 'order', undefined, env)
    assert.equal(readRememberedVariant('http://a', 'order', env), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
