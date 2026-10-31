/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A profile's stored sign-in and the fetch that authenticates with it, shared by both heads so a
 * sign-in made by `qqq login` works in `qqq ui` and the other way round. The keyring account is
 * `{profile}@{server}`, as the CLI has always used.
 *
 * The rule for sending it: a server session (MOCK, FULLY_ANONYMOUS, TABLE_BASED via manageSession)
 * goes as the `sessionUUID` cookie, because the sample server cannot continue an asynchronous
 * process step with the same UUID as a bearer token (docs/server-findings.md); OAuth2 tokens go
 * as `Authorization: Bearer`, refreshed at the provider when they are about to expire.
 * QQQ_TOKEN overrides everything with a bearer token.
 */

import { createSession, isExpiring, refreshTokens, type NativeSignInConfig, type TokenSet } from '@qrun-io/qqq-ui-api-client'
import { upsertProfile, type ResolvedProfile } from './profiles.js'
import type { SecretStore } from './keyring.js'

/** What is stored per profile: OAuth2 tokens from the device flow, or a server session from manageSession. */
export type StoredLogin =
  | { kind?: 'oauth'; config: NativeSignInConfig; tokens: TokenSet }
  | { kind: 'session'; authType: string; sessionUUID: string; user?: Record<string, unknown>; createdAt: string }

/** The keyring account of a profile's sign-in. */
export function loginAccount(target: Pick<ResolvedProfile, 'name' | 'server'>): string {
  return `${target.name}@${target.server}`
}

export async function readLogin(store: SecretStore, target: Pick<ResolvedProfile, 'name' | 'server'>): Promise<StoredLogin | undefined> {
  const raw = await store.get(loginAccount(target))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as StoredLogin
  } catch {
    return undefined
  }
}

/** Keeps a sign-in and names the profile (the first profile becomes the default). */
export async function writeLogin(store: SecretStore, target: Pick<ResolvedProfile, 'name' | 'server'>, login: StoredLogin, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  upsertProfile(target.name, { server: target.server }, {}, env)
  await store.set(loginAccount(target), JSON.stringify(login))
}

export async function deleteLogin(store: SecretStore, target: Pick<ResolvedProfile, 'name' | 'server'>): Promise<boolean> {
  return store.delete(loginAccount(target))
}

/** Signs in to a MOCK or FULLY_ANONYMOUS server with manageSession and keeps the session. */
export async function signInWithSession(store: SecretStore, target: Pick<ResolvedProfile, 'name' | 'server'>, authType: string, clientChannel: string, fetchImpl: typeof fetch = fetch): Promise<StoredLogin & { kind: 'session' }> {
  const session = await createSession(target.server, {}, clientChannel, fetchImpl)
  const login = { kind: 'session' as const, authType, sessionUUID: session.sessionUUID, user: (session.values.user ?? {}) as Record<string, unknown>, createdAt: new Date().toISOString() }
  await writeLogin(store, target, login)
  return login
}

export interface LoginFetchOptions {
  store: SecretStore
  target: Pick<ResolvedProfile, 'name' | 'server'>
  clientChannel: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}

/** The credential to send now: a session cookie, a bearer token (refreshed when expiring), or nothing. */
export async function currentCredential(options: LoginFetchOptions, force = false): Promise<{ cookie?: string; bearer?: string }> {
  const env = options.env ?? process.env
  if (env.QQQ_TOKEN) return { bearer: env.QQQ_TOKEN }
  const login = await readLogin(options.store, options.target)
  if (!login) return {}
  if (login.kind === 'session') return { cookie: `sessionUUID=${login.sessionUUID}` }
  if ((force || isExpiring(login.tokens)) && login.tokens.refreshToken) {
    const tokens = await refreshTokens(login.config, login.tokens.refreshToken, options.fetch ?? fetch)
    await writeLogin(options.store, options.target, { kind: 'oauth', config: login.config, tokens }, env)
    return { bearer: tokens.accessToken }
  }
  return { bearer: login.tokens.accessToken }
}

/** A fetch that adds the profile's credential and the client channel; retries once after a refresh on 401. */
export function loginFetch(options: LoginFetchOptions): typeof fetch {
  const base = options.fetch ?? fetch
  const send = async (input: RequestInfo | URL, init: RequestInit | undefined, force: boolean): Promise<Response> => {
    const request = new Request(input as RequestInfo, init)
    request.headers.set('X-QQQ-Client', options.clientChannel)
    const credential = await currentCredential(options, force)
    if (credential.cookie) request.headers.set('Cookie', credential.cookie)
    else if (credential.bearer) request.headers.set('Authorization', `Bearer ${credential.bearer}`)
    return base(request)
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const retryable = !init?.body || typeof init.body === 'string'
    const response = await send(input, init, false)
    if (response.status !== 401 || !retryable) return response
    const login = await readLogin(options.store, options.target)
    if (!login || login.kind === 'session' || !login.tokens.refreshToken) return response
    try {
      return await send(input, init, true)
    } catch {
      return response
    }
  }) as typeof fetch
}
