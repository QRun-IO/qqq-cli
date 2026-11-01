/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The F6 filter dialog (design: packages/tui/docs/filter-dialog.md), two modes over one QueryFilter:
 * - guided: a list of condition rows, each a sentence of three cells (field, operator, value). Quick
 *   rows are the same rows seeded from the table's quick filter fields. A row with no value is not
 *   applied and shows (any). AND/OR per level, one level of groups, the sort, Apply and Cancel.
 * - advanced: the grammar typed directly with completion from the kernel, a cheat sheet, inline parse
 *   errors with a caret, and a way back to guided when the text fits it.
 * The footer shows a live match count, the grammar and the equivalent qqq command.
 */

import {
  FilterSyntaxError, LIST_OPERATORS, OPERATORS, UNARY_OPERATORS, WEEKDAY_OF_DATE, WEEKDAY_OF_DATE_TIME, applyFieldTypes, applyCompletion, completeFilter, isEscapedAt, describeFilter, expressionCandidates, locateFilterError,
  operatorsForField, parseFilter, textMatchOptions, TEXT_MATCH_OPERATORS, CASE_INSENSITIVE, parseValue, printCriterion, printFilter, printValue, resolvePossibleValue, searchPossibleValues,
  type CompletionResult, type Completion, type Criterion, type FilterValue, type Operator, type QueryFilter,
} from '@qrun-io/qqq-core'
import type { FieldMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad, shellQuote, trunc } from '../util/text'
import { readViewSettings, writeViewSettings } from '@qrun-io/qqq-core'
import { ChoiceOverlay, ConfirmOverlay, EditorLine, PromptOverlay, overlayId, wrap } from './basic'
import { Frame, Line } from './frame'

type Sort = { field: string; asc: boolean } | undefined

/** How a field's value cell edits. */
export type FieldKind = 'text' | 'number' | 'date' | 'bool' | 'choice'

/** One condition row. A row with no values and an operator that needs one is not applied. */
export interface Cond {
  field: string
  operator: Operator
  values: FilterValue[]
  options?: string[]
  fieldFunction?: Criterion['fieldFunction']
  /** A quick row: seeded from the table's quick filter fields; its field is fixed. */
  quick?: boolean
}

export interface Level {
  booleanOperator: 'AND' | 'OR'
  conds: Cond[]
}

/** A guided row; `level` -1 is the top level, 0.. the groups. */
export type GuidedRow =
  | { kind: 'cond'; level: number; index: number }
  | { kind: 'addQuick' }
  | { kind: 'add'; level: number }
  | { kind: 'group'; level: number }
  | { kind: 'addGroup' }
  | { kind: 'join' }
  | { kind: 'sort' }
  | { kind: 'buttons' }

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const PASTE = '\u0000paste'
const TYPE_IN = '\u0000type'
const MORE = '\u0000more'
const CASE = '\u0000case'
const WEEKDAY_IN = '\u0000weekday-in'
const WEEKDAY_NOT_IN = '\u0000weekday-not-in'

/** Splits pasted text on commas, tabs, semicolons and new lines (quoted values keep their commas). */
export function splitPasted(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && /[,;\t\n\r]/.test(ch)) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

function clone<T>(f: T): T {
  return JSON.parse(JSON.stringify(f)) as T
}

/** A text match without CASE_INSENSITIVE matches exact case. */
export function isCaseSensitive(c: Pick<Criterion, 'operator' | 'options'>): boolean {
  return TEXT_MATCH_OPERATORS.has(c.operator as never) && !(c.options ?? []).includes(CASE_INSENSITIVE)
}

/** The grammar for the editor: exact-case text matches print as OPERATOR:CS so they survive a round trip. */
export function printWithCase(f: QueryFilter): string {
  const mark = (g: QueryFilter): QueryFilter => ({ ...g, criteria: g.criteria.map((c) => (isCaseSensitive(c) ? { ...c, operator: `${c.operator}:CS` as never } : c)), ...(g.subFilters ? { subFilters: (g.subFilters as QueryFilter[]).map(mark) } : {}) })
  return printFilter(mark(f))
}

/** The kind of value editor a field gets. */
export function fieldKind(f: Pick<FieldMetaData, 'type' | 'possibleValueSourceName'> | undefined): FieldKind {
  if (!f) return 'text'
  if (f.possibleValueSourceName) return 'choice'
  const t = String(f.type ?? '').toUpperCase()
  if (t === 'BOOLEAN') return 'bool'
  if (t === 'INTEGER' || t === 'LONG' || t === 'DECIMAL') return 'number'
  if (t === 'DATE' || t === 'DATE_TIME' || t === 'TIME') return 'date'
  return 'text'
}

const ORDER: Record<FieldKind, Operator[]> = {
  text: ['CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'EQUALS', 'NOT_EQUALS', 'NOT_CONTAINS', 'NOT_STARTS_WITH', 'NOT_ENDS_WITH', 'IN', 'NOT_IN', 'IS_BLANK', 'IS_NOT_BLANK'],
  number: ['EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'BETWEEN', 'NOT_BETWEEN', 'IN', 'NOT_IN', 'IS_BLANK', 'IS_NOT_BLANK'],
  date: ['EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'BETWEEN', 'NOT_BETWEEN', 'IN', 'NOT_IN', 'IS_BLANK', 'IS_NOT_BLANK'],
  choice: ['IN', 'NOT_IN', 'IS_BLANK', 'IS_NOT_BLANK', 'EQUALS', 'NOT_EQUALS'],
  bool: ['EQUALS', 'IS_BLANK', 'IS_NOT_BLANK'],
}

/** The operators offered for a field, most useful first (a boolean's EQUALS stands for "is true/false"). */
export function operatorsFor(f: FieldMetaData | undefined): Operator[] {
  const kind = fieldKind(f)
  const valid = operatorsForField(f as never)
  const ok = (o: Operator) => (kind === 'bool' && o === 'EQUALS' ? valid.includes('TRUE') || valid.includes('EQUALS') : valid.includes(o))
  const first = ORDER[kind].filter(ok)
  const rest = valid.filter((o) => !first.includes(o) && !(kind === 'bool' && (o === 'TRUE' || o === 'FALSE')))
  return [...first, ...rest]
}

/** The operator a new row starts with: contains for text, = for numbers and dates, is any of for choices, is for booleans. */
export function defaultOperator(f: FieldMetaData | undefined): Operator {
  return operatorsFor(f)[0] ?? 'EQUALS'
}

/** True when the row is part of the filter (a value, or an operator that takes none). */
export function isApplied(c: Pick<Cond, 'operator' | 'values'>): boolean {
  return UNARY_OPERATORS.has(c.operator) || c.values.length > 0
}

/** The operator as the row says it. */
export function operatorLabel(op: Operator, kind: FieldKind, weekday = false): string {
  const a = glyphs().pointer === '>'
  if (weekday) return op === 'NOT_IN' ? 'weekday is not' : 'weekday is'
  if (kind === 'bool' && (op === 'EQUALS' || op === 'TRUE' || op === 'FALSE')) return 'is'
  const words = kind === 'text' || kind === 'choice'
  switch (op) {
    case 'EQUALS': return words ? 'is' : '='
    case 'NOT_EQUALS': return words ? 'is not' : a ? '!=' : '≠'
    case 'NOT_EQUALS_OR_IS_NULL': return words ? 'is not (or empty)' : a ? '!= or empty' : '≠ or empty'
    case 'IN': return 'is any of'
    case 'NOT_IN': return 'is none of'
    case 'IS_NULL_OR_IN': return 'empty or any of'
    case 'CONTAINS': return 'contains'
    case 'NOT_CONTAINS': return "doesn't contain"
    case 'CONTAINS_ALL': return 'contains all of'
    case 'STARTS_WITH': return 'starts with'
    case 'NOT_STARTS_WITH': return "doesn't start with"
    case 'ENDS_WITH': return 'ends with'
    case 'NOT_ENDS_WITH': return "doesn't end with"
    case 'LIKE': return 'is like'
    case 'NOT_LIKE': return 'is not like'
    case 'LESS_THAN': return '<'
    case 'LESS_THAN_OR_EQUALS': return a ? '<=' : '≤'
    case 'GREATER_THAN': return '>'
    case 'GREATER_THAN_OR_EQUALS': return a ? '>=' : '≥'
    case 'BETWEEN': return 'between'
    case 'NOT_BETWEEN': return 'not between'
    case 'IS_BLANK': return 'is empty'
    case 'IS_NOT_BLANK': return 'is not empty'
    case 'TRUE': return 'is true'
    case 'FALSE': return 'is false'
  }
  return String(op).toLowerCase().replace(/_/g, ' ')
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * The values typed into a value cell: one value, a list (a, b, c) or a range (from, to; or from and
 * to). Empty text means no value (the row is then not applied). Numbers and dates are checked.
 */
export function valuesFromText(f: Pick<FieldMetaData, 'type' | 'possibleValueSourceName' | 'label'>, op: Operator, text: string): FilterValue[] {
  const t = text.trim()
  if (!t) return []
  const kind = fieldKind(f)
  const between = op === 'BETWEEN' || op === 'NOT_BETWEEN'
  const parts = between ? t.split(/\s*,\s*|\s+and\s+/i).filter(Boolean) : LIST_OPERATORS.has(op) ? splitPasted(t) : [t]
  if (between && parts.length !== 2) throw new FilterSyntaxError('between takes two values: from, to')
  const one = (p: string): FilterValue => {
    if (kind === 'text' && !LIST_OPERATORS.has(op)) return p
    const v = parseValue(p)
    if (typeof v !== 'string') return v
    if (kind === 'number' && !NUMBER.test(v)) throw new FilterSyntaxError(`"${v}" is not a number`)
    if (kind === 'date' && String(f.type).toUpperCase() !== 'TIME' && !DATE.test(v)) throw new FilterSyntaxError(`"${v}" is not a date: type YYYY-MM-DD or an expression such as now(-7d), startOf(month)`)
    return v
  }
  return parts.map(one)
}

/** Builds the guided levels from a filter; booleans read as is true / is false. */
export function levelsOf(filter: QueryFilter): { top: Level; groups: Level[] } {
  const cond = (c: Criterion): Cond => {
    const out: Cond = { field: c.fieldName, operator: c.operator, values: [...c.values], ...(c.options ? { options: [...c.options] } : {}), ...(c.fieldFunction ? { fieldFunction: { ...c.fieldFunction } } : {}) }
    if (c.operator === 'EQUALS' && c.values.length === 1 && /^(true|false)$/i.test(String(c.values[0]))) {
      // EQUALS true from the grammar is the same condition as TRUE
      out.operator = String(c.values[0]).toLowerCase() === 'true' ? 'TRUE' : 'FALSE'
      out.values = []
    }
    return out
  }
  return {
    top: { booleanOperator: filter.booleanOperator ?? 'AND', conds: (filter.criteria ?? []).map(cond) },
    groups: (filter.subFilters ?? []).map((g) => ({ booleanOperator: g.booleanOperator ?? 'AND', conds: (g.criteria ?? []).map(cond) })),
  }
}

/** The filter of the applied rows; empty groups are dropped. */
export function filterOf(top: Level, groups: Level[]): QueryFilter {
  const crit = (c: Cond): Criterion => ({ fieldName: c.field, operator: c.operator, values: [...c.values], ...(c.options ? { options: [...c.options] } : {}), ...(c.fieldFunction ? { fieldFunction: { ...c.fieldFunction } } : {}) })
  const subs = groups.map((g) => ({ booleanOperator: g.booleanOperator, criteria: g.conds.filter(isApplied).map(crit) })).filter((g) => g.criteria.length)
  return { criteria: top.conds.filter(isApplied).map(crit), booleanOperator: top.booleanOperator, ...(subs.length ? { subFilters: subs } : {}) }
}

/** Why a filter cannot be shown in guided mode, or undefined when it can. */
export function guidedProblem(f: QueryFilter): string | undefined {
  if ((f.subFilters ?? []).some((g) => g.subFilters?.length)) return 'Guided shows one level of groups; this filter has a group inside a group. Keep editing here, or flatten the inner parentheses.'
  return undefined
}

/** Where AND and OR are mixed at one level without parentheses: the first joiner that differs. */
export function mixedJoinAt(text: string): number | undefined {
  const first: Array<string | undefined> = [undefined]
  let quoted = false
  let calls = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"' && !isEscapedAt(text, i)) quoted = !quoted // a \" inside a value does not end it (as in core's tokenizer)
    if (quoted) continue
    if (ch === '(') {
      if (/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ')) calls++
      else first.push(undefined)
    } else if (ch === ')') {
      if (calls) calls--
      else if (first.length > 1) first.pop()
    } else if (/\s/.test(text[i - 1] ?? ' ')) {
      const m = /^(AND|OR)(?=\s)/i.exec(text.slice(i))
      if (m) {
        const word = m[1]!.toUpperCase()
        const at = first.length - 1
        if (first[at] === undefined) first[at] = word
        else if (first[at] !== word) return i
      }
    }
  }
  return undefined
}

const CHEAT = [
  '= != < <= > >=  compare',
  '~ x             contains, any case',
  '~= x            contains, exact case',
  'STARTS_WITH x   ENDS_WITH, LIKE too',
  'OP:CS           text ops, exact case',
  'IN a,b,c        any of (NOT_IN: none)',
  'BETWEEN a,b     from, to',
  'IS_BLANK        IS_NOT_BLANK too',
  'TRUE  FALSE     true/false fields',
  '"a, b"          quote commas, spaces',
  'a AND b         or: a OR b',
  'a AND (b OR c)  mixing needs ( )',
  'now(-7d)        now(), now(+1h)',
  'startOf(month)  thisPeriod(week)',
  'weekday(f) IN sat,sun',
]

export class FilterOverlay implements Overlay {
  readonly id = overlayId('filter')
  mode: 'guided' | 'advanced' = 'guided'
  top: Level
  groups: Level[]
  sort: Sort
  row = 0
  /** The focused cell: field 0, operator 1, value 2 (buttons: Apply 0, Cancel 1). */
  cell = 2
  /** The value cell being edited in place, and the error of the last confirm. */
  editing?: LineEditor
  editError?: string
  /** Labels of possible-value ids, for display: `${field}\u0000${id}` -> label. */
  labels = new Map<string, string>()
  readonly text = new LineEditor('')
  completion?: CompletionResult
  candidate = 0
  parseError?: { message: string; at?: number }
  /** Why Advanced could not switch to Guided. */
  modeError?: string
  historyIndex = -1
  historySearch?: LineEditor
  /** The live match count: total of the table, and the count of the current filter. */
  total?: number
  count?: { key: string; state: 'counting' | 'done' | 'error'; value?: number; message?: string }
  private countTimer?: ReturnType<typeof setTimeout>
  private countSeq = 0
  private valueCache = new Map<string, Completion[]>()
  private readonly opened: string

  constructor(private store: AppStore, readonly meta: TableMetaData, filter: QueryFilter, sort: Sort, private onApply: (filter: QueryFilter, sort: Sort | null) => void) {
    const l = levelsOf(clone({ ...filter, criteria: filter.criteria ?? [], booleanOperator: filter.booleanOperator ?? 'AND' }))
    this.top = l.top
    this.groups = l.groups
    this.sort = sort
    this.seedQuick()
    this.opened = this.signature()
    this.collectLabels()
  }

  // ---- model ----

  fields(): FieldMetaData[] {
    return Object.values(this.meta.fields).filter((f) => !f.isHidden)
  }

  field(name: string): FieldMetaData | undefined {
    return this.meta.fields[name]
  }

  level(l: number): Level {
    return l < 0 ? this.top : this.groups[l]!
  }

  /** The filter of the applied rows. */
  current(): QueryFilter {
    return filterOf(this.top, this.groups)
  }

  signature(): string {
    return `${printWithCase(this.current())}\u0000${this.sort ? `${this.sort.field}:${this.sort.asc}` : ''}`
  }

  dirty(): boolean {
    return this.signature() !== this.opened
  }

  /** Quick filter fields: the table's defaults (defaultQuickFilterFieldNames, else T1 fields) plus the ones added here (kept per table). */
  quickFields(): string[] {
    return [...new Set([...this.defaultQuickFields(), ...this.addedQuickFields()])].filter((n) => this.meta.fields[n] && !this.meta.fields[n]!.isHidden && operatorsForField(this.meta.fields[n]).length)
  }

  defaultQuickFields(): string[] {
    const md = ((this.meta.supplementalMetaData as Record<string, unknown> | undefined)?.materialDashboard ?? {}) as { defaultQuickFilterFieldNames?: string[] }
    return md.defaultQuickFilterFieldNames?.length ? md.defaultQuickFilterFieldNames : (this.meta.sections ?? []).filter((x) => x.tier === 'T1').flatMap((x) => x.fieldNames ?? [])
  }

  addedQuickFields(): string[] {
    return (readViewSettings(`table:${this.meta.name}`).quickFilterFields as string[] | undefined) ?? []
  }

  /** Marks or adds a top-level row for every quick field, quick rows first. */
  seedQuick(): void {
    const quick: Cond[] = []
    for (const name of this.quickFields()) {
      const at = this.top.conds.findIndex((c) => c.field === name && !c.fieldFunction && !c.quick)
      if (at >= 0) quick.push({ ...this.top.conds.splice(at, 1)[0]!, quick: true })
      else quick.push(this.blank(name, true))
    }
    this.top.conds = [...quick, ...this.top.conds.filter((c) => !c.quick)]
  }

  blank(name: string, quick = false): Cond {
    const f = this.field(name)
    const op = defaultOperator(f)
    return { field: name, operator: op, values: [], ...textMatchOptions(op), ...(quick ? { quick: true } : {}) }
  }

  /** Looks up labels for possible-value ids already in the filter. */
  collectLabels(): void {
    const all = [...this.top.conds, ...this.groups.flatMap((g) => g.conds)]
    for (const c of all) {
      const f = this.field(c.field)
      const ids = c.values.filter((v): v is string => typeof v === 'string')
      if (!f?.possibleValueSourceName || !ids.length || !this.store.client) continue
      searchPossibleValues(this.store.client.server, this.store.client.fetch, { table: this.meta.name }, f.name, { ids, useCase: 'FILTER' })
        .then((opts) => { for (const o of opts) this.labels.set(`${f.name}\u0000${String(o.id)}`, o.label); this.store.bump() })
        .catch(() => undefined)
    }
  }

  rows(): GuidedRow[] {
    const out: GuidedRow[] = []
    const quick = this.top.conds.filter((c) => c.quick).length
    this.top.conds.forEach((_, i) => {
      out.push({ kind: 'cond', level: -1, index: i })
      if (i === quick - 1) out.push({ kind: 'addQuick' })
    })
    if (!quick) out.push({ kind: 'addQuick' })
    out.push({ kind: 'add', level: -1 })
    this.groups.forEach((g, gi) => {
      out.push({ kind: 'group', level: gi })
      g.conds.forEach((_, i) => out.push({ kind: 'cond', level: gi, index: i }))
      out.push({ kind: 'add', level: gi })
    })
    out.push({ kind: 'addGroup' }, { kind: 'join' }, { kind: 'sort' }, { kind: 'buttons' })
    return out
  }

  focused(): GuidedRow | undefined {
    return this.rows()[this.row]
  }

  condAt(r: GuidedRow | undefined): Cond | undefined {
    return r?.kind === 'cond' ? this.level(r.level).conds[r.index] : undefined
  }

  levelOf(r: GuidedRow | undefined): number {
    return r && 'level' in r ? r.level : -1
  }

  focusCond(level: number, index: number, cell = 2): void {
    const at = this.rows().findIndex((r) => r.kind === 'cond' && r.level === level && r.index === index)
    if (at >= 0) {
      this.row = at
      this.cell = cell
    }
  }

  focusRow(kind: GuidedRow['kind']): void {
    const at = this.rows().findIndex((r) => r.kind === kind)
    if (at >= 0) this.row = at
  }

  valueText(c: Cond): string {
    const kind = fieldKind(this.field(c.field))
    if (c.fieldFunction) return c.values.map((v) => DAYS[Number(v) - 1] ?? String(v)).join(', ')
    if (c.operator === 'TRUE') return kind === 'bool' ? 'true' : ''
    if (c.operator === 'FALSE') return kind === 'bool' ? 'false' : ''
    if (UNARY_OPERATORS.has(c.operator)) return ''
    if (!c.values.length) return '(any)'
    const text = (v: FilterValue) => (typeof v === 'string' ? this.labels.get(`${c.field}\u0000${v}`) ?? v : printValue(v))
    const s = c.operator === 'BETWEEN' || c.operator === 'NOT_BETWEEN' ? c.values.map(text).join(' and ') : c.values.map(text).join(', ')
    return `${s}${isCaseSensitive({ operator: c.operator, options: c.options }) ? '  (exact case)' : ''}`
  }

  /** The text a value edit starts from. */
  editText(c: Cond): string {
    if (!c.values.length) return ''
    if (fieldKind(this.field(c.field)) === 'text' && !LIST_OPERATORS.has(c.operator)) return String(typeof c.values[0] === 'string' ? c.values[0] : printValue(c.values[0]!))
    return c.values.map(printValue).join(', ')
  }

  // ---- guided editing ----

  /** Starts editing the focused value cell in place (text, number, date). */
  startEdit(initial?: string): void {
    const c = this.condAt(this.focused())
    if (!c) return
    this.cell = 2
    this.editing = new LineEditor(initial ?? this.editText(c))
    this.editError = undefined
  }

  confirmEdit(): boolean {
    const c = this.condAt(this.focused())
    if (!c || !this.editing) return true
    try {
      c.values = valuesFromText(this.field(c.field) ?? { type: 'STRING', label: c.field }, c.operator, this.editing.value)
      this.editing = undefined
      this.editError = undefined
      return true
    } catch (e) {
      this.editError = errorText(e)
      return false
    }
  }

  /** Clears the focused cell: a value back to (any), an operator back to the default. */
  clearCell(): void {
    const r = this.focused()
    const c = this.condAt(r)
    if (r?.kind === 'sort') {
      this.sort = undefined
      return
    }
    if (!c) return
    const f = this.field(c.field)
    if (this.cell === 0) return
    if (this.cell === 1 || (UNARY_OPERATORS.has(c.operator) && fieldKind(f) !== 'bool') || c.fieldFunction) {
      const op = defaultOperator(f)
      delete c.fieldFunction
      delete c.options
      Object.assign(c, { operator: op, values: [] }, textMatchOptions(op))
      return
    }
    if (this.cell === 2) {
      if (fieldKind(f) === 'bool') c.operator = 'EQUALS'
      c.values = []
    }
  }

  /** Space/Enter on a boolean value: (any) → true → false → (any). */
  cycleBool(c: Cond): void {
    c.values = []
    c.operator = c.operator === 'TRUE' ? 'FALSE' : c.operator === 'FALSE' ? 'EQUALS' : 'TRUE'
  }

  /** Edits the focused cell the way its type asks (Enter, Space, or typing `ch`). */
  editCell(ch = ''): void {
    const r = this.focused()
    const c = this.condAt(r)
    if (!c || !r || r.kind !== 'cond') return
    const f = this.field(c.field)
    if (this.cell === 0) {
      if (c.quick) return this.store.flash('a quick row keeps its field; Ctrl+N adds a condition on another field')
      return this.pickField(`Filter on which field?`, (nf) => {
        const fresh = this.blank(nf.name)
        Object.keys(c).forEach((k) => { if (k !== 'quick') delete (c as unknown as Record<string, unknown>)[k] })
        Object.assign(c, fresh)
        this.cell = 2
        this.afterNewField(r.level, r.index)
      }, ch)
    }
    if (this.cell === 1) return this.pickOperator(c, ch)
    if (!f) return
    const kind = fieldKind(f)
    if (c.fieldFunction) return this.pickWeekdays(f, c.operator, (n) => { c.values = n.values; this.store.bump() }, c.values.map(String))
    if (kind === 'bool' && (c.operator === 'EQUALS' || c.operator === 'TRUE' || c.operator === 'FALSE')) {
      if (ch.toLowerCase() === 't') c.operator = 'TRUE'
      else if (ch.toLowerCase() === 'f') c.operator = 'FALSE'
      else if (!ch || ch === ' ') this.cycleBool(c)
      c.values = []
      return
    }
    if (UNARY_OPERATORS.has(c.operator)) return this.store.flash(`"${operatorLabel(c.operator, kind)}" takes no value; Backspace resets the comparison`)
    const between = c.operator === 'BETWEEN' || c.operator === 'NOT_BETWEEN'
    if (kind === 'choice' && !between) return this.pickChoices(f, c, ch)
    if (kind === 'date' && !ch && !between && !LIST_OPERATORS.has(c.operator)) {
      const presets = expressionCandidates(f.type).map((x) => ({ label: x.detail ?? x.value, value: x.value, detail: x.value }))
      this.store.open(new ChoiceOverlay(this.store, `${f.label} ${operatorLabel(c.operator, kind)}`, [{ label: 'Type a date or an expression…', value: TYPE_IN, detail: 'YYYY-MM-DD' }, ...presets], (v) => {
        if (v === TYPE_IN) return this.startEdit()
        c.values = [parseValue(v)]
        this.store.bump()
      }))
      return
    }
    this.startEdit(ch ? ch : undefined)
  }

  /** After a field is chosen for a row: go straight to its value. */
  afterNewField(level: number, index: number): void {
    this.focusCond(level, index, 2)
    const c = this.level(level).conds[index]!
    const kind = fieldKind(this.field(c.field))
    if (kind === 'text' || kind === 'number' || kind === 'date') this.startEdit()
    else if (kind === 'choice') this.editCell()
    this.store.bump()
  }

  pickField(title: string, next: (f: FieldMetaData) => void, search = '', onCancel?: () => void): void {
    const o = new ChoiceOverlay(this.store, title, this.fields().map((f) => ({ label: f.label, value: f, detail: `${f.name} · ${f.possibleValueSourceName ? 'choice' : f.type.toLowerCase()}` })), next, 'type to search', 0, onCancel)
    if (search) o.filter.set(search)
    this.store.open(o)
  }

  /** The operator list for a row: the ones that fit the field, weekday criteria, exact case, more. */
  pickOperator(c: Cond, search = ''): void {
    const f = this.field(c.field)
    const kind = fieldKind(f)
    const ops = operatorsFor(f)
    const weekdays = kind === 'date' && String(f?.type).toUpperCase() !== 'TIME' && this.weekdayEnabled()
    const choices: Array<{ label: string; value: string; detail?: string }> = [
      ...ops.map((o) => ({ label: operatorLabel(o, kind), value: o as string, detail: kind === 'bool' && o === 'EQUALS' ? 'TRUE / FALSE' : o })),
      ...(weekdays ? [{ label: 'weekday is', value: WEEKDAY_IN, detail: 'day of the week is any of' }, { label: 'weekday is not', value: WEEKDAY_NOT_IN, detail: 'day of the week is none of' }] : []),
      ...(TEXT_MATCH_OPERATORS.has(c.operator as never) ? [{ label: isCaseSensitive(c) ? 'Ignore case (the default)' : 'Match exact case', value: CASE, detail: isCaseSensitive(c) ? 'now: exact case' : 'now: any case' }] : []),
      ...(OPERATORS.some((o) => !ops.includes(o)) ? [{ label: 'More operators…', value: MORE, detail: 'for other field types' }] : []),
    ]
    const shown = c.fieldFunction ? (c.operator === 'NOT_IN' ? WEEKDAY_NOT_IN : WEEKDAY_IN) : kind === 'bool' && (c.operator === 'TRUE' || c.operator === 'FALSE') ? 'EQUALS' : c.operator
    const pick = (o: string) => {
      if (o === MORE) {
        this.store.open(new ChoiceOverlay(this.store, `${f?.label ?? c.field}: every operator`, OPERATORS.map((x) => ({ label: operatorLabel(x, kind), value: x as string, detail: x })), pick))
        return
      }
      if (o === CASE) {
        const cs = !isCaseSensitive(c)
        delete c.options
        Object.assign(c, textMatchOptions(c.operator, cs))
        return
      }
      if (o === WEEKDAY_IN || o === WEEKDAY_NOT_IN) {
        c.operator = o === WEEKDAY_IN ? 'IN' : 'NOT_IN'
        c.values = []
        delete c.options
        c.fieldFunction = { fieldName: c.field, functionTypeIdentifierName: String(f?.type).toUpperCase() === 'DATE_TIME' ? WEEKDAY_OF_DATE_TIME : WEEKDAY_OF_DATE }
        this.cell = 2
        if (f) this.pickWeekdays(f, c.operator, (n) => { c.values = n.values; this.store.bump() })
        return
      }
      const op = o as Operator
      const was = c.operator
      const cs = isCaseSensitive(c)
      if (c.fieldFunction) {
        delete c.fieldFunction
        c.values = []
      }
      if (kind === 'bool' && op === 'EQUALS') c.operator = was === 'TRUE' || was === 'FALSE' ? was : 'EQUALS'
      else c.operator = op
      const range = (x: Operator) => x === 'BETWEEN' || x === 'NOT_BETWEEN'
      if (UNARY_OPERATORS.has(c.operator) || LIST_OPERATORS.has(was) !== LIST_OPERATORS.has(c.operator) || range(was) !== range(c.operator)) c.values = []
      delete c.options
      Object.assign(c, textMatchOptions(c.operator, cs))
      this.cell = 2
      this.store.bump()
    }
    const o = new ChoiceOverlay<string>(this.store, `${f?.label ?? c.field}: which comparison?`, choices, pick, 'type to search', Math.max(0, choices.findIndex((x) => x.value === shown)))
    if (search) o.filter.set(search)
    this.store.open(o)
  }

  /** The possible-value picker: one value, or for a list operator Enter adds or removes values until Done. */
  pickChoices(f: FieldMetaData, c: Cond, search = ''): void {
    const list = LIST_OPERATORS.has(c.operator)
    const open = (acc: FilterValue[], term: string, focus?: string) => {
      const finish = (vals: FilterValue[]) => {
        c.values = vals
        this.store.bump()
      }
      const overlay = new ChoiceOverlay<string | null>(this.store, `${f.label} ${operatorLabel(c.operator, 'choice')}${list ? ` (${acc.length} chosen)` : ''}`, [], (id) => {
        if (id === null) return finish(acc)
        if (id === PASTE) return this.pasteValues(f, true, (vals) => finish([...new Set([...acc, ...vals])]))
        if (!list) return finish([id])
        open(acc.includes(id) ? acc.filter((x) => x !== id) : [...acc, id], overlay.filter.value, id)
      }, list ? 'Enter toggles · Esc done' : 'type to search', 0, () => { if (list) finish(acc) })
      const load = (term2: string) => {
        if (!this.store.client) return
        searchPossibleValues(this.store.client.server, this.store.client.fetch, { table: this.meta.name }, f.name, { searchTerm: term2, useCase: 'FILTER', limit: 100 }).then((opts) => {
          overlay.choices.splice(0, overlay.choices.length,
            ...(list ? [{ label: acc.length ? `Done (${acc.map((v) => this.labels.get(`${f.name}\u0000${String(v)}`) ?? String(v)).join(', ')})` : 'Done (none chosen: any)', value: null }] : []),
            ...(list && !term2 ? [{ label: 'Paste a list of labels or ids…', value: PASTE, detail: 'bulk add' }] : []),
            ...opts.map((o) => {
              this.labels.set(`${f.name}\u0000${String(o.id)}`, o.label)
              return { label: `${list ? (acc.includes(String(o.id)) ? `${glyphs().check} ` : `${glyphs().uncheck} `) : ''}${o.label}`, value: String(o.id), detail: String(o.id) }
            }))
          // the cursor starts on the value just toggled, else on the first value
          const at = overlay.choices.findIndex((x) => (focus ? x.value === focus : x.value !== null && x.value !== PASTE))
          overlay.index = Math.max(0, at)
          this.store.bump()
        }).catch((e) => this.store.flash(errorText(e), 'error'))
      }
      const original = overlay.onKey.bind(overlay)
      overlay.onKey = (key: Key) => {
        const before = overlay.filter.value
        original(key)
        if (overlay.filter.value !== before) load(overlay.filter.value)
      }
      // the server searches; the list is not filtered again locally
      overlay.matches = () => overlay.choices
      if (term) overlay.filter.set(term)
      load(term)
      this.store.open(overlay)
    }
    open(list ? [...c.values] : [], search)
  }

  weekdayEnabled(): boolean {
    const sup = (this.store.meta as { supplementalInstanceMetaData?: { uiSettings?: Record<string, unknown>; materialDashboard?: Record<string, unknown> } } | undefined)?.supplementalInstanceMetaData
    const settings = (sup?.uiSettings?.weekdayCriteriaSettings ?? sup?.materialDashboard?.weekdayCriteriaSettings) as { enabled?: boolean } | undefined
    return settings?.enabled !== false
  }

  /** Day-of-week criteria: a multi-pick of Monday … Sunday (ISO numbers), with the WeekdayOf function. */
  pickWeekdays(f: FieldMetaData, op: Operator, done: (c: Criterion) => void, acc: string[] = []): void {
    const crit = (): Criterion => ({ fieldName: f.name, operator: op, values: acc, fieldFunction: { fieldName: f.name, functionTypeIdentifierName: f.type === 'DATE_TIME' ? WEEKDAY_OF_DATE_TIME : WEEKDAY_OF_DATE } })
    const choices = [{ label: acc.length ? `Done (${acc.map((d) => DAYS[Number(d) - 1]).join(', ')})` : 'Done (none chosen: any)', value: '' }, ...DAYS.map((d, i) => ({ label: `${acc.includes(String(i + 1)) ? glyphs().check : glyphs().uncheck} ${d}`, value: String(i + 1) }))]
    this.store.open(new ChoiceOverlay(this.store, `${f.label}: day of the week ${op === 'NOT_IN' ? 'is none of' : 'is any of'}`, choices, (v) => {
      if (!v) return done(crit())
      this.pickWeekdays(f, op, done, acc.includes(v) ? acc.filter((x) => x !== v) : [...acc, v].sort())
    }, 'Enter adds or removes a day · Esc done', 0, () => done(crit())))
  }

  /** The instance's help for bulk-added filter values (help slots bulkAddFilterValues…). */
  pasteHelp(pvs: boolean): string {
    const help = (this.store.meta as { helpContents?: Record<string, Array<{ contentAsText?: string; content?: string }>> } | undefined)?.helpContents?.[pvs ? 'bulkAddFilterValuesPossibleValueSource' : 'bulkAddFilterValues']
    return help?.map((h) => h.contentAsText ?? h.content ?? '').filter(Boolean).join(' ') ?? ''
  }

  /** Bulk paste of possible values: labels or ids separated by commas, tabs, semicolons or new lines. */
  pasteValues(f: FieldMetaData, pvs: boolean, done: (values: FilterValue[]) => void, initial = ''): void {
    const help = this.pasteHelp(pvs)
    this.store.open(new PromptOverlay(this.store, `${f.label}: values`, `Type or paste values separated by commas, tabs, semicolons or new lines${pvs ? ' (labels or ids)' : ''}; duplicates are dropped.${help ? ` ${help}` : ''}`, (text) => {
      const parts = [...new Set(splitPasted(text))]
      if (!parts.length) return
      if (!pvs) {
        try {
          return done(parts.map((p) => parseValue(p)))
        } catch (e) {
          return this.store.flash(errorText(e), 'error')
        }
      }
      const c = this.store.client!
      Promise.all(parts.map((p) => resolvePossibleValue(c.server, c.fetch, { table: this.meta.name }, f.name, p, { fieldType: f.type }).then((r) => ({ p, option: r.option }))))
        .then((rs) => {
          const missing = rs.filter((r) => !r.option).map((r) => r.p)
          for (const r of rs) if (r.option) this.labels.set(`${f.name}\u0000${String(r.option.id)}`, r.option.label)
          if (missing.length) this.store.flash(`not added (no match): ${missing.join(', ')}`, 'error')
          done(rs.filter((r) => r.option).map((r) => String(r.option!.id)))
          this.store.bump()
        }).catch((e) => this.store.flash(errorText(e), 'error'))
    }, initial, { newline: ', ' }))
  }

  /** Ctrl+N: a new condition at a level; picks its field first (cancelled: no row). */
  addCond(level: number): void {
    if (level >= this.groups.length) level = -1
    this.pickField(level >= 0 ? 'Add a condition to the group: which field?' : 'Add a condition: which field?', (f) => {
      const lv = this.level(level)
      lv.conds.push(this.blank(f.name))
      this.afterNewField(level, lv.conds.length - 1)
    })
  }

  addGroup(): void {
    this.pickField('A new group (conditions in parentheses): first field?', (f) => {
      this.groups.push({ booleanOperator: this.top.booleanOperator === 'AND' ? 'OR' : 'AND', conds: [this.blank(f.name)] })
      this.afterNewField(this.groups.length - 1, 0)
    })
  }

  addQuick(): void {
    const have = new Set(this.quickFields())
    this.store.open(new ChoiceOverlay(this.store, 'Add a quick filter field (remembered for this table)', this.fields().filter((f) => !have.has(f.name)).map((f) => ({ label: f.label, value: f.name, detail: f.name })), (name) => {
      const key = `table:${this.meta.name}`
      const v = readViewSettings(key)
      writeViewSettings(key, { ...v, quickFilterFields: [...((v.quickFilterFields as string[] | undefined) ?? []), name] })
      const at = this.top.conds.filter((c) => c.quick).length
      this.top.conds.splice(at, 0, this.blank(name, true))
      this.afterNewField(-1, at)
    }, 'type to search'))
  }

  /** Ctrl+D: removes the focused row (a quick row forgets its added quick field; a table's own quick field is only cleared). */
  removeRow(r: GuidedRow | undefined): void {
    if (!r) return
    if (r.kind === 'cond') {
      const lv = this.level(r.level)
      const c = lv.conds[r.index]!
      if (c.quick) {
        if (this.defaultQuickFields().includes(c.field)) {
          lv.conds[r.index] = this.blank(c.field, true)
          this.store.flash('a quick field of the table: cleared (it stays in the list)')
          return
        }
        const key = `table:${this.meta.name}`
        const v = readViewSettings(key)
        writeViewSettings(key, { ...v, quickFilterFields: ((v.quickFilterFields as string[] | undefined) ?? []).filter((n) => n !== c.field) })
      }
      lv.conds.splice(r.index, 1)
      if (r.level >= 0 && !lv.conds.length) this.groups.splice(r.level, 1)
    } else if (r.kind === 'group') this.groups.splice(r.level, 1)
    else if (r.kind === 'sort') this.sort = undefined
    this.row = Math.min(this.row, this.rows().length - 1)
  }

  toggleJoin(level: number): void {
    const lv = this.level(level)
    lv.booleanOperator = lv.booleanOperator === 'AND' ? 'OR' : 'AND'
  }

  clearAll(): void {
    this.top = { booleanOperator: 'AND', conds: [] }
    this.groups = []
    this.seedQuick()
    this.row = 0
    this.cell = 2
  }

  editSort(): void {
    this.store.open(new ChoiceOverlay(this.store, 'Sort by', [{ label: '(default order)', value: '' }, ...this.fields().map((f) => ({ label: f.label, value: f.name, detail: f.name }))], (field) => {
      if (!field) {
        this.sort = undefined
        return
      }
      this.store.open(new ChoiceOverlay(this.store, 'Direction', [{ label: 'Ascending', value: true }, { label: 'Descending', value: false }], (asc) => { this.sort = { field, asc }; this.store.bump() }))
    }, 'type to search'))
  }

  /** Enter or Space on the focused row. */
  activate(): void {
    const r = this.focused()
    if (!r) return
    if (r.kind === 'cond') return this.editCell()
    if (r.kind === 'addQuick') return this.addQuick()
    if (r.kind === 'add') return this.addCond(r.level)
    if (r.kind === 'addGroup') return this.addGroup()
    if (r.kind === 'group') return this.toggleJoin(r.level)
    if (r.kind === 'join') return this.toggleJoin(-1)
    if (r.kind === 'sort') return this.editSort()
    if (r.kind === 'buttons') return this.cell === 1 ? this.cancel() : this.apply()
  }

  // ---- advanced ----

  toAdvanced(): void {
    if (this.editing && !this.confirmEdit()) return
    this.text.set(printWithCase(this.current()))
    this.mode = 'advanced'
    this.modeError = undefined
    this.complete()
  }

  toGuided(): void {
    const parsed = this.parse()
    if (!parsed) {
      this.modeError = `Guided needs a filter that parses: ${this.parseError?.message ?? 'fix the text'} (Ctrl+U clears it)`
      return
    }
    const problem = guidedProblem(parsed)
    if (problem) {
      this.modeError = problem
      return
    }
    const l = levelsOf(parsed)
    this.top = l.top
    this.groups = l.groups
    this.seedQuick()
    this.collectLabels()
    this.mode = 'guided'
    this.modeError = undefined
    this.row = 0
    this.cell = 2
  }

  parse(): QueryFilter | undefined {
    const text = this.text.value.trim()
    if (!text) {
      this.parseError = undefined
      return { criteria: [], booleanOperator: 'AND' }
    }
    try {
      const f = parseFilter(text, Object.keys(this.meta.fields))
      this.parseError = undefined
      return f
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.parseError = { message, at: /^Mixed AND and OR/.test(message) ? mixedJoinAt(text) ?? locateFilterError(text, e) : locateFilterError(text, e) }
      return undefined
    }
  }

  complete(): void {
    const fields = this.fields().map((f) => ({ name: f.name, label: f.label, type: f.type, possibleValueSourceName: f.possibleValueSourceName, allowedFilterOperators: f.allowedFilterOperators as string[] | undefined }))
    this.completion = completeFilter(this.text.value, this.text.cursor, fields, {
      values: (f, prefix) => {
        const key = `${f.name}\u0000${prefix.toLowerCase()}`
        if (!this.valueCache.has(key) && this.store.client) {
          this.valueCache.set(key, [])
          searchPossibleValues(this.store.client.server, this.store.client.fetch, { table: this.meta.name }, f.name, { searchTerm: prefix, useCase: 'FILTER', limit: 20 }).then((opts) => {
            this.valueCache.set(key, opts.map((o) => ({ value: o.label, label: o.label, kind: 'value' as const, detail: String(o.id) })))
            if (this.mode === 'advanced') {
              this.complete()
              this.store.bump()
            }
          }).catch(() => undefined)
        }
        return this.valueCache.get(key) ?? []
      },
    })
    this.candidate = 0
    this.parse()
  }

  /** Turns possible-value labels typed in the text into ids (the server filters by id). */
  async resolveLabels(filter: QueryFilter): Promise<QueryFilter> {
    const visit = async (f: QueryFilter) => {
      for (const c of f.criteria) {
        const field = this.field(c.fieldName)
        if (!field?.possibleValueSourceName) continue
        const out: FilterValue[] = []
        for (const v of c.values) {
          if (typeof v !== 'string') {
            out.push(v)
            continue
          }
          const { option } = await resolvePossibleValue(this.store.client!.server, this.store.client!.fetch, { table: this.meta.name }, field.name, v, { fieldType: field.type })
          out.push(option ? String(option.id) : v)
        }
        c.values = out
      }
      for (const s of f.subFilters ?? []) await visit(s)
    }
    const copy = clone(filter)
    await visit(copy)
    return copy
  }

  /** Weekday functions follow the field type (WeekdayOfDateTime on DATE_TIME, with the instance's arguments). */
  typed(f: QueryFilter): QueryFilter {
    const sup = (this.store.meta as { supplementalInstanceMetaData?: { uiSettings?: Record<string, unknown> } } | undefined)?.supplementalInstanceMetaData
    const args = (sup?.uiSettings?.weekdayCriteriaSettings as { dateTimeFieldFunctionArguments?: Record<string, unknown> } | undefined)?.dateTimeFieldFunctionArguments
    return applyFieldTypes(f, (n) => this.meta.fields[n]?.type, args)
  }

  // ---- live count ----

  /** Counts the current filter a moment after the last change (once per distinct filter). */
  scheduleCount(): void {
    const client = this.store.client
    if (!client) return
    const key = this.mode === 'advanced' ? `a\u0000${this.text.value.trim()}` : `g\u0000${printWithCase(this.current())}`
    if (this.count?.key === key) return
    if (this.countTimer) clearTimeout(this.countTimer)
    const parsed = this.mode === 'advanced' ? (this.parseError ? undefined : this.parse()) : this.current()
    if (!parsed) {
      this.count = { key, state: 'error', message: 'the filter does not parse' }
      return
    }
    this.count = { key, state: 'counting' }
    const seq = ++this.countSeq
    this.countTimer = setTimeout(() => {
      if (!this.store.overlays.includes(this)) return
      const work = (async () => {
        if (this.total === undefined) this.total = await client.count(this.meta.name, { criteria: [], booleanOperator: 'AND' })
        const f = this.typed(this.mode === 'advanced' ? await this.resolveLabels(parsed) : parsed)
        return client.count(this.meta.name, f)
      })()
      work.then((n) => {
        if (seq !== this.countSeq) return
        this.count = { key, state: 'done', value: n }
        this.store.bump()
      }, (e) => {
        if (seq !== this.countSeq) return
        this.count = { key, state: 'error', message: errorText(e) }
        this.store.bump()
      })
    }, 350)
  }

  countText(): string {
    const c = this.count
    if (!c || c.state === 'counting') return ` matches ${glyphs().ellipsis}`
    if (c.state === 'error') return ` count: ${c.message}`
    return ` matches ${c.value}${this.total !== undefined ? ` of ${this.total}` : ''} record${this.total === 1 ? '' : 's'}`
  }

  // ---- apply, cancel ----

  paste(text: string): void {
    if (this.mode === 'advanced') {
      this.text.insert(text)
      this.complete()
      return
    }
    if (this.editing) return this.editing.insert(text.replace(/[\r\n\t;]+/g, ', '))
    const c = this.condAt(this.focused())
    const f = c && this.field(c.field)
    if (!c || !f) return
    if (fieldKind(f) === 'choice') return this.pasteValues(f, true, (vals) => { c.values = LIST_OPERATORS.has(c.operator) ? [...new Set([...c.values, ...vals])] : vals.slice(0, 1); this.store.bump() }, text)
    if (fieldKind(f) !== 'bool' && !UNARY_OPERATORS.has(c.operator)) this.startEdit(text.replace(/[\r\n\t;]+/g, ', '))
  }

  apply(): void {
    if (this.mode === 'advanced') {
      const parsed0 = this.parse()
      if (!parsed0) return
      const parsed = this.typed(parsed0)
      this.store.filterHistory.add(this.text.value)
      this.store.run(this.resolveLabels(parsed), (resolved) => {
        this.close()
        this.onApply(resolved, this.sort ?? null)
      })
      return
    }
    if (this.editing && !this.confirmEdit()) return
    const f = this.typed(this.current())
    if (printFilter(f)) this.store.filterHistory.add(printFilter(f))
    this.close()
    this.onApply(f, this.sort ?? null)
  }

  close(): void {
    if (this.countTimer) clearTimeout(this.countTimer)
    this.store.closeOverlay(this)
  }

  cancel(): void {
    const changed = this.mode === 'advanced' ? this.text.value.trim() !== printWithCase(this.current()) || this.dirty() : this.dirty()
    if (!changed) return this.close()
    this.store.open(new ConfirmOverlay(this.store, 'Discard the changes to the filter?', () => this.close()))
  }

  /** The qqq command the footer shows (set by render); ^Y copies it. */
  private cliText?: string

  onKey(key: Key): void {
    if (this.mode === 'guided' && this.editing) return this.editKey(key)
    if (key.name === 'escape') {
      if (this.historySearch) {
        this.historySearch = undefined
        return
      }
      return this.cancel()
    }
    if (key.name === 'f10' || (key.ctrl && key.name === 's')) return this.apply()
    if (key.ctrl && key.name === 'y' && this.cliText) {
      const how = this.store.copyText(this.cliText)
      return this.store.flash(how ? `copied the command (${how})` : 'no clipboard here', how ? 'info' : 'error')
    }
    if (key.name === 'f2') return this.mode === 'guided' ? this.toAdvanced() : this.toGuided()
    if (this.mode === 'guided') return this.guidedKey(key)
    return this.advancedKey(key)
  }

  /** Keys while a value cell is edited in place. */
  editKey(key: Key): void {
    const ed = this.editing!
    if (key.name === 'escape') {
      this.editing = undefined
      this.editError = undefined
      return
    }
    if (key.name === 'return' || key.name === 'tab' || key.name === 'up' || key.name === 'down' || key.name === 'f10' || (key.ctrl && key.name === 's')) {
      if (!this.confirmEdit()) return
      if (key.name === 'up' || key.name === 'down') return this.guidedKey(key)
      if (key.name === 'f10' || (key.ctrl && key.name === 's')) return this.apply()
      return
    }
    if (ed.handle(key)) this.editError = undefined
  }

  guidedKey(key: Key): void {
    const rows = this.rows()
    const r = rows[this.row]
    const ch = charOf(key)
    const wasCond = r?.kind === 'cond'
    const cells = r?.kind === 'cond' ? 3 : r?.kind === 'buttons' ? 2 : 1
    if (key.name === 'down') this.row = Math.min(rows.length - 1, this.row + 1)
    else if (key.name === 'up') this.row = Math.max(0, this.row - 1)
    else if (key.name === 'pagedown') this.row = Math.min(rows.length - 1, this.row + 10)
    else if (key.name === 'pageup') this.row = Math.max(0, this.row - 10)
    else if (key.name === 'home') this.row = 0
    else if (key.name === 'end') this.row = rows.length - 1
    else if (key.name === 'right' || (key.name === 'tab' && !key.shift)) {
      if (this.cell < cells - 1) this.cell++
      else if (key.name === 'tab' && this.row < rows.length - 1) {
        this.row++
        this.cell = 0
      }
    } else if (key.name === 'left' || (key.name === 'tab' && key.shift)) {
      if (this.cell > 0) this.cell = Math.min(this.cell, cells - 1) - 1
      else if (key.name === 'tab' && this.row > 0) {
        this.row--
        this.cell = 2
      }
    } else if (key.name === 'return' || key.name === 'space') this.activate()
    else if (key.name === 'backspace' || key.name === 'delete') this.clearCell()
    else if ((key.ctrl && key.name === 'n') || key.name === 'insert') this.addCond(this.levelOf(r))
    else if (key.ctrl && key.name === 'd') this.removeRow(r)
    else if (key.ctrl && key.name === 'o') this.toggleJoin(this.levelOf(r))
    else if (key.ctrl && key.name === 'g') this.addGroup()
    else if (key.ctrl && key.name === 'u') this.store.open(new ConfirmOverlay(this.store, 'Clear every condition? (quick rows go back to (any))', () => this.clearAll()))
    else if (ch && r?.kind === 'cond') this.editCell(ch)
    else if (ch && r?.kind === 'sort') this.editSort()
    if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown' || key.name === 'home' || key.name === 'end') {
      const nr = this.rows()[this.row]
      if (nr?.kind === 'buttons') this.cell = Math.min(this.cell, 1)
      else if (nr?.kind === 'cond' && !wasCond) this.cell = 2
    }
  }

  advancedKey(key: Key): void {
    if (this.historySearch) {
      if (key.name === 'return' || (key.ctrl && key.name === 'r')) {
        const hit = this.store.filterHistory.search(this.historySearch.value)[0]
        if (hit) this.text.set(hit)
        this.historySearch = undefined
        this.complete()
        return
      }
      this.historySearch.handle(key)
      return
    }
    const cands = this.completion?.candidates ?? []
    if (key.ctrl && key.name === 'r') {
      this.historySearch = new LineEditor('')
      return
    }
    if (key.name === 'tab') {
      if (key.shift) return this.toGuided()
      const c = cands[this.candidate]
      if (c && this.completion) {
        const next = applyCompletion(this.text.value, this.completion, c)
        this.text.value = next.text
        this.text.cursor = next.cursor
        this.complete()
      }
      return
    }
    if (key.name === 'down' || key.name === 'up') {
      if (cands.length && this.text.value.trim()) {
        this.candidate = (this.candidate + (key.name === 'down' ? 1 : cands.length - 1)) % cands.length
      } else {
        const hist = this.store.filterHistory.entries()
        this.historyIndex = Math.max(-1, Math.min(hist.length - 1, this.historyIndex + (key.name === 'up' ? 1 : -1)))
        this.text.set(this.historyIndex >= 0 ? hist[this.historyIndex]! : '')
        this.complete()
      }
      return
    }
    if (key.name === 'return') return this.apply()
    if (key.ctrl && key.name === 'g') return this.toGuided()
    if (this.text.handle(key)) {
      this.modeError = undefined
      this.complete()
    }
  }

  // ---- help lines ----

  /** How the focused cell edits, in a sentence. */
  cellHelp(): string {
    const r = this.focused()
    if (this.editing) {
      const c = this.condAt(r)
      const f = c && this.field(c.field)
      const kind = fieldKind(f)
      const between = c && (c.operator === 'BETWEEN' || c.operator === 'NOT_BETWEEN')
      const list = c && LIST_OPERATORS.has(c.operator)
      const what = between ? 'from, to' : list ? 'values separated by commas' : kind === 'number' ? 'a number' : kind === 'date' ? 'YYYY-MM-DD or now(-7d), startOf(month)' : 'text (any case)'
      return `${f?.label ?? ''}: type ${what}; Enter confirms, Esc cancels, empty = (any)`
    }
    if (!r) return ''
    switch (r.kind) {
      case 'addQuick': return 'Enter adds a quick field: a row that is always here for this table'
      case 'add': return `Enter adds a condition${r.level >= 0 ? ' to this group' : ''}`
      case 'addGroup': return 'Enter adds a group: conditions in parentheses, with their own AND/OR'
      case 'group': return `Enter or Ctrl+O switches this group to ${this.level(r.level).booleanOperator === 'AND' ? 'OR' : 'AND'}; Ctrl+D removes the group`
      case 'join': return `Enter switches the top-level joiner to ${this.top.booleanOperator === 'AND' ? 'OR' : 'AND'}`
      case 'sort': return 'Enter picks the sort field and direction; Backspace goes back to the default order'
      case 'buttons': return this.cell === 1 ? 'Enter cancels (asks when there are changes)' : 'Enter applies the filter and the sort'
    }
    const c = this.condAt(r)!
    const f = this.field(c.field)
    const kind = fieldKind(f)
    const label = f?.label ?? c.field
    if (this.cell === 0) return c.quick ? `${label}: a quick row keeps its field${this.defaultQuickFields().includes(c.field) ? '' : '; Ctrl+D forgets it'}` : `${label}: Enter or typing picks another field`
    if (this.cell === 1) return `${label}: Enter or typing picks the comparison; Backspace: back to "${operatorLabel(defaultOperator(f), kind)}"`
    if (c.fieldFunction) return `${label}: Enter picks the days of the week; Backspace clears`
    if (kind === 'bool' && (c.operator === 'EQUALS' || c.operator === 'TRUE' || c.operator === 'FALSE')) return `${label}: Space or Enter cycles (any) ${this.arrow()} true ${this.arrow()} false; t/f set it; Backspace clears`
    if (UNARY_OPERATORS.has(c.operator)) return `${label}: "${operatorLabel(c.operator, kind)}" takes no value; Backspace resets the comparison`
    const between = c.operator === 'BETWEEN' || c.operator === 'NOT_BETWEEN'
    if (kind === 'choice' && !between) return `${label}: Enter or typing opens the list${LIST_OPERATORS.has(c.operator) ? ' (Enter toggles values)' : ''}; Backspace clears`
    if (kind === 'date' && !between && !LIST_OPERATORS.has(c.operator)) return `${label}: type YYYY-MM-DD or now(-7d); Enter: presets; Backspace clears`
    const what = between ? 'from, to' : LIST_OPERATORS.has(c.operator) ? 'values separated by commas' : kind === 'number' ? 'a number' : kind === 'date' ? 'dates' : 'text (any case)'
    return `${label}: type ${what} (or Enter); Backspace clears`
  }

  arrow(): string {
    return glyphs().pointer === '>' ? '->' : '→'
  }

  /** The keys that apply where the focus is, the most important kept when the line is narrow. */
  keyLine(width = 200): string {
    if (this.editing) return ' Enter confirm · Esc cancel edit · ←→ Home End move · ^U clear text'
    const r = this.focused()
    const cond = r?.kind === 'cond'
    // [text, priority (lower is kept first)]
    const items: Array<[string, number]> = [
      [cond || r?.kind === 'buttons' ? '↑↓ ←→ move' : '↑↓ move', 6],
      ...(cond ? [['Enter edit', 0], ['Bksp clear', 3]] as Array<[string, number]> : r?.kind === 'buttons' ? [] : [['Enter ' + (r?.kind === 'sort' ? 'change' : r?.kind === 'group' || r?.kind === 'join' ? 'and/or' : 'add'), 0] as [string, number]]),
      ['^N add', 4],
      ...(cond || r?.kind === 'group' || r?.kind === 'sort' ? [['^D remove', 5] as [string, number]] : []),
      ['^O and/or', 7], ['^G group', 9], ['F2 advanced', 8], ['F10 apply', 1], ['Esc cancel', 2],
    ]
    const kept = new Set<string>()
    let used = 1
    for (const [text] of [...items].sort((a, b) => a[1] - b[1])) {
      if (used + text.length + 3 > width) continue
      kept.add(text)
      used += text.length + 3
    }
    return ` ${items.filter(([text]) => kept.has(text)).map(([text]) => text).join(' · ')}`
  }

  // ---- render ----

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    const width = Math.min(sw - 2, 110)
    const inner = width - 2
    const height = Math.min(sh - 3, 32)
    this.scheduleCount()
    const lines: React.ReactNode[] = []
    const tabs = <text flexShrink={0} wrapMode="none" key="tabs"><span fg={this.mode === 'guided' ? t.selFg : t.fg} bg={this.mode === 'guided' ? t.selBg : undefined}>{' Guided '}</span><span fg={t.dim}>{` ${g.sep} `}</span><span fg={this.mode === 'advanced' ? t.selFg : t.fg} bg={this.mode === 'advanced' ? t.selBg : undefined}>{' Advanced '}</span><span fg={t.dim}>{pad('   F2 switches', inner - 21)}</span></text>
    lines.push(tabs)
    let grammar = ''
    if (this.mode === 'guided') {
      lines.push(<Line key="sp" text="" width={inner} />)
      const rows = this.rows()
      const body = Math.max(3, Math.min(rows.length, height - 9))
      const top = Math.max(0, Math.min(this.row - Math.floor(body / 2), rows.length - body))
      const wf = inner >= 96 ? 22 : 16
      const wo = inner >= 96 ? 18 : 15
      rows.slice(top, top + body).forEach((r, i) => {
        const sel = top + i === this.row
        const ptr = sel ? g.pointer : ' '
        const key = `r${top + i}`
        if (r.kind === 'cond') {
          const lv = this.level(r.level)
          const c = lv.conds[r.index]!
          const f = this.field(c.field)
          const kind = fieldKind(f)
          const applied = isApplied(c)
          const fg = applied ? t.fg : t.dim
          const tag = c.quick ? 'quick ' : '      '
          const join = r.index > 0 ? lv.booleanOperator.toLowerCase().padEnd(4) : '    '
          const indent = r.level >= 0 ? '    ' : ''
          const head = `${ptr} ${tag}${indent}${join}`
          const vw = Math.max(4, inner - head.length - wf - wo - 2)
          const fieldCell = pad(f?.label ?? c.field, wf)
          const opCell = pad(operatorLabel(c.operator, kind, !!c.fieldFunction), wo)
          const cellBg = (n: number) => (sel && this.cell === n ? t.selBg : undefined)
          const cellFg = (n: number, base: string) => (sel && this.cell === n ? t.selFg : base)
          let valueNode: React.ReactNode
          if (sel && this.editing) {
            const v = this.editing.view(vw - 1)
            const rest = vw - v.before.length - 1 - v.after.length
            valueNode = <><span fg={t.inputFg} bg={t.inputBg}>{v.before}</span><span fg={t.inputBg} bg={t.inputFg}>{v.at}</span><span fg={t.inputFg} bg={t.inputBg}>{v.after + ' '.repeat(Math.max(0, rest))}</span></>
          } else {
            const vt = this.valueText(c)
            valueNode = <span fg={cellFg(2, vt === '(any)' ? t.dim : fg)} bg={cellBg(2)}>{pad(vt || (UNARY_OPERATORS.has(c.operator) ? '' : ' '), vw)}</span>
          }
          lines.push(<text flexShrink={0} wrapMode="none" key={key}><span fg={sel ? t.acc : t.dim}>{head}</span><span fg={cellFg(0, fg)} bg={cellBg(0)}>{fieldCell}</span><span>{' '}</span><span fg={cellFg(1, fg)} bg={cellBg(1)}>{opCell}</span><span>{' '}</span>{valueNode}</text>)
          return
        }
        if (r.kind === 'buttons') {
          const b = (label: string, n: number) => <span fg={sel && this.cell === n ? t.selFg : t.acc} bg={sel && this.cell === n ? t.selBg : undefined}>{`[ ${label} ]`}</span>
          lines.push(<text flexShrink={0} wrapMode="none" key={key}><span fg={t.acc}>{`${ptr}           `}</span>{b('Apply', 0)}<span>{'  '}</span>{b('Cancel', 1)}<span>{' '.repeat(Math.max(0, inner - 12 - 21))}</span></text>)
          return
        }
        let text = ''
        let fg = t.fg
        const lead = '            '
        if (r.kind === 'addQuick') {
          text = `${lead}+ add a quick field (remembered for this table)`
          fg = t.acc
        } else if (r.kind === 'add') {
          text = `${lead}${r.level >= 0 ? '    ' : ''}+ add a condition${r.level >= 0 ? ' to this group' : ''}`
          fg = t.acc
        } else if (r.kind === 'group') {
          const before = r.level > 0 || this.top.conds.length > 0
          text = `        ${before ? this.top.booleanOperator.toLowerCase().padEnd(4) : '    '}( group: its conditions joined by ${this.level(r.level).booleanOperator} )`
          fg = t.acc2
        } else if (r.kind === 'addGroup') {
          text = `${lead}+ add a group (conditions in parentheses)`
          fg = t.acc
        } else if (r.kind === 'join') {
          text = `${lead}conditions are joined by ${this.top.booleanOperator}`
          fg = t.dim
        } else if (r.kind === 'sort') {
          text = `${lead}${this.sort ? `sorted by ${this.field(this.sort.field)?.label ?? this.sort.field}, ${this.sort.asc ? 'ascending' : 'descending'}` : 'sorted in the default order'}`
          fg = t.dim
        }
        lines.push(<text flexShrink={0} wrapMode="none" key={key} fg={sel ? t.selFg : fg} bg={sel ? t.selBg : undefined}>{pad(`${ptr}${text.slice(1)}`, inner)}</text>)
      })
      for (let i = Math.min(body, rows.length - top); i < body; i++) lines.push(<Line key={`p${i}`} text="" width={inner} />)
      grammar = printWithCase(this.current())
      lines.push(<Line key="help" text={` ${this.editError ?? this.cellHelp()}`} width={inner} fg={this.editError ? t.err : t.acc2} />)
      lines.push(<Line key="keys" text={this.keyLine(inner)} width={inner} fg={t.dim} />)
    } else {
      lines.push(<box key="ed" paddingLeft={1}><EditorLine editor={this.text} width={inner - 2} placeholder="lastName STARTS_WITH S AND (birthDate > now(-40y) OR email IS_BLANK)" /></box>)
      if (this.historySearch) lines.push(<text flexShrink={0} wrapMode="none" key="hs" fg={t.acc2}>{pad(` history search: ${this.historySearch.value}_  → ${this.store.filterHistory.search(this.historySearch.value)[0] ?? '(no match)'}`, inner)}</text>)
      else if (this.parseError) {
        // the caret sits under the offending place in the visible part of the (scrolled) editor
        const at = this.parseError.at
        const start = this.text.cursor - this.text.view(inner - 3).before.length
        const col = at === undefined ? -1 : at - start
        lines.push(<text flexShrink={0} wrapMode="none" key="caret" fg={t.err}>{pad(col >= 0 && col < inner - 3 ? ` ${' '.repeat(col)}^` : at !== undefined ? ` (at character ${at + 1})` : '', inner)}</text>)
      } else lines.push(<Line key="caret" text="" width={inner} />)
      const parsed = this.parseError ? undefined : this.parse()
      const message = (m: string) => m.split(`: ${this.text.value.trim()}`)[0]!.replace(/ in$/, '')
      const status = this.modeError ? ` ${message(this.modeError)}` : this.parseError ? ` ${message(this.parseError.message)}` : ` ${parsed ? describeFilter(parsed) || 'every record' : ''}`
      wrap(status.trim(), inner - 2).slice(0, 2).forEach((l, i) => lines.push(<Line key={`st${i}`} text={` ${l}`} width={inner} fg={this.modeError || this.parseError ? t.err : t.ok} />))
      const cands = this.completion?.candidates ?? []
      const body = Math.max(3, Math.min(CHEAT.length, height - 2 - lines.length - 5))
      const cheatW = inner >= 90 ? 42 : 40
      const candW = inner - cheatW - 1
      const ctop = Math.max(0, Math.min(this.candidate - Math.floor(body / 2), cands.length - body))
      lines.push(<text flexShrink={0} wrapMode="none" key="ex"><span fg={t.dim}>{pad(` expecting ${this.completion?.expecting ?? 'field'}${this.completion?.field ? ` (${this.completion.field})` : ''}`, candW)}</span><span fg={t.dim}>{` ${pad('cheat sheet', cheatW)}`}</span></text>)
      for (let i = 0; i < body; i++) {
        const c = cands[ctop + i]
        const sel = ctop + i === this.candidate && !!c
        const left = c ? `  ${pad(c.label, Math.min(26, candW - 12))} ${c.detail ?? ''}` : ''
        lines.push(<text flexShrink={0} wrapMode="none" key={`c${i}`}><span fg={sel ? t.selFg : c?.kind === 'keyword' ? t.acc2 : t.fg} bg={sel ? t.selBg : undefined}>{pad(left, candW)}</span><span fg={t.dim}>{' '}</span><span fg={t.acc2}>{pad(CHEAT[i] ? ` ${CHEAT[i]}` : '', cheatW)}</span></text>)
      }
      grammar = this.text.value.trim()
      lines.push(<Line key="keys" text={inner >= 96 ? ' Tab complete · ↑↓ choose (history when empty) · ^R history · F2 guided · Enter apply · Esc cancel' : ' Tab complete · ↑↓ choose · ^R history · F2 guided · Enter apply · Esc'} width={inner} fg={t.dim} />)
    }
    const cli = `qqq table query ${this.meta.name}${grammar ? ` -g ${shellQuote(grammar)}` : ''}${this.sort ? ` -o ${this.sort.asc ? '' : '-'}${this.sort.field}` : ''}`
    this.cliText = cli
    lines.push(<Line key="count" text={this.countText()} width={inner} fg={this.count?.state === 'error' ? t.err : t.ok} />)
    lines.push(<text flexShrink={0} wrapMode="none" key="gram" fg={t.acc}>{pad(` ${trunc(grammar || '(no criteria: every record)', inner - 2)}`, inner)}</text>)
    lines.push(<text flexShrink={0} wrapMode="none" key="cli" fg={t.dim}>{pad(` ${trunc(cli, inner - 14)}`, inner - 11)}{pad('  ^Y copies', 11)}</text>)
    return <Frame title={`Filter ${this.meta.label}`} width={width} height={lines.length + 2} screenWidth={sw} screenHeight={sh} top={1}>{lines}</Frame>
  }
}

export { printCriterion, wrap, FilterSyntaxError }
