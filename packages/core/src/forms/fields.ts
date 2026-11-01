/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { findReferences } from '../render/text.js'

/** Field metadata as both heads consume it (a structural subset of FieldMetaData). */
export interface FieldMeta {
  name: string
  label: string
  type: string
  isRequired?: boolean
  isEditable?: boolean | null
  isHidden?: boolean
  isHeavy?: boolean
  defaultValue?: string
  displayFormat?: string
  possibleValueSourceName?: string | null
  possibleValueSourceDependsOn?: string[]
  possibleValueSourceDependencyBehavior?: 'DISABLE_UNTIL_SET' | 'SHOW_ALL_UNTIL_SET' | string
  possibleValueSourceFilter?: unknown
  inlinePossibleValueSource?: { enumValues?: Array<{ id?: unknown; label?: string } | string> } | null
  validation?: FieldValidation
  behaviors?: string[]
  supplementalMetaData?: Record<string, unknown>
  adornments?: Array<{ type: string; values?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The server's validation rules (FieldValidationV1). */
export interface FieldValidation {
  required?: boolean
  maxLength?: number
  tooLongBehavior?: string
  minValue?: string
  maxValue?: string
  minInclusive?: boolean | null
  maxInclusive?: boolean | null
  pattern?: string
  patternMessage?: string
  [key: string]: unknown
}

/** A possible-value option. */
export interface PossibleValue {
  id: unknown
  label: string
}

export type FieldValues = Record<string, unknown>

/** Whether a value counts as unset; zero and false are values. */
export function isMissingValue(value: unknown): boolean {
  return value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0)
}

/** The fields controlling a contingent field's choices: explicit, else discovered from `${input.x}` references in its filter. */
export function getDependencies(field: FieldMeta): string[] {
  if (field.possibleValueSourceDependsOn !== undefined) return [...new Set(field.possibleValueSourceDependsOn)]
  const names = new Set<string>()
  const scanValue = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const name of findReferences(value, 'input.')) names.add(name)
    } else if (Array.isArray(value)) value.forEach(scanValue)
    else if (value && typeof value === 'object') Object.values(value).forEach(scanValue)
  }
  const scanFilter = (filter: { criteria?: Array<{ values?: unknown }>; subFilters?: unknown[] }): void => {
    for (const criterion of filter.criteria ?? []) scanValue(criterion.values)
    for (const sub of filter.subFilters ?? []) scanFilter(sub as never)
  }
  if (field.possibleValueSourceFilter) scanFilter(field.possibleValueSourceFilter as never)
  return [...names]
}

/** The policy while dependencies are unset; unknown values default to the safe one. */
export function dependencyBehavior(field: FieldMeta): 'DISABLE_UNTIL_SET' | 'SHOW_ALL_UNTIL_SET' {
  return field.possibleValueSourceDependencyBehavior === 'SHOW_ALL_UNTIL_SET' ? 'SHOW_ALL_UNTIL_SET' : 'DISABLE_UNTIL_SET'
}

/** Dependencies of a field that have no value yet, with labels. */
export function missingDependencies(field: FieldMeta, values: FieldValues, fieldsByName: Record<string, FieldMeta> = {}): Array<{ name: string; label: string }> {
  return getDependencies(field).filter((name) => isMissingValue(values[name])).map((name) => ({ name, label: fieldsByName[name]?.label ?? name }))
}

/** Only the values that can change a contingent field's choices. */
export function dependencyValues(field: FieldMeta, values: FieldValues): FieldValues {
  return Object.fromEntries(getDependencies(field).map((name) => [name, values[name]]))
}

/** Whether a contingent field is disabled right now (DISABLE_UNTIL_SET with a missing dependency). */
export function isContingentlyDisabled(field: FieldMeta, values: FieldValues): boolean {
  return dependencyBehavior(field) === 'DISABLE_UNTIL_SET' && missingDependencies(field, values).length > 0
}

/** The fields whose choices depend on `name`: they are cleared when `name` changes. */
export function dependentsOf(name: string, fields: Iterable<FieldMeta>): FieldMeta[] {
  return [...fields].filter((f) => getDependencies(f).includes(name))
}

/** Applies the field's editing behaviors (TRIM, TO_UPPER_CASE, TO_LOWER_CASE) to text. */
export function applyBehaviors(field: FieldMeta, value: string): string {
  let out = value
  for (const behavior of field.behaviors ?? []) {
    if (behavior === 'TRIM') out = out.trim()
    else if (behavior === 'TO_UPPER_CASE') out = out.toUpperCase()
    else if (behavior === 'TO_LOWER_CASE') out = out.toLowerCase()
  }
  return out
}

/**
 * Validates one value against the field's type and server rules, the way the server will on
 * insert and update, so a client can refuse before a round trip. Returns the problem, or undefined.
 */
export function validateValue(field: FieldMeta, raw: unknown): string | undefined {
  const rules = field.validation ?? {}
  const required = rules.required ?? field.isRequired ?? false
  if (isMissingValue(raw)) return required ? 'is required' : undefined
  const text = typeof raw === 'string' ? raw : String(raw)
  switch (field.type) {
    case 'INTEGER':
    case 'LONG':
      if (!/^-?\d+$/.test(text)) return 'must be a whole number'
      break
    case 'DECIMAL':
      if (!/^-?\d+(\.\d+)?$/.test(text)) return 'must be a number'
      break
    case 'BOOLEAN':
      if (typeof raw !== 'boolean' && !/^(true|false|yes|no|1|0)$/i.test(text)) return 'must be true or false'
      break
    case 'DATE':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) return 'must be a date, YYYY-MM-DD'
      break
    case 'DATE_TIME':
      if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(text) || Number.isNaN(Date.parse(text.replace(' ', 'T')))) return 'must be a date and time, YYYY-MM-DDTHH:MM (local time) or an ISO instant'
      break
    case 'TIME':
      if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(text)) return 'must be a time, HH:MM'
      break
    default:
      break
  }
  if (rules.maxLength !== undefined && text.length > rules.maxLength && (rules.tooLongBehavior ?? 'ERROR') === 'ERROR') return `must be at most ${rules.maxLength} characters`
  if (field.type === 'INTEGER' || field.type === 'LONG' || field.type === 'DECIMAL') {
    const n = Number(text)
    if (rules.minValue !== undefined) {
      const min = Number(rules.minValue)
      if ((rules.minInclusive ?? true) ? n < min : n <= min) return `must be ${(rules.minInclusive ?? true) ? 'at least' : 'more than'} ${rules.minValue}`
    }
    if (rules.maxValue !== undefined) {
      const max = Number(rules.maxValue)
      if ((rules.maxInclusive ?? true) ? n > max : n >= max) return `must be ${(rules.maxInclusive ?? true) ? 'at most' : 'less than'} ${rules.maxValue}`
    }
  }
  if (rules.pattern) {
    let re: RegExp | undefined
    try {
      re = new RegExp(`^(?:${rules.pattern})$`)
    } catch {
      re = undefined
    }
    if (re && !re.test(text)) return rules.patternMessage ?? `must match ${rules.pattern}`
  }
  return undefined
}

/** Validates every field present in `fields`; returns problems by field name. */
export function validateValues(fields: Iterable<FieldMeta>, values: FieldValues, only?: Iterable<string>): Record<string, string> {
  const names = only ? new Set(only) : undefined
  const problems: Record<string, string> = {}
  for (const field of fields) {
    if (names && !names.has(field.name)) continue
    if (field.isEditable === false || field.isHidden) continue
    const problem = validateValue(field, values[field.name])
    if (problem) problems[field.name] = problem
  }
  return problems
}
