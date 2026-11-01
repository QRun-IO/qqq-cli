/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The shared date control: typed entry in the display format, the calendar picker, forms, bulk and the filter cell. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import { localToUtc, nowIn, readDateSettings, resolveDateSettings } from '@qrun-io/qqq-core'
import { DateEditor } from '../src/controls/date-editor'
import { DatePickerOverlay, DatePromptOverlay, wrapItems } from '../src/controls/date-picker'
import { datesCommand } from '../src/controls/date-settings'
import type { Key } from '../src/keys'
import type { AppStore } from '../src/store'
import { setAscii } from '../src/theme'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
  setAscii(false)
})

const k = (name: string, extra: Partial<Key> = {}): Key => ({ name, sequence: name.length === 1 ? name : '', ...extra })
const iso = resolveDateSettings({})
const us = resolveDateSettings({ order: 'MDY', clock: '12h', weekStart: 'sunday' })

/** A store that records the overlays opened and closed. */
function fakeStore() {
  const open: unknown[] = []
  const store = {
    target: { name: 'fake', server: 'http://fake.test' },
    open: (o: unknown) => open.push(o),
    closeOverlay: (o: unknown) => { const i = open.indexOf(o); if (i >= 0) open.splice(i, 1) },
    bump: () => undefined,
    flash: () => undefined,
  }
  return { store: store as unknown as AppStore, open }
}

test('the editor shows the stored value in the display format and reads typed text leniently', () => {
  const ed = new DateEditor('2026-03-05', { kind: 'DATE', settings: us, nullable: true, timeZone: 'UTC' })
  expect(ed.value).toBe('03/05/2026')
  expect(ed.storedText()).toBe('2026-03-05')
  expect(ed.hint()).toBe('MM/DD/YYYY')
  ed.set('')
  ed.insert('3/9')
  expect(ed.resolve()).toMatchObject({ ok: true, value: `${nowIn('UTC').year}-03-09` })
  ed.set('')
  ed.insert('2026-02-30')
  expect(ed.resolve()).toEqual({ ok: false, reason: 'February 2026 has 28 days' })
  expect(ed.storedText()).toBe('2026-02-30')

  const dt = new DateEditor('2026-03-05T20:30:00Z', { kind: 'DATE_TIME', settings: iso, nullable: true, timeZone: 'America/Chicago' })
  expect(dt.value).toBe('2026-03-05 14:30')
  expect(dt.storedText()).toBe('2026-03-05T14:30:00')
  expect(dt.hint()).toBe('YYYY-MM-DD HH:mm CST')
  const secs = new DateEditor('2026-03-05T14:30:15', { kind: 'DATE_TIME', settings: us, nullable: true, timeZone: 'UTC' })
  expect(secs.value).toBe('03/05/2026 02:30:15 PM')
  expect(secs.withSeconds).toBe(true)
})

test('Backspace on a whole value clears it when the field may be empty; once typing, it deletes a character', () => {
  const ed = new DateEditor('2026-03-05', { kind: 'DATE', settings: iso, nullable: true })
  ed.handle(k('backspace'))
  expect(ed.value).toBe('')
  ed.insert('2026-03-05')
  ed.handle(k('backspace'))
  expect(ed.value).toBe('2026-03-0')
  const required = new DateEditor('2026-03-05', { kind: 'DATE', settings: iso, nullable: false })
  required.handle(k('delete'))
  expect(required.value).toBe('2026-03-05')
  required.handle(k('backspace'))
  expect(required.value).toBe('2026-03-0')
})

test('the picker: arrows move a day or a week, PgUp/PgDn a month, Shift a year, Home/End, t today, Enter accepts', () => {
  const { store, open } = fakeStore()
  let accepted = ''
  const p = new DatePickerOverlay(store, { title: 'Birth Date', kind: 'DATE', settings: iso, timeZone: 'UTC', initial: { year: 2026, month: 1, day: 31, hour: 0, minute: 0, second: 0 }, onAccept: (v) => { accepted = v } })
  open.push(p)
  p.onKey(k('right'))
  expect(p.value()).toBe('2026-02-01')
  p.onKey(k('left'))
  p.onKey(k('pagedown'))
  expect(p.value()).toBe('2026-02-28')
  p.onKey(k('pageup', { shift: true }))
  expect(p.value()).toBe('2025-02-28')
  p.onKey(k('down'))
  expect(p.value()).toBe('2025-03-07')
  p.onKey(k('up'))
  p.onKey(k('up'))
  expect(p.value()).toBe('2025-02-21')
  p.onKey(k('home'))
  expect(p.value()).toBe('2025-02-01')
  p.onKey(k('end'))
  expect(p.value()).toBe('2025-02-28')
  p.onKey(k('t'))
  const today = nowIn('UTC')
  expect(p.value()).toBe(`${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`)
  p.onKey(k('end'))
  p.onKey(k('return'))
  expect(accepted).toMatch(/^\d{4}-\d{2}-(28|29|30|31)$/)
  expect(open).toEqual([])
})

test('the picker time row: Tab between parts, digits and arrows, 12-hour AM/PM, Esc cancels', () => {
  const { store, open } = fakeStore()
  let accepted = ''
  let cancelled = false
  const p = new DatePickerOverlay(store, { title: 'Start', kind: 'DATE_TIME', settings: us, timeZone: 'America/Chicago', initial: { year: 2026, month: 3, day: 5, hour: 9, minute: 0, second: 0 }, onAccept: (v) => { accepted = v }, onCancel: () => { cancelled = true } })
  open.push(p)
  expect(p.parts()).toEqual(['date', 'hour', 'minute', 'ampm'])
  p.onKey(k('tab'))
  expect(p.part).toBe('hour')
  p.onKey(k('2', { sequence: '2' }))
  expect(p.part).toBe('minute')
  p.onKey(k('4', { sequence: '4' }))
  p.onKey(k('5', { sequence: '5' }))
  expect(p.part).toBe('ampm')
  p.onKey(k('p', { sequence: 'p' }))
  expect(p.value()).toBe('2026-03-05T14:45:00')
  p.onKey(k('left'))
  p.onKey(k('up'))
  expect(p.value()).toBe('2026-03-05T14:46:00')
  p.onKey(k('tab', { shift: true }))
  p.onKey(k('down'))
  expect(p.value()).toBe('2026-03-05T13:46:00')
  p.onKey(k('tab', { shift: true }))
  expect(p.part).toBe('date')
  p.onKey(k('return'))
  expect(accepted).toBe('2026-03-05T13:46:00')

  const q = new DatePickerOverlay(store, { title: 'Start', kind: 'DATE_TIME', settings: iso, timeZone: 'UTC', withSeconds: true, initial: { year: 2026, month: 3, day: 5, hour: 9, minute: 0, second: 0 }, onAccept: () => undefined, onCancel: () => { cancelled = true } })
  open.push(q)
  expect(q.parts()).toEqual(['date', 'hour', 'minute', 'second'])
  q.onKey(k('tab'))
  for (const d of '235959') q.onKey(k(d, { sequence: d }))
  expect(q.value()).toBe('2026-03-05T23:59:59')
  expect(q.part).toBe('second')
  q.onKey(k('left'))
  q.onKey(k('left'))
  q.onKey(k('down'))
  expect(q.value()).toBe('2026-03-05T22:59:59')
  q.onKey(k('escape'))
  expect(cancelled).toBe(true)
  expect(open).toEqual([])
})

test('the picker hands a typed character to typed entry, and p to the presets, when its opener allows', () => {
  const { store, open } = fakeStore()
  let typed = ''
  let presets = 0
  const p = new DatePickerOverlay(store, { title: 'D', kind: 'DATE', settings: iso, onAccept: () => undefined, onType: (ch) => { typed = ch }, onPresets: () => { presets++ } })
  open.push(p)
  p.onKey(k('2', { sequence: '2' }))
  expect(typed).toBe('2')
  expect(open).toEqual([])
  const q = new DatePickerOverlay(store, { title: 'D', kind: 'DATE', settings: iso, onAccept: () => undefined, onPresets: () => { presets++ } })
  open.push(q)
  q.onKey(k('p', { sequence: 'p' }))
  expect(presets).toBe(1)
})

/** Renders an overlay alone on a screen of the given size. */
async function renderOverlay(o: { render(w: number, h: number): React.ReactNode }, width: number, height: number): Promise<string> {
  const setup = await testRender(<box width={width} height={height}>{o.render(width, height)}</box>, { width, height })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  setup.renderer.destroy()
  return frame
}

test('the picker fits an 80x24 screen anchored under the field (above when there is no room), week numbers, ASCII', async () => {
  const { store } = fakeStore()
  const p = new DatePickerOverlay(store, { title: 'Order Date', kind: 'DATE_TIME', settings: resolveDateSettings({ weekNumbers: true }), timeZone: 'America/Chicago', serverZone: 'UTC', initial: { year: 2026, month: 3, day: 5, hour: 14, minute: 30, second: 0 }, anchor: { x: 30, y: 4 }, onAccept: () => undefined })
  let f = await renderOverlay(p, 80, 24)
  const lines = f.split('\n')
  const top = lines.findIndex((l) => l.includes('Order Date'))
  expect(top).toBe(5)
  expect(lines[top]!.indexOf('╔')).toBe(30)
  expect(f).toContain('March 2026')
  expect(f).toContain('Wk  Mo Tu We Th Fr Sa Su')
  expect(f).toMatch(/10\s+2\s+3\s+4\s+5\s+6\s+7\s+8/)
  expect(f).toContain('Time 14:30  24-hour')
  expect(f).toContain('Local America/Chicago (CST, UTC-06:00)')
  expect(f).toContain('Sends 2026-03-05T20:30:00Z (UTC)')
  expect(f).toContain('Server UTC')
  expect(lines.filter((l) => l.includes('║')).length + 2).toBeLessThanOrEqual(24)
  const low = new DatePickerOverlay(store, { ...p.options, anchor: { x: 70, y: 20 } })
  f = await renderOverlay(low, 80, 24)
  const lowLines = f.split('\n')
  const lowTop = lowLines.findIndex((l) => l.includes('Order Date'))
  expect(lowTop).toBeLessThan(20)
  expect(lowLines[lowTop]!.indexOf('╔')).toBe(80 - 42)
  setAscii(true)
  f = await renderOverlay(new DatePickerOverlay(store, { title: 'Birth Date', kind: 'DATE', settings: us, onAccept: () => undefined }), 80, 24)
  expect(f).not.toMatch(/[╔║◂▸←→↑↓]/)
  expect(f).toContain('Su Mo Tu We Th Fr Sa')
  expect(f).toMatch(/<\s+\w+ \d{4}\s+>/)
})

test('the bulk prompt reads typed dates, refuses with the reason, and opens the picker on F2', () => {
  const { store, open } = fakeStore()
  let got: string | null | undefined
  const prompt = new DatePromptOverlay(store, 'Ship Date', 'DATE', null, (v) => { got = v })
  open.push(prompt)
  prompt.paste('2026-13-01')
  prompt.onKey(k('return'))
  expect(prompt.error).toBe('month 13 does not exist (1-12)')
  prompt.onKey(k('u', { ctrl: true }))
  prompt.paste('2026-1-9')
  prompt.onKey(k('f2'))
  expect(open.at(-1)).toBeInstanceOf(DatePickerOverlay)
  const picker = open.at(-1) as DatePickerOverlay
  expect(picker.value()).toBe('2026-01-09')
  picker.onKey(k('right'))
  picker.onKey(k('return'))
  expect(prompt.editor.value).toBe('2026-01-10')
  prompt.onKey(k('return'))
  expect(got).toBe('2026-01-10')
  // a DATE_TIME from the bulk editor goes out as the UTC instant, as forms send it
  const dt = new DatePromptOverlay(store, 'Starts', 'DATE_TIME', null, (v) => { got = v }, { utc: true })
  open.push(dt)
  dt.paste('2026-3-5 14:30')
  dt.onKey(k('return'))
  expect(got).toBe(localToUtc('2026-03-05T14:30:00'))
  expect(got).toMatch(/Z$/)
})

test('key hints wrap into lines of the popup width', () => {
  expect(wrapItems(['aaa', 'bbb', 'ccc'], 9)).toEqual(['aaa · bbb', 'ccc'])
})

test(':dates saves the order for the profile; the form then shows and takes MM/DD/YYYY', async () => {
  const { store } = fakeStore()
  expect(datesCommand(store, [])).toContain('order ymd')
  expect(() => datesCommand(store, ['order', 'xyz'])).toThrow('usage: :dates')
  expect(datesCommand(store, ['order', 'mdy', 'weeknumbers', 'on'])).toContain('order mdy')
  expect(readDateSettings('fake')).toMatchObject({ order: 'MDY', weekNumbers: true })
  h = await startTui(120, 36)
  await command(h, 'table create person')
  await waitFor(h, (x) => x.includes('New Person'))
  await press(h, () => h!.setup.mockInput.typeText('Ann'))
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressTab())
  let f = await waitFor(h, (x) => x.includes('MM/DD/YYYY'))
  expect(f).toContain('F2/Ctrl+Space calendar')
  await press(h, () => h!.setup.mockInput.typeText('3/5/85'))
  await press(h, () => h!.setup.mockInput.pressTab())
  f = await waitFor(h, (x) => x.includes('03/05/1985'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, () => h!.log.requests.some((r) => r.path === '/table/person' && r.method === 'POST'))
  const insert = h.log.requests.find((r) => r.path === '/table/person' && r.method === 'POST')!
  expect(insert.body).toMatchObject({ firstName: 'Ann', birthDate: '1985-03-05' })
  datesCommand(store, ['order', 'ymd', 'weeknumbers', 'off'])
})

test('a form date field: typed partial input completes, a bad date keeps the focus with the reason, F2 opens the calendar not the palette', async () => {
  h = await startTui(120, 36)
  await press(h, () => h!.setup.resize(80, 24))
  await command(h, 'table create person')
  await waitFor(h, (x) => x.includes('New Person'))
  await press(h, () => h!.setup.mockInput.typeText('Bo'))
  await press(h, () => h!.setup.mockInput.pressTab())
  await press(h, () => h!.setup.mockInput.pressTab())
  await waitFor(h, (x) => x.includes('YYYY-MM-DD'))
  await press(h, () => h!.setup.mockInput.typeText('2026-02-30'))
  await press(h, () => h!.setup.mockInput.pressTab())
  let f = await waitFor(h, (x) => x.includes('! February 2026 has 28 d'))
  expect(h.store.screen && (h.store.screen as unknown as { editor: { current: string } }).editor.current).toBe('birthDate')
  await press(h, () => h!.setup.mockInput.pressKey('u', { ctrl: true }))
  await press(h, () => h!.setup.mockInput.typeText('1990-7-4'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F2))
  f = await waitFor(h, (x) => x.includes('July 1990'))
  expect(f).not.toContain('Go to')
  await press(h, () => h!.setup.mockInput.pressKey('\x1b[6~'))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('1990-08-05') && !x.includes('August 1990'))
  await press(h, () => h!.setup.mockInput.pressKey(' ', { ctrl: true }))
  await waitFor(h, (x) => x.includes('August 1990'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, (x) => !x.includes('August 1990') && x.includes('1990-08-05'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  await waitFor(h, () => h!.log.requests.some((r) => r.path === '/table/person' && r.method === 'POST'))
  expect(h.log.requests.find((r) => r.path === '/table/person' && r.method === 'POST')!.body).toMatchObject({ birthDate: '1990-08-05' })
})

test('the filter value cell: Enter opens the calendar, p the presets; between takes from and to', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F6))
  await waitFor(h, (x) => x.includes('quick     Id'))
  await press(h, () => h!.setup.mockInput.pressKey('n', { ctrl: true }))
  await waitFor(h, (x) => x.includes('Add a condition: which field?'))
  await press(h, () => h!.setup.mockInput.typeText('birth'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Birth Date: type YYYY-MM-DD'))
  await press(h, () => h!.setup.mockInput.typeText('1975-1-1'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  let f = await waitFor(h, (x) => x.includes('birthDate EQUALS 1975-01-01'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('January 1975') && x.includes('p presets'))
  await press(h, () => h!.setup.mockInput.pressArrow('right'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('birthDate EQUALS 1975-01-02'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('January 1975'))
  await press(h, () => h!.setup.mockInput.typeText('p'))
  f = await waitFor(h, (x) => x.includes('Type a date or an expression'))
  await press(h, () => h!.setup.mockInput.typeText('7 days'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('birthDate EQUALS now(-7d)'))
  await press(h, () => h!.setup.mockInput.pressArrow('left'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('which comparison?'))
  await press(h, () => h!.setup.mockInput.typeText('between'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('between: from'))
  await press(h, () => h!.setup.mockInput.typeText('t'))
  await press(h, () => h!.setup.mockInput.pressKey('\x1b[5;2~'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.HOME))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('between: to'))
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.END))
  await press(h, () => h!.setup.mockInput.pressEnter())
  const y = nowIn().year - 1
  const m = String(nowIn().month).padStart(2, '0')
  f = await waitFor(h, (x) => x.includes(`birthDate BETWEEN ${y}-${m}-01,${y}-${m}-`))
})
