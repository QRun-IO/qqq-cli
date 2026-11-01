/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The printing extension (qbit-printing, `printing` 2.x): printers, print devices (agents) and
 * print jobs, printing records, following and cancelling jobs. The extension's own operations
 * are the print agent's (device enrollment, claims, events); what a person does goes through the
 * qbit's tables and processes, which this module wraps:
 *
 * - `printing_printer`, `printing_device`, `printing_job` (read-only tables)
 * - `printingPrintRecords_{table}`: Print on the records of a table the server enabled it for
 *   (values `printingPrinterId`, `printingCopies`; the queued job ids come back in `printingJobIds`)
 * - `printingCancelSelectedJobs`: cancel jobs still queued in QQQ
 * - `printingPrintTableList` (printing 2.1): a table list of any table: columns, widths, filter and
 *   sort, the current page or all rows (up to 10,000); `printingPrintText`: text such as a screen
 *   capture, as a monospace PDF
 *
 * Every call needs the extension (ExtensionNotInstalledError otherwise). The printer chosen last
 * is remembered per profile in config.json (`printing.printers[profile]`).
 */

import type { CallInput, CallResult } from '../api/call.js'
import { readConfig, writeConfig } from '../session/profiles.js'
import { downloadReference } from '../process/screen.js'
import { exportFileName } from '../render/files.js'
import type { ExtensionRegistry } from './registry.js'

export const PRINTING = 'printing'
export const PRINT_PROCESS_PREFIX = 'printingPrintRecords_'
export const CANCEL_JOBS_PROCESS = 'printingCancelSelectedJobs'
export const PRINTER_FIELD = 'printingPrinterId'
export const COPIES_FIELD = 'printingCopies'
export const JOB_IDS_VALUE = 'printingJobIds'
export const TABLE_LIST_PROCESS = 'printingPrintTableList'
export const TEXT_PROCESS = 'printingPrintText'
/** Renders a record sheet, table list or text page to a PDF download (Save as PDF). */
export const RENDER_PROCESS = 'printingRenderToPdf'
/** The most rows the server prints in one table list. */
export const MAX_LIST_ROWS = 10_000
/** "All rows" is the default list choice up to this many rows (or whenever the grid is filtered). */
export const SMALL_LIST_ROWS = 2_000

/** Job states after which nothing more happens to a job. */
export const FINAL_JOB_STATES = ['SPOOLED', 'SPOOLER_COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN'] as const
/** Job states that mean it did not print (or might not have). */
export const FAILED_JOB_STATES = ['FAILED', 'OUTCOME_UNKNOWN'] as const

export interface Printer {
  /** The printer row id (what Print takes). */
  id: string
  name: string
  /** The agent's own id for it. */
  printerId?: string
  deviceId?: string
  device?: string
  /** READY, OFFLINE, PAUSED, ERROR, UNKNOWN as the agent last reported. */
  status?: string
  /** Approved for printing by an administrator. */
  approved: boolean
  /** In the device's current inventory. */
  exposed: boolean
  formats: string[]
  location?: string
  description?: string
  lastSeenAt?: string
}

export interface PrintDevice {
  id: string
  name: string
  /** ONLINE, OFFLINE, PAUSED, DISCONNECTED, REVOKED, UNKNOWN. */
  status?: string
  agentVersion?: string
  location?: string
  facility?: string
  lastSeenAt?: string
}

export interface PrintJob {
  id: string
  title: string
  /** QUEUED, CLAIMED, RECEIVED, SUBMITTING, SPOOLED, SPOOLER_COMPLETED, FAILED, OUTCOME_UNKNOWN. */
  status: string
  printer?: string
  printerRowId?: string
  device?: string
  deviceId?: string
  format?: string
  copies?: number
  createdAt?: string
  message?: string
  spoolerJobId?: string
}

/** How the module reaches the server: the kernel's callOperation and a process runner. */
export interface PrintingTransport {
  call(id: string, input: CallInput): Promise<CallResult>
  /** Runs a process to its end with these values and selected record ids; returns its final values. */
  runProcess(processName: string, options: { values: Record<string, unknown>; recordIds: string[] }): Promise<Record<string, unknown>>
  /** Fetches a process download (GET /download/{file}); needed for Save as PDF. */
  download?(reference: { fileName: string; query: Record<string, string> }): Promise<{ bytes: Uint8Array; contentType: string }>
}

interface QueryRecord {
  values?: Record<string, unknown>
  displayValues?: Record<string, unknown>
  recordLabel?: string
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))

function formatsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return raw.split(',').map((f) => f.trim()).filter(Boolean)
  }
}

export function printerOf(r: QueryRecord): Printer {
  const v = r.values ?? {}
  const d = r.displayValues ?? {}
  return {
    id: String(v.id ?? ''),
    name: str(v.name) ?? r.recordLabel ?? String(v.id ?? ''),
    printerId: str(v.printer_id),
    deviceId: str(v.device_id),
    device: str(d.device_id) ?? str(v.device_id),
    status: str(v.status),
    approved: Number(v.enabled) === 1,
    exposed: Number(v.available) === 1,
    formats: formatsOf(v.formats),
    location: str(v.location),
    description: str(v.description),
    lastSeenAt: str(v.last_seen_at),
  }
}

export function deviceOf(r: QueryRecord): PrintDevice {
  const v = r.values ?? {}
  const d = r.displayValues ?? {}
  return {
    id: String(v.id ?? ''),
    name: str(v.name) ?? r.recordLabel ?? String(v.id ?? ''),
    status: str(v.device_status) ?? str(d.device_status),
    agentVersion: str(v.agent_version),
    location: str(v.location),
    facility: str(d.facility_id) ?? str(v.facility_id),
    lastSeenAt: str(v.last_seen_at),
  }
}

export function jobOf(r: QueryRecord): PrintJob {
  const v = r.values ?? {}
  const d = r.displayValues ?? {}
  let copies: number | undefined
  try {
    const options = typeof v.options_json === 'string' ? JSON.parse(v.options_json) : undefined
    if (options && typeof options.copies === 'number') copies = options.copies
  } catch {
    copies = undefined
  }
  return {
    id: String(v.id ?? ''),
    title: str(v.title) ?? r.recordLabel ?? '',
    status: str(v.status) ?? 'UNKNOWN',
    printer: str(d.printer_row_id),
    printerRowId: str(v.printer_row_id),
    device: str(d.device_id),
    deviceId: str(v.device_id),
    format: str(v.format),
    copies,
    createdAt: str(v.created_at),
    message: str(v.message),
    spoolerJobId: str(v.spooler_job_id),
  }
}

/** True once nothing more will happen to the job. */
export function isFinalJobState(status: string | undefined): boolean {
  return (FINAL_JOB_STATES as readonly string[]).includes(String(status))
}

/** A printer can take a record print: approved, exposed, PDF. */
export function canPrintTo(printer: Printer): boolean {
  return printer.approved && printer.exposed && printer.formats.includes('PDF')
}

/** Why a printer cannot take a record print, or undefined when it can. */
export function whyNotPrintable(printer: Printer): string | undefined {
  if (!printer.exposed) return 'its device does not currently expose it'
  if (!printer.approved) return 'it is not approved for printing'
  if (!printer.formats.includes('PDF')) return 'it does not take PDF'
  return undefined
}

/** The Print process of a table (it exists only where the server enabled printing for the table). */
export function printProcessName(table: string): string {
  return `${PRINT_PROCESS_PREFIX}${table}`
}

/** Whether the server can print table lists and text (printing 2.1 processes in the metadata). */
export function canPrintLists(meta: { processes?: Record<string, unknown> } | undefined): boolean {
  return Boolean(meta?.processes?.[TABLE_LIST_PROCESS]) && Boolean(meta?.processes?.[TEXT_PROCESS])
}

/**
 * The header and footer every printed page carries (printing 0.4.1+ renderers): the app or
 * instance name, the screen title or breadcrumb, the server, the user and the printed-at time in
 * the user's date format on top; the client's footer (`qqq ui 1.0.1 · server`), a grid's filter and
 * sort, and the page number at the bottom.
 */
export interface PrintChrome {
  app?: string
  title?: string
  server?: string
  user?: string
  printedAt?: string
  footerLeft?: string
  footerNote?: string
}

/** The process values of a chrome (blank fields left out: the server's defaults apply). */
export function chromeValues(chrome: PrintChrome | undefined): Record<string, string> {
  if (!chrome) return {}
  const out: Record<string, string> = {}
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value.trim()) out[key] = value.trim()
  }
  put('headerApp', chrome.app)
  put('headerTitle', chrome.title)
  put('headerServer', chrome.server)
  put('headerUser', chrome.user)
  put('headerPrintedAt', chrome.printedAt)
  put('footerLeft', chrome.footerLeft)
  put('footerNote', chrome.footerNote)
  return out
}

/** One section of a screen's content: a panel's title (blank for none) and its lines. */
export interface ContentSection {
  title: string
  lines: string[]
}

/** Whether the server can render documents to a PDF download ("Save as PDF"). */
export function canSaveAsPdf(meta: { processes?: Record<string, unknown> } | undefined): boolean {
  return Boolean(meta?.processes?.[RENDER_PROCESS])
}

/** What Save as PDF renders: a record sheet, a table list, or a text page. */
export type RenderRequest =
  | { kind: 'record'; table: string; id: string }
  | { kind: 'list'; list: Omit<TableListRequest, 'printer' | 'copies'> }
  | { kind: 'text'; title: string; subtitle?: string; text: string; sections?: ContentSection[]; orientation?: 'PORTRAIT' | 'LANDSCAPE' }

/** A PDF rendered for the client: the default file name (stamped), the server's name, the bytes, and a note. */
export interface RenderedPdf {
  fileName: string
  serverName: string
  bytes: Uint8Array
  message?: string
}

/** The process values of a render request. */
export function renderValues(request: RenderRequest, chrome?: PrintChrome): Record<string, unknown> {
  const header = chromeValues(chrome)
  if (request.kind === 'record') return { kind: 'RECORD', tableName: request.table, recordId: request.id, ...header }
  if (request.kind === 'text') return { kind: 'TEXT', title: request.title, ...(request.subtitle ? { subtitle: request.subtitle } : {}), text: request.text, ...(request.sections?.length ? { sections: JSON.stringify(request.sections) } : {}), orientation: request.orientation ?? 'PORTRAIT', pageSize: 'LETTER', ...header }
  const values = tableListValues({ ...request.list, printer: '' })
  delete values[PRINTER_FIELD]
  delete values[COPIES_FIELD]
  return { kind: 'LIST', ...values, ...header }
}

/** What a grid print covers. */
export type ListScope = { kind: 'all' } | { kind: 'page'; skip: number; limit: number } | { kind: 'selected'; ids: string[] } | { kind: 'sheets'; ids: string[] }

export interface ListScopeChoice {
  label: string
  value: ListScope
  detail?: string
}

/**
 * The choices of a grid print, the default first: all rows (current filter and sort; the default
 * when the grid is filtered or has at most SMALL_LIST_ROWS rows), this page, the selected rows as a
 * list, and a record sheet per selected row (when the table has Print). Over MAX_LIST_ROWS, "all"
 * says it prints the first 10,000.
 */
export function listScopeChoices(grid: { total?: number; pageIndex: number; pageSize: number; pageRows: number; selected: string[]; filtered: boolean; recordSheets: boolean }): ListScopeChoice[] {
  const total = grid.total
  const fmt = (n: number) => n.toLocaleString('en-US')
  const all: ListScopeChoice = total !== undefined && total > MAX_LIST_ROWS
    ? { label: `First ${fmt(MAX_LIST_ROWS)} of ${fmt(total)} rows (current filter and sort)`, value: { kind: 'all' }, detail: `the print limit is ${fmt(MAX_LIST_ROWS)} rows; narrow the filter for the rest` }
    : { label: `All ${total === undefined ? '' : `${fmt(total)} `}rows (current filter and sort)`, value: { kind: 'all' } }
  const skip = grid.pageIndex * grid.pageSize
  const page: ListScopeChoice = { label: `This page (rows ${fmt(grid.pageRows ? skip + 1 : 0)}-${fmt(skip + grid.pageRows)})`, value: { kind: 'page', skip, limit: grid.pageSize } }
  const allFirst = grid.filtered || total === undefined || total <= SMALL_LIST_ROWS
  const out = allFirst ? [all, page] : [page, all]
  if (grid.selected.length) {
    out.push({ label: `Selected rows (${fmt(grid.selected.length)}) as a list`, value: { kind: 'selected', ids: grid.selected } })
    if (grid.recordSheets) out.push({ label: `A record sheet for each selected row (${fmt(grid.selected.length)})`, value: { kind: 'sheets', ids: grid.selected } })
  }
  return out
}

/** Whether metadata offers Print on a table. */
export function tableHasPrint(meta: { processes?: Record<string, unknown> } | undefined, table: string): boolean {
  return Boolean(meta?.processes?.[printProcessName(table)])
}

/**
 * Finds a printer by row id, agent printer id, exact name (any case) or a unique name prefix.
 * Throws with the choices when nothing or more than one matches.
 */
export function resolvePrinter(printers: Printer[], wanted: string): Printer {
  const w = wanted.trim().toLowerCase()
  const exact = printers.filter((p) => p.id.toLowerCase() === w || p.printerId?.toLowerCase() === w || p.name.toLowerCase() === w)
  if (exact.length === 1) return exact[0]!
  const prefix = exact.length ? exact : printers.filter((p) => p.name.toLowerCase().startsWith(w))
  if (prefix.length === 1) return prefix[0]!
  const names = printers.map((p) => p.name).join(', ') || 'none'
  throw new Error(prefix.length ? `"${wanted}" matches more than one printer: ${prefix.map((p) => p.name).join(', ')}` : `no printer "${wanted}" (printers: ${names})`)
}

/** The job ids a Print run returned (the process value printingJobIds). */
export function jobIdsOf(values: Record<string, unknown> | undefined): string[] {
  const raw = values?.[JOB_IDS_VALUE]
  return raw === undefined || raw === null ? [] : String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

/** A one-line summary of job states: `2 SPOOLER_COMPLETED, 1 QUEUED`. */
export function jobStateSummary(jobs: PrintJob[]): string {
  const counts = new Map<string, number>()
  for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1)
  return [...counts].map(([s, n]) => `${n} ${s}`).join(', ')
}

// ---------------------------------------------------------------------------------------------
// remembered printer, per profile
// ---------------------------------------------------------------------------------------------

export interface RememberedPrinter {
  id: string
  name?: string
}

interface PrintingSection {
  printers?: Record<string, RememberedPrinter>
}

/** The printer last chosen on this profile, if any. */
export function readRememberedPrinter(profile: string, env: NodeJS.ProcessEnv = process.env): RememberedPrinter | undefined {
  const section = readConfig(env).printing as PrintingSection | undefined
  return section?.printers?.[profile]
}

/** Remembers (or with undefined forgets) the printer of a profile. */
export function writeRememberedPrinter(profile: string, printer: RememberedPrinter | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const section: PrintingSection = { ...((config.printing as PrintingSection | undefined) ?? {}) }
  const printers = { ...(section.printers ?? {}) }
  if (printer) printers[profile] = { id: printer.id, ...(printer.name ? { name: printer.name } : {}) }
  else delete printers[profile]
  section.printers = printers
  config.printing = section
  writeConfig(config, env)
}

// ---------------------------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------------------------

export interface PrintRequest {
  table: string
  ids: string[]
  /** Printer row id. */
  printer: string
  copies?: number
  chrome?: PrintChrome
}

export interface TableListRequest {
  table: string
  /** Field names in the order the grid shows them. */
  columns: string[]
  /** The grid's column widths in characters, same order (optional). */
  widths?: number[]
  /** The grid's query filter, with its orderBys. */
  filter: Record<string, unknown>
  scope: ListScope
  title?: string
  /** The filter as the user sees it (for the page header). */
  filterDescription?: string
  /** Printer row id. */
  printer: string
  copies?: number
  orientation?: 'AUTO' | 'PORTRAIT' | 'LANDSCAPE'
  pageSize?: 'LETTER' | 'A4'
  /** The primary key field, for a selection. */
  primaryKeyField?: string
  chrome?: PrintChrome
}

export interface TextRequest {
  title: string
  subtitle?: string
  text: string
  /** A screen's content as sections (printed instead of the raw text when given). */
  sections?: ContentSection[]
  chrome?: PrintChrome
  printer: string
  copies?: number
  orientation?: 'PORTRAIT' | 'LANDSCAPE'
}

/** What a list or text print queued, and the server's note (a row-limit message). */
export interface PrintOutcome {
  jobIds: string[]
  message?: string
  truncated?: boolean
}

/** The process values of a table list print (exported for tests and other clients). */
export function tableListValues(request: TableListRequest): Record<string, unknown> {
  const { orderBys, ...rest } = request.filter as { orderBys?: unknown }
  const base: Record<string, unknown> = { criteria: [], booleanOperator: 'AND', ...rest, ...(orderBys ? { orderBys } : {}) }
  delete base.skip
  delete base.limit
  let filter: Record<string, unknown> = base
  let scope = 'ALL'
  if (request.scope.kind === 'page') {
    filter = { ...base, skip: request.scope.skip, limit: request.scope.limit }
    scope = 'PAGE'
  } else if (request.scope.kind === 'selected') {
    filter = { criteria: [{ fieldName: request.primaryKeyField ?? 'id', operator: 'IN', values: request.scope.ids }], booleanOperator: 'AND', ...(orderBys ? { orderBys } : {}) }
  } else if (request.scope.kind === 'sheets') {
    throw new Error('record sheets are printed with print(), not as a list')
  }
  return {
    tableName: request.table,
    columns: request.columns.join(','),
    ...(request.widths?.length === request.columns.length ? { columnWidths: request.widths.join(',') } : {}),
    filterJSON: JSON.stringify(filter),
    scope,
    maxRows: MAX_LIST_ROWS,
    ...(request.title ? { title: request.title } : {}),
    ...(request.filterDescription ? { filterDescription: request.filterDescription } : {}),
    orientation: request.orientation ?? 'AUTO',
    pageSize: request.pageSize ?? 'LETTER',
    [PRINTER_FIELD]: request.printer,
    [COPIES_FIELD]: request.copies ?? 1,
    ...chromeValues(request.chrome),
  }
}

export interface WatchOptions {
  /** Called whenever any job's state changes (and once at the start). */
  onChange?: (jobs: PrintJob[]) => void
  intervalMs?: number
  /** Give up after this long (default 120 s); the last states are returned. */
  timeoutMs?: number
  signal?: AbortSignal
}

export class Printing {
  constructor(private readonly registry: ExtensionRegistry, private readonly transport: PrintingTransport) {}

  /** Whether the server has the printing extension. */
  get available(): boolean {
    return this.registry.has(PRINTING)
  }

  private require(): void {
    this.registry.require(PRINTING)
  }

  private async query(table: string, filter: Record<string, unknown>): Promise<QueryRecord[]> {
    this.require()
    const result = await this.transport.call('queryTable', { path: { tableName: table }, json: { filter: { booleanOperator: 'AND', skip: 0, ...filter } } })
    return ((result.data as { records?: QueryRecord[] } | undefined)?.records ?? [])
  }

  /** Every printer the user may see, approved ones first, by name. */
  async printers(options: { printableOnly?: boolean } = {}): Promise<Printer[]> {
    const rows = (await this.query('printing_printer', { criteria: [], orderBys: [{ fieldName: 'name', isAscending: true }], limit: 500 })).map(printerOf)
    const list = options.printableOnly ? rows.filter(canPrintTo) : rows
    return list.sort((a, b) => Number(canPrintTo(b)) - Number(canPrintTo(a)) || a.name.localeCompare(b.name))
  }

  /** The print devices (agents) and their health. */
  async devices(): Promise<PrintDevice[]> {
    return (await this.query('printing_device', { criteria: [], orderBys: [{ fieldName: 'name', isAscending: true }], limit: 500 })).map(deviceOf)
  }

  /** Jobs, newest first; by ids, by state, or the latest `limit`. */
  async jobs(options: { ids?: string[]; status?: string[]; limit?: number } = {}): Promise<PrintJob[]> {
    const criteria: Record<string, unknown>[] = []
    if (options.ids?.length) criteria.push({ fieldName: 'id', operator: 'IN', values: options.ids })
    if (options.status?.length) criteria.push({ fieldName: 'status', operator: 'IN', values: options.status.map((s) => s.toUpperCase()) })
    const rows = await this.query('printing_job', { criteria, orderBys: [{ fieldName: 'created_at', isAscending: false }], limit: options.limit ?? (options.ids?.length || 50) })
    return rows.map(jobOf)
  }

  /** One job, or undefined when it does not exist (or is not visible). */
  async job(id: string): Promise<PrintJob | undefined> {
    return (await this.jobs({ ids: [id] }))[0]
  }

  /** Prints records of a table on a printer; returns the queued job ids. */
  async print(request: PrintRequest): Promise<string[]> {
    this.require()
    if (!request.ids.length) throw new Error('nothing to print: no record ids')
    const copies = request.copies ?? 1
    if (!Number.isInteger(copies) || copies < 1 || copies > 100) throw new Error('copies must be 1 to 100')
    const values = await this.transport.runProcess(printProcessName(request.table), { values: { [PRINTER_FIELD]: request.printer, [COPIES_FIELD]: copies, ...chromeValues(request.chrome) }, recordIds: request.ids })
    return jobIdsOf(values)
  }

  /** Prints a table list (needs printing 2.1); returns the job and the server's row-limit note. */
  async printTableList(request: TableListRequest): Promise<PrintOutcome> {
    this.require()
    const values = await this.transport.runProcess(TABLE_LIST_PROCESS, { values: tableListValues(request), recordIds: [] })
    return { jobIds: jobIdsOf(values), message: values.printingMessage === undefined ? undefined : String(values.printingMessage), truncated: values.printingTruncated === true || values.printingTruncated === 'true' }
  }

  /** Prints text, such as a screen capture, as a monospace PDF (needs printing 2.1). */
  async printText(request: TextRequest): Promise<PrintOutcome> {
    this.require()
    if (!request.text.trim()) throw new Error('nothing to print: the text is empty')
    const values = await this.transport.runProcess(TEXT_PROCESS, { values: { ...chromeValues(request.chrome), title: request.title, ...(request.subtitle ? { subtitle: request.subtitle } : {}), text: request.text, ...(request.sections?.length ? { sections: JSON.stringify(request.sections) } : {}), orientation: request.orientation ?? 'PORTRAIT', pageSize: 'LETTER', [PRINTER_FIELD]: request.printer, [COPIES_FIELD]: request.copies ?? 1 }, recordIds: [] })
    return { jobIds: jobIdsOf(values) }
  }

  /**
   * Renders a record sheet, table list or text page to a PDF on the server (no printer, no job)
   * and downloads it; the default name is the server's (the document title) with the date and
   * time stamp downloads and exports use: `Customer-Ada-Lovelace_2026-11-01_120301.pdf`.
   */
  async renderToPdf(request: RenderRequest, now: Date = new Date(), chrome?: PrintChrome): Promise<RenderedPdf> {
    this.require()
    if (!this.transport.download) throw new Error('this client cannot download process files')
    if (request.kind === 'text' && !request.text.trim()) throw new Error('nothing to save: the text is empty')
    const values = await this.transport.runProcess(RENDER_PROCESS, { values: renderValues(request, chrome), recordIds: [] })
    const reference = downloadReference(values)
    if (!reference) throw new Error('the server rendered no PDF (no download in its answer)')
    const { bytes } = await this.transport.download(reference)
    return { fileName: exportFileName(reference.fileName, 'pdf', now), serverName: reference.fileName, bytes, message: values.printingMessage === undefined ? undefined : String(values.printingMessage) }
  }

  /** Cancels jobs still queued in QQQ (jobs a device has taken must be handled at the device). */
  async cancel(ids: string[]): Promise<void> {
    this.require()
    await this.transport.runProcess(CANCEL_JOBS_PROCESS, { values: {}, recordIds: ids })
  }

  /** Follows jobs until every one is final (or the timeout / signal); returns their last states. */
  async watch(ids: string[], options: WatchOptions = {}): Promise<PrintJob[]> {
    const interval = options.intervalMs ?? 1000
    const deadline = Date.now() + (options.timeoutMs ?? 120000)
    let last = ''
    let jobs: PrintJob[] = []
    for (;;) {
      jobs = await this.jobs({ ids })
      const key = jobs.map((j) => `${j.id}:${j.status}`).join(',')
      if (key !== last) {
        last = key
        options.onChange?.(jobs)
      }
      if ((jobs.length >= ids.length && jobs.every((j) => isFinalJobState(j.status))) || Date.now() >= deadline || options.signal?.aborted) return jobs
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval)
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
}
