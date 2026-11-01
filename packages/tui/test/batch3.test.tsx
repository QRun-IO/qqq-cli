/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFilePreferences } from '@qrun-io/qqq-core'
import type { TableScreen } from '../src/screens/table'
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

test('developer: panels, a script revision, its logs; table APIs and an OpenAPI document', async () => {
  h = await startTui(130, 44)
  await command(h, 'table get acc 1')
  await waitFor(h, (x) => x.includes('Alpha'))
  await key('D')
  await waitFor(h, (x) => x.includes('Panel One') && x.includes('codeRef: acc-script') && x.includes('v2  second'))
  const grid = h.store.screen as unknown as { list: { rows: Array<{ key?: string }>; cursor: number } }
  grid.list.cursor = grid.list.rows.findIndex((r) => r.key === 'r:51')
  await enter()
  await waitFor(h, (x) => x.includes('Show the run logs'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('log line one'))
  await esc()
  await esc()
  await esc()
  await command(h, 'table query acc')
  await waitFor(h, (x) => x.includes('1 records'))
  await key('D')
  await waitFor(h, (x) => x.includes('Public API (pub)'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
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
