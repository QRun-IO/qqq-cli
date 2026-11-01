/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Bulk insert, bulk edit (with and without a file) and bulk delete: the table's bulk processes,
 * driven through the process runner with one callback per kind of screen (edit form, column
 * mapping, value mapping, validation review). The CLI answers from flags, a mapping document or
 * prompts; the TUI from its forms. Saved bulk load profiles are the `*SavedBulkLoadProfile` processes.
 */

import { callOperation } from '../api/call.js'
import type { FieldMeta, FieldValues } from '../forms/fields.js'
import { resolvePossibleValue, searchPossibleValues } from '../forms/possible-values.js'
import { BACK, ProcessCancelledError, ProcessError, runProcess, type ProcessStep, type RunnerOptions, type RunOutcome } from '../process/runner.js'
import type { ScreenBlock } from '../process/screen.js'
import { assertMapping, bulkEditValues, cleanSuggestion, mappingFromProfile, profileSubmitValues, readFileDescription, readTableStructure, structureFields, type BulkLoadProfile, type BulkLoadTableStructure, type BulkMapping, type FileDescription } from './mapping.js'

type J = Record<string, unknown>

/** The bulk processes of a table. */
export interface BulkProcesses {
  insert?: string
  edit?: string
  editWithFile?: string
  delete?: string
}

/**
 * The table's bulk processes: `clientCapabilities` (UI API 1.6+) when it says, else the standard
 * names (`{table}.bulkInsert`, …) when the metadata lists them (the user may run them).
 */
export function bulkProcesses(tableMeta: J, metaData: J): BulkProcesses {
  const caps = tableMeta.clientCapabilities as Record<string, J | undefined> | undefined
  const processes = (metaData.processes ?? {}) as Record<string, J>
  const table = String(tableMeta.name ?? '')
  const pick = (cap: string, suffix: string): string | undefined => {
    const c = caps?.[cap]
    if (c) return c.available === false ? undefined : (typeof c.processName === 'string' ? c.processName : undefined)
    const name = `${table}.${suffix}`
    return processes[name] && processes[name]!.hasPermission !== false ? name : undefined
  }
  const out: BulkProcesses = { insert: pick('bulkInsert', 'bulkInsert'), edit: pick('bulkEdit', 'bulkEdit'), editWithFile: pick('bulkEditWithFile', 'bulkEditWithFile'), delete: pick('bulkDelete', 'bulkDelete') }
  for (const k of Object.keys(out) as Array<keyof BulkProcesses>) if (!out[k]) delete out[k]
  return out
}

/** A saved bulk load profile (the `savedBulkLoadProfile` table). */
export interface SavedBulkLoadProfile {
  id: number
  label: string
  tableName: string
  userId?: string
  isBulkEdit: boolean
  profile: BulkLoadProfile
}

export const SAVED_BULK_LOAD_PROFILE_PROCESSES = { query: 'querySavedBulkLoadProfile', store: 'storeSavedBulkLoadProfile', delete: 'deleteSavedBulkLoadProfile' } as const

/** Whether the server offers saved bulk load profiles to this user (the three processes in the metadata). */
export function savedBulkLoadProfilesAvailable(metaData: J): boolean {
  const processes = (metaData.processes ?? {}) as Record<string, J>
  return Object.values(SAVED_BULK_LOAD_PROFILE_PROCESSES).every((p) => processes[p] && processes[p]!.hasPermission !== false)
}

export class SavedBulkLoadProfileError extends Error {}

/** Reads a saved profile record (`{ values: {...} }` or the values themselves). */
export function readSavedBulkLoadProfile(record: unknown): SavedBulkLoadProfile | undefined {
  if (!record || typeof record !== 'object') return undefined
  const v = ((record as J).values ?? record) as J
  if (v.id === undefined || v.id === null) return undefined
  let profile: BulkLoadProfile
  try {
    profile = typeof v.mappingJson === 'string' ? JSON.parse(v.mappingJson) as BulkLoadProfile : (v.mappingJson as BulkLoadProfile)
  } catch {
    profile = { version: 'v1', fieldList: [], hasHeaderRow: true, layout: 'FLAT', isBulkEdit: false, keyFields: null }
  }
  return { id: Number(v.id), label: String(v.label ?? ''), tableName: String(v.tableName ?? ''), ...(v.userId !== undefined && v.userId !== null ? { userId: String(v.userId) } : {}), isBulkEdit: v.isBulkEdit === true || v.isBulkEdit === 'true', profile: profile ?? { version: 'v1', fieldList: [] } as unknown as BulkLoadProfile }
}

async function runProfileProcess(baseUrl: string, fetchImpl: typeof fetch, processName: string, values: J): Promise<SavedBulkLoadProfile[]> {
  const result = await callOperation(baseUrl, 'initProcess', { path: { processName }, form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' } }, fetchImpl)
  const response = (result.data ?? {}) as J
  if (response.type === 'ERROR' || response.error) throw new SavedBulkLoadProfileError(String(response.userFacingError ?? response.error ?? 'The saved bulk load profile request failed'))
  if (response.type !== undefined && response.type !== 'COMPLETE') throw new SavedBulkLoadProfileError('The saved bulk load profile request did not complete.')
  const list = (((response.values ?? {}) as J).savedBulkLoadProfileList ?? []) as unknown[]
  return list.map(readSavedBulkLoadProfile).filter((p): p is SavedBulkLoadProfile => Boolean(p))
}

/** The saved profiles for a table (insert profiles, or bulk-edit profiles), by label. */
export async function listSavedBulkLoadProfiles(baseUrl: string, fetchImpl: typeof fetch, table: string, isBulkEdit: boolean): Promise<SavedBulkLoadProfile[]> {
  const list = await runProfileProcess(baseUrl, fetchImpl, SAVED_BULK_LOAD_PROFILE_PROCESSES.query, { tableName: table, isBulkEdit })
  return list.sort((a, b) => a.label.localeCompare(b.label))
}

/** Creates (no id) or updates a saved profile; returns it as stored. */
export async function storeSavedBulkLoadProfile(baseUrl: string, fetchImpl: typeof fetch, input: { table: string; label: string; isBulkEdit: boolean; profile: BulkLoadProfile; id?: number }): Promise<SavedBulkLoadProfile> {
  const [stored] = await runProfileProcess(baseUrl, fetchImpl, SAVED_BULK_LOAD_PROFILE_PROCESSES.store, { ...(input.id !== undefined ? { id: input.id } : {}), label: input.label, tableName: input.table, isBulkEdit: input.isBulkEdit, mappingJson: JSON.stringify(input.profile) })
  if (!stored) throw new SavedBulkLoadProfileError('The profile was not saved.')
  return stored
}

export async function deleteSavedBulkLoadProfile(baseUrl: string, fetchImpl: typeof fetch, id: number): Promise<void> {
  await runProfileProcess(baseUrl, fetchImpl, SAVED_BULK_LOAD_PROFILE_PROCESSES.delete, { id })
}

/** Finds a profile by id or label (exact, then ignoring case). */
export function findSavedBulkLoadProfile(profiles: SavedBulkLoadProfile[], idOrName: string): SavedBulkLoadProfile {
  const found = profiles.find((p) => String(p.id) === idOrName) ?? profiles.find((p) => p.label === idOrName) ?? profiles.find((p) => p.label.toLowerCase() === idOrName.toLowerCase())
  if (!found) throw new SavedBulkLoadProfileError(`No saved bulk load profile "${idOrName}"${profiles.length ? ` (saved: ${profiles.map((p) => p.label).join(', ')})` : ' (none saved for this table)'}`)
  return found
}

/** Yours (you own them) and shared with you, as the web profile menu groups them. */
export function splitProfilesByOwner(profiles: SavedBulkLoadProfile[], userId: string | undefined): { yours: SavedBulkLoadProfile[]; shared: SavedBulkLoadProfile[] } {
  const yours = profiles.filter((p) => isProfileOwner(p, userId))
  return { yours, shared: profiles.filter((p) => !yours.includes(p)) }
}

/** Only the owner may save over, rename or delete a profile. */
export function isProfileOwner(profile: SavedBulkLoadProfile, userId: string | undefined): boolean {
  return Boolean(userId) && profile.userId === userId
}

/** What the file mapping callback is given. */
export interface MappingContext {
  step: ProcessStep
  structure: BulkLoadTableStructure
  file: FileDescription
  /** The server's suggestion (cleaned), or the mapping submitted before going back. */
  suggestion: BulkMapping
  /** The mapping this run used last (after Back), if any. */
  previous?: BulkMapping
  /** The saved profile chosen for this run, if any. */
  savedProfile?: SavedBulkLoadProfile
  /** Bulk edit: the key field choices (`a|b` for compound keys) with labels. */
  keyFieldOptions: () => Promise<Array<{ id: string; label: string }>>
  canGoBack: boolean
  values: FieldValues
}

/** What the value mapping callback is given: one field whose file values map to table values. */
export interface ValueMappingContext {
  step: ProcessStep
  /** The profile field name (`homeCityId`, `pets.speciesId,0`). */
  fieldName: string
  field: FieldMeta
  /** The table the field belongs to (a child table for child fields). */
  tableName: string
  /** The distinct values of the column in the file. */
  fileValues: string[]
  /** Mappings known so far (the profile's or the mapping document's), by file value. */
  mapped: Record<string, unknown>
  /** Labels of mapped ids the server looked up. */
  labels: Record<string, string>
  index: number
  count: number
  canGoBack: boolean
}

/** What the review callback is given. */
export interface ReviewContext {
  step: ProcessStep
  screen: ScreenBlock[]
  /** Whether full validation already ran (its summary is on the screen). */
  validated: boolean
  supportsFullValidation: boolean
  canGoBack: boolean
  values: FieldValues
}

/** `validate` runs full validation and shows the review again; `skip` and `submit` run the load; `cancel` stops it. */
export type ReviewDecision = 'validate' | 'skip' | 'submit' | 'cancel'

export interface BulkRunOptions extends Omit<RunnerOptions, 'provide' | 'values' | 'files' | 'always'> {
  /** The file to load (insert, edit with a file): sent with the upload step, again after going back to it. */
  file?: { name: string; bytes: Uint8Array; type?: string }
  /** Values known up front (sent with init and every step). */
  values?: FieldValues
  /** A saved profile to use (its id is sent with the mapping steps). */
  savedProfile?: SavedBulkLoadProfile
  /** Bulk edit form: the switched-on fields and their values (or BACK). */
  editForm?: (context: { step: ProcessStep; fields: FieldMeta[]; values: FieldValues; canGoBack: boolean }) => Promise<{ values: FieldValues; enabled: string[] } | typeof BACK>
  /** File mapping: the mapping to submit (or BACK). */
  chooseMapping?: (context: MappingContext) => Promise<BulkMapping | typeof BACK>
  /** Value mapping: file value to table value for one field (or BACK). */
  mapValues?: (context: ValueMappingContext) => Promise<Record<string, unknown> | typeof BACK>
  /** Validation review: what to do (or BACK). */
  review: (context: ReviewContext) => Promise<ReviewDecision | typeof BACK>
  /** Any other step with input (a process-specific form): values to send (default: none). */
  other?: (context: { step: ProcessStep; fields: FieldMeta[]; values: FieldValues; screen: ScreenBlock[] }) => Promise<FieldValues | typeof BACK>
}

/** The person declined at the review (the run was cancelled on the server). */
export class BulkDeclinedError extends ProcessError {}

export interface BulkOutcome extends RunOutcome {
  /** The mapping the load used (file loads). */
  mapping?: BulkMapping
  structure?: BulkLoadTableStructure
  file?: FileDescription
}

/** Runs a bulk process (insert, edit, edit with a file, delete) to its result screen. */
export async function runBulkProcess(options: BulkRunOptions): Promise<BulkOutcome> {
  const { file, savedProfile, review } = options
  const controller = new AbortController()
  const outer = options.signal
  const onOuterAbort = () => controller.abort()
  outer?.addEventListener('abort', onOuterAbort, { once: true })
  if (outer?.aborted) controller.abort()
  let declined = false
  let mapping: BulkMapping | undefined
  let structure: BulkLoadTableStructure | undefined
  let fileDescription: FileDescription | undefined
  const stepFiles: NonNullable<RunnerOptions['stepFiles']> = {}
  const savedId = (): Record<string, string> => (savedProfile ? { savedBulkLoadProfileId: String(savedProfile.id) } : {})
  try {
    const outcome = await runProcess({
      ...options,
      values: options.values,
      files: file ? { theFile: file } : undefined,
      stepFiles,
      signal: controller.signal,
      provide: async ({ step, fields, values, response, screen }) => {
        const types = (step.components ?? []).map((c) => c.type)
        const canGoBack = Boolean(response.backStep)
        if (types.includes('BULK_EDIT_FORM')) {
          if (!options.editForm) throw new ProcessError(`${step.label ?? step.name}: no bulk edit values were given`)
          const answer = await options.editForm({ step, fields, values, canGoBack })
          if (answer === BACK) return BACK
          return bulkEditValues(answer.values, answer.enabled)
        }
        if (types.includes('BULK_LOAD_FILE_MAPPING_FORM')) {
          structure = readTableStructure(values.tableStructure)
          if (!structure) throw new ProcessError(`${step.label ?? step.name}: the server sent no table structure for the uploaded file`)
          fileDescription = readFileDescription(values)
          if (!options.chooseMapping) throw new ProcessError(`${step.label ?? step.name}: no mapping was given`)
          const fromServer = (values.bulkLoadProfile ?? values.suggestedBulkLoadProfile) as BulkLoadProfile | undefined
          const suggestion = mapping ?? (savedProfile ? cleanSuggestion(savedProfile.profile, structure, fileDescription) : cleanSuggestion(fromServer, structure, fileDescription))
          const chosen = await options.chooseMapping({
            step, structure, file: fileDescription, suggestion, previous: mapping, savedProfile, canGoBack, values,
            keyFieldOptions: () => keyFieldOptions(options.baseUrl, options.fetch, options.meta.name, structure!),
          })
          if (chosen === BACK) return BACK
          assertMapping(chosen, structure, fileDescription)
          mapping = await resolveDefaults(options.baseUrl, options.fetch, structure, chosen)
          return { ...profileSubmitValues(mapping), ...savedId() }
        }
        if (types.includes('BULK_LOAD_VALUE_MAPPING_FORM')) {
          structure ??= readTableStructure(values.tableStructure)
          if (!structure) throw new ProcessError(`${step.label ?? step.name}: the server sent no table structure`)
          mapping ??= mappingFromProfile(values.bulkLoadProfile as BulkLoadProfile, structure)
          const fieldName = String(values.valueMappingFullFieldName ?? '')
          const field = (values.valueMappingField ?? {}) as FieldMeta
          const tableName = String(values.valueMappingFieldTableName || structure.tableName)
          const fileValues = Array.isArray(values.fileValues) ? values.fileValues.map(String) : []
          const target = mapping.fields.find((f) => f.name === fieldName)
          const known = { ...((values.valueMapping && typeof values.valueMapping === 'object') ? values.valueMapping as J : {}), ...(target?.valueMappings ?? {}) }
          if (!options.mapValues) throw new ProcessError(`${step.label ?? step.name}: values of ${field.label ?? fieldName} need mapping`)
          const answer = await options.mapValues({
            step, fieldName, field, tableName, fileValues, mapped: known,
            labels: (values.mappedValueLabels && typeof values.mappedValueLabels === 'object' ? values.mappedValueLabels : {}) as Record<string, string>,
            index: typeof values.valueMappingFieldIndex === 'number' ? values.valueMappingFieldIndex : 0,
            count: Array.isArray(values.fieldNamesToDoValueMapping) ? values.fieldNamesToDoValueMapping.length : 1,
            canGoBack,
          })
          if (answer === BACK) return BACK
          const resolved = await resolveValueMappings(options.baseUrl, options.fetch, tableName, field, answer)
          if (target) {
            target.doValueMapping = true
            target.valueMappings = resolved
          }
          return { ...profileSubmitValues(mapping), mappedValuesJSON: JSON.stringify(resolved), ...savedId() }
        }
        if (types.includes('VALIDATION_REVIEW_SCREEN')) {
          const block = screen.find((b) => b.kind === 'review')
          const supportsFullValidation = values.supportsFullValidation === true || values.supportsFullValidation === 'true' || (block?.kind === 'review' && block.supportsFullValidation)
          const validated = values.validationSummary !== undefined && values.validationSummary !== null
          const decision = await review({ step, screen, validated, supportsFullValidation, canGoBack, values })
          if (decision === BACK) return BACK
          if (decision === 'cancel') {
            declined = true
            controller.abort()
            throw new ProcessError('not submitted')
          }
          if (decision === 'validate') return { doFullValidation: 'true' }
          if (decision === 'skip') return { doFullValidation: 'false' }
          return validated ? {} : { doFullValidation: 'false' }
        }
        if (fields.some((f) => f.type === 'BLOB') && file) {
          // the upload step (again after Back): the file goes with it
          stepFiles.theFile = file
          for (const f of fields) if (f.type === 'BLOB' && f.name !== 'theFile') stepFiles[f.name] = file
          return {}
        }
        return options.other ? await options.other({ step, fields, values, screen }) : {}
      },
    })
    return { ...outcome, ...(mapping ? { mapping } : {}), ...(structure ? { structure } : {}), ...(fileDescription ? { file: fileDescription } : {}) }
  } catch (error) {
    if (declined && error instanceof ProcessCancelledError) throw new BulkDeclinedError(`not submitted; ${error.message}`, error.processUUID)
    throw error
  } finally {
    outer?.removeEventListener('abort', onOuterAbort)
  }
}

/** The key field choices of a bulk-edit-with-file process (`tableKeyFields` possible values), else the structure's. */
export async function keyFieldOptions(baseUrl: string, fetchImpl: typeof fetch, processName: string, structure: BulkLoadTableStructure): Promise<Array<{ id: string; label: string }>> {
  const labels = new Map(structureFields(structure).map((f) => [f.name, f.label]))
  const fallback = (structure.possibleKeyFields ?? []).map((k) => ({ id: k, label: k.split('|').map((p) => labels.get(p) ?? p).join(', ') }))
  try {
    const options = await searchPossibleValues(baseUrl, fetchImpl, { process: processName }, 'tableKeyFields', { searchTerm: '' })
    return options.length ? options.map((o) => ({ id: String(o.id), label: o.label })) : fallback
  } catch {
    return fallback
  }
}

/**
 * Default values typed for their field: a possible-value field takes an id or a label (resolved
 * to the id), a boolean yes/no/true/false; other values are sent as written.
 */
export async function resolveDefaults(baseUrl: string, fetchImpl: typeof fetch, structure: BulkLoadTableStructure, mapping: BulkMapping): Promise<BulkMapping> {
  const byName = new Map(structureFields(structure).map((f) => [f.name, f]))
  const fields = []
  for (const f of mapping.fields) {
    if (f.column !== undefined || f.defaultValue === undefined || f.defaultValue === null) {
      fields.push(f)
      continue
    }
    const meta = byName.get(f.name.replace(/,\d+$/, ''))
    fields.push({ ...f, defaultValue: meta ? await typedValue(baseUrl, fetchImpl, meta.tableName, meta.field, f.defaultValue, `default for ${meta.label}`) : f.defaultValue })
  }
  return { ...mapping, fields }
}

/** Value mappings typed for the field (labels of possible values resolved to ids). */
export async function resolveValueMappings(baseUrl: string, fetchImpl: typeof fetch, tableName: string, field: FieldMeta, mapped: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [fileValue, value] of Object.entries(mapped)) {
    if (value === undefined || value === null || value === '') continue
    out[fileValue] = await typedValue(baseUrl, fetchImpl, tableName, field, value, `${field.label ?? field.name} for "${fileValue}"`)
  }
  return out
}

async function typedValue(baseUrl: string, fetchImpl: typeof fetch, tableName: string, field: FieldMeta, value: unknown, what: string): Promise<unknown> {
  if (field.possibleValueSourceName && (typeof value === 'string' || typeof value === 'number')) {
    const { option, candidates } = await resolvePossibleValue(baseUrl, fetchImpl, { table: tableName }, field.name, String(value), { fieldType: field.type })
    if (option) return option.id
    throw new ProcessError(`${what}: "${String(value)}" ${candidates.length ? `matches several values (${candidates.slice(0, 8).map((c) => `${c.label} (${String(c.id)})`).join(', ')})` : 'matches no value'}`, undefined, { userFacing: true })
  }
  if (field.type === 'BOOLEAN' && typeof value === 'string') {
    if (/^(y|yes|true|1)$/i.test(value)) return true
    if (/^(n|no|false|0)$/i.test(value)) return false
  }
  return value
}

