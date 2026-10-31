/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The process step engine: init, then each frontend step until the process completes, polling
 * asynchronous jobs. Input for a step comes from a provider callback, so the CLI can answer from
 * flags or prompts and the TUI from a form, both through a FormSession per step.
 */

import { callOperation } from '../api/call.js'
import type { FieldMeta, FieldValues } from '../forms/fields.js'

export interface ProcessStep {
  name: string
  label?: string
  components?: Array<{ type: string; values?: Record<string, unknown> }>
  formFields?: FieldMeta[]
  viewFields?: FieldMeta[]
  recordListFields?: FieldMeta[]
  [key: string]: unknown
}

export interface ProcessMeta {
  name: string
  label?: string
  tableName?: string
  frontendSteps?: ProcessStep[]
  minInputRecords?: number
  maxInputRecords?: number
  [key: string]: unknown
}

export type StepResponse =
  | { type: 'COMPLETE'; processUUID: string; nextStep?: string; backStep?: string; values?: FieldValues; processMetaDataAdjustment?: { updatedFrontendStepList?: ProcessStep[]; updatedFields?: Record<string, FieldMeta> } }
  | { type: 'JOB_STARTED'; processUUID: string; jobUUID: string }
  | { type: 'RUNNING'; processUUID: string; message?: string; current?: number; total?: number; logTail?: unknown }
  | { type: 'ERROR'; processUUID: string; error?: string; userFacingError?: string }

export interface RunnerOptions {
  baseUrl: string
  fetch: typeof fetch
  meta: ProcessMeta
  /** Values known up front (flags, a saved profile). */
  values?: FieldValues
  records?: { ids: string[] } | { filter: unknown }
  /** Files for BLOB fields, by field name: sent as multipart parts with the first step that asks for the field. */
  files?: Record<string, { name: string; bytes: Uint8Array; type?: string }>
  tableVariant?: string
  /** How long the server may run a step before backgrounding it (0: always background). */
  stepTimeoutMillis?: number
  pollMillis?: number
  /**
   * Asked before each step is submitted. Receives the step, its fields and the values so far
   * (server values from the previous step merged with the known ones); returns the values to
   * send, or throws to stop. Called for every step that has input fields.
   */
  provide?: (context: { step: ProcessStep; fields: FieldMeta[]; values: FieldValues; missing: FieldMeta[]; response: StepResponse & { type: 'COMPLETE' } }) => Promise<FieldValues>
  /** Call the provider for every step with fields, not only when required fields are missing. */
  always?: boolean
  onProgress?: (event: { step?: string; message?: string; current?: number; total?: number; phase: 'init' | 'step' | 'running' | 'complete' }) => void
}

export class ProcessError extends Error {
  constructor(message: string, readonly processUUID?: string) {
    super(message)
  }
}

export interface RunOutcome {
  response: StepResponse & { type: 'COMPLETE' }
  values: FieldValues
  processUUID: string
  steps: ProcessStep[]
  /** The step whose screen the server would show last (results). */
  lastStep?: ProcessStep
}

/** Runs a process to completion. */
export async function runProcess(options: RunnerOptions): Promise<RunOutcome> {
  const { baseUrl, fetch: fetchImpl, meta } = options
  let steps = [...(meta.frontendSteps ?? [])]
  const known: FieldValues = { ...(options.values ?? {}) }
  const poll = options.pollMillis ?? 500
  const timeout = String(options.stepTimeoutMillis ?? 0)

  const pendingFiles = { ...(options.files ?? {}) }
  const form = (values: FieldValues, extra: Record<string, string> = {}, fileFields: string[] = []): Record<string, string | Blob> => {
    const out: Record<string, string | Blob> = { values: JSON.stringify(values), stepTimeoutMillis: timeout, ...extra }
    for (const name of fileFields) {
      const file = pendingFiles[name]
      if (file) {
        out[name] = new File([file.bytes as BlobPart], file.name, file.type ? { type: file.type } : undefined)
        delete pendingFiles[name]
      }
    }
    return out
  }
  const records: Record<string, string> = options.records && 'ids' in options.records ? { recordsParam: 'recordIds', recordIds: options.records.ids.join(',') }
    : options.records && 'filter' in options.records ? { recordsParam: 'filterJSON', filterJSON: JSON.stringify(options.records.filter) } : {}
  const query = options.tableVariant ? { tableVariant: options.tableVariant } : undefined

  options.onProgress?.({ phase: 'init' })
  let response = (await callOperation(baseUrl, 'initProcess', { path: { processName: meta.name }, query, form: form(known, records) }, fetchImpl)).data as StepResponse
  response = await settle(response)
  if (response.type !== 'COMPLETE') throw new ProcessError(`unexpected ${response.type} after init`, response.processUUID)
  const processUUID = response.processUUID

  for (let guard = 0; guard < 200; guard++) {
    if (response.processMetaDataAdjustment?.updatedFrontendStepList) steps = response.processMetaDataAdjustment.updatedFrontendStepList
    const next = response.nextStep
    if (!next) break
    const step = steps.find((s) => s.name === next) ?? { name: next }
    const isLast = steps.length > 0 && steps[steps.length - 1]!.name === next
    options.onProgress?.({ phase: 'step', step: next })
    if (isLast && !hasInputs(step)) return { response, values: { ...response.values, ...known }, processUUID, steps, lastStep: step }
    const fields = inputFields(step, response)
    const current: FieldValues = { ...(response.values ?? {}), ...known }
    const missing = fields.filter((f) => f.isRequired && isUnset(current[f.name]) && !(f.type === 'BLOB' && pendingFiles[f.name]))
    let values: FieldValues = { ...known }
    if (options.provide && (options.always || missing.length || fields.length)) {
      values = { ...values, ...(await options.provide({ step, fields, values: current, missing, response })) }
      Object.assign(known, values)
    } else if (missing.length) {
      throw new ProcessError(`step "${step.label ?? step.name}" needs ${missing.map((f) => f.name).join(', ')}`, processUUID)
    }
    if (isLast) return { response, values: { ...response.values, ...known }, processUUID, steps, lastStep: step }
    const fileFields = fields.filter((f) => f.type === 'BLOB' && pendingFiles[f.name]).map((f) => f.name)
    for (const name of fileFields) delete values[name]
    response = (await callOperation(baseUrl, 'stepProcess', { path: { processName: meta.name, processUUID, stepName: next }, query, form: form(values, {}, fileFields) }, fetchImpl)).data as StepResponse
    response = await settle(response)
    if (response.type !== 'COMPLETE') throw new ProcessError(`unexpected ${response.type} after step ${next}`, processUUID)
  }
  options.onProgress?.({ phase: 'complete' })
  return { response, values: { ...response.values, ...known }, processUUID, steps }

  /** Polls JOB_STARTED / RUNNING until the step completes or fails. */
  async function settle(first: StepResponse): Promise<StepResponse> {
    let current = first
    let jobUUID: string | undefined
    while (current.type === 'JOB_STARTED' || current.type === 'RUNNING') {
      if (current.type === 'JOB_STARTED') jobUUID = current.jobUUID
      else options.onProgress?.({ phase: 'running', message: current.message, current: current.current, total: current.total })
      await new Promise((resolve) => setTimeout(resolve, poll))
      current = (await callOperation(baseUrl, 'getProcessStatus', { path: { processName: meta.name, processUUID: current.processUUID, jobUUID: jobUUID! }, query }, fetchImpl)).data as StepResponse
    }
    if (current.type === 'ERROR') throw new ProcessError(current.userFacingError ?? current.error ?? 'the process failed', current.processUUID)
    return current
  }
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** Whether a step asks for anything (an edit form, a validation review, a file upload, a picker). */
export function hasInputs(step: ProcessStep): boolean {
  const types = (step.components ?? []).map((c) => c.type)
  return (step.formFields?.length ?? 0) > 0 || types.some((t) => ['EDIT_FORM', 'BULK_EDIT_FORM', 'VALIDATION_REVIEW_SCREEN', 'GOOGLE_DRIVE_SELECT_FOLDER', 'BULK_LOAD_FILE_MAPPING_FORM', 'BULK_LOAD_VALUE_MAPPING_FORM', 'BULK_LOAD_PROFILE_FORM'].includes(t))
}

/** The fields a step's form asks for, applying any field adjustments the previous step returned. */
export function inputFields(step: ProcessStep, response: StepResponse & { type: 'COMPLETE' }): FieldMeta[] {
  const adjusted = response.processMetaDataAdjustment?.updatedFields ?? {}
  const base = step.formFields ?? []
  const names = new Set<string>()
  for (const c of step.components ?? []) for (const n of ((c.values?.includeFieldNames as string[] | undefined) ?? [])) names.add(n)
  const fields = base.map((f) => ({ ...f, ...(adjusted[f.name] ?? {}) }))
  if (names.size === 0) return fields.filter((f) => f.isEditable !== false)
  return fields.filter((f) => names.has(f.name) && f.isEditable !== false)
}
