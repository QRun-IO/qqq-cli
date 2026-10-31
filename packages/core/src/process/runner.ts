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
import { buildScreen, type ScreenBlock, type ScreenOptions, type ScreenStep } from './screen.js'

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
   * Asked before each step with input (an edit form, a validation review, an upload) is
   * submitted. Receives the step, its fields, the values so far (server values from the previous
   * step merged with the known ones) and the screen; returns the values to send, or {@link BACK}
   * to restart at the step's back step (offered when `backStep` is set), or throws to stop.
   */
  provide?: (context: { step: ProcessStep; fields: FieldMeta[]; values: FieldValues; missing: FieldMeta[]; response: StepResponse & { type: 'COMPLETE' }; screen: ScreenBlock[]; backStep?: string }) => Promise<FieldValues | typeof BACK>
  /** Call the provider for every step with fields, not only when required fields are missing. */
  always?: boolean
  /**
   * Shown each screen before its input is asked for (and the last screen, the results): the
   * step's components as {@link ScreenBlock}s. Without it, screens are not built (no extra calls) and the provider gets an empty screen.
   */
  present?: (context: { step: ProcessStep; screen: ScreenBlock[]; values: FieldValues; isLast: boolean; processUUID: string }) => void | Promise<void>
  /** Options for building screens (record limits, value formatting). */
  screen?: Pick<ScreenOptions, 'recordLimit' | 'previewLimit' | 'pageSize' | 'format'>
  /** Aborting stops the run and asks the server to cancel it (POST …/cancel); the run then throws {@link ProcessCancelledError}. */
  signal?: AbortSignal
  onProgress?: (event: { step?: string; message?: string; current?: number; total?: number; phase: 'init' | 'step' | 'running' | 'complete' | 'back' | 'cancel' }) => void
}

/** Returned by a provider to go back to the step's back step. */
export const BACK: unique symbol = Symbol('qqq.process.back')

export class ProcessError extends Error {
  constructor(message: string, readonly processUUID?: string) {
    super(message)
  }
}

/** The run was cancelled (the signal aborted); `cancelled` says whether the server accepted the cancel. */
export class ProcessCancelledError extends ProcessError {
  constructor(processUUID: string | undefined, readonly cancelled: boolean, readonly cancelError?: string) {
    super(processUUID ? (cancelled ? 'cancelled (the server accepted POST …/cancel, which runs the process cancel step when it declares one)' : `stopped; the server did not accept the cancel${cancelError ? ` (${cancelError})` : ''}`) : 'cancelled before the process started', processUUID)
  }
}

export interface RunOutcome {
  response: StepResponse & { type: 'COMPLETE' }
  values: FieldValues
  processUUID: string
  steps: ProcessStep[]
  /** The step whose screen the server would show last (results). */
  lastStep?: ProcessStep
  /** The last step's screen, when `present` was given. */
  lastScreen?: ScreenBlock[]
}

/**
 * Checks the input record count against the process's minInputRecords and maxInputRecords before
 * init. `count` resolves the number of records a filter selects (a table count); without it, a
 * filter passes. Throws a ProcessError naming the limit.
 */
export async function checkInputRecords(meta: ProcessMeta, records: RunnerOptions['records'], count?: (filter: unknown) => Promise<number>): Promise<number | undefined> {
  const min = typeof meta.minInputRecords === 'number' ? meta.minInputRecords : undefined
  const max = typeof meta.maxInputRecords === 'number' ? meta.maxInputRecords : undefined
  if (min === undefined && max === undefined) return undefined
  let n: number | undefined
  if (!records) n = 0
  else if ('ids' in records) n = records.ids.filter(Boolean).length
  else if (count) n = await count(records.filter)
  if (n === undefined) return undefined
  const label = meta.label ?? meta.name
  if (min !== undefined && n < min) throw new ProcessError(`${label} needs at least ${min} record${min === 1 ? '' : 's'}; ${n === 0 ? 'none were given (-r ids or --filter-json)' : `${n} given`}`)
  if (max !== undefined && n > max) throw new ProcessError(`${label} runs on at most ${max} record${max === 1 ? '' : 's'}; ${n} given`)
  return n
}

/** Runs a process to completion. */
export async function runProcess(options: RunnerOptions): Promise<RunOutcome> {
  const { baseUrl, fetch: fetchImpl, meta, signal } = options
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
  let processUUID: string | undefined

  const checkAbort = (): void => {
    if (signal?.aborted) throw new AbortedSignal()
  }
  const screenOf = async (step: ProcessStep, values: FieldValues): Promise<ScreenBlock[]> => {
    if (!options.present) return []
    return buildScreen({ baseUrl, fetch: fetchImpl, processName: meta.name, processUUID: processUUID!, step: step as ScreenStep, values, tableVariant: options.tableVariant, ...(options.screen ?? {}) })
  }

  try {
    checkAbort()
    options.onProgress?.({ phase: 'init' })
    let response = (await callOperation(baseUrl, 'initProcess', { path: { processName: meta.name }, query, form: form(known, records) }, fetchImpl)).data as StepResponse
    processUUID = response.processUUID
    response = await settle(response)
    if (response.type !== 'COMPLETE') throw new ProcessError(`unexpected ${response.type} after init`, response.processUUID)

    for (let guard = 0; guard < 200; guard++) {
      checkAbort()
      if (response.processMetaDataAdjustment?.updatedFrontendStepList) steps = response.processMetaDataAdjustment.updatedFrontendStepList
      const next = response.nextStep
      if (!next) break
      const step = steps.find((s) => s.name === next) ?? { name: next }
      const isLast = steps.length > 0 && steps[steps.length - 1]!.name === next
      options.onProgress?.({ phase: 'step', step: next })
      const current: FieldValues = { ...(response.values ?? {}), ...known }
      const lastInputless = isLast && !hasInputs(step)
      const screen = await screenOf(step, current)
      await options.present?.({ step, screen, values: current, isLast: lastInputless, processUUID: processUUID! })
      if (lastInputless) return { response, values: current, processUUID: processUUID!, steps, lastStep: step, lastScreen: options.present ? screen : undefined }
      const fields = inputFields(step, response)
      const missing = fields.filter((f) => f.isRequired && isUnset(current[f.name]) && !(f.type === 'BLOB' && pendingFiles[f.name]))
      let values: FieldValues = { ...known }
      if (options.provide && (options.always || missing.length || fields.length || hasInputs(step))) {
        const provided = await options.provide({ step, fields, values: current, missing, response, screen, backStep: response.backStep })
        checkAbort()
        if (provided === BACK) {
          if (!response.backStep) throw new ProcessError(`step "${step.label ?? step.name}" has no back step`, processUUID)
          options.onProgress?.({ phase: 'back', step: response.backStep })
          // restart at the back step with the values entered so far (isStepBack=true)
          response = (await callOperation(baseUrl, 'stepProcess', { path: { processName: meta.name, processUUID: processUUID!, stepName: response.backStep }, query: { ...(query ?? {}), isStepBack: 'true' }, form: form(known) }, fetchImpl)).data as StepResponse
          response = await settle(response)
          if (response.type !== 'COMPLETE') throw new ProcessError(`unexpected ${response.type} after going back`, processUUID)
          continue
        }
        values = { ...values, ...provided }
        Object.assign(known, values)
      } else if (missing.length) {
        throw new ProcessError(`step "${step.label ?? step.name}" needs ${missing.map((f) => f.name).join(', ')}`, processUUID)
      }
      if (isLast) return { response, values: { ...response.values, ...known }, processUUID: processUUID!, steps, lastStep: step, lastScreen: options.present ? screen : undefined }
      const fileFields = fields.filter((f) => f.type === 'BLOB' && pendingFiles[f.name]).map((f) => f.name)
      for (const name of fileFields) delete values[name]
      response = (await callOperation(baseUrl, 'stepProcess', { path: { processName: meta.name, processUUID: processUUID!, stepName: next }, query, form: form(values, {}, fileFields) }, fetchImpl)).data as StepResponse
      response = await settle(response)
      if (response.type !== 'COMPLETE') throw new ProcessError(`unexpected ${response.type} after step ${next}`, processUUID)
    }
    options.onProgress?.({ phase: 'complete' })
    return { response, values: { ...response.values, ...known }, processUUID: processUUID!, steps }
  } catch (error) {
    if (signal?.aborted) throw await cancel()
    throw error
  }

  /** Asks the server to cancel the run (it runs the process's cancel step) and builds the error. */
  async function cancel(): Promise<ProcessCancelledError> {
    if (!processUUID) return new ProcessCancelledError(undefined, false)
    options.onProgress?.({ phase: 'cancel' })
    try {
      await callOperation(baseUrl, 'cancelProcess', { path: { processName: meta.name, processUUID }, query }, fetchImpl)
      return new ProcessCancelledError(processUUID, true)
    } catch (error) {
      return new ProcessCancelledError(processUUID, false, error instanceof Error ? error.message : String(error))
    }
  }

  /** Polls JOB_STARTED / RUNNING until the step completes or fails. */
  async function settle(first: StepResponse): Promise<StepResponse> {
    let current = first
    let jobUUID: string | undefined
    while (current.type === 'JOB_STARTED' || current.type === 'RUNNING') {
      if (current.type === 'JOB_STARTED') jobUUID = current.jobUUID
      else options.onProgress?.({ phase: 'running', message: current.message, current: current.current, total: current.total })
      await sleep(poll, signal)
      checkAbort()
      current = (await callOperation(baseUrl, 'getProcessStatus', { path: { processName: meta.name, processUUID: current.processUUID, jobUUID: jobUUID! }, query }, fetchImpl)).data as StepResponse
    }
    if (current.type === 'ERROR') throw new ProcessError(current.userFacingError ?? current.error ?? 'the process failed', current.processUUID)
    return current
  }
}

class AbortedSignal extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** Components that take input: their step's form fields are asked for. */
export const INPUT_COMPONENTS = ['EDIT_FORM', 'BULK_EDIT_FORM', 'VALIDATION_REVIEW_SCREEN', 'GOOGLE_DRIVE_SELECT_FOLDER', 'BULK_LOAD_FILE_MAPPING_FORM', 'BULK_LOAD_VALUE_MAPPING_FORM', 'BULK_LOAD_PROFILE_FORM']

/**
 * Whether a step asks for anything (an edit form, a validation review, a file upload, a picker).
 * A step that declares components asks only through input components; its form fields alone (a
 * VIEW_FORM screen listing them) are not inputs. A step without components asks for its form fields.
 */
export function hasInputs(step: ProcessStep): boolean {
  const types = (step.components ?? []).map((c) => c.type)
  if (types.length) return types.some((t) => INPUT_COMPONENTS.includes(t))
  return (step.formFields?.length ?? 0) > 0
}

/** The fields a step's form asks for, applying any field adjustments the previous step returned. */
export function inputFields(step: ProcessStep, response: StepResponse & { type: 'COMPLETE' }): FieldMeta[] {
  const adjusted = response.processMetaDataAdjustment?.updatedFields ?? {}
  const types = (step.components ?? []).map((c) => c.type)
  if (types.length && !types.some((t) => t !== 'VALIDATION_REVIEW_SCREEN' && INPUT_COMPONENTS.includes(t))) return []
  const base = step.formFields ?? []
  const names = new Set<string>()
  for (const c of step.components ?? []) if (c.type !== 'VIEW_FORM') for (const n of ((c.values?.includeFieldNames as string[] | undefined) ?? [])) names.add(n)
  const fields = base.map((f) => ({ ...f, ...(adjusted[f.name] ?? {}) }))
  if (names.size === 0) return fields.filter((f) => f.isEditable !== false)
  return fields.filter((f) => names.has(f.name) && f.isEditable !== false)
}
