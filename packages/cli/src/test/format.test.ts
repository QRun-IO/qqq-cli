/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTable, parseCriteria, parseValues, valueText } from '../format.js'

const fields = { id: {}, status: {}, lastName: {} }

test('criteria parse operators, shorthand and lists', () => {
  assert.deepEqual(parseCriteria('status EQUALS active', fields), { fieldName: 'status', operator: 'EQUALS', values: ['active'] })
  assert.deepEqual(parseCriteria('id >= 10', fields), { fieldName: 'id', operator: 'GREATER_THAN_OR_EQUALS', values: ['10'] })
  assert.deepEqual(parseCriteria('id IN 1, 2,3', fields), { fieldName: 'id', operator: 'IN', values: ['1', '2', '3'] })
  assert.deepEqual(parseCriteria('lastName ~ van der', fields), { fieldName: 'lastName', operator: 'CONTAINS', values: ['van der'] })
  assert.deepEqual(parseCriteria('lastName IS_BLANK', fields), { fieldName: 'lastName', operator: 'IS_BLANK', values: [] })
  assert.throws(() => parseCriteria('nope EQUALS 1', fields), /No field nope/)
  assert.throws(() => parseCriteria('id ABOUT 1', fields), /Unknown operator/)
})

test('values parse name=value pairs', () => {
  assert.deepEqual(parseValues(['a=1', 'b=x=y']), { a: '1', b: 'x=y' })
  assert.throws(() => parseValues(['=1']))
})

test('display values win over raw values', () => {
  assert.equal(valueText({ values: { s: 1 }, displayValues: { s: 'Active' } }, 's'), 'Active')
  assert.equal(valueText({ values: { s: 1 } }, 's'), '1')
  assert.equal(valueText({ values: {} }, 's'), '')
})

test('tables align columns', () => {
  assert.equal(formatTable([{ a: 'x', b: 'long value' }], ['a', 'b']), 'a  b\n-  ----------\nx  long value')
})
