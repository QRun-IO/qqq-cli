/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Saved views and audits against a stub (the sample has neither). */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type J, type Stub } from './stub.js'

describe('saved views and audits against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  const views: J[] = [
    { id: 1, label: 'Mine', tableName: 'order', userId: 'me@example.com', viewJson: JSON.stringify({ queryFilter: { criteria: [{ fieldName: 'status', operator: 'EQUALS', values: ['open'] }], booleanOperator: 'AND' }, queryColumns: { columns: [{ name: 'id', isVisible: true }, { name: 'gone', isVisible: true }] }, rowsPerPage: 10 }) },
    { id: 2, label: 'Shared', tableName: 'order', userId: 'bob@example.com', type: 'quickView', doCount: true, viewJson: JSON.stringify({ queryFilter: { criteria: [], booleanOperator: 'AND' } }) },
  ]
  const token = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.y`
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: token, ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { order: { name: 'order', label: 'Order' } }, processes: { querySavedView: {}, storeSavedView: {}, deleteSavedView: {}, getAuditsForRecord: {} }, apps: {} })],
      [/^GET \/metaData\/table\/order$/, () => ({ name: 'order', label: 'Order', primaryKeyField: 'id', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, status: { name: 'status', label: 'Status', type: 'STRING' } }, clientCapabilities: { savedViews: { available: true, queryProcessName: 'querySavedView', storeProcessName: 'storeSavedView', deleteProcessName: 'deleteSavedView' }, audits: { available: true, processName: 'getAuditsForRecord' } } })],
      [/^POST \/processes\/querySavedView\/init$/, () => ({ type: 'COMPLETE', processUUID: 'q', values: { savedViewList: views.map((v) => ({ values: v })) } })],
      [/^POST \/processes\/storeSavedView\/init$/, (r) => {
        const record = { ...r.values, id: r.values.id ?? 3, userId: 'me@example.com' }
        const i = views.findIndex((v) => v.id === record.id)
        if (i >= 0) views[i] = record
        else views.push(record)
        return { type: 'COMPLETE', processUUID: 's', values: { savedViewList: [{ values: record }] } }
      }],
      [/^POST \/processes\/deleteSavedView\/init$/, (r) => { views.splice(views.findIndex((v) => v.id === r.values.id), 1); return { type: 'COMPLETE', processUUID: 'd', values: {} } }],
      [/^POST \/table\/order\/count$/, () => ({ count: 4 })],
      [/^POST \/table\/order\/query$/, () => ({ records: [{ values: { id: 1, status: 'open' } }] })],
      [/^POST \/processes\/getAuditsForRecord\/init$/, () => ({ type: 'COMPLETE', processUUID: 'a', values: { audits: [
        { values: { id: 2, message: 'Record was Edited', timestamp: '2026-10-31T12:00:00Z', auditUserId: 1, 'auditDetail.id': 5, 'auditDetail.fieldName': 'status', 'auditDetail.oldValue': 'new', 'auditDetail.newValue': 'open' }, displayValues: { auditUserId: 'Ann' } },
        { values: { id: 1, message: 'Record was Inserted', timestamp: '2026-10-30T12:00:00Z', auditUserId: 1, 'auditDetail.id': null }, displayValues: { auditUserId: 'Ann' } },
      ], distinctCount: 2 } })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('saved-view list: yours first, shared by their owner, quick views counted', async () => {
    const r = await qqq(['saved-view', 'list', 'order', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /1,Mine,you,/)
    assert.match(r.stdout, /2,Shared,shared by bob@example.com,quickView,.*,4/)
  })

  test('opening a view drops removed fields with a warning; the view filter is sent', async () => {
    const r = await qqq(['table', 'query', 'order', '--view', 'Mine', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /warning: .*gone/)
    const body = stub.requests.filter((q) => q.path === '/table/order/query').at(-1)!.json as { filter: { criteria: J[]; limit: number } }
    assert.deepEqual(body.filter.criteria, [{ fieldName: 'status', operator: 'EQUALS', values: ['open'] }])
    assert.equal(body.filter.limit, 10)
  })

  test('save, duplicate refused, rename, delete', async () => {
    const save = await qqq(['saved-view', 'save', 'order', '--name', 'Late', '-w', 'status = late', '-O', 'csv'])
    assert.equal(save.code, 0, save.stderr)
    assert.match(JSON.stringify(views.find((v) => v.label === 'Late')), /late/)
    const dup = await qqq(['saved-view', 'save', 'order', '--name', 'Late', '-w', 'status = x'])
    assert.equal(dup.code, 2)
    const rename = await qqq(['saved-view', 'rename', 'order', 'Late', 'Later'])
    assert.equal(rename.code, 0, rename.stderr)
    assert.ok(views.some((v) => v.label === 'Later'))
    const unknown = await qqq(['saved-view', 'open', 'order', 'Nope'])
    assert.equal(unknown.code, 2)
    const del = await qqq(['saved-view', 'delete', 'order', 'Later', '--yes'])
    assert.equal(del.code, 0, del.stderr)
    assert.ok(!views.some((v) => v.label === 'Later'))
  })

  test('audit list: newest first, who, what changed', async () => {
    const r = await qqq(['--utc', 'audit', 'list', 'order', '1', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    const lines = r.stdout.trim().split('\n')
    assert.match(lines[1]!, /2026-10-31T12:00:00Z,Ann,update,Status: new -> open/)
    assert.match(r.stdout, /Status: new -> open/)
    assert.match(lines.at(-1)!, /2026-10-30T12:00:00Z,Ann,insert/)
  })
})
