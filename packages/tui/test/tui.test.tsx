/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import type { TableScreen } from '../src/screens/table'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTheme, writeFilePreferences } from '@qrun-io/qqq-core'
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

test('grid column widths stay fixed while paging, even when the next page has much longer values', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query wide')
  const first = await waitFor(h, (x) => x.includes('40 records') && x.includes('n1 '))
  const header = (frame: string) => frame.split('\n').find((l) => l.includes('Id') && l.includes('Name') && l.includes('Note'))!
  const h1 = header(first)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.END))
  const last = await waitFor(h, (x) => x.includes('40 a-'))
  expect(header(last)).toBe(h1)
  const rowLine = last.split('\n').find((l) => l.includes('40 a-'))!
  expect(rowLine.indexOf('…')).toBeGreaterThan(0)
  expect(h1.indexOf('Note')).toBe(header(last).indexOf('Note'))
})

test('F9 is a stack: the theme picker returns to F9 at the theme entry with the new name; Esc closes F9', async () => {
  h = await startTui(140, 40)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  await press(h, () => h!.setup.mockInput.typeText('theme'))
  let f = await waitFor(h, (x) => x.includes('Theme: high-contrast'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('Classic (cyan title'))
  await press(h, () => h!.setup.mockInput.typeText('Light'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Keep light for') && x.includes('This profile only (fake)'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('Theme: light') && x.includes('Menu  (F9)'))
  expect(readTheme('fake')).toBe('light')
  expect(h.store.settings.theme).toBe('light')
  const menu = h.store.overlays.at(-1) as unknown as { visible(): Array<{ id?: string; label: string }>; index: number }
  expect(menu.visible()[menu.index]!.label).toBe('Theme: light')
  f = await press(h, () => h!.setup.mockInput.pressEscape())
  expect(f).not.toContain('Menu  (F9)')
  expect(h.store.overlays.length).toBe(0)
})

test('Home: panels, Tab between them, Enter on an application card opens its app home', async () => {
  h = await startTui(130, 40)
  const f = await waitFor(h, (x) => x.includes('Quick actions') && x.includes('Applications (1)'))
  expect(f).toContain('Recently viewed')
  // this line went missing when an overlong row wrapped and the layout shrank other rows to zero height
  expect(f).toContain('2 tables · 1 processes')
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('People') && h!.store.screen?.kind === 'app')
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(h.store.screen?.kind).toBe('home')
})

test('export from a filtered grid: the filter and the visible columns go to the server; the file is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-export-'))
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  try {
    h = await startTui(120, 30)
    await command(h, 'table query person -w "lastName = Odd"')
    await waitFor(h, (x) => x.includes('15 records'))
    await command(h, 'export csv')
    await waitFor(h, (x) => x.includes('Wrote'))
    const req = h.log.requests.find((r) => r.path === '/table/person/export')!
    const b = req.body as { filter: { criteria: unknown[] }; fieldNames: string[]; format: string }
    expect(b.format).toBe('csv')
    expect(b.filter.criteria).toEqual([{ fieldName: 'lastName', operator: 'EQUALS', values: ['Odd'] }])
    expect(b.fieldNames).toEqual(['id', 'firstName', 'lastName', 'birthDate'])
    const text = readFileSync(join(dir, readdirSync(dir).find((n) => /^person_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/.test(n))!), 'utf8')
    expect(text.split('\n').length).toBe(16)
  } finally {
    writeFilePreferences({ downloadDir: undefined, downloadMode: undefined })
  }
})

test('the export dialog is pre-filled with a name stamped with the local date and time', async () => {
  writeFilePreferences({ downloadDir: mkdtempSync(join(tmpdir(), 'qqq-export-')), downloadMode: 'ask' })
  try {
    h = await startTui(120, 30)
    await command(h, 'table query person')
    await waitFor(h, (x) => x.includes('records'))
    await command(h, 'export csv')
    const frame = await waitFor(h, (x) => /person_\d{4}-\d{2}-\d{2}_\d{6}\.csv/.test(x))
    expect(frame).toMatch(/person_\d{4}-\d{2}-\d{2}_\d{6}\.csv/)
  } finally {
    writeFilePreferences({ downloadDir: undefined, downloadMode: undefined })
  }
})

test('a file field: chosen in the file dialog, sent as a multipart part; a stored BLOB saves from the record view', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-upload-'))
  writeFileSync(join(dir, 'notes.txt'), 'hello upload')
  h = await startTui(120, 34)
  await command(h, 'table create doc --set title=Report')
  await waitFor(h, (x) => x.includes('(choose a file…)'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('File for Content'))
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressKey('u', { ctrl: true }))
  await press(h, () => h!.setup.mockInput.typeText(join(dir, 'notes.txt')))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('notes.txt (12 B)'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, (x) => x.includes('created Doc 5'))
  expect(h.log.requests.find((r) => r.path === '/table/doc' && r.method === 'POST')!.body).toEqual({ title: 'Report', content: 'notes.txt:hello upload' })
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  try {
    await command(h, 'table get doc 5')
    await waitFor(h, (x) => x.includes('file, 9 B'))
    await press(h, () => h!.setup.mockInput.pressKey('a'))
    await press(h, () => h!.setup.mockInput.typeText('save content'))
    await press(h, () => h!.setup.mockInput.pressEnter())
    await waitFor(h, (x) => x.includes('Saved'))
    expect(readFileSync(join(dir, readdirSync(dir).find((n) => /^doc-5-content_\d{4}-\d{2}-\d{2}_\d{6}$/.test(n))!), 'utf8')).toBe('file body')
  } finally {
    writeFilePreferences({ downloadDir: undefined, downloadMode: undefined })
  }
})

test('quick search is ANDed onto the filter as CONTAINS over the visible text columns; Esc clears it', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query person -w "lastName = Odd"')
  await waitFor(h, (x) => x.includes('15 records'))
  await press(h, () => h!.setup.mockInput.pressKey('q'))
  await press(h, () => h!.setup.mockInput.typeText('First1'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('quick "First1"'))
  const q = h.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!.body as { filter: { criteria: unknown[]; subFilters?: Array<{ booleanOperator: string; criteria: Array<{ fieldName: string; operator: string }> }> } }
  const quick = JSON.stringify(q.filter)
  expect(quick).toContain('"lastName"')
  expect(quick).toContain('"CONTAINS"')
  expect(quick).toContain('"firstName"')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, (x) => !x.includes('quick "First1"'))
})

test('a table with variants asks for one first and queries with tableVariant', async () => {
  h = await startTui(120, 30)
  await command(h, 'table query vt')
  await waitFor(h, (x) => x.includes('Client for Variant Table') && x.includes('Globex'))
  expect(h.log.requests.some((r) => r.path === '/table/vt/query')).toBe(false)
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('3 records') && x.includes('Client Globex'))
})
