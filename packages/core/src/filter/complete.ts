/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Completion for the filter grammar: given the text, the cursor and the table's fields, what can
 * come next (a field, an operator valid for that field, a value or expression, AND / OR / a
 * parenthesis) and which span of the text a candidate replaces. The TUI filter box uses it as the
 * person types; the CLI's shell completion can use it for --where and --group values.
 */

import { FilterSyntaxError, LIST_OPERATORS, OPERATORS, UNARY_OPERATORS, type Operator, type QueryFilter } from './grammar.js'

/** The field metadata completion needs (a structural subset of FieldMetaData). */
export interface CompletionField {
  name: string
  label?: string
  type?: string
  possibleValueSourceName?: string | null
  /** Operators the application allows on this field, when it restricts them. */
  allowedFilterOperators?: string[] | null
  [key: string]: unknown
}

export interface Completion {
  /** The text that replaces the span `from..to`. */
  value: string
  /** What a list shows. */
  label: string
  kind: 'field' | 'operator' | 'value' | 'expression' | 'keyword'
  detail?: string
}

export interface CompletionResult {
  /** The span the candidate replaces (the partial word under the cursor). */
  from: number
  to: number
  /** What the grammar expects at the cursor. */
  expecting: 'field' | 'operator' | 'value' | 'connector'
  /** The field of the criterion being written, when expecting an operator or a value. */
  field?: string
  operator?: Operator
  candidates: Completion[]
}

const SHORTHAND = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=', '~', '!~'])
const SHORTHAND_OP: Record<string, Operator> = { '=': 'EQUALS', '==': 'EQUALS', '!=': 'NOT_EQUALS', '<>': 'NOT_EQUALS', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUALS', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUALS', '~': 'CONTAINS', '!~': 'NOT_CONTAINS' }

const TEXT_OPS: Operator[] = ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'NOT_STARTS_WITH', 'ENDS_WITH', 'NOT_ENDS_WITH', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_BLANK', 'IS_NOT_BLANK']
const NUMBER_OPS: Operator[] = ['EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'BETWEEN', 'NOT_BETWEEN', 'IN', 'NOT_IN', 'IS_BLANK', 'IS_NOT_BLANK']
const DATE_OPS: Operator[] = ['EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'BETWEEN', 'NOT_BETWEEN', 'IS_BLANK', 'IS_NOT_BLANK']
const BOOLEAN_OPS: Operator[] = ['TRUE', 'FALSE', 'IS_BLANK', 'IS_NOT_BLANK']
const CHOICE_OPS: Operator[] = ['EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'IS_NULL_OR_IN', 'IS_BLANK', 'IS_NOT_BLANK']

/** The operators that make sense for a field, honouring `allowedFilterOperators`. */
export function operatorsForField(field: Pick<CompletionField, 'type' | 'possibleValueSourceName' | 'allowedFilterOperators'> | undefined): Operator[] {
  if (!field) return [...OPERATORS]
  const type = String(field.type ?? 'STRING').toUpperCase()
  let ops = field.possibleValueSourceName ? CHOICE_OPS
    : type === 'INTEGER' || type === 'LONG' || type === 'DECIMAL' ? NUMBER_OPS
      : type === 'DATE' || type === 'DATE_TIME' || type === 'TIME' ? DATE_OPS
        : type === 'BOOLEAN' ? BOOLEAN_OPS : TEXT_OPS
  if (field.allowedFilterOperators?.length) {
    const allowed = new Set(field.allowedFilterOperators.map((o) => o.toUpperCase()))
    const narrowed = ops.filter((o) => allowed.has(o))
    ops = narrowed.length ? narrowed : OPERATORS.filter((o) => allowed.has(o))
  }
  return [...ops]
}

/** Expression values for date and time fields (and me() for others), as a person would pick them. */
export function expressionCandidates(type: string | undefined): Completion[] {
  const t = String(type ?? '').toUpperCase()
  if (t === 'DATE' || t === 'DATE_TIME' || t === 'TIME') {
    return [
      ['now()', 'now'], ['now(-1d)', '1 day ago'], ['now(-7d)', '7 days ago'], ['now(-30d)', '30 days ago'], ['now(-1y)', '1 year ago'],
      ['thisPeriod(day)', 'today'], ['thisPeriod(week)', 'this week'], ['thisPeriod(month)', 'this month'], ['thisPeriod(year)', 'this year'],
      ['lastPeriod(week)', 'last week'], ['lastPeriod(month)', 'last month'], ['lastPeriod(year)', 'last year'],
      ['startOf(month)', 'start of this month'], ['startOf(quarter)', 'start of this quarter'], ['startOf(year)', 'start of this year'], ['startOf(month, -1)', 'start of last month'],
    ].map(([value, detail]) => ({ value: value!, label: value!, kind: 'expression' as const, detail }))
  }
  return [{ value: 'me()', label: 'me()', kind: 'expression', detail: 'the signed-in user' }]
}

interface Word { text: string; start: number; end: number; kind: 'word' | '(' | ')' }

/** Splits text into words, group parentheses and function calls (now(-7d) is one word), keeping quotes. */
function words(text: string): Word[] {
  const out: Word[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      out.push({ text: ch, start: i, end: i + 1, kind: ch })
      i++
      continue
    }
    const start = i
    let quoted = false
    let depth = 0
    while (i < text.length) {
      const c = text[i]!
      if (c === '"' && text[i - 1] !== '\\') quoted = !quoted
      else if (!quoted && c === '(') {
        if (/[A-Za-z0-9_}]/.test(text[i - 1] ?? ' ')) depth++
        else break
      } else if (!quoted && c === ')') {
        if (depth > 0) depth--
        else break
      } else if (!quoted && depth === 0 && /\s/.test(c)) break
      i++
    }
    out.push({ text: text.slice(start, i), start, end: i, kind: 'word' })
  }
  return out
}

export interface CompleteOptions {
  /** Possible-value candidates for a field (labels the caller has looked up for this prefix). */
  values?: (field: CompletionField, prefix: string) => Completion[]
  limit?: number
}

/**
 * What can be typed at the cursor. Words before the cursor drive a small state machine
 * (field → operator → value → connector → field …); the word under the cursor is the prefix.
 */
export function completeFilter(text: string, cursor: number, fields: CompletionField[], options: CompleteOptions = {}): CompletionResult {
  const before = text.slice(0, cursor)
  const all = words(before)
  const endsInSpace = before.length > 0 && /[\s(]$/.test(before) || before.length === 0
  const partial = !endsInSpace && all.length && all[all.length - 1]!.kind === 'word' ? all.pop()! : undefined
  const byName = new Map(fields.map((f) => [f.name, f]))
  let state: CompletionResult['expecting'] = 'field'
  let field: CompletionField | undefined
  let operator: Operator | undefined
  let depth = 0
  for (const w of all) {
    if (w.kind === '(') {
      if (state === 'field') depth++
      continue
    }
    if (w.kind === ')') {
      depth = Math.max(0, depth - 1)
      state = 'connector'
      continue
    }
    const upper = w.text.toUpperCase()
    switch (state) {
      case 'field':
        field = byName.get(w.text) ?? { name: w.text }
        state = 'operator'
        break
      case 'operator':
        operator = SHORTHAND.has(w.text) ? SHORTHAND_OP[w.text] : upper as Operator
        state = operator && UNARY_OPERATORS.has(operator) ? 'connector' : 'value'
        break
      case 'value':
        state = operator && LIST_OPERATORS.has(operator) && w.text.endsWith(',') ? 'value' : 'connector'
        break
      case 'connector':
        if (upper === 'AND' || upper === 'OR') {
          state = 'field'
          field = undefined
          operator = undefined
        } else if (operator && LIST_OPERATORS.has(operator) && w.text.startsWith(',')) {
          state = w.text.endsWith(',') ? 'value' : 'connector'
        }
        // any other word continues an unquoted value with spaces
        break
    }
  }
  let prefix = partial?.text ?? ''
  let from = partial?.start ?? cursor
  // a list value: complete the item after the last comma
  if (state === 'value' && operator && LIST_OPERATORS.has(operator) && prefix.includes(',')) {
    const at = prefix.lastIndexOf(',')
    from += at + 1
    prefix = prefix.slice(at + 1)
  }
  const needle = prefix.replace(/^"/, '').toLowerCase()
  const limit = options.limit ?? 50
  let candidates: Completion[] = []
  if (state === 'field') {
    candidates = fields.filter((f) => !needle || f.name.toLowerCase().startsWith(needle) || String(f.label ?? '').toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
      .map((f) => ({ value: f.name, label: f.name, kind: 'field' as const, detail: `${f.label ?? f.name}${f.type ? ` · ${String(f.type).toLowerCase()}` : ''}` }))
    if (!needle) candidates.push({ value: '(', label: '(', kind: 'keyword', detail: 'start a group' })
  } else if (state === 'operator') {
    candidates = operatorsForField(field?.type || field?.possibleValueSourceName ? field : byName.get(field?.name ?? ''))
      .filter((o) => !needle || o.toLowerCase().startsWith(needle) || o.toLowerCase().includes(needle))
      .map((o) => ({ value: o, label: o, kind: 'operator' as const, detail: UNARY_OPERATORS.has(o) ? 'no value' : LIST_OPERATORS.has(o) ? (o.includes('BETWEEN') ? 'two values: a,b' : 'a list: a,b,c') : undefined }))
  } else if (state === 'value') {
    const f = field && byName.get(field.name)
    if (f?.possibleValueSourceName && options.values) candidates.push(...options.values(f, prefix.replace(/^"/, '')))
    if (String(f?.type ?? '').toUpperCase() === 'BOOLEAN') candidates.push(...['true', 'false'].map((v) => ({ value: v, label: v, kind: 'value' as const })))
    candidates.push(...expressionCandidates(f?.type).filter((c) => !needle || c.value.toLowerCase().startsWith(needle) || String(c.detail ?? '').toLowerCase().includes(needle)))
  } else {
    candidates = ['AND', 'OR', ...(depth > 0 ? [')'] : [])].filter((k) => !needle || k.toLowerCase().startsWith(needle))
      .map((k) => ({ value: k, label: k, kind: 'keyword' as const, detail: k === ')' ? 'close the group' : undefined }))
  }
  return { from, to: cursor, expecting: state, field: field?.name, operator, candidates: candidates.slice(0, limit) }
}

/** Applies a completion: the new text and the cursor after it (a space follows fields, operators and keywords). */
export function applyCompletion(text: string, result: Pick<CompletionResult, 'from' | 'to'>, completion: Completion): { text: string; cursor: number } {
  const tail = text.slice(result.to)
  const value = /[\s,]/.test(completion.value) && completion.kind === 'value' && !completion.value.startsWith('"') ? `"${completion.value.replace(/"/g, '\\"')}"` : completion.value
  const space = completion.value === '(' ? '' : tail.startsWith(' ') ? '' : ' '
  const insert = value + space
  return { text: text.slice(0, result.from) + insert + tail, cursor: result.from + insert.length }
}

/** Where in the text a parse error points, from the quoted fragment in its message (best effort). */
export function locateFilterError(text: string, error: unknown): number | undefined {
  if (!(error instanceof FilterSyntaxError)) return undefined
  const quoted = /"([^"]+)"/.exec(error.message)?.[1]
  if (quoted) {
    const at = text.indexOf(quoted)
    if (at >= 0) return at
  }
  if (/Missing "\)"/.test(error.message)) return text.length
  const tail = /: (.+)$/.exec(error.message)?.[1]
  if (tail) {
    const at = text.indexOf(tail)
    if (at >= 0) return at
  }
  return undefined
}

/** A one-line description of a parsed filter: criteria and groups, for a preview. */
export function describeFilter(filter: QueryFilter): string {
  let criteria = 0
  let groups = 0
  const visit = (f: QueryFilter) => {
    criteria += f.criteria.length
    for (const sub of f.subFilters ?? []) {
      groups++
      visit(sub)
    }
  }
  visit(filter)
  if (criteria === 0) return 'no criteria (every record)'
  return `${criteria} criteri${criteria === 1 ? 'on' : 'a'}${groups ? `, ${groups} group${groups === 1 ? '' : 's'}` : ''}, joined by ${filter.booleanOperator}`
}
