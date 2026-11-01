/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'bun:test'
import { ResultCursor, associationGroups, writeViewSettings } from '@qrun-io/qqq-core'
import type { TableMetaData } from '../src/client'
import { RecordScreen, orderedSections } from '../src/screens/record'
import { childBox, childBoxIndicator, planRecordLayout } from '../src/screens/record-layout'

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-tui-layout-'))
  process.env.QQQ_CONFIG_DIR = join(dir, 'config')
  process.env.QQQ_CACHE_DIR = join(dir, 'cache')
  process.env.QQQ_STATE_DIR = join(dir, 'state')
})

const f = (name: string, label: string, type = 'STRING', extra: Record<string, unknown> = {}) => ({ name, label, type, ...extra })

// the sample's sales order: widget sections "Lines" and "Tags" list the associations by join name
const order: TableMetaData = {
  name: 'sales_order', label: 'Sales Order', primaryKeyField: 'id',
  fields: { id: f('id', 'Id', 'INTEGER'), orderNo: f('orderNo', 'Order No'), customer: f('customer', 'Customer'), createDate: f('createDate', 'Create Date', 'DATE_TIME') },
  sections: [
    { name: 'identity', label: 'Identity', tier: 'T1', fieldNames: ['id', 'orderNo', 'customer'] },
    { name: 'lines', label: 'Lines', tier: 'T2', widgetName: 'salesOrderLines' },
    { name: 'tags', label: 'Tags', tier: 'T2', widgetName: 'salesOrderTags' },
    { name: 'dates', label: 'Dates', tier: 'T3', fieldNames: ['createDate'] },
  ],
  associations: [
    { name: 'lines', associatedTableName: 'sales_order_line', join: { name: 'salesOrderJoinLine', leftTable: 'sales_order', rightTable: 'sales_order_line', joinOns: [{ leftField: 'id', rightField: 'salesOrderId' }] } },
    { name: 'tags', associatedTableName: 'sales_order_tag', join: { name: 'salesOrderJoinTag', leftTable: 'sales_order', rightTable: 'sales_order_tag', joinOns: [{ leftField: 'id', rightField: 'salesOrderId' }] } },
  ],
}
const line: TableMetaData = {
  name: 'sales_order_line', label: 'Sales Order Line', primaryKeyField: 'id',
  fields: { id: f('id', 'Id', 'INTEGER'), createDate: f('createDate', 'Create Date', 'DATE_TIME'), salesOrderId: f('salesOrderId', 'Sales Order', 'INTEGER', { possibleValueSourceName: 'sales_order' }), sku: f('sku', 'SKU'), quantity: f('quantity', 'Quantity', 'INTEGER') },
  sections: [{ name: 'line', label: 'Line', tier: 'T1', fieldNames: ['id', 'salesOrderId', 'sku', 'quantity'] }, { name: 'dates', label: 'Dates', tier: 'T3', fieldNames: ['createDate'] }],
}
const tag: TableMetaData = {
  name: 'sales_order_tag', label: 'Sales Order Tag', primaryKeyField: 'id',
  fields: { id: f('id', 'Id', 'INTEGER'), salesOrderId: f('salesOrderId', 'Sales Order', 'INTEGER'), tag: f('tag', 'Tag') },
  sections: [{ name: 'tag', label: 'Tag', tier: 'T1', fieldNames: ['id', 'salesOrderId', 'tag'] }],
}
const widgets = {
  salesOrderLines: { name: 'salesOrderLines', type: 'childRecordList', label: 'Lines', defaultValues: { joinName: 'salesOrderJoinLine', maxRows: 50 } },
  salesOrderTags: { name: 'salesOrderTags', type: 'childRecordList', label: 'Tags', defaultValues: { joinName: 'salesOrderJoinTag', maxRows: 50 } },
}
const lines = (orderId: number, n: number) => Array.from({ length: n }, (_, i) => ({ values: { id: orderId * 100 + i, salesOrderId: orderId, sku: `SKU-${i}-${'x'.repeat(i * 3)}`, quantity: i, createDate: '2026-10-31T22:33:01Z' }, displayValues: { salesOrderId: `SO-${orderId}` }, recordLabel: `line ${i}` }))
const RECORDS: Record<string, unknown> = {
  1: { values: { id: 1, orderNo: 'SO-1001', customer: 'Acme', createDate: '2026-10-31T22:33:01Z' }, recordLabel: 'SO-1001', associatedRecords: { lines: lines(1, 2), tags: [{ values: { id: 1, salesOrderId: 1, tag: 'Rush' } }] } },
  2: { values: { id: 2, orderNo: 'SO-1002', customer: 'Bolt Brothers Incorporated of Somewhere Far', createDate: '2026-10-31T22:33:01Z' }, recordLabel: 'SO-1002', associatedRecords: { lines: lines(2, 12) } },
  3: { values: { id: 3, orderNo: 'SO-1003', customer: '', createDate: '2026-10-31T22:33:01Z' }, recordLabel: 'SO-1003', associatedRecords: {} },
}
const META: Record<string, TableMetaData> = { sales_order: order, sales_order_line: line, sales_order_tag: tag }

/** A record screen over a stub store: just enough client and store for load and build. */
async function recordScreen(pk: string, cursor?: ResultCursor, collaboration = false, width = 120): Promise<RecordScreen> {
  const store = {
    client: { tableMeta: async (name: string) => META[name]!, record: async (_t: string, key: string) => structuredClone(RECORDS[key]), server: 'http://fake.test', fetch },
    meta: { tables: Object.fromEntries(Object.keys(META).map((k) => [k, { name: k, label: META[k]!.label }])), widgets },
    extensions: { has: (name: string) => collaboration && name === 'collaboration', registry: undefined, all: () => [] },
    width,
    status: { profile: '' },
    singleKeys: true,
    remember: () => undefined, bump: () => undefined, flash: () => undefined, run: (p: Promise<unknown>) => p,
  }
  const screen = new RecordScreen(store as never, 'sales_order', pk, cursor)
  for (let i = 0; i < 50 && !screen.record; i++) await new Promise((r) => setTimeout(r, 5))
  screen.width = width
  screen.build()
  return screen
}

/** Line index of each section heading (`Identity (T1) ───`, `Lines (2) ───`), by its label. */
const headings = (s: RecordScreen) => s.list.rows.flatMap((r, i) => { const m = /^([A-Z][A-Za-z ]*?)(?: \([A-Z0-9]+\))? ─/.exec(r.text); return m ? [`${i} ${m[1]}`] : [] })

test('a child list box is the same height whatever its row count: short lists pad, long ones scroll with a count line', () => {
  const box = (count: number, offset = 0) => childBox({ heading: 'Lines', inner: 100, rows: 5, offset, columns: [{ label: 'Id', width: 4 }, { label: 'SKU', width: 10 }], cells: Array.from({ length: count }, (_, i) => [String(i + 1), `sku ${i + 1}`]), key: (i) => (i === undefined ? 'c:0' : `c:0:${i}`), rule: '─', colors: { heading: 'h', dim: 'd' } })
  for (const n of [0, 1, 5, 12]) expect(box(n).length).toBe(5 + 4)
  expect(box(0)[3]!.text).toBe('')
  expect(box(0).at(-1)!.text).toContain('(none) · Enter on the heading or F7 adds one')
  expect(box(2).filter((r) => r.key?.startsWith('c:0:')).length).toBe(2)
  expect(box(2).at(-1)!.text.trim()).toBe('2 rows')
  const scrolled = box(12, 5)
  expect(scrolled.filter((r) => r.key?.startsWith('c:0:')).map((r) => r.key)).toEqual(['c:0:5', 'c:0:6', 'c:0:7', 'c:0:8', 'c:0:9'])
  expect(scrolled.at(-1)!.text).toContain('rows 6-10 of 12')
  expect(box(12, 99).at(-1)!.text).toContain('rows 8-12 of 12')
  expect(box(1, 0)[1]!.text).toStartWith('Lines (1) ─')
  const unavailable = childBox({ heading: 'Secrets', inner: 100, rows: 5, offset: 0, columns: [], cells: [], unavailable: 'You may not read Secrets.', key: () => 'c:1', rule: '─', colors: { heading: 'h', dim: 'd' } })
  expect(unavailable.length).toBe(9)
})

test('the count line: none, a count, or the rows shown of the total', () => {
  expect(childBoxIndicator(0, 0, 5)).toContain('(none)')
  expect(childBoxIndicator(1, 0, 5)).toBe('1 row')
  expect(childBoxIndicator(5, 0, 5)).toBe('5 rows')
  expect(childBoxIndicator(12, 0, 5)).toStartWith('rows 1-5 of 12')
})

test('an association a widget section lists renders once, in the section, under its label, with the widget columns', () => {
  const rec = RECORDS[1] as never
  const groups = associationGroups(rec, order as never, { sales_order_line: line as never, sales_order_tag: tag as never }, { widgets })
  const plan = planRecordLayout(orderedSections(order), order, groups, widgets, new Map([['sales_order_line', line], ['sales_order_tag', tag]]))
  expect(plan.map((x) => (x.kind === 'children' ? `children:${x.group.association.name}:${x.label}` : `${x.kind}:${x.section.name}`))).toEqual(['fields:identity', 'children:lines:Lines', 'children:tags:Tags', 'fields:dates'])
  const lineList = plan.find((x) => x.kind === 'children' && x.group.association.name === 'lines')
  // Next's widget columns: key first, T1 section order, then T3, without the parent key
  expect(lineList?.kind === 'children' && lineList.columns).toEqual(['id', 'sku', 'quantity', 'createDate'])
  // a widget that lists no association of this table is a distinct widget and stays
  const other = { ...widgets, salesOrderTags: { name: 'salesOrderTags', type: 'statistics', label: 'Tags' } }
  const plan2 = planRecordLayout(orderedSections(order), order, associationGroups(rec, order as never, { sales_order_line: line as never, sales_order_tag: tag as never }, { widgets: other }), other, new Map([['sales_order_line', line], ['sales_order_tag', tag]]))
  expect(plan2.map((x) => (x.kind === 'children' ? `children:${x.group.association.name}` : `${x.kind}:${x.section.name}`))).toEqual(['fields:identity', 'children:lines', 'widget:tags', 'fields:dates', 'children:tags'])
})

test('the record view does not duplicate a widget-bound association', async () => {
  const screen = await recordScreen('1')
  const text = screen.list.rows.map((r) => r.text)
  expect(text.filter((t) => /^Lines \(/.test(t)).length).toBe(1)
  expect(text.filter((t) => /^Tags \(/.test(t)).length).toBe(1)
  expect(text.some((t) => /Sales Order Line$/.test(t.trim()))).toBe(false)
})

test('sections keep their lines across records with different child counts, empty lists and value widths', async () => {
  const one = await recordScreen('1')
  const two = await recordScreen('2')
  const three = await recordScreen('3')
  expect(headings(one)).toEqual(['1 Identity', '5 Lines', '14 Tags', '23 Dates'])
  expect(headings(two)).toEqual(headings(one))
  expect(headings(three)).toEqual(headings(one))
  expect(one.list.rows.length).toBe(two.list.rows.length)
  expect(three.list.rows.length).toBe(one.list.rows.length)
  // the field value column starts at the same place whatever the value
  const valueAt = (s: RecordScreen, value: string) => s.list.rows.find((r) => r.text.startsWith('  Customer'))!.text.indexOf(value)
  expect(valueAt(one, 'Acme')).toBe(valueAt(two, 'Bolt'))
  // child columns are placed from metadata: the same column header for every record
  const header = (s: RecordScreen) => s.list.rows[s.list.rows.findIndex((r) => r.text.startsWith('Lines (')) + 1]!.text
  expect(header(one)).toBe(header(two))
  expect(header(three)).toBe(header(one))
  expect(two.list.rows.some((r) => r.text.includes('rows 1-5 of 12'))).toBe(true)
})

test('the child row count is a per-table view setting', async () => {
  writeViewSettings('record:sales_order', { childRows: 3 })
  try {
    const screen = await recordScreen('2')
    expect(headings(screen)).toEqual(['1 Identity', '5 Lines', '12 Tags', '19 Dates'])
    expect(screen.list.rows.some((r) => r.text.includes('rows 1-3 of 12'))).toBe(true)
  } finally {
    writeViewSettings('record:sales_order', undefined)
  }
})

test('a focused long list scrolls with PgDn/PgUp and j/k; Enter still opens the child under the cursor', async () => {
  const screen = await recordScreen('2')
  const opened: number[] = []
  screen.openChild = (_group, index) => { opened.push(index) }
  const focus = (key: string) => { screen.list.cursor = screen.list.rows.findIndex((r) => r.key === key) }
  focus('c:0:4')
  screen.onKey({ name: 'down', sequence: '' })
  expect(screen.list.current?.key).toBe('c:0:5')
  expect(screen.list.rows.some((r) => r.text.includes('rows 2-6 of 12'))).toBe(true)
  screen.onKey({ name: 'pagedown', sequence: '' })
  expect(screen.list.current?.key).toBe('c:0:10')
  expect(screen.list.rows.some((r) => r.text.includes('rows 7-11 of 12'))).toBe(true)
  screen.onKey({ name: 'k', sequence: 'k' })
  screen.onKey({ name: 'k', sequence: 'k' })
  screen.onKey({ name: 'k', sequence: 'k' })
  screen.onKey({ name: 'k', sequence: 'k' })
  expect(screen.list.current?.key).toBe('c:0:6')
  screen.onKey({ name: 'k', sequence: 'k' })
  expect(screen.list.current?.key).toBe('c:0:5')
  expect(screen.list.rows.some((r) => r.text.includes('rows 6-10 of 12'))).toBe(true)
  screen.onKey({ name: 'pageup', sequence: '' })
  expect(screen.list.rows.some((r) => r.text.includes('rows 1-5 of 12'))).toBe(true)
  expect(headings(screen)).toEqual(['1 Identity', '5 Lines', '14 Tags', '23 Dates'])
  screen.onKey({ name: 'return', sequence: '' })
  expect(opened).toEqual([0])
})

test('collaboration takes no rows above the sections: the same lines with the extension, the cursor on the first field', async () => {
  const plain = await recordScreen('1')
  const collab = await recordScreen('1', undefined, true)
  const other = await recordScreen('2', undefined, true)
  expect(collab.list.rows.map((r) => r.text)).toEqual(plain.list.rows.map((r) => r.text))
  expect(headings(other)).toEqual(headings(collab))
  expect(collab.list.rows[1]!.text).toStartWith('Identity (T1) ─')
  expect(collab.list.current?.key).toStartWith('f:')
  // a 160-column terminal: the panel takes its cells, the section lines stay the same across records
  const wide = await recordScreen('1', undefined, true, 160)
  const wide2 = await recordScreen('3', undefined, true, 160)
  expect(wide.hasPanel()).toBe(true)
  expect(headings(wide2)).toEqual(headings(wide))
  expect(Math.max(...wide.list.rows.map((r) => r.text.length))).toBeLessThanOrEqual(160 - 2 - 36)
})
