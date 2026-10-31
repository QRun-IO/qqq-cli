/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksToText, htmlToText, widgetRows, widgetToBlocks } from '../widgets/render-model.js'

test('statistics, stepper and html become stat, steps and text blocks', () => {
  assert.deepEqual(widgetToBlocks({ type: 'statistics', count: '98.5%', countContext: 'of 481', percentageAmount: 3, percentageLabel: 'vs prev week', increaseIsGood: true }), [
    { kind: 'stat', value: '98.5%', context: 'of 481', delta: { amount: 3, label: 'vs prev week', good: true } },
  ])
  assert.equal(blocksToText(widgetToBlocks({ type: 'stepper', title: 'S', activeStep: 1, steps: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })), 'S\n[x] a\n[>] b\n[ ] c')
  assert.equal(htmlToText('<div style="x"><b>Purely</b> Custom<br>Use <a href="u">this</a>&nbsp;now</div>'), 'Purely Custom\nUse this now')
  assert.deepEqual(widgetToBlocks({ type: 'html', html: '<p>x</p>', text: 'already text' }), [{ kind: 'text', text: 'already text' }])
})

test('charts become series; one dataset prints as bars, several as a table', () => {
  const one = widgetToBlocks({ type: 'chart', title: 'Line', chartData: { labels: ['Jan', 'Feb'], datasets: [{ label: 'Units', data: [10, 5] }] } })
  assert.equal(one[1]!.kind, 'series')
  const text = blocksToText(one, { width: 60, ascii: true })
  assert.match(text, /Jan\s+#+\s+10/)
  assert.match(text, /Feb\s+#+\s+5/)
  const two = widgetToBlocks({ type: 'stackedBarChart', chartData: { labels: ['Apple'], datasets: [{ label: 'One', data: [1] }, { label: 'Two', data: [2] }] }, chartSubheaderData: { mainNumber: 42, vsPreviousPercent: -5, vsDescription: 'vs prev', isGoodVsPrevious: false } })
  assert.equal(blocksToText(two), '42 (-5% vs prev ▼)\nlabel  One  Two\n-----  ---  ---\nApple  1    2')
  assert.deepEqual(widgetRows(two)?.rows, [{ label: 'Apple', One: 1, Two: 2 }])
})

test('tables drop hidden columns and strip html cells; composites nest', () => {
  const t = widgetToBlocks({ type: 'table', columns: [{ header: 'Name', accessor: 'name', type: 'html' }, { header: 'Secret', accessor: 's', type: 'hidden' }], rows: [{ name: '<b>Darin</b>', s: 'x' }] })
  assert.deepEqual(t, [{ kind: 'table', columns: ['name'], headers: ['Name'], rows: [{ name: 'Darin' }] }])
  const c = widgetToBlocks({ type: 'block', blockTypeName: 'COMPOSITE', blocks: [{ blockTypeName: 'BIG_NUMBER', values: { heading: 'Open', number: '123', context: 'orders' } }, { blockTypeName: 'TEXT', values: { text: 'hi' } }] })
  assert.equal(blocksToText(c), 'Open: 123 orders\n\nhi')
  assert.equal(blocksToText(widgetToBlocks({ type: 'statistics', hasPermission: false, label: 'Secret' })), 'Secret\n[WARNING] You do not have permission to view this data.')
})
