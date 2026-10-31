/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { callOperation } from '../api/call.js'
import type { FieldMeta, FieldValues } from './fields.js'

/** What a form adjuster asks the form to change (FormAdjusterOutputV1). */
export interface FormAdjusterOutput {
  updatedFieldMetaData?: Record<string, FieldMeta>
  updatedFieldValues?: FieldValues
  updatedFieldDisplayValues?: Record<string, string>
  fieldsToClear?: string[]
  updatedSectionMetaData?: Record<string, unknown>
  isFormDisabled?: boolean
  formDisabledMessage?: string
}

/** A field's adjuster identifier, from its `materialDashboard` supplemental metadata (the v1 key). */
export function fieldAdjusterIdentifier(field: FieldMeta): string | undefined {
  const md = field.supplementalMetaData?.materialDashboard as { formAdjusterIdentifier?: string } | undefined
  return md?.formAdjusterIdentifier
}

/** Whether a table declares an on-load adjuster (`table:{name}`), from its supplemental metadata. */
export function hasTableOnLoadAdjuster(tableMeta: { supplementalMetaData?: Record<string, unknown> } | undefined): boolean {
  const md = tableMeta?.supplementalMetaData?.materialDashboard as { onLoadFormAdjuster?: unknown } | undefined
  return Boolean(md?.onLoadFormAdjuster)
}

/**
 * Runs an adjuster. A 404 ("no form adjusters") is not an error: it means no change.
 */
export async function runFormAdjuster(baseUrl: string, fetchImpl: typeof fetch, table: string, identifier: string, event: 'onLoad' | 'onChange', state: { fieldName?: string; newValue?: unknown; allValues: FieldValues }): Promise<FormAdjusterOutput | null> {
  try {
    const result = await callOperation(baseUrl, 'runFormAdjuster', { path: { tableName: table, identifier, event }, json: state }, fetchImpl)
    return (result.data ?? {}) as FormAdjusterOutput
  } catch (error) {
    if (error instanceof UiApiError && error.status === 404) return null
    throw error
  }
}

/** Applies an adjuster's output to field definitions and values; returns the new state. */
export function applyAdjustment(fields: Record<string, FieldMeta>, values: FieldValues, output: FormAdjusterOutput | null): { fields: Record<string, FieldMeta>; values: FieldValues; displayValues: Record<string, string>; disabled?: { message?: string } } {
  if (!output) return { fields, values, displayValues: {} }
  const nextFields = { ...fields }
  for (const [name, meta] of Object.entries(output.updatedFieldMetaData ?? {})) nextFields[name] = { ...fields[name], ...meta, name }
  const nextValues = { ...values, ...(output.updatedFieldValues ?? {}) }
  for (const name of output.fieldsToClear ?? []) nextValues[name] = null
  return { fields: nextFields, values: nextValues, displayValues: output.updatedFieldDisplayValues ?? {}, ...(output.isFormDisabled ? { disabled: { message: output.formDisabledMessage } } : {}) }
}
