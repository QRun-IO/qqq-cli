/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { shareLog, updates } from './fake-share'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const key = (k: string) => press(h!, () => h!.setup.mockInput.pressKey(k))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())

test('share a saved report: add a user Read-Only, change to Read and Edit, remove; only the owner may share', async () => {
  h = await startTui(120, 36)
  await command(h, 'table get savedReport 1')
  await waitFor(h, (x) => x.includes('record 1 of savedReport') || x.includes('Mine'))
  await key('Z')
  await waitFor(h, (x) => x.includes('Share Mine · 0 shares'))
  await enter()
  await waitFor(h, (x) => x.includes('Share with') && x.includes('Pat Smith'))
  await enter()
  await waitFor(h, (x) => x.includes('Scope') && x.includes('Read-Only'))
  await enter()
  let f = await waitFor(h, (x) => x.includes('Share Mine · 1 share'))
  expect(f).toContain('user · Read-Only')
  expect(shareLog()).toEqual([{ shareId: 1, scopeId: 'READ_ONLY', audienceType: 'user', audienceId: '7', audienceLabel: 'Pat Smith' }])
  await type('Pat')
  await enter()
  await waitFor(h, (x) => x.includes('Change to Read and Edit'))
  await enter()
  f = await waitFor(h, (x) => x.includes('user · Read and Edit'))
  await type('Pat')
  await enter()
  await type('Remove')
  await enter()
  await key('y')
  await waitFor(h, (x) => x.includes('Share Mine · 0 shares'))
  expect(shareLog()).toEqual([])
  await press(h!, () => h!.setup.mockInput.pressEscape())
  await command(h, 'table get savedReport 2')
  await waitFor(h, (x) => x.includes('Theirs'))
  await key('Z')
  await waitFor(h, (x) => x.includes('only the owner of a Saved Report may share it'))
})



test('a saved view is shared through the same share dialog', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query order')
  await waitFor(h, (x) => x.includes('records'))
  await key('a')
  await type('Saved views')
  await enter()
  await waitFor(h, (x) => x.includes('Saved views ·'))
  await type('Share')
  await enter()
  await waitFor(h, (x) => x.includes('Share Recent orders · 0 shares'))
  expect(h.log.requests.some((r) => r.path === '/processes/getSharedRecords/init' && JSON.stringify(r.body).includes('savedView'))).toBe(true)
})



test('saved report record: filter/columns and pivot setup shown and edited, cron schedule, dynamicForm edited, data bag versions', async () => {
  h = await startTui(130, 70)
  await command(h, 'table get savedReport 1')
  let f = await waitFor(h, (x) => x.includes('At 09:00 every day') && x.includes('lastName equals Odd') && x.includes('firstName (none)') === false && x.includes('Rows'))
  expect(f).toContain('0 0 9 * * ?')
  expect(f).toContain('America/Chicago')
  expect(f).toMatch(/Columns\s+id, firstName/)
  expect(f).toMatch(/Values\s+id \(count\)/)
  expect(f).toMatch(/Region \*\s+North/)
  // dynamicForm: Edit these fields
  const dyn = h.store.screen as unknown as { list: { rows: Array<{ key?: string }>; cursor: number } }
  dyn.list.cursor = dyn.list.rows.findIndex((r) => r.key === 'dyn:dynW')
  await enter()
  await waitFor(h, (x) => x.includes('Inputs: Mine') && x.includes('Region'))
  await press(h, () => h!.setup.mockInput.pressKey('u', { ctrl: true }))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, (x) => x.includes('need'))
  await type('South')
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, (x) => x.includes('saved Inputs in inputValues'))
  expect(updates.at(-1)).toEqual({ inputValues: JSON.stringify({ region: 'South', limit: null }) })
  // pivot: clear
  const scr = h.store.screen as unknown as { list: { rows: Array<{ key?: string }>; cursor: number } }
  await waitFor(h, () => scr.list.rows.some((r) => r.key === 'w:pivotSetup'))
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:pivotSetup')
  await enter()
  await type('Clear')
  await enter()
  await key('y')
  await waitFor(h, (x) => x.includes('No pivot table'))
  expect(updates.at(-1)).toEqual({ pivotTableJson: null })
  // data bag versions
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:bagW')
  await enter()
  await type('Versions')
  await enter()
  f = await waitFor(h, (x) => x.includes('Rates · 2 versions') && x.includes('"rate": 2'))
  expect(f).toContain('Version 1')
  await press(h, () => h!.setup.mockInput.pressEscape())
  // filter and columns: choose columns (saved on Esc), then preview the rows in the full grid
  await waitFor(h, () => scr.list.rows.some((r) => r.key === 'w:reportSetup'))
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:reportSetup')
  await enter()
  await type('Choose the col')
  await enter()
  await waitFor(h, (x) => x.includes('Columns · 2 shown'))
  await type('Last')
  await enter()
  await waitFor(h, (x) => x.includes('Columns · 3 shown'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, (x) => x.includes('saved 3 columns'))
  expect(JSON.parse(String(updates.at(-1)!.columnsJson)).columns.filter((c: { isVisible: boolean }) => c.isVisible).length).toBe(3)
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:reportSetup')
  await enter()
  await type('Preview')
  await enter()
  await waitFor(h, (x) => x.includes('lastName EQUALS Odd') || x.includes('15 records'))
  expect(h.store.screen?.kind).toBe('table')
})



test('an API-versioned report setup reads the fields and previews the rows through the application API', async () => {
  h = await startTui(130, 70)
  await command(h, 'table get savedReport 1')
  const scr = h.store.screen as unknown as { list: { rows: Array<{ key?: string }>; cursor: number } }
  await waitFor(h, () => scr.list.rows.some((r) => r.key === 'w:apiSetup'))
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:apiSetup')
  await enter()
  await type('Choose the col')
  await enter()
  let f = await waitFor(h, (x) => x.includes('Full Name'))
  expect(f).not.toContain('First Name')
  await press(h, () => h!.setup.mockInput.pressEscape())
  scr.list.cursor = scr.list.rows.findIndex((r) => r.key === 'w:apiSetup')
  await enter()
  await type('Preview')
  await enter()
  f = await waitFor(h, (x) => x.includes('application API') && x.includes('Avery Sample'))
  expect(f).toContain('1 records')
})
