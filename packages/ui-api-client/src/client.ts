/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import createClient, { type Client, type Middleware } from 'openapi-fetch'
import type { paths } from './schema.js'
import { UiApiError } from './errors.js'

/** The typed client: `client.GET('/qqq/v1/metaData')`, `client.POST('/qqq/v1/table/{tableName}/query', ...)`. */
export type UiApiClient = Client<paths>

/** Options for {@link createUiApiClient}. */
export interface UiApiClientOptions {
  /** The server origin, e.g. https://admin.example.com (paths already include /qqq/v1). */
  baseUrl: string
  /** Returns the bearer token (an OAuth2 access token or a session UUID) for each request. */
  token?: () => string | undefined | Promise<string | undefined>
  /** Called once on a 401; return true when it refreshed the token, to retry the request. */
  onUnauthorized?: () => boolean | Promise<boolean>
  /** The client channel (X-QQQ-Client), e.g. `cli/qqq-cli 0.1.0`. */
  clientChannel?: string
  /** Optional fetch (tests, proxies). */
  fetch?: typeof fetch
  /** Extra headers on every request (e.g. a load-balancer affinity cookie). */
  headers?: Record<string, string>
}

/**
 * Creates a typed UI API client. Every operation of the merged document (core and extensions) is a
 * typed call; errors come back as `error` (BasicErrorResponseV1) - use {@link unwrap} to throw
 * {@link UiApiError} instead.
 *
 * @param options - Server, token and channel.
 */
export function createUiApiClient(options: UiApiClientOptions): UiApiClient {
  const baseFetch = options.fetch ?? fetch
  const authedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const send = async (): Promise<Response> => {
      const attempt = request.clone()
      const token = await options.token?.()
      if (token) attempt.headers.set('Authorization', `Bearer ${token}`)
      return baseFetch(attempt)
    }
    let response = await send()
    if (response.status === 401 && options.onUnauthorized && await options.onUnauthorized()) {
      response = await send()
    }
    return response
  }

  const client = createClient<paths>({ baseUrl: options.baseUrl.replace(/\/$/, ''), fetch: authedFetch })
  const headers: Middleware = {
    onRequest({ request }) {
      if (options.clientChannel) request.headers.set('X-QQQ-Client', options.clientChannel)
      for (const [name, value] of Object.entries(options.headers ?? {})) request.headers.set(name, value)
      if (!request.headers.has('Accept')) request.headers.set('Accept', 'application/json')
      return request
    },
  }
  client.use(headers)
  return client
}

/**
 * Returns the data of a call, or throws {@link UiApiError} for an error answer.
 *
 * @param result - What a client call returned.
 */
export async function unwrap<T>(result: Promise<{ data?: T; error?: unknown; response: Response }> | { data?: T; error?: unknown; response: Response }): Promise<T> {
  const { data, error, response } = await result
  if (!response.ok || error !== undefined) {
    throw new UiApiError(response.status, error, response.headers.get('X-QQQ-Trace-Id'))
  }
  return data as T
}
