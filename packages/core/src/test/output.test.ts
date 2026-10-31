/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyQuery, defaultFormat, formatCsv, formatTable, formatText, render } from '../render/output.js'

const rows = [{ id: 1, name: 'Morgan, "Mo"' }, { id: 2, name: 'Casey' }]

test('table aligns and labels columns, with a footer', () => {
  assert.equal(render({ data: rows, columns: ['id', 'name'], headers: ['Id', 'Name'], footer: '(2 records)' }, 'table'),
    'Id  Name\n--  ------------\n1   Morgan, "Mo"\n2   Casey\n(2 records)')
  assert.equal(formatTable([{ a: 'x'.repeat(70) }], ['a'], ['a'], 10), 'a\n----------\nxxxxxxxxx…')
})

test('csv quotes per RFC 4180 and text is tab separated without a header', () => {
  assert.equal(formatCsv(rows, ['id', 'name']), 'id,name\n1,"Morgan, ""Mo"""\n2,Casey\n')
  assert.equal(formatText(rows, ['id', 'name']), '1\tMorgan, "Mo"\n2\tCasey')
})

test('json and yaml print the full data; jmespath reshapes first', () => {
  assert.equal(render({ data: { a: [1, 2] } }, 'json'), '{\n  "a": [\n    1,\n    2\n  ]\n}')
  assert.equal(render({ data: { a: [1, 2] } }, 'yaml'), 'a:\n  - 1\n  - 2')
  assert.deepEqual(applyQuery({ records: rows }, 'records[].name'), ['Morgan, "Mo"', 'Casey'])
  assert.equal(render({ data: { records: rows }, rows, columns: ['id'] }, 'table', 'records[].{n: name}'), 'n\n------------\nMorgan, "Mo"\nCasey')
})

test('default format follows the tty and QQQ_OUTPUT', () => {
  assert.equal(defaultFormat(true, {}), 'table')
  assert.equal(defaultFormat(false, {}), 'json')
  assert.equal(defaultFormat(true, { QQQ_OUTPUT: 'yaml' }), 'yaml')
  assert.equal(defaultFormat(true, { QQQ_OUTPUT: 'bogus' }), 'table')
})
