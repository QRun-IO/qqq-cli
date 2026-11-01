/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dynamicFormFields, dynamicFormMissing, dynamicFormSubmission, dynamicFormValues, type DynamicFormPayload } from '../forms/dynamic-form.js'

const payload: DynamicFormPayload = { type: 'dynamicForm', mergedDynamicFormValuesIntoFieldName: 'settingsJson', fieldList: [
  { name: 'limit', label: 'Limit', type: 'INTEGER', isRequired: true },
  { name: 'note', label: 'Note', type: 'STRING' },
  { name: 'secret', label: 'Secret', type: 'STRING', isHidden: true },
] }

test('a dynamicForm reads its values from the merged JSON field and saves them there in field order', () => {
  assert.deepEqual(dynamicFormFields(payload).map((f) => f.name), ['limit', 'note'])
  assert.deepEqual(dynamicFormValues(payload, { settingsJson: '{"note":"x","limit":3}' }), { note: 'x', limit: 3 })
  assert.deepEqual(dynamicFormValues(payload, { settingsJson: 'not json' }), {})
  assert.deepEqual(dynamicFormMissing(payload, { note: 'x' }), ['Limit'])
  assert.deepEqual(dynamicFormSubmission(payload, { note: 'y', limit: '5' }), { settingsJson: '{"limit":"5","note":"y"}' })
})

test('without a merged field the values are record fields', () => {
  const plain: DynamicFormPayload = { fieldList: [{ name: 'a', label: 'A', type: 'STRING' }, { name: 'b', label: 'B', type: 'STRING', isEditable: false }], recordOfFieldValues: { values: { a: 1, b: 2 } } }
  assert.deepEqual(dynamicFormValues(plain), { a: 1, b: 2 })
  assert.deepEqual(dynamicFormSubmission(plain, { a: 'z', b: 9 }), { a: 'z' })
})
