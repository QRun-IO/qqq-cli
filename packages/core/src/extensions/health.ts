/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The health summary of a server that serves the plain `/health` endpoint without advertising
 * the health extension in GET /version (qqq-all does this). The extension's operations live under
 * /qqq/v1/health; the plain endpoint answers `{status, timestamp, checks: {name: {status, ...}}}`.
 * probeHealth reads it and shapes it like the extension's summary, marked as unadvertised.
 */

type Json = Record<string, unknown>

/** The note shown with a summary read from /health. */
export const UNADVERTISED_HEALTH_NOTE = 'the server does not advertise the health extension in GET /version; this summary comes from its plain GET /health endpoint'

/** A health summary read from /health, in the extension's summary shape plus where it came from. */
export interface ProbedHealthSummary {
  status: string | null
  since: string | null
  components: Array<{ name: string; status: string | null; durationMs?: number; details?: unknown }>
  source: 'GET /health'
  advertised: false
  note: string
}

/** Shapes a `/health` answer like the extension's summary; undefined when it is not one. */
export function healthSummaryFromProbe(body: unknown): ProbedHealthSummary | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const b = body as Json
  if (typeof b.status !== 'string') return undefined
  // the timestamp is epoch seconds with a fraction (Instant as a number), or an ISO string
  const since = typeof b.timestamp === 'number' ? new Date(b.timestamp * (b.timestamp < 1e11 ? 1000 : 1)).toISOString() : typeof b.timestamp === 'string' ? b.timestamp : null
  const checks = (b.checks && typeof b.checks === 'object' && !Array.isArray(b.checks) ? b.checks : {}) as Record<string, Json>
  const components = Object.entries(checks).map(([name, c]) => ({
    name,
    status: typeof c?.status === 'string' ? c.status : null,
    ...(typeof c?.durationMs === 'number' ? { durationMs: c.durationMs } : {}),
    ...(c?.details !== undefined ? { details: c.details } : {}),
  }))
  return { status: b.status, since, components, source: 'GET /health', advertised: false, note: UNADVERTISED_HEALTH_NOTE }
}

/**
 * Probes `{server}/health`; the summary when it answers 2xx with a health document, otherwise
 * undefined (a missing endpoint, an error or a network failure all mean "no health here").
 */
export async function probeHealth(server: string, fetchImpl: typeof fetch = fetch): Promise<ProbedHealthSummary | undefined> {
  try {
    const response = await fetchImpl(`${server.replace(/\/$/, '')}/health`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return undefined
    return healthSummaryFromProbe(await response.json())
  } catch {
    return undefined
  }
}
