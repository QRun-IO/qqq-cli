/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MASK, fileDownload, recordView, relatedRecordTarget, selectHelpContent, helpEntryText, tableViewHelp, valueText } from '../records/record-view.js'
import type { RecordLike, TableMetaLike } from '../records/associations.js'
import type { FieldMeta } from '../forms/fields.js'

const field = (name: string, extra: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name, type: 'STRING', ...extra })
const rec = (values: Record<string, unknown>, displayValues: Record<string, unknown> = {}): RecordLike => ({ values, displayValues })

test('LINK: a record link names the target table and key; a URL link shows the URL', () => {
  const personId = field('personId', { type: 'INTEGER', adornments: [{ type: 'LINK', values: { toRecordFromTable: 'person' } }] })
  assert.deepEqual(valueText(personId, rec({ personId: 1 }, { personId: 'Avery Sample' })), { text: 'Avery Sample → person 1', link: { tableName: 'person', primaryKey: '1' }, adornment: 'LINK' })
  const site = field('site', { adornments: [{ type: 'LINK', values: {} }] })
  assert.equal(valueText(site, rec({ site: 'https://qrun.io' })).text, 'https://qrun.io')
  const dyn = field('ref', { adornments: [{ type: 'LINK', values: { toRecordFromTableDynamic: true } }] })
  assert.deepEqual(valueText(dyn, rec({ ref: 5 }, { ref: 'Five', 'ref:toRecordFromTableDynamic': 'order' })).link, { tableName: 'order', primaryKey: '5' })
})

test('possible-value fields from a table link to the related record (only for known tables)', () => {
  const speciesId = field('speciesId', { type: 'INTEGER', possibleValueSourceName: 'petSpecies' })
  assert.equal(valueText(speciesId, rec({ speciesId: 1 }, { speciesId: 'Dog' }), { tableNames: ['petSpecies'] }).text, 'Dog → petSpecies 1')
  assert.equal(valueText(speciesId, rec({ speciesId: 1 }, { speciesId: 'Dog' }), { tableNames: ['person'] }).text, 'Dog')
  assert.deepEqual(relatedRecordTarget(speciesId, rec({ speciesId: 2 })), { tableName: 'petSpecies', primaryKey: '2' })
  assert.equal(relatedRecordTarget(speciesId, rec({ speciesId: null })), undefined)
})

test('CHIP brackets, REVEAL masks unless revealed, ERROR marks, CODE_EDITOR is raw, RENDER_HTML is text', () => {
  assert.equal(valueText(field('s', { adornments: [{ type: 'CHIP', values: { 'color.OPEN': 'success' } }] }), rec({ s: 'OPEN' }, { s: 'Open' })).text, '[Open]')
  const secret = field('apiKey', { adornments: [{ type: 'REVEAL' }] })
  assert.deepEqual(valueText(secret, rec({ apiKey: 'abc123' })), { text: MASK, adornment: 'REVEAL', masked: true })
  assert.equal(valueText(secret, rec({ apiKey: 'abc123' }), { reveal: true }).text, 'abc123')
  assert.equal(valueText(secret, rec({ apiKey: null })).text, '', 'nothing to mask')
  assert.deepEqual(valueText(field('e', { adornments: [{ type: 'ERROR' }] }), rec({ e: 'bad row' })), { text: '! bad row', adornment: 'ERROR', error: true })
  assert.equal(valueText(field('c', { adornments: [{ type: 'CODE_EDITOR', values: { languageMode: 'json' } }] }), rec({ c: '{"a":1}' }, { c: 'x' })).text, '{"a":1}')
  assert.equal(valueText(field('h', { adornments: [{ type: 'RENDER_HTML' }] }), rec({ h: '<p>Hello <b>there</b></p><p>Two</p>' })).text, 'Hello there\nTwo')
})

test('TOOLTIP text follows the value; dynamic text wins', () => {
  const f = field('t', { adornments: [{ type: 'TOOLTIP', values: { staticText: 'static tip', tooltipDynamic: true } }] })
  assert.equal(valueText(f, rec({ t: 'v' })).text, 'v (static tip)')
  assert.equal(valueText(f, rec({ t: 'v' }, { 't:tooltipDynamic': 'per record' })).text, 'v (per record)')
})

test('FILE_DOWNLOAD: the backend route becomes a download command; outside URLs stay URLs', () => {
  const f = field('file', { type: 'BLOB', adornments: [{ type: 'FILE_DOWNLOAD' }] })
  const r = rec({ file: '/data/doc/7/file/report%20q3.pdf' }, { file: 'report q3.pdf' })
  assert.deepEqual(fileDownload(f, r), { fileName: 'report q3.pdf', route: { tableName: 'doc', primaryKey: '7', fieldName: 'file', filename: 'report q3.pdf' } })
  assert.equal(valueText(f, r, { tableName: 'doc', primaryKey: '7' }).text, 'report q3.pdf (qqq table download doc 7 file)')
  assert.deepEqual(fileDownload(f, rec({ file: 'https://cdn.example/a.png' })), { fileName: 'a.png', url: 'https://cdn.example/a.png' })
  assert.equal(fileDownload(f, rec({ file: '//evil/a' })), undefined)
})

test('a BLOB without an adornment shows its size and the download command', () => {
  assert.equal(valueText(field('b', { type: 'BLOB' }), rec({ b: 'aGVsbG8=' }), { tableName: 'fieldLab', primaryKey: '1' }).text, '<file, 5 bytes> (qqq table download fieldLab 1 b)')
})

test('WIDGET renders the value as widget text; a missing widget is an error', () => {
  const f = field('w', { adornments: [{ type: 'WIDGET', values: { widgetName: 'stats' } }] })
  const value = { type: 'statistics', label: 'Totals', count: 3 }
  assert.ok(valueText(f, rec({ w: value }), { widgets: { stats: {} } }).text.length > 0)
  assert.deepEqual(valueText(f, rec({ w: value }), { widgets: {} }), { text: 'Error: Could not load widget [stats]', adornment: 'WIDGET', error: true })
})

test('record view: hidden sections and hidden fields are never shown; unplaced fields come last', () => {
  const table: TableMetaLike = {
    name: 't', primaryKeyField: 'id',
    fields: { id: field('id'), a: field('a'), b: field('b', { isHidden: true }), c: field('c'), d: field('d'), e: field('e') },
    sections: [{ name: 's1', label: 'One', tier: 'T1', fieldNames: ['id', 'a', 'b'] }, { name: 's2', label: 'Secret', fieldNames: ['c'], isHidden: true }, { name: 'w', label: 'Lines', widgetName: 'lines' }],
  }
  const view = recordView(table, rec({ id: 1, a: 'A', b: 'B', c: 'C', d: 'D', e: null }))
  assert.deepEqual(view.map((s) => [s.label, s.fields.map((x) => x.field.name), s.widgetName]), [['One', ['id', 'a'], undefined], ['Lines', [], 'lines'], ['Other Fields', ['d', 'e'], undefined]])
  assert.equal(recordView(table, rec({ e: null }), { empty: '--' }).at(-1)!.fields.at(-1)!.value.text, '--', 'empty values get the placeholder')
})

test('help content: view roles first, then entries without roles; HTML and MARKDOWN as text', () => {
  const entries = [{ content: 'edit help', roles: ['EDIT_SCREEN'] }, { content: 'general' }, { content: '<p>view <b>help</b></p>', format: 'HTML', roles: ['READ_SCREENS'] }]
  assert.equal(helpEntryText(selectHelpContent(entries)), 'view help')
  assert.equal(helpEntryText(selectHelpContent([{ content: '# x', format: 'MARKDOWN', contentAsHtml: '<h1>x</h1>', links: [{ label: 'Docs', url: 'https://d' }] }])), 'x (Docs <https://d>)')
  assert.equal(selectHelpContent([{ content: 'e', roles: ['EDIT_SCREEN'] }]), undefined)
  const table: TableMetaLike = { name: 't', fields: { a: field('a', { helpContents: [{ content: 'field help' }] }) }, sections: [{ name: 's', label: 'S', fieldNames: ['a'], helpContents: [{ content: 'section help' }] }], helpContents: { header: [{ content: 'table help' }] } }
  const view = recordView(table, rec({ a: 1 }), { helpContent: true })
  assert.equal(view[0]!.help, 'section help')
  assert.equal(view[0]!.fields[0]!.help, 'field help')
  assert.deepEqual(tableViewHelp(table), [{ slot: 'header', text: 'table help' }])
  assert.equal(recordView(table, rec({ a: 1 }))[0]!.help, undefined, 'help only when asked')
})

test('DATE_TIME values show in the viewer\'s zone, or as the UTC instant with utc', () => {
  const f = field('when', { type: 'DATE_TIME' })
  const r = rec({ when: '2026-10-31T22:33:01Z' }, { when: '2026-10-31T22:33:01Z' })
  assert.match(valueText(f, r, { dateTime: { timeZone: 'Asia/Tokyo' } }).text, /^2026-11-01 07:33:01 /)
  assert.equal(valueText(f, r, { dateTime: { utc: true } }).text, '2026-10-31T22:33:01Z')
  assert.equal(valueText(f, rec({ when: null }), { empty: '--' }).text, '--')
})

test('cell mode keeps the adornment rules without link targets, hints or tooltips', async () => {
  const { valueText } = await import('../records/record-view.js')
  const record = { values: { secret: 'hunter2', owner: 3, file: 'QUJD', when: '2026-10-31T19:30:00Z' }, displayValues: { owner: 'Avery' } }
  const secret = { name: 'secret', label: 'Secret', type: 'STRING', adornments: [{ type: 'REVEAL' }, { type: 'TOOLTIP', values: { staticText: 'shh' } }] }
  assert.equal(valueText(secret, record, { cell: true }).text, '••••••••')
  assert.equal(valueText(secret, record, { cell: true, reveal: true }).text, 'hunter2')
  const owner = { name: 'owner', label: 'Owner', type: 'INTEGER', possibleValueSourceName: 'person' }
  assert.equal(valueText(owner, record).text, 'Avery → person 3')
  assert.equal(valueText(owner, record, { cell: true }).text, 'Avery')
  assert.equal(valueText({ name: 'file', label: 'File', type: 'BLOB' }, record, { cell: true, tableName: 't', primaryKey: '1' }).text, '<file, 3 bytes>')
  assert.equal(valueText({ name: 'when', label: 'When', type: 'DATE_TIME' }, record, { cell: true, dateTime: { timeZone: 'America/Chicago' } }).text, '2026-10-31 14:30:00 CDT')
})

test('one help text rule: help show, the record view and process screens agree', async () => {
  const { helpContentText } = await import('../help/help-content.js')
  const { helpEntryText } = await import('../records/record-view.js')
  const { helpText } = await import('../process/screen.js')
  const entries = [
    { content: '<p>Use <b>this</b></p>', format: 'HTML' },
    { content: '**md**', format: 'MARKDOWN', contentAsHtml: '<p><strong>md</strong></p>' },
    { content: 'plain', format: 'TEXT' },
    { content: 'x', contentAsText: 'from server' },
  ]
  for (const entry of entries) {
    const text = helpContentText(entry)
    assert.equal(helpEntryText(entry), text)
    assert.deepEqual(helpText([entry]), [text])
  }
  assert.deepEqual(entries.map((e) => helpContentText(e)), ['Use this', 'md', 'plain', 'from server'])
})
