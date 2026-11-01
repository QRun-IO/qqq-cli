/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Reports, saved reports, report schedules and sharing, as the web reaches them: a report runs
 * through its process (input fields, then a file from `GET /download`), or through the report
 * route when it has none; a saved report is a `savedReport` record (filter, columns, pivot) that
 * the `renderSavedReport` process renders; schedules are `scheduledReport` records; any shareable
 * record (saved reports, saved views) is shared through the `*SharedRecord` processes.
 */

import { callOperation } from '../api/call.js'
import type { QueryFilter } from '../filter/grammar.js'

type J = Record<string, unknown>

export const SAVED_REPORT_TABLE = 'savedReport'
export const SCHEDULED_REPORT_TABLE = 'scheduledReport'
export const RENDER_SAVED_REPORT_PROCESS = 'renderSavedReport'
export const SHARING_PROCESSES = { list: 'getSharedRecords', add: 'insertSharedRecord', edit: 'editSharedRecord', remove: 'deleteSharedRecord' } as const

/** How a report runs: through its process (the usual way) or through the report route. */
export function reportRunPlan(metaData: J, reportName: string): { label: string; processName?: string; hasPermission: boolean } | undefined {
  const report = ((metaData.reports ?? {}) as Record<string, J>)[reportName]
  if (!report) return undefined
  return { label: String(report.label ?? reportName), ...(typeof report.processName === 'string' && report.processName ? { processName: report.processName } : {}), hasPermission: report.hasPermission !== false }
}

/** The report formats a report process takes (`reportFormat`), from a file extension or a name. */
export function reportFormat(text: string): string {
  const f = text.trim().toUpperCase().replace(/^\./, '')
  const known = ['CSV', 'XLSX', 'JSON', 'TSV', 'PDF', 'LIST_OF_MAPS']
  if (!known.includes(f)) throw new ReportError(`Unknown report format ${text} (csv, xlsx, json, tsv, pdf)`)
  return f
}

export class ReportError extends Error {}

/** A saved report record, its JSON fields read. */
export interface SavedReport {
  id: number
  label: string
  tableName: string
  userId?: string
  filter?: QueryFilter
  columns?: Array<{ name: string; isVisible?: boolean }>
  pivot?: PivotDefinition
  inputFields?: unknown
  raw: J
}

/** A pivot table definition (`pivotTableJson`). */
export interface PivotDefinition {
  rows: Array<{ fieldName: string }>
  columns: Array<{ fieldName: string }>
  values: Array<{ fieldName: string; function: string }>
}

export const PIVOT_FUNCTIONS = ['SUM', 'COUNT', 'COUNT_NUMS', 'AVERAGE', 'MAX', 'MIN', 'PRODUCT', 'STD_DEV', 'STD_DEVP', 'VAR', 'VARP']

function parse(v: unknown): unknown {
  if (typeof v !== 'string' || !v.trim()) return undefined
  try { return JSON.parse(v) } catch { return undefined }
}

/** Reads a savedReport record. */
export function readSavedReport(record: J): SavedReport {
  const v = (record.values ?? record) as J
  const columns = parse(v.columnsJson) as J | unknown[] | undefined
  const list = Array.isArray(columns) ? columns : Array.isArray((columns as J | undefined)?.columns) ? (columns as J).columns as unknown[] : undefined
  return {
    id: Number(v.id),
    label: String(v.label ?? ''),
    tableName: String(v.tableName ?? ''),
    ...(v.userId !== undefined && v.userId !== null ? { userId: String(v.userId) } : {}),
    ...(parse(v.queryFilterJson) ? { filter: parse(v.queryFilterJson) as QueryFilter } : {}),
    ...(list ? { columns: list.map((c) => (typeof c === 'string' ? { name: c, isVisible: true } : c as { name: string; isVisible?: boolean })) } : {}),
    ...(parse(v.pivotTableJson) ? { pivot: parse(v.pivotTableJson) as PivotDefinition } : {}),
    ...(parse(v.inputFieldsJson) ? { inputFields: parse(v.inputFieldsJson) } : {}),
    raw: record,
  }
}

/** The saved reports the user may see (own and shared), by label. */
export async function listSavedReports(baseUrl: string, fetchImpl: typeof fetch): Promise<SavedReport[]> {
  const data = (await callOperation(baseUrl, 'queryTable', { path: { tableName: SAVED_REPORT_TABLE }, json: { filter: { criteria: [], booleanOperator: 'AND', orderBys: [{ fieldName: 'label', isAscending: true }], skip: 0, limit: 1000 } } }, fetchImpl)).data as J
  return ((data.records ?? []) as J[]).map(readSavedReport)
}

/** Finds a saved report by id or label (exact, then ignoring case). */
export function findSavedReport(reports: SavedReport[], idOrName: string): SavedReport {
  const hit = reports.find((r) => String(r.id) === idOrName) ?? reports.find((r) => r.label === idOrName) ?? reports.find((r) => r.label.toLowerCase() === idOrName.toLowerCase())
  if (!hit) throw new ReportError(`No saved report "${idOrName}"${reports.length ? ` (saved reports: ${reports.slice(0, 15).map((r) => `${r.label} (${r.id})`).join(', ')})` : ''}`)
  return hit
}

/** The savedReport values that store a filter (with its sort) and visible columns, as the setup widget writes them. */
export function savedReportFilterValues(filter: QueryFilter | undefined, columns: string[] | undefined): J {
  return {
    ...(filter ? { queryFilterJson: JSON.stringify(filter) } : {}),
    ...(columns ? { columnsJson: JSON.stringify({ columns: columns.map((name) => ({ name, isVisible: true })) }) } : {}),
  }
}

/**
 * A pivot definition from `--rows a,b --columns c --values SUM:total,COUNT:id`; the value
 * function defaults to SUM. Fields are checked against the table's fields when given.
 */
export function buildPivot(spec: { rows?: string[]; columns?: string[]; values?: string[] }, fieldNames?: string[]): PivotDefinition {
  const check = (name: string) => {
    if (fieldNames && !fieldNames.includes(name)) throw new ReportError(`${name}: not a field of the report's table`)
    return name
  }
  const values = (spec.values ?? []).map((v) => {
    const [fn, field] = v.includes(':') ? v.split(':', 2) as [string, string] : ['SUM', v]
    const f = fn.toUpperCase()
    if (!PIVOT_FUNCTIONS.includes(f)) throw new ReportError(`${fn}: one of ${PIVOT_FUNCTIONS.join(', ')}`)
    return { fieldName: check(field), function: f }
  })
  if (!values.length) throw new ReportError('A pivot table needs at least one value (--values FUNCTION:field)')
  return { rows: (spec.rows ?? []).map((r) => ({ fieldName: check(r) })), columns: (spec.columns ?? []).map((c) => ({ fieldName: check(c) })), values }
}

/** A report schedule (`scheduledReport`). */
export interface ReportSchedule { id: number; savedReportId: number; cronExpression: string; cronDescription?: string; timeZone: string; isActive: boolean; toAddresses: string; subject: string; format: string }

/** The schedules of a saved report. */
export async function listReportSchedules(baseUrl: string, fetchImpl: typeof fetch, savedReportId: number): Promise<ReportSchedule[]> {
  const data = (await callOperation(baseUrl, 'queryTable', { path: { tableName: SCHEDULED_REPORT_TABLE }, json: { filter: { criteria: [{ fieldName: 'savedReportId', operator: 'EQUALS', values: [String(savedReportId)] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: true }] } } }, fetchImpl)).data as J
  return ((data.records ?? []) as J[]).map((r) => {
    const v = (r.values ?? r) as J
    return { id: Number(v.id), savedReportId: Number(v.savedReportId), cronExpression: String(v.cronExpression ?? ''), ...(v.cronDescription ? { cronDescription: String(v.cronDescription) } : {}), timeZone: String(v.cronTimeZoneId ?? ''), isActive: v.isActive !== false, toAddresses: String(v.toAddresses ?? ''), subject: String(v.subject ?? ''), format: String(v.format ?? '') }
  })
}

/** One share of a record (`getSharedRecords` resultList). */
export interface RecordShare { shareId: number; audienceType: string; audienceId: string; audienceLabel: string; scopeId: string }

export class SharingError extends Error {}

async function runSharing(baseUrl: string, fetchImpl: typeof fetch, processName: string, values: J): Promise<J> {
  const data = (await callOperation(baseUrl, 'initProcess', { path: { processName }, form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' } }, fetchImpl)).data as J
  if (data.type === 'ERROR') throw new SharingError(String(data.userFacingError ?? data.error ?? 'The sharing request failed'))
  return (data.values ?? {}) as J
}

/** The shares of a record of a shareable table (saved reports, saved views). */
export async function listShares(baseUrl: string, fetchImpl: typeof fetch, table: string, recordId: string): Promise<RecordShare[]> {
  const values = await runSharing(baseUrl, fetchImpl, SHARING_PROCESSES.list, { tableName: table, recordId })
  return ((values.resultList ?? []) as J[]).map((r) => {
    const v = (r.values ?? r) as J
    return { shareId: Number(v.shareId), audienceType: String(v.audienceType ?? ''), audienceId: String(v.audienceId ?? ''), audienceLabel: String(v.audienceLabel ?? v.audienceId ?? ''), scopeId: String(v.scopeId ?? '') }
  })
}

/** Shares a record with an audience (a user, a group …) at a scope (READ_ONLY, READ_WRITE). Only the owner may. */
export async function addShare(baseUrl: string, fetchImpl: typeof fetch, table: string, recordId: string, share: { audienceType: string; audienceId: string; scopeId: string }): Promise<void> {
  await runSharing(baseUrl, fetchImpl, SHARING_PROCESSES.add, { tableName: table, recordId, ...share })
}

export async function editShare(baseUrl: string, fetchImpl: typeof fetch, table: string, recordId: string, shareId: number, scopeId: string): Promise<void> {
  await runSharing(baseUrl, fetchImpl, SHARING_PROCESSES.edit, { tableName: table, recordId, shareId, scopeId })
}

export async function removeShare(baseUrl: string, fetchImpl: typeof fetch, table: string, recordId: string, shareId: number): Promise<void> {
  await runSharing(baseUrl, fetchImpl, SHARING_PROCESSES.remove, { tableName: table, recordId, shareId })
}

/** The share scopes the server knows. */
export const SHARE_SCOPES: Record<string, string> = { READ_ONLY: 'Read Only', READ_WRITE: 'Read and Edit' }

/** A scope from what a person typed: READ_ONLY, read-only, read, READ_WRITE, edit, "Read and Edit". */
export function shareScope(text: string): string {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (['read only', 'read', 'readonly', 'r'].includes(t)) return 'READ_ONLY'
  if (['read write', 'read and edit', 'edit', 'write', 'rw', 'readwrite'].includes(t)) return 'READ_WRITE'
  throw new SharingError(`Unknown scope "${text}": read-only or read-write`)
}
