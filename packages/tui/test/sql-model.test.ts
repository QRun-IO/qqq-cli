/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import {
  SqlBuffer, SqlHistory, cellSummary, coerceParameter, commonPrefix, complete, errorPosition, extractParameters, markdownLines, moveCell,
  notebookParameters, notebookRequest, referencedTables, scratchNotebook, splitStatements, statementAt, tokenize, tokenLines, type SqlSchema,
} from '../src/sql/model'
import { hideRunnerApps, isRunnerWidget, runnerApps } from '../src/sql/apps'

const key = (name: string, extra: Partial<{ ctrl: boolean; shift: boolean; meta: boolean; sequence: string }> = {}) => ({ name, sequence: extra.sequence ?? (name.length === 1 ? name : ''), ...extra })

test('buffer: typing, new lines with indent, backspace across lines, offsets, word movement', () => {
  const b = new SqlBuffer('')
  for (const ch of 'SELECT 1') b.handle(key(ch === ' ' ? 'space' : ch, { sequence: ch }))
  expect(b.text).toBe('SELECT 1')
  b.insert('\n  FROM t')
  expect(b.lines).toEqual(['SELECT 1', '  FROM t'])
  b.newline()
  expect(b.lines[2]).toBe('  ')
  expect(b.offset()).toBe(b.text.length)
  b.handle(key('backspace'))
  expect(b.lines[2]).toBe('')
  b.handle(key('backspace'))
  expect(b.lines).toEqual(['SELECT 1', '  FROM t'])
  b.setOffset(3)
  expect([b.row, b.col]).toEqual([0, 3])
  b.handle(key('down'))
  expect([b.row, b.col]).toEqual([1, 3])
  b.handle(key('home'))
  expect(b.col).toBe(2)
  b.handle(key('home'))
  expect(b.col).toBe(0)
  b.handle(key('right', { ctrl: true }))
  expect(b.col).toBe(6)
  b.handle(key('end'))
  b.handle(key('w', { ctrl: true }))
  expect(b.line).toBe('  FROM ')
  b.setOffset(0)
  b.handle(key('left'))
  expect(b.offset()).toBe(0)
  b.setOffset(8)
  b.handle(key('delete'))
  expect(b.lines).toEqual(['SELECT 1  FROM '])
  b.replaceBefore(0, 'X')
  expect(b.text.startsWith('SELECT 1X')).toBe(true)
  b.scrollTo(3, 5)
  expect(b.left).toBeGreaterThan(0)
})

test('buffer: the word before the cursor, with a qualifier', () => {
  const b = new SqlBuffer('SELECT c.NA')
  expect(b.wordBefore()).toEqual({ qualifier: 'c', prefix: 'NA', from: 9 })
  b.set('SELECT ')
  expect(b.wordBefore().prefix).toBe('')
})

test('statements: split at ; outside strings, comments and quoted names; the one under the cursor', () => {
  const sql = "SELECT 'a;b' AS x; -- c;\nSELECT \"x;y\" FROM t;\n\n  SELECT 3 /* ; */"
  const all = splitStatements(sql)
  expect(all.map((s) => s.text)).toEqual(["SELECT 'a;b' AS x", '-- c;\nSELECT "x;y" FROM t', 'SELECT 3 /* ; */'])
  expect(statementAt(sql, 3)!.text).toBe("SELECT 'a;b' AS x")
  expect(statementAt(sql, sql.indexOf('FROM'))!.text).toContain('FROM t')
  expect(statementAt(sql, sql.length)!.text).toBe('SELECT 3 /* ; */')
  // the cursor just after a ; belongs to the statement it ends
  expect(statementAt('SELECT 1;\n', 10)!.text).toBe('SELECT 1')
  expect(statementAt('  ;  ', 1)).toBeUndefined()
  expect(statementAt('SELECT 1', 0)!.start).toBe(0)
})

test('parameters: :name in order, not inside strings, comments or :: casts; typed coercion', () => {
  expect(extractParameters("SELECT :a, ':b', x::int, :a, \"c:d\" -- :e\n FROM t WHERE y > :since /* :f */ AND z = $$:g$$")).toEqual(['a', 'since'])
  expect(coerceParameter('', 'INTEGER')).toBeNull()
  expect(coerceParameter('42', 'INTEGER')).toBe(42)
  expect(coerceParameter('x', 'DECIMAL')).toBe('x')
  expect(coerceParameter('yes', 'BOOLEAN')).toBe(true)
  expect(coerceParameter('007')).toBe('007')
})

test('tokens: keywords, strings, numbers, comments and params for the tint; lines split', () => {
  const kinds = tokenize("SELECT name, 1.5e3 FROM t WHERE x = 'it''s' AND y = :p -- note").filter((t) => t.kind !== 'space').map((t) => `${t.kind}:${t.text}`)
  expect(kinds).toEqual(['keyword:SELECT', 'ident:name', 'punct:,', 'number:1.5e3', 'keyword:FROM', 'ident:t', 'keyword:WHERE', 'ident:x', 'punct:=', "string:'it''s'", 'keyword:AND', 'ident:y', 'punct:=', 'param::p', 'comment:-- note'])
  const lines = tokenLines("SELECT /* a\nb */ 1\nFROM t")
  expect(lines.length).toBe(3)
  expect(lines[1]![0]).toMatchObject({ kind: 'comment', text: 'b */' })
  expect(lines[2]![0]).toMatchObject({ kind: 'keyword', text: 'FROM' })
  expect(tokenize('QUALIFY x', new Set(['QUALIFY']))[0]!.kind).toBe('keyword')
})

const schema: SqlSchema = {
  schemas: [{ name: 'PUBLIC', tables: [
    { name: 'CUSTOMER', columns: [{ name: 'ID' }, { name: 'NAME' }, { name: 'EMAIL' }] },
    { name: 'CUSTOMER_NOTE', columns: [{ name: 'ID' }, { name: 'TEXT' }] },
    { name: 'ORDERS', columns: [{ name: 'ID' }, { name: 'CUSTOMER_ID' }, { name: 'STATUS' }] },
  ] }],
  qqqTables: [{ name: 'order', sqlName: 'orders' }],
  keywords: ['SELECT', 'ORDER BY', 'OFFSET'], functions: ['ordinal_fn'],
}

test('completion: tables, columns of the statement\'s tables, alias. columns, keywords in the typed case', () => {
  expect(complete('SELECT * FROM CUST', 18, schema).candidates).toEqual(['CUSTOMER', 'CUSTOMER_NOTE'])
  expect(commonPrefix(['CUSTOMER', 'CUSTOMER_NOTE'])).toBe('CUSTOMER')
  const sql = 'SELECT o.ST FROM ORDERS o JOIN CUSTOMER c ON c.ID = o.CUSTOMER_ID'
  expect(complete(sql, 11, schema)).toEqual({ from: 9, prefix: 'ST', candidates: ['STATUS'] })
  expect(complete('SELECT c. FROM CUSTOMER AS c', 9, schema).candidates).toEqual(['ID', 'NAME', 'EMAIL'])
  // columns of the named tables come first, then tables (QQQ SQL names deduplicated), keywords, functions
  const mixed = complete('SELECT ord FROM ORDERS', 10, schema).candidates
  expect(mixed).toEqual(['ORDERS', 'order', 'ordinal_fn'])
  expect(complete('SELECT e', 8, schema).candidates).toContain('end')
  expect(complete('SELECT ', 7, schema).candidates).toEqual([])
  expect(complete('SELECT CU', 9).candidates).toEqual([])
  expect([...referencedTables('SELECT * FROM PUBLIC.ORDERS o LEFT JOIN "CUSTOMER" WHERE 1=1').entries()]).toEqual([['ORDERS', 'ORDERS'], ['O', 'ORDERS'], ['CUSTOMER', 'CUSTOMER']])
})

test('error positions: H2 [*], an EXPLAIN prefix, PostgreSQL Position, line and column, MySQL line', () => {
  const sql = 'SELECT *\nFRM X'
  expect(errorPosition('Syntax error in SQL statement "SELECT *\nFRM[*] X"; SQL statement:', sql)).toEqual({ offset: 12, line: 2, col: 4 })
  expect(errorPosition('Syntax error in SQL statement "EXPLAIN SELECT * [*]FRM X"; SQL statement:', 'SELECT * FRM X')).toEqual({ offset: 9, line: 1, col: 10 })
  expect(errorPosition('ERROR: syntax error at or near "FRM"\n  Position: 10', 'SELECT * FRM X')).toEqual({ offset: 9, line: 1, col: 10 })
  expect(errorPosition('error at line 3, column 7', 'x')).toEqual({ line: 3, col: 7 })
  expect(errorPosition("You have an error in your SQL syntax near 'FRM' at line 1", 'x')).toEqual({ line: 1 })
  expect(errorPosition('Table "NOPE" not found', 'SELECT * FROM NOPE')).toBeUndefined()
})

test('history: newest first, multi-line SQL kept, Ctrl+↑↓ steps back to the draft', () => {
  const lines: string[] = []
  const h = new SqlHistory({ entries: () => [...lines].reverse(), add: (l) => { lines.push(l) } })
  h.add('SELECT 1')
  h.add('SELECT 2\nFROM t')
  h.add('  ')
  expect(h.entries()).toEqual(['SELECT 2\nFROM t', 'SELECT 1'])
  expect(h.step(1, 'draft')).toBe('SELECT 2\nFROM t')
  expect(h.step(1, 'ignored')).toBe('SELECT 1')
  expect(h.step(1, 'x')).toBeUndefined()
  expect(h.step(-1, 'x')).toBe('SELECT 2\nFROM t')
  expect(h.step(-1, 'x')).toBe('draft')
  expect(h.step(-1, 'x')).toBeUndefined()
})

test('notebooks: scratch, parameters, the save body, moving cells, summaries, markdown as text', () => {
  const nb = scratchNotebook('SELECT * FROM t WHERE a = :a')
  nb.parameters = [{ name: 'limit', type: 'INTEGER', defaultValue: '10' }]
  nb.cells.push({ cellKey: 'k2', cellType: 'MARKDOWN', content: '## Notes\n- one' }, { cellKey: 'k3', cellType: 'SQL', content: 'SELECT :b, :a' })
  expect(notebookParameters(nb)).toEqual(['limit', 'a', 'b'])
  const body = notebookRequest(nb, { a: 'x' }, 'why')
  expect(body.parameters).toEqual([{ name: 'limit', type: 'INTEGER', defaultValue: '10', label: null }, { name: 'a', type: 'STRING', defaultValue: 'x', label: null }, { name: 'b', type: 'STRING', defaultValue: null, label: null }])
  expect((body.cells as Array<{ sortOrder: number; cellKey: string }>).map((c) => `${c.sortOrder}:${c.cellKey}`).slice(1)).toEqual(['1:k2', '2:k3'])
  expect(body.title).toBe('Untitled')
  expect(body.comment).toBe('why')
  expect(moveCell(nb.cells, 2, -1)).toBe(1)
  expect(nb.cells.map((c) => c.cellKey).slice(1)).toEqual(['k3', 'k2'])
  expect(moveCell(nb.cells, 0, -1)).toBe(0)
  expect(cellSummary(nb.cells[2]!)).toBe('Notes')
  expect(cellSummary({ cellKey: 'x', cellType: 'SQL', content: '\n  SELECT 1\n' })).toBe('SELECT 1')
  expect(cellSummary({ cellKey: 'x', cellType: 'SQL', content: '', title: 'Totals' })).toBe('Totals')
  expect(markdownLines('# Title\nSome **bold** and `code` and [a link](http://x)\n- item\n> quoted\n```\nraw *text*\n```')).toEqual([
    { text: 'Title', style: 'heading' }, { text: 'Some bold and code and a link (http://x)', style: 'text' }, { text: '• item', style: 'text' },
    { text: '│ quoted', style: 'quote' }, { text: '  raw *text*', style: 'code' },
  ])
})

test('absent extension: the Runner apps leave the metadata; installed, nothing changes', () => {
  const meta = {
    apps: { sqlWorkbench: { name: 'sqlWorkbench', children: [{ type: 'APP', name: 'sqlWorkbenchRunner' }, { type: 'TABLE', name: 't' }], childMap: { sqlWorkbenchRunner: {}, t: {} } }, sqlWorkbenchRunner: { name: 'sqlWorkbenchRunner', widgets: ['w'] } },
    widgets: { w: { name: 'w', type: 'SQL_WORKBENCH' } },
    appTree: [{ type: 'APP', name: 'sqlWorkbench', children: [{ type: 'APP', name: 'sqlWorkbenchRunner' }, { type: 'TABLE', name: 't' }] }],
  } as never
  expect(runnerApps(meta)).toEqual(['sqlWorkbenchRunner'])
  expect(hideRunnerApps(meta, true)).toBe(meta)
  const hidden = hideRunnerApps(meta, false) as unknown as { apps: Record<string, { children?: unknown[]; childMap?: Record<string, unknown> }>; appTree: Array<{ children: Array<{ name: string }> }> }
  expect(Object.keys(hidden.apps)).toEqual(['sqlWorkbench'])
  expect(hidden.apps.sqlWorkbench!.children).toEqual([{ type: 'TABLE', name: 't' }])
  expect(Object.keys(hidden.apps.sqlWorkbench!.childMap!)).toEqual(['t'])
  expect(hidden.appTree[0]!.children.map((c) => c.name)).toEqual(['t'])
  expect(runnerApps(hidden as never)).toEqual([])
  expect(isRunnerWidget(meta, 'w')).toBe(true)
  expect(isRunnerWidget(hidden as never, 'w')).toBe(false)
})
