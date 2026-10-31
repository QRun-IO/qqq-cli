/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { authorizationUrl, createPkce, createState, endSessionUrl, exchangeAuthorizationCode, keepIdToken, readAuthorizationCallback, revokeToken, type NativeSignInConfig } from '../index.js'

const config: NativeSignInConfig = { issuer: 'http://idp.test/application/o/cli/', clientId: 'cli', scope: 'openid offline_access' }
const discovery = {
  issuer: config.issuer, token_endpoint: 'http://idp.test/token/', authorization_endpoint: 'http://idp.test/authorize/',
  end_session_endpoint: 'http://idp.test/application/o/cli/end-session/', revocation_endpoint: 'http://idp.test/revoke/',
}

function fakeProvider(onPost: (url: string, form: URLSearchParams) => { status: number; body: unknown }): { fetch: typeof fetch; posts: Array<{ url: string; form: URLSearchParams }> } {
  const posts: Array<{ url: string; form: URLSearchParams }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    if (request.method === 'GET' && request.url.endsWith('/.well-known/openid-configuration')) return Response.json(discovery)
    const form = new URLSearchParams(await request.text())
    posts.push({ url: request.url, form })
    const answer = onPost(request.url, form)
    return Response.json(answer.body, { status: answer.status })
  }
  return { fetch: fetchImpl, posts }
}

test('PKCE: a 43-character verifier and its S256 challenge; states are random', async () => {
  const pkce = await createPkce()
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'))
  assert.notEqual(createState(), createState())
})

test('the authorization URL carries the PKCE challenge, state and loopback redirect, and no nonce', () => {
  const url = new URL(authorizationUrl({ issuer: config.issuer, tokenEndpoint: discovery.token_endpoint, authorizationEndpoint: discovery.authorization_endpoint }, config, { redirectUri: 'http://127.0.0.1:5000/callback', state: 's1', challenge: 'c1' }))
  assert.equal(url.origin + url.pathname, 'http://idp.test/authorize/')
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: 'code', client_id: 'cli', redirect_uri: 'http://127.0.0.1:5000/callback', scope: 'openid offline_access', state: 's1', code_challenge: 'c1', code_challenge_method: 'S256' })
  assert.equal(url.searchParams.has('nonce'), false)
})

test('the callback is checked: denial, forged state and a missing code are refused', () => {
  assert.deepEqual(readAuthorizationCallback(new URL('http://127.0.0.1/callback?code=k&state=s1'), 's1'), { code: 'k' })
  assert.throws(() => readAuthorizationCallback(new URL('http://127.0.0.1/callback?error=access_denied&error_description=No&state=s1'), 's1'), /Sign-in was denied: No/)
  assert.throws(() => readAuthorizationCallback(new URL('http://127.0.0.1/callback?code=k&state=other'), 's1'), /state .* does not match/)
  assert.throws(() => readAuthorizationCallback(new URL('http://127.0.0.1/callback?code=k'), 's1'), /does not match/)
  assert.throws(() => readAuthorizationCallback(new URL('http://127.0.0.1/callback?state=s1'), 's1'), /no code/)
  assert.throws(() => readAuthorizationCallback(new URL('http://127.0.0.1/callback?error=server_error&state=s1'), 's1'), /failed at the provider: server_error/)
})

test('the code exchange sends the verifier and redirect URI; a refused exchange is reported', async () => {
  const ok = fakeProvider(() => ({ status: 200, body: { access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 60 } }))
  const tokens = await exchangeAuthorizationCode(config, { code: 'k', verifier: 'v', redirectUri: 'http://127.0.0.1:5000/callback' }, ok.fetch)
  assert.equal(tokens.accessToken, 'a')
  assert.equal(tokens.idToken, 'i')
  assert.deepEqual(Object.fromEntries(ok.posts[0]!.form), { grant_type: 'authorization_code', client_id: 'cli', code: 'k', code_verifier: 'v', redirect_uri: 'http://127.0.0.1:5000/callback' })
  const bad = fakeProvider(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } }))
  await assert.rejects(exchangeAuthorizationCode(config, { code: 'k', verifier: 'wrong', redirectUri: 'x' }, bad.fetch), /Exchanging the code failed: PKCE verification failed/)
})

test('sign-out: the refresh token is revoked and the end-session URL names the client and the ID token', async () => {
  const provider = fakeProvider(() => ({ status: 200, body: {} }))
  assert.equal(await revokeToken(config, 'r1', 'refresh_token', provider.fetch), true)
  assert.deepEqual(Object.fromEntries(provider.posts[0]!.form), { token: 'r1', token_type_hint: 'refresh_token', client_id: 'cli' })
  const url = new URL((await endSessionUrl(config, { idToken: 'id1' }, provider.fetch))!)
  assert.equal(url.pathname, '/application/o/cli/end-session/')
  assert.equal(url.searchParams.get('id_token_hint'), 'id1')
  assert.equal(url.searchParams.get('client_id'), 'cli')
  assert.deepEqual(keepIdToken({ accessToken: 'b', expiresAt: 1 }, { accessToken: 'a', idToken: 'id1', expiresAt: 0 }), { accessToken: 'b', expiresAt: 1, idToken: 'id1' })
})
