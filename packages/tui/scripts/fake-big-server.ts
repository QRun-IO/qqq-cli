/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A fake UI API server with a generated large instance (default 1000 tables, 500 processes, 3000
 * widgets, 300 reports) for trying qqq ui at scale. MOCK sign-in; every table has id and name with
 * 40 rows; every widget is a statistics widget answered after 150 ms.
 *   bun run packages/tui/scripts/fake-big-server.ts [port] [tables] [processes]
 *   qqq ui --server http://localhost:8099
 */

import { generateMetaData } from '@qrun-io/qqq-core'

const port = Number(process.argv[2] ?? 8099)
const tables = Number(process.argv[3] ?? 1000)
const processes = Number(process.argv[4] ?? 500)
const doc = generateMetaData({ tables, processes, widgets: 3000, reports: 300 })
const body = JSON.stringify(doc)
const json = (data: unknown, init: ResponseInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
let widgetCalls = 0

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace('/qqq/v1', '')
    if (path === '/version') return json({ apiVersion: '1.8.0', features: ['metaData', 'tables', 'processes', 'widgets'], extensions: [] })
    if (path === '/metaData/authentication') return json({ type: 'MOCK', name: 'mock', values: {} })
    if (path === '/manageSession') return json({ values: { user: { name: 'Big Tester' } } }, { headers: { 'set-cookie': 'sessionUUID=big-session; Path=/' } })
    if (path === '/metaData') return json(body)
    let m = /^\/metaData\/table\/([^/]+)$/.exec(path)
    if (m) return json({ name: m[1], label: (doc.tables as Record<string, { label: string }>)[m[1]!]?.label ?? m[1], primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, name: { name: 'name', label: 'Name', type: 'STRING' } }, sections: [{ name: 's', label: 'Record', tier: 'T1', fieldNames: ['id', 'name'] }] })
    m = /^\/table\/([^/]+)\/(query|count)$/.exec(path)
    if (m) {
      const filter = ((await req.json()) as { filter?: { skip?: number; limit?: number } }).filter ?? {}
      if (m[2] === 'count') return json({ count: 40 })
      const skip = filter.skip ?? 0
      return json({ records: Array.from({ length: Math.max(0, Math.min(filter.limit ?? 50, 40 - skip)) }, (_, i) => ({ values: { id: skip + i + 1, name: `${m![1]} ${skip + i + 1}` }, recordLabel: `${m![1]} ${skip + i + 1}` })) })
    }
    m = /^\/widget\/([^/]+)$/.exec(path)
    if (m) {
      widgetCalls++
      await new Promise((r) => setTimeout(r, 150))
      return json({ type: 'statistics', label: m[1], count: widgetCalls, countContext: 'calls so far' })
    }
    return json({ code: 'NOT_FOUND', message: `no ${path}` }, { status: 404 })
  },
})
console.log(`fake large instance on http://localhost:${port}: ${tables} tables, ${processes} processes, 3000 widgets, ${(body.length / 1e6).toFixed(2)} MB of metadata`)
