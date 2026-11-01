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


test('render model: fieldValueList indent and icons, generic and html, smallLine description, multiTable labels, quickSight, rowBuilder, child list without association, every block type, chrome footer, empty states', () => {
  const text = (d: unknown) => blocksToText(widgetToBlocks(d))
  assert.match(text({ type: 'fieldValueList', fields: [{ name: 'a', label: 'Alpha' }, { name: 'b', label: 'Beta' }], record: { values: { a: 1 }, displayValues: { b: 'two' } }, fieldIndentLevels: { b: 1 }, fieldLabelPrefixIconNames: { a: 'star' } }), /• Alpha\s+1[\s\S]*  Beta\s+two/)
  assert.equal(text({ type: 'fieldValueList', fields: [] }), 'No values to show')
  assert.match(text({ type: 'generic', label: 'G', sublabel: 'sub', html: '<p>Hi <b>there</b></p>', footerHTML: '<i>foot</i>' }), /G — sub[\s\S]*Hi there[\s\S]*foot/)
  assert.equal(text({ type: 'html', html: '<script>x</script><p>safe</p>' }).includes('safe'), true)
  assert.match(text({ type: 'smallLineChart', label: 'Trend', description: '<b>last 7 days</b>', chartData: { labels: ['a', 'b'], datasets: [{ label: 'n', data: [1, 2] }] } }), /Trend — last 7 days/)
  assert.match(text({ type: 'multiTable', tables: [{ label: 'First', columns: [{ accessor: 'x' }], rows: [{ x: 1 }] }, { label: 'Second', columns: [{ accessor: 'y' }], rows: [{ y: 2 }] }] }), /First[\s\S]*Second/)
  assert.match(text({ type: 'quickSightChart', url: 'https://qs.example/embed' }), /https:\/\/qs.example\/embed/)
  assert.equal(text({ type: 'quickSightChart' }), 'No dashboard is available to embed.')
  assert.match(text({ type: 'rowBuilder', records: [{ values: { sku: 'A1', qty: 2 } }] }), /sku\s+qty[\s\S]*A1\s+2/)
  assert.match(text({ type: 'childRecordList', childTableMetaData: { label: 'Lines', fields: { sku: { label: 'SKU' } } }, queryOutput: { records: [{ values: { sku: 'Z9' } }] }, totalRows: 1 }), /SKU[\s\S]*Z9[\s\S]*1 Lines/)
  const all = text({ type: 'composite', blocks: ['TEXT', 'BIG_NUMBER', 'NUMBER_ICON_BADGE', 'UP_OR_DOWN_NUMBER', 'PROGRESS_BAR', 'DIVIDER', 'TABLE_SUB_ROW_DETAIL_ROW', 'INPUT_FIELD', 'BUTTON', 'IMAGE', 'AUDIO', 'ICON'].map((t) => ({ blockTypeName: t, values: { text: `t-${t}`, number: 3, label: `l-${t}`, value: 'v', percent: 40, heading: 'h', path: '/a.mp3', alt: 'logo', name: 'star', fieldMetaData: { name: 'f', label: 'F', type: 'STRING' } } })) })
  for (const s of ['t-TEXT', 'h: 3', 'l-NUMBER_ICON_BADGE: 3', '▼ 3', 'h: ████████░░░░░░░░░░░░ v', 'l-TABLE_SUB_ROW_DETAIL_ROW', 'F: [v]', '[ l-BUTTON ]', '[image logo]', '[audio /a.mp3]', '[star]']) assert.ok(all.includes(s), s)
  assert.equal(text({ type: 'statistics' }), 'No value')
  assert.equal(text({ type: 'barChart', chartData: { labels: [], datasets: [] } }), 'No chart data available')
  assert.equal(text({ type: 'parentWidget' }), 'No child widgets to show')
})
