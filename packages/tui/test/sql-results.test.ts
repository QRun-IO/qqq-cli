/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { ResultPager, barLines, fullValueText, numericColumns, planLineText, planLines, sqlColumns, valueText, type SqlColumn } from '../src/sql/results'

const cols: SqlColumn[] = [{ name: 'ID', kind: 'number' }, { name: 'NAME', kind: 'string' }]
const ALL = Array.from({ length: 250 }, (_, i) => [i + 1, `n${String(250 - i).padStart(3, '0')}`])

function fakeRows(calls: Array<{ offset: number; limit: number; sort?: string }>) {
  return async (offset: number, limit: number, sort?: { column: number; dir: 'asc' | 'desc' }) => {
    calls.push({ offset, limit, sort: sort ? `${sort.column}:${sort.dir}` : undefined })
    const rows = [...ALL]
    if (sort) rows.sort((a, b) => (a[sort.column]! < b[sort.column]! ? -1 : 1) * (sort.dir === 'asc' ? 1 : -1))
    return { rows: rows.slice(offset, offset + limit), rowCount: ALL.length }
  }
}

test('paging: the first chunk from execute, later chunks on demand, each once', async () => {
  const calls: Array<{ offset: number; limit: number; sort?: string }> = []
  const p = new ResultPager({ executionUuid: 'u', status: 'SUCCEEDED', columns: cols, rows: ALL.slice(0, 100), rowCount: 250 }, fakeRows(calls), 100)
  expect(p.total).toBe(250)
  expect(p.has(0, 100)).toBe(true)
  expect(p.has(90, 20)).toBe(false)
  expect(p.window(98, 4).map((r) => r?.[0])).toEqual([99, 100, undefined, undefined])
  await p.ensure(90, 20)
  expect(calls).toEqual([{ offset: 100, limit: 100, sort: undefined }])
  expect(p.get(150)?.[0]).toBe(151)
  await p.ensure(120, 200)
  expect(calls.map((c) => c.offset)).toEqual([100, 200])
  expect(p.window(248, 10).map((r) => r?.[0])).toEqual([249, 250])
  await p.ensure(0, 250)
  expect(calls.length).toBe(2)
})

test('sorting: the server sorts; asc, desc, then the result order, from the first row again', async () => {
  const calls: Array<{ offset: number; limit: number; sort?: string }> = []
  const p = new ResultPager({ executionUuid: 'u', status: 'SUCCEEDED', columns: cols, rows: ALL.slice(0, 100), rowCount: 250 }, fakeRows(calls), 100)
  await p.sortBy(1)
  expect(p.sort).toEqual({ column: 1, dir: 'asc' })
  expect(p.get(0)).toEqual([250, 'n001'])
  expect(p.has(100, 1)).toBe(false)
  await p.sortBy(1)
  expect(p.get(0)).toEqual([1, 'n250'])
  await p.sortBy(1)
  expect(p.sort).toBeUndefined()
  await p.sortBy(0)
  expect(calls.map((c) => c.sort)).toEqual(['1:asc', '1:desc', undefined, '0:asc'])
})

test('paging: a failed chunk keeps the error and can be loaded again', async () => {
  let fail = true
  const p = new ResultPager({ executionUuid: 'u', status: 'SUCCEEDED', columns: cols, rows: [], rowCount: 10 }, async () => {
    if (fail) throw new Error('result expired')
    return { rows: [[1, 'a']], rowCount: 10 }
  }, 100)
  await p.ensure(0, 5)
  expect(p.error).toBe('result expired')
  fail = false
  await p.ensure(0, 5)
  expect(p.error).toBeUndefined()
  expect(p.get(0)).toEqual([1, 'a'])
})

test('values by kind: NULL, binary, JSON, line breaks; whole values pretty', () => {
  expect(valueText(null)).toBe('NULL')
  expect(valueText({ $binary: true, length: 40, hexPreview: 'ff' })).toBe('<binary 40 bytes>')
  expect(valueText('{"a": 1}', 'json')).toBe('{"a":1}')
  expect(valueText([1, 2], 'array')).toBe('[1,2]')
  expect(valueText('a\nb', 'string')).toBe('a b')
  expect(valueText(true, 'boolean')).toBe('true')
  expect(fullValueText('{"a":1}', 'json')).toBe('{\n  "a": 1\n}')
  expect(fullValueText({ $binary: true, length: 3, hexPreview: '0a0b0c' })).toBe('binary, 3 bytes\nfirst bytes: 0x0a0b0c')
})

test('column widths from kinds: capped per kind, numbers right-aligned, spare width to cut text', () => {
  const columns: SqlColumn[] = [{ name: 'ID', kind: 'number' }, { name: 'OK', kind: 'boolean' }, { name: 'D', kind: 'date' }, { name: 'TXT', kind: 'string' }]
  const rows = [[123456789012345678901234, true, '2026-11-01', 'x'.repeat(80)]]
  const narrow = sqlColumns(columns, rows, 60)
  expect(narrow.map((c) => c.width)).toEqual([20, 4, 10, 40])
  expect(narrow.map((c) => c.numeric)).toEqual([true, false, false, false])
  const wide = sqlColumns(columns, rows, 200)
  expect(wide[3]!.width).toBe(60)
  expect(sqlColumns([{ name: 'A_LONG_LABEL', kind: 'number' }], [[1]], 80)[0]!.width).toBe(13)
  expect(numericColumns(columns)).toEqual([0])
})

test('plan tree: indented lines, costs and a relative bar, collapsing a subtree', () => {
  const plan = { label: 'Limit', totalCost: 12.4, startupCost: 0, planRows: 100, children: [
    { label: 'Sort', totalCost: 10.3, startupCost: 10.1, planRows: 412, children: [{ label: 'Seq Scan', detail: 'web_user', totalCost: 7.1, planRows: 9120, actualTimeMs: 1.25, loops: 3 }] },
    { label: 'Filter', detail: null, children: [] },
  ] }
  const lines = planLines(plan)
  expect(lines.map((l) => `${l.depth}:${l.label}`)).toEqual(['0:Limit', '1:Sort', '2:Seq Scan web_user', '1:Filter'])
  expect(lines[0]!.stats).toBe('cost 0..12.40 · rows 100')
  expect(lines[2]!.stats).toBe('cost 7.10 · rows 9,120 · 1.25 ms × 3')
  expect(lines[0]!.share).toBe(1)
  expect(lines[3]!.share).toBeUndefined()
  const g = { open: '▾', closed: '▸', bar: '█' }
  const text = planLineText(lines[1]!, 60, g)
  expect(text.length).toBe(60)
  expect(text.startsWith('  ▾ Sort')).toBe(true)
  expect(text.endsWith('cost 10.10..10.30 · rows 412 ████ ')).toBe(true)
  expect(planLineText(lines[3]!, 60, g)).toBe('    Filter')
  const folded = planLines(plan, new Set(['0.0']))
  expect(folded.map((l) => l.label)).toEqual(['Limit', 'Sort', 'Filter'])
  expect(planLineText(folded[1]!, 20, g)).toBe('  ▸ Sort')
  // H2: a text plan with no costs is a plain indented tree
  expect(planLines({ label: 'Plan', children: [{ label: 'SELECT', children: [{ label: 'X' }] }] }).map((l) => planLineText(l, 30, g))).toEqual(['▾ Plan', '  ▾ SELECT', '      X'])
})

test('quick chart bars: scaled to the largest value, labels cut, negatives marked', () => {
  const lines = barLines([{ label: 'North', value: 10 }, { label: 'South region long name', value: 5 }, { label: 'West', value: -2.5 }], 40)
  expect(lines.every((l) => l.length === 40)).toBe(true)
  expect(lines[0]).toMatch(/^North\s+█+ +10$/)
  expect((lines[0]!.match(/█/g) ?? []).length).toBe(2 * (lines[1]!.match(/█/g) ?? []).length)
  expect(lines[1]!.startsWith('South region')).toBe(true)
  expect(lines[2]).toMatch(/-█+ +-2\.50$/)
  expect(barLines([], 40)).toEqual([])
})
