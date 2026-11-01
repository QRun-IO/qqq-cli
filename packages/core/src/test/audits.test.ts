/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditSource, getAudits, groupAuditRows } from '../records/audits.js'

test('the audit source: an available capability, else the instance process, else the audit table', () => {
  assert.deepEqual(auditSource({ clientCapabilities: { audits: { available: true, processName: 'P', detailTableName: 'D' } } }, {}), { kind: 'process', processName: 'P', detailTableName: 'D' })
  assert.deepEqual(auditSource({ clientCapabilities: { audits: { available: true, tableName: 'A' } } }, {}), { kind: 'table', tableName: 'A' })
  assert.equal(auditSource({ clientCapabilities: { audits: { available: false } } }, { processes: {}, tables: {} }), undefined)
  assert.equal(auditSource({}, { processes: { GetAuditsForRecord: {} } })!.kind, 'process')
  assert.deepEqual(auditSource({}, { processes: { GetAuditsForRecord: { hasPermission: false } }, tables: { audit: {} } }), { kind: 'table', tableName: 'audit', detailTableName: 'auditDetail' })
})

test('rows group into entries with their field changes', () => {
  const entries = groupAuditRows([
    { values: { id: 2, message: 'Record was Edited', timestamp: 't2', auditUserId: 1, 'auditDetail.id': 5, 'auditDetail.fieldName': 'a', 'auditDetail.oldValue': 1, 'auditDetail.newValue': 2 }, displayValues: { auditUserId: 'Ann' } },
    { values: { id: 2, message: 'Record was Edited', 'auditDetail.id': 6, 'auditDetail.fieldName': 'b', 'auditDetail.message': 'Set b' } },
    { values: { id: 1, message: 'Record was Inserted', 'auditDetail.id': null } },
  ])
  assert.deepEqual(entries.map((e) => [e.id, e.action, e.user, e.changes.length]), [[2, 'UPDATE', 'Ann', 2], [1, 'INSERT', '', 0]])
  assert.deepEqual(entries[0]!.changes[1], { fieldName: 'b', oldValue: null, newValue: null, message: 'Set b' })
})

test('audits read through the process, or the audit table with its joins', async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body instanceof FormData ? JSON.parse(String(init.body.get('values'))) : JSON.parse(String(init?.body))
    seen.push({ url, body })
    const data = url.includes('/processes/') ? { type: 'COMPLETE', values: { audits: [{ values: { id: 1, message: 'Record was Deleted' } }], distinctCount: 1 } } : { records: [{ values: { id: 3, message: 'x' } }] }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const viaProcess = await getAudits('http://h', fetchImpl, { kind: 'process', processName: 'GetAuditsForRecord', detailTableName: 'auditDetail' }, 'person', '7')
  assert.deepEqual([viaProcess.entries[0]!.action, viaProcess.total], ['DELETE', 1])
  assert.deepEqual(seen[0]!.body, { tableName: 'person', recordId: '7', isSortAscending: false, limit: 1000 })
  const viaTable = await getAudits('http://h', fetchImpl, { kind: 'table', tableName: 'audit', detailTableName: 'auditDetail' }, 'person', '7', { ascending: true })
  assert.equal(viaTable.entries[0]!.id, 3)
  assert.match(seen[1]!.url, /\/table\/audit\/query$/)
  const body = seen[1]!.body as { joins: unknown[]; filter: { orderBys: Array<{ isAscending: boolean }> } }
  assert.deepEqual(body.joins, [{ joinTable: 'auditTable', select: false, type: 'INNER' }, { joinTable: 'auditDetail', select: true, type: 'LEFT' }])
  assert.equal(body.filter.orderBys[0]!.isAscending, true)
})
