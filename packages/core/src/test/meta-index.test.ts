/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MetaDataIndex, generateMetaData } from '../metadata/index.js'

test('a 1000-table, 500-process instance indexes and searches in milliseconds', () => {
  const doc = generateMetaData({ tables: 1000, processes: 500, widgets: 2000, reports: 300 })
  const text = JSON.stringify(doc)
  const parseStart = performance.now()
  const parsed = JSON.parse(text)
  const parseMs = performance.now() - parseStart
  const index = new MetaDataIndex(parsed)
  assert.equal(index.counts.table, 1000)
  assert.equal(index.counts.process, 500)
  assert.equal(index.counts.widget, 2000)
  assert.ok(index.buildMillis < 200, `build ${index.buildMillis.toFixed(1)} ms`)
  const times: number[] = []
  for (const q of ['inv', 'invoice 12', 'cust', 'recalc ship', 'shpmnt', 'x', 'order_99', 'app 3']) {
    const t = performance.now()
    const r = index.search(q, { limit: 50 })
    times.push(performance.now() - t)
    assert.ok(r.entries.length <= 50)
  }
  assert.ok(Math.max(...times) < 50, `search max ${Math.max(...times).toFixed(1)} ms`)
  console.log(`  ${(text.length / 1e6).toFixed(2)} MB parse ${parseMs.toFixed(1)} ms, index ${index.buildMillis.toFixed(1)} ms, search max ${Math.max(...times).toFixed(2)} ms`)
})

test('ranking: exact, prefix, word prefix, substring, then fuzzy; every word must match', () => {
  const index = new MetaDataIndex({
    appTree: [{ type: 'APP', name: 'sales', label: 'Sales', children: [{ type: 'TABLE', name: 'order', label: 'Order' }, { type: 'TABLE', name: 'orderLine', label: 'Order Line' }, { type: 'TABLE', name: 'backorder', label: 'Back Order' }] }],
    tables: { order: { name: 'order', label: 'Order' }, secret: { name: 'secret', label: 'Secret orders', isHidden: true } },
  })
  assert.deepEqual(index.search('order').entries.map((e) => e.name), ['order', 'orderLine', 'backorder'])
  assert.equal(index.search('ordr').total, 3, 'fuzzy: o-r-d-r in order')
  assert.deepEqual(index.search('order line').entries.map((e) => e.name), ['orderLine'])
  assert.equal(index.search('secret').total, 0)
  assert.equal(index.search('secret', { includeHidden: true }).total, 1)
  assert.deepEqual(index.get('table', 'order')!.path, ['Sales'])
  assert.equal(index.search('', { kinds: ['app'] }).entries[0]!.name, 'sales')
})
