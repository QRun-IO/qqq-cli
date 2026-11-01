/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import type { CallInput, CallResult } from '../api/call.js'
import { Assistant, AssistantUnavailableError, SseParser, applyAssistantEvent, assistantContextFor, describeAssistantConfig, emptyAnswer, parseAppHref, type AssistantEvent } from '../extensions/assistant.js'
import { ExtensionNotInstalledError, ExtensionRegistry } from '../extensions/registry.js'

const withAssistant = ExtensionRegistry.fromVersion({ extensions: [{ name: 'assistant', version: '1.7.0' }] })
const without = ExtensionRegistry.fromVersion({ extensions: [{ name: 'esb', version: '1.1.0' }] })
const result = (data: unknown): CallResult => ({ status: 200, headers: new Headers(), data, contentType: 'application/json' })

/** SSE frames as the qbit writes them: event name, id, one JSON data line. */
function frames(events: AssistantEvent[]): string {
  return events.map((e, i) => `event: ${e.type}\nid: ${i + 1}\ndata: ${JSON.stringify({ seq: i + 1, ...e })}\n\n`).join('')
}

const TURN: AssistantEvent[] = [
  { type: 'message.start', turnId: 7, conversationId: 3, userMessageId: 10, messageId: 11 },
  { type: 'turn.phase', phase: 'tool', toolName: 'count_records' },
  { type: 'tool.start', messageId: 11, toolCallId: 't1', name: 'count_records', summary: 'Counting Customer' },
  { type: 'tool.result', messageId: 11, toolCallId: 't1', name: 'count_records', outcome: 'OK', summary: 'Counted 42 Customer records',
    render: { type: 'count', tableName: 'customer', tableLabel: 'Customer', count: 42, openHref: '/app/customer' } },
  { type: 'text.delta', messageId: 11, text: 'There are ' },
  { type: 'text.delta', messageId: 11, text: '**42** customers.' },
  { type: 'tool.result', messageId: 11, toolCallId: 't2', name: 'get_record', outcome: 'OK', summary: 'Read one',
    recordRefs: [{ tableName: 'customer', tableLabel: 'Customer', id: 5, label: 'Acme', href: '/app/customer/5' }] },
  { type: 'usage', turnId: 7, inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
  { type: 'message.end', messageId: 11, status: 'COMPLETE' },
]

/** A fake server: records calls and the turn request, streams the frames in small chunks. */
function fake(config: unknown, stream: string, status = 200) {
  const calls: { id: string; input: CallInput }[] = []
  const requests: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    if (status !== 200) return new Response(JSON.stringify({ error: 'nope', code: 'NOT_CONFIGURED', message: 'No model provider is configured.' }), { status, headers: { 'Content-Type': 'application/json' } })
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < stream.length; i += 17) controller.enqueue(encoder.encode(stream.slice(i, i + 17)))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  const assistant = (registry = withAssistant) => new Assistant(registry, {
    baseUrl: 'http://server',
    fetch: fetchImpl,
    call: async (id, input) => {
      calls.push({ id, input })
      if (id === 'getAssistantConfig') return result(config)
      if (id === 'postAssistantConversations') return result({ id: 3, title: null, status: 'ACTIVE' })
      throw new Error(`unexpected ${id}`)
    },
  })
  return { calls, requests, assistant }
}

test('SSE frames split across chunks and CRLF; pings and comments dropped', () => {
  const parser = new SseParser()
  const out = [
    ...parser.push(': hello\r\nevent: ping\r\ndata: {}\r\n\r\nevent: text.del'),
    ...parser.push('ta\ndata: {"seq":1,"text":"Hi"}\n\n'),
    ...parser.push('data: {"type":"message.end","status":"COMPLETE"}'),
    ...parser.flush(),
  ]
  assert.deepEqual(out.map((e) => e.type), ['text.delta', 'message.end'])
  assert.equal(out[0]!.text, 'Hi')
})

test('ask creates a conversation with the page context, streams the turn, folds the answer', async () => {
  const { calls, requests, assistant } = fake({ enabled: true, model: 'llama3.3' }, frames(TURN))
  const seen: string[] = []
  const answer = await assistant().ask('how many customers are there', {
    context: assistantContextFor({ tableName: 'customer', recordId: 5 }),
    onEvent: (event) => seen.push(event.type),
  })
  assert.deepEqual(calls.map((c) => c.id), ['getAssistantConfig', 'postAssistantConversations'])
  assert.deepEqual(calls[1]!.input.json, { context: { route: '/app/customer/5', tableName: 'customer', recordId: 5 } })
  assert.equal(requests[0]!.url, 'http://server/qqq/v1/assistant/conversations/3/turns')
  assert.equal((requests[0]!.init!.headers as Record<string, string>).Accept, 'text/event-stream')
  assert.deepEqual(JSON.parse(String(requests[0]!.init!.body)), { text: 'how many customers are there', pageContext: { route: '/app/customer/5', tableName: 'customer', recordId: 5 }, concurrency: 'supersede' })
  assert.ok(seen.includes('text.delta') && !seen.includes('ping'))
  assert.equal(answer.text, 'There are **42** customers.')
  assert.equal(answer.status, 'COMPLETE')
  assert.equal(answer.turnId, 7)
  assert.deepEqual(answer.numbers, [{ label: 'Customer', value: '42', href: '/app/customer' }])
  assert.deepEqual(answer.links.map((l) => [l.kind, l.tableName, l.recordId ?? null, l.href]), [
    ['table', 'customer', null, '/app/customer'],
    ['record', 'customer', '5', '/app/customer/5'],
  ])
  assert.deepEqual(answer.tools.map((t) => [t.name, t.outcome]), [['count_records', 'OK'], ['get_record', 'OK']])
  assert.equal(answer.usage?.inputTokens, 900)
})

test('ask continues a conversation without probing again', async () => {
  const { calls, requests, assistant } = fake({ enabled: true }, frames([{ type: 'text.delta', text: 'ok' }, { type: 'message.end', status: 'COMPLETE' }]))
  const answer = await assistant().ask('and orders?', { conversationId: 9 })
  assert.equal(calls.length, 0)
  assert.match(requests[0]!.url, /conversations\/9\/turns$/)
  assert.equal(answer.text, 'ok')
})

test('unavailable: reason and the server message, or the client wording before 1.7.0', async () => {
  const off = fake({ enabled: false, reason: 'NOT_CONFIGURED', message: 'No model provider is configured on this server. An administrator adds one.' }, '')
  await assert.rejects(off.assistant().ask('hi'), (error: unknown) => {
    assert.ok(error instanceof AssistantUnavailableError && error instanceof UiApiError)
    assert.equal(error.code, 'NOT_CONFIGURED')
    assert.equal(error.status, 503)
    assert.match(error.message, /No model provider/)
    return true
  })
  const view = await fake({ enabled: false, reason: 'NO_PERMISSION' }, '').assistant().config()
  assert.equal(view.message, 'You do not have access to the assistant.')
  assert.equal(describeAssistantConfig(view), 'off (NO_PERMISSION): You do not have access to the assistant.')
  assert.equal(describeAssistantConfig(await fake({ enabled: true, model: 'm' }, '').assistant().config()), 'enabled, model m')
})

test('without the extension: config says so with no request; ask throws ExtensionNotInstalledError', async () => {
  const { calls, assistant } = fake({}, '')
  const view = await assistant(without).config()
  assert.deepEqual(view, { installed: false, enabled: false, starterPrompts: [] })
  assert.equal(describeAssistantConfig(view), 'not installed on this server')
  await assert.rejects(assistant(without).ask('hi'), ExtensionNotInstalledError)
  assert.equal(calls.length, 0)
})

test('a refused turn surfaces as UiApiError with the server code', async () => {
  const { assistant } = fake({ enabled: true }, '', 503)
  await assert.rejects(assistant().ask('hi', { conversationId: 1 }), (error: unknown) => error instanceof UiApiError && error.code === 'NOT_CONFIGURED')
})

test('stream errors and presentation blocks', () => {
  const answer = emptyAnswer(1)
  applyAssistantEvent(answer, { type: 'presentation', part: { type: 'presentation', summary: 's', markdown: '42 customers', blocks: [
    { kind: 'metrics', items: [{ label: 'Customers', value: 42, display: '42', href: '/app/customer' }] },
    { kind: 'recordLinks', items: [{ label: 'Acme', tableName: 'customer', recordId: 5, href: '/app/customer/5' }] },
    { kind: 'filterLinks', items: [{ label: 'Active', tableName: 'customer', href: '/app/customer?filter=%7B%22criteria%22%3A%5B%5D%7D' }] },
    { kind: 'mystery', items: [] },
  ] } })
  applyAssistantEvent(answer, { type: 'error', code: 'TIMEOUT', message: 'Took too long.' })
  assert.equal(answer.text, '42 customers')
  assert.deepEqual(answer.numbers, [{ label: 'Customers', value: '42', href: '/app/customer' }])
  assert.equal(answer.links.length, 3)
  assert.equal(answer.status, 'ERROR')
  assert.deepEqual(answer.error, { code: 'TIMEOUT', message: 'Took too long.' })
})

test('app hrefs: record, table, filter, nested apps', () => {
  assert.deepEqual(parseAppHref('/app/customer/5'), { path: '/app/customer/5', tableName: 'customer', recordId: '5' })
  assert.deepEqual(parseAppHref('/app/customer'), { path: '/app/customer', tableName: 'customer' })
  assert.deepEqual(parseAppHref('/app/customer?filter=' + encodeURIComponent('{"criteria":[{"fieldName":"id","operator":"EQUALS","values":[1]}]}'))?.filter,
    { criteria: [{ fieldName: 'id', operator: 'EQUALS', values: [1] }] })
  const b64 = Buffer.from('{"booleanOperator":"AND","criteria":[{"fieldName":"name","operator":"EQUALS","values":["Zoë"]}]}', 'utf8').toString('base64')
  assert.deepEqual(parseAppHref(`/app/customer?filter=${encodeURIComponent(b64)}`)?.filter, { booleanOperator: 'AND', criteria: [{ fieldName: 'name', operator: 'EQUALS', values: ['Zoë'] }] })
  assert.deepEqual(parseAppHref('/app/sales/customer/7', new Set(['customer'])), { path: '/app/sales/customer/7', tableName: 'customer', recordId: '7' })
  assert.equal(parseAppHref('/app/customer/create')?.recordId, undefined)
  assert.equal(parseAppHref('https://evil.example/x'), undefined)
  assert.equal(parseAppHref('/other'), undefined)
})

test('page context for a filtered grid keeps criteria only when there are some', () => {
  assert.deepEqual(assistantContextFor({ tableName: 'order', filter: { criteria: [] } }), { route: '/app/order', tableName: 'order' })
  assert.deepEqual(assistantContextFor({ tableName: 'order', filter: { criteria: [{ fieldName: 'status', operator: 'EQUALS', values: ['open'] }] } }),
    { route: '/app/order', tableName: 'order', filter: { criteria: [{ fieldName: 'status', operator: 'EQUALS', values: ['open'] }], booleanOperator: 'AND' } })
  assert.equal(assistantContextFor({}), undefined)
})
