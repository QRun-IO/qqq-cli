/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readViewSettings, writeFilePreferences } from '@qrun-io/qqq-core'
import { widgetCalls } from './fake-widgets'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())

test('dashboard widgets: dropdown defaults and changes (stored), date picker, required dropdowns, export, denied and hidden widgets, negative bars, parent children, process widget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-wexp-'))
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  try {
    h = await startTui(130, 60)
    await command(h, 'app dash')
    let f = await waitFor(h, (x) => x.includes('Sales by region') && x.includes('1,000') && x.includes('Please select a Store') && x.includes('Down'))
    expect(f).toContain('You do not have permission to view this data.')
    expect(f).not.toContain('not shown')
    expect(f).toMatch(/Down\s+█+│/)
    expect(f).toMatch(/Up\s+│█+/)
    expect(widgetCalls.some((c) => c.name === 'deniedW')).toBe(false)
    // the default region was applied and sent
    expect(widgetCalls.filter((c) => c.name === 'ddWidget').at(-1)!.body.region).toBe('n')
    // Enter on the first widget heading: its actions
    await enter()
    await waitFor(h, (x) => x.includes('Region: North'))
    await type('Region')
    await enter()
    await waitFor(h, (x) => x.includes('South'))
    await type('South')
    await enter()
    f = await waitFor(h, (x) => x.includes('2,000'))
    expect((readViewSettings('widget:ddWidget').dropdowns as Record<string, string>).region).toBe('s')
    await enter()
    await type('As of')
    await enter()
    await waitFor(h, (x) => x.includes('YYYY-MM-DD'))
    await type('2026-03-04')
    await enter()
    await waitFor(h, () => widgetCalls.filter((c) => c.name === 'ddWidget').at(-1)!.body.asOf === '3/4/2026')
    await enter()
    await type('Export')
    await enter()
    await waitFor(h, (x) => x.includes('Wrote'))
    const file = readdirSync(dir).find((n) => n.endsWith('.csv'))!
    expect(readFileSync(join(dir, file), 'utf8')).toBe('Region,Total,As of\nSouth,2000,3/4/2026\n')
    expect(widgetCalls.some((c) => c.name === 'hbar')).toBe(true)
    expect(widgetCalls.some((c) => c.name === 'unknownW' as string)).toBe(false)
  } finally {
    writeFilePreferences({})
  }
})

test('a process widget runs its process with the default values; a required dropdown loads once chosen', async () => {
  h = await startTui(130, 60)
  await command(h, 'app dash')
  await waitFor(h, (x) => x.includes('Please select a Store'))
  // second widget heading: Needs a choice
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('Store: (none)'))
  await type('Store')
  await enter()
  await type('Store A')
  await enter()
  await waitFor(h, (x) => x.includes('store a'))
  await press(h, () => h!.setup.mockInput.pressArrow('down'))
  await enter()
  await waitFor(h, (x) => x.includes('Run Scanner'))
  await type('Run')
  await enter()
  await waitFor(h, (x) => x.includes('Barcode') && x.includes('PRE'))
})
