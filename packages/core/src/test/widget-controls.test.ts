/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { datePickerValue, reconcileSelections, resolveDropdowns, widgetCsv, widgetParams } from '../widgets/controls.js'
import { blocksToText, widgetToBlocks } from '../widgets/render-model.js'

const meta = { name: 'w', dropdowns: [{ type: 'POSSIBLE_VALUE_SOURCE', label: 'Region', isRequired: true }, { type: 'DATE_PICKER', label: 'As of' }] }
const data = { type: 'table', dropdownNameList: ['region', 'asOf'], dropdownLabelList: ['Region'], dropdownDataList: [[{ id: 1, label: 'North' }, { id: 2, label: 'South' }], []], dropdownDefaultValueList: [2, '1/2/2026'] }

test('dropdowns pair with metadata; defaults apply; stale selections drop; params include choices', () => {
  const r = reconcileSelections(data, meta, {})
  assert.deepEqual(r.selections, { region: '2', asOf: '1/2/2026' })
  const stale = reconcileSelections(data, meta, { region: '9' })
  assert.deepEqual(stale, { selections: { region: null, asOf: '1/2/2026' }, dropped: ['region'] })
  const dd = resolveDropdowns(data, meta, r.selections)
  assert.deepEqual(dd.map((d) => [d.paramName, d.label, d.type, d.value, d.isRequired]), [['region', 'Region', 'POSSIBLE_VALUE_SOURCE', '2', true], ['asOf', 'As of', 'DATE_PICKER', '1/2/2026', false]])
  assert.deepEqual(widgetParams({ id: '5' }, { region: '1', asOf: null }), { id: '5', region: '1' })
  assert.equal(datePickerValue('2026-03-04'), '3/4/2026')
})

test('export CSV: csvData first, else the table rows', () => {
  assert.equal(widgetCsv({ csvData: [['a', 'b'], ['1', 'x,y']] }), 'a,b\n1,"x,y"\n')
  assert.match(widgetCsv({ type: 'table', columns: [{ accessor: 'n', header: 'N' }], rows: [{ n: 1 }] })!, /^N\n1/)
  assert.equal(widgetCsv({ type: 'table', columns: [], rows: [] }), undefined)
})

test('render model: dynamicForm, cronUI with record, usaMap, location, untyped chart, single block, unsupported block, hidden alert, typed cells', () => {
  const text = (d: unknown, ctx = {}) => blocksToText(widgetToBlocks(d, ctx))
  assert.match(text({ type: 'dynamicForm', fieldList: [{ name: 'a', label: 'Alpha', isRequired: true }], recordOfFieldValues: { values: { a: 'x' } } }), /Alpha \*\s+x/)
  assert.equal(text({ type: 'dynamicForm', fieldList: [], noFieldsMessage: 'Pick a type first' }), 'Pick a type first')
  assert.match(text({ type: 'cronUI', cronDescription: 'Every day at 9' }, { meta: { defaultValues: { cronExpressionFieldName: 'cron', timeZoneFieldName: 'tz' } }, record: { values: { cron: '0 0 9 * * ?', tz: 'UTC' } } }), /0 0 9 \* \* \?[\s\S]*Every day at 9[\s\S]*UTC/)
  assert.equal(text({ type: 'cronUI' }, { meta: { defaultValues: { cronExpressionFieldName: 'cron' } }, record: { values: {} } }), 'No schedule set')
  assert.match(text({ type: 'usaMap', mapMarkerList: [{ name: 'Chester', latitude: 37.9, longitude: -89.8 }] }), /Chester\s+37.9\s+-89.8[\s\S]*1 marker/)
  assert.match(text({ type: 'location', title: 'HQ', description: 'Main office', location: '1 Main St', footerText: 'open 9-5' }), /Main office[\s\S]*1 Main St[\s\S]*open 9-5/)
  assert.match(text({ chartData: { labels: ['a'], datasets: [{ label: 'n', data: [3] }] } }), /a.*3/)
  assert.match(text({ blockTypeName: 'BIG_NUMBER', values: { heading: 'Open', number: 12 } }), /Open: 12/)
  assert.match(text({ type: 'composite', blocks: [{ blockTypeName: 'WIGGLE' }] }), /Unsupported block type WIGGLE/)
  assert.deepEqual(widgetToBlocks({ type: 'alert', hideWidget: true, html: 'x' }), [])
  assert.deepEqual(widgetToBlocks({ type: 'alert' }), [])
  assert.match(text({ type: 'table', columns: [{ accessor: 'n', header: 'N' }, { accessor: 'h', header: 'H', type: 'html' }], rows: [{ n: 1234567, h: '<b>bold</b>' }] }), /1,234,567\s+bold/)
  assert.match(text({ type: 'composite', blocks: [{ blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'w', label: 'When', type: 'DATE_TIME' }, value: '2026-01-02T03:04:05Z' } }] }), /When: \[2026-01-0\d \d\d:04:05/)
})
