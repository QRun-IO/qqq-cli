/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** One error about a request field (BasicErrorResponseV1.fieldErrors). */
export interface UiApiFieldError {
  field: string
  message: string
  code?: string
}

/**
 * An error answer of the UI API. Every operation answers errors with BasicErrorResponseV1:
 * `{ error, code, message, fieldErrors[], traceId }` (code, message, fieldErrors and traceId since
 * UI API 1.6.0; older servers send only `error`).
 */
export class UiApiError extends Error {
  readonly status: number
  readonly code: string
  readonly traceId?: string
  readonly fieldErrors: UiApiFieldError[]
  readonly body: unknown

  constructor(status: number, body: unknown, traceIdHeader?: string | null) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const message = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : `HTTP ${status}`
    super(message)
    this.name = 'UiApiError'
    this.status = status
    this.code = typeof b.code === 'string' ? b.code : codeForStatus(status)
    this.traceId = typeof b.traceId === 'string' ? b.traceId : traceIdHeader ?? undefined
    this.fieldErrors = Array.isArray(b.fieldErrors) ? (b.fieldErrors as UiApiFieldError[]) : []
    this.body = body
  }
}

/** The well-known code for an HTTP status (what a pre-1.6.0 server would have meant). */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST'
    case 401: return 'UNAUTHENTICATED'
    case 403: return 'PERMISSION_DENIED'
    case 404: return 'NOT_FOUND'
    case 409: return 'CONFLICT'
    case 429: return 'RATE_LIMITED'
    case 500: return 'INTERNAL_ERROR'
    default: return 'ERROR'
  }
}
