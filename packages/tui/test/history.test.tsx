/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { clearActivity, readActivity, type ActivityEntry } from '@qrun-io/qqq-core'
import { commandEvent, history, queryCommand, redactFilter } from '../src/history/record'
import { ReverseSearch } from '../src/history/reverse-search'
import { historyLine, matchesFilter, type HistoryScreen } from '../src/history/screen'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined

beforeAll(() => isolate())
beforeEach(() => {
  clearActivity({ profile: 'fake' })
  history.reset()
})
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const key = (name: string, extra: { ctrl?: boolean; sequence?: string } = {}) => ({ name, sequence: extra.sequence ?? (name.length === 1 ? name : ''), ctrl: extra.ctrl ?? false, meta: false, shift: false })

test('a : line is a CLI command (qqq …, with its kind) or a TUI command (:…)', () => {
  expect(commandEvent('table query person -w "lastName = S"')).toEqual({ kind: 'query', summary: ':table query person -w "lastName = S"', command: 'qqq table query person -w "lastName = S"' })
  expect(commandEvent(':theme light')).toEqual({ kind: 'command', summary: ':theme light', command: ':theme light' })
  expect(commandEvent('apps').kind).toBe('command')
})

test('filter values on password fields are redacted in the CLI equivalent', () => {
  const type = (n: string) => (n === 'code' ? 'PASSWORD' : 'STRING')
  const filter = { criteria: [{ fieldName: 'lastName', operator: 'EQUALS', values: ['S'] }, { fieldName: 'code', operator: 'EQUALS', values: ['1234'] }, { fieldName: 'apiToken', operator: 'EQUALS', values: ['t'] }], booleanOperator: 'AND' as const }
  expect(redactFilter(filter as never, type).criteria.map((c) => c.values)).toEqual([['S'], ['***'], ['***']])
  const cmd = queryCommand('person', filter as never, type, { field: 'id', asc: false })
  expect(cmd).toContain('qqq table query person -g')
  expect(cmd).not.toContain('1234')
  expect(cmd).toEndWith('--order -id')
})

test('a history line fits its width and the filter matches summary, command, kind and client', () => {
  const e: ActivityEntry = { n: 12, at: new Date().toISOString(), profile: 'p', client: 'ui', kind: 'open', summary: 'Opened Person 3 "Ada Lovelace" '.repeat(5), command: 'qqq table get person 3' }
  for (const w of [40, 78, 98, 140]) expect(Bun.stringWidth(historyLine(e, w, { numberWidth: 3 }))).toBe(w)
  expect(historyLine(e, 120)).toContain('open')
  expect(historyLine(e, 78)).not.toContain(' open ')
  expect(matchesFilter(e, 'person ada')).toBe(true)
  expect(matchesFilter(e, 'table get')).toBe(true)
  expect(matchesFilter(e, 'ui')).toBe(true)
  expect(matchesFilter(e, 'pet')).toBe(false)
})

test('Ctrl+R: typing narrows, Ctrl+R goes older, Enter runs, Esc edits, Ctrl+G cancels', () => {
  const lines = ['table get person 3', 'theme light', 'table query person', 'apps']
  const r = new ReverseSearch(() => lines)
  for (const ch of 'per') expect(r.handle(key(ch))).toBeUndefined()
  expect(r.current()).toBe('table get person 3')
  expect(r.prompt()).toBe("(reverse-i-search 1/2)'per': table get person 3")
  r.handle(key('r', { ctrl: true }))
  expect(r.current()).toBe('table query person')
  r.handle(key('r', { ctrl: true }))
  expect(r.current()).toBe('table query person')
  r.handle(key('down'))
  expect(r.current()).toBe('table get person 3')
  expect(r.handle(key('return'))).toBe('run')
  expect(r.handle(key('escape'))).toBe('edit')
  expect(r.handle(key('g', { ctrl: true }))).toBe('cancel')
  const none = new ReverseSearch(() => lines)
  for (const ch of 'zzz') none.handle(key(ch))
  expect(none.prompt()).toContain('(no match)')
  expect(none.handle(key('return'))).toBe('cancel')
})

test('the TUI records what you do; :history lists it at 80x24, filters, opens, copies and clears', async () => {
  h = await startTui(100, 30)
  await press(h, () => h!.setup.resize(80, 24))
  await command(h, 'table query person -w "lastName = Odd"')
  await waitFor(h, (f) => f.includes('records') && h!.store.screen?.kind === 'table')
  await command(h, 'table get person 3')
  await waitFor(h, () => h!.store.screen?.kind === 'record')
  await command(h, 'theme light')
  const entries = readActivity({ profile: 'fake' })
  expect(entries.map((e) => [e.client, e.kind, e.summary])).toEqual([
    ['ui', 'auth', 'Signed in to http://fake.test as Tester (mock session)'],
    ['ui', 'query', ':table query person -w "lastName = Odd"'],
    ['ui', 'command', ':table get person 3'],
    ['ui', 'command', ':theme light'],
  ])
  expect(entries[2]!.command).toBe('qqq table get person 3')
  expect(entries.every((e) => e.profile === 'fake' && e.server === 'http://fake.test')).toBe(true)

  await command(h, 'history')
  let f = await waitFor(h, (x) => x.includes('History · fake'))
  const screen = h.store.screen as HistoryScreen
  expect(screen.kind).toBe('history')
  // newest at the bottom, the cursor on it; nothing wider than the terminal
  expect(f).toContain(':theme light')
  expect(f).toContain(':table get person 3')
  expect(f).toContain(' 5  now       ui   :history')
  expect(f.split('\n').every((line) => Bun.stringWidth(line) <= 80)).toBe(true)
  expect(screen.list.cursor).toBe(screen.list.rows.length - 1)
  // the :history line itself is recorded too
  expect(readActivity({ profile: 'fake' }).at(-1)!.summary).toBe(':history')

  // typing filters
  await press(h, () => h!.setup.mockInput.typeText('person'))
  f = await waitFor(h, (x) => x.includes('filter: person_'))
  expect(f).toContain('(2 of 5)')
  expect(f).not.toContain(':theme light')
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.BACKSPACE))
  expect(screen.filter).toBe('perso')
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(screen.filter).toBe('')

  // y copies the CLI equivalent of the entry under the cursor
  const copied: string[] = []
  h.store.copyText = (t) => { copied.push(t); return 'pbcopy' }
  await press(h, () => h!.setup.mockInput.pressArrow('up'))
  await press(h, () => h!.setup.mockInput.pressArrow('up'))
  f = await press(h, () => h!.setup.mockInput.typeText('y'))
  expect(f).toContain(' qqq table get person 3   fake.test')
  expect(copied).toEqual(['qqq table get person 3'])

  // Enter opens the record again
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, () => h!.store.screen?.kind === 'record')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, () => h!.store.screen?.kind === 'history')

  // c clears after asking
  await press(h, () => h!.setup.mockInput.typeText('c'))
  f = await waitFor(h, (x) => /Clear \d+ history entries of profile fake\?/.test(x))
  await press(h, () => h!.setup.mockInput.typeText('y'))
  f = await waitFor(h, (x) => x.includes('no history yet'))
  expect(readActivity({ profile: 'fake' })).toEqual([])
})

test('F9 → Work → History, and Ctrl+R on the : line searches the activity log', async () => {
  h = await startTui(100, 30)
  await command(h, 'table get person 3')
  await waitFor(h, () => h!.store.screen?.kind === 'record')
  await press(h, () => h!.setup.mockInput.pressEscape())
  const entry = h.store.commands() as unknown as { entries: (t: string) => Array<{ section: string; label: string; command?: string; run?: () => void }> }
  const historyEntry = entry.entries('').find((e) => e.section === 'Work' && e.label === 'History')!
  expect(historyEntry.command).toBe('history')
  await press(h, () => historyEntry.run!())
  await waitFor(h, (x) => x.includes('History · fake'))
  await press(h, () => h!.setup.mockInput.pressEscape())

  // Ctrl+R on the : line finds the record command, Enter runs it
  await press(h, () => h!.setup.mockInput.typeText(':'))
  await press(h, () => h!.setup.mockInput.pressKey('r', { ctrl: true }))
  await press(h, () => h!.setup.mockInput.typeText('get pers'))
  const f = await waitFor(h, (x) => x.includes("(reverse-i-search)'get pers': table get person 3"))
  expect(f).toContain('Ctrl+R older')
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, () => h!.store.screen?.kind === 'record')
})
