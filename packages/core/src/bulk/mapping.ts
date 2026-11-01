/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The bulk load mapping: which file column (or default value) feeds each table field, as the
 * server's v1 bulk load profile describes it (`BulkLoadProfile`, `BulkLoadProfileField`). Pure
 * functions over the process values the bulk insert and bulk-edit-with-file steps return
 * (`tableStructure`, `headerValues`, `headerLetters`, `bodyValuesPreview`, `suggestedBulkLoadProfile`).
 *
 * The mapping steps read the profile as flat string values (`version`, `fieldListJSON`, `layout`,
 * `hasHeaderRow`, `isBulkEdit`, `keyFields`), never as an object: see {@link profileSubmitValues}.
 * A person or a script writes a mapping document ({@link parseMappingDocument}): field name or
 * label to a column (header name or letter), a default value, or a column with value mappings.
 */

import type { FieldMeta } from '../forms/fields.js'

/** A table (and its child tables) a bulk load can fill: the `tableStructure` process value. */
export interface BulkLoadTableStructure {
  isMain: boolean
  isMany: boolean
  tableName: string
  label: string
  associationPath: string | null
  fields: FieldMeta[]
  associations: BulkLoadTableStructure[] | null
  isBulkEdit?: boolean
  possibleKeyFields?: string[] | null
  keyFields?: string | null
}

/** One field of a v1 profile. */
export interface BulkLoadProfileField {
  fieldName: string
  columnIndex?: number | null
  headerName?: string | null
  defaultValue?: unknown
  doValueMapping?: boolean | null
  clearIfEmpty?: boolean | null
  valueMappings?: Record<string, unknown> | null
}

/** The v1 profile the server reads and returns (`bulkLoadProfile`, a saved profile's `mappingJson`). */
export interface BulkLoadProfile {
  version: string
  fieldList: BulkLoadProfileField[]
  hasHeaderRow: boolean
  layout: string | null
  isBulkEdit: boolean
  keyFields: string | null
}

export type BulkLoadLayout = 'FLAT' | 'TALL' | 'WIDE'

/** A field the load fills: from a column (with optional value mappings) or one default value. */
export interface MappedField {
  /** The profile field name: `field`, `association.field`, plus `,n` for a WIDE repetition (0-based). */
  name: string
  column?: number
  header?: string
  defaultValue?: unknown
  doValueMapping?: boolean
  clearIfEmpty?: boolean
  /** File value to table value (an id for possible-value fields). */
  valueMappings?: Record<string, unknown>
}

/** The mapping being edited and submitted. */
export interface BulkMapping {
  layout: BulkLoadLayout
  hasHeaderRow: boolean
  isBulkEdit: boolean
  /** Bulk edit: `|`-separated key field names. */
  keyFields?: string
  fields: MappedField[]
}

/** A field of the table structure, by qualified name. */
export interface StructureField {
  /** `field`, or `association.field` for a child table. */
  name: string
  /** `Label`, or `Child: Label`. */
  label: string
  field: FieldMeta
  tableName: string
  isMain: boolean
  isMany: boolean
}

/** The uploaded file as the upload step describes it. */
export interface FileDescription {
  name?: string
  headers: string[]
  letters: string[]
  /** Preview values per column. */
  preview: string[][]
  /** Columns whose header repeats an earlier one (only the first is read by the server). */
  duplicates: boolean[]
}

export const DUPLICATE_HEADER_WARNING = 'its column repeats an earlier header; only the first column with that header is read'

/** Thrown for a mapping that cannot be submitted or a mapping document that cannot be read. */
export class BulkMappingError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length ? `${message}:\n  ${problems.join('\n  ')}` : message)
  }
}

/** Reads the `tableStructure` process value. */
export function readTableStructure(value: unknown): BulkLoadTableStructure | undefined {
  return value && typeof value === 'object' && Array.isArray((value as BulkLoadTableStructure).fields) ? value as BulkLoadTableStructure : undefined
}

/** Every field the structure offers, main table first, then child tables (depth first). */
export function structureFields(structure: BulkLoadTableStructure): StructureField[] {
  const out: StructureField[] = []
  const visit = (s: BulkLoadTableStructure): void => {
    for (const field of s.fields ?? []) {
      out.push({ name: s.isMain ? field.name : `${s.associationPath}.${field.name}`, label: s.isMain ? String(field.label ?? field.name) : `${s.label}: ${String(field.label ?? field.name)}`, field, tableName: s.tableName, isMain: s.isMain, isMany: s.isMany })
    }
    for (const child of s.associations ?? []) visit(child)
  }
  visit(structure)
  return out
}

/** Whether the table has child tables (TALL and WIDE layouts are offered). */
export function hasChildTables(structure: BulkLoadTableStructure): boolean {
  return Boolean(structure.associations?.length)
}

/** Splits a profile field name into its qualified field name and WIDE index. */
export function splitProfileName(name: string): { field: string; wideIndex?: number } {
  const m = /^(.*),(\d+)$/.exec(name)
  return m ? { field: m[1]!, wideIndex: Number(m[2]) } : { field: name }
}

/** A mapped field's label: the structure label, plus ` (n)` for a WIDE repetition. */
export function mappedFieldLabel(structure: BulkLoadTableStructure, name: string): string {
  const { field, wideIndex } = splitProfileName(name)
  const known = structureFields(structure).find((f) => f.name === field)
  return `${known?.label ?? field}${wideIndex !== undefined ? ` (${wideIndex + 1})` : ''}`
}

/** The file from the upload step's values. */
export function readFileDescription(values: Record<string, unknown>): FileDescription {
  const headers = Array.isArray(values.headerValues) ? values.headerValues.map((v) => (v === null || v === undefined ? '' : String(v))) : []
  const letters = Array.isArray(values.headerLetters) ? values.headerLetters.map(String) : headers.map((_, i) => columnLetter(i))
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object' && 'string' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).string ?? '')
    return String(v)
  }
  const preview = Array.isArray(values.bodyValuesPreview) ? values.bodyValuesPreview.map((c) => (Array.isArray(c) ? c.map(cell) : [])) : []
  const seen = new Set<string>()
  const duplicates = headers.map((h) => {
    const dup = seen.has(h)
    seen.add(h)
    return dup
  })
  return { ...(typeof values.fileBaseName === 'string' ? { name: values.fileBaseName } : {}), headers, letters, preview, duplicates }
}

/** `A`, `B`, … `Z`, `AA`, … for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A column's name: its header with a header row, else `Column B`. */
export function columnName(file: FileDescription, index: number, hasHeaderRow: boolean): string {
  return hasHeaderRow ? (file.headers[index] ?? columnLetter(index)) : `Column ${file.letters[index] ?? columnLetter(index)}`
}

/** A column's preview values (the header row is data without a header row). */
export function columnPreview(file: FileDescription, index: number, hasHeaderRow: boolean): string[] {
  const body = file.preview[index] ?? []
  return hasHeaderRow ? body : [file.headers[index] ?? '', ...body]
}

/**
 * Finds a column by what a person wrote: a header name (exact, then ignoring case; the first
 * column with that header, as the server reads it) or a column letter. Undefined when nothing matches.
 */
export function findColumn(file: FileDescription, text: string, hasHeaderRow: boolean): number | undefined {
  const wanted = text.trim()
  if (hasHeaderRow) {
    let i = file.headers.indexOf(wanted)
    if (i < 0) i = file.headers.findIndex((h) => h.toLowerCase() === wanted.toLowerCase())
    if (i >= 0) return i
  }
  const m = /^(?:column\s+)?([A-Za-z]{1,3})$/i.exec(wanted)
  if (m) {
    const i = file.letters.indexOf(m[1]!.toUpperCase())
    if (i >= 0) return i
  }
  return undefined
}

/** Reads a v1 profile into a mapping (unknown fields dropped). */
export function mappingFromProfile(profile: BulkLoadProfile, structure: BulkLoadTableStructure): BulkMapping {
  if (profile.version && profile.version !== 'v1') throw new BulkMappingError(`Unexpected bulk load profile version ${profile.version}`)
  const known = new Set(structureFields(structure).map((f) => f.name))
  const fields: MappedField[] = []
  for (const pf of profile.fieldList ?? []) {
    if (!known.has(splitProfileName(pf.fieldName).field)) continue
    if ((pf.columnIndex !== null && pf.columnIndex !== undefined) || pf.headerName) {
      fields.push(clean({ name: pf.fieldName, column: pf.columnIndex ?? undefined, header: pf.headerName ?? undefined, doValueMapping: pf.doValueMapping ? true : undefined, clearIfEmpty: pf.clearIfEmpty ? true : undefined, valueMappings: pf.valueMappings && Object.keys(pf.valueMappings).length ? { ...pf.valueMappings } : undefined }))
    } else if (pf.defaultValue !== null && pf.defaultValue !== undefined && pf.defaultValue !== '') {
      fields.push({ name: pf.fieldName, defaultValue: pf.defaultValue })
    }
  }
  const layout = (['FLAT', 'TALL', 'WIDE'].includes(String(profile.layout)) ? profile.layout : 'FLAT') as BulkLoadLayout
  return clean({ layout: hasChildTables(structure) ? layout : 'FLAT', hasHeaderRow: profile.hasHeaderRow !== false, isBulkEdit: Boolean(profile.isBulkEdit ?? structure.isBulkEdit), keyFields: profile.keyFields ?? structure.keyFields ?? undefined, fields })
}

/** The mapping as a v1 profile (what a saved profile stores). */
export function profileFromMapping(mapping: BulkMapping): BulkLoadProfile {
  return {
    version: 'v1',
    fieldList: mapping.fields.map((f) => (f.column !== undefined
      ? clean({ fieldName: f.name, columnIndex: f.column, headerName: mapping.hasHeaderRow ? f.header : undefined, doValueMapping: Boolean(f.doValueMapping), clearIfEmpty: Boolean(f.clearIfEmpty), valueMappings: f.doValueMapping && f.valueMappings && Object.keys(f.valueMappings).length ? f.valueMappings : undefined })
      : { fieldName: f.name, defaultValue: f.defaultValue })),
    hasHeaderRow: mapping.hasHeaderRow,
    layout: mapping.layout,
    isBulkEdit: mapping.isBulkEdit,
    keyFields: mapping.keyFields ?? null,
  }
}

/**
 * The flat values every mapping step re-submits (the server reads them with
 * `BulkInsertStepUtils.getBulkLoadProfile`; an object in `values` fails the step).
 */
export function profileSubmitValues(mapping: BulkMapping): Record<string, string> {
  const profile = profileFromMapping(mapping)
  return {
    version: profile.version,
    fieldListJSON: JSON.stringify(profile.fieldList),
    layout: mapping.layout,
    hasHeaderRow: String(mapping.hasHeaderRow),
    isBulkEdit: String(mapping.isBulkEdit),
    ...(mapping.keyFields ? { keyFields: mapping.keyFields } : {}),
  }
}

/**
 * The server's suggestion made safe to submit (server finding 11): a child-table field that
 * reuses a column a main-table field already reads is dropped, and with no child field left the
 * layout is FLAT. Header names are pointed at this file's columns.
 */
export function cleanSuggestion(profile: BulkLoadProfile | undefined, structure: BulkLoadTableStructure, file?: FileDescription): BulkMapping {
  if (!profile) return requiredMapping(structure)
  const mapping = mappingFromProfile({ ...profile, version: profile.version ?? 'v1' }, structure)
  const fieldsByName = new Map(structureFields(structure).map((f) => [f.name, f]))
  const mainColumns = new Set(mapping.fields.filter((f) => fieldsByName.get(splitProfileName(f.name).field)?.isMain && f.column !== undefined).map((f) => f.column))
  mapping.fields = mapping.fields.filter((f) => fieldsByName.get(splitProfileName(f.name).field)?.isMain || f.column === undefined || !mainColumns.has(f.column))
  if (!mapping.fields.some((f) => !fieldsByName.get(splitProfileName(f.name).field)?.isMain)) mapping.layout = 'FLAT'
  if (file) remapByHeader(mapping, file)
  // a required field the suggestion did not map stays in the mapping, unmapped, so the person is asked for it
  for (const required of requiredMapping(structure).fields) if (!mapping.fields.some((f) => f.name === required.name)) mapping.fields.push(required)
  if (mapping.isBulkEdit && !mapping.keyFields && structure.possibleKeyFields?.length) {
    const names = mapping.fields.map((f) => f.name)
    mapping.keyFields = structure.possibleKeyFields.find((k) => k.split('|').every((p) => names.includes(p)))
  }
  return clean(mapping)
}

/** The default mapping: the main table's required fields (bulk edit: the key fields), unmapped. */
export function requiredMapping(structure: BulkLoadTableStructure): BulkMapping {
  const isBulkEdit = Boolean(structure.isBulkEdit)
  const keys = (structure.keyFields ?? '').split('|').filter(Boolean)
  const fields = structureFields(structure).filter((f) => (isBulkEdit ? keys.includes(f.name) : f.isMain && f.field.isRequired)).map((f) => ({ name: f.name }))
  return clean({ layout: 'FLAT', hasHeaderRow: true, isBulkEdit, keyFields: structure.keyFields ?? undefined, fields })
}

/** Points each column-mapped field that names a header at that header's column in this file. */
export function remapByHeader(mapping: BulkMapping, file: FileDescription): void {
  if (!mapping.hasHeaderRow) return
  for (const f of mapping.fields) {
    if (f.header === undefined) {
      if (f.column !== undefined) f.header = file.headers[f.column]
      continue
    }
    const i = file.headers.indexOf(f.header)
    if (i >= 0) f.column = i
  }
}

/** Turns the header row on or off: column fields take their column's header, or lose it. */
export function setHasHeaderRow(mapping: BulkMapping, hasHeaderRow: boolean, file: FileDescription): string[] {
  const warnings: string[] = []
  mapping.hasHeaderRow = hasHeaderRow
  for (const f of mapping.fields) {
    if (!hasHeaderRow) {
      delete f.header
      continue
    }
    if (f.column === undefined) continue
    if (file.duplicates[f.column]) {
      warnings.push(`${f.name}: ${DUPLICATE_HEADER_WARNING}`)
      delete f.column
      delete f.header
    } else {
      f.header = file.headers[f.column]
    }
  }
  return warnings
}

/**
 * What stops a mapping from being submitted (as the web screen checks before Next): a field
 * with neither a column nor a default value, a column that does not exist, a layout the table
 * does not offer, bulk edit without key fields or with a key field not read from the file, no
 * fields at all. Warnings: a column whose header repeats an earlier one.
 */
export function checkMapping(mapping: BulkMapping, structure: BulkLoadTableStructure, file: FileDescription): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const label = (name: string) => mappedFieldLabel(structure, name)
  if (!mapping.fields.length) errors.push('map at least 1 field')
  if (!hasChildTables(structure) && mapping.layout !== 'FLAT') errors.push(`layout ${mapping.layout}: ${structure.label} has no child tables, so the layout is FLAT`)
  const known = new Set(structureFields(structure).map((f) => f.name))
  const seen = new Set<string>()
  for (const f of mapping.fields) {
    const { field } = splitProfileName(f.name)
    if (!known.has(field)) errors.push(`${f.name}: not a field ${structure.label} can load`)
    if (seen.has(f.name)) errors.push(`${label(f.name)}: mapped twice`)
    seen.add(f.name)
    if (f.column === undefined && (f.defaultValue === undefined || f.defaultValue === null || f.defaultValue === '')) errors.push(`${label(f.name)}: choose a column or give a default value`)
    if (f.column !== undefined && (f.column < 0 || f.column >= Math.max(file.headers.length, file.preview.length))) errors.push(`${label(f.name)}: the file has no column ${columnLetter(f.column)}`)
    if (f.column !== undefined && mapping.hasHeaderRow && file.duplicates[f.column]) warnings.push(`${label(f.name)}: ${DUPLICATE_HEADER_WARNING}`)
    const many = structureFields(structure).find((s) => s.name === field)?.isMany
    if (many && mapping.layout === 'WIDE' && splitProfileName(f.name).wideIndex === undefined) errors.push(`${label(f.name)}: a WIDE layout needs a repetition (${field},0 for the first)`)
    if (splitProfileName(f.name).wideIndex !== undefined && mapping.layout !== 'WIDE') errors.push(`${f.name}: a repetition index needs the WIDE layout`)
  }
  if (mapping.isBulkEdit) {
    if (!mapping.keyFields) errors.push('choose the key fields that find each record (bulk edit with a file)')
    else for (const key of mapping.keyFields.split('|').filter(Boolean)) {
      const f = mapping.fields.find((m) => m.name === key)
      if (!f || f.column === undefined) errors.push(`key field ${label(key)} is not mapped to a column`)
    }
  }
  return { errors, warnings }
}

/** Throws a {@link BulkMappingError} listing the problems when a mapping cannot be submitted. */
export function assertMapping(mapping: BulkMapping, structure: BulkLoadTableStructure, file: FileDescription): string[] {
  const { errors, warnings } = checkMapping(mapping, structure, file)
  if (errors.length) throw new BulkMappingError('The mapping cannot be used', errors)
  return warnings
}

/** One row per mapped field, for showing a mapping: field, source (column or default), preview or value mapping. */
export function mappingRows(mapping: BulkMapping, structure: BulkLoadTableStructure, file: FileDescription): Array<{ field: string; name: string; source: string; preview: string; options: string }> {
  return mapping.fields.map((f) => {
    const source = f.column !== undefined ? `column ${columnName(file, f.column, mapping.hasHeaderRow)}${mapping.hasHeaderRow ? ` (${file.letters[f.column] ?? columnLetter(f.column)})` : ''}`
      : f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '' ? `default ${String(f.defaultValue)}` : '(not mapped)'
    const preview = f.column !== undefined ? columnPreview(file, f.column, mapping.hasHeaderRow).slice(0, 3).join(', ') : ''
    const options = [f.doValueMapping ? `map values${f.valueMappings ? ` (${Object.keys(f.valueMappings).length})` : ''}` : '', f.clearIfEmpty ? 'clear if empty' : ''].filter(Boolean).join(', ')
    return { field: mappedFieldLabel(structure, f.name), name: f.name, source, preview, options }
  })
}

/** A field entry of a mapping document. */
export type MappingDocField = string | { column?: string | number; default?: unknown; values?: Record<string, unknown>; valueMapping?: boolean; clearIfEmpty?: boolean }

/** The mapping document a script passes (`--mapping m.yaml`), or the server's v1 profile. */
export interface MappingDocument {
  layout?: string
  hasHeaderRow?: boolean
  keyFields?: string | string[]
  fields?: Record<string, MappingDocField>
}

/**
 * Reads a mapping document: `fields` maps a field (name, `child.field`, `child.field,0` for a
 * WIDE repetition, or the label shown by the mapping) to a column (header name or letter; a
 * number is a 0-based index), `{ default: value }`, or `{ column, values: { fileValue: tableValue },
 * clearIfEmpty }`. A document with `fieldList` is taken as the server's v1 profile (a saved
 * profile's mapping). Values in `values` and defaults stay as written; labels are resolved to ids
 * when the load runs.
 */
export function parseMappingDocument(doc: unknown, structure: BulkLoadTableStructure, file: FileDescription): BulkMapping {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new BulkMappingError('A mapping document is an object with fields (and optionally layout, hasHeaderRow, keyFields)')
  const raw = doc as Record<string, unknown>
  if (Array.isArray(raw.fieldList)) {
    const mapping = mappingFromProfile({ version: 'v1', hasHeaderRow: true, layout: 'FLAT', isBulkEdit: Boolean(structure.isBulkEdit), keyFields: null, ...(raw as Partial<BulkLoadProfile>), fieldList: raw.fieldList as BulkLoadProfileField[] }, structure)
    remapByHeader(mapping, file)
    return mapping
  }
  const d = raw as MappingDocument
  const problems: string[] = []
  const hasHeaderRow = d.hasHeaderRow !== false
  const layout = String(d.layout ?? 'FLAT').toUpperCase()
  if (!['FLAT', 'TALL', 'WIDE'].includes(layout)) problems.push(`layout ${String(d.layout)}: one of FLAT, TALL, WIDE`)
  const all = structureFields(structure)
  const fields: MappedField[] = []
  for (const [key, spec] of Object.entries(d.fields ?? {})) {
    const { field: base, wideIndex } = splitProfileName(key.trim())
    const target = all.find((f) => f.name === base) ?? all.find((f) => f.label.toLowerCase() === base.toLowerCase())
    if (!target) {
      problems.push(`${key}: no such field (${all.map((f) => f.name).join(', ')})`)
      continue
    }
    const name = wideIndex !== undefined ? `${target.name},${wideIndex}` : target.name
    const entry = typeof spec === 'string' || typeof spec === 'number' ? { column: spec } : (spec ?? {}) as Exclude<MappingDocField, string>
    const m: MappedField = { name }
    if (entry.column !== undefined && entry.column !== null && entry.column !== '') {
      const column = typeof entry.column === 'number' ? entry.column : findColumn(file, String(entry.column), hasHeaderRow)
      if (column === undefined || column < 0 || column >= Math.max(file.headers.length, 1)) {
        problems.push(`${key}: no column ${String(entry.column)} (columns: ${file.headers.map((h, i) => (hasHeaderRow ? `${h} (${file.letters[i]})` : file.letters[i])).join(', ')})`)
        continue
      }
      m.column = column
      if (hasHeaderRow) m.header = file.headers[column]
      if (entry.values && typeof entry.values === 'object') {
        m.doValueMapping = true
        m.valueMappings = Object.fromEntries(Object.entries(entry.values).map(([k, v]) => [k, v]))
      } else if (entry.valueMapping) m.doValueMapping = true
      if (entry.clearIfEmpty) m.clearIfEmpty = true
    } else if (entry.default !== undefined) {
      m.defaultValue = entry.default
    } else {
      problems.push(`${key}: give a column or a default`)
      continue
    }
    fields.push(m)
  }
  const keyFields = Array.isArray(d.keyFields) ? d.keyFields.join('|') : d.keyFields
  if (keyFields) {
    for (const k of keyFields.split('|')) if (!all.some((f) => f.name === k)) problems.push(`keyFields: ${k} is not a field`)
  }
  if (problems.length) throw new BulkMappingError('The mapping document has problems', problems)
  return clean({ layout: (hasChildTables(structure) ? layout : 'FLAT') as BulkLoadLayout, hasHeaderRow, isBulkEdit: Boolean(structure.isBulkEdit), keyFields: keyFields || structure.keyFields || undefined, fields })
}

/** The mapping as a document a script can pass back with `--mapping` (columns by header name, else letter). */
export function mappingDocument(mapping: BulkMapping, file: FileDescription): MappingDocument {
  const fields: Record<string, MappingDocField> = {}
  for (const f of mapping.fields) {
    if (f.column === undefined) {
      fields[f.name] = { default: f.defaultValue }
      continue
    }
    const column = mapping.hasHeaderRow && file.headers[f.column] && !file.duplicates[f.column] ? file.headers[f.column]! : (file.letters[f.column] ?? columnLetter(f.column))
    const extra = { ...(f.doValueMapping ? (f.valueMappings && Object.keys(f.valueMappings).length ? { values: f.valueMappings } : { valueMapping: true }) : {}), ...(f.clearIfEmpty ? { clearIfEmpty: true } : {}) }
    fields[f.name] = Object.keys(extra).length ? { column, ...extra } : column
  }
  return { layout: mapping.layout, hasHeaderRow: mapping.hasHeaderRow, ...(mapping.keyFields ? { keyFields: mapping.keyFields } : {}), fields }
}

/**
 * The changes between two mappings, one line each, as the web profile menu lists them before an
 * update: header row, layout, key fields, fields added and removed, columns, defaults, value mappings.
 */
export function diffMappings(base: BulkMapping, active: BulkMapping, structure: BulkLoadTableStructure, file: FileDescription): string[] {
  const out: string[] = []
  const label = (n: string) => mappedFieldLabel(structure, n)
  const col = (i: number | undefined) => (i === undefined ? '--' : columnName(file, i, active.hasHeaderRow))
  if (base.hasHeaderRow !== active.hasHeaderRow) out.push(`header row: ${base.hasHeaderRow ? 'yes' : 'no'} -> ${active.hasHeaderRow ? 'yes' : 'no'}`)
  if (base.layout !== active.layout) out.push(`layout: ${base.layout} -> ${active.layout}`)
  if (active.isBulkEdit && (base.keyFields ?? '') !== (active.keyFields ?? '')) out.push(`key fields: ${base.keyFields ?? '--'} -> ${active.keyFields ?? '--'}`)
  const b = new Map(base.fields.map((f) => [f.name, f]))
  const a = new Map(active.fields.map((f) => [f.name, f]))
  const added = [...a.keys()].filter((n) => !b.has(n)).map(label)
  const removed = [...b.keys()].filter((n) => !a.has(n)).map(label)
  if (added.length) out.push(`added: ${added.join(', ')}`)
  if (removed.length) out.push(`removed: ${removed.join(', ')}`)
  for (const [name, now] of a) {
    const was = b.get(name)
    if (!was) continue
    if ((was.column === undefined) !== (now.column === undefined)) out.push(`${label(name)}: ${was.column === undefined ? `default ${String(was.defaultValue)}` : `column ${col(was.column)}`} -> ${now.column === undefined ? `default ${String(now.defaultValue)}` : `column ${col(now.column)}`}`)
    else if (now.column === undefined && String(was.defaultValue) !== String(now.defaultValue)) out.push(`${label(name)}: default ${String(was.defaultValue)} -> ${String(now.defaultValue)}`)
    else if (now.column !== undefined && (active.hasHeaderRow ? (was.header ?? '') !== (now.header ?? '') : was.column !== now.column)) out.push(`${label(name)}: column ${was.header ?? col(was.column)} -> ${now.header ?? col(now.column)}`)
    if (Boolean(was.doValueMapping) !== Boolean(now.doValueMapping)) out.push(`${label(name)}: ${now.doValueMapping ? 'map values' : 'do not map values'}`)
    const wv = was.valueMappings ?? {}
    const nv = now.valueMappings ?? {}
    const changed = [...new Set([...Object.keys(wv), ...Object.keys(nv)])].filter((k) => String(wv[k] ?? '') !== String(nv[k] ?? ''))
    if (changed.length) out.push(`${label(name)}: value mappings changed for ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}`)
  }
  return out
}

/**
 * Bulk edit (BULK_EDIT_FORM): the switched-on fields' values plus `bulkEditEnabledFields`; an enabled
 * field without a value is sent as `""`, which clears it (a JSON null in `values` fails the step).
 */
export function bulkEditValues(values: Record<string, unknown>, enabled: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of enabled) out[name] = values[name] === undefined || values[name] === null ? '' : values[name]
  out.bulkEditEnabledFields = enabled.join(',')
  return out
}

/**
 * The template files the upload instructions link to (`data:` URIs in `{step}.html`): name and
 * bytes, in page order (`Person - Flat.csv`, `Person - Tall.csv`, …).
 */
export function uploadTemplates(html: unknown): Array<{ name: string; bytes: Uint8Array; contentType: string }> {
  if (typeof html !== 'string') return []
  const out: Array<{ name: string; bytes: Uint8Array; contentType: string }> = []
  const re = /<a\b[^>]*?href="data:([^;,"]*)(;base64)?,([^"]*)"[^>]*?download="([^"]*)"[^>]*>|<a\b[^>]*?download="([^"]*)"[^>]*?href="data:([^;,"]*)(;base64)?,([^"]*)"[^>]*>/gi
  for (const m of html.matchAll(re)) {
    const [contentType, b64, data, name] = m[1] !== undefined ? [m[1], m[2], m[3], m[4]] : [m[6], m[7], m[8], m[5]]
    const bytes = b64 ? Uint8Array.from(atob(data ?? ''), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data ?? ''))
    out.push({ name: decodeEntities(name ?? 'template'), bytes, contentType: contentType || 'application/octet-stream' })
  }
  return out
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** Drops undefined members (so mappings compare and serialize cleanly). */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k]
  return o
}
