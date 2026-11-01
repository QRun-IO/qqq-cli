/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The F6 filter dialog, two modes over one QueryFilter (through the kernel grammar):
 * - guided: a builder over the table's fields (field, then an operator valid for its type, then a
 *   value editor that fits: possible-value picker, date presets, list values), AND/OR, one level of
 *   groups, and the sort; the grammar text is shown live;
 * - advanced: the grammar typed directly with completion from the kernel (fields, operators,
 *   values and expressions, AND/OR/parentheses), inline parse errors and a preview.
 * Tab switches modes (guided prints the grammar; advanced parses back when it parses).
 */

import {
  FilterSyntaxError, LIST_OPERATORS, OPERATORS, UNARY_OPERATORS, applyCompletion, completeFilter, describeFilter, expressionCandidates, locateFilterError,
  operatorsForField, parseFilter, parseValue, printCriterion, printFilter, printValue, resolvePossibleValue, searchPossibleValues,
  type Completion, type CompletionResult, type Criterion, type FilterValue, type Operator, type QueryFilter,
} from '@qrun-io/qqq-core'
import type { FieldMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad, shellQuote, trunc } from '../util/text'
import { ChoiceOverlay, EditorLine, PromptOverlay, overlayId, wrap } from './basic'
import { Frame, Line } from './frame'

type Sort = { field: string; asc: boolean } | undefined

type GuidedRow =
  | { kind: 'crit'; group: number; index: number }
  | { kind: 'group'; group: number }
  | { kind: 'add'; group: number }
  | { kind: 'addGroup' }
  | { kind: 'join' }
  | { kind: 'sort' }

function clone(f: QueryFilter): QueryFilter {
  return JSON.parse(JSON.stringify(f)) as QueryFilter
}

export class FilterOverlay implements Overlay {
  readonly id = overlayId('filter')
  mode: 'guided' | 'advanced' = 'guided'
  filter: QueryFilter
  sort: Sort
  row = 0
  /** Labels of possible-value ids, for display: `${field}\u0000${id}` -> label. */
  labels = new Map<string, string>()
  readonly text = new LineEditor('')
  completion?: CompletionResult
  candidate = 0
  parseError?: { message: string; at?: number }
  historyIndex = -1
  historySearch?: LineEditor
  private valueCache = new Map<string, Completion[]>()

  constructor(private store: AppStore, readonly meta: TableMetaData, filter: QueryFilter, sort: Sort, private onApply: (filter: QueryFilter, sort: Sort | null) => void) {
    this.filter = clone({ ...filter, criteria: filter.criteria ?? [], booleanOperator: filter.booleanOperator ?? 'AND' })
    this.sort = sort
    this.collectLabels()
  }

  fields(): FieldMetaData[] {
    return Object.values(this.meta.fields).filter((f) => !f.isHidden)
  }

  field(name: string): FieldMetaData | undefined {
    return this.meta.fields[name]
  }

  /** Looks up labels for possible-value ids already in the filter. */
  collectLabels(): void {
    const all = [...this.filter.criteria, ...(this.filter.subFilters ?? []).flatMap((s) => s.criteria)]
    for (const c of all) {
      const f = this.field(c.fieldName)
      const ids = c.values.filter((v): v is string => typeof v === 'string')
      if (!f?.possibleValueSourceName || !ids.length) continue
      searchPossibleValues(this.store.client!.server, this.store.client!.fetch, { table: this.meta.name }, f.name, { ids, useCase: 'FILTER' })
        .then((opts) => { for (const o of opts) this.labels.set(`${f.name}\u0000${String(o.id)}`, o.label); this.store.bump() })
        .catch(() => undefined)
    }
  }

  // ---- guided ----

  groups(): QueryFilter[] {
    return this.filter.subFilters ?? []
  }

  rows(): GuidedRow[] {
    const out: GuidedRow[] = []
    this.filter.criteria.forEach((_, i) => out.push({ kind: 'crit', group: -1, index: i }))
    out.push({ kind: 'add', group: -1 })
    this.groups().forEach((g, gi) => {
      out.push({ kind: 'group', group: gi })
      g.criteria.forEach((_, i) => out.push({ kind: 'crit', group: gi, index: i }))
      out.push({ kind: 'add', group: gi })
    })
    out.push({ kind: 'addGroup' }, { kind: 'join' }, { kind: 'sort' })
    return out
  }

  groupOf(gi: number): QueryFilter {
    return gi < 0 ? this.filter : this.groups()[gi]!
  }

  valueText(c: Criterion): string {
    return c.values.map((v) => (typeof v === 'string' ? this.labels.get(`${c.fieldName}\u0000${v}`) ?? v : printValue(v))).join(', ')
  }

  critText(c: Criterion): string {
    const f = this.field(c.fieldName)
    const op = c.operator.toLowerCase().replace(/_/g, ' ')
    return `${f?.label ?? c.fieldName} ${op}${c.values.length ? ` ${this.valueText(c)}` : ''}`
  }

  /** Field, then operator, then value; calls back with the criterion. */
  buildCriterion(start: Partial<Criterion>, done: (c: Criterion) => void): void {
    const pickField = (next: (f: FieldMetaData) => void) => {
      if (start.fieldName && this.field(start.fieldName)) return next(this.field(start.fieldName)!)
      this.store.open(new ChoiceOverlay(this.store, 'Filter on which field?', this.fields().map((f) => ({ label: f.label, value: f, detail: `${f.name} · ${f.possibleValueSourceName ? 'choice' : f.type.toLowerCase()}` })), next))
    }
    pickField((f) => {
      const pickOp = (next: (op: Operator) => void) => {
        if (start.operator && operatorsForField(f).includes(start.operator)) return next(start.operator)
        const ops = operatorsForField(f)
        const more = OPERATORS.filter((o) => !ops.includes(o))
        const all = (pickAll: boolean) => this.store.open(new ChoiceOverlay<Operator | ''>(this.store, `${f.label}: which comparison?`, [...(pickAll ? OPERATORS : ops).map((o) => ({ label: o.toLowerCase().replace(/_/g, ' '), value: o as Operator | '', detail: o })), ...(!pickAll && more.length ? [{ label: 'More operators…', value: '' as const, detail: `${more.length} for other field types` }] : [])], (o) => (o ? next(o) : all(true))))
        all(false)
      }
      pickOp((op) => {
        if (UNARY_OPERATORS.has(op)) return done({ fieldName: f.name, operator: op, values: [] })
        this.editValues(f, op, start.values ?? [], (values) => done({ fieldName: f.name, operator: op, values }))
      })
    })
  }

  /** The value editor that fits the field and operator. */
  editValues(f: FieldMetaData, op: Operator, current: FilterValue[], done: (values: FilterValue[]) => void): void {
    const list = LIST_OPERATORS.has(op)
    const between = op === 'BETWEEN' || op === 'NOT_BETWEEN'
    if (f.possibleValueSourceName && !between) {
      const pick = (acc: FilterValue[]) => {
        const term = new LineEditor('')
        const overlay = new ChoiceOverlay<string | null>(this.store, `${f.label}${list ? ` (${acc.length} chosen; Esc when done)` : ''}`, [], (id) => {
          if (id === null) return done(acc)
          const next = list ? [...acc, id] : [id]
          if (list) pick(next)
          else done(next)
        }, 'type to search', 0, () => { if (list && acc.length) done(acc) })
        void term
        const load = (search: string) => {
          searchPossibleValues(this.store.client!.server, this.store.client!.fetch, { table: this.meta.name }, f.name, { searchTerm: search, useCase: 'FILTER', limit: 100 }).then((opts) => {
            overlay.choices.splice(0, overlay.choices.length, ...(list && acc.length ? [{ label: `Done (${acc.length} chosen)`, value: null }] : []), ...opts.map((o) => {
              this.labels.set(`${f.name}\u0000${String(o.id)}`, o.label)
              return { label: o.label, value: String(o.id), detail: String(o.id) }
            }))
            this.store.bump()
          }).catch((e) => this.store.flash(errorText(e), 'error'))
        }
        const original = overlay.onKey.bind(overlay)
        overlay.onKey = (key: Key) => {
          const before = overlay.filter.value
          original(key)
          if (overlay.filter.value !== before) load(overlay.filter.value)
        }
        // the choice list filters locally too; server search narrows big sources
        overlay.matches = () => overlay.choices
        load('')
        this.store.open(overlay)
      }
      return pick(list ? current : [])
    }
    const type = f.type.toUpperCase()
    const isDate = type === 'DATE' || type === 'DATE_TIME' || type === 'TIME'
    const prompt = (initial: string) => this.store.open(new PromptOverlay(this.store, `${f.label} ${op.toLowerCase().replace(/_/g, ' ')}`, between ? 'Two values separated by a comma: from,to. Expressions work: now(-7d), startOf(month).' : list ? 'Values separated by commas; quote values that contain commas.' : isDate ? 'A date (YYYY-MM-DD) or an expression: now(-7d), thisPeriod(month), startOf(year).' : 'The value.', (text) => {
      try {
        const c = parseFilter(`${f.name} ${op} ${text}`).criteria[0]!
        done(c.values)
      } catch (e) {
        this.store.flash(errorText(e), 'error')
      }
    }, initial))
    const initial = current.map(printValue).join(',')
    if (isDate && !list) {
      const presets = expressionCandidates(type).map((c) => ({ label: c.detail ?? c.value, value: c.value, detail: c.value }))
      this.store.open(new ChoiceOverlay(this.store, `${f.label}: when?`, [{ label: 'Type a date or an expression…', value: '', detail: 'YYYY-MM-DD' }, ...presets], (v) => (v ? done([parseValue(v)]) : prompt(initial))))
      return
    }
    prompt(initial)
  }

  editRow(r: GuidedRow): void {
    if (r.kind === 'crit') {
      const g = this.groupOf(r.group)
      const c = g.criteria[r.index]!
      const f = this.field(c.fieldName)
      this.store.open(new ChoiceOverlay(this.store, this.critText(c), [
        { label: 'Change the value', value: 'value', disabled: UNARY_OPERATORS.has(c.operator) ? 'this comparison has no value' : undefined },
        { label: 'Change the comparison', value: 'op' },
        { label: 'Change the field', value: 'field' },
        { label: 'Remove this condition', value: 'remove' },
      ], (what) => {
        if (what === 'remove') g.criteria.splice(r.index, 1)
        else if (what === 'value' && f) this.editValues(f, c.operator, c.values, (values) => { c.values = values; this.store.bump() })
        else if (what === 'op') this.buildCriterion({ fieldName: c.fieldName }, (n) => { g.criteria[r.index] = n; this.store.bump() })
        else this.buildCriterion({}, (n) => { g.criteria[r.index] = n; this.store.bump() })
      }))
    } else if (r.kind === 'add') {
      this.buildCriterion({}, (c) => { this.groupOf(r.group).criteria.push(c); this.store.bump() })
    } else if (r.kind === 'addGroup') {
      this.filter.subFilters = [...this.groups(), { criteria: [], booleanOperator: this.filter.booleanOperator === 'AND' ? 'OR' : 'AND' }]
      this.buildCriterion({}, (c) => { this.groups()[this.groups().length - 1]!.criteria.push(c); this.store.bump() })
    } else if (r.kind === 'group' || r.kind === 'join') {
      const g = r.kind === 'group' ? this.groupOf(r.group) : this.filter
      g.booleanOperator = g.booleanOperator === 'AND' ? 'OR' : 'AND'
    } else if (r.kind === 'sort') {
      this.store.open(new ChoiceOverlay(this.store, 'Sort by', [{ label: '(default order)', value: '' }, ...this.fields().map((f) => ({ label: f.label, value: f.name, detail: f.name }))], (field) => {
        if (!field) {
          this.sort = undefined
          return
        }
        this.store.open(new ChoiceOverlay(this.store, 'Direction', [{ label: 'Ascending', value: true }, { label: 'Descending', value: false }], (asc) => { this.sort = { field, asc }; this.store.bump() }))
      }))
    }
  }

  removeRow(r: GuidedRow): void {
    if (r.kind === 'crit') this.groupOf(r.group).criteria.splice(r.index, 1)
    else if (r.kind === 'group') this.filter.subFilters = this.groups().filter((_, i) => i !== r.group)
    else if (r.kind === 'sort') this.sort = undefined
  }

  /** Empty groups are dropped before printing or applying. */
  normalized(): QueryFilter {
    const f = clone(this.filter)
    f.subFilters = (f.subFilters ?? []).filter((g) => g.criteria.length || g.subFilters?.length)
    if (!f.subFilters.length) delete f.subFilters
    return f
  }

  // ---- advanced ----

  toAdvanced(): void {
    this.text.set(printFilter(this.normalized()))
    this.mode = 'advanced'
    this.complete()
  }

  toGuided(): void {
    const parsed = this.parse()
    if (!parsed) return this.store.flash('fix the filter text first (or Ctrl+U clears it)', 'error')
    this.filter = parsed
    this.collectLabels()
    this.mode = 'guided'
    this.row = 0
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
      this.parseError = { message: e instanceof Error ? e.message : String(e), at: locateFilterError(text, e) }
      return undefined
    }
  }

  complete(): void {
    const fields = this.fields().map((f) => ({ name: f.name, label: f.label, type: f.type, possibleValueSourceName: f.possibleValueSourceName, allowedFilterOperators: f.allowedFilterOperators as string[] | undefined }))
    this.completion = completeFilter(this.text.value, this.text.cursor, fields, {
      values: (f, prefix) => {
        const key = `${f.name}\u0000${prefix.toLowerCase()}`
        if (!this.valueCache.has(key)) {
          this.valueCache.set(key, [])
          searchPossibleValues(this.store.client!.server, this.store.client!.fetch, { table: this.meta.name }, f.name, { searchTerm: prefix, useCase: 'FILTER', limit: 20 }).then((opts) => {
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

  apply(): void {
    if (this.mode === 'advanced') {
      const parsed = this.parse()
      if (!parsed) return
      this.store.filterHistory.add(this.text.value)
      this.store.run(this.resolveLabels(parsed), (resolved) => {
        this.store.closeOverlay(this)
        this.onApply(resolved, this.sort ?? null)
      })
      return
    }
    const f = this.normalized()
    if (printFilter(f)) this.store.filterHistory.add(printFilter(f))
    this.store.closeOverlay(this)
    this.onApply(f, this.sort ?? null)
  }

  onKey(key: Key): void {
    if (key.name === 'escape') {
      if (this.historySearch) {
        this.historySearch = undefined
        return
      }
      return this.store.closeOverlay(this)
    }
    if (key.ctrl && key.name === 's') return this.apply()
    if (this.mode === 'guided') return this.guidedKey(key)
    return this.advancedKey(key)
  }

  guidedKey(key: Key): void {
    const rows = this.rows()
    const r = rows[this.row]
    const ch = charOf(key)
    if (key.name === 'tab') return this.toAdvanced()
    if (key.name === 'down') this.row = Math.min(rows.length - 1, this.row + 1)
    else if (key.name === 'up') this.row = Math.max(0, this.row - 1)
    else if (key.name === 'home') this.row = 0
    else if (key.name === 'end') this.row = rows.length - 1
    else if (key.name === 'return') {
      if (r && (r.kind === 'add' || r.kind === 'addGroup' || r.kind === 'sort' || r.kind === 'join' || r.kind === 'group')) this.editRow(r)
      else this.apply()
    } else if (ch === 'e' || key.name === 'right' || key.name === 'space') {
      if (r) this.editRow(r)
    } else if (ch === 'a' || key.name === 'insert') this.editRow({ kind: 'add', group: r && 'group' in r ? r.group : -1 })
    else if (ch === 'd' || key.name === 'delete' || key.name === 'backspace') {
      if (r) this.removeRow(r)
      this.row = Math.min(this.row, this.rows().length - 1)
    } else if (ch === 'o') {
      const g = r && 'group' in r && r.group >= 0 ? this.groupOf(r.group) : this.filter
      g.booleanOperator = g.booleanOperator === 'AND' ? 'OR' : 'AND'
    } else if (ch === 'g') this.editRow({ kind: 'addGroup' })
    else if (ch === 's') this.editRow({ kind: 'sort' })
    else if (ch === 'c' || (key.ctrl && key.name === 'u')) {
      this.filter = { criteria: [], booleanOperator: 'AND' }
      this.row = 0
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
    if (this.text.handle(key)) this.complete()
  }

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    const width = Math.min(sw - 2, 110)
    const inner = width - 2
    const height = Math.min(sh - 2, 30)
    const lines: React.ReactNode[] = []
    const tabs = <text flexShrink={0} wrapMode="none" key="tabs"><span fg={this.mode === 'guided' ? t.selFg : t.fg} bg={this.mode === 'guided' ? t.selBg : undefined}>{' Guided '}</span><span fg={t.dim}>{' │ '}</span><span fg={this.mode === 'advanced' ? t.selFg : t.fg} bg={this.mode === 'advanced' ? t.selBg : undefined}>{' Advanced '}</span><span fg={t.dim}>{pad('   Tab switches', inner - 23)}</span></text>
    lines.push(tabs)
    lines.push(<Line key="sp" text="" width={inner} />)
    let grammar = ''
    let cli = ''
    if (this.mode === 'guided') {
      const rows = this.rows()
      const body = height - 9
      const top = Math.max(0, Math.min(this.row - Math.floor(body / 2), rows.length - body))
      rows.slice(top, top + body).forEach((r, i) => {
        const sel = top + i === this.row
        let text = ''
        let fg = t.fg
        if (r.kind === 'crit') {
          const c = this.groupOf(r.group).criteria[r.index]!
          const join = r.index > 0 ? this.groupOf(r.group).booleanOperator.padEnd(4) : '    '
          text = `${r.group >= 0 ? '    ' : ''}${join}${this.critText(c)}`
        } else if (r.kind === 'add') {
          text = `${r.group >= 0 ? '    ' : ''}    + add a condition${r.group >= 0 ? ' to this group' : ''}`
          fg = t.acc
        } else if (r.kind === 'group') {
          text = `${r.group > 0 || this.filter.criteria.length ? this.filter.booleanOperator.padEnd(4) : '    '}( group, joined by ${this.groupOf(r.group).booleanOperator} )   d removes the group`
          fg = t.acc2
        } else if (r.kind === 'addGroup') {
          text = '    + add a group (conditions in parentheses)'
          fg = t.acc
        } else if (r.kind === 'join') {
          text = `    conditions are joined by ${this.filter.booleanOperator}   (Enter or o switches to ${this.filter.booleanOperator === 'AND' ? 'OR' : 'AND'})`
          fg = t.dim
        } else {
          text = `    sort: ${this.sort ? `${this.field(this.sort.field)?.label ?? this.sort.field} ${this.sort.asc ? 'ascending' : 'descending'}` : 'default order'}`
          fg = t.dim
        }
        lines.push(<text flexShrink={0} wrapMode="none" key={`r${i}`} fg={sel ? t.selFg : fg} bg={sel ? t.selBg : undefined}>{pad(`${sel ? g.pointer : ' '}${text}`, inner)}</text>)
      })
      for (let i = lines.length; i < body + 2; i++) lines.push(<Line key={`p${i}`} text="" width={inner} />)
      grammar = printFilter(this.normalized())
      lines.push(<Line key="help" text=" a add · e edit · d remove · o AND/OR · g group · s sort · c clear · Enter applies · Esc cancels" width={inner} fg={t.dim} />)
    } else {
      lines.push(<box key="ed" paddingLeft={1}><EditorLine editor={this.text} width={inner - 2} placeholder="lastName STARTS_WITH S AND (birthDate > now(-40y) OR email IS_BLANK)" /></box>)
      if (this.historySearch) lines.push(<text flexShrink={0} wrapMode="none" key="hs" fg={t.acc2}>{pad(` history search: ${this.historySearch.value}_  → ${this.store.filterHistory.search(this.historySearch.value)[0] ?? '(no match)'}`, inner)}</text>)
      else if (this.parseError) {
        const at = this.parseError.at
        lines.push(<text flexShrink={0} wrapMode="none" key="caret" fg={t.err}>{pad(at !== undefined ? ' ' + ' '.repeat(at) + '^' : '', inner)}</text>)
      } else lines.push(<Line key="caret" text="" width={inner} />)
      const cands = this.completion?.candidates ?? []
      const body = height - 11
      const ctop = Math.max(0, Math.min(this.candidate - Math.floor(body / 2), cands.length - body))
      lines.push(<Line key="ex" text={` expecting ${this.completion?.expecting ?? 'field'}${this.completion?.field ? ` (${this.completion.field})` : ''} · Tab accepts · ↑↓ choose`} width={inner} fg={t.dim} />)
      cands.slice(ctop, ctop + body).forEach((c, i) => {
        const sel = ctop + i === this.candidate
        lines.push(<text flexShrink={0} wrapMode="none" key={`c${i}`} fg={sel ? t.selFg : c.kind === 'keyword' ? t.acc2 : t.fg} bg={sel ? t.selBg : undefined}>{pad(`  ${pad(c.label, 28)} ${c.detail ?? ''}`, inner)}</text>)
      })
      for (let i = Math.min(body, cands.length - ctop); i < body; i++) lines.push(<Line key={`q${i}`} text="" width={inner} />)
      const parsed = this.parseError ? undefined : this.parse()
      grammar = this.text.value.trim()
      lines.push(<text flexShrink={0} wrapMode="none" key="pv" fg={this.parseError ? t.err : t.ok}>{pad(this.parseError ? ` ${trunc(this.parseError.message, inner - 2)}` : ` ${parsed ? describeFilter(parsed) : ''}`, inner)}</text>)
      lines.push(<Line key="help" text=" Enter applies · Shift+Tab or Ctrl+G guided · Ctrl+R history · ↑↓ history when empty · Esc cancels" width={inner} fg={t.dim} />)
    }
    cli = `qqq table query ${this.meta.name}${grammar ? ` -g ${shellQuote(grammar)}` : ''}${this.sort ? ` -o ${this.sort.asc ? '' : '-'}${this.sort.field}` : ''}`
    lines.push(<text flexShrink={0} wrapMode="none" key="gram" fg={t.acc}>{pad(` ${trunc(grammar || '(no criteria: every record)', inner - 2)}`, inner)}</text>)
    lines.push(<text flexShrink={0} wrapMode="none" key="cli" fg={t.dim}>{pad(` ${trunc(cli, inner - 2)}`, inner)}</text>)
    return <Frame title={`Filter ${this.meta.label}`} width={width} height={lines.length + 2} screenWidth={sw} screenHeight={sh} top={1}>{lines}</Frame>
  }
}

export { printCriterion, wrap, FilterSyntaxError }
