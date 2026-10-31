/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChoiceError, FormSession } from '../forms/form-session.js'
import type { FieldMeta } from '../forms/fields.js'

const fields: FieldMeta[] = [
  { name: 'label', label: 'Label', type: 'STRING', isRequired: true },
  { name: 'countryId', label: 'Country', type: 'INTEGER', possibleValueSourceName: 'country' },
  { name: 'stateId', label: 'State', type: 'INTEGER', possibleValueSourceName: 'countryState', possibleValueSourceDependsOn: ['countryId'] },
  { name: 'cityId', label: 'City', type: 'INTEGER', possibleValueSourceName: 'stateCity', possibleValueSourceDependsOn: ['stateId'] },
]

const data: Record<string, Array<{ id: number; label: string }>> = {
  countryId: [{ id: 1, label: 'USA' }, { id: 2, label: 'Canada' }],
  stateId: [{ id: 1, label: 'Illinois' }, { id: 2, label: 'Missouri' }, { id: 3, label: 'Ontario' }],
  cityId: [{ id: 1, label: 'Chicago' }, { id: 2, label: 'St. Louis' }, { id: 3, label: 'Springfield' }, { id: 4, label: 'Springfield' }],
}
const calls: Array<{ field: string; body: Record<string, unknown> }> = []

/** A fake possible-values server: ids, labels and search over the fixture; states need a country. */
const fakeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input as RequestInfo, init)
  const m = /possibleValues\/(\w+)$/.exec(request.url)
  if (request.url.includes('formAdjuster')) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'no adjusters' }), { status: 404, headers: { 'content-type': 'application/json' } })
  const field = m![1]!
  const body = JSON.parse(await request.text()) as Record<string, unknown>
  calls.push({ field, body })
  let options = data[field]!
  if (field === 'stateId' && (body.values as Record<string, unknown> | undefined)?.countryId === undefined) options = []
  if (Array.isArray(body.ids)) options = options.filter((o) => (body.ids as string[]).includes(String(o.id)))
  else if (Array.isArray(body.labels)) options = options.filter((o) => (body.labels as string[]).some((l) => l.toLowerCase() === o.label.toLowerCase()))
  else if (body.searchTerm) options = options.filter((o) => o.label.toLowerCase().includes(String(body.searchTerm).toLowerCase()))
  return new Response(JSON.stringify({ options }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function session() {
  return new FormSession({ baseUrl: 'http://h', fetch: fakeFetch, scope: { table: 'placeAddress' }, fields })
}

test('contingent fields are disabled until their dependency is set, then offer filtered choices', async () => {
  const s = session()
  assert.match(s.state('stateId').disabledBecause!, /set Country first/)
  assert.deepEqual(await s.options('stateId'), [])
  await assert.rejects(s.set('stateId', 'Missouri'), /set Country first/)
  await s.set('countryId', 'USA')
  assert.equal(s.values.countryId, 1)
  assert.equal(s.displayValues.countryId, 'USA')
  assert.equal(s.state('stateId').disabledBecause, undefined)
  const states = await s.options('stateId')
  assert.deepEqual(states.map((o) => o.label), ['Illinois', 'Missouri', 'Ontario'])
  assert.deepEqual(calls.at(-1)!.body.values, { countryId: 1 })
})

test('changing a dependency clears its dependents transitively', async () => {
  const s = session()
  await s.set('countryId', '1')
  await s.set('stateId', 'missouri')
  await s.set('cityId', '2')
  assert.equal(s.values.cityId, 2)
  const change = await s.set('countryId', 'Canada')
  assert.deepEqual(change.cleared, ['stateId', 'cityId'])
  assert.equal(s.values.stateId, null)
  assert.equal(s.values.cityId, null)
  assert.equal(s.displayValues.stateId, undefined)
})

test('typed choices resolve by id, exact label, or a unique partial, and report ambiguity', async () => {
  const s = session()
  await s.set('countryId', '2')
  await s.set('stateId', 'Ontario')
  await s.set('cityId', 'chic')
  assert.equal(s.values.cityId, 1)
  await assert.rejects(s.set('cityId', 'Springfield'), (e: unknown) => e instanceof ChoiceError && e.candidates.length === 2)
  await assert.rejects(s.set('cityId', 'Nowhere'), /no choice named "Nowhere"/)
})

test('validation covers required fields and disabled fields with values; submission has only set fields', async () => {
  const s = session()
  assert.deepEqual(s.validate(), { label: 'is required' })
  await s.set('label', 'Home')
  s.values.stateId = 2 // as if an old value remained after the country was cleared
  assert.match(s.validate().stateId!, /set Country first/)
  s.values.stateId = null
  assert.deepEqual(s.validate(), {})
  assert.deepEqual(s.submission(), { label: 'Home', stateId: null })
})

test('promptOrder puts dependencies before dependents whatever the form order', () => {
  const s = new FormSession({ baseUrl: 'http://h', fetch: fakeFetch, scope: { table: 't' }, fields: [fields[3]!, fields[2]!, fields[0]!, fields[1]!], exclude: ['label'] })
  assert.deepEqual(s.promptOrder(), ['countryId', 'stateId', 'cityId'])
  assert.deepEqual(s.promptOrder(['cityId', 'countryId']), ['countryId', 'cityId'])
})
