/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */


import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeLoadedColumnStats, loadedStatsKind } from '../query/loaded-stats.js'

const rows = (field: string, values: unknown[]) => values.map((v) => ({ values: { [field]: v } }))

test('loaded stats: the kind follows the field type; possible-value ids are not quantities', () => {
  assert.equal(loadedStatsKind({ type: 'INTEGER' }), 'number')
  assert.equal(loadedStatsKind({ type: 'DECIMAL' }), 'number')
  assert.equal(loadedStatsKind({ type: 'INTEGER', possibleValueSourceName: 'person' }), 'other')
  assert.equal(loadedStatsKind({ type: 'DATE_TIME' }), 'date')
  assert.equal(loadedStatsKind({ type: 'STRING' }), 'string')
  assert.equal(loadedStatsKind({ type: 'BOOLEAN' }), 'other')
  assert.equal(loadedStatsKind({}), 'string')
})

test('loaded stats: numbers have sum, mean, median (odd and even), min, max, nulls and distinct', () => {
  const odd = computeLoadedColumnStats(rows('n', [3, 1, 3, null, '', 10]), 'n', { type: 'INTEGER' })
  assert.deepEqual({ rows: odd.rows, count: odd.count, nulls: odd.nulls, distinct: odd.distinct, min: odd.min, max: odd.max, sum: odd.sum, mean: odd.mean, median: odd.median }, { rows: 6, count: 4, nulls: 2, distinct: 3, min: '1', max: '10', sum: 17, mean: 4.25, median: 3 })
  assert.deepEqual(odd.top, [])
  const even = computeLoadedColumnStats(rows('n', [1, 2, 3, 4]), 'n', { type: 'DECIMAL' })
  assert.equal(even.median, 2.5)
  assert.equal(computeLoadedColumnStats(rows('n', [0.1, 0.2]), 'n', { type: 'DECIMAL' }).sum, 0.3)
  // numbers sort as numbers, not as text
  assert.equal(computeLoadedColumnStats(rows('n', [9, 10]), 'n', { type: 'INTEGER' }).max, '10')
})

test('loaded stats: text has shortest, longest and the top 5 values, ties by value', () => {
  const stats = computeLoadedColumnStats(rows('s', ['b', 'a', 'b', 'ccc', null, 'dd', 'e', 'f', 'g', 'a']), 's', { type: 'STRING' })
  assert.equal(stats.kind, 'string')
  assert.equal(stats.nulls, 1)
  assert.equal(stats.distinct, 7)
  assert.equal(stats.shortest, 'b')
  assert.equal(stats.longest, 'ccc')
  assert.equal(stats.min, 'a')
  assert.equal(stats.max, 'g')
  assert.deepEqual(stats.top, [{ value: 'a', count: 2 }, { value: 'b', count: 2 }, { value: 'ccc', count: 1 }, { value: 'dd', count: 1 }, { value: 'e', count: 1 }])
})

test('loaded stats: dates have earliest, latest and the top 5 days', () => {
  const stats = computeLoadedColumnStats(rows('t', ['2026-03-02T10:00:00Z', '2026-03-02T23:59:00Z', '2026-01-05T01:00:00Z', null, '2026-12-31T00:00:00Z']), 't', { type: 'DATE_TIME' })
  assert.equal(stats.kind, 'date')
  assert.equal(stats.min, '2026-01-05T01:00:00Z')
  assert.equal(stats.max, '2026-12-31T00:00:00Z')
  assert.deepEqual(stats.top, [{ value: '2026-03-02', count: 2 }, { value: '2026-01-05', count: 1 }, { value: '2026-12-31', count: 1 }])
  assert.equal(stats.distinct, 3)
  const dates = computeLoadedColumnStats(rows('d', ['1980-01-01', '1970-06-30']), 'd', { type: 'DATE' })
  assert.deepEqual([dates.min, dates.max], ['1970-06-30', '1980-01-01'])
})

test('loaded stats: booleans and possible-value ids count by display value', () => {
  const flags = computeLoadedColumnStats(rows('b', [true, false, true]), 'b', { type: 'BOOLEAN' })
  assert.deepEqual(flags.top, [{ value: 'true', count: 2 }, { value: 'false', count: 1 }])
  assert.equal(flags.sum, undefined)
  const linked = computeLoadedColumnStats([{ values: { p: 1 }, displayValues: { p: 'Ann' } }, { values: { p: 1 }, displayValues: { p: 'Ann' } }, { values: { p: 2 }, displayValues: { p: 'Bob' } }], 'p', { type: 'INTEGER', possibleValueSourceName: 'person' })
  assert.deepEqual(linked.top, [{ value: 'Ann', count: 2 }, { value: 'Bob', count: 1 }])
  assert.equal(linked.sum, undefined)
})

test('loaded stats: no rows, and all nulls', () => {
  for (const type of ['INTEGER', 'STRING', 'DATE_TIME', 'BOOLEAN']) {
    const empty = computeLoadedColumnStats([], 'x', { type })
    assert.deepEqual({ rows: empty.rows, count: empty.count, nulls: empty.nulls, distinct: empty.distinct, min: empty.min, max: empty.max, sum: empty.sum, mean: empty.mean, median: empty.median, top: empty.top }, { rows: 0, count: 0, nulls: 0, distinct: 0, min: undefined, max: undefined, sum: undefined, mean: undefined, median: undefined, top: [] })
  }
  const nulls = computeLoadedColumnStats(rows('x', [null, undefined, '']), 'x', { type: 'STRING' })
  assert.deepEqual({ count: nulls.count, nulls: nulls.nulls, distinct: nulls.distinct, shortest: nulls.shortest, top: nulls.top }, { count: 0, nulls: 3, distinct: 0, shortest: undefined, top: [] })
})
