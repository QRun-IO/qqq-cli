/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Reports, saved reports, schedules and sharing against a stub (the sample has no reports). */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, StubResponse, startStub, type J, type Stub } from './stub.js'

const CSV = 'id,name\n1,Ann\n2,Lee\n'
const SUMMARY = 'state,count\nIL,2\nTotal,2\n'

describe('reports against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let dir: string
  let saved: J = { id: 3, label: 'Open orders', tableName: 'order', userId: 'me@example.com', queryFilterJson: JSON.stringify({ criteria: [{ fieldName: 'status', operator: 'EQUALS', values: ['open'] }], booleanOperator: 'AND' }), columnsJson: JSON.stringify({ columns: [{ name: 'id', isVisible: true }, { name: 'name', isVisible: true }] }), pivotTableJson: null }
  const schedules: J[] = []
  let shares: J[] = [{ shareId: 1, audienceType: 'user', audienceId: 'bob@example.com', audienceLabel: 'Bob', scopeId: 'READ_ONLY' }]
  const token = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.y`
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: token, ...box.env })
  const reportSteps = (name: string) => [
    { name: 'input', label: 'Input', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'state', label: 'State', type: 'STRING', isRequired: true }] },
    { name: 'access', label: 'Download', components: [{ type: 'DOWNLOAD_FORM' }], viewFields: [] },
  ].map((s) => ({ ...s, name: `${name}-${s.name}` }))
  before(async () => {
    box = sandbox()
    dir = mkdtempSync(join(tmpdir(), 'qqq-reports-'))
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { order: { name: 'order', label: 'Order' }, savedReport: { name: 'savedReport', label: 'Saved Report' }, scheduledReport: { name: 'scheduledReport', label: 'Scheduled Report' } },
        processes: { 'orders.run': { name: 'orders.run', label: 'Orders Report' }, renderSavedReport: { name: 'renderSavedReport', label: 'Render Saved Report' } },
        reports: { orders: { name: 'orders', label: 'Orders', processName: 'orders.run' }, summary: { name: 'summary', label: 'Summary' } },
        apps: { ops: { name: 'ops', label: 'Operations', children: [{ type: 'REPORT', name: 'orders' }, { type: 'REPORT', name: 'summary' }] } }, appTree: [{ type: 'APP', name: 'ops' }] })],
      [/^GET \/metaData\/table\/order$/, () => ({ name: 'order', label: 'Order', primaryKeyField: 'id', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, name: { name: 'name', label: 'Name', type: 'STRING' }, status: { name: 'status', label: 'Status', type: 'STRING' }, state: { name: 'state', label: 'State', type: 'STRING' }, total: { name: 'total', label: 'Total', type: 'DECIMAL' } } })],
      [/^GET \/metaData\/table\/savedReport$/, () => ({ name: 'savedReport', label: 'Saved Report', primaryKeyField: 'id', fields: {}, shareableTableMetaData: { audienceTypes: { user: { name: 'user' }, group: { name: 'group' } } } })],
      [/^GET \/metaData\/process\/orders\.run$/, () => ({ name: 'orders.run', label: 'Orders Report', frontendSteps: reportSteps('orders') })],
      [/^GET \/metaData\/process\/renderSavedReport$/, () => ({ name: 'renderSavedReport', label: 'Render Saved Report', tableName: 'savedReport', frontendSteps: [{ name: 'output', label: 'Output', components: [{ type: 'DOWNLOAD_FORM' }] }] })],
      [/^POST \/processes\/orders\.run\/init$/, () => ({ type: 'COMPLETE', processUUID: 'r1', nextStep: 'orders-input', values: {} })],
      [/^POST \/processes\/orders\.run\/r1\/step\/orders-input$/, (r) => ({ type: 'COMPLETE', processUUID: 'r1', nextStep: 'orders-access', values: { downloadFileName: `orders-${String(r.values.state)}.${String(r.values.reportFormat).toLowerCase()}`, storageTableName: 'reports', storageReference: 'ref-1' } })],
      [/^POST \/processes\/renderSavedReport\/init$/, (r) => ({ type: 'COMPLETE', processUUID: 'r2', nextStep: 'output', values: { downloadFileName: `Open orders.${String(r.values.reportFormat).toLowerCase()}`, storageTableName: 'reports', storageReference: `saved-${String(r.values.recordIds)}` } })],
      [/^GET \/download\/(.+)$/, () => new StubResponse(200, CSV, { 'content-type': 'text/csv' })],
      [/^GET \/reports\/summary$/, (r) => new StubResponse(200, r.query.get('format') === 'csv' ? SUMMARY : 'x', { 'content-type': 'text/csv' })],
      [/^POST \/table\/savedReport\/query$/, () => ({ records: [{ values: saved }, { values: { id: 4, label: 'Bob report', tableName: 'order', userId: 'bob@example.com' } }] })],
      [/^PATCH \/table\/savedReport\/3$/, (r) => { saved = { ...saved, ...(r.json as J) }; return { record: { values: saved } } }],
      [/^POST \/table\/order\/query$/, () => ({ records: [{ values: { id: 1, name: 'Ann' } }, { values: { id: 2, name: 'Lee' } }] })],
      [/^POST \/table\/order\/count$/, () => ({ count: 2 })],
      [/^POST \/api\/v2\/table\/order\/query$/, () => ({ records: [{ values: { id: 9, name: 'Via API' } }] })],
      [/^POST \/api\/v2\/table\/order\/count$/, () => ({ count: 1 })],
      [/^POST \/table\/scheduledReport$/, (r) => { const rec = { id: schedules.length + 1, ...(r.json as J), cronDescription: 'At 07:00, Monday through Friday' }; schedules.push(rec); return { record: { values: rec } } }],
      [/^POST \/table\/scheduledReport\/query$/, () => ({ records: schedules.map((s) => ({ values: s })) })],
      [/^POST \/processes\/getSharedRecords\/init$/, () => ({ type: 'COMPLETE', processUUID: 's', values: { resultList: shares.map((s) => ({ values: s })) } })],
      [/^POST \/processes\/insertSharedRecord\/init$/, (r) => {
        if (r.values.recordId === '4') return { type: 'ERROR', processUUID: 's', userFacingError: 'You do not have permission to share this record.' }
        shares.push({ shareId: shares.length + 1, audienceType: r.values.audienceType, audienceId: r.values.audienceId, audienceLabel: r.values.audienceId, scopeId: r.values.scopeId })
        return { type: 'COMPLETE', processUUID: 's', values: {} }
      }],
      [/^POST \/processes\/editSharedRecord\/init$/, (r) => { shares = shares.map((s) => (s.shareId === r.values.shareId ? { ...s, scopeId: r.values.scopeId } : s)); return { type: 'COMPLETE', processUUID: 's', values: {} } }],
      [/^POST \/processes\/deleteSharedRecord\/init$/, (r) => { shares = shares.filter((s) => s.shareId !== r.values.shareId); return { type: 'COMPLETE', processUUID: 's', values: {} } }],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('reports are listed under their app', async () => {
    const r = await qqq(['report', 'list', '-O', 'csv'])
    assert.match(r.stdout, /orders,Orders,,ops/)
    const home = await qqq(['apps', 'show', 'ops', '-O', 'csv', '--no-counts'])
    assert.match(home.stdout, /Reports,report,orders,Orders/)
  })

  test('a report with a process: required inputs, then the file from the download route', async () => {
    const missing = await qqq(['report', 'run', 'orders', '--format', 'csv'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /--values state=…/)
    const r = await qqq(['report', 'run', 'orders', '--format', 'xlsx', '-v', 'state=IL', '--out-dir', dir])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(readdirSync(dir).includes('orders-IL.xlsx'))
    const init = stub.requests.find((q) => q.path === '/processes/orders.run/init')!
    assert.equal(init.values.reportName, 'orders')
    assert.equal(stub.requests.find((q) => /\/step\/orders-input$/.test(q.path))!.values.reportFormat, 'XLSX')
    assert.ok(stub.requests.some((q) => q.path === '/download/orders-IL.xlsx' && q.query.get('storageReference') === 'ref-1'))
  })

  test('a report without a process streams from the report route', async () => {
    const out = join(dir, 'summary.csv')
    const r = await qqq(['report', 'run', 'summary', '--format', 'csv', '--out', out])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(out, 'utf8'), SUMMARY)
  })

  test('saved reports: list, show the filter, columns and pivot, preview, run', async () => {
    const list = await qqq(['saved-report', 'list', '-O', 'csv'])
    assert.match(list.stdout, /3,Open orders,order,you,,status EQUALS open/)
    assert.match(list.stdout, /4,Bob report,order,shared by bob@example.com/)
    const show = await qqq(['saved-report', 'show', 'Open orders', '-O', 'table'])
    assert.match(show.stdout, /Match all of:\n {2}Status equals open\nColumns: Id, Name\nPivot table:\nNo pivot table: this report does not use one\./)
    const preview = await qqq(['saved-report', 'preview', '3', '-l', '1', '-O', 'table'])
    assert.match(preview.stdout, /Ann/)
    assert.match(preview.stdout, /2 in all/)
    const api = await qqq(['saved-report', 'preview', '3', '--api-path', '/api/', '--api-version', 'v2', '-O', 'table'])
    assert.equal(api.code, 0, api.stderr)
    assert.match(api.stdout, /Via API/)
    const paged = await qqq(['saved-report', 'preview', '3', '-l', '1', '--skip', '1', '-o', '-name', '-O', 'json'])
    assert.equal(paged.code, 0, paged.stderr)
    const body = stub.requests.filter((q) => q.path === '/table/order/query').at(-1)!.json as { filter: { skip: number; limit: number; orderBys: J[] } }
    assert.deepEqual([body.filter.skip, body.filter.limit, body.filter.orderBys], [1, 1, [{ fieldName: 'name', isAscending: false }]])
    const run = await qqq(['saved-report', 'run', '3', '--format', 'csv', '--out-dir', dir])
    assert.equal(run.code, 0, run.stderr)
    assert.match(stub.requests.find((q) => q.path === '/processes/renderSavedReport/init')!.body, /name="recordIds"\r\n\r\n3\r\n/)
  })

  test('saved reports: change filter, sort and columns; set and clear the pivot table', async () => {
    const set = await qqq(['saved-report', 'set', '3', '-w', 'state = ${variable.state}', '-o', '-total', '--columns', 'id,total'])
    assert.equal(set.code, 0, set.stderr)
    assert.deepEqual(JSON.parse(String(saved.queryFilterJson)).orderBys, [{ fieldName: 'total', isAscending: false }])
    assert.equal(JSON.parse(String(saved.queryFilterJson)).criteria[0].values[0].type, 'FilterVariableExpression')
    assert.equal(saved.columnsJson, '{"columns":[{"name":"id","isVisible":true},{"name":"total","isVisible":true}]}')
    const pivot = await qqq(['saved-report', 'pivot', '3', '--rows', 'state', '--values', 'SUM:total,COUNT:id'])
    assert.match(pivot.stdout, /Values +Sum of Total, Count of Id/)
    const clear = await qqq(['saved-report', 'pivot', '3', '--clear'])
    assert.match(clear.stdout, /No pivot table/)
    assert.equal(saved.pivotTableJson, null)
  })

  test('schedules: create one and see its cron description', async () => {
    const r = await qqq(['saved-report', 'schedule', '3', '--cron', '0 0 7 ? * MON-FRI', '--time-zone', 'America/Chicago', '--to', 'me@example.com', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    const list = await qqq(['saved-report', 'schedules', '3', '-O', 'csv'])
    assert.match(list.stdout, /1,0 0 7 \? \* MON-FRI,"At 07:00, Monday through Friday",America\/Chicago,yes,me@example.com,XLSX/)
  })

  test('sharing: list, add read-only, change to read and edit, remove; only the owner may share', async () => {
    assert.match((await qqq(['share', 'list', 'savedReport', '3', '-O', 'csv'])).stdout, /1,Bob,user,Read-Only/)
    const add = await qqq(['share', 'add', 'savedReport', '3', 'group:7', '--scope', 'read-only'])
    assert.equal(add.code, 0, add.stderr)
    const scope = await qqq(['share', 'scope', 'savedReport', '3', '2', 'read-write'])
    assert.equal(scope.code, 0, scope.stderr)
    assert.match((await qqq(['share', 'list', 'savedReport', '3', '-O', 'csv'])).stdout, /2,7,group,Read and Edit/)
    const remove = await qqq(['share', 'remove', 'savedReport', '3', '2', '--yes'])
    assert.equal(remove.code, 0, remove.stderr)
    assert.doesNotMatch((await qqq(['share', 'list', 'savedReport', '3', '-O', 'csv'])).stdout, /group/)
    const notOwner = await qqq(['share', 'add', 'savedReport', '4', 'user:x'])
    assert.equal(notOwner.code, 2)
    assert.match(notOwner.stderr, /permission to share this record/)
  })
})
