/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { printerOf, readRememberedPrinter, writeRememberedPrinter } from '@qrun-io/qqq-core'
import { printerChoices } from '../src/printing'
import { printing } from './fake-print'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
beforeEach(() => printing.reset())
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
  expect(labels()).toContain('Print…')
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
  expect(printing.runs[0]).toEqual({ values: { printingPrinterId: 'p1', printingCopies: 1 }, recordIds: '2' })
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

test('grid: Space selects records, p prints the selection on the remembered printer (preselected)', async () => {
  printing.enabled = true
  writeRememberedPrinter('fake', { id: 'p3', name: 'Back office laser' })
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1'))
  await key(' ')
  await key(' ')
  expect((h.store.screen?.menu?.() ?? []).map((e) => e.label)).toContain('Print 2 selected…')
  await key('p')
  const f = await waitFor(h, (x) => x.includes('Print 2 Person records on…'))
  expect(f).toContain('Back office laser  (last used)')
  await enter()
  await waitFor(h, () => printing.runs.length === 1)
  expect(printing.runs[0]).toEqual({ values: { printingPrinterId: 'p3', printingCopies: 1 }, recordIds: '1,2' })
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

test('without the printing extension: no Print action, p does nothing, :printjobs says what is missing', async () => {
  h = await startTui(120, 36)
  await command(h, 'table get person 2')
  await waitFor(h, (f) => f.includes('First2 Odd'))
  expect((h.store.screen?.menu?.() ?? []).map((e) => e.label)).not.toContain('Print…')
  await key('p')
  expect(h.store.overlays.map((o) => o.id)).toEqual([])
  await command(h, 'printjobs')
  await waitFor(h, (x) => x.includes('Print jobs need the printing extension'))
})
