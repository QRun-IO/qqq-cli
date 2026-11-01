/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { App } from '../src/app'
import { chatLines, contextLabel, plainText, wrap } from '../src/assistant/model'
import { boot, parseArgs } from '../src/boot'
import { fakeFetch, type FakeLog } from './fake-server'
import { command, isolate, press, sessionSecrets, waitFor, type Harness } from './helpers'

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const sse = (events: J[]) => events.map((e, i) => `event: ${String(e.type)}\nid: ${i + 1}\ndata: ${JSON.stringify({ seq: i + 1, ...e })}\n\n`).join('')

const TURN = sse([
  { type: 'message.start', turnId: 1, conversationId: 7, userMessageId: 1, messageId: 2 },
  { type: 'tool.start', messageId: 2, toolCallId: 'a', name: 'count_records', summary: 'Counting Person' },
  { type: 'tool.result', messageId: 2, toolCallId: 'a', name: 'count_records', outcome: 'OK', summary: 'Counted',
    render: { type: 'count', tableName: 'person', tableLabel: 'Person', count: 3, openHref: '/app/person' },
    recordRefs: [{ tableName: 'person', tableLabel: 'Person', id: 2, label: 'Blair Sample', href: '/app/person/2' }] },
  { type: 'text.delta', messageId: 2, text: 'There are **3** people.' },
  { type: 'message.end', messageId: 2, status: 'COMPLETE' },
])

interface AssistantFake { installed: boolean; config: J; turns: J[]; conversations: J[] }

function assistantFetch(log: FakeLog, state: AssistantFake): typeof fetch {
  const base = fakeFetch(log)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    const path = new URL(request.url).pathname.replace('/qqq/v1', '')
    if (path === '/version') return json({ apiVersion: '1.9.0', features: ['metaData', 'tables', 'processes'], extensions: state.installed ? [{ name: 'assistant', version: '1.7.0', pathPrefix: '/assistant' }] : [] })
    if (!path.startsWith('/assistant')) return base(input, init)
    const body = request.method === 'POST' ? await request.json().catch(() => undefined) as J | undefined : undefined
    log.requests.push({ method: request.method, path, body })
    if (path === '/assistant/config') return json(state.config)
    if (path === '/assistant/conversations') {
      state.conversations.push(body ?? {})
      return json({ id: 7, title: null, status: 'ACTIVE' })
    }
    if (/^\/assistant\/conversations\/\d+\/turns$/.test(path)) {
      state.turns.push(body ?? {})
      return new Response(TURN, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return json({ code: 'NOT_FOUND', message: path }, 404)
  }) as typeof fetch
}

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const ENABLED = { enabled: true, model: 'llama3.3:70b-instruct-q4_K_M', profile: { displayName: 'Assistant', starterPrompts: ['How many people are there?'] } }

async function start(state: AssistantFake, width = 120, height = 36): Promise<Harness> {
  const log: FakeLog = { requests: [] }
  const store = boot({ args: parseArgs(['--profile', 'fake']), quit: () => undefined, build: 'test', secrets: sessionSecrets, fetch: assistantFetch(log, state) })
  const setup = await testRender(<App store={store} />, { width, height })
  const harness: Harness = { setup, store, log, frame: () => setup.captureCharFrame() }
  await waitFor(harness, () => harness.store.screen?.kind === 'home' && Boolean(harness.store.meta))
  return harness
}

const key = (k: string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => press(h!, () => h!.setup.mockInput.pressKey(k as never, mods))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
/** No frame line is wider than the terminal (the clipping rule). */
const fits = (frame: string, width: number) => frame.split('\n').every((l) => [...l].length <= width)
const fresh = (): AssistantFake => ({ installed: true, config: ENABLED, turns: [], conversations: [] })

test('without the extension: Ctrl+G and :ask say what is missing, the menu entry is disabled, no requests', async () => {
  h = await start({ ...fresh(), installed: false })
  await key('g', { ctrl: true })
  await waitFor(h, (f) => f.includes('needs the assistant extension'))
  expect(h.store.assistantOpen).toBe(false)
  await command(h, 'ask how many')
  expect(h.store.assistantOpen).toBe(false)
  const entry = (h.store.commandsImpl!(h.store) as unknown as { entries(t: string): Array<{ label: string; disabled?: string }> }).entries('').find((e) => e.label === 'Assistant')
  expect(entry?.disabled).toContain('needs the assistant extension')
  expect(h.log.requests.some((r) => r.path.startsWith('/assistant'))).toBe(false)
})

test('on a record at 120 columns: a right-hand pane, the record as context, the answer with numbers and links; Enter on a link opens it', async () => {
  const state = fresh()
  h = await start(state, 120, 36)
  await command(h, 'record person 1')
  await waitFor(h, () => h!.store.screen?.kind === 'record')
  await key('g', { ctrl: true })
  let f = await waitFor(h, (x) => x.includes('Assistant · llama3.3'))
  expect(f).toContain('on: Person #1')
  expect(f).toContain('How many people are there?')
  await type('how many people are there')
  await key('RETURN')
  f = await waitFor(h, (x) => x.includes('There are 3 people.'))
  expect(f).toContain('You: how many people are there')
  expect(f).toContain('# Person: 3')
  expect(f).toContain('→ Blair Sample (Person)')
  expect(fits(f, 120)).toBe(true)
  // the record stays visible on the left
  expect(h.store.screen?.kind).toBe('record')
  expect(state.conversations[0]).toEqual({ context: { route: '/app/person/1', tableName: 'person', recordId: '1' } })
  expect(state.turns[0]).toEqual({ text: 'how many people are there', pageContext: { route: '/app/person/1', tableName: 'person', recordId: '1' }, concurrency: 'supersede' })
  // Tab to the links (Blair Sample, then Person (3)); Enter opens the record beside the panel
  await key('TAB')
  await key('RETURN')
  await waitFor(h, () => (h!.store.screen as unknown as { primaryKey?: string })?.primaryKey === '2')
  expect(h.store.assistantOpen).toBe(true)
  expect(h.store.focus).toBe('content')
  // Ctrl+G back to the panel; ↑ recalls the question (history per profile); a follow-up continues the conversation
  await key('g', { ctrl: true })
  expect(h.store.focus).toBe('assistant')
  await key('ARROW_UP')
  expect(h.store.assistant!.editor.value).toBe('how many people are there')
  await key('RETURN')
  await waitFor(h, () => state.turns.length === 2)
  expect(state.conversations.length).toBe(1)
  expect((state.turns[1]!.pageContext as J).recordId).toBe('2')
  await key('ESCAPE')
  expect(h.store.assistantOpen).toBe(false)
})

test('at 80×24: the panel takes the whole body, fits, F1 lists its keys; Ctrl+D drops the context', async () => {
  const state = fresh()
  h = await start(state, 80, 24)
  await command(h, 'open person')
  await waitFor(h, () => h!.store.screen?.kind === 'table')
  await command(h, 'ask how many people are there')
  const f = await waitFor(h, (x) => x.includes('There are 3 people.'))
  expect(h.store.assistantLayout()?.mode).toBe('full')
  expect(fits(f, 80)).toBe(true)
  expect(f).toContain('on: Person (Ctrl+D drops)')
  expect(state.turns[0]!.pageContext).toEqual({ route: '/app/person', tableName: 'person' })
  await key('d', { ctrl: true })
  expect(await waitFor(h, (x) => x.includes('no page context (Ctrl+D adds it)'))).toBeTruthy()
  await key('F1')
  await waitFor(h, (x) => x.includes('Keys'))
  let seen = false
  for (let i = 0; i < 6 && !seen; i++) seen = (await key('f', { ctrl: true })).includes('question history of this profile')
  expect(seen).toBe(true)
  await key('ESCAPE')
  // Enter on a link closes the full-width panel so the grid shows
  await key('TAB')
  await key('RETURN')
  await waitFor(h, () => !h!.store.assistantOpen)
})

test('assistant off (no model provider): the panel shows the reason and what to configure; nothing is sent', async () => {
  const state = { ...fresh(), config: { enabled: false, reason: 'NOT_CONFIGURED', message: 'No model provider is configured on this server. An administrator adds an enabled provider on Assistant > Providers.' } }
  h = await start(state, 100, 30)
  await key('g', { ctrl: true })
  const f = await waitFor(h, (x) => x.includes('The assistant is off (NOT_CONFIGURED).'))
  expect(f).toContain('No model provider is configured')
  expect(fits(f, 100)).toBe(true)
  await type('hello')
  await key('RETURN')
  await waitFor(h, (x) => x.includes('assistant off (NOT_CONFIGURED)'))
  expect(state.turns.length).toBe(0)
})

test('chat lines wrap to the width, number links across exchanges and drop markdown', () => {
  expect(plainText('**42** `x` ## no')).toBe('42 x ## no')
  expect(wrap('alpha beta gamma delta', 11)).toEqual(['alpha beta', 'gamma delta'])
  expect(wrap('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl'])
  const answer = (href: string) => ({ conversationId: 1, text: 'ok', status: 'COMPLETE' as const, notices: [], numbers: [], tools: [], links: [{ label: href, href, kind: 'record' as const }] })
  const lines = chatLines([{ question: 'q1', startedAt: 0, answer: answer('/app/a/1') }, { question: 'q2', startedAt: 0, answer: answer('/app/a/2') }], 30)
  expect(lines.filter((l) => l.role === 'link').map((l) => l.link)).toEqual([0, 1])
  expect(lines.every((l) => [...l.text].length <= 30)).toBe(true)
  expect(contextLabel({ tableName: 'order', recordId: 5 }, 'Order')).toBe('Order #5')
  expect(contextLabel({ tableName: 'order', filter: {} }, 'Order')).toBe('Order (filtered)')
})
