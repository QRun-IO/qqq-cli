/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MetaDataIndex, generateMetaData } from '../metadata/index.js'

const QUERIES = ['inv', 'invoice 12', 'cust', 'recalc ship', 'shpmnt', 'x', 'order_99', 'app 3']

/** The least time of `rounds` runs of `work` (the minimum filters out scheduler and GC noise). */
function leastMillis(rounds: number, work: () => void): number {
  let best = Infinity
  for (let i = 0; i < rounds; i++) {
    const t = performance.now()
    work()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

test('a 1000-table, 500-process instance indexes and searches in time linear in its size', () => {
  // Wall-clock bounds flake on shared CI containers (a 50 ms bound failed at 51.5 ms on cimg/node:22),
  // so the guard compares the same work on a 10x smaller instance: the index is a flat scan, so 10x
  // the entries should cost about 10x. A per-keystroke tree walk or a quadratic step would cost ~100x
  // and fail the generous 40x bound below; machine speed cancels out of the ratio.
  const small = new MetaDataIndex(generateMetaData({ tables: 100, processes: 50, widgets: 200, reports: 30 }))
  const doc = generateMetaData({ tables: 1000, processes: 500, widgets: 2000, reports: 300 })
  const text = JSON.stringify(doc)
  const parseStart = performance.now()
  const parsed = JSON.parse(text)
  const parseMs = performance.now() - parseStart
  const index = new MetaDataIndex(parsed)
  assert.equal(index.counts.table, 1000)
  assert.equal(index.counts.process, 500)
  assert.equal(index.counts.widget, 2000)
  const entryRatio = index.entries.length / small.entries.length
  assert.ok(entryRatio > 9 && entryRatio < 11, `the large instance has about 10x the entries (${index.entries.length} vs ${small.entries.length})`)

  for (const q of QUERIES) {
    const r = index.search(q, { limit: 50 })
    assert.ok(r.entries.length <= 50)
    assert.ok(r.total >= r.entries.length)
  }

  const searchAll = (i: MetaDataIndex) => () => { for (let k = 0; k < 20; k++) for (const q of QUERIES) i.search(q, { limit: 50 }) }
  const smallSearch = leastMillis(7, searchAll(small))
  const largeSearch = leastMillis(7, searchAll(index))
  const searchRatio = largeSearch / Math.max(smallSearch, 0.05)
  assert.ok(searchRatio < 40, `search 10x entries took ${searchRatio.toFixed(1)}x as long (${smallSearch.toFixed(2)} ms -> ${largeSearch.toFixed(2)} ms for ${20 * QUERIES.length} searches)`)

  const smallDoc = generateMetaData({ tables: 100, processes: 50, widgets: 200, reports: 30 })
  const smallBuild = leastMillis(5, () => new MetaDataIndex(smallDoc))
  const largeBuild = leastMillis(5, () => new MetaDataIndex(parsed))
  const buildRatio = largeBuild / Math.max(smallBuild, 0.05)
  assert.ok(buildRatio < 40, `building over 10x entries took ${buildRatio.toFixed(1)}x as long (${smallBuild.toFixed(2)} ms -> ${largeBuild.toFixed(2)} ms)`)

  // A loose absolute backstop for local runs only, far above the observed few milliseconds.
  const searchMax = Math.max(...QUERIES.map((q) => leastMillis(3, () => index.search(q, { limit: 50 }))))
  if (!process.env.CI) assert.ok(searchMax < 500, `search max ${searchMax.toFixed(1)} ms`)
  console.log(`  ${(text.length / 1e6).toFixed(2)} MB parse ${parseMs.toFixed(1)} ms, index ${largeBuild.toFixed(1)} ms (${buildRatio.toFixed(1)}x of 1/10), search max ${searchMax.toFixed(2)} ms, ${QUERIES.length * 20} searches ${searchRatio.toFixed(1)}x of 1/10`)
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
