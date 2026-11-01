/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The SQL Runner's result side, free of drawing: typed values as text, column widths from the
 * column kinds, the server-paged (and server-sorted) result over GET /executions/{uuid}/rows, the
 * EXPLAIN plan as an indented tree, and quick text bar charts.
 */

import { formatDateValue, type ResolvedDateSettings } from '@qrun-io/qqq-core'
import type { GridColumn } from '../screens/table'

/** A result column as the server describes it. */
export interface SqlColumn {
  name: string
  label?: string
  typeName?: string
  jdbcType?: number
  kind?: 'number' | 'string' | 'boolean' | 'date' | 'datetime' | 'time' | 'json' | 'binary' | 'array' | 'other'
}

/** POST /sql-workbench/execute (read-only runs). */
export interface ExecuteResponse {
  executionUuid: string
  status: string
  mode?: string
  backendName?: string
  columns?: SqlColumn[]
  rows?: unknown[][]
  rowCount?: number
  hasMore?: boolean
  truncated?: boolean
  truncatedReason?: string | null
  durationMs?: number
  rowsAffected?: number | null
  statements?: Array<{ index: number; kind: string; leadingKeyword?: string; affectedRows?: number | null }>
  error?: string
  sqlState?: string | null
}

/** GET /sql-workbench/executions/{uuid}/rows. */
export interface RowsResponse {
  columns?: SqlColumn[]
  rows?: unknown[][]
  offset?: number
  rowCount?: number
  totalRows?: number
  truncated?: boolean
}

export interface PlanNode {
  label: string
  detail?: string | null
  startupCost?: number | null
  totalCost?: number | null
  planRows?: number | null
  actualTimeMs?: number | null
  actualRows?: number | null
  loops?: number | null
  extra?: Record<string, unknown>
  children?: PlanNode[]
}

/** POST /sql-workbench/explain. */
export interface ExplainResponse {
  executionUuid?: string
  status?: string
  dialect?: string
  analyze?: boolean
  plan?: PlanNode
  raw?: string
  error?: string
  sqlState?: string | null
  durationMs?: number | null
}

// ---- values ----

/** A value as one line of text by its column kind: NULL, `<binary N bytes>`, compact JSON, ISO dates as sent. */
export function valueText(value: unknown, kind?: SqlColumn['kind']): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object' && (value as { $binary?: boolean }).$binary) return `<binary ${(value as { length?: number }).length ?? '?'} bytes>`
  if (typeof value === 'object') return JSON.stringify(value)
  if (kind === 'json' && typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return value
    }
  }
  return String(value).replace(/[\r\n\t]+/g, ' ')
}

/** A value in full, for the whole-value view: pretty JSON, binary with its hex preview, text as is. */
export function fullValueText(value: unknown, kind?: SqlColumn['kind']): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object' && (value as { $binary?: boolean }).$binary) {
    const b = value as { length?: number; hexPreview?: string }
    return `binary, ${b.length ?? '?'} bytes\nfirst bytes: ${b.hexPreview ? `0x${b.hexPreview}` : '(none)'}`
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  if (kind === 'json' && typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return String(value)
}

/** A cell as the grid shows it: text, alignment, and whether it is dimmed (NULL). */
export interface CellFormat {
  text: string
  right: boolean
  dim?: boolean
}

/** Key-like number columns (`ID`, `CUSTOMER_ID`, `customerId`) keep their digits ungrouped, as the main grid shows ids. */
const KEY_LIKE = /(^|_)id$|[a-z0-9]Id$|^(year|port|code)$/i

/** Groups the digits of a number's integer part with commas (works on big decimals sent as text). */
export function groupDigits(text: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(text)
  if (!m) return text
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}`
}

/** The date display settings a cell needs (order and clock); YYYY-MM-DD and 24 h unless the profile says otherwise. */
export type DateDisplay = Pick<ResolvedDateSettings, 'order' | 'clock'>
const DEFAULT_DATES: DateDisplay = { order: 'YMD', clock: '24h' }

/**
 * A date or date-time in the profile's display format (the kernel's formatDateValue): seconds only
 * when the value has them, never the fraction; zoned instants in the local zone.
 */
export function dateTimeText(value: string, dates: DateDisplay = DEFAULT_DATES, kind: 'DATE' | 'DATE_TIME' = 'DATE_TIME'): string {
  return formatDateValue(value.trim(), kind, dates)
}

/**
 * The grid's formatting of a SQL value by its column: NULL as a dim `—`; numbers right-aligned with
 * thousands separators (not in key-like columns); booleans as true/false; date-times in the local
 * display format at seconds precision; times without fractions; JSON compact; binary as its size.
 */
export function formatCell(value: unknown, column: SqlColumn, dates: DateDisplay = DEFAULT_DATES): CellFormat {
  if (value === null || value === undefined) return { text: '—', right: column.kind === 'number', dim: true }
  switch (column.kind) {
    case 'number': {
      const raw = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : String(value)) : String(value)
      return { text: KEY_LIKE.test(column.name) ? raw : groupDigits(raw), right: true }
    }
    case 'boolean': return { text: value === true || value === 'true' || value === 1 ? 'true' : 'false', right: false }
    case 'datetime': return { text: typeof value === 'string' ? dateTimeText(value, dates) : valueText(value), right: false }
    case 'date': return { text: typeof value === 'string' ? dateTimeText(value, dates, 'DATE') : valueText(value), right: false }
    case 'time': return { text: String(value).replace(/\.\d+$/, ''), right: false }
    default: return { text: valueText(value, column.kind), right: false }
  }
}

/** Widest a column of a kind starts (its values are cut beyond, V shows them whole). */
const KIND_CAP: Record<string, number> = { number: 24, boolean: 5, date: 10, time: 15, datetime: 27, string: 40, json: 40, array: 30, binary: 22, other: 30 }

/**
 * Column widths from the column kinds and the first rows: the longer of the label and the values,
 * capped per kind; spare width goes to text columns that were cut. Numbers are right-aligned.
 */
export function sqlColumns(columns: SqlColumn[], rows: unknown[][], available: number, dates: DateDisplay = DEFAULT_DATES): GridColumn[] {
  const cols = columns.map((c, i) => {
    const label = c.label || c.name
    const longest = Math.max(label.length + 1, ...rows.slice(0, 200).map((r) => formatCell(r[i], c, dates).text.length), 4)
    const cap = KIND_CAP[c.kind ?? 'other'] ?? 30
    return { name: String(i), label, type: c.kind ?? 'other', numeric: c.kind === 'number', width: Math.min(cap, longest), longest }
  })
  let spare = available - cols.reduce((a, c) => a + c.width + 1, 0)
  for (const c of [...cols].filter((x) => x.longest > x.width && !x.numeric).sort((a, b) => (a.longest - a.width) - (b.longest - b.width))) {
    if (spare <= 0) break
    const add = Math.min(spare, c.longest - c.width, 60 - c.width)
    if (add > 0) {
      c.width += add
      spare -= add
    }
  }
  return cols.map(({ longest: _l, ...c }) => c)
}

// ---- paging ----

export type FetchRows = (offset: number, limit: number, sort?: { column: number; dir: 'asc' | 'desc' }) => Promise<RowsResponse>

/**
 * A server-side result read in chunks: the first chunk comes with the execute response; later rows
 * load on demand through GET /executions/{uuid}/rows; sorting is the server's (type-aware, nulls
 * last) and starts again from the first row.
 */
export class ResultPager {
  readonly columns: SqlColumn[]
  total: number
  truncated: boolean
  truncatedReason?: string | null
  sort?: { column: number; dir: 'asc' | 'desc' }
  loading = false
  error?: string
  private rows = new Map<number, unknown[]>()
  private pending = new Set<number>()
  private generation = 0

  constructor(first: ExecuteResponse, private readonly fetchRows: FetchRows, readonly chunk = 100) {
    this.columns = first.columns ?? []
    this.total = first.rowCount ?? first.rows?.length ?? 0
    this.truncated = Boolean(first.truncated)
    this.truncatedReason = first.truncatedReason
    ;(first.rows ?? []).forEach((r, i) => this.rows.set(i, r))
  }

  get(index: number): unknown[] | undefined {
    return this.rows.get(index)
  }

  /** Whether every row from `start` (count rows, within the total) is loaded. */
  has(start: number, count: number): boolean {
    for (let i = start; i < Math.min(this.total, start + count); i++) if (!this.rows.has(i)) return false
    return true
  }

  /** Loads the chunks that hold rows start..start+count; resolves when they are in. */
  async ensure(start: number, count: number): Promise<void> {
    const chunks = new Set<number>()
    for (let i = Math.max(0, start); i < Math.min(this.total, start + count); i++) if (!this.rows.has(i)) chunks.add(Math.floor(i / this.chunk))
    const gen = this.generation
    const loads = [...chunks].filter((c) => !this.pending.has(c)).map(async (c) => {
      this.pending.add(c)
      this.loading = true
      try {
        const data = await this.fetchRows(c * this.chunk, this.chunk, this.sort)
        if (gen !== this.generation) return
        ;(data.rows ?? []).forEach((r, i) => this.rows.set(c * this.chunk + i, r))
        if (typeof data.rowCount === 'number') this.total = data.rowCount
        this.error = undefined
      } catch (e) {
        if (gen === this.generation) this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.pending.delete(c)
        this.loading = this.pending.size > 0
      }
    })
    await Promise.all(loads)
  }

  /** Sorts by a column: ascending, then descending, then the order of the result. */
  async sortBy(column: number): Promise<void> {
    if (this.sort?.column !== column) this.sort = { column, dir: 'asc' }
    else if (this.sort.dir === 'asc') this.sort = { column, dir: 'desc' }
    else this.sort = undefined
    this.generation++
    this.rows.clear()
    this.pending.clear()
    await this.ensure(0, this.chunk)
  }

  /** The loaded rows from `start` (undefined where not loaded yet). */
  window(start: number, count: number): Array<unknown[] | undefined> {
    const out: Array<unknown[] | undefined> = []
    for (let i = start; i < Math.min(this.total, start + count); i++) out.push(this.rows.get(i))
    return out
  }
}

// ---- EXPLAIN ----

export interface PlanLine {
  /** Path of the node (`0.1.2`), for collapsing. */
  path: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  label: string
  /** "cost 0.00..12.40 · rows 100 · 1.2 ms × 3" when the database reports them. */
  stats: string
  /** This node's total cost as a share of the most expensive node (0..1), when costs are known. */
  share?: number
}

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)
}

/** The plan as lines of an indented tree: children under their parent, collapsed subtrees skipped. */
export function planLines(root: PlanNode, collapsed: Set<string> = new Set()): PlanLine[] {
  let maxCost = 0
  const visit = (n: PlanNode) => {
    if (typeof n.totalCost === 'number') maxCost = Math.max(maxCost, n.totalCost)
    for (const c of n.children ?? []) visit(c)
  }
  visit(root)
  const out: PlanLine[] = []
  const walk = (n: PlanNode, depth: number, path: string) => {
    const kids = n.children ?? []
    const stats: string[] = []
    if (typeof n.totalCost === 'number') stats.push(`cost ${typeof n.startupCost === 'number' ? `${num(n.startupCost)}..` : ''}${num(n.totalCost)}`)
    if (typeof n.planRows === 'number') stats.push(`rows ${num(n.planRows)}`)
    if (typeof n.actualTimeMs === 'number') stats.push(`${num(n.actualTimeMs)} ms${typeof n.loops === 'number' && n.loops > 1 ? ` × ${n.loops}` : ''}`)
    if (typeof n.actualRows === 'number') stats.push(`actual ${num(n.actualRows)}`)
    const isCollapsed = collapsed.has(path)
    out.push({
      path, depth, hasChildren: kids.length > 0, collapsed: isCollapsed,
      label: `${n.label}${n.detail ? ` ${n.detail}` : ''}`.replace(/\s+/g, ' ').trim(),
      stats: stats.join(' · '),
      share: maxCost > 0 && typeof n.totalCost === 'number' ? n.totalCost / maxCost : undefined,
    })
    if (!isCollapsed) kids.forEach((c, i) => walk(c, depth + 1, `${path}.${i}`))
  }
  walk(root, 0, '0')
  return out
}

/** One plan line as text in a width: tree glyph and label on the left, stats and a cost bar on the right. */
export function planLineText(line: PlanLine, width: number, glyph: { open: string; closed: string; bar: string }): string {
  const marker = line.hasChildren ? (line.collapsed ? glyph.closed : glyph.open) : ' '
  const left = `${'  '.repeat(line.depth)}${marker} ${line.label}`
  const bar = line.share !== undefined ? ' ' + glyph.bar.repeat(Math.max(1, Math.round(line.share * 5))).padEnd(5, ' ') : ''
  const right = line.stats ? `${line.stats}${bar}` : ''
  if (!right) return left.length > width ? left.slice(0, Math.max(0, width - 1)) + '…' : left
  const room = width - right.length - 2
  if (room < 12) return left.length > width ? left.slice(0, Math.max(0, width - 1)) + '…' : left
  const l = left.length > room ? left.slice(0, room - 1) + '…' : left.padEnd(room)
  return `${l}  ${right}`
}

// ---- quick charts ----

/** Columns a quick chart can plot: numeric ones. */
export function numericColumns(columns: SqlColumn[]): number[] {
  return columns.map((c, i) => (c.kind === 'number' ? i : -1)).filter((i) => i >= 0)
}

/** Horizontal text bars: one line per row, label column, bar scaled to the largest magnitude, value at the end. */
export function barLines(items: Array<{ label: string; value: number }>, width: number, bar = '█'): string[] {
  if (!items.length) return []
  const labelWidth = Math.min(24, Math.max(...items.map((i) => i.label.length)), Math.max(4, Math.floor(width / 3)))
  const values = items.map((i) => num(i.value))
  const valueWidth = Math.max(...values.map((v) => v.length))
  const barRoom = Math.max(1, width - labelWidth - valueWidth - 2)
  const max = Math.max(...items.map((i) => Math.abs(i.value))) || 1
  return items.map((it, i) => {
    const label = it.label.length > labelWidth ? it.label.slice(0, labelWidth - 1) + '…' : it.label.padEnd(labelWidth)
    const n = Math.round((Math.abs(it.value) / max) * barRoom)
    const b = (it.value < 0 ? '-' : '') + bar.repeat(Math.max(it.value === 0 ? 0 : 1, n - (it.value < 0 ? 1 : 0)))
    return `${label} ${b.padEnd(barRoom)} ${values[i]!.padStart(valueWidth)}`
  })
}

// ---- copy and export ----

/** A value as delimited text for copying and TSV: raw (ISO dates, full numbers), NULL empty. */
export function rawText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return (value as { $binary?: boolean }).$binary ? `<binary ${(value as { length?: number }).length ?? '?'} bytes>` : JSON.stringify(value)
  return String(value)
}

/** Rows as TSV (tabs and line breaks inside values become spaces) or CSV (RFC 4180 quoting), with a header row. */
export function toDelimited(columns: SqlColumn[], rows: unknown[][], format: 'tsv' | 'csv', header = true): string {
  const cell = (v: unknown) => {
    const t = rawText(v)
    if (format === 'tsv') return t.replace(/[\t\r\n]+/g, ' ')
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const sep = format === 'tsv' ? '\t' : ','
  const lines = rows.map((r) => columns.map((_, i) => cell(r[i])).join(sep))
  if (header) lines.unshift(columns.map((c) => cell(c.label || c.name)).join(sep))
  return lines.join('\n') + '\n'
}

/** The most rows "copy to clipboard" takes; larger results go to a file. */
export const CLIPBOARD_MAX_ROWS = 2000

export type ExportTarget = 'csv' | 'tsv' | 'xlsx' | 'json' | 'clipboard'

/** The export dialog's choices, as the main grid offers them, plus the clipboard for small results. */
export function exportChoices(total: number, maxRows?: number): Array<{ label: string; value: ExportTarget; detail?: string; disabled?: string }> {
  const all = `all ${total.toLocaleString('en-US')} row${total === 1 ? '' : 's'}`
  return [
    { label: 'csv', value: 'csv', detail: `${all}, written by the server` },
    { label: 'tsv', value: 'tsv', detail: `${all}, read page by page` },
    { label: 'xlsx', value: 'xlsx', detail: `Excel, ${all}` },
    { label: 'json', value: 'json', detail: `${all} keyed by column label` },
    { label: 'copy to clipboard', value: 'clipboard', detail: 'TSV with a header row', disabled: total > CLIPBOARD_MAX_ROWS ? `more than ${CLIPBOARD_MAX_ROWS.toLocaleString('en-US')} rows: export to a file` : undefined },
  ].map((c) => (maxRows && total >= maxRows ? { ...c, detail: `${c.detail} (the result stopped at the ${maxRows.toLocaleString('en-US')}-row limit)` } : c)) as ReturnType<typeof exportChoices>
}

/** Every row of a result (pages the server's cached result as needed). */
export async function allRows(pager: ResultPager): Promise<unknown[][]> {
  // ten chunks at a time, so a 10,000-row result does not open a hundred requests at once
  for (let start = 0; start < pager.total; start += pager.chunk * 10) await pager.ensure(start, pager.chunk * 10)
  const rows = pager.window(0, pager.total)
  if (rows.some((r) => !r)) throw new Error(pager.error ?? 'some rows could not be read (the server keeps a result for 15 minutes: run it again)')
  return rows as unknown[][]
}
