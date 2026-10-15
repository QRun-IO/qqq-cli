/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Credentials and the authenticated client for one server. Tokens are kept in
 * ~/.config/qqq-cli/credentials.json (mode 0600), per server origin, or come from QQQ_TOKEN
 * (any bearer token: an access token or a session UUID).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createUiApiClient, getNativeSignInConfig, isExpiring, refreshTokens,
  type NativeSignInConfig, type TokenSet, type UiApiClient,
} from '@qrun-io/qqq-ui-api-client'

export const CLI_VERSION = '0.1.0-rc.1'
export const CLIENT_CHANNEL = `cli/qqq-cli ${CLI_VERSION}`

/** What is stored per server. */
export interface StoredLogin {
  config: NativeSignInConfig
  tokens: TokenSet
}

interface Store {
  defaultServer?: string
  servers: Record<string, StoredLogin>
}

const dir = process.env.QQQ_CLI_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'qqq-cli')
const file = join(dir, 'credentials.json')

function readStore(): Store {
  if (!existsSync(file)) return { servers: {} }
  return JSON.parse(readFileSync(file, 'utf8')) as Store
}

function writeStore(store: Store): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // not supported on every file system (e.g. some Windows volumes)
  }
}

/** The server to use: --server, else QQQ_SERVER, else the last one signed in to. */
export function resolveServer(option?: string): string {
  const server = option ?? process.env.QQQ_SERVER ?? readStore().defaultServer
  if (!server) throw new Error('No server: pass --server https://... or set QQQ_SERVER (or run `qqq login --server ...`).')
  return new URL(server).origin
}

/** Keeps a new sign-in for a server, and makes it the default server. */
export function saveLogin(server: string, login: StoredLogin): void {
  const store = readStore()
  store.servers[server] = login
  store.defaultServer = server
  writeStore(store)
}

/** Forgets a server's tokens. */
export function removeLogin(server: string): boolean {
  const store = readStore()
  const had = server in store.servers
  delete store.servers[server]
  if (store.defaultServer === server) delete store.defaultServer
  writeStore(store)
  return had
}

/** The stored sign-in of a server, if any. */
export function getLogin(server: string): StoredLogin | undefined {
  return readStore().servers[server]
}

/** Fetches the native sign-in config of a server. */
export function nativeConfig(server: string): Promise<NativeSignInConfig> {
  return getNativeSignInConfig(server)
}

/**
 * Returns the current bearer token for a server, refreshing it at the provider when it is about to
 * expire (QQQ_TOKEN overrides everything).
 *
 * @param server - Server origin.
 * @param force - Refresh even when not expiring (after a 401).
 */
export async function currentToken(server: string, force = false): Promise<string | undefined> {
  if (process.env.QQQ_TOKEN) return process.env.QQQ_TOKEN
  const login = getLogin(server)
  if (!login) return undefined
  if ((force || isExpiring(login.tokens)) && login.tokens.refreshToken) {
    const tokens = await refreshTokens(login.config, login.tokens.refreshToken)
    saveLogin(server, { config: login.config, tokens })
    return tokens.accessToken
  }
  return login.tokens.accessToken
}

/** An authenticated UI API client for a server (refreshes once on 401). */
export function clientFor(server: string): UiApiClient {
  return createUiApiClient({
    baseUrl: server,
    clientChannel: CLIENT_CHANNEL,
    token: () => currentToken(server),
    onUnauthorized: async () => {
      if (process.env.QQQ_TOKEN || !getLogin(server)?.tokens.refreshToken) return false
      try {
        await currentToken(server, true)
        return true
      } catch {
        return false
      }
    },
  })
}
