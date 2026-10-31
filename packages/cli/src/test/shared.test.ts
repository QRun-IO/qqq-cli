/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { EXIT, UsageError, describeError } from '../context.js'
import { defaultFields, parsePairs, readJson, valueText } from '../commands/shared.js'

test('pairs parse name=value, keeping = inside the value', () => {
  assert.deepEqual(parsePairs(['a=1', 'b=x=y'], '--set'), { a: '1', b: 'x=y' })
  assert.throws(() => parsePairs(['=1'], '--set'), UsageError)
})

test('readJson takes inline JSON and reports bad JSON as a usage error', () => {
  assert.deepEqual(readJson('{"a":1}', '--input-json'), { a: 1 })
  assert.throws(() => readJson('{nope', '--input-json'), UsageError)
})

test('display values win over raw values', () => {
  assert.equal(valueText({ values: { s: 1 }, displayValues: { s: 'Active' } }, 's'), 'Active')
  assert.equal(valueText({ values: { s: 1 } }, 's'), '1')
  assert.equal(valueText({ values: {} }, 's'), '')
})

test('default fields follow the primary key and section tiers', () => {
  const meta = { primaryKeyField: 'id', fields: { id: {}, z: {}, a: {}, b: {}, h: { isHidden: true } }, sections: [{ tier: 'T2', fieldNames: ['b'] }, { tier: 'T1', fieldNames: ['id', 'a'] }] }
  assert.deepEqual(defaultFields(meta), ['id', 'a', 'b', 'z'])
})

test('exit codes follow the error code', () => {
  assert.equal(describeError(new UiApiError(401, { code: 'UNAUTHENTICATED', message: 'x' })).code, EXIT.auth)
  assert.equal(describeError(new UiApiError(404, { code: 'NOT_FOUND', message: 'x' })).code, EXIT.notFound)
  assert.equal(describeError(new UiApiError(400, { code: 'BAD_REQUEST', message: 'x', fieldErrors: [{ field: 'email', message: 'bad' }] })).text, 'Error: x (BAD_REQUEST, HTTP 400)\n  email: bad')
  assert.equal(describeError(new UiApiError(429, { code: 'RATE_LIMITED', message: 'x' })).code, EXIT.transient)
  assert.equal(describeError(new UiApiError(500, { code: 'INTERNAL_ERROR', message: 'x' })).code, EXIT.unexpected)
  assert.equal(describeError(new UsageError('bad')).code, EXIT.usage)
  assert.equal(describeError(new Error('other')).code, EXIT.error)
})
