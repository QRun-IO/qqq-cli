/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Dashboards against a stub: a heavy 24-widget app loads each widget once within budget; a process widget runs its process. */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type J, type Stub } from './stub.js'

const kinds = ['statistics', 'barChart', 'lineChart', 'pieChart', 'table', 'table'] as const
const names = Array.from({ length: 24 }, (_, i) => `w${String(i).padStart(2, '0')}`)
const payload = (i: number): J => {
  const type = kinds[i % kinds.length]!
  if (type === 'statistics') return { type, count: 1000 + i, countContext: 'records' }
  if (type === 'table') return { type, columns: [{ accessor: 'id', header: 'Id' }, { accessor: 'name', header: 'Name' }], rows: Array.from({ length: 100 }, (_, r) => ({ id: r + 1, name: `row ${r + 1}` })) }
  return { type, chartData: { labels: ['a', 'b', 'c'], datasets: [{ label: 'n', data: [1, 2, 3] }] } }
}

describe('dashboards against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    const widgets: Record<string, J> = Object.fromEntries(names.map((n, i) => [n, { name: n, label: `Widget ${i}`, type: kinds[i % kinds.length], gridColumns: i % 3 === 0 ? 12 : 6 }]))
    widgets.runIt = { name: 'runIt', label: 'Run It', type: 'process' }
    widgets.filterSetup = { name: 'filterSetup', label: 'Filter', type: 'filterAndColumnsSetup' }
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: {}, processes: { hello: { name: 'hello', label: 'Hello' } }, widgets, apps: { heavy: { name: 'heavy', label: 'Heavy Dashboard', widgets: names, children: [] } }, appTree: [] })],
      [/^POST \/widget\/runIt$/, () => ({ type: 'process', processMetaData: { name: 'hello', label: 'Hello' }, defaultValues: { greeting: 'hi' } })],
      [/^POST \/widget\/w(\d+)$/, (r) => new Promise((resolve) => setTimeout(() => resolve(payload(Number(/w(\d+)/.exec(r.path)![1]))), 150))],
      [/^GET \/metaData\/process\/hello$/, () => ({ name: 'hello', label: 'Hello', frontendSteps: [{ name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'reply', label: 'Reply', type: 'STRING' }] }] })],
      [/^GET \/metaData\/process\/setup$/, () => ({ name: 'setup', label: 'Setup', frontendSteps: [{ name: 'pick', label: 'Pick', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'queryFilterJson', label: 'Filter', type: 'TEXT', adornments: [{ type: 'WIDGET', values: { widgetName: 'filterSetup' } }] }] }, { name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [] }] })],
      [/^POST \/processes\/setup\/init$/, () => ({ type: 'COMPLETE', processUUID: 's', nextStep: 'pick', values: {} })],
      [/^POST \/processes\/setup\/s\/step\/pick$/, () => ({ type: 'COMPLETE', processUUID: 's', nextStep: 'done', values: {} })],
      [/^POST \/processes\/hello\/init$/, (r) => ({ type: 'COMPLETE', processUUID: 'p', nextStep: 'done', values: { reply: `${String(r.values.greeting)} there` } })],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('a heavy dashboard: 24 widgets (statistics, charts, 100-row tables) load once each, concurrently, in declared order', async () => {
    const started = Date.now()
    const r = await qqq(['apps', 'show', 'heavy', '--widgets', '--no-counts', '-O', 'table'])
    const elapsed = Date.now() - started
    assert.equal(r.code, 0, r.stderr)
    const calls = stub.requests.filter((q) => /^\/widget\/w\d+$/.test(q.path)).map((q) => q.path)
    assert.equal(calls.length, 24)
    assert.equal(new Set(calls).size, 24)
    const order = [...r.stdout.matchAll(/== Widget (\d+) \((\d+)\/12\) ==/g)].map((m) => Number(m[1]))
    assert.deepEqual(order, names.map((_, i) => i))
    assert.match(r.stdout, /== Widget 0 \(12\/12\) ==\n1,000 records/)
    assert.match(r.stdout, /row 100/)
    // 24 widgets at 150 ms each: well under the 24 x 150 ms a serial load would take, plus CLI start-up
    assert.ok(elapsed < 3000, `took ${elapsed} ms`)
    assert.match(r.stderr, /24 widgets loaded once each/)
  })

  test('a process widget runs its process with the widget\'s default values', async () => {
    const shown = await qqq(['widget', 'get', 'runIt', '-O', 'table'])
    assert.match(shown.stdout, /qqq process run hello -v greeting=hi/)
    const r = await qqq(['widget', 'get', 'runIt', '--run', '-O', 'table'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Reply: +hi there/)
    assert.equal(stub.requests.find((q) => q.path === '/processes/hello/init')!.values.greeting, 'hi')
  })

  test('a WIDGET-adorned filter field takes the filter grammar and writes its QueryFilter JSON', async () => {
    const r = await qqq(['process', 'run', 'setup', '-v', 'queryFilterJson=state = IL AND total > 10', '--quiet'])
    assert.equal(r.code, 0, r.stderr)
    const sent = JSON.parse(String(stub.requests.find((q) => /\/step\/pick$/.test(q.path))!.values.queryFilterJson))
    assert.deepEqual(sent.criteria.map((c: J) => c.fieldName), ['state', 'total'])
    assert.equal(sent.booleanOperator, 'AND')
  })
})
