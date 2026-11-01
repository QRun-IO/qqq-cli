/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Is a server there, and what is it? GET /qqq/v1/version and /qqq/v1/metaData/authentication
 * (neither needs a sign-in) with a short timeout. The Servers dialog of the TUI and
 * `qqq profile list --probe` / `qqq profile add --check` use it.
 */

export interface ServerProbe {
  reachable: boolean
  /** The UI API version the server reports. */
  apiVersion?: string
  /** The authentication type (MOCK, TABLE_BASED, OAUTH2, AUTH_0, FULLY_ANONYMOUS), when the server says. */
  authType?: string
  /** Round trip of the version request. */
  ms?: number
  /** Why it is not reachable (timeout, refused, HTTP status, not a QQQ server). */
  error?: string
}

export const PROBE_TIMEOUT_MS = 2500

export async function probeServer(server: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<ServerProbe> {
  const fetchImpl = options.fetch ?? fetch
  const base = server.replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const get = async (path: string): Promise<Response> => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      return await fetchImpl(`${base}${path}`, { headers: { Accept: 'application/json' }, signal: abort.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  const started = Date.now()
  try {
    const [version, auth] = await Promise.all([get('/qqq/v1/version'), get('/qqq/v1/metaData/authentication').catch(() => undefined)])
    const ms = Date.now() - started
    if (!version.ok) return { reachable: false, ms, error: `HTTP ${version.status} from /qqq/v1/version` }
    const body = await version.json().catch(() => undefined) as { apiVersion?: unknown } | undefined
    if (!body || typeof body.apiVersion !== 'string') return { reachable: false, ms, error: 'not a QQQ UI API server (no apiVersion at /qqq/v1/version)' }
    let authType: string | undefined
    if (auth?.ok) {
      const a = await auth.json().catch(() => undefined) as { type?: unknown } | undefined
      if (a && typeof a.type === 'string') authType = a.type
    }
    return { reachable: true, apiVersion: body.apiVersion, authType, ms }
  } catch (error) {
    const e = error as Error & { cause?: { message?: string; code?: string } }
    const aborted = e.name === 'AbortError' || /abort/i.test(e.message)
    return { reachable: false, error: aborted ? `no answer in ${(timeoutMs / 1000).toFixed(1)} s` : e.cause?.code ?? e.cause?.message ?? e.message }
  }
}
