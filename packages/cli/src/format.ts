/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { components } from "@qrun-io/qqq-ui-api-client"

type Json = Record<string, unknown>
type Operator = NonNullable<components["schemas"]["FilterCriteria"]["operator"]>

const OPERATORS = new Set([
  'EQUALS', 'NOT_EQUALS', 'NOT_EQUALS_OR_IS_NULL', 'IN', 'NOT_IN', 'IS_NULL_OR_IN', 'LIKE', 'NOT_LIKE', 'STARTS_WITH', 'ENDS_WITH',
  'CONTAINS', 'CONTAINS_ALL', 'NOT_STARTS_WITH', 'NOT_ENDS_WITH', 'NOT_CONTAINS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN',
  'GREATER_THAN_OR_EQUALS', 'IS_BLANK', 'IS_NOT_BLANK', 'BETWEEN', 'NOT_BETWEEN', 'TRUE', 'FALSE',
])

const SHORTHAND: Record<string, string> = {
  '=': 'EQUALS', '==': 'EQUALS', '!=': 'NOT_EQUALS', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUALS', '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUALS', '~': 'CONTAINS',
}

/** A filter criterion of the UI API (FilterCriteria). */
export interface Criterion {
  fieldName: string
  operator: Operator
  values: string[]
}

/**
 * Parses `field OPERATOR value[,value]` (operators as in FilterCriteria, or =, !=, <, <=, >, >=, ~).
 *
 * @param text - The criterion.
 * @param fields - The table's fields (to check the name).
 */
export function parseCriteria(text: string, fields: Record<string, unknown>): Criterion {
  const match = /^\s*(\S+)\s+(\S+)\s*(.*)$/.exec(text)
  if (!match) throw new Error(`Criteria must be "field OPERATOR value": ${text}`)
  const [, fieldName, rawOperator, rest] = match
  const operator = SHORTHAND[rawOperator] ?? rawOperator.toUpperCase()
  if (!OPERATORS.has(operator)) throw new Error(`Unknown operator ${rawOperator}; use one of ${[...OPERATORS].join(', ')}`)
  if (Object.keys(fields).length && !(fieldName in fields)) throw new Error(`No field ${fieldName}; fields: ${Object.keys(fields).join(', ')}`)
  const values = rest === '' ? [] : ['IN', 'NOT_IN', 'IS_NULL_OR_IN', 'BETWEEN', 'NOT_BETWEEN', 'CONTAINS_ALL'].includes(operator) ? rest.split(',').map((v) => v.trim()) : [rest.trim()]
  return { fieldName, operator: operator as Operator, values }
}

/** Parses `name=value` pairs. */
export function parseValues(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`Values are name=value: ${pair}`)
    values[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return values
}

/** A record's value as text: its display value when the server sent one. */
export function valueText(record: Json, field: string): string {
  const display = (record.displayValues as Json | undefined)?.[field]
  const raw = (record.values as Json | undefined)?.[field]
  const value = display ?? raw
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * Formats rows as an aligned text table.
 *
 * @param rows - Objects.
 * @param columns - Keys to show.
 * @param headers - Optional header labels.
 */
export function formatTable(rows: Array<Record<string, unknown>>, columns: string[], headers: string[] = columns): string {
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').slice(0, 60)
  const widths = columns.map((c, i) => Math.max(headers[i].length, ...rows.map((r) => cell(r[c]).length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n')
}
