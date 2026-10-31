/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Saved views: named query screens (filter, sort, columns, page size) a backend keeps through its
 * saved-view processes (`querySavedView`, `storeSavedView`, `deleteSavedView`), named per table by
 * `clientCapabilities.savedViews`. The view document is the Material dashboard's `RecordQueryView`,
 * so views saved in the web UIs open here and the other way round.
 */

import { callOperation } from '../api/call.js'
import type { OrderBy, QueryFilter } from '../filter/grammar.js'
import type { ExposedJoin } from './joins.js'
import { resolveField } from './joins.js'

type J = Record<string, unknown>

/** The process names when a server predates `clientCapabilities` (UI API before 1.6). */
export const LEGACY_SAVED_VIEW_PROCESSES = { query: 'querySavedView', store: 'storeSavedView', delete: 'deleteSavedView' } as const

/** One column of a view document. */
export interface SavedViewColumn {
  name: string
  isVisible: boolean
  width?: number
  pinned?: 'left' | 'right'
}

/** The view document (Material `RecordQueryView`). */
export interface RecordQueryView {
  queryFilter: Partial<QueryFilter>
  queryColumns?: { columns: SavedViewColumn[] }
  rowsPerPage?: number
  quickFilterFieldNames?: string[]
  mode?: string
}

/** A stored view. */
export interface SavedView {
  id: number
  label: string
  userId?: string
  tableName: string
  view: RecordQueryView
  type?: string
  sortOrder?: number
  doCount?: boolean
}

export interface SavedViewProcesses {
  query?: string
  store?: string
  delete?: string
}

/**
 * The saved-view processes of a table: those `clientCapabilities.savedViews` names when it is
 * available; none when it says unavailable; the legacy names, when the instance has them and the
 * table carries no capabilities at all.
 */
export function savedViewProcesses(tableMeta: J, metaData: J): SavedViewProcesses {
  const capabilities = tableMeta.clientCapabilities as J | undefined
  if (capabilities) {
    const declared = capabilities.savedViews as J | undefined
    if (!declared?.available) return {}
    return {
      ...(declared.queryProcessName ? { query: String(declared.queryProcessName) } : {}),
      ...(declared.storeProcessName ? { store: String(declared.storeProcessName) } : {}),
      ...(declared.deleteProcessName ? { delete: String(declared.deleteProcessName) } : {}),
    }
  }
  const processes = (metaData.processes ?? {}) as Record<string, J>
  const permitted = (name: string) => Boolean(processes[name]) && processes[name]!.hasPermission !== false
  const out: SavedViewProcesses = {}
  for (const key of ['query', 'store', 'delete'] as const) if (permitted(LEGACY_SAVED_VIEW_PROCESSES[key])) out[key] = LEGACY_SAVED_VIEW_PROCESSES[key]
  return out
}

/** Parses a stored `viewJson` (text or object), tolerating partial documents. */
export function parseViewJson(viewJson: unknown): RecordQueryView {
  let parsed: unknown = viewJson
  if (typeof viewJson === 'string') {
    try {
      parsed = JSON.parse(viewJson)
    } catch {
      parsed = {}
    }
  }
  const source = (parsed && typeof parsed === 'object' ? parsed : {}) as J
  const columns = (source.queryColumns as { columns?: unknown } | undefined)?.columns
  return {
    queryFilter: source.queryFilter && typeof source.queryFilter === 'object' ? source.queryFilter as Partial<QueryFilter> : {},
    ...(Array.isArray(columns) ? { queryColumns: { columns: (columns as SavedViewColumn[]).filter((c) => c && typeof c === 'object' && typeof c.name === 'string') } } : {}),
    ...(typeof source.rowsPerPage === 'number' ? { rowsPerPage: source.rowsPerPage } : {}),
    quickFilterFieldNames: Array.isArray(source.quickFilterFieldNames) ? (source.quickFilterFieldNames as unknown[]).filter((n): n is string => typeof n === 'string') : [],
    ...(typeof source.mode === 'string' ? { mode: source.mode } : {}),
  }
}

/** Runs a saved-view process and returns its `savedViewList`. */
export async function runSavedViewProcess(baseUrl: string, fetchImpl: typeof fetch, processName: string, values: J): Promise<SavedView[]> {
  const result = await callOperation(baseUrl, 'initProcess', { path: { processName }, form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' } }, fetchImpl)
  const response = (result.data ?? {}) as J
  if (response.type === 'ERROR' || response.error) throw new SavedViewError(String(response.userFacingError ?? response.error ?? 'The saved view request failed'))
  if (response.type !== undefined && response.type !== 'COMPLETE') throw new SavedViewError('The saved view request did not complete.')
  const list = (((response.values ?? {}) as J).savedViewList ?? []) as Array<{ values?: J }>
  return list.map((record) => {
    const v = record.values ?? {}
    return {
      id: Number(v.id),
      label: String(v.label ?? ''),
      ...(typeof v.userId === 'string' ? { userId: v.userId } : {}),
      tableName: String(v.tableName ?? ''),
      view: parseViewJson(v.viewJson),
      ...(typeof v.type === 'string' ? { type: v.type } : {}),
      ...(typeof v.sortOrder === 'number' ? { sortOrder: v.sortOrder } : {}),
      ...(typeof v.doCount === 'boolean' ? { doCount: v.doCount } : {}),
    }
  })
}

/** Saved views of a table, sorted by label. */
export async function listSavedViews(baseUrl: string, fetchImpl: typeof fetch, processes: SavedViewProcesses, table: string): Promise<SavedView[]> {
  if (!processes.query) throw new SavedViewError('Saved views are unavailable for this table.')
  return (await runSavedViewProcess(baseUrl, fetchImpl, processes.query, { tableName: table })).sort((a, b) => a.label.localeCompare(b.label))
}

/** Finds a view by id or by name (exact, then any case); throws when none or several match. */
export function findSavedView(views: SavedView[], idOrName: string): SavedView {
  const byId = /^\d+$/.test(idOrName) ? views.find((v) => v.id === Number(idOrName)) : undefined
  if (byId) return byId
  const exact = views.filter((v) => v.label === idOrName)
  const named = exact.length ? exact : views.filter((v) => v.label.toLowerCase() === idOrName.toLowerCase())
  if (named.length === 1) return named[0]!
  if (named.length > 1) throw new SavedViewError(`${named.length} views are named "${idOrName}" (ids ${named.map((v) => v.id).join(', ')}); give the id`)
  throw new SavedViewError(`No saved view "${idOrName}"${views.length ? `; views: ${views.map((v) => `${v.label} (${v.id})`).join(', ')}` : ' (the table has none)'}`)
}

/** Stores a view (insert, or update when `id` is given) and returns the stored record. */
export async function storeSavedView(baseUrl: string, fetchImpl: typeof fetch, processes: SavedViewProcesses, input: { table: string; label: string; view: RecordQueryView; id?: number }): Promise<SavedView> {
  if (!processes.store) throw new SavedViewError('Saving views is unavailable for this table.')
  const [stored] = await runSavedViewProcess(baseUrl, fetchImpl, processes.store, { tableName: input.table, label: input.label, viewJson: JSON.stringify(input.view), ...(input.id !== undefined ? { id: input.id } : {}) })
  if (!stored) throw new SavedViewError('No saved view was stored.')
  return stored
}

/** Deletes a view. */
export async function deleteSavedView(baseUrl: string, fetchImpl: typeof fetch, processes: SavedViewProcesses, id: number): Promise<void> {
  if (!processes.delete) throw new SavedViewError('Deleting views is unavailable for this table.')
  await runSavedViewProcess(baseUrl, fetchImpl, processes.delete, { id })
}

/** The view document for a filter, sort, shown columns and page size (what the web UIs store). */
export function buildViewJson(input: { filter: Partial<QueryFilter>; columns: string[]; allColumns?: string[]; rowsPerPage?: number; base?: RecordQueryView }): RecordQueryView {
  const { skip: _skip, limit: _limit, orderBys, ...rest } = input.filter
  void _skip
  void _limit
  const shown = new Set(input.columns)
  const hidden = (input.allColumns ?? []).filter((c) => !shown.has(c))
  return {
    queryFilter: { criteria: rest.criteria ?? [], booleanOperator: rest.booleanOperator ?? 'AND', ...(rest.subFilters?.length ? { subFilters: rest.subFilters } : {}), orderBys: orderBys ?? [] },
    queryColumns: { columns: [{ name: '__check__', isVisible: true, width: 100, pinned: 'left' }, ...input.columns.map((name) => ({ name, isVisible: true })), ...hidden.map((name) => ({ name, isVisible: false }))] },
    ...(input.rowsPerPage ? { rowsPerPage: input.rowsPerPage } : {}),
    quickFilterFieldNames: input.base?.quickFilterFieldNames ?? [],
    mode: input.base?.mode ?? 'advanced',
  }
}

/**
 * What a view runs: its filter and sort, its visible columns in order, its page size, with what the
 * table no longer has removed and the warnings the web UI shows (Material's reconcile).
 */
export function viewToQuery(tableMeta: J, joins: ExposedJoin[], view: RecordQueryView): { filter: QueryFilter; columns: string[]; rowsPerPage?: number; warnings: string[] } {
  const removed = new Set<string>()
  const reasons = new Set<string>()
  const exists = (name: string) => Boolean(resolveField(tableMeta, joins, name))
  const clean = (filter: Partial<QueryFilter>): QueryFilter => {
    const criteria = []
    for (const criterion of Array.isArray(filter.criteria) ? filter.criteria : []) {
      if (!criterion || typeof criterion.fieldName !== 'string') continue
      const found = resolveField(tableMeta, joins, criterion.fieldName)
      if (!found) {
        removed.add(criterion.fieldName)
        continue
      }
      if (found.field.type === 'BOOLEAN' && criterion.operator && !['EQUALS', 'IS_BLANK', 'IS_NOT_BLANK', 'TRUE', 'FALSE'].includes(criterion.operator)) {
        reasons.add(`${String(found.field.label ?? criterion.fieldName)} has an unsupported operator: ${criterion.operator}`)
        continue
      }
      criteria.push(criterion)
    }
    return { criteria, booleanOperator: filter.booleanOperator === 'OR' ? 'OR' : 'AND', ...(Array.isArray(filter.subFilters) && filter.subFilters.length ? { subFilters: filter.subFilters.map(clean) } : {}) }
  }
  const filter = clean(view.queryFilter ?? {})
  const saved = (Array.isArray(view.queryFilter?.orderBys) ? view.queryFilter.orderBys : []) as OrderBy[]
  const orderBys = saved.filter((o) => {
    if (!o || typeof o.fieldName !== 'string') return false
    if (exists(o.fieldName)) return true
    removed.add(o.fieldName)
    return false
  })
  if (saved.length && !orderBys.length) orderBys.push({ fieldName: String(tableMeta.primaryKeyField ?? 'id'), isAscending: false })
  if (orderBys.length) filter.orderBys = orderBys
  const columns: string[] = []
  for (const column of view.queryColumns?.columns ?? []) {
    if (column.name === '__check__' || column.isVisible === false) continue
    if (exists(column.name)) columns.push(column.name)
    else removed.add(column.name)
  }
  for (const name of view.quickFilterFieldNames ?? []) if (!exists(name)) removed.add(name)
  const warnings: string[] = []
  if (removed.size) {
    const plural = removed.size > 1
    warnings.push(`${removed.size} field${plural ? 's' : ''} that ${plural ? 'were' : 'was'} part of this view ${plural ? 'are' : 'is'} no longer in this table, and ${plural ? 'were' : 'was'} removed from this view (${[...removed].join(', ')}).`)
  }
  if (reasons.size) {
    const plural = reasons.size > 1
    warnings.push(`${reasons.size} filter${plural ? 's' : ''} ${plural ? 'are' : 'is'} misconfigured for this screen and ${plural ? 'were' : 'was'} removed from this view: (Details: ${[...reasons].join(', ')}).`)
  }
  return { filter, columns, ...(view.rowsPerPage ? { rowsPerPage: view.rowsPerPage } : {}), warnings }
}

/** A saved-view request cannot be done (unavailable, unknown view, server refusal text). */
export class SavedViewError extends Error {}
