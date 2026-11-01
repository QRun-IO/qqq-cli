/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The document layout of table output (extension results): scalars as key/value rows, lists of
 * objects as sub-tables, fitted to a width. The layouts are compared with src/test/golden/*.txt;
 * UPDATE_GOLDEN=1 rewrites them.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fitColumns, formatDocument, isNestedDocument, render } from '../render/output.js'
import { DEFAULT_LIST_COLUMNS, defaultListColumns, parseColumnList } from '../extensions/list-columns.js'

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'test', 'golden')

function golden(name: string, actual: string): void {
  const file = join(GOLDEN, `${name}.txt`)
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(file, `${actual}\n`)
    if (process.env.UPDATE_GOLDEN !== '1') assert.fail(`wrote missing golden ${name}.txt; check it and run again`)
    return
  }
  assert.equal(`${actual}\n`, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `golden ${name}.txt (UPDATE_GOLDEN=1 rewrites it)`)
}

const INBOX = {
  items: [
    { id: 7, title: 'Send Test Event To Webhook failed', severity: 'ERROR', category: 'JOB', age: '4 min', unread: true, href: '/app/webhook', actions: [{ label: 'Mark read', name: 'read' }, { label: 'Dismiss', name: 'dismiss' }] },
    { id: 6, title: 'Calculate Order Total (JavaScript) failed', severity: 'ERROR', category: 'JOB', age: '7 min', unread: false, href: null, actions: [] },
  ],
  total: 2,
  offset: 0,
  limit: 25,
}

const CAPABILITIES = {
  version: '1.0.0',
  canWrite: false,
  limits: { maxRows: 10000, pageSize: 500 },
  dialects: ['h2', 'postgres'],
  backends: [{ name: 'h2', vendor: 'h2', owner: { id: 1, name: 'Admin' }, schemas: ['PUBLIC', 'INFO'] }],
  notebooks: [],
}

test('a result with lists: key/value rows, then one sub-table per list (union of keys, first-seen order)', () => {
  golden('document-inbox', formatDocument(INBOX))
  golden('document-capabilities', formatDocument(CAPABILITIES))
})

test('sub-tables fit the width: cells cut with …, columns that do not fit are named', () => {
  golden('document-inbox-narrow', formatDocument(INBOX, { width: 50 }))
})

test('a layout chooses columns per list; * applies to every list; a nested object reads as a.b', () => {
  golden('document-inbox-columns', formatDocument(INBOX, { columns: defaultListColumns('alertsInbox') }))
  golden('document-capabilities-columns', formatDocument(CAPABILITIES, { columns: { '*': ['name', 'owner.name', 'schemas'] } }))
  golden('document-top-level-list', formatDocument(INBOX.items, { columns: { '': ['id', 'title'] }, width: 30 }))
})

test('render uses the document layout for nested results and layouts; json and csv do not change', () => {
  assert.equal(isNestedDocument(INBOX), true)
  assert.equal(isNestedDocument({ a: 1, b: ['x'] }), false)
  assert.equal(render({ data: INBOX }, 'table'), formatDocument(INBOX))
  assert.equal(render({ data: { notebooks: [] }, layout: {} }, 'table'), 'notebooks  (none)')
  // flat results keep the key/value table
  assert.equal(render({ data: { a: 1 } }, 'table'), 'key  value\n---  -----\na    1')
  assert.equal(render({ data: INBOX, layout: {} }, 'json'), JSON.stringify(INBOX, null, 2))
  // --query reshapes: the layout's column choice no longer applies, the width still does
  assert.equal(render({ data: INBOX, layout: { columns: { '*': ['id'] } } }, 'table', 'items[].{id: id, age: age}', { width: 40 }), 'id  age\n--  -----\n7   4 min\n6   7 min')
  assert.equal(render({ data: INBOX, footer: '(2 alerts)' }, 'table').endsWith('\n(2 alerts)'), true)
})

test('fitColumns keeps as many columns as fit, then shrinks the widest', () => {
  assert.deepEqual(fitColumns([10, 20, 30], undefined), { widths: [10, 20, 30], shown: 3 })
  assert.deepEqual(fitColumns([10, 20, 30], 40), { widths: [10, 13, 13], shown: 3 })
  assert.deepEqual(fitColumns([10, 20, 30, 30], 30), { widths: [8, 9, 9], shown: 3 })
  assert.deepEqual(fitColumns([3, 4], 100), { widths: [3, 4], shown: 2 })
})

test('default list columns cover the common extension lists; --columns parses', () => {
  for (const id of ['alertsInbox', 'sqlWorkbenchListNotebooks', 'sqlWorkbenchGetHistory', 'getQbitCollaborationRecordsByTableByPkComments', 'getQbitCollaborationTasksMine', 'getQbitCollaborationFavorites', 'getQbitCollaborationRecents']) assert.ok(DEFAULT_LIST_COLUMNS[id], id)
  assert.equal(defaultListColumns('nope'), undefined)
  assert.deepEqual(parseColumnList(' id, title ,,'), ['id', 'title'])
  assert.equal(parseColumnList(''), undefined)
})
