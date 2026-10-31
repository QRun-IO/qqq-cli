/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Go To a record by a key: the primary key or one of the table's unique keys (Material's
 * `materialDashboard.gotoFieldNames` in the table's supplemental metadata). The lookup is a query
 * with EQUALS on each given field, limited to two rows, since only none, one or several matters.
 */

import { callOperation } from '../api/call.js'
import type { QueryFilter } from '../filter/grammar.js'
import type { TableVariant } from './variants.js'

type J = Record<string, unknown>

const asRecord = (v: unknown): J | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as J : undefined)

/** The table's Material dashboard supplemental metadata (v1 key or the legacy one). */
export function materialDashboardMeta(tableMeta: J): J | undefined {
  return asRecord(asRecord(tableMeta.supplementalMetaData)?.materialDashboard) ?? asRecord(asRecord(tableMeta.supplementalTableMetaData)?.materialDashboard)
}

/** The configured Go To keys (each a list of fields that together find one record), or undefined. */
export function gotoFieldNames(tableMeta: J): string[][] | undefined {
  const names = materialDashboardMeta(tableMeta)?.gotoFieldNames
  if (!Array.isArray(names)) return undefined
  return names.filter(Array.isArray).map((key) => (key as unknown[]).filter((n): n is string => typeof n === 'string'))
}

/** The keys a lookup can use: the primary key first (unless a configured key is it), then the configured keys. */
export function gotoKeys(tableMeta: J): string[][] {
  const fields = (tableMeta.fields ?? {}) as J
  const pk = String(tableMeta.primaryKeyField ?? 'id')
  const keys = (gotoFieldNames(tableMeta) ?? []).map((key) => key.filter((n) => fields[n])).filter((key) => key.length)
  if (!keys.some((key) => key.includes(pk))) keys.unshift([pk])
  return keys
}

/** Whether the given field names are exactly one of the lookup keys. */
export function isGotoKey(tableMeta: J, names: string[]): boolean {
  const given = [...names].sort().join(',')
  return gotoKeys(tableMeta).some((key) => [...key].sort().join(',') === given)
}

/** The lookup filter: EQUALS on each field with a value, limit 2; undefined when nothing has a value. */
export function gotoFilter(values: Record<string, string>): QueryFilter | undefined {
  const criteria = Object.entries(values).filter(([, v]) => String(v ?? '').trim() !== '').map(([fieldName, v]) => ({ fieldName, operator: 'EQUALS' as const, values: [String(v).trim()] }))
  if (!criteria.length) return undefined
  return { criteria, booleanOperator: 'AND', skip: 0, limit: 2 }
}

export type GotoResult = { found: 'one'; record: J; primaryKey: string } | { found: 'none' } | { found: 'many' }

/** Runs a Go To lookup. */
export async function findRecordByKey(baseUrl: string, fetchImpl: typeof fetch, tableMeta: J, values: Record<string, string>, options: { tableVariant?: TableVariant } = {}): Promise<GotoResult> {
  const filter = gotoFilter(values)
  if (!filter) throw new Error('Give at least one key value')
  const result = await callOperation(baseUrl, 'queryTable', { path: { tableName: String(tableMeta.name) }, json: { filter, ...(options.tableVariant ? { tableVariant: options.tableVariant } : {}) } }, fetchImpl)
  const records = ((result.data as J | undefined)?.records ?? []) as J[]
  if (records.length === 0) return { found: 'none' }
  if (records.length > 1) return { found: 'many' }
  const record = records[0]!
  return { found: 'one', record, primaryKey: String((record.values as J | undefined)?.[String(tableMeta.primaryKeyField ?? 'id')] ?? '') }
}
