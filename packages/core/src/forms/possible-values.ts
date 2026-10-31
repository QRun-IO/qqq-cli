/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { callOperation } from '../api/call.js'
import type { FieldValues, PossibleValue } from './fields.js'

/** Where a field lives: a table's form, or a process step's form. */
export type FormScope = { table: string } | { process: string }

export interface PossibleValueSearch {
  searchTerm?: string
  ids?: unknown[]
  labels?: string[]
  /** The other form values, for contingent fields (`${input.x}` filters). */
  values?: FieldValues
  processValues?: FieldValues
  useCase?: 'FORM' | 'FILTER'
  limit?: number
}

/** Searches a field's possible values, as the web UI's dropdowns do. */
export async function searchPossibleValues(baseUrl: string, fetchImpl: typeof fetch, scope: FormScope, fieldName: string, search: PossibleValueSearch): Promise<PossibleValue[]> {
  const body: Record<string, unknown> = { searchTerm: search.searchTerm ?? '', useCase: search.useCase ?? 'FORM' }
  if (search.ids?.length) body.ids = search.ids.map(String)
  if (search.labels?.length) body.labels = search.labels
  if (search.values) body.values = search.values
  if (search.processValues) body.processValues = search.processValues
  const result = 'table' in scope
    ? await callOperation(baseUrl, 'searchTablePossibleValues', { path: { tableName: scope.table, fieldName }, json: body }, fetchImpl)
    : await callOperation(baseUrl, 'searchProcessPossibleValues', { path: { processName: scope.process, fieldName }, json: body }, fetchImpl)
  const options = ((result.data as { options?: Array<{ id: unknown; label?: string }> } | undefined)?.options ?? [])
  const list = options.map((o) => ({ id: o.id, label: String(o.label ?? o.id) }))
  return search.limit ? list.slice(0, search.limit) : list
}

/**
 * Resolves what a person typed for a possible-value field to an option: an exact id, else an
 * exact label (case-insensitive), else the only option whose label contains the text.
 */
export async function resolvePossibleValue(baseUrl: string, fetchImpl: typeof fetch, scope: FormScope, fieldName: string, typed: string, context: Pick<PossibleValueSearch, 'values' | 'processValues'> & { fieldType?: string } = {}): Promise<{ option?: PossibleValue; candidates: PossibleValue[] }> {
  const { fieldType, ...search } = context
  // an id lookup with text on a numeric field makes the server fail the query, so only try ids that can be ids
  const numeric = fieldType === 'INTEGER' || fieldType === 'LONG' || fieldType === 'DECIMAL'
  if (!numeric || /^-?\d+(\.\d+)?$/.test(typed)) {
    const byId = await searchPossibleValues(baseUrl, fetchImpl, scope, fieldName, { ids: [typed], ...search })
    const exactId = byId.find((o) => String(o.id) === typed)
    if (exactId) return { option: exactId, candidates: [exactId] }
  }
  const byLabel = await searchPossibleValues(baseUrl, fetchImpl, scope, fieldName, { labels: [typed], ...search })
  const exactLabels = byLabel.filter((o) => o.label.toLowerCase() === typed.toLowerCase())
  if (exactLabels.length === 1) return { option: exactLabels[0], candidates: exactLabels }
  if (exactLabels.length > 1) return { option: undefined, candidates: exactLabels }
  const bySearch = await searchPossibleValues(baseUrl, fetchImpl, scope, fieldName, { searchTerm: typed, ...search })
  let contains = bySearch.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()))
  if (!contains.length) {
    // some sources match case-sensitively or by prefix only; look through the first page ourselves
    const firstPage = await searchPossibleValues(baseUrl, fetchImpl, scope, fieldName, { searchTerm: '', limit: 500, ...search })
    contains = firstPage.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()))
  }
  return { option: contains.length === 1 ? contains[0] : undefined, candidates: contains.length ? contains : bySearch }
}
