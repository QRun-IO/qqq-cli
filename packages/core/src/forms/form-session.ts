/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * One form being filled in: a table record (create or edit) or a process step. Holds the field
 * definitions and values, keeps contingent fields consistent (clears dependents when a dependency
 * changes, disables them while a dependency is unset), resolves possible values typed as labels,
 * runs form adjusters on load and on change, and validates before submit. Both heads drive it:
 * the CLI from flags and prompts, the TUI from key presses.
 */

import { applyAdjustment, fieldAdjusterIdentifier, hasTableOnLoadAdjuster, runFormAdjuster, type FormAdjusterOutput } from './adjuster.js'
import { applyBehaviors, dependentsOf, dependencyValues, getDependencies, isContingentlyDisabled, isMissingValue, missingDependencies, validateValues, type FieldMeta, type FieldValues, type PossibleValue } from './fields.js'
import { resolvePossibleValue, searchPossibleValues, type FormScope } from './possible-values.js'

export interface FormSessionOptions {
  baseUrl: string
  fetch: typeof fetch
  scope: FormScope
  fields: FieldMeta[]
  initialValues?: FieldValues
  /** Table forms: whether to call the `table:{name}` on-load adjuster (from table metadata). */
  tableMeta?: { supplementalMetaData?: Record<string, unknown> }
  /** Fields never offered for input (the primary key on create). */
  exclude?: string[]
}

export interface FieldState {
  field: FieldMeta
  value: unknown
  displayValue?: string
  /** Set while a dependency is missing under DISABLE_UNTIL_SET. */
  disabledBecause?: string
  error?: string
}

export interface ChangeResult {
  /** Fields whose values were cleared because this one changed. */
  cleared: string[]
  /** What an adjuster changed, if one ran. */
  adjusted?: FormAdjusterOutput | null
  disabled?: { message?: string }
}

export class FormSession {
  readonly scope: FormScope
  fields: Record<string, FieldMeta>
  order: string[]
  values: FieldValues
  displayValues: Record<string, string> = {}
  errors: Record<string, string> = {}
  disabledForm?: { message?: string }
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly tableMeta?: FormSessionOptions['tableMeta']
  private readonly exclude: Set<string>

  constructor(options: FormSessionOptions) {
    this.baseUrl = options.baseUrl
    this.fetchImpl = options.fetch
    this.scope = options.scope
    this.tableMeta = options.tableMeta
    this.exclude = new Set(options.exclude ?? [])
    this.order = options.fields.map((f) => f.name)
    this.fields = Object.fromEntries(options.fields.map((f) => [f.name, f]))
    this.values = { ...(options.initialValues ?? {}) }
    for (const f of options.fields) if (this.values[f.name] === undefined && f.defaultValue !== undefined && f.defaultValue !== null) this.values[f.name] = f.defaultValue
  }

  /** Runs the table's on-load adjuster when it declares one. */
  async load(): Promise<FormAdjusterOutput | null> {
    if (!('table' in this.scope) || !hasTableOnLoadAdjuster(this.tableMeta)) return null
    const output = await runFormAdjuster(this.baseUrl, this.fetchImpl, this.scope.table, `table:${this.scope.table}`, 'onLoad', { allValues: this.values })
    this.absorb(output)
    return output
  }

  /** The editable fields, in form order. */
  get editable(): FieldMeta[] {
    return this.order.map((n) => this.fields[n]!).filter((f) => f.isEditable !== false && !f.isHidden && !this.exclude.has(f.name))
  }

  /**
   * The order to set or ask for fields so that a dependency always comes before the fields that
   * depend on it (form order otherwise). Cycles fall back to form order.
   */
  promptOrder(names: Iterable<string> = this.editable.map((f) => f.name)): string[] {
    const wanted = [...names].filter((n) => this.fields[n])
    const out: string[] = []
    const pending = new Set(wanted)
    // dependencies are transitive: city -> state -> country orders country before city even when state is not asked
    const closure = (name: string, seen = new Set<string>()): Set<string> => {
      for (const d of getDependencies(this.fields[name] ?? { name, label: name, type: '' })) {
        if (!seen.has(d)) {
          seen.add(d)
          closure(d, seen)
        }
      }
      return seen
    }
    while (pending.size) {
      let progressed = false
      for (const n of wanted) {
        if (!pending.has(n)) continue
        const deps = [...closure(n)].filter((d) => pending.has(d))
        if (deps.length === 0) {
          out.push(n)
          pending.delete(n)
          progressed = true
        }
      }
      if (!progressed) {
        out.push(...pending)
        break
      }
    }
    return out
  }

  /** The state of one field as a UI would show it. */
  state(name: string): FieldState {
    const field = this.fields[name]!
    const missing = missingDependencies(field, this.values, this.fields)
    return {
      field,
      value: this.values[name],
      displayValue: this.displayValues[name],
      disabledBecause: isContingentlyDisabled(field, this.values) ? `set ${missing.map((m) => m.label).join(' and ')} first` : undefined,
      error: this.errors[name],
    }
  }

  /** Whether the field has choices (a possible-value source or inline enum). */
  hasChoices(name: string): boolean {
    const f = this.fields[name]
    return Boolean(f && (f.possibleValueSourceName || f.inlinePossibleValueSource?.enumValues?.length))
  }

  /** The current choices of a field, honouring its dependencies; empty while disabled. */
  async options(name: string, searchTerm = '', limit = 50): Promise<PossibleValue[]> {
    const field = this.fields[name]!
    const inline = field.inlinePossibleValueSource?.enumValues
    if (inline?.length) {
      return inline.map((e) => (typeof e === 'string' ? { id: e, label: e } : { id: e.id, label: String(e.label ?? e.id) }))
        .filter((o) => !searchTerm || o.label.toLowerCase().includes(searchTerm.toLowerCase())).slice(0, limit)
    }
    if (!field.possibleValueSourceName) return []
    if (isContingentlyDisabled(field, this.values)) return []
    return searchPossibleValues(this.baseUrl, this.fetchImpl, this.scope, name, { searchTerm, limit, ...this.context(field) })
  }

  /**
   * Sets a value from text or a typed value. For possible-value fields, text is resolved to an
   * option by id or label; an ambiguous or unknown text throws with the candidates. Dependents are
   * cleared, and the field's onChange adjuster runs when it has one.
   */
  async set(name: string, input: unknown): Promise<ChangeResult> {
    const field = this.fields[name]
    if (!field) throw new FormInputError(`No field "${name}"`)
    if (field.isEditable === false) throw new FormInputError(`${field.label} is not editable`)
    if (isContingentlyDisabled(field, this.values)) throw new FormInputError(`${field.label}: ${this.state(name).disabledBecause}`)
    let value: unknown = input
    if (typeof input === 'string') value = applyBehaviors(field, input)
    if (this.hasChoices(name) && typeof value === 'string' && !isMissingValue(value)) {
      const resolved = await this.resolveChoice(name, value)
      value = resolved.id
      this.displayValues[name] = resolved.label
    } else if (isMissingValue(value)) {
      delete this.displayValues[name]
    }
    const before = this.values[name]
    this.values[name] = isMissingValue(value) ? null : value
    delete this.errors[name]
    const cleared: string[] = []
    if (String(before ?? '') !== String(this.values[name] ?? '')) {
      for (const dependent of dependentsOf(name, Object.values(this.fields))) {
        if (!isMissingValue(this.values[dependent.name])) {
          this.values[dependent.name] = null
          delete this.displayValues[dependent.name]
          cleared.push(dependent.name)
          cleared.push(...this.clearTransitive(dependent.name))
        }
      }
    }
    let adjusted: FormAdjusterOutput | null | undefined
    const identifier = fieldAdjusterIdentifier(field)
    if (identifier && 'table' in this.scope) {
      adjusted = await runFormAdjuster(this.baseUrl, this.fetchImpl, this.scope.table, identifier, 'onChange', { fieldName: name, newValue: this.values[name], allValues: this.values })
      this.absorb(adjusted)
    }
    return { cleared, adjusted, disabled: this.disabledForm }
  }

  /** Resolves typed text to a choice. */
  async resolveChoice(name: string, typed: string): Promise<PossibleValue> {
    const field = this.fields[name]!
    const inline = field.inlinePossibleValueSource?.enumValues
    if (inline?.length) {
      const all = await this.options(name, '', 10_000)
      const hit = all.find((o) => String(o.id) === typed) ?? all.find((o) => o.label.toLowerCase() === typed.toLowerCase())
      if (!hit) throw new ChoiceError(field, typed, all)
      return hit
    }
    const { option, candidates } = await resolvePossibleValue(this.baseUrl, this.fetchImpl, this.scope, name, typed, { ...this.context(field), fieldType: field.type })
    if (!option) throw new ChoiceError(field, typed, candidates)
    return option
  }

  /** Validates the editable fields (or `only` those); records and returns problems. */
  validate(only?: Iterable<string>): Record<string, string> {
    this.errors = validateValues(this.editable, this.values, only)
    for (const f of this.editable) if (isContingentlyDisabled(f, this.values) && !isMissingValue(this.values[f.name])) this.errors[f.name] = this.state(f.name).disabledBecause!
    return this.errors
  }

  /** The values to submit: only fields that were set (null clears). */
  submission(): FieldValues {
    const out: FieldValues = {}
    for (const f of this.editable) if (this.values[f.name] !== undefined) out[f.name] = this.values[f.name]
    return out
  }

  private context(field: FieldMeta): { values?: FieldValues; processValues?: FieldValues } {
    const deps = dependencyValues(field, this.values)
    return 'table' in this.scope ? { values: deps } : { values: deps, processValues: this.values }
  }

  private clearTransitive(name: string): string[] {
    const cleared: string[] = []
    for (const dependent of dependentsOf(name, Object.values(this.fields))) {
      if (!isMissingValue(this.values[dependent.name])) {
        this.values[dependent.name] = null
        delete this.displayValues[dependent.name]
        cleared.push(dependent.name, ...this.clearTransitive(dependent.name))
      }
    }
    return cleared
  }

  private absorb(output: FormAdjusterOutput | null): void {
    const applied = applyAdjustment(this.fields, this.values, output)
    this.fields = applied.fields
    this.values = applied.values
    Object.assign(this.displayValues, applied.displayValues)
    for (const name of Object.keys(applied.fields)) if (!this.order.includes(name)) this.order.push(name)
    this.disabledForm = applied.disabled
  }
}

/** The person's input cannot be applied (unknown field, not editable, dependency unset). */
export class FormInputError extends Error {}

/** Typed text did not name one choice. */
export class ChoiceError extends FormInputError {
  constructor(readonly field: FieldMeta, readonly typed: string, readonly candidates: PossibleValue[]) {
    super(candidates.length
      ? `${field.label}: "${typed}" matches ${candidates.length} choices: ${candidates.slice(0, 8).map((c) => `${c.label} (${String(c.id)})`).join(', ')}${candidates.length > 8 ? ', …' : ''}`
      : `${field.label}: no choice named "${typed}"`)
  }
}
