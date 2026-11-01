/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchCoverageText, plainSearchText, groupSearchResults, highlightText, quickSearchStatus, searchStatusLine, unsupportedSyntax } from '../query/record-search.js'

const RESPONSE = {
  results: [
    { recordId: '1', tableName: 'customer', tableLabel: 'Customer', recordLabel: 'Ada Lovelace', highlights: [{ text: 'ada@example.test', fieldName: 'email', fieldLabel: 'Email', matches: [{ start: 0, end: 3 }] }] },
    { recordId: '7', tableName: 'order', tableLabel: 'Order', recordLabel: '7', highlights: [{ text: 'Ada order', fieldName: 'notes', fieldLabel: 'Notes' }] },
    { recordId: '2', tableName: 'customer', tableLabel: 'Customer', recordLabel: 'Adam Smith', highlights: [] },
  ],
  tables: [{ tableName: 'order', tableLabel: 'Order', totalCount: 3, hasMore: true }, { tableName: 'customer', tableLabel: 'Customer', totalCount: 2 }, { tableName: 'tag', tableLabel: 'Tags', totalCount: 0 }],
  provider: { status: 'OK' },
}

test('search results group by table in the server order with counts; labels fall back to the highlight; snippets name the field', () => {
  const r = groupSearchResults(RESPONSE)
  assert.deepEqual(r.groups.map((g) => [g.table, g.label, g.total, g.hasMore, g.hits.length]), [['order', 'Order', 3, true, 1], ['customer', 'Customer', 2, false, 2]])
  assert.equal(r.total, 5)
  assert.equal(r.groups[0]!.hits[0]!.label, 'Ada order')
  assert.equal(r.groups[1]!.hits[0]!.snippet, 'Email: ada@example.test')
  assert.equal(r.groups[1]!.hits[1]!.snippet, undefined)
  assert.equal(highlightText(RESPONSE.results[0]!.highlights[0]!, ['[', ']']), 'Email: [ada]@example.test')
  assert.equal(groupSearchResults({ results: [], provider: { status: 'NONE' } }).provider, 'NONE')
})

test('quick search status and the status line; syntax quick search does not have is named', () => {
  const s = quickSearchStatus({ state: 'OK', indexes: [{ tableName: 'customer', enabled: true, documentCount: 1200 }, { tableName: 'order', enabled: true, documentCount: 34 }, { tableName: 'x', enabled: false, documentCount: 9 }], lastSuccessfulSync: '2026-11-01T10:12:00Z' })
  assert.deepEqual(s.tables, ['customer', 'order'])
  assert.equal(s.documents, 1234)
  assert.equal(searchStatusLine({ total: 3, groups: [1, 2] }, 42.4, s, () => '10:12'), '3 matches in 2 tables · 42 ms · index 1,234 records in 2 tables · last reindex 10:12')
  assert.deepEqual(unsupportedSyntax('ada lov'), [])
  assert.match(unsupportedSyntax('name:ada')[0]!, /name:ada is not a field search: searched for ada in every field/)
  assert.equal(plainSearchText('status:new ord'), 'new ord')
  assert.equal(plainSearchText('ada'), 'ada')
  assert.equal(unsupportedSyntax('"ada lovelace" ad*').length, 2)
  assert.deepEqual(unsupportedSyntax('ORD-1001'), [])
  assert.deepEqual(unsupportedSyntax('ada OR grace'), ['OR and minus are not operators: every word must match'])
  assert.deepEqual(unsupportedSyntax('ada -grace').length, 1)
})

test('the empty state names what quick search covers, up to five tables then "and N more"', () => {
  const s = quickSearchStatus({ state: 'OK', indexes: [{ tableName: 'customer', enabled: true, documentCount: 4 }, { tableName: 'order', enabled: true, documentCount: 2 }], lastSuccessfulSync: '2026-11-01T11:23:00Z' })
  const label = (t: string) => t[0]!.toUpperCase() + t.slice(1)
  assert.equal(searchCoverageText('Illinois', s, { totalTables: 183, label, clock: () => '05:23', fallback: 'press `o` to search the current table by name' }),
    'No records match "Illinois". Quick search indexes 2 of 183 tables (Customer, Order) · 6 records · last reindex 05:23. Tables not indexed cannot be found here; add them in Quick Search Admin › Quick Search Index, or press `o` to search the current table by name.')
  const many = quickSearchStatus({ indexes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => ({ tableName: t, enabled: true, documentCount: 1 })) })
  assert.match(searchCoverageText('x', many), /\(a, b, c, d, e and 2 more\) · 7 records\. Tables not indexed/)
  assert.equal(searchCoverageText('x', undefined), 'No records match "x".')
})
