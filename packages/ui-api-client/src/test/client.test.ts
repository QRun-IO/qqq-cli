/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUiApiClient, unwrap } from '../client.js'
import { UiApiError } from '../errors.js'
import { deviceSignIn, refreshTokens, isExpiring } from '../auth.js'
import { parseEventBlock } from '../realtime.js'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

test('sends the bearer token and client channel, and unwraps data', async () => {
  const seen: Request[] = []
  const client = createUiApiClient({
    baseUrl: 'https://app.example.com/',
    token: () => 'tok-1',
    clientChannel: 'cli/test',
    fetch: async (input) => {
      seen.push(input as Request)
      return jsonResponse(200, { apiVersion: '1.6.0' })
    },
  })
  const version = await unwrap(client.GET('/qqq/v1/version'))
  assert.equal((version as { apiVersion: string }).apiVersion, '1.6.0')
  assert.equal(seen[0].url, 'https://app.example.com/qqq/v1/version')
  assert.equal(seen[0].headers.get('Authorization'), 'Bearer tok-1')
  assert.equal(seen[0].headers.get('X-QQQ-Client'), 'cli/test')
})

test('an error answer becomes UiApiError with code, traceId and field errors', async () => {
  const client = createUiApiClient({
    baseUrl: 'https://app.example.com',
    fetch: async () => jsonResponse(400, { error: 'Bad', code: 'BAD_REQUEST', message: 'Bad input', traceId: 't-1', fieldErrors: [{ field: 'name', message: 'required' }] }),
  })
  await assert.rejects(unwrap(client.GET('/qqq/v1/metaData', {})), (error: unknown) => {
    assert.ok(error instanceof UiApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'BAD_REQUEST')
    assert.equal(error.message, 'Bad input')
    assert.equal(error.traceId, 't-1')
    assert.equal(error.fieldErrors[0].field, 'name')
    return true
  })
})

test('a pre-1.6.0 error body (only "error") still maps, using the status code and trace header', async () => {
  const client = createUiApiClient({ baseUrl: 'https://app.example.com', fetch: async () => jsonResponse(403, { error: 'Permission denied.' }, { 'X-QQQ-Trace-Id': 'h-1' }) })
  await assert.rejects(unwrap(client.GET('/qqq/v1/metaData', {})), (error: unknown) => {
    assert.ok(error instanceof UiApiError)
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.equal(error.message, 'Permission denied.')
    assert.equal(error.traceId, 'h-1')
    return true
  })
})

test('a 401 refreshes once and retries with the new token', async () => {
  let token = 'old'
  let calls = 0
  const client = createUiApiClient({
    baseUrl: 'https://app.example.com',
    token: () => token,
    onUnauthorized: () => {
      token = 'new'
      return true
    },
    fetch: async (input) => {
      calls++
      return (input as Request).headers.get('Authorization') === 'Bearer new' ? jsonResponse(200, { apiVersion: '1.6.0' }) : jsonResponse(401, { error: 'expired', code: 'UNAUTHENTICATED' })
    },
  })
  await unwrap(client.GET('/qqq/v1/version'))
  assert.equal(calls, 2)
})

test('device sign-in polls through authorization_pending and slow_down', async () => {
  const answers = [
    jsonResponse(400, { error: 'authorization_pending' }),
    jsonResponse(400, { error: 'slow_down' }),
    jsonResponse(200, { access_token: 'a.b.c', refresh_token: 'r1', expires_in: 600 }),
  ]
  const sleeps: number[] = []
  let prompted = ''
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(200, { issuer: 'https://idp/o/cli/', token_endpoint: 'https://idp/token', device_authorization_endpoint: 'https://idp/device' })
    if (url === 'https://idp/device') return jsonResponse(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://idp/activate', verification_uri_complete: 'https://idp/activate?c=1', interval: 2, expires_in: 600 })
    return answers.shift() as Response
  }
  const tokens = await deviceSignIn({ issuer: 'https://idp/o/cli/', clientId: 'cli', scope: 'openid' }, (p) => { prompted = p.userCode }, { fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(prompted, 'ABCD-EFGH')
  assert.equal(tokens.accessToken, 'a.b.c')
  assert.equal(tokens.refreshToken, 'r1')
  assert.deepEqual(sleeps, [2000, 2000, 7000])
  assert.equal(isExpiring(tokens), false)
})

test('device sign-in stops on access_denied', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(200, { token_endpoint: 'https://idp/token', device_authorization_endpoint: 'https://idp/device' })
    if (url === 'https://idp/device') return jsonResponse(200, { device_code: 'dc', user_code: 'X', verification_uri: 'https://idp/a', interval: 1, expires_in: 60 })
    return jsonResponse(400, { error: 'access_denied' })
  }
  await assert.rejects(deviceSignIn({ issuer: 'https://idp/', clientId: 'cli', scope: 'openid' }, () => undefined, { fetch: fetchImpl, sleep: async () => undefined }), /denied/)
})

test('refresh keeps the old refresh token when the provider does not rotate it', async () => {
  const fetchImpl: typeof fetch = async (input) => String(input).endsWith('openid-configuration')
    ? jsonResponse(200, { token_endpoint: 'https://idp/token' })
    : jsonResponse(200, { access_token: 'x.y.z', expires_in: 60 })
  const tokens = await refreshTokens({ issuer: 'https://idp/', clientId: 'cli', scope: 'openid' }, 'r-old', fetchImpl)
  assert.equal(tokens.refreshToken, 'r-old')
  assert.equal(isExpiring(tokens, 120), true)
})

test('SSE blocks parse events and skip comments', () => {
  assert.deepEqual(parseEventBlock('id: c:1\nevent: hello\ndata: {"connectionId":"c"}'), { id: 'c:1', event: 'hello', data: { connectionId: 'c' } })
  assert.equal(parseEventBlock(': ping'), undefined)
  assert.deepEqual(parseEventBlock('event: job.progress\ndata: {"jobId":1,\ndata: "percent":50}'), { id: undefined, event: 'job.progress', data: { jobId: 1, percent: 50 } })
})
