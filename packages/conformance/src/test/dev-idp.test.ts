/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
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

test('dev IdP: authorization code with S256 PKCE on a loopback redirect, revocation and end-session', async () => {
  const idp = await startDevIdp({ port: 9489, clients: ['cli'], autoApprove: true, user: { sub: 'u@x.test', email: 'u@x.test', name: 'U', preferredUsername: 'u', groups: ['g'] } })
  try {
    const discovery = await (await fetch(`${idp.issuer('cli')}.well-known/openid-configuration`)).json() as Record<string, string>
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const redirect = 'http://127.0.0.1:7777/callback'
    const authorize = (params: Record<string, string>) => fetch(`${discovery.authorization_endpoint}?${new URLSearchParams(params)}`, { redirect: 'manual' })
    const base = { response_type: 'code', client_id: 'cli', redirect_uri: redirect, scope: 'openid offline_access', state: 's1', code_challenge: challenge, code_challenge_method: 'S256' }
    assert.equal((await authorize({ ...base, redirect_uri: 'https://evil.test/cb' })).status, 400)
    assert.equal((await authorize({ ...base, code_challenge_method: 'plain' })).status, 400)
    const ok = await authorize(base)
    assert.equal(ok.status, 302)
    const back = new URL(ok.headers.get('location')!)
    assert.equal(back.origin + back.pathname, redirect)
    assert.equal(back.searchParams.get('state'), 's1')
    const code = back.searchParams.get('code')!
    const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) })
    const wrong = await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'authorization_code', code, code_verifier: 'nope', redirect_uri: redirect }))
    assert.equal(wrong.status, 400)
    // a code is single-use even after a failed exchange
    const again = await authorize(base)
    const code2 = new URL(again.headers.get('location')!).searchParams.get('code')!
    const tokens = await (await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'authorization_code', code: code2, code_verifier: verifier, redirect_uri: redirect }))).json() as Record<string, string>
    assert.ok(tokens.access_token && tokens.refresh_token && tokens.id_token)
    assert.equal((await fetch(discovery.revocation_endpoint, form({ client_id: 'cli', token: tokens.refresh_token }))).status, 200)
    assert.equal((await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).status, 400)
    const more = await (await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'authorization_code', code: new URL((await authorize(base)).headers.get('location')!).searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect }))).json() as Record<string, string>
    assert.equal((await fetch(`${discovery.end_session_endpoint}?client_id=cli&id_token_hint=${more.id_token}`)).status, 200)
    assert.equal((await fetch(discovery.token_endpoint, form({ client_id: 'cli', grant_type: 'refresh_token', refresh_token: more.refresh_token }))).status, 400)
    // end-session goes back only to a loopback post_logout_redirect_uri; any other is refused with 400
    const endSession = (back: string) => fetch(`${discovery.end_session_endpoint}?client_id=cli&post_logout_redirect_uri=${encodeURIComponent(back)}`, { redirect: 'manual' })
    for (const back of ['http://127.0.0.1:7777/signed-out?x=1', 'http://localhost:7777/', 'http://[::1]:7777/bye', 'http://localhost/']) {
      const answer = await endSession(back)
      assert.equal(answer.status, 302, back)
      assert.equal(answer.headers.get('location'), back)
    }
    for (const back of ['https://evil.test/cb', 'http://127.0.0.1.evil.test/', 'http://evil.test@127.0.0.1:7777/', 'https://127.0.0.1:7777/', '//evil.test/', 'javascript:alert(1)', 'not a url']) {
      assert.equal((await endSession(back)).status, 400, back)
    }
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
