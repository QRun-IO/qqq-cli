/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { generateMetaData } from '@qrun-io/qqq-core'
import { isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

test('F9 and the palette stay search-first and fast on a 1000-table, 500-process instance', async () => {
  const big = generateMetaData({ tables: 1000, processes: 500, widgets: 3000, reports: 300 })
  h = await startTui(140, 40, { metaData: big })
  expect(h.store.index!.counts.table).toBe(1000)
  let t = performance.now()
  let f = await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  const f9Open = performance.now() - t
  expect(f).toContain('1,000 tables, 500 processes')
  expect(f).not.toContain('Table: Order 0')
  t = performance.now()
  f = await press(h, () => h!.setup.mockInput.typeText('invoice 1'))
  const f9Search = performance.now() - t
  f = await waitFor(h, (x) => x.includes('Table: Invoice 1'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  t = performance.now()
  f = await press(h, () => h!.setup.mockInput.pressKey('/'))
  const paletteOpen = performance.now() - t
  expect(f).toContain('type to search')
  t = performance.now()
  f = await press(h, () => h!.setup.mockInput.typeText('shpm'))
  const paletteSearch = performance.now() - t
  f = await waitFor(h, (x) => x.includes('matches'))
  expect(f).toContain('more (scroll)')
  console.log(`  F9 open ${f9Open.toFixed(0)} ms, F9 search ${f9Search.toFixed(0)} ms, palette open ${paletteOpen.toFixed(0)} ms, palette search ${paletteSearch.toFixed(0)} ms (each includes a 30 ms settle)`)
  for (const ms of [f9Open, f9Search, paletteOpen, paletteSearch]) expect(ms).toBeLessThan(1000)
})
