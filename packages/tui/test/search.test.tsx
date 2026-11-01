/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { SearchModel, type Hit, type SearchDeps } from '../src/search-model'
import { QUICK_SEARCH, fakeExtensions } from './fake-collab'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

type J = Record<string, unknown>

const RESPONSE: J = {
  results: [
    { recordId: '1', tableName: 'customer', tableLabel: 'Customer', recordLabel: 'Ada Lovelace', highlights: [{ text: 'ada@example.test', fieldLabel: 'Email' }] },
    { recordId: '2', tableName: 'customer', tableLabel: 'Customer', recordLabel: 'Adam Smith', highlights: [] },
    { recordId: '9', tableName: 'order', tableLabel: 'Order', recordLabel: 'ORD-9', highlights: [{ text: 'for Ada', fieldLabel: 'Notes' }] },
  ],
  tables: [{ tableName: 'customer', tableLabel: 'Customer', totalCount: 2 }, { tableName: 'order', tableLabel: 'Order', totalCount: 5, hasMore: true }],
  provider: { status: 'OK' },
}

function deps(over: Partial<SearchDeps> = {}): SearchDeps & { calls: Array<{ text: string; tables?: string[]; limit: number }>; saved: string[] } {
  const calls: Array<{ text: string; tables?: string[]; limit: number }> = []
  const saved: string[] = ['ada', 'grace', 'ada']
  return {
    quick: true,
    calls,
    saved,
    searchRecords: async (text, tables, limit) => { calls.push({ text, tables, limit }); return RESPONSE },
    status: async () => ({ state: 'OK', indexes: [{ tableName: 'customer', enabled: true, documentCount: 1200 }, { tableName: 'order', enabled: true, documentCount: 34 }], lastSuccessfulSync: '2026-11-01T10:12:00Z' }),
    names: () => [],
    history: { entries: () => [...saved].reverse(), add: (t) => saved.push(t) },
    now: (() => { let t = 0; return () => (t += 21) })(),
    ...over,
  }
}

test('search model: groups by table with counts, cursor moves, ←→ cycle the table groups, marks and the grid keys', async () => {
  const d = deps()
  const m = new SearchModel(d)
  await m.loadStatus()
  expect(m.placeholder()).toBe('search records across 2 tables (quick search)')
  m.text = 'ada'
  await m.run()
  expect(d.calls).toEqual([{ text: 'ada', tables: undefined, limit: 10 }])
  expect(m.groups.map((g) => `${g.label}:${g.total}:${g.hits.length}`)).toEqual(['Customer:2:2', 'Order:5:1'])
  expect(m.statusLine(() => '10:12')).toBe('7 matches in 2 tables · 21 ms · index 1,234 records · last reindex 10:12')
  expect(m.current()!.hit.label).toBe('Ada Lovelace')
  m.cycleGroup(1)
  expect(m.current()!.hit.key).toBe('9')
  m.cycleGroup(1)
  expect(m.current()!.hit.key).toBe('1')
  m.cycleGroup(-1)
  expect(m.current()!.hit.key).toBe('9')
  m.cursor = 0
  expect(m.keysForGrid(0)).toEqual(['1', '2'])
  m.toggleMark()
  expect(m.keysForGrid(0)).toEqual(['1'])
  expect([...m.markedByTable()]).toEqual([['customer', ['1']]])
  // narrowed to one table: that table only, more per table
  m.table = 'order'
  await m.run()
  expect(d.calls.at(-1)).toEqual({ text: 'ada', tables: ['order'], limit: 50 })
})

test('search model: field:value searches the value with a note; recent searches are distinct, newest first', async () => {
  const d = deps()
  const m = new SearchModel(d)
  m.text = 'email:ada'
  await m.run()
  expect(d.calls.at(-1)!.text).toBe('ada')
  expect(m.notes).toEqual(['email:ada is not a field search: searched for ada in every field'])
  expect(m.recent()).toEqual(['ada', 'grace'])
  m.remember()
  expect(m.recent()[0]).toBe('email:ada')
})

test('search model without quick search: names and the context table\'s records; the status says names only', async () => {
  const names: Hit[] = [{ table: ':table', tableLabel: 'table', key: 'person', label: 'Person', highlights: [], target: { kind: 'table', name: 'person' } }, { table: ':app', tableLabel: 'app', key: 'people', label: 'People', highlights: [], target: { kind: 'app', name: 'people' } }]
  const m = new SearchModel(deps({
    quick: false,
    names: () => names,
    contextRecords: async () => ({ table: 'person', label: 'Person (records of this table)', total: 1, hasMore: false, hits: [{ table: 'person', tableLabel: 'Person', key: '3', label: 'Pat Person', highlights: [] }] }),
  }))
  expect(m.placeholder()).toContain('by name')
  m.text = 'pe'
  await m.run()
  expect(m.groups.map((g) => g.label)).toEqual(['Person (records of this table)', 'Tables', 'Apps'])
  expect(m.statusLine()).toBe('3 matches · quick search not installed: searching names only')
  m.cursor = 1
  m.toggleMark()
  expect(m.marked.size).toBe(0)
})

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
  fakeExtensions.length = 0
})
const key = (k: string) => press(h!, () => h!.setup.mockInput.pressKey(k))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))

test('F2 is Search everywhere; Home has the search line and typing starts a search; Enter opens the record and Esc comes back to the hit', async () => {
  fakeExtensions.push(QUICK_SEARCH)
  h = await startTui(120, 36)
  let f = await waitFor(h, (x) => x.includes('across 2 tables (quick search)'))
  expect(f).toContain(' Search: ')
  expect(f).toContain('2Search')
  await type('ad')
  expect(h.store.screen?.kind).toBe('search')
  await type('a')
  f = await waitFor(h, (x) => x.includes('Person · 1 match'))
  expect(f).toContain('Ada Lovelace')
  expect(f).toContain('#1')
  expect(f).toContain('Name: Ada Lovelace')
  expect(f).toContain('1 match in 1 table')
  expect(f).toContain('index 32 records')
  await press(h, () => h!.setup.mockInput.pressEnter())
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => h!.store.screen?.kind === 'record' && x.includes('First1'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  f = await waitFor(h, (x) => h!.store.screen?.kind === 'search' && x.includes('Ada Lovelace'))
  // from a grid, F2 opens Search too; :search <text> fills it
  await press(h, () => h!.setup.mockInput.pressEscape())
  await waitFor(h, () => h!.store.screen?.kind === 'home')
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('First Name'))
  await key(KeyCodes.F2)
  expect(h.store.screen?.kind).toBe('search')
  await press(h, () => h!.setup.mockInput.pressEscape())
  await command(h, 'search ada')
  f = await waitFor(h, (x) => x.includes('Person · 1 match'))
  // o: the table's grid filtered to the hits
  await press(h, () => h!.setup.mockInput.pressEnter())
  await type('o')
  await waitFor(h, (x) => h!.store.screen?.kind === 'table' && x.includes('id IN 1'))
})

test('without quick search F2 still searches: names and the records of the table it came from', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('First Name'))
  await key(KeyCodes.F2)
  let f = await type('first1')
  f = await waitFor(h, (x) => x.includes('Person (records of this table)'))
  expect(f).toContain('quick search not installed: searching names only')
  expect(f).toContain('First Name: First1')
})

test('search model: an older, slower search does not overwrite the newer one (results or provider state)', async () => {
  let release: (v: J) => void = () => undefined
  const slow = new Promise<J>((r) => { release = r })
  const d = deps({ searchRecords: async (text) => (text === 'a' ? slow : RESPONSE) })
  const m = new SearchModel(d)
  m.text = 'a'
  const first = m.run()
  m.text = 'ada'
  await m.run()
  release({ results: [], provider: { status: 'NONE' } })
  await first
  expect(m.provider).toBe('OK')
  expect(m.total).toBe(7)
})
