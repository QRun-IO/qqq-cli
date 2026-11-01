/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCompletion, completeFilter, describeFilter, locateFilterError, operatorsForField } from '../filter/complete.js'
import { parseFilter } from '../filter/grammar.js'

const fields = [
  { name: 'id', label: 'Id', type: 'INTEGER' },
  { name: 'firstName', label: 'First Name', type: 'STRING' },
  { name: 'lastName', label: 'Last Name', type: 'STRING' },
  { name: 'birthDate', label: 'Birth Date', type: 'DATE' },
  { name: 'isEmployed', label: 'Is Employed', type: 'BOOLEAN' },
  { name: 'personId', label: 'Person', type: 'INTEGER', possibleValueSourceName: 'person' },
]

test('operators follow the field type and allowedFilterOperators', () => {
  assert.ok(operatorsForField(fields[1]).includes('STARTS_WITH'))
  assert.ok(!operatorsForField(fields[3]).includes('STARTS_WITH'))
  assert.deepEqual(operatorsForField(fields[4]), ['TRUE', 'FALSE', 'EQUALS', 'NOT_EQUALS', 'IS_BLANK', 'IS_NOT_BLANK'])
  assert.ok(operatorsForField(fields[1]).includes('NOT_EQUALS_OR_IS_NULL') && operatorsForField(fields[3]).includes('IN'))
  assert.ok(operatorsForField(fields[5]).includes('IN') && !operatorsForField(fields[5]).includes('GREATER_THAN'))
  assert.deepEqual(operatorsForField({ type: 'STRING', allowedFilterOperators: ['EQUALS', 'IN'] }), ['EQUALS', 'IN'])
})

test('completion walks field, operator, value and connector', () => {
  let r = completeFilter('', 0, fields)
  assert.equal(r.expecting, 'field')
  assert.ok(r.candidates.some((c) => c.value === '('))
  r = completeFilter('la', 2, fields)
  assert.deepEqual([r.from, r.to, r.candidates[0]!.value], [0, 2, 'lastName'])
  r = completeFilter('last', 4, fields)
  assert.equal(r.candidates[0]!.value, 'lastName', 'label match: Last Name')
  r = completeFilter('lastName ST', 11, fields)
  assert.equal(r.expecting, 'operator')
  assert.deepEqual(r.candidates.map((c) => c.value), ['STARTS_WITH', 'NOT_STARTS_WITH'])
  r = completeFilter('birthDate > ', 12, fields)
  assert.equal(r.expecting, 'value')
  assert.ok(r.candidates.some((c) => c.value === 'now(-7d)'))
  r = completeFilter('birthDate > now(-7d) ', 21, fields)
  assert.equal(r.expecting, 'connector')
  assert.deepEqual(r.candidates.map((c) => c.value), ['AND', 'OR'])
  r = completeFilter('(isEmployed TRUE ', 17, fields)
  assert.deepEqual(r.candidates.map((c) => c.value), ['AND', 'OR', ')'])
  r = completeFilter('a = 1 AND (fi', 13, fields)
  assert.deepEqual([r.expecting, r.candidates[0]!.value], ['field', 'firstName'])
})

test('possible values come from the caller and list items complete after the comma', () => {
  const values = (_f: unknown, prefix: string) => ['Avery Sample', 'Blair Sample'].filter((l) => l.toLowerCase().startsWith(prefix.toLowerCase())).map((l) => ({ value: l, label: l, kind: 'value' as const }))
  const r = completeFilter('personId IN Avery,Bl', 20, fields, { values })
  assert.equal(r.from, 18)
  assert.deepEqual(r.candidates.filter((c) => c.kind === 'value').map((c) => c.value), ['Blair Sample'])
  const applied = applyCompletion('personId IN Avery,Bl', r, r.candidates[0]!)
  assert.equal(applied.text, 'personId IN Avery,"Blair Sample" ')
})

test('errors are located and filters described', () => {
  const text = 'lastName BOGUS x'
  let error: unknown
  try {
    parseFilter(text)
  } catch (e) {
    error = e
  }
  assert.equal(locateFilterError(text, error), 9)
  assert.equal(describeFilter(parseFilter('a = 1 AND (b = 2 OR c = 3)')), '3 criteria, 1 group, joined by AND')
})
