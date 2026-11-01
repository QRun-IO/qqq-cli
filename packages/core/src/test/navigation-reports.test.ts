/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appHome, findNavigationTargets, homePage, listReports, navigationTargets } from '../metadata/navigation.js'
import { buildPivot, findSavedReport, readSavedReport, reportFormat, reportRunPlan, savedReportFilterValues, shareScope } from '../reports/reports.js'

const metaData = {
  appTree: [{ type: 'APP', name: 'ops' }, { type: 'APP', name: 'dash' }],
  apps: {
    ops: { name: 'ops', label: 'Operations', children: [{ type: 'TABLE', name: 'order' }, { type: 'PROCESS', name: 'ship' }, { type: 'REPORT', name: 'sales' }, { type: 'APP', name: 'sub' }, { type: 'TABLE', name: 'secret' }] },
    sub: { name: 'sub', label: 'Sub App', children: [{ type: 'REPORT', name: 'denied' }] },
    dash: { name: 'dash', label: 'Dashboard', widgets: ['w1'], children: [] },
  },
  tables: { order: { name: 'order', label: 'Orders' }, secret: { name: 'secret', label: 'Secret', readPermission: false } },
  processes: { ship: { name: 'ship', label: 'Ship Orders' } },
  reports: { sales: { name: 'sales', label: 'Sales Report', processName: 'sales.run', tableName: 'order' }, denied: { name: 'denied', label: 'Denied', hasPermission: false } },
  widgets: { w1: { name: 'w1', label: 'W1' } },
}

test('navigation targets list permitted apps, tables, processes and reports with their app', () => {
  assert.deepEqual(navigationTargets(metaData).map((t) => `${t.type}:${t.name}@${t.app}`), ['APP:ops@', 'TABLE:order@Operations', 'PROCESS:ship@Operations', 'REPORT:sales@Operations', 'APP:sub@Operations', 'APP:dash@'])
  assert.deepEqual(findNavigationTargets(metaData, 'ord').map((t) => t.name), ['order', 'ship'])
  assert.deepEqual(findNavigationTargets(metaData, 'ord', ['TABLE']).map((t) => t.name), ['order'])
})

test('home page: counts, quick actions and app cards', () => {
  const home = homePage(metaData)
  assert.deepEqual(home.counts, { apps: 3, tables: 1, processes: 1, reports: 1, widgets: 1 })
  assert.deepEqual(home.quickActions.map((a) => a.name), ['ship'])
  assert.deepEqual(home.apps.map((a) => [a.label, a.tables, a.processes, a.reports, a.widgets, a.apps]), [['Operations', 1, 1, 1, 0, 1], ['Dashboard', 0, 0, 0, 1, 0]])
})

test('reports are listed under their app and in the app home Reports group', () => {
  assert.deepEqual(listReports(metaData).map((r) => [r.name, r.app]), [['sales', 'ops']])
  assert.deepEqual(appHome(metaData, 'ops')!.sections.find((s) => s.label === 'Reports')!.items.map((i) => i.name), ['sales'])
  assert.deepEqual(reportRunPlan(metaData, 'sales'), { label: 'Sales Report', processName: 'sales.run', hasPermission: true })
  assert.equal(reportRunPlan(metaData, 'denied')!.hasPermission, false)
  assert.equal(reportFormat('xlsx'), 'XLSX')
  assert.throws(() => reportFormat('doc'), /Unknown report format/)
})

test('saved reports: read, find, filter values, pivot definitions, share scopes', () => {
  const r = readSavedReport({ values: { id: 3, label: 'Open orders', tableName: 'order', userId: 'me', queryFilterJson: '{"criteria":[{"fieldName":"status","operator":"EQUALS","values":["open"]}],"booleanOperator":"AND"}', columnsJson: '{"columns":[{"name":"id","isVisible":true}]}', pivotTableJson: '{"rows":[{"fieldName":"state"}],"columns":[],"values":[{"fieldName":"total","function":"SUM"}]}' } })
  assert.equal(r.filter!.criteria[0]!.fieldName, 'status')
  assert.deepEqual(r.columns, [{ name: 'id', isVisible: true }])
  assert.equal(r.pivot!.values[0]!.function, 'SUM')
  assert.equal(findSavedReport([r], 'open ORDERS').id, 3)
  assert.throws(() => findSavedReport([r], 'x'), /No saved report "x"/)
  assert.deepEqual(savedReportFilterValues({ criteria: [], booleanOperator: 'AND' }, ['id', 'name']), { queryFilterJson: '{"criteria":[],"booleanOperator":"AND"}', columnsJson: '{"columns":[{"name":"id","isVisible":true},{"name":"name","isVisible":true}]}' })
  assert.deepEqual(buildPivot({ rows: ['state'], values: ['total', 'count:id'] }, ['state', 'total', 'id']), { rows: [{ fieldName: 'state' }], columns: [], values: [{ fieldName: 'total', function: 'SUM' }, { fieldName: 'id', function: 'COUNT' }] })
  assert.throws(() => buildPivot({ values: ['MEDIAN:x'] }), /one of SUM/)
  assert.throws(() => buildPivot({ rows: ['nope'], values: ['x'] }, ['x']), /nope: not a field/)
  assert.equal(shareScope('read-only'), 'READ_ONLY')
  assert.equal(shareScope('Read and Edit'), 'READ_WRITE')
  assert.throws(() => shareScope('admin'))
})
