/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const key = (k: string, mods?: { ctrl?: boolean }) => press(h!, () => h!.setup.mockInput.pressKey(k, mods))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const esc = () => press(h!, () => h!.setup.mockInput.pressEscape())

test('hidden and disabled tables, processes and apps: unknown names are refused; disabled ones explain the denial and load nothing', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query nosuchtable')
  await waitFor(h, (x) => x.includes('no table named "nosuchtable"'))
  await command(h, 'table query secret')
  await waitFor(h, (x) => x.includes('You do not have permission to view Secret'))
  expect(h.log.requests.some((r) => r.path.includes('/secret'))).toBe(false)
  await esc()
  await command(h, 'process run denyProc')
  await waitFor(h, (x) => x.includes('You do not have permission to run Deny Proc'))
  expect(h.log.requests.some((r) => r.path.includes('denyProc'))).toBe(false)
  await esc()
  await command(h, 'app denyApp')
  await waitFor(h, (x) => x.includes('You do not have permission to view Deny App'))
})

test('capabilities: a read-only table offers no new, edit, delete or copy and refuses them; password masked, hidden field absent', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query ro')
  let f = await waitFor(h, (x) => x.includes('1 records') || x.includes('One'))
  const keys = h.store.screen!.fkeys!()
  expect([keys[4], keys[7], keys[8]]).toEqual([null, null, null])
  expect(f).not.toContain('hunter2')
  expect(f).not.toContain('do-not-show')
  await key('n')
  await waitFor(h, (x) => x.includes('you may not create records'))
  await command(h, 'table get ro 1')
  f = await waitFor(h, (x) => x.includes('Pin') && x.includes('••••••'))
  expect(f).not.toContain('hunter2')
  expect(f).not.toContain('Internal')
  await key('c')
  await waitFor(h, (x) => x.includes('copying needs permission to create records'))
  await key('e')
  await waitFor(h, (x) => x.includes('you may not edit records'))
})

test('permission revoked mid-session: the save is refused with the server message and the form keeps what was typed', async () => {
  h = await startTui(120, 36)
  await command(h, 'table get locked 1')
  await waitFor(h, (x) => x.includes('Before'))
  await key('e')
  await waitFor(h, (x) => x.includes('Ctrl+S save'))
  await key('u', { ctrl: true })
  await type('After')
  await key('s', { ctrl: true })
  const f = await waitFor(h, (x) => x.includes('You do not have permission to edit Locked records'))
  expect(f).toContain('After')
  expect(h.store.screen?.kind).toBe('form')
})



test('a denied report is refused; a record the server refuses shows its message; a process widget for a denied process offers no run', async () => {
  h = await startTui(130, 60)
  await command(h, 'report run deniedReport')
  await waitFor(h, (x) => x.includes('you may not run Denied report'))
  await command(h, 'table get locked 2')
  await waitFor(h, (x) => x.includes('You do not have access to this Locked record'))
  const { WidgetView } = await import('../src/widget-view')
  const view = new WidgetView(h.store, 'procDenied')
  await view.load()
  const run = view.actions().find((a) => a.label === 'Run Deny Proc')!
  expect(run.disabled).toBe('This process is not available to you.')
})
