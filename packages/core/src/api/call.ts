/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Calls any UI API operation by id with plain inputs: the escape hatch that makes every operation
 * reachable before it has a first-class command. Paths are filled from `path`, `query` becomes the
 * query string, and the body goes as JSON, multipart or octet-stream depending on what the
 * operation accepts and what was given.
 */

import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { operation, type OperationInfo } from './operations.js'

/** The inputs do not fit the operation (a missing or unknown path parameter, a body it does not take). */
export class OperationInputError extends Error {}

export interface CallInput {
  path?: Record<string, string>
  query?: Record<string, string | undefined>
  /** A JSON body (object or array); sent as application/json when the operation accepts it. */
  json?: unknown
  /** Form fields; sent as multipart/form-data. Values that are `File` objects are uploaded. */
  form?: Record<string, string | Blob>
  /** Raw bytes for application/octet-stream operations. */
  bytes?: Uint8Array
  headers?: Record<string, string>
}

export interface CallResult {
  status: number
  headers: Headers
  /** Parsed JSON when the response was JSON, else the text (or empty for binary; see `bytes`). */
  data: unknown
  bytes?: Uint8Array
  contentType: string
}

/** Builds the URL of an operation from its path parameters and query. */
export function buildUrl(baseUrl: string, op: OperationInfo, input: CallInput): string {
  let path = op.path
  for (const name of op.pathParams) {
    const value = input.path?.[name]
    if (value === undefined) throw new OperationInputError(`${op.id} needs path parameter "${name}" (--path ${name}=...)`)
    path = path.replace(`{${name}}`, encodeURIComponent(value))
  }
  const unknownPath = Object.keys(input.path ?? {}).filter((k) => !op.pathParams.includes(k))
  if (unknownPath.length) throw new OperationInputError(`${op.id} has no path parameter ${unknownPath.join(', ')}; it takes ${op.pathParams.join(', ') || 'none'}`)
  const url = new URL(baseUrl.replace(/\/$/, '') + path)
  for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * Performs the call. `fetchImpl` must add authentication (the session manager's fetch does).
 */
export async function callOperation(baseUrl: string, id: string, input: CallInput, fetchImpl: typeof fetch): Promise<CallResult> {
  const op = operation(id)
  if (!op) throw new OperationInputError(`No UI API operation "${id}" (see \`qqq api --list\`)`)
  const url = buildUrl(baseUrl, op, input)
  const headers: Record<string, string> = { Accept: 'application/json, */*;q=0.5', ...(input.headers ?? {}) }
  let body: BodyInit | undefined
  if (input.json !== undefined) {
    if (!op.bodyTypes.includes('application/json') && op.bodyTypes.length) throw new OperationInputError(`${op.id} takes ${op.bodyTypes.join(' or ')}, not JSON`)
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(input.json)
  } else if (input.form) {
    const form = new FormData()
    for (const [k, v] of Object.entries(input.form)) form.append(k, v)
    body = form
  } else if (input.bytes) {
    headers['Content-Type'] = 'application/octet-stream'
    body = input.bytes as unknown as BodyInit
  }
  const response = await fetchImpl(url, { method: op.method, headers, body })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      // keep text
    }
    throw new UiApiError(response.status, parsed, response.headers.get('X-QQQ-Trace-Id'))
  }
  if (/json/i.test(contentType)) {
    // an empty body (204, or 200 with no content) is no data, not a parse failure
    const text = await response.text()
    return { status: response.status, headers: response.headers, data: text.trim() ? JSON.parse(text) as unknown : undefined, contentType }
  }
  if (/^text\//i.test(contentType) || contentType === '') return { status: response.status, headers: response.headers, data: await response.text(), contentType }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, data: undefined, bytes, contentType }
}
