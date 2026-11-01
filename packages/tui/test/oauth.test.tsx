/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { SignInScreen } from '../src/screens/signin'
import type { FakeAuth } from './fake-server'
import { isolate, memorySecrets, press, startTui, waitFor, type Harness } from './helpers'

/** An OIDC provider on a loopback port: discovery, token (code exchange checks the PKCE verifier exists), end session. */
let provider: ReturnType<typeof Bun.serve>
let tokenAnswer: 'ok' | 'fail' = 'ok'
const exchanges: URLSearchParams[] = []
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = `${b64({ alg: 'none' })}.${b64({ email: 'oidc@fake.test', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`

let h: Harness | undefined
beforeAll(() => {
  isolate()
  process.env.QQQ_UI_SIGN_IN = 'browser'
  process.env.QQQ_UI_NO_BROWSER = '1'
  provider = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const base = `http://127.0.0.1:${provider.port}`
      if (url.pathname === '/.well-known/openid-configuration') return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, end_session_endpoint: `${base}/logout` })
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await req.text())
        exchanges.push(form)
        if (tokenAnswer === 'fail' || !form.get('code_verifier')) return Response.json({ error: 'invalid_grant', error_description: 'the code was refused' }, { status: 400 })
        return Response.json({ access_token: jwt, refresh_token: 'r1', id_token: jwt, expires_in: 3600, token_type: 'Bearer' })
      }
      return new Response('not found', { status: 404 })
    },
  })
})
afterAll(() => {
  provider.stop(true)
  delete process.env.QQQ_UI_SIGN_IN
  delete process.env.QQQ_UI_NO_BROWSER
})
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

function oauth(): FakeAuth {
  return { type: 'OAUTH2', sessions: new Set(), values: { nativeClientId: 'qqq-cli', baseUrl: `http://127.0.0.1:${provider.port}` } }
}

/** What the browser does after the provider: follows the redirect to the loopback callback. */
async function redirect(query: (state: string) => string): Promise<number> {
  let url: string | undefined
  await waitFor(h!, () => Boolean(url = (h!.store.screen as SignInScreen | undefined)?.browserUrl))
  const authorize = new URL(url!)
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  const state = authorize.searchParams.get('state')!
  const back = await fetch(`${authorize.searchParams.get('redirect_uri')}?${query(state)}`)
  return back.status
}

test('OAUTH2 authorization code + PKCE: discovery, authorize address shown, loopback callback, code exchanged with the verifier', async () => {
  const secrets = memorySecrets()
  h = await startTui(120, 36, { auth: oauth(), secrets, until: 'signin' })
  expect(await redirect((state) => `code=abc&state=${state}`)).toBe(200)
  await waitFor(h, (x) => x.includes('Apps') && h!.store.screen?.kind === 'home')
  expect(exchanges.at(-1)!.get('code')).toBe('abc')
  expect(exchanges.at(-1)!.get('code_verifier')!.length).toBeGreaterThan(40)
  expect(h.store.status.user).toBe('oidc@fake.test')
  const stored = JSON.parse(String(await secrets().get('fake@http://fake.test')))
  expect(stored.kind).toBe('oauth')
  expect(h.log.requests.find((r) => r.path === '/metaData')!.auth).toBe(`Bearer ${jwt}`)
})

test('OAUTH2 failures: tampered state, provider denial and a refused code exchange are reported and store nothing', async () => {
  const secrets = memorySecrets()
  h = await startTui(120, 36, { auth: oauth(), secrets, until: 'signin' })
  expect(await redirect(() => 'code=abc&state=forged')).toBe(400)
  await waitFor(h, (x) => /state/i.test(x) && h!.store.screen?.kind === 'signin' && !(h!.store.screen as SignInScreen).connecting)
  expect(await secrets().get('fake@http://fake.test')).toBeUndefined()
  await press(h, () => h!.setup.mockInput.pressEnter())
  expect(await redirect((state) => `error=access_denied&error_description=denied+by+user&state=${state}`)).toBe(400)
  await waitFor(h, (x) => x.includes('denied') && !(h!.store.screen as SignInScreen).connecting)
  tokenAnswer = 'fail'
  await press(h, () => h!.setup.mockInput.pressEnter())
  expect(await redirect((state) => `code=abc&state=${state}`)).toBe(200)
  await waitFor(h, (x) => x.includes('the code was refused'))
  tokenAnswer = 'ok'
  expect(await secrets().get('fake@http://fake.test')).toBeUndefined()
})
