/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateTimesToUtc, displayDateTime, filterDateTimesToUtc, localToUtc, utcToLocal, utcToLocalInput, wallTimeToInstant } from '../forms/datetime.js'
import type { QueryFilter } from '../filter/grammar.js'

const CHI = 'America/Chicago'

test('local wall-clock times become UTC instants in the given zone', () => {
  assert.equal(localToUtc('2026-10-31T14:30', { timeZone: CHI }), '2026-10-31T19:30:00Z')
  assert.equal(localToUtc('2026-10-31 14:30:15', { timeZone: CHI }), '2026-10-31T19:30:15Z')
  assert.equal(localToUtc('2026-01-15T09:00', { timeZone: CHI }), '2026-01-15T15:00:00Z')
  assert.equal(localToUtc('2026-07-01T12:00', { timeZone: 'Asia/Kolkata' }), '2026-07-01T06:30:00Z')
  assert.equal(localToUtc('2026-07-01T12:00', { timeZone: 'UTC' }), '2026-07-01T12:00:00Z')
  assert.equal(localToUtc('2026-07-01T12:00:00.123456', { timeZone: 'UTC' }), '2026-07-01T12:00:00.123456Z')
})

test('zoned instants pass through and unparseable text is left for validation', () => {
  assert.equal(localToUtc('2026-10-31T19:30:00Z', { timeZone: CHI }), '2026-10-31T19:30:00Z')
  assert.equal(localToUtc('2026-10-31T14:30:00-05:00', { timeZone: 'UTC' }), '2026-10-31T14:30:00-05:00')
  assert.equal(localToUtc('next tuesday', { timeZone: CHI }), 'next tuesday')
  assert.equal(localToUtc('2026-10-31', { timeZone: CHI }), '2026-10-31')
  assert.equal(localToUtc('2026-10-31', { timeZone: CHI, dateMeansMidnight: true }), '2026-10-31T05:00:00Z')
})

test('spring forward: a time in the gap moves forward by the gap (Chicago, 2026-03-08 02:00 to 03:00)', () => {
  assert.equal(localToUtc('2026-03-08T01:59', { timeZone: CHI }), '2026-03-08T07:59:00Z')
  assert.equal(localToUtc('2026-03-08T02:30', { timeZone: CHI }), '2026-03-08T08:30:00Z')
  assert.equal(utcToLocal('2026-03-08T08:30:00Z', CHI), '2026-03-08 03:30:00 CDT')
  assert.equal(localToUtc('2026-03-08T03:00', { timeZone: CHI }), '2026-03-08T08:00:00Z')
})

test('fall back: a repeated time means its first occurrence (Chicago, 2026-11-01 01:00 to 02:00 twice)', () => {
  assert.equal(localToUtc('2026-11-01T01:30', { timeZone: CHI }), '2026-11-01T06:30:00Z')
  assert.equal(utcToLocal('2026-11-01T06:30:00Z', CHI), '2026-11-01 01:30:00 CDT')
  assert.equal(utcToLocal('2026-11-01T07:30:00Z', CHI), '2026-11-01 01:30:00 CST')
  assert.equal(localToUtc('2026-11-01T02:30', { timeZone: CHI }), '2026-11-01T08:30:00Z')
  // the second 01:30 survives an edit that leaves the wall-clock text alone
  assert.equal(localToUtc('2026-11-01T01:30:00', { timeZone: CHI, original: '2026-11-01T07:30:00Z' }), '2026-11-01T07:30:00Z')
})

test('southern hemisphere and Europe: Sydney and London DST edges', () => {
  // Sydney leaves DST 2026-04-05 03:00 -> 02:00; enters 2026-10-04 02:00 -> 03:00
  assert.equal(localToUtc('2026-04-05T02:30', { timeZone: 'Australia/Sydney' }), '2026-04-04T15:30:00Z')
  assert.equal(localToUtc('2026-10-04T02:30', { timeZone: 'Australia/Sydney' }), '2026-10-03T16:30:00Z')
  // London enters BST 2026-03-29 01:00 -> 02:00
  assert.equal(localToUtc('2026-03-29T01:30', { timeZone: 'Europe/London' }), '2026-03-29T01:30:00Z')
  assert.equal(localToUtc('2026-03-29T00:30', { timeZone: 'Europe/London' }), '2026-03-29T00:30:00Z')
  assert.equal(localToUtc('2026-03-29T02:30', { timeZone: 'Europe/London' }), '2026-03-29T01:30:00Z')
})

test('unchanged instants keep their precision through an edit', () => {
  const original = '2026-10-31T22:41:52.344419Z'
  const local = utcToLocalInput(original, CHI)
  assert.equal(local, '2026-10-31T17:41:52')
  assert.equal(localToUtc(local, { timeZone: CHI, original }), original)
  assert.equal(localToUtc('2026-10-31T17:42', { timeZone: CHI, original }), '2026-10-31T22:42:00Z')
})

test('display: local zone, the server zoned display when given, raw with utc', () => {
  assert.equal(displayDateTime('2026-10-31T19:30:00Z', '2026-10-31T19:30:00Z', { timeZone: CHI }), '2026-10-31 14:30:00 CDT')
  assert.equal(displayDateTime('2026-10-31T19:30:00Z', '2026-10-31 3:30:00 PM EDT', { timeZone: CHI }), '2026-10-31 3:30:00 PM EDT')
  assert.equal(displayDateTime('2026-10-31T19:30:00Z', undefined, { timeZone: CHI, utc: true }), '2026-10-31T19:30:00Z')
  assert.equal(displayDateTime(null, undefined, { timeZone: CHI }), '')
  assert.match(displayDateTime('2026-12-01T12:00:00Z', undefined, { timeZone: 'Europe/London' }), /^2026-12-01 12:00:00 GMT/)
})

test('only DATE_TIME fields and DATE_TIME criteria are converted', () => {
  const fields = [{ name: 'when', label: 'When', type: 'DATE_TIME' }, { name: 'day', label: 'Day', type: 'DATE' }, { name: 'note', label: 'Note', type: 'STRING' }]
  assert.deepEqual(dateTimesToUtc(fields, { when: '2026-10-31T14:30', day: '2026-10-31', note: '2026-10-31T14:30' }, { timeZone: CHI }),
    { when: '2026-10-31T19:30:00Z', day: '2026-10-31', note: '2026-10-31T14:30' })
  const filter: QueryFilter = {
    criteria: [{ fieldName: 'when', operator: 'BETWEEN', values: ['2026-10-31', '2026-10-31T23:59'] }, { fieldName: 'day', operator: 'EQUALS', values: ['2026-10-31'] }],
    booleanOperator: 'AND',
    subFilters: [{ criteria: [{ fieldName: 'when', operator: 'GREATER_THAN', values: [{ type: 'NowWithOffset', operator: 'MINUS', amount: 7, timeUnit: 'DAYS' } as never] }], booleanOperator: 'AND' }],
  } as QueryFilter
  filterDateTimesToUtc(filter, Object.fromEntries(fields.map((f) => [f.name, f])), CHI)
  assert.deepEqual(filter.criteria[0]!.values, ['2026-10-31T05:00:00Z', '2026-11-01T04:59:00Z'])
  assert.deepEqual(filter.criteria[1]!.values, ['2026-10-31'])
  assert.equal(typeof (filter.subFilters![0] as QueryFilter).criteria[0]!.values[0], 'object')
})

test('wallTimeToInstant agrees with Date for the host zone across a year', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  for (let month = 1; month <= 12; month++) {
    const expected = new Date(2026, month - 1, 15, 10, 20, 0).getTime()
    assert.equal(wallTimeToInstant(2026, month, 15, 10, 20, 0, 0, zone), expected)
  }
})

test('a form session reads typed DATE_TIME values as local time and keeps unchanged instants', async () => {
  const { FormSession } = await import('../forms/form-session.js')
  const noFetch: typeof fetch = async () => new Response('{}', { status: 404 })
  const session = new FormSession({
    baseUrl: 'http://x', fetch: noFetch, scope: { process: 'p' }, timeZone: CHI,
    fields: [{ name: 'when', label: 'When', type: 'DATE_TIME' }, { name: 'other', label: 'Other', type: 'DATE_TIME' }],
    initialValues: { when: '2026-10-31T22:41:52.344419Z' },
  })
  assert.equal(session.displayValues.when, '2026-10-31 17:41:52 CDT')
  await session.set('when', '2026-10-31T17:41:52')
  assert.equal(session.values.when, '2026-10-31T22:41:52.344419Z')
  await session.set('other', '2026-11-01T01:30')
  assert.equal(session.values.other, '2026-11-01T06:30:00Z')
  assert.equal(session.displayValues.other, '2026-11-01 01:30:00 CDT')
  await session.set('other', 'soon')
  assert.deepEqual(session.validate(), { other: 'must be a date and time, YYYY-MM-DDTHH:MM (local time) or an ISO instant' })
})
