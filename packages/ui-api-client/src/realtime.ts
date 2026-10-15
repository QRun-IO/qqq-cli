/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** One server-sent event of GET /qqq/v1/realtime/stream (RealtimeEventV1 in `data`). */
export interface RealtimeMessage {
  id?: string
  event: string
  data: unknown
}

/** Options for {@link openRealtimeStream}. */
export interface RealtimeStreamOptions {
  baseUrl: string
  token?: () => string | undefined | Promise<string | undefined>
  clientChannel?: string
  lastEventId?: string
  signal?: AbortSignal
  fetch?: typeof fetch
}

/**
 * Opens the realtime event stream and yields its events. The first event is `hello`, whose data
 * carries the connectionId to send to POST /qqq/v1/realtime/subscriptions (the subscriptions belong
 * to this connection and its session). Comment pings are skipped. The generator ends when the
 * server closes the stream (e.g. `session.ended`) or the signal aborts.
 *
 * Works with bearer tokens, unlike the browser EventSource (which cannot send headers).
 *
 * @param options - Server, token and optional Last-Event-ID.
 */
export async function* openRealtimeStream(options: RealtimeStreamOptions): AsyncGenerator<RealtimeMessage> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const token = await options.token?.()
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.clientChannel) headers['X-QQQ-Client'] = options.clientChannel
  if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId

  const response = await (options.fetch ?? fetch)(new URL('/qqq/v1/realtime/stream', options.baseUrl), { headers, signal: options.signal })
  if (!response.ok || !response.body) throw new Error(`GET /qqq/v1/realtime/stream answered ${response.status}`)

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary: number
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
      const message = parseEventBlock(block)
      if (message) yield message
    }
  }
}

/**
 * Parses one SSE block (lines up to a blank line). Returns undefined for comments-only blocks.
 *
 * @param block - The raw lines.
 */
export function parseEventBlock(block: string): RealtimeMessage | undefined {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0 && event === 'message') return undefined
  const text = data.join('\n')
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { id, event, data: parsed }
}
