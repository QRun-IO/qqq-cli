/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The sql-workbench extension on top of the fake server: /version lists it (or not), the metadata
 * carries the SQL Workbench app with its Runner (a SQL_WORKBENCH widget), and /sql-workbench/*
 * answers capabilities, schema, execute and rows (with server-side sort), explain, history and
 * notebooks from memory.
 */

import { fakeFetch, type FakeLog } from './fake-server'

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const CUSTOMERS = Array.from({ length: 250 }, (_, i) => [i + 1, i === 2 ? null : `Customer ${String(i + 1).padStart(3, '0')}`, `c${i + 1}@example.test`])

const SCHEMA = {
  backendName: 'h2', dialect: 'h2',
  schemas: [{ name: 'PUBLIC', tables: [
    { name: 'CUSTOMER', type: 'BASE TABLE', columns: [{ name: 'ID', typeName: 'INTEGER' }, { name: 'NAME', typeName: 'VARCHAR' }, { name: 'EMAIL', typeName: 'VARCHAR' }] },
    { name: 'ORDERS', type: 'BASE TABLE', columns: [{ name: 'ID', typeName: 'INTEGER' }, { name: 'CUSTOMER_ID', typeName: 'INTEGER' }, { name: 'STATUS', typeName: 'VARCHAR' }] },
  ] }],
  qqqTables: [{ name: 'order', sqlName: 'orders', fields: [] }],
  keywords: ['SELECT', 'FROM', 'QUALIFY'], functions: ['abs'],
}

const PLAN = { label: 'Plan', children: [{ label: 'SELECT', totalCost: 10, children: [{ label: 'Seq Scan CUSTOMER', totalCost: 8, planRows: 250 }] }] }

export interface SqlFakeState {
  executions: Array<{ uuid: string; sql: string; params?: unknown; status: string }>
  notebooks: Array<J & { id: number }>
  rowsCalls: Array<Record<string, string>>
}

export const SQL_APPS = {
  sqlWorkbench: { name: 'sqlWorkbench', label: 'SQL Workbench', widgets: [], children: [{ type: 'APP', name: 'sqlWorkbenchRunner', label: 'Runner' }] },
  sqlWorkbenchRunner: { name: 'sqlWorkbenchRunner', label: 'Runner', widgets: ['sqlWorkbenchWidget'], children: [], helpContents: { help: [{ contentAsText: 'The notebook editor: write SQL in cells.' }] } },
}

/** A fetch: the fake server plus the SQL workbench (installed or not). */
export function sqlFakeFetch(log: FakeLog, installed: boolean, state: SqlFakeState = { executions: [], notebooks: [], rowsCalls: [] }): typeof fetch {
  const base = fakeFetch(log)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    const path = url.pathname.replace('/qqq/v1', '')
    if (path === '/version') return json({ apiVersion: '1.8.0', features: ['metaData', 'tables', 'processes'], extensions: installed ? [{ name: 'sql-workbench', version: '1.1.0', pathPrefix: '/sql-workbench' }] : [] })
    if (path === '/metaData') {
      const meta = await (await base(input, init)).json() as J
      return json({
        ...meta,
        apps: { ...(meta.apps as J), ...SQL_APPS },
        appTree: [...(meta.appTree as unknown[]), { type: 'APP', name: 'sqlWorkbench', label: 'SQL Workbench', children: [{ type: 'APP', name: 'sqlWorkbenchRunner', label: 'Runner' }] }],
        widgets: { ...(meta.widgets as J), sqlWorkbenchWidget: { name: 'sqlWorkbenchWidget', label: 'SQL Workbench', type: 'SQL_WORKBENCH' } },
      })
    }
    if (!path.startsWith('/sql-workbench')) return base(input, init)
    const body = request.method !== 'GET' && (request.headers.get('content-type') ?? '').includes('json') ? await request.json() as J : undefined
    log.requests.push({ method: request.method, path, body })
    const sub = path.replace('/sql-workbench', '')
    if (sub === '/capabilities') return json({ version: '1.1.0', canWrite: false, canShare: true, writeModeEnabled: true, limits: { maxRows: 10000, pageSize: 500, maxPageSize: 2000, statementTimeoutSeconds: 30 }, backends: [{ name: 'h2', label: 'h2', vendor: 'h2', dialect: 'h2', readOnlyCredentials: false, readOnlyEnforced: false, writeAllowed: false }] })
    if (sub === '/schema/h2') return json(SCHEMA)
    if (sub === '/execute') {
      const sql = String(body?.sql ?? '')
      const uuid = String(body?.executionUuid ?? 'u1')
      if (/FRM/.test(sql)) {
        state.executions.push({ uuid, sql, status: 'FAILED' })
        return json({ executionUuid: uuid, status: 'FAILED', error: `Syntax error in SQL statement "${sql.replace('FRM', '[*]FRM')}"; SQL statement:\n${sql} [42000-240]`, sqlState: '42000', durationMs: 3 })
      }
      if (/^\s*SELEC\b/i.test(sql)) return json({ code: 'BAD_REQUEST', message: 'Read-only sessions run exactly one read-only statement.' }, 400)
      state.executions.push({ uuid, sql, params: body?.params, status: 'SUCCEEDED' })
      if (/CUSTOMER/i.test(sql)) {
        const size = Number(body?.pageSize ?? 500)
        return json({ executionUuid: uuid, status: 'SUCCEEDED', columns: [{ name: 'ID', label: 'ID', typeName: 'INTEGER', kind: 'number' }, { name: 'NAME', label: 'NAME', typeName: 'VARCHAR', kind: 'string' }, { name: 'EMAIL', label: 'EMAIL', typeName: 'VARCHAR', kind: 'string' }], rows: CUSTOMERS.slice(0, size), rowCount: CUSTOMERS.length, hasMore: true, truncated: false, durationMs: 7 })
      }
      return json({ executionUuid: uuid, status: 'SUCCEEDED', columns: [{ name: '1', label: '1', typeName: 'INTEGER', kind: 'number' }], rows: [[1]], rowCount: 1, hasMore: false, truncated: false, durationMs: 2 })
    }
    const rows = /^\/executions\/([^/]+)\/rows$/.exec(sub)
    if (rows) {
      const q = Object.fromEntries(url.searchParams.entries())
      state.rowsCalls.push(q)
      const offset = Number(q.offset ?? 0)
      const limit = Number(q.limit ?? 500)
      let all = [...CUSTOMERS]
      if (q.sort !== undefined) {
        const c = Number(q.sort)
        all.sort((a, b) => (a[c] === null ? 1 : b[c] === null ? -1 : a[c]! < b[c]! ? -1 : a[c]! > b[c]! ? 1 : 0) * (q.dir === 'desc' ? -1 : 1))
        if (q.dir === 'desc') all = [...all.filter((r) => r[Number(q.sort)] !== null), ...all.filter((r) => r[Number(q.sort)] === null)]
      }
      return json({ rows: all.slice(offset, offset + limit), offset, rowCount: CUSTOMERS.length, truncated: false })
    }
    const exp = /^\/executions\/([^/]+)\/export$/.exec(sub)
    if (exp) return new Response(`ID,NAME\n1,Customer 001\n`, { status: 200, headers: { 'content-type': 'text/csv' } })
    if (sub === '/explain') return json({ executionUuid: 'e1', status: 'SUCCEEDED', dialect: 'h2', analyze: false, plan: PLAN, raw: 'SELECT\n  ID\nFROM CUSTOMER', durationMs: 4 })
    if (sub === '/history') return json({ executions: [...state.executions].reverse().map((e) => ({ executionUuid: e.uuid, backendName: 'h2', mode: 'READ_ONLY', status: e.status, sqlText: e.sql, startTime: '2026-11-01T10:00:00Z', durationMs: 3, rowsReturned: 1 })) })
    if (sub === '/notebooks' && request.method === 'GET') return json({ notebooks: state.notebooks.filter((n) => (url.searchParams.get('scope') === 'shared') === (n.visibility === 'SHARED')).map(({ cells: _c, ...n }) => n) })
    if (sub === '/notebooks' && request.method === 'POST') {
      const nb = { ...(body as J), id: state.notebooks.length + 1, currentVersion: 1, canEdit: true, visibility: 'PERSONAL' }
      state.notebooks.push(nb)
      return json(nb)
    }
    const one = /^\/notebooks\/(\d+)$/.exec(sub)
    if (one) {
      const i = state.notebooks.findIndex((n) => n.id === Number(one[1]))
      if (i < 0) return json({ error: 'not found' }, 404)
      if (request.method === 'GET') return json(state.notebooks[i])
      if (request.method === 'PUT') {
        state.notebooks[i] = { ...state.notebooks[i]!, ...(body as J), currentVersion: Number(state.notebooks[i]!.currentVersion ?? 1) + 1 }
        return json(state.notebooks[i])
      }
      if (request.method === 'DELETE') {
        state.notebooks.splice(i, 1)
        return json({ deleted: true })
      }
    }
    return json({ error: `fake sql-workbench has no ${request.method} ${sub}` }, 404)
  }) as typeof fetch
}
