/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The Shift bank (Shift+F1…F10): the table, the bar in one and two rows, dispatch, the mouse, help. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { readConfig } from '@qrun-io/qqq-core'
import { App } from '../src/app'
import { boot, parseArgs } from '../src/boot'
import { ACTIONS } from '../src/keys/actions'
import { SHIFT_BANK, fkeyBarRows, shiftSlots } from '../src/keys/shift-bank'
import { shiftRowCells, slotWidths } from '../src/keys/shift-row'
import { CPR_QUIET_MS, installFKeyRewrite } from '../src/keys/stdin-rewrite'
import { fkeyAt } from '../src/mouse/hit'
import { SqlRunnerScreen } from '../src/sql/screen'
import { fakeFetch, type FakeLog } from './fake-server'
import { sqlFakeFetch } from './fake-sql'
import { command, isolate, press, sessionSecrets, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined

beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const E = '\x1b'
/** Raw bytes into the terminal, as a terminal would send them. */
const raw = (seq: string) => press(h!, () => h!.setup.mockInput.pressKeys([seq]))
const lines = (frame: string) => frame.replace(/\n$/, '').split('\n')
const fits = (frame: string, width: number) => lines(frame).every((l) => [...l].length <= width)
const last = (frame: string, n = 1) => lines(frame).slice(-n)

async function start(width: number, height: number, fkeyBar?: 'one' | 'two' | 'auto', fetch?: typeof globalThis.fetch): Promise<Harness> {
  const log: FakeLog = { requests: [] }
  const store = boot({ args: parseArgs(['--profile', 'fake']), quit: () => undefined, build: 'test', secrets: sessionSecrets, fetch: fetch ?? fakeFetch(log) })
  if (fkeyBar) store.settings.fkeyBar = fkeyBar
  const setup = await testRender(<App store={store} />, { width, height })
  const harness: Harness = { setup, store, log, frame: () => setup.captureCharFrame() }
  store.captureScreen = () => setup.captureCharFrame()
  await waitFor(harness, () => harness.store.screen?.kind === 'home' && Boolean(harness.store.meta))
  return harness
}

/** Changes the bar mode and repaints. */
async function mode(m: 'one' | 'two' | 'auto'): Promise<string> {
  h!.store.settings.fkeyBar = m
  h!.store.bump()
  return press(h!, () => undefined)
}

/** The fake server with the assistant extension (enough for the panel to open). */
function assistantFetch(): typeof fetch {
  const base = fakeFetch({ requests: [] })
  const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } })
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input as RequestInfo, init).url).pathname.replace('/qqq/v1', '')
    if (path === '/version') return json({ apiVersion: '1.9.0', features: ['metaData', 'tables', 'processes'], extensions: [{ name: 'assistant', version: '1.7.0', pathPrefix: '/assistant' }] })
    if (path === '/assistant/config') return json({ enabled: true, model: 'm', profile: { displayName: 'Assistant' } })
    return base(input, init)
  }) as typeof fetch
}

// ---- the table ----

test('the bank is one table of ten keys, each bound to a named action, with short labels for 80 columns', () => {
  expect(SHIFT_BANK.map((k) => k.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(SHIFT_BANK.map((k) => k.label)).toEqual(['Keys', 'Servers', 'SQL', 'Bulk', 'Metadata', 'Views', 'Copy', 'Export', 'History', 'Assistant'])
  for (const k of SHIFT_BANK) {
    expect(ACTIONS[k.action]).toBeDefined()
    expect(k.short.length).toBeLessThanOrEqual(5)
  }
  // the assistant toggle is the named action F12 and Ctrl+G bind too
  expect(SHIFT_BANK.find((k) => k.n === 10)!.action).toBe('assistant.toggle')
})

test('rows: auto is two from 30 lines; one and two are fixed', () => {
  expect(fkeyBarRows('auto', 29)).toBe(1)
  expect(fkeyBarRows('auto', 30)).toBe(2)
  expect(fkeyBarRows(undefined, 40)).toBe(2)
  expect(fkeyBarRows('one', 40)).toBe(1)
  expect(fkeyBarRows('two', 24)).toBe(2)
})

test('row cells: the primary arithmetic, ⇧ on the first number, short labels below 100 columns, clipped', () => {
  expect(slotWidths(80, 10)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 8])
  expect(slotWidths(120, 12).reduce((a, b) => a + b, 0)).toBe(120)
  const slots = SHIFT_BANK.map((k) => ({ n: k.n, label: k.label, global: k.label, short: k.short }))
  const narrow = shiftRowCells(slots, 80)
  expect(narrow[0]!.num).toBe('⇧1')
  expect(narrow[1]!.label.trim()).toBe('Servr')
  expect(narrow.map((c) => c.num + c.label).join('').length).toBe(80)
  expect(shiftRowCells(slots, 120)[4]!.label.trim()).toBe('Metadata')
  expect(shiftRowCells(slots, 80, true)[0]!.num).toBe('S1')
  // twelve slots (when the primary row has 11 and 12) line up; 11 and 12 are blank
  expect(shiftRowCells([...slots, { n: 11, label: null, global: '', short: '' }, { n: 12, label: null, global: '', short: '' }], 120).length).toBe(12)
})

// ---- the bar ----

test('80×24 auto: one row; a Shift+F press shows the Shift row for 2 s, then the primary row again', async () => {
  h = await start(80, 24)
  let f = h.frame()
  expect(fits(f, 80)).toBe(true)
  expect(last(f)[0]).toContain(' 1Help')
  expect(f).not.toContain('⇧1')
  // Shift+F2 (xterm form): the Servers dialog; the bar swaps to the Shift row
  await raw(`${E}[1;2Q`)
  expect(h.store.overlays[0]!.constructor.name).toBe('ServersOverlay')
  f = h.frame()
  expect(last(f)[0]).toStartWith('⇧1Keys')
  expect(last(f)[0]).toContain('2Servr')
  expect(last(f)[0]).toContain('9Hist')
  expect(fits(f, 80)).toBe(true)
  // after the 2 s the primary row is back
  h.store.shiftRowUntil = Date.now() - 1
  h.store.bump()
  f = await press(h, () => undefined)
  expect(last(f)[0]).toContain(' 1Help')
})

test('80×24 two rows: primary then Shift, the footer above them, nothing wider than 80', async () => {
  h = await start(80, 24, 'two')
  const f = h.frame()
  expect(fits(f, 80)).toBe(true)
  const [primary, shift] = last(f, 2)
  expect(primary).toContain(' 1Help')
  expect(primary).toContain('10Quit')
  expect(shift).toStartWith('⇧1Keys')
  expect(shift).toContain('10Asst')
  expect(lines(f).length).toBe(24)
})

test('120×40 auto: two rows with full labels; one-row mode keeps the primary row', async () => {
  h = await start(120, 40)
  let f = h.frame()
  expect(fits(f, 120)).toBe(true)
  const [primary, shift] = last(f, 2)
  expect(primary).toContain(' 1Help')
  expect(shift).toStartWith('⇧1Keys')
  for (const label of ['2Servers', '3SQL', '4Bulk', '5Metadata', '6Views', '7Copy', '8Export', '9History', '10Asst']) expect(shift).toContain(label)
  // the primary row has 11 and 12 from 120 columns: the Shift row lines up with it (11 and 12 unbound)
  expect(shift).toMatch(/11\s+12\s*$/)
  expect(shift.indexOf(' 9History')).toBe(primary.indexOf(' 9Menu'))
  expect(lines(f).length).toBe(40)
  f = await mode('one')
  expect(last(f)[0]).toContain(' 1Help')
  expect(f).not.toContain('⇧1Keys')
  expect(lines(f).length).toBe(40)
  await press(h, () => h!.setup.mockInput.pressKey('F9', { shift: true }))
  f = await waitFor(h, () => h!.store.screen?.kind === 'history')
  expect(last(f)[0]).toStartWith('⇧1Keys')
})

test('context: keys that do not apply are dimmed and say why; on a grid Bulk, Views, Copy and Export apply', async () => {
  h = await start(120, 40)
  const home = Object.fromEntries(shiftSlots(h.store).map((s) => [s.global, s.why]))
  expect(home.Keys).toBeUndefined()
  expect(home.Servers).toBeUndefined()
  expect(home.SQL).toContain('sql-workbench')
  expect(home.Bulk).toContain('table grid')
  expect(home.Views).toContain('table grid')
  expect(home.Copy).toBeDefined()
  expect(home.Export).toContain('table grid')
  expect(home.History).toBeUndefined()
  expect(home.Assistant).toContain('assistant extension')
  // Shift+F3 in the xterm form without the stdin rewrite (main.tsx installs it): OpenTUI takes it for a cursor report
  await raw(`${E}[1;2R`)
  expect(h.store.overlays.length).toBe(0)
  await press(h, () => h!.setup.mockInput.pressKey('F10', { shift: true }))
  expect(h.store.flashText?.text).toContain('Shift+F10 Assistant: needs the assistant extension')
  expect(h.store.assistantOpen).toBe(false)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1 '))
  const grid = Object.fromEntries(shiftSlots(h.store).map((s) => [s.global, s.why]))
  expect(grid.Views).toBeUndefined()
  expect(grid.Export).toBeUndefined()
  // person has no TABLE_INSERT capability in the fake: Copy is dimmed and says so
  expect(grid.Copy).toBe('copying needs permission to create records')
  await press(h, () => h!.setup.mockInput.pressKey('F7', { shift: true }))
  expect(h.store.flashText?.text).toBe('Shift+F7 Copy: copying needs permission to create records')
  expect(h.store.screen?.kind).toBe('table')
})

// ---- dispatch ----

test('dispatch on a grid: Shift+F8 export, Shift+F6 saved views, Shift+F4 bulk, Shift+F7 copy, Shift+F5 metadata, Shift+F1 keys', async () => {
  h = await start(120, 40)
  await command(h, 'table query person')
  await waitFor(h, (f) => f.includes('First1 '))
  await press(h, () => h!.setup.mockInput.pressKey('F8', { shift: true }))
  expect((h.store.overlays[0] as unknown as { title: string }).title).toBe('Export to a file')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await press(h, () => h!.setup.mockInput.pressKey('F6', { shift: true }))
  await waitFor(h, (f) => f.includes('Saved views'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  h.store.overlays = []
  await raw(`${E}[1;2S`) // Shift+F4
  const bulk = h.store.overlays[0] as unknown as { title?: string } | undefined
  if (bulk) expect(bulk.title).toContain('Run on')
  else expect(h.store.flashText?.text).toContain('Shift+F4 Bulk')
  h.store.overlays = []
  // with permission to create records, Shift+F7 copies the row under the cursor into a new-record form
  const meta = (h.store.screen as unknown as { meta: { capabilities: string[] } }).meta
  meta.capabilities = [...meta.capabilities, 'TABLE_INSERT']
  await press(h, () => h!.setup.mockInput.pressKey('F7', { shift: true }))
  await waitFor(h, () => h!.store.screen?.kind === 'form')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, () => h!.store.screen?.kind === 'table')
  const before = h.log.requests.filter((r) => r.path === '/metaData').length
  await press(h, () => h!.setup.mockInput.pressKey('F5', { shift: true }))
  await waitFor(h, () => h!.store.flashText?.text === 'metadata refreshed')
  expect(h.log.requests.filter((r) => r.path === '/metaData').length).toBe(before + 1)
  await raw(`${E}[1;2P`) // Shift+F1
  expect(h.store.overlays[0]!.constructor.name).toBe('HelpOverlay')
})

test('plain F-keys are unchanged; Ctrl+F5 still refreshes like F5; Shift+F11 does nothing', async () => {
  h = await start(120, 40)
  await raw(`${E}OQ`) // F2
  expect(h.store.screen?.kind).toBe('search')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await press(h, () => h!.setup.mockInput.pressKey('F11', { shift: true }))
  expect(h.store.flashText?.text).toContain('Shift+F11 does nothing')
  await press(h, () => h!.setup.mockInput.pressKey('F5', { ctrl: true }))
  expect(h.store.overlays.length).toBe(0)
})

test('the rewrite on the terminal input: Shift+F3 (CSI 1;2R) opens the SQL Runner; legacy CSI 26~ is Shift+F2', async () => {
  const log: FakeLog = { requests: [] }
  h = await start(120, 40, undefined, sqlFakeFetch(log, true, { executions: [], notebooks: [], rowsCalls: [] }))
  let now = 0
  const rewrite = installFKeyRewrite(h.setup.renderer.stdin, 'vt220', () => now)
  // during the startup probe CSI 1;2R is a cursor report: nothing happens
  await raw(`${E}[1;2R`)
  expect(h.store.screen?.kind).toBe('home')
  // past it, the same bytes are Shift+F3
  now += CPR_QUIET_MS
  try {
    expect(shiftSlots(h.store).find((s) => s.n === 3)!.why).toBeUndefined()
    await raw(`${E}[1;2R`)
    await waitFor(h, () => h!.store.screen instanceof SqlRunnerScreen)
    await press(h, () => h!.setup.mockInput.pressEscape())
    h.store.overlays = []
    await raw(`${E}[26~`)
    expect(h.store.overlays[0]!.constructor.name).toBe('ServersOverlay')
  } finally {
    rewrite.dispose()
  }
})

test('Shift+F10 toggles the Assistant (the same named action as Ctrl+G)', async () => {
  h = await start(120, 40, undefined, assistantFetch())
  await press(h, () => h!.setup.mockInput.pressKey('F10', { shift: true }))
  expect(h.store.assistantOpen).toBe(true)
  expect(h.store.focus).toBe('assistant')
  // the panel has the focus: the same key goes on toggling (Shift+F keys are global)
  await press(h, () => h!.setup.mockInput.pressKey('F10', { shift: true }))
  expect(h.store.focus === 'content' || !h.store.assistantOpen).toBe(true)
})

// ---- the mouse ----

test('mouse: a click on the Shift row runs that key; in one-row mode while the Shift row shows, too', async () => {
  h = await start(120, 40)
  const y = 39
  const shiftLine = last(h.frame())[0]!
  const x = shiftLine.indexOf('2Servers') + 2
  // the Shift row has as many slots as the primary row (12 from 120 columns)
  expect(fkeyAt(x, 120, h.store.fkeys().map((k) => k.n))).toBe(2)
  await press(h, () => h!.setup.mockMouse.click(x, y))
  expect(h.store.overlays[0]!.constructor.name).toBe('ServersOverlay')
  await press(h, () => h!.setup.mockInput.pressEscape())
  h.store.overlays = []
  // the primary row above still presses F1
  await press(h, () => h!.setup.mockMouse.click(3, y - 1))
  expect(h.store.overlays[0]!.constructor.name).toBe('HelpOverlay')
  await press(h, () => h!.setup.mockInput.pressEscape())
  h.store.overlays = []
  h.store.showShiftRow()
  const f = await mode('one')
  const row = last(f)[0]!
  expect(row).toStartWith('⇧1Keys')
  await press(h, () => h!.setup.mockMouse.click(row.indexOf('9History') + 2, 39))
  await waitFor(h, () => h!.store.screen?.kind === 'history')
})

// ---- help and settings ----

test('? lists the Shift bank; :fkeys and Settings › F-key bar switch and save the mode', async () => {
  h = await start(120, 40)
  h.store.commands().help()
  const help = h.store.overlays[0] as unknown as { after: Array<{ title: string; keys: Array<[string, string]> }> }
  expect(help.after[0]!.title).toStartWith('Shift bank')
  expect(help.after[0]!.keys.map(([k]) => k)).toEqual(SHIFT_BANK.map((k) => `Shift+F${k.n}`))
  expect(help.after[0]!.keys[2]![1]).toContain('not here')
  h.store.overlays = []
  await command(h, 'fkeys one')
  expect(h.store.settings.fkeyBar).toBe('one')
  expect(readConfig().ui?.fkeyBar).toBe('one')
  const f = await press(h, () => undefined)
  expect(f).not.toContain('⇧1Keys')
  await command(h, 'fkeys sideways')
  expect(h.store.flashText?.text).toContain('fkeys one|two|auto')
  const entry = (h.store.commandsImpl!(h.store) as unknown as { entries(t: string): Array<{ id?: string; label: string; run?: () => void }> }).entries('').find((e) => e.id === 'settings:fkeys')
  expect(entry?.label).toBe('F-key bar: one')
  entry!.run!()
  expect((h.store.overlays[0] as unknown as { title: string }).title).toBe('F-key bar')
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(h.store.overlays.length).toBe(0)
  // (the : line keeps a failed command for editing, so this one runs directly)
  await press(h, () => h!.store.commands().run('fkeys auto'))
  expect(readConfig().ui?.fkeyBar).toBe('auto')
})
