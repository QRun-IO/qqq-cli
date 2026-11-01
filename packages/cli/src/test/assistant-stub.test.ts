/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { linkCommand, plainAnswer, renderAnswer } from '../commands/assistant.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_SOURCE } from './harness.js'
import { runCli, sandbox } from './harness.js'
import { StubResponse, startStub, type J, type Stub } from './stub.js'

const sse = (events: J[]) => events.map((e, i) => `event: ${String(e.type)}\nid: ${i + 1}\ndata: ${JSON.stringify({ seq: i + 1, ...e })}\n\n`).join('')

const TURN = sse([
  { type: 'message.start', turnId: 4, conversationId: 12, userMessageId: 1, messageId: 2 },
  { type: 'tool.start', messageId: 2, toolCallId: 'a', name: 'count_records', summary: 'Counting Customer' },
  { type: 'tool.result', messageId: 2, toolCallId: 'a', name: 'count_records', outcome: 'OK', summary: 'Counted',
    render: { type: 'count', tableName: 'customer', tableLabel: 'Customer', count: 42, openHref: '/app/customer' },
    recordRefs: [{ tableName: 'customer', tableLabel: 'Customer', id: 5, label: 'Acme', href: '/app/customer/5' }] },
  { type: 'text.delta', messageId: 2, text: 'There are **42** ' },
  { type: 'text.delta', messageId: 2, text: 'customers.' },
  { type: 'message.end', messageId: 2, status: 'COMPLETE' },
])

describe('qqq assistant against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let enabled = true
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([
      [/^GET \/version$/, () => ({ apiVersion: '1.9.0', supportedMajorVersions: [1], features: [], extensions: [{ name: 'assistant', version: '1.7.0' }] })],
      [/^GET \/assistant\/config$/, () => (enabled
        ? { enabled: true, model: 'llama3.3:70b-instruct-q4_K_M', shortcut: 'mod+j', limits: { maxTurnSeconds: 900 }, profile: { displayName: 'Assistant', starterPrompts: ['How many customers are there?'] } }
        : { enabled: false, reason: 'NOT_CONFIGURED', message: 'No model provider is configured on this server.', model: 'claude-sonnet-5-5', profile: { starterPrompts: [] } })],
      [/^POST \/assistant\/conversations$/, () => ({ id: 12, title: null, status: 'ACTIVE' })],
      [/^POST \/assistant\/conversations\/\d+\/turns$/, () => new StubResponse(200, TURN, { 'content-type': 'text/event-stream' })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('config: the model, or the reason and what to configure', async () => {
    enabled = true
    const r = await qqq(['-O', 'table', 'assistant', 'config'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /status\s+enabled, model llama3.3:70b-instruct-q4_K_M/)
    assert.match(r.stdout, /try asking\s+How many customers are there\?/)
    enabled = false
    const off = await qqq(['assistant', 'config', '--json'])
    assert.deepEqual(JSON.parse(off.stdout), { installed: true, enabled: false, reason: 'NOT_CONFIGURED', message: 'No model provider is configured on this server.', model: 'claude-sonnet-5-5', starterPrompts: [] })
  })

  test('ask streams the answer, then numbers and links; sends the page context', async () => {
    enabled = true
    const r = await qqq(['-O', 'table', 'assistant', 'ask', '--table', 'customer', '--record', '5', 'how', 'many', 'customers?'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^There are 42 customers\.\n/)
    assert.match(r.stdout, /Customer\s+42\n/)
    assert.match(r.stdout, /Links\n/)
    assert.match(r.stdout, /\[1\]\s+Acme \(Customer\)\s+qqq table get customer 5/)
    assert.match(r.stdout, /\[2\]\s+Customer \(42\)\s+qqq table query customer/)
    assert.doesNotMatch(r.stdout, /\/app\//)
    assert.match(r.stderr, /Counting Customer/)
    assert.match(r.stderr, /conversation 12; continue with: qqq assistant ask -c 12/)
    const created = stub.requests.find((q) => q.path === '/assistant/conversations')!
    assert.deepEqual(created.json, { context: { route: '/app/customer/5', tableName: 'customer', recordId: '5' } })
    const turn = [...stub.requests].reverse().find((q) => q.path.endsWith('/turns'))!
    assert.deepEqual(turn.json, { text: 'how many customers?', pageContext: { route: '/app/customer/5', tableName: 'customer', recordId: '5' }, concurrency: 'supersede' })
  })

  test('ask --json prints the folded answer; -c continues without a new conversation', async () => {
    enabled = true
    const before = stub.requests.filter((q) => q.path === '/assistant/conversations').length
    const r = await qqq(['assistant', 'ask', '-c', '12', '--json', 'and orders?'])
    assert.equal(r.code, 0, r.stderr)
    const answer = JSON.parse(r.stdout) as J
    assert.equal(answer.text, 'There are **42** customers.')
    assert.equal(answer.conversationId, 12)
    assert.deepEqual((answer.numbers as J[])[0], { label: 'Customer', value: '42', href: '/app/customer' })
    assert.equal(stub.requests.filter((q) => q.path === '/assistant/conversations').length, before)
  })

  test('ask when the server has no model provider: the reason, exit 4', async () => {
    enabled = false
    const r = await qqq(['assistant', 'ask', 'hello'])
    assert.equal(r.code, 4)
    assert.match(r.stderr, /No model provider is configured on this server\. \(NOT_CONFIGURED, HTTP 503\)/)
    const usage = await qqq(['assistant', 'ask', '--record', '1', 'x'])
    assert.equal(usage.code, 2)
  })

  test('plain answer text drops markdown markers', () => {
    assert.equal(plainAnswer('## Total\nThere are **42** `customers` and __3__ orders.'), 'Total\nThere are 42 customers and 3 orders.')
  })

  test('the 8078 answer about unhealthy services renders as text: no entities, no URLs, a sub-table, links once', () => {
    const fixture = JSON.parse(readFileSync(join(TEST_SOURCE, '..', '..', '..', 'core', 'src', 'test', 'fixtures', 'assistant-unhealthy.json'), 'utf8')) as { text: string; links: Array<{ label: string; href: string }> }
    const { text, links } = renderAnswer(fixture, 100)
    assert.doesNotMatch(text, /&#|\/app\/|%7B|\| ---/)
    assert.match(text, /Service\s+Status\s+Since/)
    assert.match(text, /email \[1\]\s+DEGRADED/)
    assert.match(text, /- Open unhealthy components \[4\]/)
    assert.ok(text.split('\n').every((l) => [...l].length <= 100))
    assert.deepEqual(links.map((l) => [l.n, l.label, l.open.split(' --')[0]]), [
      [1, 'email', 'qqq table get health_component 4'],
      [2, 'db_performance', 'qqq table get health_component 3'],
      [3, 'esb', 'qqq table get health_component 10'],
      [4, 'Open unhealthy components', 'qqq table query health_component'],
    ])
    assert.match(links[3]!.open, /--filter-json '\{"criteria":\[\{"fieldName":"status","operator":"NOT_EQUALS","values":\["UP"\]\}\],"booleanOperator":"AND"\}'/)
    assert.equal(linkCommand('/app/person/2'), 'qqq table get person 2')
    assert.equal(linkCommand('https://x'), '')
  })
})

