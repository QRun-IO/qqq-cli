/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The gaps an enterprise sweep (qqq-all with the full QBit set) found: extension results in table
 * output, the -o convention, ESB trigger names, login moving a profile, and the unadvertised
 * health endpoint. A small fake enterprise server answers the extension routes; the table flag
 * tests use the shared fake server.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { TEST_SOURCE, runCli, sandbox, startFakeServer, type CliResult, type FakeServer } from './harness.js'

type J = Record<string, unknown>

const GOLDEN = join(TEST_SOURCE, 'golden')

function golden(name: string, result: CliResult, url: string): void {
  const actual = `${result.stdout.split(url).join('http://fake')}--- stderr ---\n${result.stderr.split(url).join('http://fake')}--- exit ${result.code}\n`.replace(/\r\n/g, '\n')
  const file = join(GOLDEN, `${name}.txt`)
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(file, actual)
    if (process.env.UPDATE_GOLDEN !== '1') assert.fail(`wrote missing golden ${name}.txt; check it and run again`)
    return
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `golden ${name}.txt (UPDATE_GOLDEN=1 rewrites it)`)
}

const INBOX = {
  items: [
    { id: 7, notificationId: 7, title: 'Send Test Event To Webhook failed', body: 'No records were selected.', severity: 'ERROR', category: 'JOB', source: 'processes', href: '/app/webhook', deliveredAt: '2026-11-01T11:08:07Z', age: '4 min', unread: true, sticky: false, actions: [{ label: 'Mark read', name: 'read' }, { label: 'Dismiss', name: 'dismiss' }] },
    { id: 6, notificationId: 6, title: 'Calculate Order Total (JavaScript) failed', body: 'Supply quantity 1..1000', severity: 'ERROR', category: 'JOB', source: 'processes', href: null, deliveredAt: '2026-11-01T11:05:29Z', age: '7 min', unread: true, sticky: false, actions: [] },
  ],
  total: 2,
  offset: 0,
  limit: 25,
}

interface Enterprise {
  url: string
  requests: Array<{ path: string; query: J }>
  health: boolean
  close(): Promise<void>
}

/** A fake enterprise server: alerts and esb installed, health served at /health but not listed. */
async function startEnterprise(): Promise<Enterprise> {
  const state: Enterprise = { url: '', requests: [], health: true, close: async () => {} }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    state.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const path = url.pathname
    if (path === '/health') return state.health ? send(200, { status: 'UP', timestamp: 1793531653.5, checks: { memory: { status: 'UP', durationMs: 0, details: { usedPercent: '1.5' } }, slack: { status: 'UNKNOWN', durationMs: 1 } } }) : send(404, { message: 'no' })
    if (path === '/qqq/v1/version') return send(200, { apiVersion: '1.9.0', features: ['metaData'], extensions: [{ name: 'esb', version: '1.1.0', pathPrefix: '/esb' }, { name: 'alerts', version: '1.2.0', pathPrefix: '/alerts' }] })
    if (path === '/qqq/v1/metaData/authentication') return send(200, { type: 'MOCK', values: {} })
    if (path === '/qqq/v1/manageSession') return send(200, { uuid: 'session-1', values: { user: { name: 'Admin' } } })
    if (path === '/qqq/v1/alerts/inbox') return send(200, INBOX)
    if (path === '/qqq/v1/esb/overview') return send(200, { providers: [], destinations: [{ name: 'orderEvents', type: 'TOPIC', triggers: [{ name: 'syncOrder.orderEvents', processName: 'syncOrder' }] }] })
    if (path === '/qqq/v1/esb/messages/orderEvents') {
      const trigger = url.searchParams.get('trigger')
      if (!trigger) return send(400, { code: 'BAD_REQUEST', message: "A topic's messages are kept on each of its triggers' subscriptions: name one of the triggers of orderEvents in the trigger parameter." })
      if (trigger !== 'syncOrder.orderEvents') return send(404, { code: 'NOT_FOUND', message: `Trigger ${trigger} was not found on orderEvents.` })
      return send(200, { messages: [{ messageId: 'm-1', timestamp: '2026-11-01T11:00:00Z', deliveryCount: 1, event: 'INSERT', rawBody: '{"id":1}' }], hasMore: false })
    }
    return send(404, { code: 'NOT_FOUND', message: `no route ${path}` })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  return state
}

describe('enterprise gaps', { concurrency: true }, () => {
  let ent: Enterprise
  let fake: FakeServer
  let box: ReturnType<typeof sandbox>
  before(async () => {
    ent = await startEnterprise()
    fake = await startFakeServer()
    box = sandbox()
  })
  after(async () => {
    await ent.close()
    await fake.close()
    box.dispose()
  })
  const onEnt = (args: string[]) => runCli(['--server', ent.url, ...args], { QQQ_TOKEN: 'test-token', ...box.env })
  const onFake = (args: string[]) => runCli(['--server', fake.url, ...args], { QQQ_TOKEN: 'test-token', ...box.env })
  const lastBody = (path: RegExp) => JSON.parse([...fake.requests].reverse().find((r) => r.method === 'POST' && path.test(r.path))!.body) as { filter?: { orderBys?: unknown } }

  test('an extension list prints as a sub-table with default columns; --columns chooses; --json is unchanged', async () => {
    golden('ext-alerts-inbox', await onEnt(['alerts', 'get-inbox', '-O', 'table']), ent.url)
    golden('ext-alerts-inbox-columns', await onEnt(['alerts', 'get-inbox', '-O', 'table', '--columns', 'id,title,actions']), ent.url)
    const json = await onEnt(['alerts', 'get-inbox', '--json'])
    assert.deepEqual(JSON.parse(json.stdout), INBOX)
  })

  test('esb messages: a topic without --trigger lists the triggers; a process name finds its trigger', async () => {
    const none = await onEnt(['esb', 'messages', 'orderEvents'])
    assert.equal(none.code, 2, none.stderr)
    assert.match(none.stderr, /orderEvents is a topic: .* pass --trigger with one of: syncOrder\.orderEvents \(process syncOrder\)/)
    const byProcess = await onEnt(['esb', 'messages', 'orderEvents', '--trigger', 'syncOrder', '--json'])
    assert.equal(byProcess.code, 0, byProcess.stderr)
    assert.match(byProcess.stderr, /trigger syncOrder\.orderEvents \(of process syncOrder\)/)
    assert.equal((JSON.parse(byProcess.stdout) as { messages: unknown[] }).messages.length, 1)
    const wrong = await onEnt(['esb', 'messages', 'orderEvents', '--trigger', 'nope'])
    assert.equal(wrong.code, 2)
    assert.match(wrong.stderr, /No trigger nope on orderEvents; its triggers: syncOrder\.orderEvents/)
  })

  test('health get-summary falls back to /health when the extension is not advertised, with a note', async () => {
    const result = await onEnt(['health', 'get-summary', '-O', 'table'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /does not advertise the health extension/)
    assert.match(result.stdout, /^status +UP$/m)
    assert.match(result.stdout, /^components \(2\)\nname +status +durationMs +details$/m)
    assert.match(result.stdout, /^advertised +false$/m)
    ent.health = false
    try {
      const absent = await onEnt(['health', 'get-summary'])
      assert.equal(absent.code, 5)
      assert.match(absent.stderr, /getHealthSummary belongs to extension health, which is not installed/)
    } finally {
      ent.health = true
    }
  })

  test('-o is the output file of table export; --order sorts', async () => {
    const file = join(box.env.HOME!, 'people.csv')
    const result = await onFake(['table', 'export', 'person', '-o', file, '--order', '-id'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(readFileSync(file, 'utf8'), 'id,firstName\n1,Avery\n2,Blair\n')
    assert.deepEqual(lastBody(/\/table\/person\/export$/).filter?.orderBys, [{ fieldName: 'id', isAscending: false }])
  })

  test('-o still sorts table query for one release, with a deprecation note; a path-like sort field warns', async () => {
    const old = await onFake(['table', 'query', 'person', '-o', '-id', '--limit', '1', '--json'])
    assert.equal(old.code, 0, old.stderr)
    assert.match(old.stderr, /-o for the sort order is deprecated; use --order/)
    assert.deepEqual(lastBody(/\/table\/person\/query$/).filter?.orderBys, [{ fieldName: 'id', isAscending: false }])
    const pathy = await onFake(['table', 'query', 'person', '--order', 'out.csv', '--print-filter'])
    assert.match(pathy.stderr, /the sort field "out\.csv" looks like a file path/)
    const help = await onFake(['table', 'query', '--help'])
    assert.doesNotMatch(help.stdout, /-o[, ]/)
    assert.match(help.stdout, /--order <field\.\.\.>/)
    const exportHelp = await onFake(['table', 'export', '--help'])
    assert.match(exportHelp.stdout, /-o, --out <file>/)
  })

  test('login --server for an existing profile warns and needs --yes; --profile <new> creates one', async () => {
    const home = sandbox()
    try {
      const env: Record<string, string> = { ...home.env, QQQ_PROFILE: 'ent' }
      mkdirSync(env.QQQ_CONFIG_DIR!, { recursive: true })
      const config = join(env.QQQ_CONFIG_DIR!, 'config.json')
      writeFileSync(config, JSON.stringify({ profiles: { ent: { server: 'http://127.0.0.1:9' } }, defaultProfile: 'ent' }))
      const refused = await runCli(['login', '--server', ent.url], env)
      assert.equal(refused.code, 2, refused.stderr)
      assert.match(refused.stderr, /warning: profile "ent" \(QQQ_PROFILE=ent\) points at http:\/\/127\.0\.0\.1:9; signing in to .* would point it there instead/)
      assert.match(refused.stderr, /nothing was changed\. Pass --yes .* or --profile <new-name>/)
      assert.equal((JSON.parse(readFileSync(config, 'utf8')) as { profiles: Record<string, { server: string }> }).profiles.ent!.server, 'http://127.0.0.1:9')

      const created = await runCli(['login', '--server', ent.url, '--profile', 'enterprise'], env)
      assert.equal(created.code, 0, created.stderr)
      let profiles = (JSON.parse(readFileSync(config, 'utf8')) as { profiles: Record<string, { server: string }> }).profiles
      assert.equal(profiles.ent!.server, 'http://127.0.0.1:9')
      assert.equal(profiles.enterprise!.server, ent.url)

      const moved = await runCli(['login', '--server', ent.url, '--yes'], env)
      assert.equal(moved.code, 0, moved.stderr)
      profiles = (JSON.parse(readFileSync(config, 'utf8')) as { profiles: Record<string, { server: string }> }).profiles
      assert.equal(profiles.ent!.server, ent.url)
    } finally {
      home.dispose()
    }
  })
})
