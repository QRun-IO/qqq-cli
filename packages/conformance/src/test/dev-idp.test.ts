/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startDevIdp } from '../dev-idp.js'
import { SchemaValidator } from '../conformance.js'

test('dev IdP: discovery, device grant (manual approval) and refresh', async () => {
  const idp = await startDevIdp({ port: 9488, clients: ['app', 'cli'], user: { sub: 'u@x.test', email: 'u@x.test', name: 'U', preferredUsername: 'u', groups: ['g'] } })
  try {
    const discovery = await (await fetch(`${idp.issuer('cli')}.well-known/openid-configuration`)).json() as Record<string, string>
    assert.equal(discovery.issuer, 'http://localhost:9488/application/o/cli/')
    const keys = await (await fetch(discovery.jwks_uri)).json() as { keys: unknown[] }
    assert.equal(keys.keys.length, 1)

    const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) })
    const start = await (await fetch(discovery.device_authorization_endpoint, form({ client_id: 'cli', scope: 'openid' }))).json() as Record<string, string>
    const pending = await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code }))
    assert.equal(((await pending.json()) as Record<string, string>).error, 'authorization_pending')
    assert.ok(idp.approve(start.user_code))
    const tokens = await (await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code }))).json() as Record<string, string>
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString())
    assert.equal(claims.aud, 'cli')
    assert.equal(claims.iss, idp.issuer('cli'))

    const refreshed = await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))
    assert.equal(refreshed.status, 200)
    const replay = await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))
    assert.equal(replay.status, 400)
  } finally {
    await idp.close()
  }
})

test('schema validator maps OpenAPI nullable and refs', () => {
  const validator = new SchemaValidator({
    paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/X' } } } } } } } },
    components: { schemas: { X: { type: 'object', properties: { a: { type: 'string', nullable: true }, b: { type: 'integer' } } } } },
  })
  validator.response('get', '/x', 200, { a: null, b: 1 })
  assert.throws(() => validator.response('get', '/x', 200, { a: 1 }), /must be string/)
})
