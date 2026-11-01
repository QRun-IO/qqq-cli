/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The assistant extension (qbit-assistant, `/qqq/v1/assistant`) for both heads: the feature probe
 * (`GET /config`) and asking a question (a conversation, then a turn streamed as server-sent events).
 *
 * A question is sent the way the Next UI's panel sends it: `POST /conversations` with the page
 * context, then `POST /conversations/{id}/turns` with `{ text, pageContext, concurrency }`. The
 * context is a hint the server never trusts: `{ route, tableName, recordId?, filter? }` where
 * route is the web UI path (`/app/{table}` or `/app/{table}/{id}`).
 *
 * The stream's events are folded into an {@link AssistantAnswer}: the text, notices, the numbers
 * (count renders and presentation metrics) and the links the answer refers to. Links are app paths
 * (`/app/...`, the only hrefs the server emits); {@link parseAppHref} turns one into the table,
 * record id and filter a client opens.
 */

import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { buildUrl, type CallInput, type CallResult } from '../api/call.js'
import { operation } from '../api/operations.js'
import type { ExtensionRegistry } from './registry.js'

export const ASSISTANT = 'assistant'

type Json = Record<string, unknown>

/** How the module reaches the server: the kernel's callOperation, plus a fetch for the event stream. */
export interface AssistantTransport {
  call(id: string, input: CallInput): Promise<CallResult>
  /** An authenticated fetch (the stream is read as it arrives, not through callOperation). */
  fetch: typeof fetch
  /** The server origin. */
  baseUrl: string
}

/** The page a question is asked from (sent as a hint). */
export interface AssistantPageContext {
  route?: string
  tableName?: string
  recordId?: string | number
  /** A QQueryFilter as JSON. */
  filter?: Json
  selectedIds?: Array<string | number>
}

/** What `GET /config` says, plus whether the extension is installed at all. */
export interface AssistantConfigView {
  installed: boolean
  enabled: boolean
  /** DISABLED, NOT_CONFIGURED, NO_PERMISSION or KILL_SWITCH. */
  reason?: string
  /** The server's sentence about the reason (assistant 1.7.0+), else the client's. */
  message?: string
  model?: string
  shortcut?: string
  displayName?: string
  greeting?: string
  starterPrompts: string[]
  limits?: Json
  /** The body as received. */
  raw?: Json
}

/** A destination the answer refers to: a record, or a table (optionally filtered). */
export interface AssistantLink {
  label: string
  href: string
  kind: 'record' | 'table' | 'page'
  tableName?: string
  recordId?: string
}

/** A number in the answer: a record count or a presentation metric. */
export interface AssistantNumber {
  label: string
  value: string
  href?: string
}

/** One tool the assistant used. */
export interface AssistantToolUse {
  name: string
  summary: string
  outcome?: string
}

/** A finished (or stopped) answer. */
export interface AssistantAnswer {
  conversationId: number
  turnId?: number
  messageId?: number
  text: string
  status: 'COMPLETE' | 'CANCELLED' | 'ERROR' | 'RUNNING'
  error?: { code: string; message: string }
  notices: Array<{ level: string; text: string }>
  numbers: AssistantNumber[]
  links: AssistantLink[]
  tools: AssistantToolUse[]
  usage?: { inputTokens?: number; outputTokens?: number; costMicros?: number }
  /** Milliseconds from sending to the end of the stream. */
  elapsedMs?: number
}

/** One parsed stream event (the JSON data, with its type). */
export interface AssistantEvent extends Json {
  type: string
}

/** Client-side wording for each reason, used when the server sends no message (before 1.7.0). */
export const ASSISTANT_REASON_TEXT: Record<string, string> = {
  DISABLED: 'The assistant is turned off for this application.',
  NOT_CONFIGURED: 'No model provider is configured on this server (an administrator adds one on Assistant > Providers).',
  NO_PERMISSION: 'You do not have access to the assistant.',
  KILL_SWITCH: 'The assistant has been turned off by an administrator.',
}

/** The most links and numbers an answer keeps (a records render can list many rows). */
const MAX_LINKS = 40

/**
 * Splits a server-sent event stream into events. Feed it text as it arrives; it returns the events
 * completed by that text. Comments and pings are dropped; a frame's `event:` name is the type when
 * its JSON has none.
 */
export class SseParser {
  private buffer = ''

  push(text: string): AssistantEvent[] {
    this.buffer += text.replace(/\r\n?/g, '\n')
    const events: AssistantEvent[] = []
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const event = parseFrame(frame)
      if (event) events.push(event)
    }
    return events
  }

  /** The last frame when the stream ended without a blank line. */
  flush(): AssistantEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const event = rest.trim() ? parseFrame(rest) : undefined
    return event ? [event] : []
  }
}

function parseFrame(frame: string): AssistantEvent | undefined {
  let name: string | undefined
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') name = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data.join('\n'))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const body = parsed as Json
  const type = typeof body.type === 'string' ? body.type : name
  if (!type || type === 'ping') return undefined
  return { ...body, type }
}

/** A new, empty answer for a conversation. */
export function emptyAnswer(conversationId: number): AssistantAnswer {
  return { conversationId, text: '', status: 'RUNNING', notices: [], numbers: [], links: [], tools: [] }
}

/** Folds one stream event into the answer (returns the same object, changed). */
export function applyAssistantEvent(answer: AssistantAnswer, event: AssistantEvent): AssistantAnswer {
  switch (event.type) {
    case 'message.start':
      if (typeof event.turnId === 'number') answer.turnId = event.turnId
      if (typeof event.messageId === 'number') answer.messageId = event.messageId
      break
    case 'text.delta':
      if (typeof event.text === 'string') answer.text += event.text
      break
    case 'tool.start':
      answer.tools.push({ name: String(event.name ?? ''), summary: String(event.summary ?? '') })
      break
    case 'tool.result': {
      const name = String(event.name ?? '')
      const open = [...answer.tools].reverse().find((t) => t.name === name && t.outcome === undefined)
      if (open) {
        open.outcome = String(event.outcome ?? '')
        if (typeof event.summary === 'string' && event.summary) open.summary = event.summary
      } else {
        answer.tools.push({ name, summary: String(event.summary ?? ''), outcome: String(event.outcome ?? '') })
      }
      for (const ref of asList(event.recordRefs)) addRecordRef(answer, ref)
      if (event.render && typeof event.render === 'object') addRender(answer, event.render as Json)
      break
    }
    case 'presentation':
      addPresentation(answer, (event.part ?? {}) as Json)
      break
    case 'ui.navigate':
      if (typeof event.href === 'string') addLink(answer, { label: event.href, href: event.href })
      break
    case 'notice':
      answer.notices.push({ level: String(event.level ?? 'info'), text: String(event.text ?? '') })
      break
    case 'usage':
      answer.usage = { inputTokens: num(event.inputTokens), outputTokens: num(event.outputTokens), costMicros: num(event.costMicros) }
      break
    case 'message.end':
      answer.status = event.status === 'CANCELLED' || event.status === 'ERROR' ? event.status : 'COMPLETE'
      break
    case 'error':
      answer.status = 'ERROR'
      answer.error = { code: String(event.code ?? 'INTERNAL'), message: String(event.message ?? 'The assistant could not answer.') }
      break
    default:
      break
  }
  return answer
}

function asList(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v): v is Json => Boolean(v) && typeof v === 'object') : []
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function addRecordRef(answer: AssistantAnswer, ref: Json): void {
  if (typeof ref.href !== 'string') return
  const label = String(ref.label ?? ref.id ?? ref.href)
  addLink(answer, { label: ref.tableLabel ? `${label} (${String(ref.tableLabel)})` : label, href: ref.href })
}

function addRender(answer: AssistantAnswer, render: Json): void {
  const tableLabel = String(render.tableLabel ?? render.tableName ?? '')
  if (render.type === 'count' && typeof render.count === 'number') {
    const href = typeof render.openHref === 'string' ? render.openHref : undefined
    addNumber(answer, { label: tableLabel, value: String(render.count), href })
    if (href) addLink(answer, { label: `${tableLabel} (${render.count})`, href })
  } else if (render.type === 'records') {
    for (const row of asList(render.rows)) {
      if (typeof row.href !== 'string') continue
      const values = (row.values ?? {}) as Json
      const first = Object.values(values).find((v) => typeof v === 'string' && v)
      addLink(answer, { label: `${String(first ?? row.id)} (${tableLabel})`, href: row.href })
    }
    if (typeof render.openHref === 'string') addLink(answer, { label: `${tableLabel}${typeof render.totalCount === 'number' ? ` (${render.totalCount})` : ''}`, href: render.openHref })
  } else if (render.type === 'record' && typeof render.href === 'string') {
    addLink(answer, { label: `${tableLabel} #${String(render.id ?? '')}`, href: render.href })
  }
}

function addPresentation(answer: AssistantAnswer, part: Json): void {
  if (!answer.text.trim()) {
    const markdown = typeof part.markdown === 'string' && part.markdown ? part.markdown : typeof part.summary === 'string' ? part.summary : ''
    answer.text = markdown
  }
  for (const block of asList(part.blocks)) {
    const items = asList(block.items)
    if (block.kind === 'metrics') {
      for (const item of items) {
        const value = String(item.display ?? item.value ?? '')
        const href = typeof item.href === 'string' ? item.href : undefined
        addNumber(answer, { label: String(item.label ?? ''), value, href })
        if (href) addLink(answer, { label: `${String(item.label ?? '')} (${value})`, href })
      }
    } else if (block.kind === 'recordLinks' || block.kind === 'filterLinks') {
      for (const item of items) if (typeof item.href === 'string') addLink(answer, { label: String(item.label ?? item.href), href: item.href })
    } else if (block.kind === 'table') {
      for (const row of asList(block.rows)) {
        if (typeof row.href !== 'string') continue
        const cells = (row.display ?? row.cells ?? {}) as Json
        addLink(answer, { label: Object.values(cells).filter((v) => v !== null && v !== '').slice(0, 2).join(' · ') || row.href, href: row.href })
      }
    } else if (block.kind === 'chart') {
      for (const point of asList(block.points)) if (typeof point.href === 'string') addLink(answer, { label: `${String(point.label ?? '')}: ${String(point.display ?? point.value ?? '')}`, href: point.href })
    } else if (block.kind === 'actions') {
      for (const item of items) if (typeof item.href === 'string') addLink(answer, { label: String(item.label ?? item.href), href: item.href })
    }
  }
}

function addNumber(answer: AssistantAnswer, value: AssistantNumber): void {
  if (answer.numbers.length >= MAX_LINKS) return
  if (answer.numbers.some((n) => n.label === value.label && n.value === value.value)) return
  answer.numbers.push(value)
}

function addLink(answer: AssistantAnswer, link: { label: string; href: string }): void {
  if (answer.links.length >= MAX_LINKS || answer.links.some((l) => l.href === link.href)) return
  const target = parseAppHref(link.href)
  answer.links.push({
    label: link.label,
    href: link.href,
    kind: target?.recordId !== undefined ? 'record' : target?.tableName ? 'table' : 'page',
    ...(target?.tableName ? { tableName: target.tableName } : {}),
    ...(target?.recordId !== undefined ? { recordId: target.recordId } : {}),
  })
}

/** Where an app path points: `/app/{table}`, `/app/{table}/{id}`, `/app/{table}?filter=...` (also with app segments before the table when `tables` is given). */
export interface AppHrefTarget {
  tableName?: string
  recordId?: string
  /** The `filter` query parameter, parsed (a QQueryFilter). */
  filter?: Json
  path: string
}

/**
 * Parses an app path the server built. Without `tables`, the first segment after `/app` is the
 * table; with them, the first segment that names a table is (app paths may nest apps first).
 */
export function parseAppHref(href: string, tables?: Set<string>): AppHrefTarget | undefined {
  let url: URL
  try {
    url = new URL(href, 'http://app.invalid')
  } catch {
    return undefined
  }
  const segments = url.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s) } catch { return s }
  })
  if (segments[0] !== 'app') return undefined
  const rest = segments.slice(1)
  const index = tables ? rest.findIndex((s) => tables.has(s)) : (rest.length ? 0 : -1)
  const target: AppHrefTarget = { path: url.pathname }
  if (index >= 0) {
    target.tableName = rest[index]
    const next = rest[index + 1]
    if (next !== undefined && !['create', 'dev', 'key', 'savedView'].includes(next)) target.recordId = next
  }
  const filter = url.searchParams.get('filter')
  if (filter) {
    try {
      const parsed = JSON.parse(filter) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) target.filter = parsed as Json
    } catch {
      // an unreadable filter opens the table unfiltered
    }
  }
  return target
}

/** The page context for a table, a record or a filtered grid (route as the web UI would have it). */
export function assistantContextFor(where: { tableName?: string; recordId?: string | number; filter?: Json }): AssistantPageContext | undefined {
  if (!where.tableName) return undefined
  const table = encodeURIComponent(where.tableName)
  if (where.recordId !== undefined && where.recordId !== '') {
    return { route: `/app/${table}/${encodeURIComponent(String(where.recordId))}`, tableName: where.tableName, recordId: where.recordId }
  }
  const context: AssistantPageContext = { route: `/app/${table}`, tableName: where.tableName }
  const criteria = where.filter?.criteria
  const subFilters = where.filter?.subFilters
  if ((Array.isArray(criteria) && criteria.length) || (Array.isArray(subFilters) && subFilters.length)) {
    context.filter = { criteria: criteria ?? [], ...(subFilters ? { subFilters } : {}), booleanOperator: where.filter?.booleanOperator ?? 'AND' }
  }
  return context
}

/** One line for a config: `enabled, model claude-…` or `off (NOT_CONFIGURED): …`. */
export function describeAssistantConfig(view: AssistantConfigView): string {
  if (!view.installed) return 'not installed on this server'
  if (view.enabled) return `enabled, model ${view.model ?? '?'}`
  return `off (${view.reason ?? 'unknown'})${view.message ? `: ${view.message}` : ''}`
}

/** Thrown by {@link Assistant.ask} when the server says the assistant is unavailable. */
export class AssistantUnavailableError extends UiApiError {
  constructor(readonly reason: string, message: string) {
    super(reason === 'NO_PERMISSION' ? 403 : 503, { code: reason, message, error: message })
  }
}

export interface AskOptions {
  /** Continue a conversation instead of starting one. */
  conversationId?: number
  context?: AssistantPageContext
  /** Called for each event as it arrives (text deltas while the model writes). */
  onEvent?: (event: AssistantEvent, answer: AssistantAnswer) => void
  signal?: AbortSignal
  /** Conversation title (default: the question, shortened by the server). */
  title?: string
}

/** The assistant module for one server. */
export class Assistant {
  constructor(private readonly registry: ExtensionRegistry, private readonly transport: AssistantTransport) {}

  /** Whether the server has the extension. */
  get installed(): boolean {
    return this.registry.has(ASSISTANT)
  }

  /** The feature probe; `installed: false` (no request) without the extension. */
  async config(): Promise<AssistantConfigView> {
    if (!this.installed) return { installed: false, enabled: false, starterPrompts: [] }
    const data = ((await this.transport.call('getAssistantConfig', {})).data ?? {}) as Json
    const profile = (data.profile ?? {}) as Json
    const reason = typeof data.reason === 'string' ? data.reason : undefined
    const enabled = data.enabled === true
    return {
      installed: true,
      enabled,
      ...(reason ? { reason } : {}),
      ...(!enabled ? { message: typeof data.message === 'string' && data.message ? data.message : ASSISTANT_REASON_TEXT[reason ?? ''] } : {}),
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.shortcut === 'string' ? { shortcut: data.shortcut } : {}),
      ...(typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {}),
      ...(typeof profile.greeting === 'string' ? { greeting: profile.greeting } : {}),
      starterPrompts: Array.isArray(profile.starterPrompts) ? profile.starterPrompts.filter((p): p is string => typeof p === 'string') : [],
      ...(data.limits && typeof data.limits === 'object' ? { limits: data.limits as Json } : {}),
      raw: data,
    }
  }

  /**
   * Asks a question and reads the streamed answer to its end. Throws ExtensionNotInstalledError
   * without the extension, and {@link AssistantUnavailableError} when it is off for this user.
   */
  async ask(question: string, options: AskOptions = {}): Promise<AssistantAnswer> {
    this.registry.require(ASSISTANT)
    const started = Date.now()
    let conversationId = options.conversationId
    if (conversationId === undefined) {
      const view = await this.config()
      if (!view.enabled) throw new AssistantUnavailableError(view.reason ?? 'DISABLED', view.message ?? ASSISTANT_REASON_TEXT.DISABLED)
      const created = ((await this.transport.call('postAssistantConversations', { json: { ...(options.title ? { title: options.title } : {}), ...(options.context ? { context: options.context } : {}) } })).data ?? {}) as Json
      if (typeof created.id !== 'number') throw new Error('The server did not return a conversation id.')
      conversationId = created.id
    }
    const answer = emptyAnswer(conversationId)
    const op = operation('postAssistantConversationsByIdTurns')
    if (!op) throw new Error('This client has no assistant turn operation.')
    const url = buildUrl(this.transport.baseUrl, op, { path: { id: String(conversationId) } })
    const response = await this.transport.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text: question, ...(options.context ? { pageContext: options.context } : {}), concurrency: 'supersede' }),
      signal: options.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      let body: unknown = text
      try { body = text ? JSON.parse(text) : {} } catch { /* keep the text */ }
      throw new UiApiError(response.status, body, response.headers.get('X-QQQ-Trace-Id'))
    }
    const parser = new SseParser()
    const deliver = (events: AssistantEvent[]) => {
      for (const event of events) {
        applyAssistantEvent(answer, event)
        options.onEvent?.(event, answer)
      }
    }
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          deliver(parser.push(decoder.decode(value, { stream: true })))
        }
      } finally {
        reader.releaseLock()
      }
      deliver(parser.push(decoder.decode()))
    } else {
      deliver(parser.push(await response.text()))
    }
    deliver(parser.flush())
    if (answer.status === 'RUNNING') answer.status = options.signal?.aborted ? 'CANCELLED' : 'COMPLETE'
    answer.elapsedMs = Date.now() - started
    return answer
  }
}
