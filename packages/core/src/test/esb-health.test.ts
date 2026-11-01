/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EsbTriggerError, esbTriggersOf, resolveEsbTrigger } from '../extensions/esb.js'
import { healthSummaryFromProbe, probeHealth } from '../extensions/health.js'

const OVERVIEW = {
  destinations: [
    { name: 'orderEvents', type: 'TOPIC', triggers: [{ name: 'syncOrder.orderEvents', processName: 'syncOrder', processLabel: 'Sync Order' }, { name: 'auditOrder.orderEvents', processName: 'auditOrder' }] },
    { name: 'twice', type: 'TOPIC', triggers: [{ name: 'a.twice', processName: 'p' }, { name: 'b.twice', processName: 'p' }] },
    { name: 'empty', type: 'TOPIC', triggers: [] },
  ],
}

test('a trigger is found by its name, its process name or label', () => {
  const triggers = esbTriggersOf(OVERVIEW, 'orderEvents')
  assert.equal(resolveEsbTrigger(triggers, 'orderEvents', 'syncOrder.orderEvents'), 'syncOrder.orderEvents')
  assert.equal(resolveEsbTrigger(triggers, 'orderEvents', 'syncOrder'), 'syncOrder.orderEvents')
  assert.equal(resolveEsbTrigger(triggers, 'orderEvents', 'sync order'), 'syncOrder.orderEvents')
  assert.deepEqual(esbTriggersOf(OVERVIEW, 'nope'), [])
})

test('no trigger, an unknown one, or a process with several: the error lists the valid triggers', () => {
  const triggers = esbTriggersOf(OVERVIEW, 'orderEvents')
  assert.throws(() => resolveEsbTrigger(triggers, 'orderEvents'), (e: unknown) => e instanceof EsbTriggerError && /pass --trigger with one of: syncOrder\.orderEvents \(process syncOrder\), auditOrder\.orderEvents \(process auditOrder\)/.test(e.message))
  assert.throws(() => resolveEsbTrigger(triggers, 'orderEvents', 'nope'), /No trigger nope on orderEvents; its triggers: syncOrder\.orderEvents/)
  assert.throws(() => resolveEsbTrigger(esbTriggersOf(OVERVIEW, 'twice'), 'twice', 'p'), /Process p has 2 triggers on twice; pass --trigger with one of: a\.twice \(process p\), b\.twice \(process p\)/)
  assert.throws(() => resolveEsbTrigger([], 'empty', 'x'), /empty has no triggers/)
})

test('a plain /health answer becomes a summary marked as unadvertised', async () => {
  const body = { status: 'UNKNOWN', timestamp: 1793531653.6, checks: { memory: { status: 'UP', durationMs: 0, details: { usedPercent: '1.5' } }, slack: { status: 'UNKNOWN', durationMs: 1 } } }
  const summary = healthSummaryFromProbe(body)!
  assert.equal(summary.status, 'UNKNOWN')
  assert.equal(summary.since, new Date(1793531653600).toISOString())
  assert.deepEqual(summary.components.map((c) => [c.name, c.status]), [['memory', 'UP'], ['slack', 'UNKNOWN']])
  assert.equal(summary.advertised, false)
  assert.match(summary.note, /does not advertise the health extension/)
  assert.equal(healthSummaryFromProbe({ nope: 1 }), undefined)
  assert.equal(healthSummaryFromProbe('UP'), undefined)

  const seen: string[] = []
  const fake = (answer: Response | Error) => (async (url: string | URL | Request) => {
    seen.push(String(url))
    if (answer instanceof Error) throw answer
    return answer
  }) as typeof fetch
  assert.equal((await probeHealth('http://s.example/', fake(new Response(JSON.stringify(body), { status: 200 }))))?.status, 'UNKNOWN')
  assert.equal(seen[0], 'http://s.example/health')
  assert.equal(await probeHealth('http://s.example', fake(new Response('no', { status: 404 }))), undefined)
  assert.equal(await probeHealth('http://s.example', fake(new Response('<html>', { status: 200 }))), undefined)
  assert.equal(await probeHealth('http://s.example', fake(new TypeError('fetch failed'))), undefined)
})
