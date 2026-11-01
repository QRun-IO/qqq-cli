/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import type { TableScreen } from '../src/screens/table'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

test('exposed joins: a joined column sends the join, labels it "Join: Field", reports the distinct count', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query order')
  await waitFor(h, (x) => x.includes('2 records'))
  const grid = h.store.screen as TableScreen
  grid.view = { columns: ['id', 'number', 'line.sku'] }
  grid.newCursor(0)
  const f = await waitFor(h, (x) => x.includes('3 rows (2 distinct)'))
  expect(f).toContain('Line: SKU')
  expect(f).toContain('A-2')
  const q = h.log.requests.filter((r) => r.path === '/table/order/query').at(-1)!.body as { joins: unknown }
  expect(q.joins).toEqual([{ joinTable: 'line', select: true, type: 'LEFT', joinName: 'orderJoinLine' }])
})

test('record sections show fields of readable exposed joins', async () => {
  h = await startTui(120, 30)
  await command(h, 'table get order 1')
  const f = await waitFor(h, (x) => x.includes('First line') && x.includes('A-1'))
  expect(f).toContain('Line: SKU')
})

test('counted quick views show their counts; opening one applies its filter', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query order')
  await waitFor(h, (x) => x.includes('2 records'))
  ;(h.store.screen as TableScreen).savedViews()
  await waitFor(h, (x) => x.includes('Recent orders') && x.includes('1 records'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('number EQUALS SO-2') && x.includes('1 records'))
})

test('quick filters: the T1 fields are offered first in the filter dialog and set a criterion', async () => {
  h = await startTui(120, 34)
  await command(h, 'table query order')
  await waitFor(h, (x) => x.includes('2 records'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F6))
  let f = await waitFor(h, (x) => x.includes('quick  Number'))
  expect(f).toContain('quick  Placed')
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('Number contains'))
  await press(h, () => h!.setup.mockInput.typeText('SO-1'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('number CONTAINS SO-1'))
})

test('weekday criteria through the grammar: weekday(placed) IN sat,sun goes out with WeekdayOfDate', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query order')
  await waitFor(h, (x) => x.includes('2 records'))
  await command(h, 'filter weekday(placed) IN sat,sun')
  await waitFor(h, (x) => x.includes('weekday(placed) IN 6,7'))
  const q = h.log.requests.filter((r) => r.path === '/table/order/query').at(-1)!.body as { filter: { criteria: Array<{ fieldFunction?: unknown }> } }
  expect(q.filter.criteria[0]!.fieldFunction).toEqual({ fieldName: 'placed', functionTypeIdentifierName: 'WeekdayOfDate' })
})

test('first N: a table process runs on the first N records of the result (filter with a limit)', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query person -w "lastName = Odd"')
  await waitFor(h, (x) => x.includes('15 records'))
  ;(h.store.screen as TableScreen).runProcess('sleeper')
  await waitFor(h, (x) => x.includes('first N records'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('How many records?'))
  await press(h, () => h!.setup.mockInput.pressKey('u', { ctrl: true }))
  await press(h, () => h!.setup.mockInput.typeText('3'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Millis'))
  const init = h.log.requests.find((r) => r.path === '/processes/sleeper/init')!.body as { filterJSON: { limit: number; criteria: unknown[] } }
  expect(init.filterJSON.limit).toBe(3)
  expect(init.filterJSON.criteria).toEqual([{ fieldName: 'lastName', operator: 'EQUALS', values: ['Odd'] }])
})

test('scanner screens: no heading or step list, and Enter in the input submits the step', async () => {
  h = await startTui(120, 30)
  await command(h, 'process run scanner')
  const f = await waitFor(h, (x) => x.includes('Barcode'))
  expect(f).not.toContain('Ctrl+S continues')
  await press(h, () => h!.setup.mockInput.typeText('4006381333931'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('scanned 4006381333931'), 5000)
})
