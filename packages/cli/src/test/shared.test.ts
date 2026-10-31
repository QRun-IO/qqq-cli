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

test('list cells follow the record view rules: REVEAL masked unless revealed, DATE_TIME in the zone', async () => {
  const meta = { fields: { pin: { name: 'pin', label: 'PIN', type: 'STRING', adornments: [{ type: 'REVEAL' }] }, at: { name: 'at', label: 'At', type: 'DATE_TIME' } } }
  const record = { values: { pin: '1234', at: '2026-10-31T19:30:00Z' } }
  assert.equal(valueText(record, 'pin', meta), '••••••••')
  assert.equal(valueText(record, 'pin', meta, undefined, true), '1234')
  assert.equal(valueText(record, 'at', meta, { timeZone: 'Asia/Tokyo' }), '2026-11-01 04:30:00 GMT+9')
  assert.equal(valueText(record, 'at', meta, { utc: true }), '2026-10-31T19:30:00Z')
})

test('footers and numeric options are shared', async () => {
  const { countFooter, intOption, positiveInt } = await import('../commands/shared.js')
  assert.equal(countFooter(1, 'record'), '(1 record)')
  assert.equal(countFooter(3, 'record', [false, 'joined: pet', undefined, 0]), '(3 records; joined: pet)')
  assert.equal(countFooter(2, 'person', [], 'people'), '(2 people)')
  assert.equal(intOption(undefined, '--skip'), undefined)
  assert.equal(intOption('0', '--skip'), 0)
  assert.throws(() => intOption('-1', '--skip'), UsageError)
  assert.throws(() => positiveInt('0', '--limit'), UsageError)
  assert.throws(() => positiveInt('ten', '--limit'), /--limit must be a whole number of at least 1: ten/)
})

test('exit codes: gateways are transient, bad operation inputs are usage errors', async () => {
  const { OperationInputError } = await import('@qrun-io/qqq-core')
  assert.equal(describeError(new UiApiError(503, { message: 'down' })).code, EXIT.transient)
  assert.equal(describeError(new UiApiError(502, 'Bad Gateway')).code, EXIT.transient)
  assert.equal(describeError(new UiApiError(500, { message: 'boom' })).code, EXIT.unexpected)
  assert.equal(describeError(new OperationInputError('needs path parameter')).code, EXIT.usage)
})
