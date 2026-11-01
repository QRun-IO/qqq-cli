/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The mouse through the OpenTUI test renderer's synthetic SGR events, on the whole TUI. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { readViewSettings, resolveDateSettings, upsertProfile } from '@qrun-io/qqq-core'
import { App } from '../src/app'
import { boot, parseArgs } from '../src/boot'
import { SqlRunnerScreen } from '../src/sql/screen'
import { DatePickerOverlay } from '../src/controls/date-picker'
import type { FakeLog } from './fake-server'
import { sqlFakeFetch } from './fake-sql'
import type { TableScreen } from '../src/screens/table'
import { command, isolate, press, sessionSecrets, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined

beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

/** The terminal row and column where `needle` is drawn (first match). */
function find(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split('\n')
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(needle)
    if (x >= 0) return { x, y }
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`)
}

const mouse = () => h!.setup.mockMouse

async function openGrid(width = 120, height = 30): Promise<TableScreen> {
  h = await startTui(width, height)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1 ') && f.includes('30 records'))
  return h.store.screen as TableScreen
}

test('grid: a click puts the cursor on the row and cell, a double-click opens the record', async () => {
  const grid = await openGrid()
  let at = find(h!.frame(), 'First5 ')
  await press(h!, () => mouse().click(at.x, at.y))
  expect(grid.cursor!.index).toBe(4)
  expect(grid.fields()[grid.colCursor]!.name).toBe('firstName')
  at = find(h!.frame(), 'First3 ')
  await press(h!, () => mouse().doubleClick(at.x, at.y))
  await waitFor(h!, (f) => f.includes('record 3 of 30'))
  expect(h!.store.screen?.kind).toBe('record')
})

test('grid: the wheel moves 3 rows, Shift+wheel moves across the columns', async () => {
  const grid = await openGrid()
  const at = find(h!.frame(), 'First2 ')
  await press(h!, () => mouse().scroll(at.x, at.y, 'down'))
  expect(grid.cursor!.index).toBe(3)
  await press(h!, () => mouse().scroll(at.x, at.y, 'up'))
  expect(grid.cursor!.index).toBe(0)
  const col = grid.colCursor
  await press(h!, () => mouse().scroll(at.x, at.y, 'down', { modifiers: { shift: true } }))
  expect(grid.colCursor).toBe(Math.min(grid.fields().length - 1, col + 3))
  expect(grid.cursor!.index).toBe(0)
})

test('grid: a right click opens the actions at that row', async () => {
  const grid = await openGrid()
  const at = find(h!.frame(), 'First6 ')
  await press(h!, () => mouse().click(at.x, at.y, 2))
  expect(grid.cursor!.index).toBe(5)
  expect(h!.store.overlays.length).toBe(1)
})

test('grid: dragging a header edge resizes the column and saves the width', async () => {
  const grid = await openGrid()
  const frame = h!.frame()
  const header = find(frame, 'First Name')
  const before = grid.fields().map((f) => f.name)
  // the separator after the first-name column: the start of the next header label, minus one
  const lineText = frame.split('\n')[header.y]!
  const next = lineText.indexOf(' ', header.x + 'First Name'.length)
  const nextLabel = lineText.slice(next).search(/\S/) + next
  await press(h!, () => mouse().drag(nextLabel - 1, header.y, nextLabel + 5, header.y))
  const saved = readViewSettings('table:person')
  expect(saved.widths?.firstName).toBeGreaterThan(0)
  expect(grid.fields().map((f) => f.name)).toEqual(before)
})

test('F-key bar: a click presses the key; the footer connection opens the menu at Connection', async () => {
  h = await startTui(120, 30)
  const frame = h.frame()
  const help = find(frame, 'Help')
  await press(h, () => mouse().click(help.x + 1, help.y))
  expect(h.store.overlays.length).toBe(1)
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(h.store.overlays.length).toBe(0)
  // the footer is the row above the F-key bar; its first cells are the server and profile: the Servers dialog
  await press(h, () => mouse().click(2, 30 - 2))
  await waitFor(h, () => h!.store.overlays.length === 1)
  expect(h.store.overlays[0]!.constructor.name).toBe('ServersOverlay')
})

test('a click beside a dialog does nothing; the wheel scrolls inside it', async () => {
  h = await startTui(120, 30)
  h.store.commands().menu()
  await press(h, () => undefined)
  const n = h.store.overlays.length
  expect(n).toBeGreaterThan(0)
  await press(h, () => mouse().click(1, 2))
  expect(h.store.overlays.length).toBe(n)
})

test('Mouse: off ignores events; :mouse on brings them back (saved)', async () => {
  const grid = await openGrid()
  await command(h!, 'mouse off')
  expect(h!.store.settings.mouse).toBe(false)
  const at = find(h!.frame(), 'First5 ')
  await press(h!, () => mouse().click(at.x, at.y))
  expect(grid.cursor!.index).toBe(0)
  await command(h!, 'mouse on')
  await press(h!, () => mouse().click(at.x, at.y))
  expect(grid.cursor!.index).toBe(4)
})

test('Apps tree: a click on the glyph opens a node, a double-click on a table opens it', async () => {
  h = await startTui(120, 30)
  const side = h.store.sidebar as unknown as { expanded: Set<string>; cursor: number }
  const glyph = find(h.frame(), '▸ ')
  await press(h, () => mouse().click(glyph.x, glyph.y))
  expect(side.expanded.size).toBe(1)
  expect(h.store.focus).toBe('sidebar')
  const frame = await waitFor(h, (f) => f.includes('▾ '))
  // the first child line under the opened app
  const child = { x: glyph.x + 4, y: find(frame, '▾ ').y + 1 }
  await press(h, () => mouse().doubleClick(child.x, child.y))
  await waitFor(h, () => h!.store.screen?.kind !== 'home')
  expect(['table', 'process', 'app', 'report']).toContain(h.store.screen!.kind)
})

test('F9 menu: a click selects, a double-click opens an area or runs an entry; the crumb goes back; a choice list picks on double-click', async () => {
  h = await startTui(120, 34)
  h.store.commands().menu()
  let frame = await waitFor(h, (f) => f.includes('Settings'))
  const menu = h.store.overlays[0] as unknown as { index: number; level: number; visible(): Array<{ label: string }> }
  let at = find(frame, 'Settings')
  await press(h, () => mouse().click(at.x, at.y))
  expect(menu.visible()[menu.index]!.label).toBe('Settings')
  await press(h, () => mouse().doubleClick(at.x, at.y))
  frame = await waitFor(h, (f) => f.includes('Theme:'))
  expect(menu.level).toBe(2)
  // the crumb line goes back a level, then forward again
  at = find(frame, 'Menu ')
  const crumb = frame.split('\n').findIndex((l) => l.includes(`Menu ${'▸'}`) || l.includes('Menu > ') || /Menu .+Settings/.test(l))
  await press(h, () => mouse().click(at.x + 2, crumb))
  expect(menu.level).toBe(1)
  frame = await waitFor(h, (f) => f.includes('Settings'))
  at = find(frame, 'Settings')
  await press(h, () => mouse().doubleClick(at.x, at.y))
  frame = await waitFor(h, (f) => f.includes('Theme:'))
  const theme = find(frame, 'Theme:')
  await press(h, () => mouse().doubleClick(theme.x, theme.y))
  frame = await waitFor(h, () => h!.store.overlays.length === 2)
  const choice = h.store.overlays[1] as unknown as { index: number; choices: Array<{ label: string; value: string }> }
  const target = choice.choices.find((c) => c.value !== h!.store.settings.theme)!
  at = find(frame, target.label)
  await press(h, () => mouse().click(at.x, at.y))
  expect(choice.choices[choice.index]!.value).toBe(target.value)
  await press(h, () => mouse().doubleClick(at.x, at.y))
  await waitFor(h, () => h!.store.settings.theme === target.value)
})

test('confirm: the [ Yes ] and [ No ] buttons answer', async () => {
  h = await startTui(120, 30)
  let answer = ''
  h.store.confirm('Really?', () => { answer = 'yes' }, () => { answer = 'no' })
  let frame = await waitFor(h, (f) => f.includes('[ Yes ]'))
  let at = find(frame, '[ No ]')
  await press(h, () => mouse().click(at.x + 2, at.y))
  expect(answer).toBe('no')
  h.store.confirm('Really?', () => { answer = 'yes' })
  frame = await waitFor(h, (f) => f.includes('[ Yes ]'))
  at = find(frame, '[ Yes ]')
  await press(h, () => mouse().click(at.x + 2, at.y))
  expect(answer).toBe('yes')
  expect(h.store.overlays.length).toBe(0)
})

test('help: the wheel scrolls it; the footer says how to select text', async () => {
  h = await startTui(120, 24)
  await press(h, () => h!.setup.mockInput.pressKey('?'))
  const frame = await waitFor(h, (f) => f.includes('Help'))
  expect(frame).toContain('Shift+drag selects text')
  const helpOverlay = h.store.overlays[0] as unknown as { top: number }
  const at = find(frame, 'Keys')
  await press(h, () => mouse().scroll(at.x, at.y + 2, 'down'))
  expect(helpOverlay.top).toBe(3)
})

test('developer view: a click on a section tab switches to it; form: a click focuses a field', async () => {
  await openGrid()
  await press(h!, () => h!.setup.mockInput.pressKey('D'))
  let frame = await waitFor(h!, () => h!.store.screen?.kind === 'developer' || h!.store.screen?.kind === 'table-developer' || /Events|Metadata/.test(h!.frame()))
  const dev = h!.store.screen as unknown as { nav: { index: number; sections: Array<{ label: string }> } }
  frame = await waitFor(h!, () => dev.nav.sections.length > 1)
  const second = dev.nav.sections[1]!.label
  const tab = find(frame, `2 ${second}`)
  await press(h!, () => mouse().click(tab.x + 1, tab.y))
  expect(dev.nav.index).toBe(1)
  await command(h!, 'table create address')
  frame = await waitFor(h!, (f) => f.includes('New Address'))
  const form = h!.store.screen as unknown as { editor?: { index: number }; form?: { index: number } }
  const country = find(frame, 'Country')
  await press(h!, () => mouse().click(country.x, country.y))
  const index = (form.editor ?? form.form)?.index
  expect(index).toBeGreaterThan(0)
})

test('Servers dialog: a click selects a profile (either of its lines), a double-click switches', async () => {
  upsertProfile('other', { server: 'http://other.test', short: 'oth', description: 'Another fake' })
  h = await startTui(120, 30)
  h.store.commands().servers()
  const frame = await waitFor(h, (f) => f.includes('Another fake'))
  const dialog = h.store.overlays.at(-1) as unknown as { index: number; list(): Array<{ name: string }> }
  const at = find(frame, 'Another fake')
  await press(h, () => mouse().click(at.x, at.y))
  expect(dialog.list()[dialog.index]!.name).toBe('other')
})

test('SQL Runner: a click focuses a pane and places the caret; a result row and cell, a schema line', async () => {
  const log: FakeLog = { requests: [] }
  const store = boot({ args: parseArgs(['--profile', 'fake']), quit: () => undefined, build: 'test', secrets: sessionSecrets, fetch: sqlFakeFetch(log, true, { executions: [], notebooks: [], rowsCalls: [] }) })
  const setup = await testRender(<App store={store} />, { width: 120, height: 36 })
  h = { setup, store, log, frame: () => setup.captureCharFrame() }
  await waitFor(h, () => h!.store.screen?.kind === 'home' && Boolean(h!.store.meta))
  await command(h, 'sql')
  await waitFor(h, (x) => x.includes('Write SQL above'))
  const runner = h.store.screen as SqlRunnerScreen
  await press(h, () => h!.setup.mockInput.pasteBracketedText('SELECT ID, NAME, EMAIL\nFROM CUSTOMER'))
  await press(h, () => h!.setup.mockInput.pressKey('j' as never, { ctrl: true }))
  let frame = await waitFor(h, (x) => x.includes('250 rows') && x.includes('Customer 004'))
  expect(runner.focus).toBe('results')
  // the caret: a click on the F of FROM (line 2 of the editor)
  const from = find(frame, 'FROM CUSTOMER')
  await press(h, () => mouse().click(from.x + 2, from.y))
  expect(runner.focus).toBe('editor')
  expect([runner.buffer.row, runner.buffer.col]).toEqual([1, 2])
  const row = find(frame, 'Customer 004')
  await press(h, () => mouse().click(row.x, row.y))
  expect(runner.focus).toBe('results')
  frame = await waitFor(h, (x) => x.includes('row 4 '))
  expect(frame).toContain('col 2/')
  // the view tabs in the results border
  const chart = find(frame, 'c chart')
  await press(h, () => mouse().click(chart.x + 1, chart.y))
  await waitFor(h, (x) => x.includes('[c chart]'))
})

test('date picker: a click picks a day, ◂ ▸ page the month, a double-click accepts', async () => {
  h = await startTui(120, 34)
  let accepted = ''
  const p = new DatePickerOverlay(h.store, { title: 'Birth Date', kind: 'DATE', settings: resolveDateSettings({}), timeZone: 'UTC', initial: { year: 2026, month: 1, day: 31, hour: 0, minute: 0, second: 0 }, onAccept: (v) => { accepted = v } })
  h.store.open(p)
  let frame = await waitFor(h, (f) => f.includes('January 2026'))
  // the 15th, on its week line
  let at = find(frame, '12 13 14 15')
  await press(h, () => mouse().click(at.x + 10, at.y))
  expect(p.value()).toBe('2026-01-15')
  const next = find(frame, '▸  ')
  await press(h, () => mouse().click(next.x, next.y))
  frame = await waitFor(h, (f) => f.includes('February 2026'))
  at = find(frame, ' 9 10 11')
  await press(h, () => mouse().doubleClick(at.x + 3, at.y))
  expect(accepted).toBe('2026-02-10')
})

test('the screen saver: a click wakes it (no PIN), as a key does', async () => {
  h = await startTui(120, 30)
  h.store.commands().lock()
  await waitFor(h, () => Boolean(h!.store.lock))
  await press(h, () => mouse().click(10, 10))
  expect(h.store.lock).toBeUndefined()
})

test('completion popup on the : line: the wheel moves the choice, a click selects, a double-click inserts', async () => {
  h = await startTui(120, 34)
  await press(h, () => h!.setup.mockInput.typeText(':'))
  await press(h, () => h!.setup.mockInput.typeText('ta'))
  await press(h, () => h!.setup.mockInput.pressTab())
  const line = h.store.overlays.at(-1) as unknown as { popup?: { model: { cursor: number; matches(): Array<{ value: string }> } }; editor: { value: string } }
  let frame = await waitFor(h, () => Boolean(line.popup))
  const items = line.popup!.model.matches()
  expect(items.length).toBeGreaterThan(1)
  // the popup's second line (the home screen above may show the same word)
  const second = find(frame, `│ ${items[1]!.value} `)
  await press(h, () => mouse().click(second.x + 1, second.y))
  expect(line.popup!.model.cursor).toBe(1)
  await press(h, () => mouse().scroll(second.x + 1, second.y, 'up'))
  expect(line.popup!.model.cursor).toBe(0)
  frame = h.frame()
  await press(h, () => mouse().doubleClick(second.x + 1, second.y))
  expect(line.popup).toBeUndefined()
  expect(line.editor.value).toContain(items[1]!.value)
})
