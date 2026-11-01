/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { CLIPBOARD_MAX_ROWS, ResultPager, allRows, barLines, dateTimeText, exportChoices, formatCell, fullValueText, groupDigits, numericColumns, planLineText, planLines, rawText, sqlColumns, toDelimited, valueText, type SqlColumn } from '../src/sql/results'
import { CompletionPopup } from '../src/overlays/popup'

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
  expect(narrow.map((c) => c.width)).toEqual([22, 4, 10, 40])
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

test('column order: exactly the server\'s column list, never object-key or alphabetical order', () => {
  // the shape of SELECT * FROM QQQTABLE on the enterprise H2 server: the table's own column order
  const columns: SqlColumn[] = [{ name: 'LABEL', kind: 'string' }, { name: 'CREATEDATE', kind: 'datetime' }, { name: 'MODIFYDATE', kind: 'datetime' }, { name: 'NAME', kind: 'string' }, { name: 'ID', kind: 'number' }]
  const cols = sqlColumns(columns, [['Order', '2026-11-01T11:07:17.049726', '2026-11-01T11:07:17.049790', 'order', 1]], 120)
  expect(cols.map((c) => c.label)).toEqual(['LABEL', 'CREATEDATE', 'MODIFYDATE', 'NAME', 'ID'])
  expect(cols.map((c) => c.name)).toEqual(['0', '1', '2', '3', '4'])
  expect(cols.map((c) => c.numeric)).toEqual([false, false, false, false, true])
  expect(cols[1]!.width).toBe('2026-11-01 11:07:17'.length)
})

test('cell formatting by type: date-times to seconds, grouped numbers right-aligned (not keys), booleans, NULL as a dim dash', () => {
  const col = (name: string, kind: SqlColumn['kind']): SqlColumn => ({ name, kind })
  expect(formatCell('2026-11-01T11:07:17.049726', col('CREATEDATE', 'datetime'))).toEqual({ text: '2026-11-01 11:07:17', right: false })
  expect(dateTimeText('2026-11-01 11:07')).toBe('2026-11-01 11:07')
  expect(dateTimeText('2026-11-01T11:07:00.5')).toBe('2026-11-01 11:07')
  expect(dateTimeText('2026-11-01T16:07:17Z')).toMatch(/^2026-11-0[12] \d{2}:07:17$/)
  // the profile's display format: day order and clock
  expect(formatCell('2026-11-01T14:07:17.049726', col('C', 'datetime'), { order: 'MDY', clock: '12h' }).text).toBe('11/01/2026 02:07:17 PM')
  expect(formatCell('2026-11-01', col('D', 'date'), { order: 'DMY', clock: '24h' }).text).toBe('01/11/2026')
  expect(formatCell(1234567, col('TOTAL', 'number'))).toEqual({ text: '1,234,567', right: true })
  expect(formatCell(1234567, col('CUSTOMER_ID', 'number')).text).toBe('1234567')
  expect(formatCell(1234567, col('ID', 'number')).text).toBe('1234567')
  expect(formatCell(-9876.5, col('amount', 'number')).text).toBe('-9,876.5')
  expect(formatCell('123456789012345678901.25', col('BIG', 'number')).text).toBe('123,456,789,012,345,678,901.25')
  expect(groupDigits('abc')).toBe('abc')
  expect(formatCell(true, col('OK', 'boolean')).text).toBe('true')
  expect(formatCell(null, col('NAME', 'string'))).toEqual({ text: '—', right: false, dim: true })
  expect(formatCell(null, col('N', 'number'))).toMatchObject({ text: '—', right: true, dim: true })
  expect(formatCell('10:11:12.345', col('T', 'time')).text).toBe('10:11:12')
  expect(formatCell('{"a": 1}', col('J', 'json')).text).toBe('{"a":1}')
})

test('copy and export: raw values, TSV and CSV quoting, the dialog\'s choices, every row read', async () => {
  const columns: SqlColumn[] = [{ name: 'ID', kind: 'number' }, { name: 'NOTE', label: 'Note', kind: 'string' }]
  expect(rawText(null)).toBe('')
  expect(rawText({ $binary: true, length: 2 })).toBe('<binary 2 bytes>')
  expect(toDelimited(columns, [[1, 'a\tb\nc'], [2, null]], 'tsv')).toBe('ID\tNote\n1\ta b c\n2\t\n')
  expect(toDelimited(columns, [[1, 'say "hi", ok']], 'csv')).toBe('ID,Note\n1,"say ""hi"", ok"\n')
  expect(toDelimited(columns, [[1, 'x']], 'csv', false)).toBe('1,x\n')
  const small = exportChoices(4, 10000)
  expect(small.map((c) => c.value)).toEqual(['csv', 'tsv', 'xlsx', 'json', 'clipboard'])
  expect(small[0]!.detail).toContain('all 4 rows')
  expect(small.find((c) => c.value === 'clipboard')!.disabled).toBeUndefined()
  const big = exportChoices(CLIPBOARD_MAX_ROWS + 1, 10000)
  expect(big.find((c) => c.value === 'clipboard')!.disabled).toContain('export to a file')
  expect(exportChoices(10000, 10000)[0]!.detail).toContain('10,000-row limit')
  const calls: number[] = []
  const p = new ResultPager({ executionUuid: 'u', status: 'SUCCEEDED', columns, rows: ALL.slice(0, 100), rowCount: 250 }, async (offset, limit) => { calls.push(offset); return { rows: ALL.slice(offset, offset + limit), rowCount: 250 } }, 100)
  const rows = await allRows(p)
  expect(rows.length).toBe(250)
  expect(rows[249]![0]).toBe(250)
  expect(calls.sort((a, b) => a - b)).toEqual([100, 200])
})

test('completion popup: filters by prefix then substring, moves, inserts, closes; lines fit the width', () => {
  const p = new CompletionPopup([{ value: 'CUSTOMER', detail: '3 cols' }, { value: 'ORDERS', detail: '4 cols' }, { value: 'CUSTOMER_NOTE', detail: '2 cols' }, { value: 'NOTES' }])
  expect(p.matches().length).toBe(4)
  p.setFilter('cust')
  expect(p.matches().map((i) => i.value)).toEqual(['CUSTOMER', 'CUSTOMER_NOTE'])
  p.setFilter('note')
  expect(p.matches().map((i) => i.value)).toEqual(['NOTES', 'CUSTOMER_NOTE'])
  expect(p.handle({ name: 'down', sequence: '' })).toBe(true)
  expect(p.selected()!.value).toBe('CUSTOMER_NOTE')
  expect(p.handle({ name: 'return', sequence: '' })).toBe('insert')
  expect(p.handle({ name: 'escape', sequence: '' })).toBe('close')
  expect(p.handle({ name: 'x', sequence: 'x' })).toBe(false)
  p.setFilter('zzz')
  expect(p.handle({ name: 'tab', sequence: '' })).toBe('close')
})

test('popup layout: the width it needs (60 to 120, never past the room), two left-aligned columns, wrapped descriptions', () => {
  const commands = new CompletionPopup([
    { value: 'assistant', detail: 'Assistant (assistant extension, qbit-assistant): QQQ Assistant conversations, profiles, skills, budgets and usage' },
    { value: 'cache', detail: 'The local metadata cache (what completion and listings read)' },
    { value: 'sql', detail: 'SQL Runner (statement to run, open <notebook id>)' },
    { value: 'q' },
  ])
  // wide room: as wide as the longest name and description need, capped at 120
  const wide = commands.layout(158)
  expect(wide.width).toBe(120)
  expect(wide.nameW).toBe('assistant'.length)
  const rows = commands.windowLines(20, wide)
  expect(rows.map((r) => r.lines.length)).toEqual([2, 1, 1, 1])
  expect(rows[1]!.lines[0]).toBe(` cache      ·  The local metadata cache (what completion and listings read)`.padEnd(wide.inner))
  expect(rows.every((r) => r.lines.every((l) => l.length === wide.inner))).toBe(true)
  // the description column starts at the same place on every row (left-aligned, no right-aligned clipping)
  expect(new Set(rows.filter((r) => r.item.detail).map((r) => r.lines[0]!.indexOf('·'))).size).toBe(1)
  // 80 columns: at least 60 wide; a description that does not fit wraps to a second line instead of …
  const narrow = commands.layout(78)
  expect(narrow.width).toBe(78)
  const assistant = CompletionPopup.rowLines(commands.items[0]!, narrow)
  expect(assistant.length).toBe(2)
  expect(assistant[0]!.trimEnd().endsWith('…')).toBe(false)
  expect(assistant[1]!.startsWith(' '.repeat(1 + narrow.nameW + 5))).toBe(true)
  expect(assistant.every((l) => l.length === narrow.inner)).toBe(true)
  // short lists stay at the 60-column minimum; a tiny room wins over the minimum
  expect(new CompletionPopup([{ value: 'ID', detail: 'INTEGER' }]).layout(150).width).toBe(60)
  expect(new CompletionPopup([{ value: 'ID', detail: 'INTEGER' }]).layout(40).width).toBe(40)
  // short descriptions (SQL tables with their column counts): long names are not cut
  const tables = new CompletionPopup([{ value: 'ALERTS_ESCALATION_POLICY_HISTORY_ENTRY', detail: '8 cols' }, { value: 'ID', detail: '40 cols' }])
  const tl = tables.layout(78)
  expect(tl.nameW).toBe('ALERTS_ESCALATION_POLICY_HISTORY_ENTRY'.length)
  expect(CompletionPopup.rowLines(tables.items[0]!, tl)[0]).toContain('ALERTS_ESCALATION_POLICY_HISTORY_ENTRY  ·  8 cols')
  // the window counts lines: two-line rows take two, and the cursor stays visible
  const many = new CompletionPopup(Array.from({ length: 20 }, (_, i) => ({ value: `t${i}`, detail: 'x '.repeat(60).trim() })))
  const lay = many.layout(78)
  expect(many.windowLines(6, lay).length).toBe(3)
  many.cursor = 10
  const win = many.windowLines(6, lay)
  expect(win.some((r) => r.index === 10)).toBe(true)
  expect(win.reduce((a, r) => a + r.lines.length, 0)).toBeLessThanOrEqual(6)
})
