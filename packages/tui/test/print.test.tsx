/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { printerOf, readRememberedPrinter, writeFilePreferences, writeRememberedPrinter } from '@qrun-io/qqq-core'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureScreenText, contentSections, printTargetOf, printerChoices } from '../src/printing'
import { printing } from './fake-print'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
beforeEach(() => {
  printing.reset()
  writeFilePreferences({ downloadMode: undefined, downloadDir: undefined })
  writeRememberedPrinter('fake', undefined)
})
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
  printing.reset()
})

const key = (k: string) => press(h!, () => h!.setup.mockInput.pressKey(k))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())
const arrow = (d: 'up' | 'down') => press(h!, () => h!.setup.mockInput.pressArrow(d))

/** Polls the print tracker once (the tests run without timers) and repaints. */
const poll = () => press(h!, () => h!.store.printTracker.poll())
const esc = () => press(h!, () => h!.setup.mockInput.pressEscape(), 120)
const ctrlP = () => press(h!, () => h!.setup.mockInput.pressKey('p', { ctrl: true }))

test('picker rows: unprintable ones are disabled with the reason; the remembered one is preselected', () => {
  const printers = [
    printerOf({ values: { id: 'z', name: 'Zebra', enabled: 1, available: 1, formats: '["ZPL"]' } }),
    printerOf({ values: { id: 'a', name: 'Laser A', enabled: 1, available: 1, formats: '["PDF"]' } }),
    printerOf({ values: { id: 'b', name: 'Laser B', enabled: 0, available: 1, formats: '["PDF"]' } }),
    printerOf({ values: { id: 'c', name: 'Laser C', enabled: 1, available: 1, formats: '["PDF"]' } }),
  ]
  const fresh = printerChoices(printers, undefined)
  expect(fresh.initial).toBe(1)
  expect(fresh.choices[0]!.disabled).toBe('"Zebra" cannot print now: it does not take PDF')
  expect(fresh.choices[2]!.disabled).toBe('"Laser B" cannot print now: it is not approved for printing')
  const remembered = printerChoices(printers, 'c')
  expect(remembered.initial).toBe(3)
  expect(remembered.choices[3]!.label).toBe('Laser C  (last used)')
  // a remembered printer that cannot print now is not preselected
  expect(printerChoices(printers, 'b').initial).toBe(1)
})

test('record: p opens the printer picker, Enter prints, the job is followed in the status line and the choice is remembered', async () => {
  printing.enabled = true
  h = await startTui(120, 36)
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  const labels = () => (h!.store.screen?.menu?.() ?? []).map((e) => e.label)
  expect(labels()).toContain('Print… (a record sheet)')
  expect(labels()).not.toContain('Run Print on this record')
  await key('p')
  let f = await waitFor(h, (x) => x.includes('Print Person First2 Odd on…'))
  expect(f).toContain('Virtual PDF printer')
  expect(f).toContain('Zebra')
  // printable printers first (by name), then Zebra (ZPL only)
  expect(f.indexOf('Back office laser')).toBeLessThan(f.indexOf('Zebra'))
  await arrow('down')
  await arrow('down')
  await enter()
  f = await waitFor(h, (x) => x.includes('cannot print now: it does not take PDF'))
  // type to narrow the picker, as a person would
  await press(h, () => h!.setup.mockInput.typeText('Virtual PDF'))
  await enter()
  await waitFor(h, () => printing.runs.length === 1)
  expect(printing.runs[0]).toMatchObject({ values: { printingPrinterId: 'p1', printingCopies: 1 }, recordIds: '2' })
  f = await waitFor(h, (x) => x.includes('Queued a print job for Person First2 Odd on Virtual PDF printer'))
  expect(h.store.status.print).toBe('print 0/1 QUEUED')
  await poll()
  await poll()
  expect(h.store.status.print).toBe('print 0/1 RECEIVED')
  f = await poll()
  expect(h.store.status.print).toBeUndefined()
  expect(f).toContain('Printed Person First2 Odd on Virtual PDF printer.')
  expect(readRememberedPrinter('fake')).toEqual({ id: 'p1', name: 'Virtual PDF printer' })
})

test('grid: Space selects records, p, "a record sheet for each selected row" prints them on the remembered printer (preselected)', async () => {
  printing.enabled = true
  writeRememberedPrinter('fake', { id: 'p3', name: 'Back office laser' })
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1'))
  await key(' ')
  await key(' ')
  expect((h.store.screen?.menu?.() ?? []).map((e) => e.label)).toContain('Print… (all rows, this page or the selection)')
  await key('p')
  let f = await waitFor(h, (x) => x.includes('Print Person: what?'))
  expect(f).toContain('Selected rows (2) as a list')
  await press(h, () => h!.setup.mockInput.typeText('record sheet'))
  await enter()
  f = await waitFor(h, (x) => x.includes('Print 2 Person records on…'))
  expect(f).toContain('Back office laser  (last used)')
  await enter()
  await waitFor(h, () => printing.runs.length === 1)
  expect(printing.runs[0]).toMatchObject({ values: { printingPrinterId: 'p3', printingCopies: 1 }, recordIds: '1,2' })
  await waitFor(h, () => h!.store.status.print === 'print 0/2 QUEUED')
  await poll()
  await poll()
  await poll()
  expect(h.store.status.print).toBeUndefined()
})

test(':printjobs lists the recent print jobs', async () => {
  printing.enabled = true
  printing.jobs.set('job-9', { title: 'Person: 9', states: ['SPOOLER_COMPLETED'], reads: 0 })
  h = await startTui(120, 36)
  await command(h, 'printjobs')
  const f = await waitFor(h, (x) => x.includes('Print jobs (newest first)'))
  expect(f).toContain('Person: 9')
  expect(f).toContain('SPOOLER_COMPLETED')
})

test('without the printing extension: Ctrl+P saves instead (the grid export, else the screen as text); :printjobs says what is missing', async () => {
  h = await startTui(120, 36)
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  expect((h.store.screen?.menu?.() ?? []).map((e) => e.label)).toContain('Print… (saves the screen as a file: no printing on this server)')
  await ctrlP()
  await waitFor(h, (x) => x.includes('Save the screen as text'))
  await esc()
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1'))
  await ctrlP()
  await waitFor(h, (x) => x.includes('save the list as a file instead'))
  expect(printing.listRuns).toEqual([])
  await esc()
  await command(h, 'printjobs')
  await waitFor(h, (x) => x.includes('Print jobs need the printing extension'))
})

test('Ctrl+P on a grid: all rows first (small grid), the printer picker, then a table list with the grid columns, widths, filter and sort', async () => {
  printing.enabled = true
  h = await startTui(140, 40)
  await command(h, 'table query person -w "lastName = Odd" -o -id')
  await waitFor(h, (f) => f.includes('First30'))
  await ctrlP()
  let f = await waitFor(h, (x) => x.includes('Print Person: what?'))
  const all = f.indexOf('All 15 rows (current filter and sort)')
  expect(all).toBeGreaterThan(-1)
  expect(all).toBeLessThan(f.indexOf('This page (rows 1-15)'))
  await enter()
  f = await waitFor(h, (x) => x.includes('Print Person: 15 rows on…'))
  await enter()
  await waitFor(h, () => printing.listRuns.length === 1 && printing.listRuns[0]!.values.printingPrinterId !== undefined)
  const run = printing.listRuns[0]!
  expect(run.process).toBe('printingPrintTableList')
  expect(run.values.tableName).toBe('person')
  expect(run.values.scope).toBe('ALL')
  expect(String(run.values.columns).split(',')).toContain('firstName')
  expect(String(run.values.columnWidths).split(',').length).toBe(String(run.values.columns).split(',').length)
  const filter = JSON.parse(String(run.values.filterJSON))
  expect(filter.criteria[0]).toMatchObject({ fieldName: 'lastName', values: ['Odd'] })
  expect(filter.orderBys).toEqual([{ fieldName: 'id', isAscending: false }])
  expect(filter.skip).toBeUndefined()
  expect(run.values.filterDescription).toContain('lastName')
  expect(run.values.title).toBe('Person')
  await waitFor(h, (x) => x.includes('Queued a print job for Person: 15 rows on Back office laser'))
  await poll()
  await poll()
  f = await poll()
  expect(f).toContain('Printed Person: 15 rows on Back office laser.')
})

test('Ctrl+P on a large unfiltered grid offers this page first; choosing it prints the page (skip/limit)', async () => {
  printing.enabled = true
  h = await startTui(140, 40)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1'))
  const target = printTargetOf(h.store.screen)
  expect(target.kind).toBe('list')
  // 30 rows is small: all rows first; a large result puts this page first (kernel listScopeChoices)
  await ctrlP()
  await waitFor(h, (x) => x.includes('Print Person: what?'))
  await press(h, () => h!.setup.mockInput.typeText('This page'))
  await enter()
  await waitFor(h, (x) => x.includes('Print Person: page 1 on…'))
  await enter()
  await waitFor(h, () => printing.listRuns.at(-1)?.values.printingPrinterId !== undefined)
  const run = printing.listRuns.at(-1)!
  expect(run.values.scope).toBe('PAGE')
  expect(JSON.parse(String(run.values.filterJSON))).toMatchObject({ skip: 0 })
})

test('Ctrl+P on a record prints its record sheet; F8 says Print where there is no Delete, and prints the screen as text', async () => {
  printing.enabled = true
  h = await startTui(120, 36)
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  expect(printTargetOf(h.store.screen)).toEqual({ kind: 'record', table: 'person', ids: ['2'], what: 'Person First2 Odd' })
  await ctrlP()
  await waitFor(h, (x) => x.includes('Print Person First2 Odd on…'))
  await esc()
  await command(h, 'home')
  let f = await waitFor(h, () => h!.store.screen?.kind === 'home')
  expect(h.store.fkeys().find((k) => k.n === 8)?.label).toBe('Print')
  expect(f).toContain('8Print')
  expect(printTargetOf(h.store.screen)).toEqual({ kind: 'text', title: h.store.screen!.title() })
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F8))
  f = await waitFor(h, (x) => x.includes('Print what?'))
  // Content first (the default), Screen second
  expect(f.indexOf('Content')).toBeLessThan(f.indexOf('Screen  '))
  await enter()
  f = await waitFor(h, (x) => x.includes('Print the content of'))
  await enter()
  await waitFor(h, () => printing.listRuns.at(-1)?.values.printingPrinterId !== undefined)
  const run = printing.listRuns.at(-1)!
  expect(run.process).toBe('printingPrintText')
  const sections = JSON.parse(String(run.values.sections)) as Array<{ title: string; lines: string[] }>
  expect(sections.length).toBeGreaterThan(0)
  const content = JSON.stringify(sections)
  expect(content).not.toContain('Apps (Tab)')
  expect(content).not.toContain('│')
  expect(content).not.toContain('1Help')
  // the app header and footer
  expect(run.values.headerApp).toBe('Fake')
  expect(run.values.headerTitle).toBe(h.store.screen!.title())
  expect(String(run.values.headerServer)).toContain('fake.test')
  expect(run.values.headerUser).toBe(h.store.status.user)
  expect(String(run.values.headerPrintedAt)).toMatch(/\d/)
  expect(String(run.values.footerLeft)).toMatch(/^qqq ui \d+\.\d+\.\d+ · .*fake\.test/)
})

test('Print what? → Screen prints the terminal as drawn; a record print carries the breadcrumb', async () => {
  printing.enabled = true
  h = await startTui(120, 36)
  await ctrlP()
  await waitFor(h, (x) => x.includes('Print what?'))
  await arrow('down')
  await enter()
  await waitFor(h, (x) => x.includes('Print this screen'))
  await enter()
  await waitFor(h, () => printing.listRuns.at(-1)?.values.printingPrinterId !== undefined)
  const run = printing.listRuns.at(-1)!
  expect(run.values.sections).toBeUndefined()
  expect(String(run.values.text)).toContain('Apps')
  expect(String(run.values.text)).not.toContain('1Help')
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  await ctrlP()
  await waitFor(h, (x) => x.includes('Print Person First2 Odd on…'))
  await press(h, () => h!.setup.mockInput.typeText('Virtual PDF'))
  await enter()
  await waitFor(h, () => printing.runs.length === 1)
  expect(printing.runs[0]!.values.headerTitle).toBe('People › Person › First2 Odd')
})

test('content sections: the content panel only, inner panels as titled sections in reading order, no borders, no key hint', () => {
  const frame = [
    ' Fake ─ Home                                                Tester ',
    '┌─ Apps (Tab) ─┐┌─ Home ───────────────────────────────────────────┐',
    '│▸ People      ││Good morning, Tester                               │',
    '│              ││┌─ Recently viewed ─┐┌─ Quick actions ───────────┐ │',
    '│              │││ Ada Lovelace      ││ ▷ Simple Sleep       run  │ │',
    '│              │││ Blair Sample      ││ + New Person      create  │ │',
    '│              ││└───────────────────┘└───────────────────────────┘ │',
    '│              ││ Applications (2)                                  │',
    '│              ││ a actions · Tab panels · Esc back                 │',
    '└──────────────┘└───────────────────────────────────────────────────┘',
    ' fake.test · fake · mock session · jobs n/a ',
    ' 1Help 2Search 8Print ',
  ].join('\n')
  const sections = contentSections(frame)
  expect(sections).toEqual([
    { title: '', lines: ['Good morning, Tester'] },
    { title: 'Recently viewed', lines: ['Ada Lovelace', 'Blair Sample'] },
    { title: 'Quick actions', lines: ['▷ Simple Sleep       run', '+ New Person      create'] },
    { title: '', lines: ['Applications (2)'] },
  ])
  expect(contentSections('')).toEqual([])
  // a panel cut off by the bottom of the content panel still becomes a section
  const clipped = [' t', '┌─ Main ──────────────┐', '│┌─ Apps grid ───────┐│', '││ Alerts  Cluster   ││', '││ 3 tables          ││', ' status', ' keys'].join('\n')
  expect(contentSections(clipped)).toEqual([{ title: 'Apps grid', lines: ['Alerts  Cluster', '3 tables'] }])
})


test('Print Screen (when the terminal passes it on) and :print <printer> print without the picker', async () => {
  printing.enabled = true
  h = await startTui(120, 36)
  await press(h, () => h!.store.handleKey({ name: 'printscreen', sequence: '' } as never))
  await waitFor(h, (x) => x.includes('Print what?'))
  await esc()
  await command(h, 'print back office')
  await waitFor(h, () => printing.listRuns.length === 1 && printing.listRuns[0]!.values.printingPrinterId === 'p3')
  await command(h, 'print zebra')
  await waitFor(h, (x) => x.includes('"Zebra" cannot print now: it does not take PDF'))
})

test('the screen capture drops the status line and the function-key bar and trims the right edge', () => {
  const store = { captureScreen: () => ' Title bar   \n body line   \n\n status line \n 1Help 2Go to \n\n' } as never
  expect(captureScreenText(store)).toBe(' Title bar\n body line')
  expect(captureScreenText({} as never)).toBe('')
})

test('Save as PDF is the first picker entry: a record renders on the server and saves like a download (silent mode: the download folder, stamped name)', async () => {
  printing.enabled = true
  const folder = mkdtempSync(join(tmpdir(), 'qqq-tui-pdf-'))
  writeFilePreferences({ downloadMode: 'silent', downloadDir: folder })
  h = await startTui(120, 36)
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  await ctrlP()
  const f = await waitFor(h, (x) => x.includes('Print Person First2 Odd on…'))
  const picker = f.split('\n').filter((l) => l.includes('║'))
  expect(picker.findIndex((l) => l.includes('Save as PDF…'))).toBeLessThan(picker.findIndex((l) => l.includes('Back office laser')))
  await press(h, () => h!.setup.mockInput.typeText('Save as PDF'))
  await enter()
  await waitFor(h, (x) => x.includes('Saved '))
  expect(printing.renders).toMatchObject([{ kind: 'RECORD', tableName: 'person', recordId: '2' }])
  expect(printing.runs).toEqual([])
  const files = readdirSync(folder)
  expect(files.length).toBe(1)
  expect(files[0]).toMatch(/^Person-2_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/)
  expect(readFileSync(join(folder, files[0]!), 'utf8')).toStartWith('%PDF-1.7 /download/Person-2.pdf')
})

test('Save as PDF on a grid saves the table list; with the dialog (default mode) the save dialog offers the stamped name', async () => {
  printing.enabled = true
  h = await startTui(140, 40)
  await command(h, 'table query person -w "lastName = Odd"')
  await waitFor(h, (f) => f.includes('First2 '))
  await ctrlP()
  await waitFor(h, (x) => x.includes('Print Person: what?'))
  await enter()
  await waitFor(h, (x) => x.includes('Print Person: 15 rows on…'))
  await press(h, () => h!.setup.mockInput.typeText('Save as PDF'))
  await enter()
  const f = await waitFor(h, (x) => x.includes('Save as PDF') && /Person_\d{4}-\d{2}-\d{2}_\d{6}\.pdf/.test(x))
  expect(f).toContain('Name')
  const render = printing.renders[0]!
  expect(render.kind).toBe('LIST')
  expect(render.scope).toBe('ALL')
  expect(JSON.parse(String(render.filterJSON)).criteria[0]).toMatchObject({ fieldName: 'lastName', values: ['Odd'] })
  expect(render.printingPrinterId).toBeUndefined()
})

test(':print pdf saves the screen as a PDF without the picker; a server without the render process shows no Save as PDF entry', async () => {
  printing.enabled = true
  const folder = mkdtempSync(join(tmpdir(), 'qqq-tui-pdf-'))
  writeFilePreferences({ downloadMode: 'silent', downloadDir: folder })
  h = await startTui(120, 36)
  await command(h, 'print pdf')
  await waitFor(h, (x) => x.includes('Saved '))
  expect(printing.renders[0]!.kind).toBe('TEXT')
  expect(String(printing.renders[0]!.text)).toContain('Apps')
  expect(readdirSync(folder)[0]).toMatch(/_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/)
  await esc()
  printing.render = false
  // F10 › Reset refreshes the metadata: the render process is gone
  await command(h, 'reset')
  await waitFor(h, () => h!.store.screen?.kind === 'home')
  await command(h, 'table get person 2')
  await waitFor(h, (x) => x.includes('First2 Odd'))
  await ctrlP()
  const f = await waitFor(h, (x) => x.includes('Print Person First2 Odd on…'))
  expect(f).not.toContain('Save as PDF…')
})
