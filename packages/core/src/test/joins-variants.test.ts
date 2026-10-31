/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JoinError, associationJoin, defaultJoinColumns, exposedJoins, fieldLabel, filterFieldNames, joinFieldNames, planJoins, resolveField } from '../query/joins.js'
import { VariantError, listTableVariants, resolveVariant, variantBody, variantParam } from '../records/variants.js'

const order = {
  name: 'order', label: 'Order', primaryKeyField: 'id',
  fields: { id: { name: 'id', label: 'Id' }, total: { name: 'total', label: 'Total' } },
  exposedJoins: [
    { label: 'Customer', isMany: false, joinTable: { name: 'customer', label: 'Customer', primaryKeyField: 'id', fields: { id: { name: 'id' }, name: { name: 'name', label: 'Name' }, secret: { name: 'secret', isHidden: true } }, sections: [{ tier: 'T1', fieldNames: ['name'] }] }, joinPath: [{ name: 'orderJoinCustomer', leftTable: 'order', rightTable: 'customer' }] },
    { label: 'Lines', isMany: true, joinTable: { name: 'orderLine', label: 'Order Line', fields: { sku: { name: 'sku', label: 'SKU' } } }, joinPath: [{ name: 'a', leftTable: 'order', rightTable: 'x' }, { name: 'b', leftTable: 'x', rightTable: 'orderLine' }] },
    { label: 'Hidden', joinTable: { name: 'audit', readPermission: false, fields: {} } },
  ],
}

test('exposed joins: readable ones, with join names for one-hop paths; path tables must be readable', () => {
  const joins = exposedJoins(order)
  assert.deepEqual(joins.map((j) => [j.table, j.label, j.isMany, j.joinName]), [['customer', 'Customer', false, 'orderJoinCustomer'], ['orderLine', 'Lines', true, undefined]])
  assert.deepEqual(exposedJoins(order, { customer: { readPermission: true }, orderLine: { readPermission: true } }).map((j) => j.table), ['customer'])
  assert.deepEqual(joinFieldNames(joins), ['customer.id', 'customer.name', 'orderLine.sku'])
  assert.equal(resolveField(order, joins, 'customer.name')!.join!.table, 'customer')
  assert.equal(resolveField(order, joins, 'customer.nope'), undefined)
  assert.equal(fieldLabel(order, joins, 'orderLine.sku'), 'Lines: SKU')
  assert.equal(fieldLabel(order, joins, 'total'), 'Total')
  assert.deepEqual(defaultJoinColumns(joins[0]!), ['customer.name'])
})

test('planJoins joins named and referenced joins, selects shown ones, and asks for distinct counts on many-side joins', () => {
  const joins = exposedJoins(order)
  const filter = { criteria: [{ fieldName: 'orderLine.sku', operator: 'EQUALS' as const, values: ['A'] }], booleanOperator: 'AND' as const, orderBys: [{ fieldName: 'total', isAscending: true }] }
  assert.deepEqual(filterFieldNames({ ...filter, subFilters: [{ criteria: [{ fieldName: 'x', operator: 'IS_BLANK', values: [] }], booleanOperator: 'AND' }] }), ['orderLine.sku', 'total', 'x'])
  const plan = planJoins(joins, { named: ['Customer'], columns: ['id', 'customer.name'], filter })
  assert.deepEqual(plan.joins, [{ joinTable: 'customer', select: true, type: 'LEFT', joinName: 'orderJoinCustomer' }, { joinTable: 'orderLine', select: false, type: 'LEFT' }])
  assert.equal(plan.includeDistinct, true)
  assert.deepEqual(planJoins(joins, { named: ['customer'] }).joins[0]!.select, false)
  assert.deepEqual(planJoins(joins, { named: ['customer'], select: true }).joins[0]!.select, true)
  assert.throws(() => planJoins(joins, { named: ['zz'] }), JoinError)
  assert.throws(() => planJoins(joins, { columns: ['zz.a'] }), /names no exposed join/)
  const assoc = associationJoin({ name: 'pets', associatedTableName: 'pet', join: { name: 'personJoinPet', type: 'ONE_TO_MANY' } }, { name: 'pet', label: 'Pet', fields: {} })!
  assert.deepEqual([assoc.table, assoc.isMany, assoc.joinName], ['pet', true, 'personJoinPet'])
})

test('variants: listed from the v1 route (wrapped or bare), resolved by id, name or type:id, sent as body or JSON param', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.match(String(input), /\/qqq\/v1\/table\/store\/variants$/)
    return new Response(JSON.stringify({ variants: [{ id: 1, type: 'store', name: 'North' }, { id: 2, type: 'store', name: 'Northwest' }, { bad: true }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const variants = await listTableVariants('http://h', fetchImpl, 'store')
  assert.deepEqual(variants, [{ id: '1', type: 'store', name: 'North' }, { id: '2', type: 'store', name: 'Northwest' }])
  assert.equal(resolveVariant(variants, '2').name, 'Northwest')
  assert.equal(resolveVariant(variants, 'north').id, '1')
  assert.equal(resolveVariant(variants, 'west').id, '2')
  assert.deepEqual(resolveVariant(variants, 'store:9'), { type: 'store', id: '9' })
  assert.throws(() => resolveVariant(variants, 'nor'), (e: Error) => e instanceof VariantError && /matches 2 variants/.test(e.message))
  assert.throws(() => resolveVariant([], 'x'), /give type:id/)
  assert.equal(variantParam({ id: '1', type: 'store', name: 'North' }), '{"type":"store","id":"1"}')
  assert.deepEqual(variantBody(undefined), {})
  assert.deepEqual(variantBody({ id: '1', type: 'store' }), { tableVariant: { type: 'store', id: '1' } })
})

test('column statistics: availability needs QUERY_STATS and the process; local computation matches the process shape', async () => {
  const { columnStatsAvailability, computeColumnStats, runColumnStats, statsFilter } = await import('../query/column-stats.js')
  assert.match(columnStatsAvailability({ label: 'T', capabilities: ['TABLE_QUERY'] }, { processes: { columnStats: {} } }).reason!, /QUERY_STATS/)
  assert.match(columnStatsAvailability({ capabilities: ['QUERY_STATS'] }, { processes: {} }).reason!, /no columnStats process/)
  assert.match(columnStatsAvailability({ capabilities: ['QUERY_STATS'] }, { processes: { columnStats: { hasPermission: false } } }).reason!, /may not run/)
  assert.deepEqual(columnStatsAvailability({ capabilities: ['QUERY_STATS'] }, { processes: { columnStats: {} } }), { available: true })
  assert.deepEqual(statsFilter({ criteria: [], booleanOperator: 'AND', skip: 5, limit: 2, orderBys: [] }), { criteria: [], booleanOperator: 'AND' })
  const records = [{ values: { n: 3 } }, { values: { n: 1 } }, { values: { n: 3 } }, { values: { n: null } }]
  const stats = computeColumnStats(records, 'n', { type: 'INTEGER' })
  assert.deepEqual(stats.stats.values, { count: 3, countDistinct: 2, sum: 7, average: 2.333333, min: 1, max: 3 })
  assert.deepEqual(stats.valueCounts.map((r) => [r.values.n, r.values.count]), [[3, 2], [null, 1], [1, 1]])
  assert.deepEqual(computeColumnStats(records, 'n', { type: 'INTEGER' }, 'n.asc').valueCounts.map((r) => r.values.n), [null, 1, 3])
  assert.ok(!('sum' in computeColumnStats(records, 'n', { type: 'INTEGER', possibleValueSourceName: 'p' }).stats.values))
  const hours = computeColumnStats([{ values: { t: '2026-01-01T10:15:00Z' } }, { values: { t: '2026-01-01T10:45:00Z' } }], 't', { type: 'DATE_TIME' })
  assert.deepEqual(hours.valueCounts[0]!.values, { t: '2026-01-01T10:00:00Z', count: 2 })
  let sent: FormData | undefined
  let url = ''
  const fetchImpl: typeof fetch = async (input, init) => {
    url = String(input)
    sent = init?.body as FormData
    return new Response(JSON.stringify({ type: 'COMPLETE', values: { statsFields: [{ name: 'count', label: 'Count' }], statsRecord: { values: { count: 4 } }, valueCounts: [{ values: { n: 3, count: 2 }, displayValues: { n: 'three' } }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const remote = await runColumnStats('http://h', fetchImpl, { table: 't', field: 'n', filter: { criteria: [], booleanOperator: 'AND', limit: 9 }, tableVariant: { type: 's', id: '1' } })
  assert.match(url, /\/qqq\/v1\/processes\/columnStats\/init\?tableVariant=/)
  assert.deepEqual(JSON.parse(String(sent!.get('values'))), { tableName: 't', fieldName: 'n', filterJSON: '{"criteria":[],"booleanOperator":"AND"}', orderBy: 'count.desc' })
  assert.deepEqual(remote.fields, [{ name: 'count', label: 'Count' }])
  assert.equal(remote.valueCounts[0]!.displayValues.n, 'three')
})
