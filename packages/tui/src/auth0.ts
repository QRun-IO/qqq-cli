/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * AUTH_0 sign-in, as the web does it: authorization code + PKCE at `{baseUrl}/authorize` with the
 * API audience, the code exchanged at `{baseUrl}/oauth/token`, then the access token handed to
 * POST manageSession, whose session (cookie) the TUI keeps. The redirect lands on a loopback
 * listener; sign-out ends the server session and opens `{baseUrl}/v2/logout`.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPkce, createSession, createState, readAuthorizationCallback } from '@qrun-io/qqq-ui-api-client'
import { writeLogin, type SecretStore, type StoredLogin } from '@qrun-io/qqq-core'

export interface Auth0Values {
  baseUrl: string
  clientId: string
  audience?: string
  scopes?: string
}

export function auth0Values(values: Record<string, unknown> | undefined): Auth0Values {
  const v = values ?? {}
  const baseUrl = typeof v.baseUrl === 'string' ? v.baseUrl : ''
  const clientId = typeof v.nativeClientId === 'string' ? v.nativeClientId : typeof v.clientId === 'string' ? v.clientId : ''
  if (!baseUrl || !clientId) throw new Error('The server publishes no Auth0 tenant or client (values.baseUrl, values.clientId).')
  return { baseUrl: baseUrl.replace(/\/+$/, ''), clientId, audience: typeof v.audience === 'string' ? v.audience : undefined, scopes: typeof v.scopes === 'string' ? v.scopes : undefined }
}

const page = (text: string) => `<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif">${text}</p>`

/** Runs the browser sign-in; `onUrl` gets the address to open. Keeps the server session it gets. */
export async function auth0SignIn(options: { server: string; values: Auth0Values; secrets: SecretStore; target: { name: string; server: string }; clientChannel: string; onUrl: (url: string) => void; signal?: AbortSignal; fetch?: typeof fetch; timeoutMillis?: number }): Promise<StoredLogin & { kind: 'session' }> {
  const { values } = options
  const pkce = await createPkce()
  const state = createState()
  let settle!: { resolve: (u: URL) => void; reject: (e: Error) => void }
  const callback = new Promise<URL>((resolve, reject) => { settle = { resolve, reject } })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    let ok = true
    try {
      readAuthorizationCallback(url, state)
    } catch {
      ok = false
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page(ok ? 'Signed in. You can close this tab and return to the terminal.' : 'Sign-in did not complete. See the terminal.'))
    settle.resolve(url)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
  const params = new URLSearchParams({ response_type: 'code', client_id: values.clientId, redirect_uri: redirectUri, scope: values.scopes ?? 'openid profile email offline_access', state, code_challenge: pkce.challenge, code_challenge_method: 'S256' })
  if (values.audience) params.set('audience', values.audience)
  const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out waiting for the browser')), options.timeoutMillis ?? 300_000)
  const onAbort = () => settle.reject(new Error('Sign-in cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    options.onUrl(`${values.baseUrl}/authorize?${params}`)
    const { code } = readAuthorizationCallback(await callback, state)
    const f = options.fetch ?? fetch
    const response = await fetch(`${values.baseUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: values.clientId, code, code_verifier: pkce.verifier, redirect_uri: redirectUri }).toString() })
    const body = await response.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string }
    if (!response.ok || !body.access_token) throw new Error(`Exchanging the code failed: ${body.error_description ?? body.error ?? response.status}`)
    // the backend checks the Auth0 JWT and opens its own session
    const session = await createSession(options.server, { accessToken: body.access_token }, options.clientChannel, f)
    const login = { kind: 'session' as const, authType: 'AUTH_0', sessionUUID: session.sessionUUID, user: (session.values.user ?? {}) as Record<string, unknown>, createdAt: new Date().toISOString() }
    await writeLogin(options.secrets, options.target, login)
    return login
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    server.close()
  }
}

/** The Auth0 end-session address (v2/logout). */
export function auth0LogoutUrl(values: Auth0Values): string {
  return `${values.baseUrl}/v2/logout?${new URLSearchParams({ client_id: values.clientId })}`
}
