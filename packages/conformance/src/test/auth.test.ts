/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authenticationFor, runConformance } from '../conformance.js'

/** A fake MOCK server that records each request's credentials; /jobs answers 403 without a session cookie. */
function fakeServer(seen: Array<{ path: string; authorization?: string; cookie?: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    seen.push({ path: url.pathname, authorization: headers.get('Authorization') ?? undefined, cookie: headers.get('Cookie') ?? undefined })
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })
    switch (url.pathname) {
      case '/qqq/v1/version': return json(200, { apiVersion: '1.9.0', extensions: [] })
      case '/qqq/v1/openapi.json': return json(200, { info: { version: '1.9.0' }, paths: { '/qqq/v1/jobs': { get: { operationId: 'listJobs' } } }, components: { schemas: {} } })
      case '/qqq/v1/metaData/authentication': return json(200, { type: 'MOCK' })
      case '/qqq/v1/manageSession': return json(200, { values: {} }, { 'Set-Cookie': 'sessionUUID=s-1; Path=/; HttpOnly' })
      case '/qqq/v1/metaData': return json(200, { apps: {}, tables: {} })
      case '/qqq/v1/jobs': return headers.get('Cookie') === 'sessionUUID=s-1' ? json(200, { jobs: [] }) : json(403, { code: 'PERMISSION_DENIED', message: 'no' })
      default: return json(404, { code: 'NOT_FOUND', message: 'no route' })
    }
  }) as typeof fetch
}

test('on a MOCK server without a token, every authenticated check (jobs too) uses one server session', async () => {
  const seen: Array<{ path: string; authorization?: string; cookie?: string }> = []
  const results = await runConformance({ baseUrl: 'http://fake', fetch: fakeServer(seen) })
  const jobs = results.find((r) => r.name === 'GET /qqq/v1/jobs validates')!
  assert.equal(jobs.ok && !jobs.skipped, true, jobs.detail ?? 'jobs check did not pass')
  assert.equal(seen.find((s) => s.path === '/qqq/v1/metaData')?.cookie, 'sessionUUID=s-1')
  assert.equal(seen.find((s) => s.path === '/qqq/v1/jobs')?.cookie, 'sessionUUID=s-1')
  assert.match(results.find((r) => r.name === 'GET /qqq/v1/metaData validates')!.detail!, /authenticated with a server session/)
})

test('a token is sent the same way to every authenticated check: a JWT as bearer, a session UUID also as the cookie', () => {
  assert.deepEqual(authenticationFor('a.b.c').headers, { Authorization: 'Bearer a.b.c' })
  assert.deepEqual(authenticationFor('d05c42c-uuid').headers, { Authorization: 'Bearer d05c42c-uuid', Cookie: 'sessionUUID=d05c42c-uuid' })
  assert.deepEqual(authenticationFor(undefined).headers, {})
})
