/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq print` and `qqq printer` against a small fake server with the printing extension: the
 * Print process (printer form, review, result with printingJobIds), the printing tables, jobs
 * that advance a state on each read, the cancel process; and the same commands against the shared
 * fake server that does not list printing (exit 5).
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli, sandbox, startFakeServer, type FakeServer } from './harness.js'

type J = Record<string, unknown>

interface PrintServer {
  url: string
  runs: { process: string; values: J; recordIds?: string }[]
  jobs: Map<string, { status: string[]; title: string; reads: number; message?: string }>
  close(): Promise<void>
}

const PRINTERS = [
  { values: { id: 'p1', name: 'Virtual PDF printer', printer_id: 'virtual-file', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["PDF","ZPL"]' }, displayValues: { device_id: 'Virtual print agent' } },
  { values: { id: 'p2', name: 'Zebra', printer_id: 'zebra', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["ZPL"]' }, displayValues: { device_id: 'Virtual print agent' } },
]
const PRINT_META = {
  name: 'printingPrintRecords_person', label: 'Print', tableName: 'person', minInputRecords: 1,
  frontendSteps: [
    { name: 'printer', label: 'Choose a printer', formFields: [{ name: 'printingPrinterId', type: 'STRING', isRequired: true, label: 'Printer' }, { name: 'printingCopies', type: 'INTEGER', isRequired: true, label: 'Copies' }] },
    { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] },
    { name: 'result', label: 'Result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] },
  ],
}
const CANCEL_META = { name: 'printingCancelSelectedJobs', label: 'Cancel queued jobs', tableName: 'printing_job', frontendSteps: [{ name: 'review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] }, { name: 'result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] }] }

async function startPrintServer(): Promise<PrintServer> {
  const runs: PrintServer['runs'] = []
  const jobs: PrintServer['jobs'] = new Map()
  const state = new Map<string, { process: string; values: J; recordIds?: string }>()
  let next = 1
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const field = (body: string, name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1]
  const jobRecord = (id: string) => {
    const job = jobs.get(id)!
    const status = job.status[Math.min(job.reads, job.status.length - 1)]!
    job.reads++
    return { values: { id, title: job.title, status, format: 'PDF', options_json: '{"copies":1,"scale":"FIT"}', created_at: '2026-11-01T10:00:00Z', printer_row_id: 'p1', message: job.message ?? null }, displayValues: { printer_row_id: 'Virtual PDF printer' } }
  }
  const handle = (req: IncomingMessage, body: string, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname.replace(/^\/qqq\/v1/, '')
    let m: RegExpExecArray | null
    if (path === '/version') return send(res, 200, { apiVersion: '1.9.0', features: ['metaData', 'tables', 'processes', 'version', 'extensions'], extensions: [{ name: 'printing', version: '2.0.0', pathPrefix: '/qbit/printing' }] })
    if (path === '/metaData/authentication') return send(res, 200, { type: 'MOCK' })
    if (path === '/metaData') return send(res, 200, { tables: { person: { name: 'person', label: 'Person' } }, processes: { printingPrintRecords_person: { name: 'printingPrintRecords_person', label: 'Print', tableName: 'person' }, printingCancelSelectedJobs: { name: 'printingCancelSelectedJobs', tableName: 'printing_job' } }, apps: {} })
    if (path === '/metaData/process/printingPrintRecords_person') return send(res, 200, PRINT_META)
    if (path === '/metaData/process/printingCancelSelectedJobs') return send(res, 200, CANCEL_META)
    if ((m = /^\/table\/([^/]+)\/query$/.exec(path))) {
      const filter = (JSON.parse(body || '{}') as J).filter as J
      if (m[1] === 'printing_printer') return send(res, 200, { records: PRINTERS })
      if (m[1] === 'printing_device') return send(res, 200, { records: [{ values: { id: 'd1', name: 'Virtual print agent', device_status: 'ONLINE', agent_version: '0.3.1-virtual', last_seen_at: '2026-11-01T10:00:00Z' }, displayValues: { facility_id: 'Default facility' } }] })
      if (m[1] === 'printing_job') {
        const ids = ((filter.criteria as J[]).find((c) => c.fieldName === 'id')?.values as string[] | undefined) ?? [...jobs.keys()].reverse()
        return send(res, 200, { records: ids.filter((id) => jobs.has(id)).map(jobRecord) })
      }
    }
    if ((m = /^\/processes\/([^/]+)\/init$/.exec(path))) {
      const uuid = `run-${next++}`
      state.set(uuid, { process: m[1]!, values: JSON.parse(field(body, 'values') ?? '{}') as J, recordIds: field(body, 'recordIds') })
      return send(res, 200, { processUUID: uuid, nextStep: m[1] === 'printingCancelSelectedJobs' ? 'review' : 'printer', type: 'COMPLETE', values: {} })
    }
    if ((m = /^\/processes\/([^/]+)\/([^/]+)\/step\/([^/]+)$/.exec(path))) {
      const run = state.get(m[2]!)!
      Object.assign(run.values, JSON.parse(field(body, 'values') ?? '{}') as J)
      if (m[3] === 'printer') return send(res, 200, { processUUID: m[2], nextStep: 'review', type: 'COMPLETE', values: {} })
      runs.push(run)
      if (run.process === 'printingCancelSelectedJobs') {
        for (const id of (run.recordIds ?? '').split(',')) {
          const job = jobs.get(id)
          if (job) Object.assign(job, { status: ['FAILED'], reads: 0, message: 'Canceled by operator before dispatch' })
        }
        return send(res, 200, { processUUID: m[2], nextStep: 'result', type: 'COMPLETE', values: {} })
      }
      const ids: string[] = []
      for (const pk of (run.recordIds ?? '').split(',')) {
        const id = `job-${pk}`
        jobs.set(id, { status: ['QUEUED', 'RECEIVED', 'SPOOLER_COMPLETED'], title: `Person: ${pk}`, reads: 0 })
        ids.push(id)
      }
      return send(res, 200, { processUUID: m[2], nextStep: 'result', type: 'COMPLETE', values: { printingJobIds: ids.join(',') } })
    }
    return send(res, 404, { code: 'NOT_FOUND', message: `no route ${req.method} ${path}` })
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handle(req, Buffer.concat(chunks).toString('utf8'), res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runs,
    jobs,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

let printServer: PrintServer
let plain: FakeServer
let box: ReturnType<typeof sandbox>

before(async () => {
  printServer = await startPrintServer()
  plain = await startFakeServer()
  box = sandbox()
})
after(async () => {
  await printServer.close()
  await plain.close()
  box.dispose()
})

const qqq = (args: string[], server = printServer.url) => runCli(['--server', server, '-O', 'table', ...args], { QQQ_TOKEN: 'test-token', ...box.env })

describe('qqq print and qqq printer', () => {
  test('printer list and devices show the printers, printability and agent health', async () => {
    const list = await qqq(['printer', 'list'])
    assert.equal(list.code, 0, list.stderr)
    assert.match(list.stdout, /Virtual PDF printer\s+Virtual print agent\s+READY\s+yes\s+yes\s+PDF ZPL\s+p1/)
    assert.match(list.stdout, /\(2 printers; 1 can print; none remembered/)
    const devices = await qqq(['printer', 'devices'])
    assert.match(devices.stdout, /Virtual print agent\s+ONLINE\s+0\.3\.1-virtual\s+Default facility/)
    assert.match(devices.stdout, /1 online/)
  })

  test('print with no printer remembered picks the only printable one; a ZPL-only printer is refused', async () => {
    const zebra = await qqq(['print', 'person', '1', '--printer', 'zebra'])
    assert.equal(zebra.code, 2)
    assert.match(zebra.stderr, /Printer "Zebra" cannot print now: it does not take PDF/)
    const result = await qqq(['print', 'person', '1', '2', '--copies', '2'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Printing 2 person records on "Virtual PDF printer", 2 copies each/)
    assert.match(result.stderr, /job-1 {2}QUEUED[\s\S]*job-1 {2}SPOOLER_COMPLETED/)
    assert.match(result.stdout, /job-1\s+Person: 1\s+SPOOLER_COMPLETED\s+Virtual PDF printer/)
    assert.match(result.stdout, /\(2 jobs; 2 SPOOLER_COMPLETED\)/)
    const run = printServer.runs.at(-1)!
    assert.equal(run.process, 'printingPrintRecords_person')
    assert.equal(run.recordIds, '1,2')
    assert.equal(run.values.printingPrinterId, 'p1')
    assert.equal(run.values.printingCopies, 2)
  })

  test('--printer is remembered for the profile; printer use, show and forget', async () => {
    await qqq(['print', 'person', '3', '--printer', 'virt', '--no-wait'])
    const config = JSON.parse(readFileSync(join(box.env.QQQ_CONFIG_DIR!, 'config.json'), 'utf8'))
    assert.deepEqual(Object.values(config.printing.printers), [{ id: 'p1', name: 'Virtual PDF printer' }])
    assert.match((await qqq(['printer', 'show'])).stdout, /Virtual PDF printer\s+p1/)
    assert.match((await qqq(['printer', 'list'])).stdout, /^\*\s+Virtual PDF printer/m)
    assert.match((await qqq(['printer', 'use', 'zebra'])).stderr, /"Zebra" \(it cannot print now: it does not take PDF\)/)
    const refused = await qqq(['print', 'person', '1'])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /Printer "Zebra" cannot print now/)
    assert.match((await qqq(['printer', 'forget'])).stderr, /No printer remembered/)
  })

  test('--no-wait returns the queued jobs with how to follow them; job status --watch follows them', async () => {
    const queued = await qqq(['print', 'person', '4', '--no-wait'])
    assert.match(queued.stdout, /job-4\s+Person: 4\s+QUEUED/)
    assert.match(queued.stdout, /follow: qqq print job status job-4 --watch/)
    const watched = await qqq(['print', 'job', 'status', 'job-4', '--watch'])
    assert.equal(watched.code, 0, watched.stderr)
    assert.match(watched.stdout, /job-4\s+Person: 4\s+SPOOLER_COMPLETED/)
  })

  test('job list, cancel (confirmed with --yes) and a failed job exits 1 when followed', async () => {
    await qqq(['print', 'person', '5', '--no-wait'])
    assert.match((await qqq(['print', 'job', 'list'])).stdout, /job-5/)
    const unconfirmed = await qqq(['print', 'job', 'cancel', 'job-5'])
    assert.equal(unconfirmed.code, 2)
    assert.match(unconfirmed.stderr, /Pass --yes/)
    const cancelled = await qqq(['-y', 'print', 'job', 'cancel', 'job-5'])
    assert.equal(cancelled.code, 0, cancelled.stderr)
    assert.match(cancelled.stdout, /job-5\s+Person: 5\s+FAILED\s+Virtual PDF printer\s+1\s+.*Canceled by operator before dispatch/)
    assert.equal(printServer.runs.at(-1)!.process, 'printingCancelSelectedJobs')
    const followed = await qqq(['print', 'job', 'status', 'job-5', '--watch'])
    assert.equal(followed.code, 1)
  })

  test('a table without Print and an unknown job are refused clearly', async () => {
    const table = await qqq(['print', 'pet', '1'])
    assert.equal(table.code, 2)
    assert.match(table.stderr, /Print is not enabled for table "pet" on this server \(tables with Print: person\)/)
    const job = await qqq(['print', 'job', 'status', 'nope'])
    assert.equal(job.code, 1)
    assert.match(job.stderr, /No print job nope/)
  })

  test('on a server without the printing extension every command exits 5 with the installed list', async () => {
    for (const args of [['print', 'person', '1'], ['printer', 'list'], ['print', 'job', 'list']]) {
      const result = await qqq(args, plain.url)
      assert.equal(result.code, 5, `${args.join(' ')}: ${result.stderr}`)
      assert.match(result.stderr, /extension printing is not installed on this server \(installed: /)
    }
  })
})
