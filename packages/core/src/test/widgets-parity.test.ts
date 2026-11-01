/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksToText, filterAndColumnsBlocks, pivotTableBlocks, widgetToBlocks } from '../widgets/render-model.js'
import { loadDashboard, loadWidget } from '../widgets/loader.js'

const text = (data: unknown, context = {}) => blocksToText(widgetToBlocks(data, context))

test('generic, location and usaMap render their payload fields', () => {
  assert.equal(text({ type: 'generic', html: '<b>Hi</b> there' }), 'Hi there')
  assert.equal(text({ type: 'location', title: 'HQ', imageUrl: 'https://x/i.png', description: 'Main office', location: '1 Main St', footerText: 'Open 9-5' }), 'HQ\nImage: https://x/i.png\nMain office\n1 Main St\n----------------------------------------\nOpen 9-5')
  assert.match(text({ type: 'usaMap', mapMarkerList: [{ name: 'Chester', latitude: 37.9, longitude: -89.8 }, { name: 'bad' }] }), /Chester +37\.9 +-89\.8/)
  assert.equal(text({ type: 'usaMap', mapMarkerList: [] }), 'No locations to show')
})

test('multiStatistics reads statisticList[].value with separators, header, subheader and icon', () => {
  const out = text({ type: 'multiStatistics', title: 'Stats', statisticsGroupData: [{ icon: 'check', header: 'This Week', subheader: '(1/1)', statisticList: [{ label: 'Red', value: 15000 }] }] })
  assert.equal(out, 'Stats\n(check) This Week (1/1)\nRed: 15,000')
  assert.equal(text({ type: 'multiStatistics', statisticsGroupData: [] }), 'No statistics available')
})

test('chrome: label and sublabel, payload or metadata footer HTML, dropdown message, denied', () => {
  assert.equal(text({ type: 'html', text: 'x', footerHTML: '<i>foot</i>' }, { meta: { label: 'Box', type: 'html' } }), 'Box\nx\nfoot')
  assert.equal(text({ type: 'table', columns: [], rows: [], sublabel: 'sub' }, { meta: { label: 'T', footerHTML: 'meta foot' } }), 'T — sub\nNo rows found\nmeta foot')
  assert.equal(text({ type: 'table', dropdownNeedsSelectedText: 'Choose a <b>store</b>' }, { meta: { label: 'Sales' } }), 'Sales\n[INFO] Choose a store')
  assert.equal(text({}, { meta: { label: 'X', hasPermission: false } }), 'X\n[WARNING] You do not have permission to view this data.')
})

test('every display type has an empty state', () => {
  for (const [type, expected] of [['table', 'No rows found'], ['multiTable', 'No tables to show'], ['barChart', 'No chart data available'], ['stepper', 'No steps to show'], ['fieldValueList', 'No values to show'], ['parentWidget', 'No child widgets to show'], ['rowBuilder', 'No rows'], ['process', 'No process is available.'], ['quickSightChart', 'No dashboard is available to embed.'], ['childRecordList', 'No records found']] as const) {
    assert.equal(text({ type }), expected, type)
  }
  assert.equal(text({ type: 'table', columns: [{ accessor: 'a' }], rows: [], noRowsFoundHTML: '<p>Nothing yet</p>' }), 'Nothing yet')
})

test('table extras: hidden columns, separators, html, tooltip, image, composite cells, sub-rows, sticky last row, link', () => {
  const out = text({ type: 'table', linkText: 'All', linkURL: '/all', fixedStickyLastRow: true, columns: [{ accessor: 'name', header: 'Name' }, { accessor: 'n', header: 'N' }, { accessor: 'h', header: 'H', type: 'htmlAndTooltip' }, { accessor: 'img', header: 'Img', type: 'image' }, { accessor: 'c', header: 'C', type: 'composite' }, { accessor: 'x', header: 'X', type: 'hidden' }],
    rows: [{ name: 'a', n: 12345, h: '<b>b</b>', tooltip: 'tip', imageLabel: 'Boxes', imageTotal: 3, x: 'secret', c: { blocks: [{ blockTypeName: 'TEXT', values: { text: 'cell' } }] }, subRows: [{ name: 'a1', n: 1 }] }, { name: 'Total', n: 12346 }] })
  assert.match(out, /^All: \/all/)
  assert.match(out, /a +12,345 +b \(tip\) +Boxes 3 +cell/)
  assert.match(out, /↳ a1/)
  assert.match(out, /---\n.*Total +12,346/s)
  assert.doesNotMatch(out, /secret|X/)
})

test('composite renders every block type; a payload that is one leaf block renders that block', () => {
  const out = text({ type: 'composite', blocks: [
    { blockTypeName: 'TEXT', values: { interpolatedText: 'Hello', startIcon: 'star' }, tooltip: { title: 'tip' } },
    { blockTypeName: 'TEXT', values: { text: 'Heads up' }, styles: { format: 'alert' } },
    { blockTypeName: 'NUMBER_ICON_BADGE', values: { number: 4, iconName: 'mail' } },
    { blockTypeName: 'UP_OR_DOWN_NUMBER', values: { number: '5%', isUp: true, isGood: true, context: 'vs last' } },
    { blockTypeName: 'TABLE_SUB_ROW_DETAIL_ROW', values: { label: 'L', value: 'V' } },
    { blockTypeName: 'PROGRESS_BAR', values: { heading: 'Done', percent: 50 } },
    { blockTypeName: 'DIVIDER' },
    { blockTypeName: 'BIG_NUMBER', values: { heading: 'Big', number: '1,234', context: 'ctx' } },
    { blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'q', label: 'Qty', type: 'INTEGER' }, value: 3 } },
    { blockTypeName: 'BUTTON', values: { label: 'Go', actionCode: 'go' } },
    { blockTypeName: 'AUDIO', values: { path: '/a.mp3' } },
    { blockTypeName: 'IMAGE', values: { path: '/i.png', alt: 'Logo' } },
    { blockTypeName: 'ICON', values: { name: { name: 'check' } } },
    { blockTypeName: 'COMPOSITE', values: { blocks: [{ blockTypeName: 'TEXT', values: { text: 'nested' } }] } },
  ] })
  for (const expected of ['(star) Hello (tip)', '[INFO] Heads up', '(mail): 4', 'vs last (good)', 'L  V', 'Done: ██████████░░░░░░░░░░ 50.0%', '----', 'Big: 1,234 ctx', 'Qty: [3]', '[ Go ]', '[audio /a.mp3]', '[image Logo] /i.png', '[check]', 'nested']) assert.ok(out.includes(expected), expected)
  assert.equal(text({ type: 'block', blockTypeName: 'BIG_NUMBER', values: { heading: 'Solo', number: 7 } }), 'Solo: 7')
})

test('editor and developer widgets render read-only: cronUI, dynamicForm, pivotTableSetup, filterAndColumnsSetup, rowBuilder, process', () => {
  assert.equal(text({ type: 'cronUI', cronDescription: 'Every hour' }, { meta: { type: 'cronUI', defaultValues: { cronExpressionFieldName: 'cron', timeZoneFieldName: 'tz' } }, record: { cron: '0 0 * * * ?', tz: 'UTC' } }), 'Cron Expression  0 0 * * * ?\nDescription      Every hour\nTime Zone        UTC')
  assert.equal(text({ type: 'cronUI' }, { meta: { type: 'cronUI' }, record: {} }), 'No schedule set')
  assert.equal(text({ type: 'dynamicForm', fieldList: [{ name: 'a', label: 'A' }], recordOfFieldValues: { values: { a: 1 }, displayValues: { a: 'One' } } }), 'A  One')
  assert.equal(text({ type: 'dynamicForm', fieldList: [], noFieldsMessage: 'Nothing to set' }), 'Nothing to set')
  assert.equal(text({ type: 'pivotTableSetup' }, { record: { pivotTableJson: JSON.stringify({ rows: [{ fieldName: 'state' }], columns: [], values: [{ fieldName: 'total', function: 'SUM' }] }) } }), 'Rows     state\nColumns  (none)\nValues   total (sum)')
  assert.equal(blocksToText(pivotTableBlocks({ pivotTableJson: JSON.stringify({ rows: [{ fieldName: 'state' }], columns: [], values: [{ fieldName: 'total', function: 'SUM' }] }) })), 'Rows     state\nColumns  None\nValues   Sum of total')
  assert.equal(text({ type: 'pivotTableSetup' }, { record: {} }), 'No pivot table: this report does not use one.')
  const saved = { queryFilterJson: JSON.stringify({ criteria: [{ fieldName: 'state', operator: 'EQUALS', values: ['IL'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: false }] }), columnsJson: JSON.stringify({ columns: [{ name: 'id', isVisible: true }, { name: 'x', isVisible: false }] }) }
  assert.match(text({ type: 'filterAndColumnsSetup' }, { record: saved }), /Filter +state equals IL\nSort +id descending\nColumns +id/)
  assert.equal(blocksToText(filterAndColumnsBlocks(saved)), 'Match all of:\n  state equals IL\nSorted by id descending\nColumns: id')
  assert.equal(text({ type: 'rowBuilder', records: [{ values: { a: 1 }, displayValues: { a: 'One' } }] }, { meta: { type: 'rowBuilder', defaultValues: { fields: [{ name: 'a', label: 'A' }] } } }), 'A\n---\nOne')
  assert.equal(text({ type: 'process', processMetaData: { name: 'greet', label: 'Greet' }, defaultValues: { x: 1 } }), 'Process: Greet (greet), with x=1')
})

type Route = [RegExp, (body: Record<string, unknown>) => unknown]
function fake(routes: Route[]): { fetch: typeof fetch; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init)
      const path = `${request.method} ${new URL(request.url).pathname.replace('/qqq/v1', '')}`
      paths.push(path)
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {}
      const route = routes.find(([re]) => re.test(path))
      return new Response(JSON.stringify(route ? route[1](body) : { code: 'NOT_FOUND', message: path }), { status: route ? 200 : 404, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  }
}

test('a parent widget loads its children once, skipping unknown and denied ones without a request, sized in twelfths', async () => {
  const server = fake([
    [/POST \/widget\/parent$/, () => ({ type: 'parentWidget', childWidgetNameList: ['a', 'denied', 'ghost'] })],
    [/POST \/widget\/a$/, (b) => ({ type: 'statistics', count: Number(b.id ?? 0) + 1 })],
  ])
  const widgets = { parent: { name: 'parent', label: 'Parent', type: 'parentWidget' }, a: { name: 'a', label: 'A', type: 'statistics', gridColumns: 6 }, denied: { name: 'denied', label: 'D', hasPermission: false } }
  const loaded = await loadWidget('http://q', server.fetch, 'parent', { widgets, params: { id: '41' } })
  const out = blocksToText(loaded.blocks)
  assert.match(out, /A — 6\/12\n42/)
  assert.match(out, /skipped: denied \(no permission\), ghost \(unknown widget\)/)
  assert.deepEqual(server.paths, ['POST /widget/parent', 'POST /widget/a'])
})

test('a dashboard loads every widget once, in declared order', async () => {
  const server = fake([[/POST \/widget\/(\w+)$/, () => ({ type: 'statistics', count: 1 })]])
  const names = Array.from({ length: 24 }, (_, i) => `w${i}`)
  const widgets = Object.fromEntries(names.map((n, i) => [n, { name: n, label: n.toUpperCase(), type: 'statistics', gridColumns: i % 2 ? 4 : 8 }]))
  const loaded = await loadDashboard('http://q', server.fetch, names, { widgets })
  assert.deepEqual(loaded.map((w) => w.name), names)
  assert.equal(server.paths.length, 24)
  assert.equal(new Set(server.paths).size, 24)
  assert.equal(loaded[1]!.gridColumns, 4)
})

test('data bag and script viewers read their records', async () => {
  const server = fake([
    [/POST \/widget\/bag$/, () => ({ type: 'dataBagViewer', queryParams: { id: 5 } })],
    [/GET \/table\/dataBag\/5$/, () => ({ record: { values: { id: 5, name: 'Settings' } } })],
    [/POST \/table\/dataBagVersion\/query$/, () => ({ records: [{ values: { id: 9, sequenceNo: 2, commitMessage: 'second', data: '{"a":1}' } }, { values: { id: 8, sequenceNo: 1 } }] })],
    [/POST \/widget\/code$/, () => ({ type: 'scriptViewer', queryParams: { id: 3 } })],
    [/GET \/table\/script\/3$/, () => ({ record: { values: { id: 3, name: 'check', currentScriptRevisionId: 30 } } })],
    [/POST \/table\/scriptRevision\/query$/, () => ({ records: [{ values: { id: 30, sequenceNo: 2 } }, { values: { id: 29, sequenceNo: 1 } }] })],
    [/POST \/table\/scriptRevisionFile\/query$/, () => ({ records: [{ values: { fileName: 'main.js', contents: 'return 1' } }] })],
  ])
  const widgets = { bag: { name: 'bag', label: 'Bag', type: 'dataBagViewer' }, code: { name: 'code', label: 'Code', type: 'scriptViewer' } }
  const bag = blocksToText((await loadWidget('http://q', server.fetch, 'bag', { widgets })).blocks)
  assert.match(bag, /Version 2 \(current\) +second/)
  assert.match(bag, /"a": 1/)
  const code = blocksToText((await loadWidget('http://q', server.fetch, 'code', { widgets })).blocks)
  assert.match(code, /2 \(current\)/)
  assert.match(code, /main\.js\nreturn 1/)
})

test('a seeded DATE_TIME input block is shown in the local zone with its seconds', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const out = text({ type: 'composite', blocks: [{ blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'at', label: 'At', type: 'DATE_TIME' }, value: '2026-03-08T07:30:45Z' } }] })
    assert.match(out, /At: \[2026-03-08 03:30:45 /)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
