/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { parseOptions } from '../src/commands'
import { LineEditor } from '../src/line-editor'
import { layoutColumns, visibleFrom } from '../src/screens/table'
import { THEMES } from '../src/theme'
import { shellSplit } from '../src/util/text'

const fields = [
  { name: 'id', label: 'Id', type: 'INTEGER' },
  { name: 'email', label: 'Email', type: 'STRING' },
  { name: 'note', label: 'Note', type: 'TEXT' },
]
const rows = [{ values: { id: 1, email: 'a-rather-long-address@example.invalid', note: 'x'.repeat(80) } }]

test('columns start at content width (capped at 40) and truncated ones get the spare width', () => {
  const tight = layoutColumns(fields, rows, 50, {})
  expect(tight.map((c) => c.width)).toEqual([3, 37, 40])
  const wide = layoutColumns(fields, rows, 200, {})
  expect(wide.find((c) => c.name === 'note')!.width).toBe(80)
  expect(layoutColumns(fields, rows, 200, { widths: { note: 12 } }).find((c) => c.name === 'note')!.width).toBe(12)
  expect(visibleFrom(tight, 0, 50).map((c) => c.name)).toEqual(['id', 'email'])
  expect(visibleFrom(tight, 2, 10).map((c) => c.name)).toEqual(['note'])
})

test('the line editor applies a burst of keys in order, from its own state', () => {
  const ed = new LineEditor('')
  for (const ch of 'Morgan') ed.handle({ name: ch, sequence: ch })
  ed.handle({ name: 'left', sequence: '' })
  ed.handle({ name: 'backspace', sequence: '' })
  expect(ed.value).toBe('Morgn')
  ed.handle({ name: 'u', sequence: '', ctrl: true })
  expect([ed.value, ed.cursor]).toEqual(['n', 0])
})

test('command lines split like a shell and options collect repeated values', () => {
  expect(shellSplit('table query person -w "lastName = O\'Neil" -o -id')).toEqual(['table', 'query', 'person', '-w', "lastName = O'Neil", '-o', '-id'])
  expect(parseOptions(['-w', 'a = 1', '-w', 'b = 2', '--or', '-o', 'x'])).toEqual({ w: ['a = 1', 'b = 2'], or: ['true'], o: ['x'] })
  expect(parseOptions(['-w', 'lastName = Sample', '-o', '-id', 'firstName'])).toEqual({ w: ['lastName = Sample'], o: ['-id', 'firstName'] })
})

test('every theme defines every token, and high-contrast has no dark grey text', () => {
  const keys = Object.keys(THEMES['high-contrast']!)
  for (const t of Object.values(THEMES)) expect(Object.keys(t).sort()).toEqual([...keys].sort())
  const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 }
  expect(lum(THEMES['high-contrast']!.dim)).toBeGreaterThan(0.6)
  expect(lum(THEMES.classic!.dim)).toBeGreaterThan(0.55)
})
