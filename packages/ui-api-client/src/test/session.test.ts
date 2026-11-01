/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUiApiClient } from '../index.js'

test('createSession reads the session UUID from an HttpOnly cookie when the body has none', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(new Request(input as RequestInfo, init).method, 'POST')
    return new Response('{}', { status: 200, headers: { 'set-cookie': 'sessionUUID=abc-123; Path=/; HttpOnly; SameSite=Lax' } })
  }
  const session = await createSession('http://example.test/', {}, 'cli/test', fetchImpl)
  assert.equal(session.sessionUUID, 'abc-123')
})

test('createSession prefers the uuid in the body and keeps the values', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ uuid: 'from-body', values: { user: { name: 'Morgan' } } }), { status: 200 })
  const session = await createSession('http://example.test', {}, undefined, fetchImpl)
  assert.equal(session.sessionUUID, 'from-body')
  assert.deepEqual(session.values, { user: { name: 'Morgan' } })
})

test('createSession reports a failed sign-in', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'bad credentials' }), { status: 401 })
  await assert.rejects(createSession('http://example.test', {}, undefined, fetchImpl), /HTTP 401 bad credentials/)
})

test('the client sends a session cookie instead of a bearer token when sessionCookie is set', async () => {
  let seen: Request | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    seen = new Request(input as RequestInfo, init)
    return new Response('{"apiVersion":"1.8.0"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createUiApiClient({ baseUrl: 'http://example.test', sessionCookie: () => 'sess-1', token: () => 'ignored', fetch: fetchImpl })
  await client.GET('/qqq/v1/version')
  assert.equal(seen?.headers.get('cookie'), 'sessionUUID=sess-1')
  assert.equal(seen?.headers.get('authorization'), null)
})
