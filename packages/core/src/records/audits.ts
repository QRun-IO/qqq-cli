/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A record's audit history, read as the web UIs read it: through the audit process the table's
 * `clientCapabilities.audits` names (the standard `GetAuditsForRecord`) when the user may run it,
 * otherwise by querying the audit table joined to its detail table. Rows (one per changed field)
 * are grouped into entries, newest first unless asked otherwise.
 */

import { callOperation } from '../api/call.js'

type J = Record<string, unknown>

/** The standard names, for servers without `clientCapabilities` (UI API before 1.6). */
export const AUDIT_DEFAULTS = { processName: 'GetAuditsForRecord', tableName: 'audit', detailTableName: 'auditDetail' } as const
/** Most audit rows read for one record, as in the web UIs. */
export const AUDIT_LIMIT = 1000

export interface AuditSource {
  kind: 'process' | 'table'
  processName?: string
  tableName?: string
  detailTableName?: string
}

export interface AuditEntry {
  id: number
  timestamp: string
  user: string
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  message: string
  changes: Array<{ fieldName: string; oldValue: unknown; newValue: unknown; message?: string }>
}

/**
 * How the user can read a table's audits, or undefined. An available capability names the process
 * or table; when it is absent or unavailable, the instance metadata (permission-filtered) decides,
 * since records of unaudited tables can still carry audits written explicitly.
 */
export function auditSource(tableMeta: J, metaData: J): AuditSource | undefined {
  const audits = (tableMeta.clientCapabilities as J | undefined)?.audits as J | undefined
  const detail = audits?.available ? (audits.detailTableName ? String(audits.detailTableName) : undefined) : AUDIT_DEFAULTS.detailTableName
  if (audits?.available) {
    if (audits.processName) return { kind: 'process', processName: String(audits.processName), ...(audits.tableName ? { tableName: String(audits.tableName) } : {}), ...(detail ? { detailTableName: detail } : {}) }
    if (audits.tableName) return { kind: 'table', tableName: String(audits.tableName), ...(detail ? { detailTableName: detail } : {}) }
    return undefined
  }
  const process = ((metaData.processes ?? {}) as Record<string, J>)[AUDIT_DEFAULTS.processName]
  if (process && process.hasPermission !== false) return { kind: 'process', processName: AUDIT_DEFAULTS.processName, tableName: AUDIT_DEFAULTS.tableName, detailTableName: AUDIT_DEFAULTS.detailTableName }
  const table = ((metaData.tables ?? {}) as Record<string, J>)[AUDIT_DEFAULTS.tableName]
  if (table && table.readPermission !== false) return { kind: 'table', tableName: AUDIT_DEFAULTS.tableName, detailTableName: AUDIT_DEFAULTS.detailTableName }
  return undefined
}

/** Groups audit rows (one per detail, from the detail join) into entries, in the rows' order. */
export function groupAuditRows(rows: J[], detailTableName = AUDIT_DEFAULTS.detailTableName as string): AuditEntry[] {
  const entries = new Map<string, AuditEntry>()
  for (const row of rows) {
    const values = (row.values ?? {}) as J
    const display = (row.displayValues ?? {}) as J
    const id = String(values.id)
    let entry = entries.get(id)
    if (!entry) {
      const message = typeof values.message === 'string' ? values.message : ''
      entry = {
        id: Number(values.id),
        timestamp: String(values.timestamp ?? ''),
        user: String(display.auditUserId ?? values.auditUserId ?? ''),
        action: /\bInserted\b/.test(message) ? 'INSERT' : /\bDeleted\b/.test(message) ? 'DELETE' : 'UPDATE',
        message,
        changes: [],
      }
      entries.set(id, entry)
    }
    const detailId = values[`${detailTableName}.id`]
    if (detailId !== null && detailId !== undefined) {
      const detailMessage = values[`${detailTableName}.message`]
      entry.changes.push({
        fieldName: String(values[`${detailTableName}.fieldName`] ?? ''),
        oldValue: values[`${detailTableName}.oldValue`] ?? null,
        newValue: values[`${detailTableName}.newValue`] ?? null,
        ...(typeof detailMessage === 'string' ? { message: detailMessage } : {}),
      })
    }
  }
  return [...entries.values()]
}

/** Reads a record's audits; `total` is the distinct count when the server gives one (or the cap was reached). */
export async function getAudits(baseUrl: string, fetchImpl: typeof fetch, source: AuditSource, table: string, primaryKey: string, options: { ascending?: boolean } = {}): Promise<{ entries: AuditEntry[]; total: number | null }> {
  const ascending = Boolean(options.ascending)
  if (source.kind === 'process') {
    const result = await callOperation(baseUrl, 'initProcess', { path: { processName: source.processName! }, form: { values: JSON.stringify({ tableName: table, recordId: primaryKey, isSortAscending: ascending, limit: AUDIT_LIMIT }), stepTimeoutMillis: '60000' } }, fetchImpl)
    const response = (result.data ?? {}) as J
    if (response.type === 'ERROR' || response.error) throw new Error(String(response.userFacingError ?? response.error ?? 'Error loading audits'))
    const out = (response.values ?? {}) as J
    if (!Array.isArray(out.audits)) throw new Error('Invalid audit response')
    return { entries: groupAuditRows(out.audits as J[], source.detailTableName), total: typeof out.distinctCount === 'number' ? out.distinctCount : null }
  }
  const auditTable = source.tableName!
  const detail = source.detailTableName
  const criteria = [{ fieldName: 'auditTable.name', operator: 'EQUALS', values: [table] }, { fieldName: 'recordId', operator: 'EQUALS', values: [primaryKey] }]
  const body = {
    filter: { criteria, booleanOperator: 'AND', orderBys: [{ fieldName: 'timestamp', isAscending: ascending }, { fieldName: 'id', isAscending: ascending }, ...(detail ? [{ fieldName: `${detail}.id`, isAscending: true }] : [])], limit: AUDIT_LIMIT },
    joins: [{ joinTable: 'auditTable', select: false, type: 'INNER' }, ...(detail ? [{ joinTable: detail, select: true, type: 'LEFT' }] : [])],
  }
  const records = ((await callOperation(baseUrl, 'queryTable', { path: { tableName: auditTable }, json: body }, fetchImpl)).data as J | undefined)?.records
  if (!Array.isArray(records)) throw new Error('Invalid audit response')
  let total: number | null = null
  if (records.length === AUDIT_LIMIT) {
    const count = (await callOperation(baseUrl, 'countTable', { path: { tableName: auditTable }, query: { includeDistinct: 'true' }, json: { filter: { criteria, booleanOperator: 'AND' } } }, fetchImpl)).data as J
    total = Number(count.distinctCount ?? count.count)
  }
  return { entries: groupAuditRows(records as J[], detail), total }
}
