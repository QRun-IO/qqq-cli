/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A fake UI API server with a generated large instance (default 1000 tables, 500 processes, 3000
 * widgets, 300 reports) for trying qqq ui at scale. MOCK sign-in; every table has id and name with
 * 40 rows (rows after 20 have much longer names, for the fixed-width check); every widget is a statistics widget answered after 150 ms.
 *   bun run packages/tui/scripts/fake-big-server.ts [port] [tables] [processes]
 *   qqq ui --server http://localhost:8099
 */

import { generateMetaData } from '@qrun-io/qqq-core'

const port = Number(process.argv[2] ?? 8099)
const tables = Number(process.argv[3] ?? 1000)
const processes = Number(process.argv[4] ?? 500)
const doc = generateMetaData({ tables, processes, widgets: 3000, reports: 300 })
// PRF-001: one 10,000-row table with 40 columns (bigwide), for the large-table budget
const WIDE_ROWS = 10_000
const wideFields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => {
  const name = i === 0 ? 'id' : `col${String(i).padStart(2, '0')}`
  return [name, { name, label: i === 0 ? 'Id' : `Column ${i}`, type: i === 0 ? 'INTEGER' : i % 5 === 0 ? 'DECIMAL' : i % 7 === 0 ? 'DATE' : 'STRING', isEditable: i !== 0 }]
}))
;(doc.tables as Record<string, unknown>).bigwide = { name: 'bigwide', label: 'Big Wide', insertPermission: true }
const wideRow = (n: number) => Object.fromEntries(Object.keys(wideFields).map((k, i) => [k, i === 0 ? n : i % 5 === 0 ? n * i / 10 : i % 7 === 0 ? `2026-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}` : `r${n}c${i}`]))
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
    if (path === '/metaData/table/bigwide') return json({ name: 'bigwide', label: 'Big Wide', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, fields: wideFields, sections: [{ name: 's', label: 'Record', tier: 'T1', fieldNames: Object.keys(wideFields) }] })
    if (path === '/table/bigwide/count') return json({ count: WIDE_ROWS })
    if (path === '/table/bigwide/query') {
      const filter = ((await req.json()) as { filter?: { skip?: number; limit?: number } }).filter ?? {}
      const skip = filter.skip ?? 0
      return json({ records: Array.from({ length: Math.max(0, Math.min(filter.limit ?? 50, WIDE_ROWS - skip)) }, (_, i) => ({ values: wideRow(skip + i + 1), recordLabel: `row ${skip + i + 1}` })) })
    }
    let m = /^\/metaData\/table\/([^/]+)$/.exec(path)
    if (m) return json({ name: m[1], label: (doc.tables as Record<string, { label: string }>)[m[1]!]?.label ?? m[1], primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, name: { name: 'name', label: 'Name', type: 'STRING' } }, sections: [{ name: 's', label: 'Record', tier: 'T1', fieldNames: ['id', 'name'] }] })
    m = /^\/table\/([^/]+)\/(query|count)$/.exec(path)
    if (m) {
      const filter = ((await req.json()) as { filter?: { skip?: number; limit?: number } }).filter ?? {}
      if (m[2] === 'count') return json({ count: 40 })
      const skip = filter.skip ?? 0
      return json({ records: Array.from({ length: Math.max(0, Math.min(filter.limit ?? 50, 40 - skip)) }, (_, i) => ({ values: { id: skip + i + 1, name: skip + i + 1 > 20 ? `${m![1]} ${skip + i + 1}, a much longer value than on the first page` : `${m![1]} ${skip + i + 1}` }, recordLabel: `${m![1]} ${skip + i + 1}` })) })
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
