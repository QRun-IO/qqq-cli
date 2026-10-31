/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** A fake UI API server for in-memory TUI tests: a person table with pets, a contingent address form, a process. */

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

export interface FakeLog { requests: Array<{ method: string; path: string; body?: unknown }> }

/** A fetch answering the operations the TUI uses. */
export function fakeFetch(log: FakeLog = { requests: [] }): typeof fetch {
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
    log.requests.push({ method: request.method, path, body })
    if (path === '/version') return json({ apiVersion: '1.8.0', features: ['metaData', 'tables', 'processes'], extensions: [] })
    if (path === '/metaData') {
      return json({
        apps: { people: { name: 'people', label: 'People', children: [{ type: 'TABLE', name: 'person', label: 'Person' }, { type: 'TABLE', name: 'address', label: 'Address' }, { type: 'PROCESS', name: 'sleeper', label: 'Sleeper' }] } },
        appTree: [{ type: 'APP', name: 'people', label: 'People', children: [{ type: 'TABLE', name: 'person', label: 'Person' }, { type: 'TABLE', name: 'address', label: 'Address' }, { type: 'PROCESS', name: 'sleeper', label: 'Sleeper' }] }],
        tables: { person: { name: 'person', label: 'Person', insertPermission: true }, address: { name: 'address', label: 'Address', insertPermission: true } },
        processes: { sleeper: { name: 'sleeper', label: 'Sleeper' } },
        widgets: {}, branding: { appName: 'Fake' },
      })
    }
    if (path === '/metaData/table/person') return json(personMeta)
    if (path === '/metaData/table/address') return json(addressMeta)
    if (path === '/metaData/process/sleeper') return json(processMeta)
    const filter = ((body as J | undefined)?.filter ?? {}) as { skip?: number; limit?: number; orderBys?: Array<{ fieldName: string; isAscending: boolean }>; criteria?: Array<{ fieldName: string; values: string[] }> }
    let people = [...PEOPLE]
    for (const c of filter.criteria ?? []) people = people.filter((p) => String((p as J)[c.fieldName]) === String(c.values[0]))
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
