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

test('home, then the grid; Esc from a record lands on the same row, also after stepping', async () => {
  h = await startTui()
  expect(h.frame()).toContain('People')
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1 ') && f.includes('30 records'))
  const grid = h.store.screen as TableScreen
  for (let i = 0; i < 3; i++) await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (f) => f.includes('record 4 of 30'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, (f) => f.includes('row 4 '))
  expect(h.store.screen).toBe(grid)
  expect(grid.cursor!.index).toBe(3)
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (f) => f.includes('record 4 of 30'))
  for (let i = 0; i < 3; i++) {
    await press(h, () => h!.setup.mockInput.pressKey(']'))
    await waitFor(h, (f) => f.includes(`record ${5 + i} of 30`))
  }
  await press(h, () => h!.setup.mockInput.pressEscape())
  const back = await waitFor(h, (f) => f.includes('row 7 '))
  expect(grid.cursor!.index).toBe(6)
  expect(back).toContain('First7')
})

test('the grid pages on the server, sorts with s and filters through the kernel grammar', async () => {
  h = await startTui(120, 20)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('30 records'))
  const grid = h.store.screen as TableScreen
  const pageSize = grid.cursor!.pageSize
  expect(pageSize).toBeLessThan(30)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.END))
  await waitFor(h, (f) => f.includes('First30'))
  const lastQuery = h.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!
  expect((lastQuery.body as { filter: { skip: number } }).filter.skip).toBe(Math.floor(29 / pageSize) * pageSize)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.HOME))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await press(h, () => h!.setup.mockInput.pressKey('s'))
  await waitFor(h, (f) => f.includes('sort firstName asc'))
  const sorted = h.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!
  expect((sorted.body as { filter: { orderBys: unknown } }).filter.orderBys).toEqual([{ fieldName: 'firstName', isAscending: true }])
  await command(h, 'filter lastName = Odd')
  const filtered = await waitFor(h, (f) => f.includes('15 records'))
  expect(filtered).toContain('lastName EQUALS Odd')
})

test('a form with a contingent field: State waits for Country, then narrows to its states', async () => {
  h = await startTui()
  await command(h, 'table create address')
  let f = await waitFor(h, (x) => x.includes('New Address'))
  expect(f).toContain('set Country first')
  await press(h, () => h!.setup.mockInput.typeText('Home'))
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Choose Country') && x.includes('Canada'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => !x.includes('Choose Country') && !x.includes('set Country first'))
  expect(f).toContain('USA')
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('Choose State') && x.includes('Missouri'))
  expect(f).toContain('narrowed by Country = USA')
  expect(f).not.toContain('Ontario')
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Missouri') && !x.includes('Choose State'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, (x) => x.includes('created Address 9'))
  const insert = h.log.requests.find((r) => r.path === '/table/address' && r.method === 'POST')!
  expect(insert.body).toEqual({ label: 'Home', countryId: 'USA', stateId: 'MO' })
})

test('the process wizard: step form, asynchronous job with progress, summary', async () => {
  h = await startTui()
  await command(h, 'process run sleeper')
  await waitFor(h, (x) => x.includes('Millis'))
  await press(h, () => h!.setup.mockInput.typeText('250'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  const done = await waitFor(h, (x) => x.includes('Finished in'), 6000)
  expect(done).toContain('slept 250')
  const step = h.log.requests.find((r) => r.path === '/processes/sleeper/p1/step/input')!
  expect(JSON.parse(String((step.body as { values: string }).values))).toEqual({ millis: '250' })
})

test('F10 offers Quit, Reset and Cancel; Reset returns to Home with the Apps tree focused', async () => {
  h = await startTui()
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('30 records'))
  let f = await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F10))
  expect(f).toContain('Quit qqq?')
  expect(f).toContain('Reset: go to the home screen')
  f = await press(h, () => h!.setup.mockInput.pressEscape())
  expect(f).not.toContain('Quit qqq?')
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F10))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('reset: home screen'))
  expect(h.store.routes.length).toBe(1)
  expect(h.store.screen?.kind).toBe('home')
  expect(h.store.focus).toBe('sidebar')
})
