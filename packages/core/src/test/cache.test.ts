/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearMetaDataCache, getMetaData, readCachedMetaData } from '../metadata/cache.js'

test('metadata is fetched once, served from the cache while fresh, and offline uses a stale copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cache-'))
  let fetches = 0
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/version')) return new Response(JSON.stringify({ apiVersion: '1.8.0' }), { status: 200, headers: { 'content-type': 'application/json' } })
    fetches++
    return new Response(JSON.stringify({ metaDataGeneration: fetches, tables: { person: { name: 'person', label: 'Person' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const first = await getMetaData('http://h', fetchImpl, { dir })
    assert.equal(first.tables?.person?.label, 'Person')
    await getMetaData('http://h', fetchImpl, { dir })
    assert.equal(fetches, 1)
    assert.equal(readCachedMetaData('http://h', { dir })?.apiVersion, '1.8.0')
    await getMetaData('http://h', fetchImpl, { dir, ttlSeconds: 0 })
    assert.equal(fetches, 2)
    const offline = await getMetaData('http://h', async () => { throw new Error('no network') }, { dir, offline: true })
    assert.equal(offline.metaDataGeneration, 2)
    clearMetaDataCache('http://h', { dir })
    assert.equal(readCachedMetaData('http://h', { dir }), undefined)
    await assert.rejects(getMetaData('http://h', fetchImpl, { dir, offline: true }), /No cached metadata/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
