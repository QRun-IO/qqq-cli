/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyBehaviors, dependentsOf, getDependencies, isContingentlyDisabled, missingDependencies, validateValue, validateValues, type FieldMeta } from '../forms/fields.js'

const country: FieldMeta = { name: 'countryId', label: 'Country', type: 'INTEGER', possibleValueSourceName: 'country' }
const state: FieldMeta = { name: 'stateId', label: 'State', type: 'INTEGER', possibleValueSourceName: 'countryState', possibleValueSourceDependsOn: ['countryId'] }
const city: FieldMeta = { name: 'cityId', label: 'City', type: 'INTEGER', possibleValueSourceName: 'stateCity', possibleValueSourceFilter: { criteria: [{ fieldName: 'stateId', operator: 'EQUALS', values: ['${input.stateId}'] }] } }

test('dependencies come from dependsOn or from ${input.x} in the filter', () => {
  assert.deepEqual(getDependencies(state), ['countryId'])
  assert.deepEqual(getDependencies(city), ['stateId'])
  assert.deepEqual(getDependencies(country), [])
  assert.deepEqual(dependentsOf('countryId', [country, state, city]).map((f) => f.name), ['stateId'])
})

test('a contingent field is disabled until its dependency is set, and zero counts as set', () => {
  assert.equal(isContingentlyDisabled(state, {}), true)
  assert.equal(isContingentlyDisabled(state, { countryId: 0 }), false)
  assert.deepEqual(missingDependencies(city, {}, { stateId: state }), [{ name: 'stateId', label: 'State' }])
  assert.equal(isContingentlyDisabled({ ...state, possibleValueSourceDependencyBehavior: 'SHOW_ALL_UNTIL_SET' }, {}), false)
})

test('validation mirrors the server rules', () => {
  const name: FieldMeta = { name: 'name', label: 'Name', type: 'STRING', validation: { required: true, maxLength: 5, pattern: '[A-Z].*' } }
  assert.equal(validateValue(name, ''), 'is required')
  assert.equal(validateValue(name, 'Toolong'), 'must be at most 5 characters')
  assert.equal(validateValue(name, 'abc'), 'must match [A-Z].*')
  assert.equal(validateValue(name, 'Abc'), undefined)
  const age: FieldMeta = { name: 'age', label: 'Age', type: 'INTEGER', validation: { minValue: '0', maxValue: '150', maxInclusive: false } }
  assert.equal(validateValue(age, '4x'), 'must be a whole number')
  assert.equal(validateValue(age, '-1'), 'must be at least 0')
  assert.equal(validateValue(age, '150'), 'must be less than 150')
  assert.equal(validateValue(age, '149'), undefined)
  assert.equal(validateValue({ name: 'd', label: 'D', type: 'DATE' }, '2020-13-01'), 'must be a date, YYYY-MM-DD')
  assert.equal(validateValue({ name: 't', label: 'T', type: 'TIME' }, '25:00'), 'must be a time, HH:MM')
  assert.equal(validateValue({ name: 'b', label: 'B', type: 'BOOLEAN' }, 'yes'), undefined)
  assert.deepEqual(validateValues([name, age], { name: '', age: '1' }), { name: 'is required' })
  assert.deepEqual(validateValues([name, age], { name: '' }, ['age']), {})
})

test('behaviors trim and change case', () => {
  assert.equal(applyBehaviors({ name: 'x', label: 'X', type: 'STRING', behaviors: ['TRIM', 'TO_UPPER_CASE'] }, '  ab '), 'AB')
})
