/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import type { DeveloperPanel } from '@qrun-io/qqq-core'
import { clipLine, codeSegLines, jsonSegLines, lineText, wrapLine, wrapText } from '../src/developer/json'
import { emptyColumnsNote, esbTableItems, linkTarget, metadataItems, panelSection, SectionNav, webUrl, type Section } from '../src/developer/model'
import { codeLines, gridLines, itemLines, PaneModel, paneText } from '../src/developer/pane'

const record = { id: 12, firstName: 'Clone of: Blair', lastName: 'Sample', email: 'blair@example.invalid', annualSalary: 150000 }
// the ESB panel's sample event exactly as the server sends it: minified, with spaces inside strings
const sampleEvent = JSON.stringify({ specversion: '1.0', source: 'qqq://qqq-sample/table/person', subject: '12', data: { record, oldRecord: record, changedFields: [] } })

const ESB_PANEL: DeveloperPanel = {
  id: 'esb', title: 'ESB Events', order: 300, description: 'This table publishes its record changes to the ESB as CloudEvents.', statusLabel: 'Publishing', statusTone: 'SUCCESS',
  blocks: [
    { type: 'KEY_VALUES', label: 'CloudEvents attributes', items: [{ label: 'type', value: 'qqq.table.person.updated' }, { label: 'subject', value: '12' }] },
    { type: 'TABLE', label: 'Published to', columns: ['Destination', 'Type', 'Provider', 'Events', 'Queued'], rows: [['personEvents', 'TOPIC', 'sampleArtemis', 'INSERT, UPDATE, DELETE', '']] },
    { type: 'TABLE', label: 'Subscribers (triggers)', columns: ['Trigger', 'Process', 'Mode', 'State', 'Max attempts', 'Dead letters'], rows: [['syncPerson.personEvents', 'Sync Person', 'SINGLE', 'RUNNING', '3', '']] },
    { type: 'CODE', label: 'Sample event for this record', language: 'json', code: sampleEvent },
    { type: 'LINKS', label: 'ESB tools', links: [{ label: 'Table developer view (messages, dead letters, operate)', href: '/app/person/dev' }, { label: 'ESB overview', href: '/app/esb' }] },
  ],
}
const CTX = { server: 'http://localhost:8077', tables: { person: {}, order: {} }, processes: { syncPerson: {} } }

// ---- JSON renderer ----

test('JSON is pretty-printed with two-space indent and tinted by token', () => {
  const lines = jsonSegLines({ a: 1, b: ['x', true, null], c: {} })
  expect(lines.map(lineText)).toEqual(['{', '  "a": 1,', '  "b": [', '    "x",', '    true,', '    null', '  ],', '  "c": {}', '}'])
  const b = lines[1]!
  expect(b.find((s) => s.text === '"a"')!.tone).toBe('key')
  expect(b.find((s) => s.text === '1')!.tone).toBe('number')
  expect(lines[3]!.find((s) => s.text === '"x"')!.tone).toBe('string')
  expect(lines[4]!.find((s) => s.text === 'true')!.tone).toBe('literal')
})

test('the sample event is never split on the spaces inside its strings, nor repeated: one source line, one screen line', () => {
  for (const width of [30, 40, 60, 100]) {
    const { lines, json } = codeLines({ code: sampleEvent, language: 'json' }, width)
    expect(json).toEqual(JSON.parse(sampleEvent))
    const texts = lines.map(lineText)
    // as many lines as the pretty-printed value, each within the width
    expect(texts.length).toBe(JSON.stringify(JSON.parse(sampleEvent), null, 2).split('\n').length)
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(width)
    // the value with a space in it appears once per occurrence (record and oldRecord), never as fragments
    expect(texts.filter((t) => t.includes('"firstName"')).length).toBe(2)
    expect(texts.some((t) => t.trim() === 'of:' || t.trim().startsWith('Blair'))).toBe(false)
  }
})

test('a long string is cut with an ellipsis in the pane, and soft-wrapped losslessly in the viewer', () => {
  const long = 'x'.repeat(50) + ' tail'
  const line = jsonSegLines({ note: long })[1]!
  const clipped = clipLine(line, 20)
  expect(lineText(clipped)).toHaveLength(20)
  expect(lineText(clipped).endsWith('…')).toBe(true)
  const pieces = wrapLine(line, 20)
  expect(pieces.every((p) => lineText(p).length <= 20)).toBe(true)
  expect(pieces.map(lineText).join('')).toBe(lineText(line))
  expect(clipLine(line, 200)).toBe(line)
})

test('code that is not JSON is shown as written; prose wraps without losing characters', () => {
  expect(codeSegLines('SELECT\n   "id"\nFROM t', 'sql').lines.map(lineText)).toEqual(['SELECT', '   "id"', 'FROM t'])
  expect(codeSegLines('{not json', 'json').json).toBeUndefined()
  const text = 'Read-only SQL for this record on the h2 backend averyveryveryverylongidentifierthatdoesnotfit end'
  const lines = wrapText(text, 16)
  expect(lines.every((l) => l.length <= 16)).toBe(true)
  expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''))
})

// ---- section model ----

test('a developer panel becomes a section: status and tone, pairs, grids with — notes, code, links as targets', () => {
  const s = panelSection(ESB_PANEL, CTX, { id: 'events', label: 'Events' })
  expect(s).toMatchObject({ id: 'events', label: 'Events', title: 'ESB Events', status: 'Publishing', statusTone: 'ok' })
  expect(s.items.map((i) => i.kind)).toEqual(['heading', 'pairs', 'heading', 'grid', 'heading', 'grid', 'code', 'heading', 'link', 'link'])
  const grids = s.items.filter((i) => i.kind === 'grid') as Array<{ note?: string }>
  expect(grids[0]!.note).toContain('Queued: the broker did not report a queue depth')
  expect(grids[1]!.note).toContain('Dead letters')
  const links = s.items.filter((i) => i.kind === 'link') as Array<{ target: unknown }>
  expect(links[0]!.target).toEqual({ kind: 'table-developer', table: 'person' })
  expect(links[1]!.target).toEqual({ kind: 'browser', url: 'http://localhost:8077/app/esb' })
})

test('the section lines: empty cells show —, the sample event once, links say where they go', () => {
  const s = panelSection(ESB_PANEL, CTX, { id: 'events', label: 'Events' })
  const lines = itemLines(s, 100, () => () => undefined)
  const text = lines.map(paneText)
  expect(text.every((t) => t.length <= 100)).toBe(true)
  expect(text.find((t) => t.startsWith('personEvents'))).toMatch(/—\s*$/)
  expect(text.filter((t) => t.includes('"firstName": "Clone of: Blair"')).length).toBe(2)
  expect(text.find((t) => t.includes('ESB overview'))).toContain('(browser only)')
  expect(text.find((t) => t.includes('Table developer view'))).toContain('table developer view · person')
  // selectable: pairs, grid rows, the code block, links
  const code = lines.find((l) => l.view?.code === sampleEvent)!
  expect(code.copy).toBe(JSON.stringify(JSON.parse(sampleEvent), null, 2))
  expect(lines.filter((l) => l.id).length).toBe(2 + 1 + 1 + 1 + 2)
})

test('empty-column notes: only for columns empty in every row; generic text for unknown headers', () => {
  expect(emptyColumnsNote(['A', 'Queued'], [['x', ''], ['y', '']])).toContain('Queued:')
  expect(emptyColumnsNote(['A', 'Queued'], [['x', ''], ['y', '4']])).toBeUndefined()
  expect(emptyColumnsNote(['A', 'Other'], [['x', ' ']])).toBe('— Other: the server reported no value.')
  expect(emptyColumnsNote(['A'], [])).toBeUndefined()
})

test('the section bar: ← → wrap, digits jump, the section is kept by id when sections change', () => {
  const sec = (id: string): Section => ({ id, label: id, title: id, items: [] })
  const nav = new SectionNav([sec('security'), sec('events'), sec('scripts')])
  expect(nav.onKey('left')).toBe(true)
  expect(nav.current!.id).toBe('scripts')
  nav.onKey('right')
  expect(nav.current!.id).toBe('security')
  nav.onKey('2')
  expect(nav.current!.id).toBe('events')
  expect(nav.onKey('7')).toBe(false)
  expect(nav.onKey('x')).toBe(false)
  nav.set([sec('security'), sec('extra'), sec('events'), sec('scripts')])
  expect(nav.current!.id).toBe('events')
  expect(nav.digits()).toBe('1-4')
  expect(nav.select('nope')).toBe(false)
})

test('the ESB table section: publications and subscribers with counters, — notes, the overview link browser only', () => {
  const destination = { name: 'personEvents', type: 'TOPIC', provider: 'sampleArtemis', counters: { published: 39, publishFailures: 0, lastActivity: '2026-11-01T10:55:08Z' }, queueInfo: null }
  const items = esbTableItems({ publications: [{ destination, events: ['INSERT'] }], subscribers: [{ name: 'syncPerson.personEvents', processLabel: 'Sync Person', state: 'RUNNING', counters: { consumed: 326, failed: 0, deadLettered: 0, lastError: 'boom' }, deadLetter: { messageCount: null } }] }, CTX, () => 'when')
  const grids = items.filter((i) => i.kind === 'grid') as Array<{ rows: Array<{ cells: string[] }>; note?: string }>
  expect(grids[0]!.rows[0]!.cells).toEqual(['personEvents', 'TOPIC', 'sampleArtemis', 'INSERT', '39', '0', ''])
  expect(grids[1]!.rows[0]!.cells).toEqual(['syncPerson.personEvents', 'Sync Person', 'RUNNING', '326', '0', '0', ''])
  expect(grids[1]!.note).toContain('Dead letters')
  expect(items.some((i) => i.kind === 'text' && i.text === 'syncPerson.personEvents: boom')).toBe(true)
  expect(items.at(-1)).toMatchObject({ kind: 'link', target: { kind: 'browser' } })
  expect(esbTableItems({ publications: [], subscribers: [] }, CTX, String)[0]).toMatchObject({ kind: 'empty' })
})

test('metadata items: summary pairs, a fields grid and a sections grid', () => {
  const items = metadataItems({ name: 'person', label: 'Person', primaryKeyField: 'id', readPermission: true, editPermission: true, capabilities: ['TABLE_QUERY'], fields: { id: { label: 'Id', type: 'INTEGER', isEditable: false }, email: { label: 'Email', type: 'STRING', isRequired: true } }, sections: [{ name: 'identity', label: 'Identity', tier: 'T1', fieldNames: ['id'] }] })
  const pairs = (items[0] as { pairs: Array<{ label: string; value: string }> }).pairs
  expect(pairs.find((p) => p.label === 'Permissions')!.value).toBe('read, edit')
  expect(pairs.find((p) => p.label === 'Fields')!.value).toBe('2')
  const fields = items[2] as { rows: Array<{ cells: string[] }> }
  expect(fields.rows.map((r) => r.cells)).toEqual([['id', 'Id', 'INTEGER', '', '', 'read-only'], ['email', 'Email', 'STRING', 'yes', '', '']])
})

// ---- link-action mapping ----

test('web links map to TUI destinations; the rest are browser only with the server URL', () => {
  expect(linkTarget('/app/person/dev', CTX)).toEqual({ kind: 'table-developer', table: 'person' })
  expect(linkTarget('/app/person/12/dev', CTX)).toEqual({ kind: 'record-developer', table: 'person', primaryKey: '12' })
  expect(linkTarget('/app/person/12', CTX)).toEqual({ kind: 'record', table: 'person', primaryKey: '12' })
  expect(linkTarget('/app/person', CTX)).toEqual({ kind: 'table', table: 'person' })
  expect(linkTarget('/app/person?filter=x', CTX)).toEqual({ kind: 'table', table: 'person' })
  expect(linkTarget('/app/syncPerson', CTX)).toEqual({ kind: 'process', process: 'syncPerson' })
  expect(linkTarget('/app/esb', CTX)).toEqual({ kind: 'browser', url: 'http://localhost:8077/app/esb' })
  expect(linkTarget('/app/sqlWorkbenchRunner?sql=SELECT%201', CTX)).toEqual({ kind: 'browser', url: 'http://localhost:8077/app/sqlWorkbenchRunner?sql=SELECT%201' })
  expect(linkTarget('https://example.test/x', CTX)).toEqual({ kind: 'browser', url: 'https://example.test/x' })
  expect(linkTarget('/app/person/12/dev/extra', CTX).kind).toBe('browser')
  expect(webUrl('http://h:1/', 'app/x')).toBe('http://h:1/app/x')
})

test('ACTIONS blocks become process targets, with the record id when the action asks for it', () => {
  const s = panelSection({ id: 'qs', title: 'Quick Search', order: 1, blocks: [{ type: 'ACTIONS', label: 'Actions', actions: [{ label: 'Reindex', processName: 'reindex', includeRecordId: true }, { label: 'All', processName: 'all' }] }] }, CTX, { recordId: '7' })
  const links = s.items.filter((i) => i.kind === 'link') as Array<{ target: unknown }>
  expect(links.map((l) => l.target)).toEqual([{ kind: 'process', process: 'reindex', recordId: '7' }, { kind: 'process', process: 'all' }])
})

// ---- grid and pane ----

test('grids use the main grid layout: fixed columns within the width, cells cut with …, empty cells —', () => {
  const g = gridLines(['Trigger', 'Process', 'State', 'Consumed', 'Dead letters'], [['syncPerson.personEvents', 'Sync Person', 'RUNNING', '326', '']], 40)
  const header = g.header.map((s) => s.text).join('')
  const row = g.rows[0]!.map((s) => s.text).join('')
  expect(header.length).toBeLessThanOrEqual(40)
  expect(row.length).toBe(header.length)
  expect(row).toContain('…')
  expect(row.trimEnd().endsWith('—')).toBe(true)
  expect(g.hidden).toBe(0)
})

test('the pane scrolls through unselectable lines and stops the cursor on selectable ones', () => {
  const pane = new PaneModel()
  const lines = Array.from({ length: 30 }, (_, i) => ({ spans: [{ text: `line ${i}` }], ...(i === 2 || i === 20 ? { id: `s${i}` } : {}) }))
  pane.update(lines, 10)
  expect(pane.selected).toBe('s2')
  pane.onKey({ name: 'down', sequence: '' })
  // s20 is out of view: the pane scrolls one line instead of jumping
  expect(pane.top).toBe(1)
  for (let i = 0; i < 10; i++) pane.onKey({ name: 'down', sequence: '' })
  expect(pane.selected).toBe('s20')
  expect(pane.position()).toMatch(/^lines \d+–\d+ of 30$/)
  pane.onKey({ name: 'home', sequence: '' })
  expect(pane.top).toBe(0)
  pane.onKey({ name: 'end', sequence: '' })
  expect(pane.top).toBe(20)
  pane.update(lines.slice(0, 5), 10)
  expect(pane.position()).toBe('')
})
