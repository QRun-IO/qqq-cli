/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Profiles, credentials and the authenticated client for one server. A profile names a server;
 * its sign-in (OAuth2 tokens from the device flow, or a server session) lives in the OS keyring
 * (macOS Keychain, Linux Secret Service, Windows DPAPI; a 0600 file on headless hosts or with
 * QQQ_KEYRING=file). QQQ_TOKEN overrides everything with a bearer token.
 *
 * Sign-ins made by 0.1 in ~/.config/qqq-cli/credentials.json are imported once.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createUiApiClient, getNativeSignInConfig, isExpiring, refreshTokens,
  type NativeSignInConfig, type TokenSet, type UiApiClient,
} from '@qrun-io/qqq-ui-api-client'
import { defaultSecretStore, readConfig, resolveProfile, upsertProfile, type ResolvedProfile, type SecretStore } from '@qrun-io/qqq-core'

export const CLI_VERSION = '0.2.0-dev'
export const CLIENT_CHANNEL = `cli/qqq-cli ${CLI_VERSION}`

/** What is stored per profile: OAuth2 tokens from the device flow, or a server session from manageSession. */
export type StoredLogin =
  | { kind?: 'oauth'; config: NativeSignInConfig; tokens: TokenSet }
  | { kind: 'session'; authType: string; sessionUUID: string; user?: Record<string, unknown>; createdAt: string }

let store: SecretStore | undefined
function secrets(): SecretStore {
  store ??= defaultSecretStore()
  return store
}

/** The profile (and server) a command runs against. */
export interface Target extends ResolvedProfile {}

let selection: { profile?: string; server?: string } = {}

/** Called once by the program with the global --profile and --server options. */
export function selectTarget(options: { profile?: string; server?: string }): void {
  selection = options
}

/** The current target, after importing any 0.1 credentials file. */
export function target(): Target {
  importLegacyCredentials()
  return resolveProfile(selection)
}

/** The server origin of the current target (kept for callers that only need the URL). */
export function resolveServer(option?: string): string {
  if (option) selection = { ...selection, server: option }
  return target().server
}

function account(t: Target): string {
  return `${t.name}@${t.server}`
}

/** Keeps a new sign-in for the target, naming the profile and making it the default when it is the first. */
export async function saveLogin(t: Target, login: StoredLogin): Promise<void> {
  upsertProfile(t.name, { server: t.server })
  await secrets().set(account(t), JSON.stringify(login))
}

/** Forgets the target's sign-in (the profile stays). */
export async function removeLogin(t: Target): Promise<boolean> {
  return secrets().delete(account(t))
}

/** The stored sign-in of the target, if any. */
export async function getLogin(t: Target): Promise<StoredLogin | undefined> {
  const raw = await secrets().get(account(t))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as StoredLogin
  } catch {
    return undefined
  }
}

/** Fetches the native sign-in config of a server. */
export function nativeConfig(server: string): Promise<NativeSignInConfig> {
  return getNativeSignInConfig(server)
}

/**
 * The current bearer token for the target, refreshing it at the provider when it is about to
 * expire (QQQ_TOKEN overrides everything).
 */
export async function currentToken(t: Target, force = false): Promise<string | undefined> {
  if (process.env.QQQ_TOKEN) return process.env.QQQ_TOKEN
  const login = await getLogin(t)
  if (!login) return undefined
  if (login.kind === 'session') return login.sessionUUID
  if ((force || isExpiring(login.tokens)) && login.tokens.refreshToken) {
    const tokens = await refreshTokens(login.config, login.tokens.refreshToken)
    await saveLogin(t, { kind: 'oauth', config: login.config, tokens })
    return tokens.accessToken
  }
  return login.tokens.accessToken
}

/** The stored server session of the target, when the sign-in was session-based (sent as a cookie). */
export async function sessionCookieFor(t: Target): Promise<string | undefined> {
  if (process.env.QQQ_TOKEN) return undefined
  const login = await getLogin(t)
  return login?.kind === 'session' ? login.sessionUUID : undefined
}

/** An authenticated UI API client for the target (refreshes once on 401). */
export function clientFor(t: Target): UiApiClient {
  return createUiApiClient({
    baseUrl: t.server,
    clientChannel: CLIENT_CHANNEL,
    token: () => currentToken(t),
    sessionCookie: () => sessionCookieFor(t),
    onUnauthorized: async () => {
      const login = await getLogin(t)
      if (process.env.QQQ_TOKEN || !login || login.kind === 'session' || !login.tokens.refreshToken) return false
      try {
        await currentToken(t, true)
        return true
      } catch {
        return false
      }
    },
  })
}

/** A fetch that adds the target's authentication and client channel, for calls outside the typed client. */
export function authenticatedFetch(t: Target): typeof fetch {
  return async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    request.headers.set('X-QQQ-Client', CLIENT_CHANNEL)
    const session = await sessionCookieFor(t)
    if (session) {
      request.headers.set('Cookie', `sessionUUID=${session}`)
    } else {
      const token = await currentToken(t)
      if (token) request.headers.set('Authorization', `Bearer ${token}`)
    }
    return fetch(request)
  }
}

/** The secret store in use (for `qqq config show`). */
export function secretStoreKind(): string {
  return secrets().kind
}

/** Imports ~/.config/qqq-cli/credentials.json (0.1) into profiles and the keyring, once. */
function importLegacyCredentials(): void {
  const dir = process.env.QQQ_CLI_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'qqq-cli')
  const file = join(dir, 'credentials.json')
  if (!existsSync(file)) return
  try {
    const legacy = JSON.parse(readFileSync(file, 'utf8')) as { defaultServer?: string; servers?: Record<string, StoredLogin> }
    const config = readConfig()
    for (const [server, login] of Object.entries(legacy.servers ?? {})) {
      const name = Object.entries(config.profiles).find(([, p]) => p.server === server)?.[0] ?? new URL(server).host.replace(/[^A-Za-z0-9.-]+/g, '-')
      upsertProfile(name, { server, note: 'imported from qqq-cli 0.1' }, { makeDefault: legacy.defaultServer === server })
      void secrets().set(`${name}@${server}`, JSON.stringify(login))
    }
    renameSync(file, `${file}.imported`)
    process.stderr.write(`Imported the 0.1 sign-ins from ${file} into profiles (${file}.imported kept).\n`)
  } catch {
    // leave the file alone
  }
}
