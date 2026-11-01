/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The `dynamicForm` widget on a record form: a backend-declared field list whose values are
 * edited with the record and saved in the table field the payload names
 * (`mergedDynamicFormValuesIntoFieldName`, a JSON object) or, without one, as record fields.
 */

import type { FieldMeta } from './fields.js'

type J = Record<string, unknown>

/** The `dynamicForm` payload (DynamicFormWidgetData). */
export interface DynamicFormPayload {
  type?: string
  fieldList?: FieldMeta[]
  recordOfFieldValues?: { values?: J; displayValues?: Record<string, string> }
  noFieldsMessage?: string
  mergedDynamicFormValuesIntoFieldName?: string
}

/** The form's fields (hidden ones left out). */
export function dynamicFormFields(payload: DynamicFormPayload): FieldMeta[] {
  return (payload.fieldList ?? []).filter((f) => f && typeof f.name === 'string' && !f.isHidden).map((f) => ({ ...f, label: f.label ?? f.name, type: f.type ?? 'STRING' }))
}

/** The current values: the record's merged JSON field when the payload names one, else recordOfFieldValues. */
export function dynamicFormValues(payload: DynamicFormPayload, recordValues: J = {}): J {
  const merged = payload.mergedDynamicFormValuesIntoFieldName
  if (merged) {
    const raw = recordValues[merged]
    if (raw && typeof raw === 'object') return { ...(raw as J) }
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as J
      } catch {
        // an unreadable value starts empty
      }
    }
  }
  return { ...(payload.recordOfFieldValues?.values ?? {}) }
}

/** Required fields without a value, by label. */
export function dynamicFormMissing(payload: DynamicFormPayload, values: J): string[] {
  return dynamicFormFields(payload).filter((f) => f.isRequired && f.isEditable !== false && (values[f.name] === undefined || values[f.name] === null || values[f.name] === '')).map((f) => f.label)
}

/** What the record update sends: the merged field as JSON text (fields in declared order), else the fields themselves. */
export function dynamicFormSubmission(payload: DynamicFormPayload, values: J): J {
  const fields = dynamicFormFields(payload)
  const merged = payload.mergedDynamicFormValuesIntoFieldName
  if (merged) return { [merged]: JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? null]))) }
  return Object.fromEntries(fields.filter((f) => f.isEditable !== false).map((f) => [f.name, values[f.name] ?? null]))
}
