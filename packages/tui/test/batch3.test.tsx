/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFilePreferences } from '@qrun-io/qqq-core'
import type { TableScreen } from '../src/screens/table'
import type { DeveloperScreen } from '../src/screens/developer'
import { paneText } from '../src/developer/pane'
import { LoadedColumnStatsOverlay } from '../src/overlays/column-stats'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const key = (k: string, mods?: { ctrl?: boolean; shift?: boolean }) => press(h!, () => h!.setup.mockInput.pressKey(k, mods))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())
const esc = () => press(h!, () => h!.setup.mockInput.pressEscape())

test('record view: CHIP value, WIDGET-adorned field drawn as a widget, section help, a section widget with the record context', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  const f = await waitFor(h, (x) => x.includes('in the payload') && x.includes('record 1 of acc'))
  expect(f).toContain('[Active]')
  expect(f).toContain('Main section help.')
  const widget = h.log.requests.find((r) => r.path === '/widget/ctxWidget')!
  expect((widget.body as { id: string }).id).toBe('1')
})

test('F1 shows table help for the view screen and field help for the edit screen', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  await waitFor(h, (x) => x.includes('Alpha'))
  let f = await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F1))
  f = await waitFor(h, (x) => x.includes('Acc table help for viewers.') && x.includes('Main: Main section help.'))
  expect(f).not.toContain('Name help when editing.')
  await esc()
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F4))
  f = await waitFor(h, (x) => x.includes('Edit Acc 1'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F1))
  await waitFor(h, (x) => x.includes('Name: Name help when editing.'))
})

test('a form adjuster runs on change and its values land in the form', async () => {
  h = await startTui(130, 44)
  await command(h, 'table update acc 1')
  await waitFor(h, (x) => x.includes('Edit Acc 1'))
  await key('u', { ctrl: true })
  await type('Beta')
  await press(h, () => h!.setup.mockInput.pressTab())
  await waitFor(h, (x) => x.includes('changed by adjuster for Beta'))
})

test('audits: newest first, who, when, what, and the field changes', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  await waitFor(h, (x) => x.includes('Alpha'))
  await key('A')
  const f = await waitFor(h, (x) => x.includes('2 of 2 audit entries'))
  expect(f.indexOf('bob')).toBeLessThan(f.indexOf('alice'))
  expect(f).toContain('name: Alfa → Alpha')
})

test('column statistics of the column under the cursor', async () => {
  h = await startTui(130, 44)
  await command(h, 'table query acc')
  await waitFor(h, (x) => x.includes('1 records'))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await key('S')
  const f = await waitFor(h, (x) => x.includes('Column statistics · Name'))
  expect(f).toContain('Distinct: 1')
  expect(f).toContain('Alpha ×1')
})

test('column statistics without a server capability: computed from the loaded rows, and "a" loads them all', async () => {
  h = await startTui(130, 44)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('30 records'))
  await press(h, () => h!.setup.resize(80, 24))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await key('S')
  const f = await waitFor(h, (x) => x.includes('Column statistics · First Name'))
  expect(f).toMatch(/from the 15 loaded rows \(the server offers no column statistics for/)
  expect(f).toContain('Person) · load more rows to widen')
  expect(f).toContain('Shortest: First1')
  expect(f).toContain('Longest:')
  expect(f).toContain('Most common values:')
  expect(f).toContain('a loads all rows up to 10,000 and recomputes')
  expect(h.log.requests.some((r) => r.path === '/processes/columnStats/init')).toBe(false)
  await key('a')
  const all = await waitFor(h, (x) => x.includes('from the 30 loaded rows') && x.includes('Count: 30'))
  expect(all).not.toContain('load more rows')
  expect(all).toContain('Distinct: 30')
  expect(all).toContain('any key closes')
  await key('x')
  await waitFor(h, (x) => !x.includes('Column statistics ·'))
})

test('column statistics: a server that refuses the process (404) falls back to the loaded rows', async () => {
  h = await startTui(130, 44)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('30 records'))
  // the server claims the capability and the process, then refuses it
  const screen = h.store.screen as unknown as TableScreen
  screen.meta!.capabilities = ['TABLE_QUERY', 'QUERY_STATS']
  ;(h.store.meta as { processes: Record<string, unknown> }).processes.columnStats = { name: 'columnStats', label: 'Stats', isHidden: true }
  const client = h.store.client as unknown as { fetch: typeof fetch }
  const real = client.fetch
  client.fetch = (async (input: Request | string | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input).includes('/processes/columnStats/')
    ? new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'no such process' }), { status: 404, headers: { 'content-type': 'application/json' } })
    : real(input as never, init)) as typeof fetch
  await key('S')
  const f = await waitFor(h, (x) => x.includes('Column statistics · Id') && x.includes('loaded rows'))
  expect(f).toContain('Sum:')
  expect(f).toContain('Median:')
})

test('column statistics from loaded rows: Esc stops the reload and keeps the rows loaded so far', async () => {
  h = await startTui(130, 44)
  const records = [{ values: { n: 1 } }, { values: { n: 2 } }]
  let reached: (() => void) | undefined
  const started = new Promise<void>((resolve) => { reached = resolve })
  h.store.open(new LoadedColumnStatsOverlay(h.store, {
    tableLabel: 'Thing', columnLabel: 'N', fieldName: 'n', field: { type: 'INTEGER' }, records, total: 50_000,
    loadAll: async (cap, progress, signal) => {
      progress(1_500, cap)
      reached!()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      return { records: [...records, { values: { n: 3 } }, { values: { n: 4 } }, { values: { n: 5 } }], total: 50_000 }
    },
  }))
  const first = await waitFor(h, (x) => x.includes('from the 2 loaded rows'))
  expect(first).toContain('load more rows to')
  await key('a')
  await started
  const loading = await waitFor(h, (x) => x.includes('loading rows 1,500 of 10,000'))
  expect(loading).toContain('Esc stops')
  await esc()
  const after = await waitFor(h, (x) => x.includes('from the 5 loaded rows'))
  expect(after).toContain('Sum: 15')
  expect(after).toContain('load more rows to')
})

test('developer: sections for panels, scripts (a revision, its logs), JSON; the table view with APIs and an OpenAPI document', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  await waitFor(h, (x) => x.includes('Alpha'))
  await key('D')
  await waitFor(h, (x) => x.includes('1 Security') && x.includes('8 Panel One') && x.includes('Record Security'))
  // the F-key bar keeps the slots that apply here
  const bar = await waitFor(h, (x) => x.includes('3Record'))
  expect(bar).toContain('10Quit')
  await key('8')
  await waitFor(h, (x) => x.includes('panel text'))
  await key('3')
  await waitFor(h, (x) => x.includes('codeRef') && x.includes('acc-script') && x.includes('second'))
  const dev = h.store.screen as unknown as DeveloperScreen
  dev.pane().selected = dev.pane().lines.find((l) => paneText(l).startsWith('v2'))!.id
  await enter()
  await waitFor(h, (x) => x.includes('Show the run logs'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('log line one'))
  await esc()
  await key('4')
  await waitFor(h, (x) => x.includes('Record raw values (json)') && x.includes('"id": 1'))
  await esc()
  await command(h, 'table query acc')
  await waitFor(h, (x) => x.includes('1 records'))
  await key('D')
  await waitFor(h, (x) => x.includes('1 Events') && x.includes('4 APIs') && x.includes('3Table'))
  await key('4')
  await waitFor(h, (x) => x.includes('Public API (pub)'))
  const table = h.store.screen as unknown as DeveloperScreen
  table.pane().selected = table.pane().lines.find((l) => l.run)!.id
  await enter()
  await waitFor(h, (x) => x.includes('View it here'))
  await enter()
  await waitFor(h, (x) => x.includes('"openapi": "3.0.0"'))
})

test('process: named widget with the process UUID, RECORD_LIST paging, back step, DOWNLOAD_FORM saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-dl-'))
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  try {
    h = await startTui(130, 44)
    await command(h, 'process run wizard')
    await waitFor(h, (x) => x.includes('One') && x.includes('▶A'))
    await key('s', { ctrl: true })
    let f = await waitFor(h, (x) => x.includes('process w1') && x.includes('records 1-100 of 120'))
    expect(f).toContain('row 1 ')
    ;(h.store.screen as unknown as { phase: string }).phase = 'review'
    await key('n')
    f = await waitFor(h, (x) => x.includes('records 101-120 of 120'))
    ;(h.store.screen as unknown as { phase: string }).phase = 'form'
    await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F4))
    f = await waitFor(h, (x) => x.includes('▶A') && !x.includes('process w1'))
    expect(h.log.requests.some((r) => r.path === '/processes/wizard/w1/step/one')).toBe(true)
    await key('s', { ctrl: true })
    await waitFor(h, (x) => x.includes('records 1-100 of 120'))
    await key('s', { ctrl: true })
    f = await waitFor(h, (x) => x.includes('Finished in') && x.includes('w saves report.csv'))
    await key('w')
    await waitFor(h, (x) => x.includes('Saved'))
    expect(readFileSync(join(dir, 'report.csv'), 'utf8')).toBe('a,b\n1,2\n')
  } finally {
    writeFilePreferences({ downloadDir: undefined, downloadMode: undefined })
  }
})

test('grid: whole-result and first-N selection, pinned columns, DATE_TIME filter in UTC, a cell link', async () => {
  h = await startTui(130, 34)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('30 records'))
  const grid = h.store.screen as TableScreen
  await key('a', { ctrl: true })
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('all 30 records of the result'))
  await esc()
  grid.view = { ...grid.view, pinned: 1 }
  for (let i = 0; i < 3; i++) await press(h, () => h!.setup.mockInput.pressArrow('right'))
  const f = await press(h, () => undefined)
  expect(f.split('\n').find((l) => l.includes('First Name'))).toContain('Id')
  await command(h, 'table query acc -w "when > 2026-10-31T17:00"')
  await waitFor(h, (x) => x.includes('1 records'))
  const q = h.log.requests.filter((r) => r.path === '/table/acc/query').at(-1)!.body as { filter: { criteria: Array<{ values: string[] }> } }
  expect(q.filter.criteria[0]!.values[0]).toMatch(/Z$/)
  for (let i = 0; i < 4; i++) await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await key('l')
  await waitFor(h, (x) => x.includes('First3') && h!.store.screen?.kind === 'record')
})

test('create child through a composite association fills every join value', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  await waitFor(h, (x) => x.includes('Part (0)'))
  const rec = h.store.screen as unknown as { groups: unknown[]; newChild(g: unknown): void }
  rec.newChild(rec.groups[0])
  const f = await waitFor(h, (x) => x.includes('New Part'))
  expect(f).toContain('Alpha')
  const form = h.store.screen as unknown as { editor: { session: { values: Record<string, unknown> } } }
  expect(form.editor.session.values).toMatchObject({ accId: 1, accName: 'Alpha' })
})



test('reports: a streaming report asks the format and saves; a process report chooses the format then runs its process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-report-'))
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  try {
    h = await startTui(120, 30)
    await command(h, 'report run streamReport')
    await waitFor(h, (x) => x.includes('Stream report: format') && x.includes('CSV'))
    await press(h, () => h!.setup.mockInput.pressArrow('down'))
    await enter()
    await waitFor(h, (x) => x.includes('Wrote'))
    expect(readFileSync(join(dir, 'streamReport.csv'), 'utf8')).toBe('fmt,csv\n')
    await esc()
    await command(h, 'report run wizReport')
    await waitFor(h, (x) => x.includes('Wizard report: format'))
    await enter()
    await waitFor(h, (x) => h!.log.requests.some((r) => r.path === '/processes/wizard/init'))
    const init = h.log.requests.find((r) => r.path === '/processes/wizard/init')!
    expect(JSON.stringify(init.body)).toContain('XLSX')
  } finally {
    writeFilePreferences({})
  }
})



test('ad hoc composite widget: interpolated text, conditional block hidden, input with Enter submits, buttons send their actionCode', async () => {
  h = await startTui(120, 36)
  await command(h, 'process run adhoc')
  let f = await waitFor(h, (x) => x.includes('Order SO-9') && x.includes('Barcode'))
  expect(f).not.toContain('Hint: scan the label')
  expect(f).toContain('[ Skip ]')
  await type('X-42')
  await enter()
  await waitFor(h, (x) => x.includes('Scan: choose') && x.includes('Finish'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  f = await waitFor(h, (x) => x.includes('finish X-42'))
  const step = h.log.requests.find((r) => r.path === '/processes/adhoc/ah/step/scan')!
  expect(String((step.body as Record<string, string>).values)).toContain('"actionCode":"finish"')
})



test('composite INPUT_FIELD editors: required checks as on any process form, a BLOB input goes as a multipart file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-adhoc-'))
  const file = join(dir, 'p.png')
  writeFileSync(file, 'PNGDATA')
  h = await startTui(120, 36)
  await command(h, 'process run adhocfile')
  await waitFor(h, (x) => x.includes('Photo') && x.includes('Quantity'))
  await key('s', { ctrl: true })
  await waitFor(h, (x) => x.includes('need attention'))
  expect(h.log.requests.some((r) => r.path === '/processes/adhocfile/af/step/up')).toBe(false)
  await enter()
  await waitFor(h, (x) => x.includes('Photo') && (x.includes('Find') || x.includes('type to filter this folder')))
  await press(h, () => h!.setup.mockInput.pressTab())
  await key('u', { ctrl: true })
  await type(file)
  await enter()
  await waitFor(h, (x) => x.includes('p.png'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await type('3')
  await key('s', { ctrl: true })
  await waitFor(h, (x) => x.includes('got p.png 7 bytes qty 3'))
})



test('a WIDGET-adorned process field with a filter setup: Enter opens the filter dialog for the form table; the field gets the filter JSON', async () => {
  h = await startTui(120, 40)
  await command(h, 'process run setupProc')
  await waitFor(h, (x) => x.includes('Filter') && x.includes('Table'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('First Name') || x.includes('guided') || x.includes('Filter and sort'))
  await key('s', { ctrl: true })
  await waitFor(h, (x) => x.includes('"orderBys":[]}') && !(h!.store.overlays.length))
  await key('s', { ctrl: true })
  await waitFor(h, (x) => x.includes('filter {') && x.includes('booleanOperator'))
})



test('help: app and widget help on an app home, step and process help, column help on the grid, help-authoring keys', async () => {
  h = await startTui(130, 50)
  await command(h, 'app dash')
  await waitFor(h, (x) => x.includes('Sales by region'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F1))
  let f = await waitFor(h, (x) => x.includes('The sales dashboard.') && x.includes('Totals by region for the chosen date.'))
  await esc()
  await command(h, 'helpkeys')
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F1))
  f = await waitFor(h, (x) => x.includes('[app:dash;slot:help]') && x.includes('[widget:needsWidget;slot:help]'))
  expect(f).toContain('[widget:ddWidget;slot:help]')
  await esc()
  await command(h, 'helpkeys')
  await command(h, 'process run adhoc')
  await waitFor(h, (x) => x.includes('Order SO-9'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F1))
  f = await waitFor(h, (x) => x.includes('Scan orders one by one.') && x.includes('Scan the order label.'))
  await esc()
  await esc()
  await key('y')
  await command(h, 'table query acc')
  await waitFor(h, (x) => x.includes('records'))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  f = await waitFor(h, (x) => x.includes('Status: Where the account stands.'))
})



test('case: quick search and guided text conditions ignore case by default; = and "Match exact case" ask for exact case, kept through the grammar', async () => {
  h = await startTui(130, 40)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  await key('q')
  await type('odd')
  await enter()
  await waitFor(h, () => h!.log.requests.some((r) => r.path === '/table/person/query' && JSON.stringify(r.body).includes('"odd"')))
  let q = h.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!
  expect(JSON.stringify(q.body)).toContain('"options":["CASE_INSENSITIVE"]')
  await key('q')
  await key('u', { ctrl: true })
  await type('=Odd')
  await enter()
  await waitFor(h, () => JSON.stringify(h!.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!.body).includes('"Odd"'))
  q = h.log.requests.filter((r) => r.path === '/table/person/query').at(-1)!
  expect(JSON.stringify(q.body)).not.toContain('CASE_INSENSITIVE')
  const { FilterOverlay } = await import('../src/overlays/filter')
  const grid = h.store.screen as unknown as { meta: never }
  let applied: unknown
  const o = new FilterOverlay(h.store, grid.meta, { criteria: [], booleanOperator: 'AND' }, undefined, (f) => { applied = f })
  h.store.open(o)
  o.focusCond(-1, o.top.conds.findIndex((c) => c.field === 'lastName'))
  await press(h, () => undefined)
  await type('od')
  await enter()
  await waitFor(h, () => o.current().criteria.length === 1)
  expect(o.current().criteria[0]!.options).toEqual(['CASE_INSENSITIVE'])
  // the operator cell's list offers exact case
  await press(h, () => h!.setup.mockInput.pressArrow('left'))
  await enter()
  await type('Match exact')
  await enter()
  await waitFor(h, (x) => x.includes('(exact case)'))
  expect(o.current().criteria[0]!.options).toBeUndefined()
  o.toAdvanced()
  expect(o.text.value).toContain('CONTAINS:CS')
  await key('s', { ctrl: true })
  await waitFor(h, () => applied !== undefined)
  expect(JSON.stringify(applied)).not.toContain('CASE_INSENSITIVE')
})
