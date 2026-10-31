/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Column statistics, as the web UI's column menu shows them: count, distinct count, sum, average,
 * min and max of one column over the filtered rows, and the distribution of its values. The
 * server computes them with the standard `columnStats` process, offered only for tables with the
 * QUERY_STATS capability when the user may run the process. `computeColumnStats` does the same
 * over records the client already has, for servers without the process (an explicit choice).
 */

import { callOperation } from '../api/call.js'
import type { QueryFilter } from '../filter/grammar.js'
import type { TableVariant } from '../records/variants.js'
import { variantParam } from '../records/variants.js'

type J = Record<string, unknown>

/** The backend's standard column statistics process. */
export const COLUMN_STATS_PROCESS = 'columnStats'

export interface ColumnStats {
  /** The statistics present, in order (`count`, `countDistinct`, `sum`, `average`, `min`, `max`). */
  fields: Array<{ name: string; label: string }>
  /** Their values (and display values). */
  stats: { values: J; displayValues: J }
  /** One row per distinct value: `values[field]`, `values.count`, display values. */
  valueCounts: Array<{ values: J; displayValues: J }>
}

/** Whether the server offers column statistics for a table, and why not. */
export function columnStatsAvailability(tableMeta: J, metaData: J): { available: boolean; reason?: string } {
  if (!((tableMeta.capabilities ?? []) as string[]).includes('QUERY_STATS')) return { available: false, reason: `${String(tableMeta.label ?? tableMeta.name)} does not offer column statistics (no QUERY_STATS capability)` }
  const process = ((metaData.processes ?? {}) as Record<string, J>)[COLUMN_STATS_PROCESS]
  if (!process) return { available: false, reason: `the server has no ${COLUMN_STATS_PROCESS} process` }
  if (process.hasPermission === false) return { available: false, reason: `you may not run ${COLUMN_STATS_PROCESS}` }
  return { available: true }
}

/** The filter the statistics run over: criteria and groups only (paging and sort dropped). */
export function statsFilter(filter: Partial<QueryFilter>): Partial<QueryFilter> {
  const { skip: _skip, limit: _limit, orderBys: _orderBys, ...criteria } = filter
  void _skip
  void _limit
  void _orderBys
  return criteria
}

/** Runs the `columnStats` process. `orderBy` orders the distribution: `count.desc`, `count.asc`, `{field}.asc`, `{field}.desc`. */
export async function runColumnStats(baseUrl: string, fetchImpl: typeof fetch, options: { table: string; field: string; filter?: Partial<QueryFilter>; orderBy?: string; tableVariant?: TableVariant }): Promise<ColumnStats> {
  const values = { tableName: options.table, fieldName: options.field, filterJSON: JSON.stringify(statsFilter(options.filter ?? {})), orderBy: options.orderBy ?? 'count.desc' }
  const result = await callOperation(baseUrl, 'initProcess', {
    path: { processName: COLUMN_STATS_PROCESS },
    query: { tableVariant: variantParam(options.tableVariant) },
    form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' },
  }, fetchImpl)
  const response = (result.data ?? {}) as J
  if (response.type === 'ERROR' || response.error) throw new Error(String(response.userFacingError ?? response.error ?? 'Column statistics failed'))
  const out = (response.values ?? {}) as J
  if (!response.values) throw new Error('Column statistics did not complete.')
  const record = (out.statsRecord ?? {}) as J
  return {
    fields: ((out.statsFields ?? []) as J[]).filter((f) => f && f.name).map((f) => ({ name: String(f.name), label: String(f.label ?? f.name) })),
    stats: { values: (record.values ?? {}) as J, displayValues: (record.displayValues ?? {}) as J },
    valueCounts: ((out.valueCounts ?? []) as J[]).map((r) => ({ values: (r.values ?? {}) as J, displayValues: (r.displayValues ?? {}) as J })),
  }
}

const NUMERIC = new Set(['INTEGER', 'LONG', 'DECIMAL'])

/**
 * Computes the statistics from records (query results) for one field: what the process returns,
 * with DATE_TIME values grouped by hour as the web UI shows them, and no sum or average for
 * possible-value ids.
 */
export function computeColumnStats(records: J[], field: string, fieldMeta: { type?: unknown; possibleValueSourceName?: unknown }, orderBy = 'count.desc'): ColumnStats {
  const fieldType = String(fieldMeta.type ?? 'STRING')
  // ids of a possible-value source are not quantities: no sum or average, ordered as numbers still
  const numeric = NUMERIC.has(fieldType)
  const quantity = numeric && !fieldMeta.possibleValueSourceName
  const counts = new Map<string, { value: unknown; display: unknown; count: number }>()
  let count = 0
  let sum = 0
  let min: unknown
  let max: unknown
  const less = (a: unknown, b: unknown) => (numeric ? Number(a) < Number(b) : String(a) < String(b))
  for (const record of records) {
    const values = (record.values ?? {}) as J
    let value = values[field]
    let display = ((record.displayValues ?? {}) as J)[field] ?? value
    if (fieldType === 'DATE_TIME' && typeof value === 'string' && value.length >= 13) {
      value = `${value.slice(0, 13)}:00:00Z`
      display = value
    }
    const key = value === null || value === undefined ? '\u0000' : String(value)
    const entry = counts.get(key) ?? { value: value ?? null, display: value === null || value === undefined ? '' : display, count: 0 }
    entry.count++
    counts.set(key, entry)
    if (value === null || value === undefined || value === '') continue
    count++
    if (quantity) sum += Number(value)
    if (min === undefined || less(value, min)) min = value
    if (max === undefined || less(max, value)) max = value
  }
  const fields: ColumnStats['fields'] = [{ name: 'count', label: 'Count' }, { name: 'countDistinct', label: 'Count Distinct' }]
  const values: J = { count, countDistinct: [...counts.keys()].filter((k) => k !== '\u0000').length }
  if (quantity) {
    fields.push({ name: 'sum', label: 'Sum' }, { name: 'average', label: 'Average' })
    values.sum = Math.round(sum * 1e6) / 1e6
    values.average = count ? Math.round((sum / count) * 1e6) / 1e6 : null
  }
  if (fieldType !== 'BOOLEAN') {
    fields.push({ name: 'min', label: 'Min' }, { name: 'max', label: 'Max' })
    values.min = min ?? null
    values.max = max ?? null
  }
  const [by, direction] = orderBy.split('.')
  const sign = direction === 'asc' ? 1 : -1
  const rows = [...counts.values()].sort((a, b) => (by === 'count'
    ? sign * (a.count - b.count) || String(a.display).localeCompare(String(b.display))
    : sign * (numeric ? Number(a.value) - Number(b.value) : String(a.value ?? '').localeCompare(String(b.value ?? '')))))
  return {
    fields,
    stats: { values, displayValues: {} },
    valueCounts: rows.map((r) => ({ values: { [field]: r.value, count: r.count }, displayValues: { [field]: r.display === null ? '' : String(r.display) } })),
  }
}
