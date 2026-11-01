/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** A fake UI API server for in-memory TUI tests: a person table with pets, a contingent address form, a process. */

import { accRoute } from './fake-acc'
import { collabRoute, fakeExtensions } from './fake-collab'
import { bulkProcessesMeta, bulkRoute } from './fake-bulk'
import { savedReportWidgets, shareRoute } from './fake-share'
import { dashApp, dashWidgets, widgetRoute } from './fake-widgets'
import { secApps, secProcesses, secRoute, secTables } from './fake-sec'
import { printProcessesMeta, printRoute } from './fake-print'

type J = Record<string, unknown>

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const PEOPLE = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, firstName: `First${i + 1}`, lastName: i % 2 ? 'Odd' : 'Even', birthDate: `19${70 + (i % 30)}-01-01` }))

const personMeta = {
  name: 'person', label: 'Person', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, capabilities: ['TABLE_QUERY'],
  fields: {
    id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false },
    firstName: { name: 'firstName', label: 'First Name', type: 'STRING', isRequired: true },
    lastName: { name: 'lastName', label: 'Last Name', type: 'STRING' },
    birthDate: { name: 'birthDate', label: 'Birth Date', type: 'DATE' },
  },
  sections: [{ name: 'identity', label: 'Identity', tier: 'T1', fieldNames: ['id', 'firstName', 'lastName'] }, { name: 'more', label: 'More', tier: 'T2', fieldNames: ['birthDate'] }],
  associations: [],
}

const addressMeta = {
  name: 'address', label: 'Address', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true,
  fields: {
    id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false },
    label: { name: 'label', label: 'Label', type: 'STRING' },
    countryId: { name: 'countryId', label: 'Country', type: 'STRING', possibleValueSourceName: 'country' },
    stateId: { name: 'stateId', label: 'State', type: 'STRING', possibleValueSourceName: 'state', possibleValueSourceDependsOn: ['countryId'], possibleValueSourceDependencyBehavior: 'DISABLE_UNTIL_SET' },
  },
  sections: [{ name: 's', label: 'Address', tier: 'T1', fieldNames: ['id', 'label', 'countryId', 'stateId'] }],
}

const STATES: Record<string, Array<{ id: string; label: string }>> = { USA: [{ id: 'MO', label: 'Missouri' }, { id: 'IL', label: 'Illinois' }], CAN: [{ id: 'ON', label: 'Ontario' }] }

const processMeta = {
  name: 'sleeper', label: 'Sleeper', frontendSteps: [
    { name: 'input', label: 'Input', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'millis', label: 'Millis', type: 'INTEGER', isRequired: true }] },
    { name: 'result', label: 'Result', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'message', label: 'Message', type: 'STRING' }] },
  ],
}

const docMeta = {
  name: 'doc', label: 'Doc', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true,
  fields: { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, title: { name: 'title', label: 'Title', type: 'STRING' }, content: { name: 'content', label: 'Content', type: 'BLOB' } },
  sections: [{ name: 's', label: 'Doc', tier: 'T1', fieldNames: ['id', 'title', 'content'] }],
}

/** An order table with an exposed many-side join to its lines, saved views, T1 quick filters and a joined section field. */
const orderMeta = {
  name: 'order', label: 'Order', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true,
  fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, number: { name: 'number', label: 'Number', type: 'STRING' }, placed: { name: 'placed', label: 'Placed', type: 'DATE' } },
  sections: [{ name: 's', label: 'Order', tier: 'T1', fieldNames: ['id', 'number', 'placed'] }, { name: 'l', label: 'First line', tier: 'T2', fieldNames: ['line.sku'] }],
  exposedJoins: [{ label: 'Line', isMany: true, joinTable: { name: 'line', label: 'Order Line', primaryKeyField: 'id', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, sku: { name: 'sku', label: 'SKU', type: 'STRING' } } }, joinPath: [{ name: 'orderJoinLine', leftTable: 'order', rightTable: 'line' }] }],
  clientCapabilities: { savedViews: { available: true, queryProcessName: 'querySavedView', storeProcessName: 'storeSavedView', deleteProcessName: 'deleteSavedView' } },
}
const ORDERS = [{ id: 1, number: 'SO-1', placed: '2026-10-31' }, { id: 2, number: 'SO-2', placed: '2026-11-01' }]

const wideMeta = {
  name: 'wide', label: 'Wide', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true,
  fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, name: { name: 'name', label: 'Name', type: 'STRING' }, note: { name: 'note', label: 'Note', type: 'STRING' } },
  sections: [{ name: 's', label: 'Wide', tier: 'T1', fieldNames: ['id', 'name', 'note'] }],
}
/** Rows 1-20 are short; rows 21-40 have much longer values (column widths must not move). */
export const WIDE = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: i < 20 ? `n${i + 1}` : `a-much-longer-name-number-${i + 1}-xxxxxxxxxxxx`, note: i < 20 ? 'short' : 'y'.repeat(70) }))

export interface FakeLog { requests: Array<{ method: string; path: string; body?: unknown; auth?: string; cookie?: string }> }

/**
 * Sign-in behaviour of the fake: the authentication type, TABLE_BASED users, and `expire` (the
 * next data request answers 401 once, as an expired session does).
 */
export interface FakeAuth {
  type: string
  users?: Record<string, string>
  expire?: boolean
  sessions: Set<string>
  /** values of the authentication metadata (OAUTH2: nativeClientId, baseUrl). */
  values?: Record<string, unknown>
}

/** A fetch answering the operations the TUI uses. */
export function fakeFetch(log: FakeLog = { requests: [] }, bigMeta?: unknown, auth?: FakeAuth): typeof fetch {
  let statusPolls = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    const path = url.pathname.replace('/qqq/v1', '')
    let body: unknown
    const type = request.headers.get('content-type') ?? ''
    if (request.method !== 'GET') {
      if (type.includes('json')) body = await request.json()
      else if (type.includes('form')) body = Object.fromEntries((await request.formData()).entries())
    }
    log.requests.push({ method: request.method, path, body, auth: request.headers.get('authorization') ?? undefined, cookie: request.headers.get('cookie') ?? undefined })
    if (auth) {
      if (path === '/metaData/authentication') return json({ type: auth.type, name: auth.type.toLowerCase(), values: { appName: 'Fake Corp', ...auth.values } })
      if (path === '/manageSession') {
        const basic = request.headers.get('authorization') ?? ''
        if (auth.type === 'TABLE_BASED') {
          const [user, password] = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString('utf8').split(':')
          if (!user || auth.users?.[user] !== password) return json({ message: 'Unable to authenticate' }, 401)
          const uuid = `s-${auth.sessions.size + 1}`
          auth.sessions.add(uuid)
          return json({ uuid, values: { user: { username: user, name: user } } })
        }
        if (auth.type === 'AUTH_0') {
          const token = (body as { accessToken?: string } | undefined)?.accessToken
          if (!token || token !== auth.values?.expectedToken) return json({ message: 'Unable to validate the access token' }, 401)
        }
        const uuid = `s-${auth.sessions.size + 1}`
        auth.sessions.add(uuid)
        return json({ uuid, values: { user: { name: 'Tester', email: 'auth0@fake.test' } } })
      }
      if (path === '/logout') {
        const uuid = /sessionUUID=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
        if (uuid) auth.sessions.delete(uuid)
        return json({})
      }
      if (auth.expire && path.startsWith('/table/')) {
        auth.expire = false
        auth.sessions.clear()
        return json({ message: 'Session expired' }, 401)
      }
    }
    const print = await printRoute(path, request.method, body)
    if (print) return print
    const acc = await accRoute(path, request.method, body, url)
    if (acc) return acc
    const bulk = await bulkRoute(path, request.method, body)
    if (bulk) return bulk
    const share = await shareRoute(path, request.method, body)
    if (share) return share
    const widget = await widgetRoute(path, body)
    if (widget) return widget
    const sec = await secRoute(path, request.method)
    if (sec) return sec
    const collab = await collabRoute(path, request.method, body)
    if (collab) return collab
    if (path === '/version') return json({ apiVersion: '1.8.0', features: ['metaData', 'tables', 'processes'], extensions: [...fakeExtensions] })
    if (path === '/metaData' && bigMeta) return json(bigMeta)
    if (path === '/metaData') {
      return json({
        apps: { ...secApps, dash: dashApp, people: { name: 'people', label: 'People', children: [{ type: 'TABLE', name: 'person', label: 'Person' }, { type: 'TABLE', name: 'address', label: 'Address' }, { type: 'PROCESS', name: 'sleeper', label: 'Sleeper' }] } },
        appTree: [{ type: 'APP', name: 'people', label: 'People', children: [{ type: 'TABLE', name: 'person', label: 'Person' }, { type: 'TABLE', name: 'address', label: 'Address' }, { type: 'PROCESS', name: 'sleeper', label: 'Sleeper' }] }],
        tables: { person: { name: 'person', label: 'Person', insertPermission: true }, address: { name: 'address', label: 'Address', insertPermission: true }, wide: { name: 'wide', label: 'Wide' }, order: { name: 'order', label: 'Order' }, acc: { name: 'acc', label: 'Acc', insertPermission: true }, part: { name: 'part', label: 'Part', insertPermission: true }, scriptRevisionFile: { name: 'scriptRevisionFile', label: 'Files' }, line: { name: 'line', label: 'Order Line' }, vt: { name: 'vt', label: 'Variant Table' }, doc: { name: 'doc', label: 'Doc', insertPermission: true }, blk: { name: 'blk', label: 'Blk', insertPermission: true }, savedReport: { name: 'savedReport', label: 'Saved Report' }, savedView: { name: 'savedView', label: 'Saved View', isHidden: true }, ...secTables },
        processes: { ...bulkProcessesMeta, ...secProcesses, ...printProcessesMeta(), adhoc: { name: 'adhoc', label: 'Ad hoc' }, adhocfile: { name: 'adhocfile', label: 'Ad hoc file' }, setupProc: { name: 'setupProc', label: 'Report setup' }, sleeper: { name: 'sleeper', label: 'Sleeper', tableName: 'person' }, scanner: { name: 'scanner', label: 'Scanner' }, wizard: { name: 'wizard', label: 'Wizard' }, GetAuditsForRecord: { name: 'GetAuditsForRecord', label: 'Audits', isHidden: true }, columnStats: { name: 'columnStats', label: 'Stats', isHidden: true }, querySavedView: { name: 'querySavedView', label: 'q', isHidden: true } },
        reports: { deniedReport: { name: 'deniedReport', label: 'Denied report', hasPermission: false }, streamReport: { name: 'streamReport', label: 'Stream report' }, wizReport: { name: 'wizReport', label: 'Wizard report', processName: 'wizard' } },
        widgets: { ...dashWidgets, ...savedReportWidgets, ctxWidget: { name: 'ctxWidget', label: 'Context' }, stepWidget: { name: 'stepWidget', label: 'Step widget' }, payloadWidget: { name: 'payloadWidget', label: 'Payload' } }, branding: { appName: 'Fake' },
      })
    }
    if (path === '/metaData/table/person') return json(personMeta)
    if (path === '/metaData/table/wide') return json(wideMeta)
    if (path === '/metaData/table/doc') return json(docMeta)
    if (path === '/metaData/table/order') return json(orderMeta)
    if (path === '/table/order/count') {
      const crit = (((body as J).filter ?? {}) as { criteria?: Array<{ fieldName: string; values: string[] }> }).criteria ?? []
      const n = ORDERS.filter((o) => crit.every((c) => String((o as J)[c.fieldName]) === String(c.values[0]))).length
      return json(JSON.stringify((body as J).joins ?? null).includes('line') ? { count: 3, distinctCount: 2 } : { count: n })
    }
    if (path === '/table/order/query') {
      const joined = JSON.stringify((body as J).joins ?? null).includes('line')
      const f = ((body as J).filter ?? {}) as { criteria?: Array<{ fieldName: string; values: string[] }> }
      let rows = joined ? [{ ...ORDERS[0], 'line.sku': 'A-1' }, { ...ORDERS[0], 'line.sku': 'A-2' }, { ...ORDERS[1], 'line.sku': 'B-1' }] : ORDERS.map((o) => ({ ...o }))
      for (const c of f.criteria ?? []) rows = rows.filter((r) => String((r as J)[c.fieldName]) === String(c.values[0]))
      return json({ records: rows.map((r) => ({ values: r, displayValues: {}, recordLabel: String(r.number) })) })
    }
    if (path === '/table/order/1' && request.method === 'GET') return json({ record: { values: ORDERS[0], displayValues: {}, recordLabel: 'SO-1' } })
    if (path === '/processes/querySavedView/init') return json({ type: 'COMPLETE', processUUID: 'sv', values: { savedViewList: [{ values: { id: 7, label: 'Recent orders', tableName: 'order', doCount: true, viewJson: JSON.stringify({ queryFilter: { criteria: [{ fieldName: 'number', operator: 'EQUALS', values: ['SO-2'] }], booleanOperator: 'AND' } }) } }] } })
    if (path === '/processes/scanner/init') return json({ type: 'COMPLETE', processUUID: 'sc', nextStep: 'scan', values: {} })
    if (path === '/processes/scanner/sc/step/scan') return json({ type: 'COMPLETE', processUUID: 'sc', nextStep: 'done', values: { message: `scanned ${JSON.parse(String((body as J).values ?? '{}')).barcode}` } })
    if (path === '/metaData/process/scanner') return json({ name: 'scanner', label: 'Scanner', frontendSteps: [{ name: 'scan', label: 'Scan', format: 'scanner', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'barcode', label: 'Barcode', type: 'STRING', isRequired: true }] }, { name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'message', label: 'Message', type: 'STRING' }] }] })
    if (path === '/processes/sleeper/init' && (body as J)?.filterJSON) {
      log.requests.at(-1)!.body = { filterJSON: JSON.parse(String((body as J).filterJSON)) }
      return json({ type: 'COMPLETE', processUUID: 'p1', nextStep: 'input', values: {} })
    }
    if (path === '/metaData/table/vt') return json({ ...wideMeta, name: 'vt', label: 'Variant Table', usesVariants: true, variantTableLabel: 'Client' })
    if (path === '/table/vt/variants') return json({ variants: [{ id: '1', type: 'client', name: 'Acme' }, { id: '2', type: 'client', name: 'Globex' }] })
    if (path === '/reports/streamReport') return new Response(`fmt,${url.searchParams.get('format')}\n`, { status: 200, headers: { 'content-type': 'text/csv' } })
    if (path === '/table/vt/count') return json({ count: url.searchParams.get('tableVariant') ? 3 : 0 })
    if (path === '/table/vt/query') return json({ records: url.searchParams.get('tableVariant') ? WIDE.slice(0, 3).map((w) => ({ values: w, recordLabel: w.name })) : [] })
    if (path === '/table/doc' && request.method === 'POST') {
      const b = body as Record<string, unknown>
      const file = b.content as File | undefined
      const text = file && typeof file === 'object' ? await file.text() : ''
      log.requests.at(-1)!.body = { title: b.title, content: file && typeof file === 'object' ? `${file.name}:${text}` : b.content }
      return json({ record: { values: { id: 5, title: b.title, content: Buffer.from(text).toString('base64') }, recordLabel: String(b.title) } })
    }
    if (path === '/table/doc/5' && request.method === 'GET') return json({ record: { values: { id: 5, title: 'Report', content: Buffer.from('file body').toString('base64') }, displayValues: {}, recordLabel: 'Report' } })
    if (path === '/table/person/export') {
      const b = body as { filter: { criteria?: Array<{ fieldName: string; values: string[] }> }; fieldNames: string[]; format: string }
      let rows = [...PEOPLE]
      for (const c of b.filter.criteria ?? []) rows = rows.filter((p) => String((p as J)[c.fieldName]) === String(c.values[0]))
      const csv = [b.fieldNames.join(','), ...rows.map((r) => b.fieldNames.map((f) => String((r as J)[f] ?? '')).join(','))].join('\n')
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })
    }
    if (path === '/table/wide/count') return json({ count: WIDE.length })
    if (path === '/table/wide/query') {
      const f = ((body as J).filter ?? {}) as { skip?: number; limit?: number }
      return json({ records: WIDE.slice(f.skip ?? 0, (f.skip ?? 0) + (f.limit ?? 50)).map((w) => ({ values: w, displayValues: {}, recordLabel: w.name })) })
    }
    if (path === '/metaData/table/address') return json(addressMeta)
    if (path === '/metaData/process/sleeper') return json(processMeta)
    const filter = ((body as J | undefined)?.filter ?? {}) as { skip?: number; limit?: number; orderBys?: Array<{ fieldName: string; isAscending: boolean }>; criteria?: Array<{ fieldName: string; values: string[] }> }
    let people = [...PEOPLE]
    const matches = (p: J, c: { fieldName: string; operator?: string; values: unknown[] }) => (c.operator === 'CONTAINS' ? String(p[c.fieldName] ?? '').toLowerCase().includes(String(c.values[0]).toLowerCase()) : String(p[c.fieldName]) === String(c.values[0]))
    if ((filter as { booleanOperator?: string }).booleanOperator === 'OR' && filter.criteria?.length) people = people.filter((p) => filter.criteria!.some((c) => matches(p as J, c as never)))
    else for (const c of filter.criteria ?? []) people = people.filter((p) => matches(p as J, c as never))
    const order = filter.orderBys?.[0]
    const key = (o: J) => (typeof o[order?.fieldName ?? 'id'] === 'number' ? (o[order?.fieldName ?? 'id'] as number) : String(o[order?.fieldName ?? 'id']))
    if (order) people.sort((a, b) => (key(a) < key(b) ? -1 : 1) * (order.isAscending ? 1 : -1))
    if (path === '/table/person/count') return json({ count: people.length })
    if (path === '/table/person/query') {
      const page = people.slice(filter.skip ?? 0, (filter.skip ?? 0) + (filter.limit ?? 50))
      return json({ records: page.map((p) => ({ values: p, displayValues: {}, recordLabel: `${p.firstName} ${p.lastName}` })) })
    }
    const rec = /^\/table\/person\/(\d+)$/.exec(path)
    if (rec && request.method === 'GET') {
      const p = PEOPLE.find((x) => x.id === Number(rec[1]))
      return p ? json({ record: { values: p, displayValues: {}, recordLabel: `${p.firstName} ${p.lastName}`, associatedRecords: {} } }) : json({ code: 'NOT_FOUND', message: 'no' }, 404)
    }
    const pv = /^\/table\/address\/possibleValues\/(\w+)$/.exec(path)
    if (pv) {
      const b = body as { searchTerm?: string; ids?: string[]; labels?: string[]; values?: J }
      let options = pv[1] === 'countryId' ? [{ id: 'USA', label: 'USA' }, { id: 'CAN', label: 'Canada' }] : STATES[String(b.values?.countryId ?? '')] ?? []
      if (b.ids?.length) options = options.filter((o) => b.ids!.includes(o.id))
      if (b.labels?.length) options = options.filter((o) => b.labels!.some((l) => l.toLowerCase() === o.label.toLowerCase()))
      if (b.searchTerm) options = options.filter((o) => o.label.toLowerCase().includes(b.searchTerm!.toLowerCase()))
      return json({ options })
    }
    if (path === '/table/address' && request.method === 'POST') return json({ record: { values: { id: 9, ...(body as J) }, recordLabel: 'new' } })
    if (path === '/processes/sleeper/init') return json({ type: 'COMPLETE', processUUID: 'p1', nextStep: 'input', values: {} })
    if (path === '/processes/sleeper/p1/step/input') return json({ type: 'JOB_STARTED', processUUID: 'p1', jobUUID: 'j1' })
    if (path === '/processes/sleeper/p1/status/j1') {
      statusPolls++
      if (statusPolls < 2) return json({ type: 'RUNNING', processUUID: 'p1', message: 'sleeping', current: 1, total: 2 })
      const millis = (log.requests.find((r) => r.path === '/processes/sleeper/p1/step/input')?.body as J | undefined)?.values
      return json({ type: 'COMPLETE', processUUID: 'p1', nextStep: 'result', values: { message: `slept ${JSON.parse(String(millis ?? '{}')).millis}` } })
    }
    return json({ code: 'NOT_FOUND', message: `fake server has no ${request.method} ${path}` }, 404)
  }) as typeof fetch
}
