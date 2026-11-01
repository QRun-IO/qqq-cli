/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The filter grammar: a text form of QQQ's QQueryFilter that can be parsed and printed back, so a
 * command line, a TUI filter box and a "copy as CLI" link all say the same thing.
 *
 *   field OPERATOR value[,value]         one criterion; operators as in FilterCriteria, or = != < <= > >= ~
 *   a EQUALS 1 AND (b IN x,y OR c IS_BLANK)   groups with AND / OR and parentheses
 *   now()  now(-7d)  now(+2h)            Now and NowWithOffset (s, min, h, d, w, mo, y)
 *   thisPeriod(month)  lastPeriod(week)  ThisOrLastPeriod (minute, hour, day, week, month, year)
 *   startOf(month, -1)                   StartOfPeriod (day, week, month, quarter, year; offset in periods)
 *   me()                                 CurrentUser
 *   ${variable.name}                     FilterVariableExpression
 *   "quoted value, with comma"           quotes keep commas and spaces literal
 */

export type Operator =
  | 'EQUALS' | 'NOT_EQUALS' | 'NOT_EQUALS_OR_IS_NULL' | 'IN' | 'NOT_IN' | 'IS_NULL_OR_IN' | 'LIKE' | 'NOT_LIKE'
  | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'CONTAINS_ALL' | 'NOT_STARTS_WITH' | 'NOT_ENDS_WITH' | 'NOT_CONTAINS'
  | 'LESS_THAN' | 'LESS_THAN_OR_EQUALS' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUALS' | 'IS_BLANK' | 'IS_NOT_BLANK'
  | 'BETWEEN' | 'NOT_BETWEEN' | 'TRUE' | 'FALSE'

export const OPERATORS: Operator[] = [
  'EQUALS', 'NOT_EQUALS', 'NOT_EQUALS_OR_IS_NULL', 'IN', 'NOT_IN', 'IS_NULL_OR_IN', 'LIKE', 'NOT_LIKE', 'STARTS_WITH', 'ENDS_WITH',
  'CONTAINS', 'CONTAINS_ALL', 'NOT_STARTS_WITH', 'NOT_ENDS_WITH', 'NOT_CONTAINS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN',
  'GREATER_THAN_OR_EQUALS', 'IS_BLANK', 'IS_NOT_BLANK', 'BETWEEN', 'NOT_BETWEEN', 'TRUE', 'FALSE',
]

const SHORTHAND: Record<string, Operator> = {
  '=': 'EQUALS', '==': 'EQUALS', '!=': 'NOT_EQUALS', '<>': 'NOT_EQUALS', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUALS',
  '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUALS', '~': 'CONTAINS', '!~': 'NOT_CONTAINS', '~=': 'CONTAINS', '!~=': 'NOT_CONTAINS',
}

/** Shorthand for a case-sensitive text match (`~=`, `!~=`; word operators take a trailing `:CS`, as `STARTS_WITH:CS`). */
const CASE_SENSITIVE_SHORTHAND = new Set(['~=', '!~='])

/** Operators whose value is a comma-separated list. */
export const LIST_OPERATORS = new Set<Operator>(['IN', 'NOT_IN', 'IS_NULL_OR_IN', 'BETWEEN', 'NOT_BETWEEN', 'CONTAINS_ALL'])
/** Operators that take no value. */
export const UNARY_OPERATORS = new Set<Operator>(['IS_BLANK', 'IS_NOT_BLANK', 'TRUE', 'FALSE'])

export type TimeUnit = 'SECONDS' | 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS' | 'MONTHS' | 'YEARS'
export type PeriodUnit = 'DAYS' | 'WEEKS' | 'MONTHS' | 'QUARTERS' | 'YEARS'

/** The expression values the backend understands inside FilterCriteria.values. */
export type FilterExpression =
  | { type: 'Now' }
  | { type: 'NowWithOffset'; operator: 'PLUS' | 'MINUS'; amount: number; timeUnit: TimeUnit }
  | { type: 'ThisOrLastPeriod'; operator: 'THIS' | 'LAST'; timeUnit: TimeUnit }
  | { type: 'StartOfPeriod'; unit: PeriodUnit; offset: number }
  | { type: 'CurrentUser' }
  | { type: 'FilterVariableExpression'; variableName: string }

export type FilterValue = string | FilterExpression

export interface Criterion {
  fieldName: string
  operator: Operator
  values: FilterValue[]
  /** A backend function applied to the field before comparing (`weekday(birthDate) IN 1,7`). */
  fieldFunction?: FieldFunction
  /** Criteria options (`CriteriaOption`): `CASE_INSENSITIVE` on text matches unless asked for case-sensitive. */
  options?: string[]
}

/**
 * Text-matching operators. String comparison is case-sensitive by design on the backends
 * (memory, H2, PostgreSQL); clients opt in to case-insensitive matching per criterion with the
 * `CASE_INSENSITIVE` criteria option, which the grammar adds to these by default.
 */
export const TEXT_MATCH_OPERATORS = new Set<Operator>(['CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'NOT_STARTS_WITH', 'ENDS_WITH', 'NOT_ENDS_WITH', 'LIKE', 'NOT_LIKE', 'CONTAINS_ALL'])

export const CASE_INSENSITIVE = 'CASE_INSENSITIVE'

/** Options a criterion gets: CASE_INSENSITIVE for a text match, unless case-sensitive. */
export function textMatchOptions(operator: Operator, caseSensitive = false): { options?: string[] } {
  return !caseSensitive && TEXT_MATCH_OPERATORS.has(operator) ? { options: [CASE_INSENSITIVE] } : {}
}

/** A backend field function (FieldFunction): `functionTypeIdentifierName` applied to `fieldName`. */
export interface FieldFunction {
  fieldName: string
  functionTypeIdentifierName: string
  arguments?: Record<string, unknown>
}

export const WEEKDAY_OF_DATE = 'WeekdayOfDate'
export const WEEKDAY_OF_DATE_TIME = 'WeekdayOfDateTime'
const DAY_NUMBER: Record<string, string> = { mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', sun: '7' }

/** ISO weekday numbers from typed values: 1-7 or day names (monday, mon, …). */
export function weekdayValues(values: FilterValue[]): string[] {
  return values.map((v) => {
    const text = String(v).trim().toLowerCase()
    if (/^[1-7]$/.test(text)) return text
    const n = DAY_NUMBER[text.slice(0, 3)]
    if (!n) throw new FilterSyntaxError(`Not a weekday: ${String(v)} (use 1-7, Monday 1, or day names)`)
    return n
  })
}

/** Uses WeekdayOfDateTime for weekday criteria on DATE_TIME fields (the grammar cannot know the type). */
export function applyFieldTypes<F extends { criteria: Criterion[]; subFilters?: F[] }>(filter: F, fieldType: (name: string) => string | undefined, dateTimeArguments?: Record<string, unknown>): F {
  for (const c of filter.criteria) {
    if (c.fieldFunction && /^WeekdayOf/.test(c.fieldFunction.functionTypeIdentifierName) && fieldType(c.fieldName) === 'DATE_TIME') {
      c.fieldFunction = { ...c.fieldFunction, functionTypeIdentifierName: WEEKDAY_OF_DATE_TIME, ...(dateTimeArguments ? { arguments: dateTimeArguments } : {}) }
    }
  }
  for (const sub of filter.subFilters ?? []) applyFieldTypes(sub, fieldType, dateTimeArguments)
  return filter
}

export interface OrderBy {
  fieldName: string
  isAscending: boolean
}

/** QQueryFilter, as the UI API accepts it. */
export interface QueryFilter {
  criteria: Criterion[]
  booleanOperator: 'AND' | 'OR'
  subFilters?: QueryFilter[]
  orderBys?: OrderBy[]
  skip?: number
  limit?: number
}

export class FilterSyntaxError extends Error {}

const UNIT_SUFFIX: Record<string, TimeUnit> = { s: 'SECONDS', sec: 'SECONDS', min: 'MINUTES', h: 'HOURS', hr: 'HOURS', d: 'DAYS', w: 'WEEKS', mo: 'MONTHS', y: 'YEARS' }
const UNIT_WORD: Record<string, TimeUnit> = { second: 'SECONDS', minute: 'MINUTES', hour: 'HOURS', day: 'DAYS', week: 'WEEKS', month: 'MONTHS', year: 'YEARS' }
const PERIOD_WORD: Record<string, PeriodUnit> = { day: 'DAYS', week: 'WEEKS', month: 'MONTHS', quarter: 'QUARTERS', year: 'YEARS' }
const SUFFIX_OF: Record<TimeUnit, string> = { SECONDS: 's', MINUTES: 'min', HOURS: 'h', DAYS: 'd', WEEKS: 'w', MONTHS: 'mo', YEARS: 'y' }

/** Turns one value token into a string or an expression. */
export function parseValue(raw: string): FilterValue {
  const text = raw.trim()
  let m: RegExpExecArray | null
  if (/^now\(\s*\)$/i.test(text)) return { type: 'Now' }
  if ((m = /^now\(\s*([+-])\s*(\d+)\s*([a-z]+)\s*\)$/i.exec(text))) {
    const unit = UNIT_SUFFIX[m[3]!.toLowerCase()] ?? UNIT_WORD[m[3]!.toLowerCase().replace(/s$/, '')]
    if (!unit) throw new FilterSyntaxError(`Unknown time unit "${m[3]}" in ${text}; use s, min, h, d, w, mo or y`)
    return { type: 'NowWithOffset', operator: m[1] === '-' ? 'MINUS' : 'PLUS', amount: Number(m[2]), timeUnit: unit }
  }
  if ((m = /^(this|last)Period\(\s*([a-z]+)\s*\)$/i.exec(text))) {
    const unit = UNIT_WORD[m[2]!.toLowerCase().replace(/s$/, '')]
    if (!unit) throw new FilterSyntaxError(`Unknown period "${m[2]}" in ${text}; use minute, hour, day, week, month or year`)
    return { type: 'ThisOrLastPeriod', operator: m[1]!.toLowerCase() === 'this' ? 'THIS' : 'LAST', timeUnit: unit }
  }
  if ((m = /^startOf\(\s*([a-z]+)\s*(?:,\s*([+-]?\d+)\s*)?\)$/i.exec(text))) {
    const unit = PERIOD_WORD[m[1]!.toLowerCase().replace(/s$/, '')]
    if (!unit) throw new FilterSyntaxError(`Unknown period "${m[1]}" in ${text}; use day, week, month, quarter or year`)
    return { type: 'StartOfPeriod', unit, offset: Number(m[2] ?? 0) }
  }
  if (/^me\(\s*\)$/i.test(text) || text === '${me}') return { type: 'CurrentUser' }
  if ((m = /^\$\{variable\.([A-Za-z0-9_.-]+)\}$/.exec(text))) return { type: 'FilterVariableExpression', variableName: m[1]! }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\"/g, '"')
  return text
}

/** Prints a value back in the grammar. */
export function printValue(value: FilterValue): string {
  if (typeof value === 'string') return /[,"()\s]/.test(value) || value === '' ? `"${value.replace(/"/g, '\\"')}"` : value
  switch (value.type) {
    case 'Now': return 'now()'
    case 'NowWithOffset': return `now(${value.operator === 'MINUS' ? '-' : '+'}${value.amount}${SUFFIX_OF[value.timeUnit]})`
    case 'ThisOrLastPeriod': return `${value.operator === 'THIS' ? 'this' : 'last'}Period(${value.timeUnit.toLowerCase().replace(/s$/, '')})`
    case 'StartOfPeriod': return `startOf(${value.unit.toLowerCase().replace(/s$/, '')}${value.offset ? `, ${value.offset}` : ''})`
    case 'CurrentUser': return 'me()'
    case 'FilterVariableExpression': return `\${variable.${value.variableName}}`
  }
}

/** Splits a value list on commas outside quotes. */
function splitValues(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted
    if (ch === ',' && !quoted) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out.map((v) => v.trim()).filter((v, i, all) => v !== '' || all.length === 1)
}

/**
 * Parses one criterion: `field OPERATOR value[,value]`.
 *
 * @param text - The criterion.
 * @param knownFields - When given, the field must be one of them.
 */
export function parseCriterion(text: string, knownFields?: Iterable<string>, options: { caseSensitive?: boolean } = {}): Criterion {
  const match = /^\s*((?:weekday\()?[A-Za-z0-9_.]+\)?)\s+(\S+)\s*(.*)$/s.exec(text)
  if (!match) throw new FilterSyntaxError(`A criterion is "field OPERATOR value": ${text.trim()}`)
  const [, rawField, rawOperator, rest] = match as unknown as [string, string, string, string]
  const weekday = /^weekday\(([A-Za-z0-9_.]+)\)$/.exec(rawField)
  const fieldName = weekday ? weekday[1]! : rawField
  const csSuffix = /:CS$/i.test(rawOperator)
  const opText = csSuffix ? rawOperator.slice(0, -3) : rawOperator
  const operator = SHORTHAND[opText] ?? opText.toUpperCase() as Operator
  if (!OPERATORS.includes(operator)) throw new FilterSyntaxError(`Unknown operator "${rawOperator}"; use one of ${OPERATORS.join(', ')} or = != < <= > >= ~ (~= is a case-sensitive ~)`)
  const caseOptions = textMatchOptions(operator, options.caseSensitive || csSuffix || CASE_SENSITIVE_SHORTHAND.has(opText))
  if (knownFields) {
    const names = [...knownFields]
    if (names.length && !names.includes(fieldName)) throw new FilterSyntaxError(`No field "${fieldName}"; fields: ${names.join(', ')}`)
  }
  const trimmed = rest.trim()
  if (UNARY_OPERATORS.has(operator)) {
    if (trimmed !== '') throw new FilterSyntaxError(`${operator} takes no value: ${text.trim()}`)
    return { fieldName, operator, values: [] }
  }
  if (trimmed === '') throw new FilterSyntaxError(`${operator} needs a value: ${text.trim()}`)
  let values = (LIST_OPERATORS.has(operator) ? splitValues(trimmed) : [trimmed]).map(parseValue)
  if (!weekday && caseOptions.options) return { fieldName, operator, values, ...caseOptions }
  if (weekday) {
    values = weekdayValues(values)
    return { fieldName, operator, values, fieldFunction: { fieldName, functionTypeIdentifierName: WEEKDAY_OF_DATE } }
  }
  if ((operator === 'BETWEEN' || operator === 'NOT_BETWEEN') && values.length !== 2) throw new FilterSyntaxError(`${operator} needs two values: ${text.trim()}`)
  return { fieldName, operator, values }
}

/** Prints one criterion. */
export function printCriterion(c: Criterion): string {
  const field = c.fieldFunction && /^WeekdayOf/.test(c.fieldFunction.functionTypeIdentifierName) ? `weekday(${c.fieldName})` : c.fieldName
  // the criteria options (CASE_INSENSITIVE) are not printed: --print-filter shows them in the JSON
  return c.values.length ? `${field} ${c.operator} ${c.values.map(printValue).join(',')}` : `${field} ${c.operator}`
}

type Token = { kind: '(' | ')' | 'AND' | 'OR' } | { kind: 'criterion'; text: string }

/** Tokenizes a filter expression: parentheses, AND / OR, and criterion text in between. */
function tokenize(source: string): Token[] {
  const text = ` ${source}` // a leading space lets a keyword at the very start be seen
  const tokens: Token[] = []
  let current = ''
  let quoted = false
  const flush = () => {
    if (current.trim()) tokens.push({ kind: 'criterion', text: current.trim() })
    current = ''
  }
  let callDepth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted
    // a "(" right after a name is a function call such as now(-7d), not a group
    if (!quoted && ch === '(' && /[A-Za-z0-9_}]/.test(text[i - 1] ?? ' ')) {
      callDepth++
      current += ch
      continue
    }
    if (!quoted && ch === ')' && callDepth > 0) {
      callDepth--
      current += ch
      continue
    }
    if (!quoted && (ch === '(' || ch === ')')) {
      flush()
      tokens.push({ kind: ch })
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      const word = /^(AND|OR)\b/i.exec(text.slice(i + 1))
      if (word && /\s/.test(text[i + 1 + word[1]!.length] ?? ' ')) {
        flush()
        tokens.push({ kind: word[1]!.toUpperCase() as 'AND' | 'OR' })
        i += word[1]!.length
        continue
      }
    }
    current += ch
  }
  flush()
  return tokens
}

/**
 * Parses a filter expression with groups: `a EQUALS 1 AND (b IN x,y OR c IS_BLANK)`. Mixing AND
 * and OR at one level without parentheses is an error, so the meaning is never ambiguous.
 */
export function parseFilter(text: string, knownFields?: Iterable<string>, options: { caseSensitive?: boolean } = {}): QueryFilter {
  const tokens = tokenize(text)
  let pos = 0
  const peek = () => tokens[pos]
  const parseGroup = (): QueryFilter => {
    const parts: Array<Criterion | QueryFilter> = []
    let op: 'AND' | 'OR' | undefined
    for (;;) {
      const t = peek()
      if (!t) break
      if (t.kind === ')') break
      if (t.kind === '(') {
        pos++
        const inner = parseGroup()
        if (peek()?.kind !== ')') throw new FilterSyntaxError(`Missing ")" in: ${text}`)
        pos++
        parts.push(inner)
      } else if (t.kind === 'criterion') {
        pos++
        parts.push(parseCriterion(t.text, knownFields, options))
      } else {
        if (parts.length === 0) throw new FilterSyntaxError(`${t.kind} without a left side in: ${text}`)
        if (op && op !== t.kind) throw new FilterSyntaxError(`Mixed AND and OR need parentheses: ${text}`)
        op = t.kind
        pos++
        continue
      }
    }
    const criteria = parts.filter((p): p is Criterion => 'fieldName' in p)
    const subFilters = parts.filter((p): p is QueryFilter => 'criteria' in p)
    return { criteria, booleanOperator: op ?? 'AND', ...(subFilters.length ? { subFilters } : {}) }
  }
  const filter = parseGroup()
  if (peek()) throw new FilterSyntaxError(`Unexpected ")" in: ${text}`)
  if (filter.criteria.length === 0 && (filter.subFilters?.length ?? 0) === 1) {
    const only = filter.subFilters![0]!
    return only
  }
  return filter
}

/** Prints a filter back in the grammar (criteria and groups only; order, skip and limit are flags). */
export function printFilter(filter: QueryFilter): string {
  const parts = [
    ...filter.criteria.map(printCriterion),
    ...(filter.subFilters ?? []).map((sub) => `(${printFilter(sub)})`),
  ]
  return parts.join(` ${filter.booleanOperator ?? 'AND'} `)
}

/** Builds a filter from repeated `--where` criteria plus optional `--group` expressions and `--or`. */
export function buildFilter(options: { where?: string[]; group?: string[]; or?: boolean; order?: string[]; skip?: number; limit?: number; knownFields?: Iterable<string>; caseSensitive?: boolean }): QueryFilter {
  const criteria = (options.where ?? []).map((w) => parseCriterion(w, options.knownFields, { caseSensitive: options.caseSensitive }))
  const subFilters = (options.group ?? []).map((g) => parseFilter(g, options.knownFields, { caseSensitive: options.caseSensitive }))
  const orderBys = (options.order ?? []).map((o) => ({ fieldName: o.replace(/^-/, ''), isAscending: !o.startsWith('-') }))
  // one --group and no --where is the filter itself, not a wrapper around it
  const filter: QueryFilter = criteria.length === 0 && subFilters.length === 1 && !options.or ? { ...subFilters[0]! } : { criteria, booleanOperator: options.or ? 'OR' : 'AND' }
  if (subFilters.length && filter !== subFilters[0] && !(criteria.length === 0 && subFilters.length === 1 && !options.or)) filter.subFilters = subFilters
  if (orderBys.length) filter.orderBys = orderBys
  if (options.skip !== undefined) filter.skip = options.skip
  if (options.limit !== undefined) filter.limit = options.limit
  return filter
}
