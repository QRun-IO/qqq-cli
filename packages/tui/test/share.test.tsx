/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { shareLog } from './fake-share'
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
