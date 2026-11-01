/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Quick search, as the web UI's query screen does it: the typed text becomes CONTAINS on each
 * shown string field, ORed, and that group is ANDed onto the advanced filter (the advanced
 * filter's own boolean operator and sort are kept).
 */

import type { QueryFilter } from '../filter/grammar.js'

type J = Record<string, unknown>

/** Field types the quick search matches (the web UI's `isStringType`). */
export const QUICK_SEARCH_TYPES = new Set(['STRING', 'TEXT', 'HTML'])

/**
 * The fields a quick search matches: the given columns, or every field that is not hidden; only
 * string-typed ones. Restricted fields (no read access) are left out.
 */
export function quickSearchFields(tableMeta: J, columns?: string[]): string[] {
  const fields = (tableMeta.fields ?? {}) as Record<string, J>
  const names = columns ?? Object.keys(fields).filter((n) => !fields[n]!.isHidden)
  return names.filter((n) => fields[n] && QUICK_SEARCH_TYPES.has(String(fields[n]!.type)) && fields[n]!.isRestricted !== true && fields[n]!.hasReadAccess !== false)
}

/** CONTAINS on each field, ORed, case-insensitive (CASE_INSENSITIVE) unless asked; undefined for a blank term or no fields. */
export function quickSearchFilter(term: string, fieldNames: string[], options: { caseSensitive?: boolean } = {}): QueryFilter | undefined {
  const text = term.trim()
  if (!text || !fieldNames.length) return undefined
  return { criteria: fieldNames.map((fieldName) => ({ fieldName, operator: 'CONTAINS', values: [text], ...(options.caseSensitive ? {} : { options: ['CASE_INSENSITIVE'] }) })), booleanOperator: 'OR' }
}

function isEmpty(filter: QueryFilter): boolean {
  return !filter.criteria?.length && !filter.subFilters?.length
}

/** ANDs a quick-search group onto a filter, keeping the filter's sort, skip and limit at the top. */
export function combineWithQuickSearch(filter: QueryFilter, quick: QueryFilter | undefined): QueryFilter {
  if (!quick || !quick.criteria.length) return filter
  const { orderBys, skip, limit, ...rest } = filter
  const top: Partial<QueryFilter> = {}
  if (orderBys) top.orderBys = orderBys
  if (skip !== undefined) top.skip = skip
  if (limit !== undefined) top.limit = limit
  if (isEmpty(filter)) return { ...quick, ...top }
  return { criteria: [], booleanOperator: 'AND', subFilters: [rest as QueryFilter, quick], ...top }
}
