/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { widgetToBlocks } from '@qrun-io/qqq-core'
import { BADGE_WIDTH, docLines, enumeration, htmlDocument, measureFor, statusTone, textDocument } from '../src/text-doc'
import { setAscii, theme } from '../src/theme'
import { blockLines, docBlock } from '../src/widgets'

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')) as { html: string; text?: string; type: string; title?: string }
const DIAG = fixture('quick-search-diagnostics.json')
const date = (iso: string) => iso.slice(0, 16).replace('T', ' ')
afterEach(() => setAscii(false))

test('before: the Search Diagnostics widget was one run-on block (no blank lines, headings as body text, raw ISO instants)', () => {
  const before = blockLines(widgetToBlocks(DIAG as never), 150).map((l) => l.text)
  expect(before.includes('')).toBe(false)
  expect(before.some((l) => /2026-11-01T13:00:22\.069086Z/.test(l))).toBe(true)
  expect(before.some((l) => l.length > 120)).toBe(true)
})

test('after: headings in the accent colour with a blank line before, their block indented under them', () => {
  const lines = docLines(htmlDocument(DIAG.html, { date }), 150)
  const t = theme()
  const headings = lines.filter((l) => l.fg === t.acc && l.bold).map((l) => l.text)
  expect(headings).toEqual(['Indexing', 'Global search on this server', 'Recent search failures (all servers)', 'Latest index validation', 'Tools'])
  for (const h of headings.slice(1)) expect(lines[lines.findIndex((l) => l.text === h) - 1]!.text).toBe('')
  const body = lines.filter((l) => l.text && !(l.fg === t.acc && l.bold))
  expect(body.every((l) => l.text.startsWith('  '))).toBe(true)
})

test('after: OK is a fixed-width green badge; lines with and without a badge align; Last failure none is green', () => {
  const t = theme()
  const lines = docLines(htmlDocument(DIAG.html, { date }), 150)
  const ok = lines.filter((l) => l.segments?.some((s) => s.text.trim() === 'OK'))
  expect(ok).toHaveLength(2)
  const badge = ok[0]!.segments!.find((s) => s.text.trim() === 'OK')!
  expect(badge.text.length).toBe(BADGE_WIDTH)
  expect(badge.bg).toBe(t.ok)
  // the continuation line starts under the text after the badge
  const at = lines.indexOf(ok[0]!)
  expect(lines[at + 1]!.text.search(/\S/)).toBe(ok[0]!.text.indexOf('Indexing is running'))
  const none = lines.find((l) => l.text.includes('Last failure'))!
  expect(none.segments!.at(-1)).toMatchObject({ text: 'none', fg: t.ok })
  expect(statusTone('degraded')).toBe('warn')
  expect(statusTone('DOWN')).toBe('err')
})

test('after: Label: value items are an aligned two-column list with dates in the display format', () => {
  const lines = docLines(htmlDocument(DIAG.html, { date }), 150).map((l) => l.text)
  const pairs = lines.filter((l) => /Failed OpenSearch|Table searches core|Last failure/.test(l))
  expect(pairs).toHaveLength(3)
  const col = (l: string) => l.search(/\s{2}\S+$/)
  expect(new Set(pairs.map(col)).size).toBe(1)
  expect(pairs[0]).toContain('since 2026-11-01 13:00')
  expect(lines.join('\n')).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d+Z/)
})

test('after: body text wraps at a ~100-cell measure (less when narrower) with blank lines between paragraphs; nothing overflows', () => {
  for (const width of [160, 100, 60, 40]) {
    const lines = docLines(htmlDocument(DIAG.html, { date }), width)
    expect(lines.every((l) => l.text.length <= Math.min(width, measureFor(width)))).toBe(true)
    const indexing = lines.findIndex((l) => l.text.includes('Self-priming'))
    expect(lines[indexing - 1]!.text).toBe('')
  }
  expect(measureFor(160)).toBe(100)
  expect(measureFor(70)).toBe(70)
})

test('after: the Tools enumeration is a bulleted list; prose with commas stays prose', () => {
  const lines = docLines(htmlDocument(DIAG.html, { date }), 150).map((l) => l.text)
  const at = lines.indexOf('  On Quick Search Index (Actions):')
  expect(lines.slice(at + 1, at + 7)).toEqual(['  • Add Search Index', '  • Apply Search Index Changes', '  • Disable and Remove Search Index', '  • Search Playground', '  • Validate Search Index', '  • Test Search Analyzer'])
  expect(enumeration('Self-priming ran today: New: 2 tables added and building (Customer, Order); 4 fields added, 0 updated from code defaults.')).toBeUndefined()
  expect(enumeration('We looked at the logs, found nothing, and moved on.')).toBeUndefined()
  expect(enumeration('Exports are: fast, reliable, and cheap.')).toBeUndefined()
  expect(enumeration('Formats: CSV, Excel, JSON, YAML.')).toEqual({ prefix: 'Formats:', list: ['CSV', 'Excel', 'JSON', 'YAML'] })
})

test('the ASCII setting: badges in brackets, bullets as *', () => {
  setAscii(true)
  const lines = docLines(htmlDocument(DIAG.html, { date }), 120).map((l) => l.text)
  expect(lines.some((l) => l.startsWith('  [OK]'))).toBe(true)
  expect(lines.some((l) => l.startsWith('  * Add Search Index'))).toBe(true)
  expect(lines.join('').includes('•')).toBe(false)
})

test('stat cards stay together, button rows of links become followable items', () => {
  const sql = fixture('sql-workbench-summary.json')
  const lines = docLines(htmlDocument(sql.html), 100)
  const text = lines.map((l) => l.text)
  const at = text.indexOf('Notebooks')
  expect(text.slice(at, at + 3)).toEqual(['Notebooks', '0', '0 yours, 0 by other users'])
  expect(text[at + 3]).toBe('')
  const runner = lines.find((l) => l.text === '• Open the Runner')!
  expect(runner.href).toBe('/app/sqlWorkbenchRunner')
})

test('plain text: markdown and short-line headings, status badges, bullets, paragraphs', () => {
  const doc = textDocument('Indexing\nOK Indexing is running.\n\n## Tools\n- Last failure: none\n- Reindex in Search\n\nA closing paragraph.')
  expect(doc.map((b) => b.kind)).toEqual(['heading', 'para', 'heading', 'list', 'para'])
  expect(doc[1]).toMatchObject({ badge: { text: 'OK', tone: 'ok' }, text: 'Indexing is running.' })
  expect(docBlock(textDocument('Just one plain sentence.'))).toBeUndefined()
})

test('long labels with short values keep their whole label in a narrower pane', () => {
  const lines = docLines(htmlDocument(DIAG.html, { date }), 66).map((l) => l.text)
  expect(lines.some((l) => l.includes('Failed OpenSearch searches since 2026-11-01 13:00  0'))).toBe(true)
  expect(lines.every((l) => l.length <= 66)).toBe(true)
})
