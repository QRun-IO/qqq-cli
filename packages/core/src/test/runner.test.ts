/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACK, ProcessCancelledError, ProcessError, checkInputRecords, hasInputs, inputFields, runProcess, type ProcessMeta, type ProcessStep } from '../process/runner.js'
import { buildScreen, downloadReference, screenToText, summaryLines, type ScreenBlock } from '../process/screen.js'

type Handler = (request: Request, url: URL) => Promise<unknown> | unknown

interface Call { method: string; path: string; query: Record<string, string>; values?: Record<string, unknown> }

/** A fake server: routes by `METHOD path-suffix` regexes; records every call with its multipart `values`. */
function fakeServer(routes: Array<[RegExp, Handler]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    const call: Call = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) }
    if (/multipart/.test(request.headers.get('content-type') ?? '')) {
      const form = await request.clone().formData()
      call.values = JSON.parse(String(form.get('values') ?? '{}')) as Record<string, unknown>
    }
    calls.push(call)
    const key = `${request.method} ${url.pathname}`
    const route = routes.find(([re]) => re.test(key))
    if (!route) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: key }), { status: 404, headers: { 'content-type': 'application/json' } })
    const body = await route[1](request, url)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, calls }
}

const base = 'http://qqq.test'

const steps: ProcessStep[] = [
  { name: 'setup', label: 'Setup', components: [{ type: 'HELP_TEXT', values: { text: 'Line one\nLine two' } }, { type: 'EDIT_FORM' }], formFields: [{ name: 'prefix', label: 'Prefix', type: 'STRING' }] },
  { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }], recordListFields: [{ name: 'firstName', label: 'First Name', type: 'STRING' }] },
  { name: 'results', label: 'Results', components: [{ type: 'HTML' }, { type: 'VIEW_FORM' }, { type: 'RECORD_LIST' }, { type: 'DOWNLOAD_FORM' }, { type: 'PROCESS_SUMMARY_RESULTS' }],
    viewFields: [{ name: 'count', label: 'Count', type: 'INTEGER' }, { name: 'done', label: 'Done', type: 'BOOLEAN' }], recordListFields: [{ name: 'firstName', label: 'First Name', type: 'STRING' }] },
]
const meta: ProcessMeta = { name: 'greet', label: 'Greet', tableName: 'person', frontendSteps: steps }

function greetServer(): ReturnType<typeof fakeServer> {
  let validated = false
  return fakeServer([
    [/POST .*\/greet\/init$/, () => ({ type: 'COMPLETE', processUUID: 'u1', nextStep: 'setup', values: {} })],
    [/POST .*\/u1\/step\/setup$/, () => ({ type: 'JOB_STARTED', processUUID: 'u1', jobUUID: 'j1' })],
    [/GET .*\/u1\/status\/j1$/, () => ({ type: 'COMPLETE', processUUID: 'u1', nextStep: 'review', values: { recordCount: 2, previewMessage: 'Preview', supportsFullValidation: true } })],
    [/POST .*\/u1\/step\/review$/, (_r) => {
      if (!validated) {
        validated = true
        return { type: 'COMPLETE', processUUID: 'u1', nextStep: 'review', values: { recordCount: 2, supportsFullValidation: true, validationSummary: [{ status: 'OK', count: 2, message: 'can be greeted' }] } }
      }
      return { type: 'COMPLETE', processUUID: 'u1', nextStep: 'results', values: {
        'results.html': '<p>All <b>done</b></p>', count: 2, done: true, downloadFileName: 'out.csv', serverFilePath: '/tmp/out.csv',
        processResults: [{ status: 'OK', count: 2, message: 'were greeted', primaryKeys: [1, 2] }, { status: 'WARNING', message: 'one had no name', bulletsOfText: ['id 3'] }],
      } }
    }],
    [/GET .*\/u1\/records$/, (_r, url) => {
      const all = [{ values: { firstName: 'Avery' } }, { values: { firstName: 'Blair' } }, { values: { firstName: 'Casey' } }]
      const skip = Number(url.searchParams.get('skip')), limit = Number(url.searchParams.get('limit'))
      return { records: all.slice(skip, skip + limit), totalRecords: all.length }
    }],
  ])
}

test('runner presents every screen, asks for input on input steps, follows async jobs and ends on the results', async () => {
  const server = greetServer()
  const presented: Array<{ step: string; kinds: string[]; isLast: boolean }> = []
  const provided: string[] = []
  const outcome = await runProcess({
    baseUrl: base, fetch: server.fetch, meta, pollMillis: 1, records: { ids: ['1', '2'] },
    screen: { pageSize: 2 },
    present: ({ step, screen, isLast }) => { presented.push({ step: step.name, kinds: screen.map((b) => b.kind), isLast }) },
    provide: async ({ step, values }) => {
      provided.push(step.name)
      if (step.name === 'setup') return { prefix: 'Hi' }
      return values.validationSummary ? {} : { doFullValidation: 'true' }
    },
  })
  assert.deepEqual(presented.map((p) => p.step), ['setup', 'review', 'review', 'results'])
  assert.deepEqual(presented[0]!.kinds, ['help', 'form'])
  assert.deepEqual(presented[3]!.kinds, ['html', 'view', 'records', 'download', 'summary'])
  assert.equal(presented[3]!.isLast, true)
  assert.deepEqual(provided, ['setup', 'review', 'review'])
  assert.equal(outcome.lastStep?.name, 'results')
  const init = server.calls.find((c) => c.path.endsWith('/init'))!
  assert.ok(init)
  const setup = server.calls.find((c) => c.path.endsWith('/step/setup'))!
  assert.equal(setup.values?.prefix, 'Hi')
  const reviews = server.calls.filter((c) => c.path.endsWith('/step/review'))
  assert.equal(reviews.length, 2)
  assert.equal(reviews[0]!.values?.doFullValidation, 'true')
  // the record list paged with the page size until the total
  const pages = server.calls.filter((c) => c.path.endsWith('/records')).map((c) => c.query.skip)
  assert.ok(pages.includes('0') && pages.includes('2'))

  const results = outcome.lastScreen!
  const text = screenToText(results, { table: (rows, columns) => rows.map((r) => columns.map((c) => r[c]).join('|')).join('\n'), widget: () => '' })
  assert.match(text, /All done/)
  assert.match(text, /Count: +2/)
  assert.match(text, /Done: +Yes/)
  assert.match(text, /Avery\nBlair\nCasey\n\(3 records\)/)
  assert.match(text, /file: out\.csv/)
  assert.match(text, /\[OK\] 2 were greeted/)
  assert.match(text, /\[WARNING\] one had no name\n {4}• id 3/)
})

test('VIEW_FORM values show on intermediate steps too, and a step with only a VIEW_FORM asks for nothing', async () => {
  const sleepSteps: ProcessStep[] = [
    { name: 'screen0', components: [{ type: 'EDIT_FORM', values: { includeFieldNames: ['ms'] } }, { type: 'VIEW_FORM', values: { includeFieldNames: ['message'] } }], formFields: [{ name: 'ms', label: 'Millis', type: 'INTEGER', isRequired: true }, { name: 'message', label: 'Message', type: 'STRING' }] },
    { name: 'screen1', components: [{ type: 'VIEW_FORM' }], formFields: [{ name: 'message', label: 'Message', type: 'STRING' }] },
  ]
  assert.equal(hasInputs(sleepSteps[1]!), false)
  assert.deepEqual(inputFields(sleepSteps[0]!, { type: 'COMPLETE', processUUID: 'x' }).map((f) => f.name), ['ms'])
  const server = fakeServer([
    [/init$/, () => ({ type: 'COMPLETE', processUUID: 'u2', nextStep: 'screen0', values: { message: 'before' } })],
    [/step\/screen0$/, () => ({ type: 'COMPLETE', processUUID: 'u2', nextStep: 'screen1', values: { message: 'Slept' } })],
  ])
  const screens: ScreenBlock[][] = []
  let asked = 0
  const outcome = await runProcess({ baseUrl: base, fetch: server.fetch, meta: { name: 'sleep', frontendSteps: sleepSteps }, values: { ms: '5' }, present: ({ screen }) => { screens.push(screen) }, provide: async () => { asked++; return {} } })
  assert.equal(asked, 1)
  assert.deepEqual(screens[0]!.find((b) => b.kind === 'view'), { kind: 'view', pairs: [{ name: 'message', label: 'Message', value: 'before', error: undefined }] })
  assert.deepEqual(outcome.lastScreen!.find((b) => b.kind === 'view'), { kind: 'view', pairs: [{ name: 'message', label: 'Message', value: 'Slept', error: undefined }] })
})

test('BACK restarts at the back step with isStepBack=true', async () => {
  let backs = 0
  const server = fakeServer([
    [/init$/, () => ({ type: 'COMPLETE', processUUID: 'u3', nextStep: 'edit', values: {} })],
    [/step\/edit$/, (r, url) => {
      if (url.searchParams.get('isStepBack') === 'true') {
        backs++
        return { type: 'COMPLETE', processUUID: 'u3', nextStep: 'edit', values: {} }
      }
      return { type: 'COMPLETE', processUUID: 'u3', nextStep: 'confirm', backStep: 'edit', values: {} }
    }],
    [/step\/confirm$/, () => ({ type: 'COMPLETE', processUUID: 'u3', values: { ok: true } })],
  ])
  const back: ProcessStep[] = [
    { name: 'edit', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'a', label: 'A', type: 'STRING' }] },
    { name: 'confirm', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'b', label: 'B', type: 'STRING' }] },
    { name: 'done', components: [{ type: 'VIEW_FORM' }] },
  ]
  let wentBack = false
  await runProcess({
    baseUrl: base, fetch: server.fetch, meta: { name: 'p', frontendSteps: back },
    provide: async ({ step, backStep }) => {
      if (step.name === 'confirm' && backStep && !wentBack) {
        wentBack = true
        return BACK
      }
      return { [step.name === 'edit' ? 'a' : 'b']: 'x' }
    },
  })
  assert.equal(backs, 1)
  const editCalls = server.calls.filter((c) => c.path.endsWith('/step/edit'))
  assert.equal(editCalls.length, 3)
  assert.equal(editCalls[1]!.query.isStepBack, 'true')
  assert.equal(editCalls[1]!.values?.a, 'x')
})

test('aborting the signal while a job runs calls POST …/cancel and throws ProcessCancelledError', async () => {
  const controller = new AbortController()
  const server = fakeServer([
    [/init$/, () => ({ type: 'JOB_STARTED', processUUID: 'u4', jobUUID: 'j4' })],
    [/status\/j4$/, () => {
      controller.abort()
      return { type: 'RUNNING', processUUID: 'u4', message: 'working' }
    }],
    [/POST .*\/u4\/cancel$/, () => ({})],
  ])
  await assert.rejects(runProcess({ baseUrl: base, fetch: server.fetch, meta: { name: 'slow' }, pollMillis: 1, signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof ProcessCancelledError)
    assert.equal(error.cancelled, true)
    assert.equal(error.processUUID, 'u4')
    return true
  })
  assert.ok(server.calls.some((c) => c.method === 'POST' && c.path.endsWith('/u4/cancel')))
})

test('aborting during a prompt cancels too, and a refused cancel is reported', async () => {
  const controller = new AbortController()
  const server = fakeServer([
    [/init$/, () => ({ type: 'COMPLETE', processUUID: 'u5', nextStep: 'ask', values: {} })],
    [/cancel$/, () => new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'no' }), { status: 500, headers: { 'content-type': 'application/json' } })],
  ])
  await assert.rejects(runProcess({
    baseUrl: base, fetch: server.fetch, meta: { name: 'p', frontendSteps: [{ name: 'ask', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'a', label: 'A', type: 'STRING' }] }, { name: 'end' }] },
    signal: controller.signal,
    provide: async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    },
  }), (error: unknown) => error instanceof ProcessCancelledError && !error.cancelled && /did not accept/.test(error.message))
})

test('min and max input records are checked before init', async () => {
  const limited: ProcessMeta = { name: 'p', label: 'Clone', minInputRecords: 1, maxInputRecords: 2 }
  await assert.rejects(checkInputRecords(limited, undefined), (e: unknown) => e instanceof ProcessError && /at least 1 record; none were given/.test(e.message))
  await assert.rejects(checkInputRecords(limited, { ids: ['1', '2', '3'] }), /at most 2 records; 3 given/)
  assert.equal(await checkInputRecords(limited, { ids: ['1'] }), 1)
  await assert.rejects(checkInputRecords(limited, { filter: {} }, async () => 5), /at most 2/)
  assert.equal(await checkInputRecords({ name: 'free' }, undefined), undefined)
})

test('screens: help content, HELP_TEXT preview, WIDGET named and ad hoc, Google Drive and download references', async () => {
  const server = fakeServer([
    [/POST .*\/widget\/Totals$/, async (r) => ({ type: 'statistics', label: 'Total', count: 7, received: JSON.parse(await r.text()) })],
  ])
  const blocks = await buildScreen({
    baseUrl: base, fetch: server.fetch, processName: 'p', processUUID: 'u6', values: { who: 'Avery', n: 3 },
    step: {
      name: 's', helpContents: [{ contentAsText: 'Step help.' }],
      components: [
        { type: 'HELP_TEXT', values: { text: 'Full text', previewText: 'Instructions' } },
        { type: 'WIDGET', values: { widgetName: 'Totals' } },
        { type: 'WIDGET', values: { isAdHocWidget: true, blocks: [{ blockType: 'TEXT', values: { text: 'Hello ${who}' } }] } },
        { type: 'GOOGLE_DRIVE_SELECT_FOLDER' },
        { type: 'DOWNLOAD_FORM' },
      ],
    },
  })
  assert.deepEqual(blocks.map((b) => b.kind), ['help', 'help', 'widget', 'widget', 'unavailable', 'unavailable'])
  assert.deepEqual(blocks[1], { kind: 'help', text: 'Full text', preview: 'Instructions', source: 'component' })
  const widgetCall = server.calls.find((c) => c.path.endsWith('/widget/Totals'))!
  assert.ok(widgetCall)
  const named = blocks[2] as Extract<ScreenBlock, { kind: 'widget' }>
  assert.deepEqual(named.blocks.find((b) => b.kind === 'stat'), { kind: 'stat', value: '7', context: undefined, delta: undefined })
  const adhoc = blocks[3] as Extract<ScreenBlock, { kind: 'widget' }>
  assert.deepEqual(adhoc.blocks, [{ kind: 'children', blocks: [[{ kind: 'text', text: 'Hello Avery' }]] }])
  assert.deepEqual(downloadReference({ downloadFileName: 'a.csv', storageTableName: 't', storageReference: 'r' }), { fileName: 'a.csv', query: { storageTableName: 't', storageReference: 'r' } })
  assert.equal(downloadReference({ downloadFileName: 'a.csv' }), undefined)
  assert.deepEqual(summaryLines([{ status: 'OK', tableName: 'person', recordId: 4, linkPreText: 'Created ', linkText: 'Avery' }]), [{ status: 'OK', count: undefined, message: 'Created Avery', bullets: undefined, link: 'person 4' }])
})

