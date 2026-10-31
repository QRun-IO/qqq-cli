/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OPERATIONS, operation } from '../api/operations.js'
import { ExtensionNotInstalledError, ExtensionRegistry, KNOWN_EXTENSIONS, compareVersions, extensionOfOperation, installedExtensions, knownExtension, operationsOf } from '../extensions/registry.js'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('every extension operation in the index names its extension; core operations name none', () => {
  assert.equal(operation('getEsbOverview')?.extension, 'esb')
  assert.equal(operation('getQbitCollaborationPresence')?.extension, 'collaboration')
  assert.equal(operation('queryTable')?.extension, undefined)
  for (const e of KNOWN_EXTENSIONS) assert.ok(operationsOf(e.name).length > 0, `${e.name} has operations`)
  const names = new Set(KNOWN_EXTENSIONS.map((e) => e.name))
  for (const o of OPERATIONS) if (o.extension) assert.ok(names.has(o.extension), `${o.id} -> ${o.extension}`)
  for (const name of ['esb', 'health', 'alerts', 'assistant', 'collaboration', 'data-analysis', 'sql-workbench', 'secured-data', 'edi', 'quick-search', 'qa-capture']) assert.ok(knownExtension(name), name)
  assert.equal(knownExtension('collaboration')?.pathPrefix, '/qbit/collaboration')
  assert.deepEqual(knownExtension('collaboration')?.channels, ['record:{table}:{pk}', 'table:{table}', 'user:me'])
  assert.equal(extensionOfOperation('getQbitEdiGuidesByGuideIdTree') ?? extensionOfOperation(operationsOf('edi')[0]!.id), 'edi')
})

test('the registry knows what is installed, keeps unknown extensions, and refuses absent ones with the installed list', () => {
  const registry = ExtensionRegistry.fromVersion({ apiVersion: '1.8.0', extensions: [{ name: 'esb', version: '1.1.0' }, { name: 'zebra', version: '0.3.0' }] })
  assert.equal(registry.has('esb'), true)
  assert.equal(registry.has('collaboration'), false)
  assert.equal(registry.version('esb'), '1.1.0')
  assert.deepEqual(registry.unknown().map((e) => e.name), ['zebra'])
  assert.equal(registry.describe(), 'esb 1.1.0, zebra 0.3.0 (unknown to this client)')
  assert.throws(() => registry.require('collaboration'), (e: unknown) => e instanceof ExtensionNotInstalledError && e.message === 'extension collaboration is not installed on this server (installed: esb 1.1.0, zebra 0.3.0)' && e.reason === 'absent')
  assert.doesNotThrow(() => registry.requireOperation('queryTable'))
  assert.doesNotThrow(() => registry.requireOperation('getEsbOverview'))
  assert.throws(() => registry.requireOperation('getQbitCollaborationMyWork'), /getQbitCollaborationMyWork belongs to extension collaboration, which is not installed on this server \(installed: esb 1\.1\.0/)
  assert.throws(() => new ExtensionRegistry([]).require('esb'), /\(installed: none\)/)
})

test('an installed extension below the documented minimum is not usable', () => {
  const registry = ExtensionRegistry.fromVersion({ extensions: [{ name: 'collaboration', version: '1.0.3' }] })
  assert.equal(registry.has('collaboration'), false)
  assert.throws(() => registry.require('collaboration'), (e: unknown) => e instanceof ExtensionNotInstalledError && e.reason === 'too-old' && /1\.1\.0 or later; this server has 1\.0\.3/.test(e.message))
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.equal(compareVersions('1.1.0-RC.2', '1.1.0'), 0)
})

test('installedExtensions reads GET /version once and serves it from the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-ext-'))
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls++
    return json({ apiVersion: '1.8.0', extensions: [{ name: 'esb', version: '1.1.0', pathPrefix: '/esb' }] })
  }
  try {
    const first = await installedExtensions('http://h', fetchImpl, { dir })
    assert.deepEqual(first, [{ name: 'esb', version: '1.1.0', pathPrefix: '/esb', description: undefined, known: true, meetsMinimum: true }])
    await installedExtensions('http://h', fetchImpl, { dir })
    assert.equal(calls, 1)
    await installedExtensions('http://h', fetchImpl, { dir, refresh: true })
    assert.equal(calls, 2)
    const offline = await installedExtensions('http://h', async () => { throw new Error('down') }, { dir, ttlSeconds: 0 })
    assert.equal(offline[0]?.name, 'esb')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
