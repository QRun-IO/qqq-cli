/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The SQL Runner's result side, free of drawing: typed values as text, column widths from the
 * column kinds, the server-paged (and server-sorted) result over GET /executions/{uuid}/rows, the
 * EXPLAIN plan as an indented tree, and quick text bar charts.
 */

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

/** Widest a column of a kind starts (its values are cut beyond, V shows them whole). */
const KIND_CAP: Record<string, number> = { number: 20, boolean: 5, date: 10, time: 15, datetime: 27, string: 40, json: 40, array: 30, binary: 22, other: 30 }

/**
 * Column widths from the column kinds and the first rows: the longer of the label and the values,
 * capped per kind; spare width goes to text columns that were cut. Numbers are right-aligned.
 */
export function sqlColumns(columns: SqlColumn[], rows: unknown[][], available: number): GridColumn[] {
  const cols = columns.map((c, i) => {
    const label = c.label || c.name
    const longest = Math.max(label.length + 1, ...rows.slice(0, 200).map((r) => valueText(r[i], c.kind).length), 4)
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
