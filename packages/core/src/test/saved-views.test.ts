/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SavedViewError, buildViewJson, deleteSavedView, findSavedView, listSavedViews, parseViewJson, savedViewProcesses, storeSavedView, viewToQuery } from '../query/saved-views.js'

const table = {
  name: 'person', label: 'Person', primaryKeyField: 'id',
  fields: { id: { name: 'id' }, firstName: { name: 'firstName', label: 'First Name' }, isEmployed: { name: 'isEmployed', label: 'Employed', type: 'BOOLEAN' } },
  clientCapabilities: { savedViews: { available: true, queryProcessName: 'qSV', storeProcessName: 'sSV', deleteProcessName: 'dSV' } },
}

test('saved-view processes come from clientCapabilities, else the legacy names when permitted', () => {
  assert.deepEqual(savedViewProcesses(table, {}), { query: 'qSV', store: 'sSV', delete: 'dSV' })
  assert.deepEqual(savedViewProcesses({ clientCapabilities: { savedViews: { available: false } } }, { processes: { querySavedView: {} } }), {})
  assert.deepEqual(savedViewProcesses({}, { processes: { querySavedView: {}, storeSavedView: { hasPermission: false } } }), { query: 'querySavedView' })
})

test('views list, store and delete through the processes; viewJson round-trips', async () => {
  const calls: Array<{ url: string; values: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const values = JSON.parse(String((init!.body as FormData).get('values')))
    calls.push({ url: String(input), values })
    const row = (id: number, label: string, userId: string) => ({ values: { id, label, userId, tableName: 'person', viewJson: JSON.stringify({ queryFilter: { criteria: [{ fieldName: 'firstName', operator: 'EQUALS', values: ['A'] }] }, rowsPerPage: 50 }) } })
    const list = String(input).includes('/dSV/') ? [] : String(input).includes('/sSV/') ? [row(9, String(values.label), 'me')] : [row(2, 'zeta', 'me'), row(1, 'Alpha', 'other')]
    return new Response(JSON.stringify({ type: 'COMPLETE', values: { savedViewList: list } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const processes = savedViewProcesses(table, {})
  const views = await listSavedViews('http://h', fetchImpl, processes, 'person')
  assert.deepEqual(views.map((v) => v.label), ['Alpha', 'zeta'])
  assert.equal(views[0]!.view.rowsPerPage, 50)
  assert.match(calls[0]!.url, /\/qqq\/v1\/processes\/qSV\/init$/)
  assert.deepEqual(calls[0]!.values, { tableName: 'person' })
  const stored = await storeSavedView('http://h', fetchImpl, processes, { table: 'person', label: 'New', view: { queryFilter: {} }, id: 2 })
  assert.equal(stored.id, 9)
  assert.deepEqual(calls[1]!.values, { tableName: 'person', label: 'New', viewJson: '{"queryFilter":{}}', id: 2 })
  await deleteSavedView('http://h', fetchImpl, processes, 9)
  assert.deepEqual(calls[2]!.values, { id: 9 })
  await assert.rejects(listSavedViews('http://h', fetchImpl, {}, 'person'), SavedViewError)
  const failing: typeof fetch = async () => new Response(JSON.stringify({ type: 'ERROR', userFacingError: 'A view with this name already exists' }), { status: 200, headers: { 'content-type': 'application/json' } })
  await assert.rejects(storeSavedView('http://h', failing, processes, { table: 'person', label: 'x', view: { queryFilter: {} } }), /already exists/)
})

test('find by id or name; duplicates and unknown views are reported', () => {
  const views = [{ id: 1, label: 'Alpha', tableName: 't', view: { queryFilter: {} } }, { id: 2, label: 'dup', tableName: 't', view: { queryFilter: {} } }, { id: 3, label: 'Dup', tableName: 't', view: { queryFilter: {} } }]
  assert.equal(findSavedView(views, '2').label, 'dup')
  assert.equal(findSavedView(views, 'alpha').id, 1)
  assert.equal(findSavedView(views, 'Dup').id, 3)
  assert.throws(() => findSavedView(views, 'DUP'), /2 views are named/)
  assert.throws(() => findSavedView(views, 'nope'), /No saved view "nope"/)
})

test('a view document is built as the web UIs store it, and reconciled when opened', () => {
  const view = buildViewJson({ filter: { criteria: [{ fieldName: 'firstName', operator: 'EQUALS', values: ['A'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: false }], limit: 5 }, columns: ['id', 'firstName'], allColumns: ['id', 'firstName', 'isEmployed'], rowsPerPage: 50 })
  assert.deepEqual(view.queryColumns!.columns.map((c) => [c.name, c.isVisible]), [['__check__', true], ['id', true], ['firstName', true], ['isEmployed', false]])
  assert.deepEqual(view.queryFilter.orderBys, [{ fieldName: 'id', isAscending: false }])
  assert.equal((view.queryFilter as { limit?: number }).limit, undefined)
  assert.deepEqual(parseViewJson(JSON.stringify(view)), view)
  assert.deepEqual(parseViewJson('not json'), { queryFilter: {}, quickFilterFieldNames: [] })
  const opened = viewToQuery(table, [], {
    queryFilter: { criteria: [{ fieldName: 'gone', operator: 'EQUALS', values: ['x'] }, { fieldName: 'isEmployed', operator: 'GREATER_THAN', values: ['1'] }, { fieldName: 'firstName', operator: 'EQUALS', values: ['A'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'gone', isAscending: true }] },
    queryColumns: { columns: [{ name: '__check__', isVisible: true }, { name: 'firstName', isVisible: true }, { name: 'old', isVisible: true }, { name: 'id', isVisible: false }] },
    rowsPerPage: 100,
  })
  assert.deepEqual(opened.filter, { criteria: [{ fieldName: 'firstName', operator: 'EQUALS', values: ['A'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: false }] })
  assert.deepEqual(opened.columns, ['firstName'])
  assert.equal(opened.rowsPerPage, 100)
  assert.match(opened.warnings[0]!, /^2 fields that were part of this view are no longer in this table, and were removed from this view \(gone, old\)\.$/)
  assert.match(opened.warnings[1]!, /Employed has an unsupported operator: GREATER_THAN/)
})
