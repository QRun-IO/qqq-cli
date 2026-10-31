/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The screen model of a process step: each frontend component, in declared order, turned into a
 * neutral block both heads render (the CLI prints, the TUI draws). Help text and HTML become text,
 * VIEW_FORM label/value pairs, RECORD_LIST a page of the process records, the validation review
 * its counts and choice, PROCESS_SUMMARY_RESULTS status lines, DOWNLOAD_FORM a file reference,
 * WIDGET the widget render model. Edit forms are only named here: input comes from the runner's
 * provider (UI-API-CLIENTS.md section 3).
 */

import { callOperation } from '../api/call.js'
import type { Row } from '../render/output.js'
import type { FieldMeta, FieldValues } from '../forms/fields.js'
import { htmlToText, widgetToBlocks, type RenderBlock } from '../widgets/render-model.js'
import { helpContentText } from '../help/help-content.js'

/** One line of PROCESS_SUMMARY_RESULTS or of a validation summary. */
export interface SummaryLine {
  status: string
  count?: number
  message: string
  bullets?: string[]
  /** Link to records the line is about, as text (table and id or primary keys). */
  link?: string
}

/** A page of the records held in a process run. */
export interface ProcessRecordsPage {
  records: Array<Record<string, unknown>>
  totalRecords: number
}

export type ScreenBlock =
  | { kind: 'help'; text: string; preview?: string; source: 'component' | 'step' | 'process' }
  | { kind: 'html'; text: string }
  | { kind: 'view'; pairs: Array<{ name: string; label: string; value: string; error?: boolean }> }
  | { kind: 'records'; columns: string[]; headers: string[]; rows: Row[]; total: number }
  | { kind: 'review'; recordCount?: number; previewMessage?: string; supportsFullValidation: boolean; summary?: SummaryLine[]; preview?: { columns: string[]; headers: string[]; rows: Row[]; total: number } }
  | { kind: 'summary'; lines: SummaryLine[] }
  | { kind: 'download'; fileName: string; query: Record<string, string> }
  | { kind: 'widget'; name?: string; blocks: RenderBlock[] }
  | { kind: 'form'; type: string }
  | { kind: 'unavailable'; type: string; text: string }

/** What a step looks like to the screen builder (a FrontendStep). */
export interface ScreenStep {
  name: string
  label?: string
  components?: Array<{ type: string; values?: Record<string, unknown> }>
  formFields?: FieldMeta[]
  viewFields?: FieldMeta[]
  recordListFields?: FieldMeta[]
  helpContents?: Array<{ contentAsText?: string; content?: string; format?: string; summary?: string; roles?: string[] }>
  [key: string]: unknown
}

export interface ScreenOptions {
  baseUrl: string
  fetch: typeof fetch
  processName: string
  processUUID: string
  step: ScreenStep
  values: FieldValues
  /** Most RECORD_LIST records to fetch (paged by `pageSize`); default 100. */
  recordLimit?: number
  /** Records previewed on a validation review screen; default 10 (0: none). */
  previewLimit?: number
  pageSize?: number
  /** Formats a value for display (DATE_TIME in the local zone, etc.), given the server's display value when there is one; default {@link formatValue}. */
  format?: (field: FieldMeta, value: unknown, displayValue?: unknown) => string
  tableVariant?: string
}

/** Formats a process value for a field: booleans as Yes/No, objects as JSON, the rest as text. */
export function formatValue(field: FieldMeta, value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (field.type === 'BOOLEAN') {
    if (value === true || value === 'true') return 'Yes'
    if (value === false || value === 'false') return 'No'
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Reads summary lines (processResults, validationSummary), composing `count message` as the web does. */
export function summaryLines(value: unknown): SummaryLine[] {
  if (!Array.isArray(value)) return []
  return value.filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object').map((l) => {
    const linked = l.tableName && (l.recordId !== undefined && l.recordId !== null || l.filter)
    const message = linked
      ? `${String(l.linkPreText ?? '')}${String(l.linkText ?? l.tableName)}${String(l.linkPostText ?? '')}`
      : String(l.message ?? '').replace(/\s+/g, ' ').trim()
    const keys = Array.isArray(l.primaryKeys) ? (l.primaryKeys as unknown[]).filter((k) => k !== null && k !== undefined) : []
    return {
      status: typeof l.status === 'string' ? l.status : 'INFO',
      count: typeof l.count === 'number' ? l.count : undefined,
      message,
      bullets: Array.isArray(l.bulletsOfText) && l.bulletsOfText.length ? (l.bulletsOfText as unknown[]).map(String) : undefined,
      link: linked ? (l.recordId !== undefined && l.recordId !== null ? `${String(l.tableName)} ${String(l.recordId)}` : `${String(l.tableName)} (filtered)`) : keys.length ? `ids ${keys.slice(0, 20).join(',')}${keys.length > 20 ? ',…' : ''}` : undefined,
    }
  })
}

/** One summary line as text: `[OK] 2 were cloned`. */
export function summaryLineText(line: SummaryLine): string {
  const head = `[${line.status}] ${line.count !== undefined ? `${line.count.toLocaleString('en-US')} ` : ''}${line.message}`
  return [head, ...(line.bullets ?? []).map((b) => `    • ${b}`)].join('\n')
}

/** GET …/records: one page of the records a process run holds. */
export async function fetchProcessRecords(baseUrl: string, fetchImpl: typeof fetch, processName: string, processUUID: string, skip: number, limit: number, tableVariant?: string): Promise<ProcessRecordsPage> {
  const result = await callOperation(baseUrl, 'getProcessRecords', { path: { processName, processUUID }, query: { skip: String(skip), limit: String(limit), tableVariant } }, fetchImpl)
  const body = (result.data ?? {}) as { records?: unknown; totalRecords?: unknown }
  const records = Array.isArray(body.records) ? body.records as Array<Record<string, unknown>> : []
  return { records, totalRecords: typeof body.totalRecords === 'number' ? body.totalRecords : records.length }
}

/** Fetches up to `limit` records of a run, page by page. */
export async function fetchProcessRecordsUpTo(baseUrl: string, fetchImpl: typeof fetch, processName: string, processUUID: string, limit: number, pageSize = 50, tableVariant?: string): Promise<ProcessRecordsPage> {
  const records: Array<Record<string, unknown>> = []
  let total = 0
  for (let skip = 0; records.length < limit; skip += pageSize) {
    const page = await fetchProcessRecords(baseUrl, fetchImpl, processName, processUUID, skip, Math.min(pageSize, limit - records.length), tableVariant)
    total = page.totalRecords
    records.push(...page.records)
    if (page.records.length === 0 || records.length >= total) break
  }
  return { records, totalRecords: Math.max(total, records.length) }
}

/** The query of `GET /download/{file}` for a DOWNLOAD_FORM, from the process values; undefined when they name no file. */
export function downloadReference(values: FieldValues): { fileName: string; query: Record<string, string> } | undefined {
  const fileName = typeof values.downloadFileName === 'string' && values.downloadFileName ? values.downloadFileName : undefined
  if (!fileName) return undefined
  if (typeof values.serverFilePath === 'string' && values.serverFilePath) return { fileName, query: { filePath: values.serverFilePath } }
  if (typeof values.storageTableName === 'string' && typeof values.storageReference === 'string') return { fileName, query: { storageTableName: values.storageTableName, storageReference: values.storageReference } }
  return undefined
}

/** Downloads a DOWNLOAD_FORM file (GET /download/{file}); returns its bytes and content type. */
export async function downloadProcessFile(baseUrl: string, fetchImpl: typeof fetch, reference: { fileName: string; query: Record<string, string> }): Promise<{ bytes: Uint8Array; contentType: string }> {
  const result = await callOperation(baseUrl, 'download', { path: { file: reference.fileName }, query: reference.query }, fetchImpl)
  const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? ''))
  return { bytes, contentType: result.contentType }
}

/** Help entries as text (contentAsText, else content with tags stripped). */
export function helpText(entries: ScreenStep['helpContents'] | undefined): string[] {
  return (entries ?? []).map((h) => helpContentText(h as Record<string, unknown>) || String(h.summary ?? '')).map((t) => t.trim()).filter(Boolean)
}

/** Process-level help (`helpContents` by slot) as text, in slot order. */
export function processHelpText(meta: { helpContents?: Record<string, ScreenStep['helpContents']> }): string[] {
  return Object.values(meta.helpContents ?? {}).flatMap((entries) => helpText(entries))
}

function recordTable(fields: FieldMeta[], records: Array<Record<string, unknown>>, format: (f: FieldMeta, v: unknown, d?: unknown) => string): { columns: string[]; headers: string[]; rows: Row[] } {
  const shown = fields.filter((f) => !f.isHidden)
  const columns = shown.length ? shown.map((f) => f.name) : Object.keys((records[0]?.values ?? {}) as Record<string, unknown>).slice(0, 8)
  const byName = Object.fromEntries(shown.map((f) => [f.name, f]))
  const rows = records.map((r) => {
    const values = (r.values ?? {}) as Record<string, unknown>
    const display = (r.displayValues ?? {}) as Record<string, unknown>
    return Object.fromEntries(columns.map((c) => {
      const field = byName[c] ?? { name: c, label: c, type: 'STRING' }
      // the server's display value wins, except for DATE_TIME, which the formatter shows in the local zone (or the server's declared zone)
      const text = field.type !== 'DATE_TIME' && display[c] !== undefined && display[c] !== null ? String(display[c]) : format(field, values[c], display[c])
      return [c, text]
    }))
  })
  return { columns, headers: columns.map((c) => byName[c]?.label ?? c), rows }
}

/**
 * Builds the screen of a step from its components and the current process values. Fetches what
 * components need from the server (records, named widgets); a failure there becomes an
 * `unavailable` block rather than stopping the run.
 */
export async function buildScreen(options: ScreenOptions): Promise<ScreenBlock[]> {
  const { step, values, baseUrl, fetch: fetchImpl, processName, processUUID } = options
  const format = options.format ?? formatValue
  const blocks: ScreenBlock[] = []
  for (const text of helpText(step.helpContents)) blocks.push({ kind: 'help', text, source: 'step' })
  for (const component of step.components ?? []) {
    const cv = component.values ?? {}
    switch (component.type) {
      case 'HELP_TEXT': {
        const text = typeof cv.text === 'string' ? cv.text : typeof values.text === 'string' ? values.text : ''
        const preview = typeof cv.previewText === 'string' ? cv.previewText : typeof values.previewText === 'string' ? values.previewText : undefined
        if (text) blocks.push({ kind: 'help', text, preview, source: 'component' })
        break
      }
      case 'HTML': {
        const raw = values[`${step.name}.html`]
        if (typeof raw === 'string' && raw.trim()) blocks.push({ kind: 'html', text: htmlToText(raw) })
        break
      }
      case 'VIEW_FORM': {
        const names = Array.isArray(cv.includeFieldNames) ? new Set(cv.includeFieldNames as string[]) : undefined
        const fields = (step.viewFields ?? []).filter((f) => !f.isHidden && (!names || names.has(f.name)))
        // a VIEW_FORM on a step without viewFields shows its form fields' current values (the sample's Screen 1)
        const source = fields.length ? fields : (step.formFields ?? []).filter((f) => !f.isHidden && (!names || names.has(f.name)) && values[f.name] !== undefined)
        const pairs = source.map((f) => ({ name: f.name, label: f.label ?? f.name, value: format(f, values[f.name]), error: f.adornments?.some((a) => a.type === 'ERROR') || undefined }))
          .filter((p) => !p.error || p.value)
        if (pairs.length) blocks.push({ kind: 'view', pairs })
        break
      }
      case 'RECORD_LIST': {
        try {
          const page = await fetchProcessRecordsUpTo(baseUrl, fetchImpl, processName, processUUID, options.recordLimit ?? 100, options.pageSize, options.tableVariant)
          blocks.push({ kind: 'records', ...recordTable(step.recordListFields ?? [], page.records, format), total: page.totalRecords })
        } catch (error) {
          blocks.push({ kind: 'unavailable', type: component.type, text: `records could not be read: ${error instanceof Error ? error.message : String(error)}` })
        }
        break
      }
      case 'VALIDATION_REVIEW_SCREEN': {
        const summary = summaryLines(values.validationSummary)
        let preview: { columns: string[]; headers: string[]; rows: Row[]; total: number } | undefined
        const limit = options.previewLimit ?? 10
        if (limit > 0) {
          try {
            const page = await fetchProcessRecordsUpTo(baseUrl, fetchImpl, processName, processUUID, limit, limit, options.tableVariant)
            if (page.records.length) preview = { ...recordTable(step.recordListFields ?? [], page.records, format), total: page.totalRecords }
          } catch {
            preview = undefined
          }
        }
        blocks.push({
          kind: 'review',
          recordCount: typeof values.recordCount === 'number' ? values.recordCount : values.recordCount !== undefined ? Number(values.recordCount) : undefined,
          previewMessage: typeof values.previewMessage === 'string' ? values.previewMessage : undefined,
          supportsFullValidation: values.supportsFullValidation === true || values.supportsFullValidation === 'true',
          summary: summary.length ? summary : undefined,
          preview,
        })
        break
      }
      case 'PROCESS_SUMMARY_RESULTS': {
        const lines = summaryLines(values.processResults ?? values.recordListSummary)
        blocks.push({ kind: 'summary', lines })
        break
      }
      case 'DOWNLOAD_FORM': {
        const ref = downloadReference(values)
        if (ref) blocks.push({ kind: 'download', ...ref })
        else blocks.push({ kind: 'unavailable', type: component.type, text: 'the step names no file to download (downloadFileName)' })
        break
      }
      case 'WIDGET': {
        if (cv.isAdHocWidget === true) {
          const nested = (cv.blocks ?? cv.subBlocks) as unknown
          blocks.push({ kind: 'widget', blocks: widgetToBlocks({ type: 'composite', blocks: interpolate(Array.isArray(nested) ? nested : [], values) }) })
          break
        }
        const name = typeof cv.widgetName === 'string' ? cv.widgetName : ''
        if (!name) {
          blocks.push({ kind: 'unavailable', type: component.type, text: 'a WIDGET component that names no widget' })
          break
        }
        try {
          // as the web does: the process values (scalars) and the process UUID are the widget's inputs
          const input: Record<string, string> = { processUUID }
          for (const [k, v] of Object.entries(values)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') input[k] = String(v)
          const seeded = values[name]
          const data = seeded && typeof seeded === 'object' ? { ...(seeded as Record<string, unknown>), hasPermission: true } : (await callOperation(baseUrl, 'getWidgetData', { path: { widgetName: name }, json: input }, fetchImpl)).data
          blocks.push({ kind: 'widget', name, blocks: widgetToBlocks(data) })
        } catch (error) {
          blocks.push({ kind: 'unavailable', type: component.type, text: `widget ${name} could not be loaded: ${error instanceof Error ? error.message : String(error)}` })
        }
        break
      }
      case 'EDIT_FORM':
      case 'BULK_EDIT_FORM':
      case 'BULK_LOAD_FILE_MAPPING_FORM':
      case 'BULK_LOAD_VALUE_MAPPING_FORM':
      case 'BULK_LOAD_PROFILE_FORM':
        blocks.push({ kind: 'form', type: component.type })
        break
      case 'GOOGLE_DRIVE_SELECT_FOLDER':
        blocks.push({ kind: 'unavailable', type: component.type, text: 'choosing a Google Drive folder is only available in the web UI' })
        break
      default:
        blocks.push({ kind: 'unavailable', type: String(component.type), text: `no terminal rendering for ${String(component.type)}` })
    }
  }
  return blocks
}

/** Replaces `${name}` in the text values of ad hoc widget blocks with process values. */
function interpolate(blocks: unknown[], values: FieldValues): unknown[] {
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replace(/\$\{([^}]+)\}/g, (p, n: string) => (values[n] !== undefined && values[n] !== null ? String(values[n]) : p))
    if (Array.isArray(node)) return node.map(visit)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) out[k === 'subBlocks' ? 'blocks' : k === 'blockType' ? 'blockTypeName' : k] = visit(v)
      return out
    }
    return node
  }
  return blocks.map(visit)
}

/** Renders screen blocks as plain text (the CLI; the TUI draws them itself). */
export function screenToText(blocks: ScreenBlock[], render: { table: (rows: Row[], columns: string[], headers: string[]) => string; widget: (blocks: RenderBlock[]) => string }): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case 'help': out.push(b.preview ? `${b.preview}\n${b.text}` : b.text); break
      case 'html': out.push(b.text); break
      case 'view': {
        const w = Math.max(...b.pairs.map((p) => p.label.length), 1)
        out.push(b.pairs.map((p) => (p.error ? `[ERROR] ${p.value}` : `${`${p.label}:`.padEnd(w + 1)}  ${p.value}`)).join('\n'))
        break
      }
      case 'records':
        out.push(b.rows.length ? `${render.table(b.rows, b.columns, b.headers)}\n(${b.rows.length === b.total ? `${b.total} record${b.total === 1 ? '' : 's'}` : `${b.rows.length} of ${b.total} records`})` : '(no records)')
        break
      case 'review': {
        const lines: string[] = []
        if (b.previewMessage) lines.push(b.previewMessage)
        if (b.recordCount !== undefined) lines.push(`${b.recordCount.toLocaleString('en-US')} record${b.recordCount === 1 ? '' : 's'} selected`)
        if (b.preview?.rows.length) lines.push(`${render.table(b.preview.rows, b.preview.columns, b.preview.headers)}${b.preview.total > b.preview.rows.length ? `\n(first ${b.preview.rows.length} of ${b.preview.total})` : ''}`)
        if (b.summary) lines.push('Validation:', ...b.summary.map(summaryLineText))
        out.push(lines.join('\n'))
        break
      }
      case 'summary': out.push(b.lines.length ? b.lines.map(summaryLineText).join('\n') : 'Done.'); break
      case 'download': out.push(`file: ${b.fileName}`); break
      case 'widget': out.push(render.widget(b.blocks)); break
      case 'form': break
      case 'unavailable': out.push(`(${b.type}: ${b.text})`); break
    }
  }
  return out.filter(Boolean).join('\n\n')
}
