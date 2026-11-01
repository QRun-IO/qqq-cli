/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CallInput, CallResult } from '../api/call.js'
import { ExtensionNotInstalledError, ExtensionRegistry, knownExtension } from '../extensions/registry.js'
import { Printing, canPrintTo, isFinalJobState, jobIdsOf, jobOf, jobStateSummary, printProcessName, printerOf, readRememberedPrinter, resolvePrinter, tableHasPrint, whyNotPrintable, writeRememberedPrinter, type PrintingTransport } from '../extensions/printing.js'
import { readConfig, upsertProfile } from '../session/profiles.js'

const withPrinting = ExtensionRegistry.fromVersion({ extensions: [{ name: 'printing', version: '2.0.0' }] })
const oldPrinting = ExtensionRegistry.fromVersion({ extensions: [{ name: 'printing', version: '1.0.0' }] })
const without = ExtensionRegistry.fromVersion({ extensions: [{ name: 'esb', version: '1.1.0' }] })
const result = (data: unknown): CallResult => ({ status: 200, headers: new Headers(), data, contentType: 'application/json' })

const PRINTER_ROWS = [
  { values: { id: 'p1', name: 'Virtual PDF printer', printer_id: 'virtual-file', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["PDF","ZPL"]' }, displayValues: { device_id: 'Virtual print agent (Default facility)' } },
  { values: { id: 'p2', name: 'Zebra', printer_id: 'zebra', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["ZPL"]' } },
  { values: { id: 'p3', name: 'Laser 2', device_id: 'd2', status: 'OFFLINE', enabled: 0, available: 0, formats: '["PDF"]' } },
]

function fake(handler: (id: string, input: CallInput) => unknown, run?: PrintingTransport['runProcess']) {
  const calls: { id: string; input: CallInput }[] = []
  const runs: { name: string; values: Record<string, unknown>; recordIds: string[] }[] = []
  const transport: PrintingTransport = {
    call: async (id, input) => {
      calls.push({ id, input })
      return result(handler(id, input))
    },
    runProcess: async (name, options) => {
      runs.push({ name, ...options })
      return run ? run(name, options) : {}
    },
  }
  return { calls, runs, transport }
}

test('the client knows printing 2.0.0+; an older server counts as not installed', () => {
  assert.equal(knownExtension('printing')?.minVersion, '2.0.0')
  assert.equal(new Printing(withPrinting, fake(() => ({})).transport).available, true)
  assert.equal(new Printing(oldPrinting, fake(() => ({})).transport).available, false)
})

test('without the extension every call throws the typed error before any request', async () => {
  const { calls, runs, transport } = fake(() => ({}))
  const printing = new Printing(without, transport)
  assert.equal(printing.available, false)
  await assert.rejects(printing.printers(), (e: unknown) => e instanceof ExtensionNotInstalledError && /installed: esb 1\.1\.0/.test(e.message))
  await assert.rejects(printing.print({ table: 'person', ids: ['1'], printer: 'p1' }), ExtensionNotInstalledError)
  await assert.rejects(printing.cancel(['j1']), ExtensionNotInstalledError)
  assert.equal(calls.length + runs.length, 0)
})

test('printers: mapped from the printer table, printable ones first; printableOnly filters', async () => {
  const { calls, transport } = fake(() => ({ records: PRINTER_ROWS }))
  const printing = new Printing(withPrinting, transport)
  const all = await printing.printers()
  assert.deepEqual(all.map((p) => p.name), ['Virtual PDF printer', 'Laser 2', 'Zebra'])
  assert.deepEqual(all[0], { id: 'p1', name: 'Virtual PDF printer', printerId: 'virtual-file', deviceId: 'd1', device: 'Virtual print agent (Default facility)', status: 'READY', approved: true, exposed: true, formats: ['PDF', 'ZPL'], location: undefined, description: undefined, lastSeenAt: undefined })
  assert.equal(calls[0]!.id, 'queryTable')
  assert.deepEqual(calls[0]!.input.path, { tableName: 'printing_printer' })
  assert.deepEqual((await printing.printers({ printableOnly: true })).map((p) => p.id), ['p1'])
})

test('printability: approved, exposed and PDF, with the reason when not', () => {
  const [pdf, zpl, offline] = PRINTER_ROWS.map(printerOf)
  assert.equal(canPrintTo(pdf!), true)
  assert.equal(whyNotPrintable(zpl!), 'it does not take PDF')
  assert.equal(whyNotPrintable(offline!), 'its device does not currently expose it')
  assert.equal(whyNotPrintable({ ...pdf!, approved: false }), 'it is not approved for printing')
})

test('resolvePrinter: id, agent id, name in any case, unique prefix; ambiguity and misses name the choices', () => {
  const printers = PRINTER_ROWS.map(printerOf)
  assert.equal(resolvePrinter(printers, 'p3').name, 'Laser 2')
  assert.equal(resolvePrinter(printers, 'virtual-file').id, 'p1')
  assert.equal(resolvePrinter(printers, 'zebra').id, 'p2')
  assert.equal(resolvePrinter(printers, 'virt').id, 'p1')
  assert.throws(() => resolvePrinter(printers, 'nope'), /no printer "nope" \(printers: Virtual PDF printer, Zebra, Laser 2\)/)
  assert.throws(() => resolvePrinter([...printers, { ...printers[0]!, id: 'p9', name: 'Virtual 2' }], 'virt'), /more than one printer/)
})

test('print runs the table\'s Print process with printer, copies and the ids, and returns the job ids', async () => {
  const { runs, transport } = fake(() => ({}), async () => ({ printingJobIds: 'j1, j2' }))
  const printing = new Printing(withPrinting, transport)
  assert.deepEqual(await printing.print({ table: 'person', ids: ['1', '2'], printer: 'p1', copies: 2 }), ['j1', 'j2'])
  assert.deepEqual(runs, [{ name: 'printingPrintRecords_person', values: { printingPrinterId: 'p1', printingCopies: 2 }, recordIds: ['1', '2'] }])
  await assert.rejects(printing.print({ table: 'person', ids: [], printer: 'p1' }), /no record ids/)
  await assert.rejects(printing.print({ table: 'person', ids: ['1'], printer: 'p1', copies: 0 }), /copies/)
})

test('jobs query by ids or state, newest first; cancel runs the cancel process', async () => {
  const { calls, runs, transport } = fake(() => ({ records: [{ values: { id: 'j1', title: 'Person: Ada', status: 'QUEUED', options_json: '{"copies":2}', format: 'PDF' }, displayValues: { printer_row_id: 'Virtual PDF printer' } }] }))
  const printing = new Printing(withPrinting, transport)
  const [job] = await printing.jobs({ ids: ['j1'] })
  assert.deepEqual([job!.id, job!.status, job!.copies, job!.printer], ['j1', 'QUEUED', 2, 'Virtual PDF printer'])
  const filter = (calls[0]!.input.json as { filter: { criteria: unknown[]; orderBys: unknown[]; limit: number } }).filter
  assert.deepEqual(filter.criteria, [{ fieldName: 'id', operator: 'IN', values: ['j1'] }])
  assert.deepEqual(filter.orderBys, [{ fieldName: 'created_at', isAscending: false }])
  assert.equal(filter.limit, 1)
  await printing.jobs({ status: ['failed'] })
  assert.deepEqual((calls[1]!.input.json as { filter: { criteria: unknown[] } }).filter.criteria, [{ fieldName: 'status', operator: 'IN', values: ['FAILED'] }])
  await printing.cancel(['j1'])
  assert.deepEqual(runs, [{ name: 'printingCancelSelectedJobs', values: {}, recordIds: ['j1'] }])
})

test('watch reports each change and stops when every job is final', async () => {
  const states = [['QUEUED'], ['RECEIVED'], ['RECEIVED'], ['SPOOLER_COMPLETED']]
  let i = 0
  const { transport } = fake(() => ({ records: [{ values: { id: 'j1', title: 't', status: states[Math.min(i++, states.length - 1)]![0] } }] }))
  const seen: string[] = []
  const last = await new Printing(withPrinting, transport).watch(['j1'], { intervalMs: 1, onChange: (jobs) => seen.push(jobs[0]!.status) })
  assert.deepEqual(seen, ['QUEUED', 'RECEIVED', 'SPOOLER_COMPLETED'])
  assert.equal(last[0]!.status, 'SPOOLER_COMPLETED')
})

test('watch gives up at the timeout with the last states', async () => {
  const { transport } = fake(() => ({ records: [{ values: { id: 'j1', status: 'QUEUED' } }] }))
  const last = await new Printing(withPrinting, transport).watch(['j1'], { intervalMs: 1, timeoutMs: 5 })
  assert.equal(last[0]!.status, 'QUEUED')
})

test('helpers: final states, job ids, summaries, Print availability per table', () => {
  assert.equal(isFinalJobState('SPOOLED'), true)
  assert.equal(isFinalJobState('CLAIMED'), false)
  assert.deepEqual(jobIdsOf({ printingJobIds: 'a,b' }), ['a', 'b'])
  assert.deepEqual(jobIdsOf({}), [])
  assert.equal(jobStateSummary([jobOf({ values: { id: '1', status: 'QUEUED' } }), jobOf({ values: { id: '2', status: 'QUEUED' } }), jobOf({ values: { id: '3', status: 'FAILED' } })]), '2 QUEUED, 1 FAILED')
  assert.equal(printProcessName('order'), 'printingPrintRecords_order')
  assert.equal(tableHasPrint({ processes: { printingPrintRecords_person: {} } }, 'person'), true)
  assert.equal(tableHasPrint({ processes: {} }, 'person'), false)
  assert.equal(tableHasPrint(undefined, 'person'), false)
})

test('the chosen printer is remembered per profile and other config is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-print-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    upsertProfile('ent', { server: 'http://localhost:8078' }, {}, env)
    assert.equal(readRememberedPrinter('ent', env), undefined)
    writeRememberedPrinter('ent', { id: 'p1', name: 'Virtual PDF printer' }, env)
    writeRememberedPrinter('other', { id: 'p9' }, env)
    assert.deepEqual(readRememberedPrinter('ent', env), { id: 'p1', name: 'Virtual PDF printer' })
    assert.deepEqual(readRememberedPrinter('other', env), { id: 'p9' })
    assert.equal(readConfig(env).profiles.ent!.server, 'http://localhost:8078')
    writeRememberedPrinter('ent', undefined, env)
    assert.equal(readRememberedPrinter('ent', env), undefined)
    assert.match(readFileSync(join(dir, 'config.json'), 'utf8'), /"other"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
