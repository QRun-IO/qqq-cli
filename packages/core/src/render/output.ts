/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Output formats shared by the CLI (and the TUI's command line): json, table, text, csv, yaml, plus
 * JMESPath reshaping. Pure functions over plain data; nothing here touches a terminal.
 */

import jmespath from 'jmespath'
import { stringify as toYaml } from 'yaml'

/** The output formats a command accepts (`--output`). */
export type OutputFormat = 'json' | 'table' | 'text' | 'csv' | 'yaml'

export const OUTPUT_FORMATS: OutputFormat[] = ['json', 'table', 'text', 'csv', 'yaml']

/** A row for tabular output: one object; the column keys are chosen by the caller. */
export type Row = Record<string, unknown>

/** What a command hands to the renderer: the machine data, and optionally rows and column labels for tables. */
export interface Printable {
  /** The full result, printed by json and yaml. */
  data: unknown
  /** The rows for table, text and csv; defaults to `data` when it is an array of objects. */
  rows?: Row[]
  /** Column keys for table, text and csv; defaults to the union of row keys, in first-seen order. */
  columns?: string[]
  /** Header labels, parallel to `columns`; default: the keys. */
  headers?: string[]
  /** A trailer for table output (counts, hints). */
  footer?: string
  /**
   * Lays out a nested result for people (table output): scalars as key/value rows, each list of
   * objects as a sub-table. Given, the layout is always used; without it, only for results with
   * nested lists or objects and no `rows`.
   */
  layout?: DocumentLayout
}

/** How the table output lays out a nested result (see {@link formatDocument}). */
export interface DocumentLayout {
  /**
   * Columns per list, by the list's key path (`items`, `data.rows`; `''` for a top-level list);
   * `'*'` applies to every list without its own choice. Default: the union of the row keys.
   */
  columns?: Record<string, string[]>
  /** The width to fit tables in (the terminal's columns); none: only the 60-character cell cap. */
  width?: number
}

/** Options of {@link render} that come from the terminal rather than the command. */
export interface RenderOptions {
  /** The terminal width; table output is fitted to it (cells cut with …, columns that do not fit dropped). */
  width?: number
}

/** Applies a JMESPath expression to data (`--query`); `undefined` leaves the data unchanged. */
export function applyQuery(data: unknown, query?: string): unknown {
  if (!query) return data
  return jmespath.search(data as never, query)
}

/** The text of one cell: display values are already strings; objects become compact JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function rowsOf(printable: Printable): Row[] {
  if (printable.rows) return printable.rows
  if (Array.isArray(printable.data)) return printable.data.map((item) => (item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Row : { value: item }))
  if (printable.data !== null && typeof printable.data === 'object') return Object.entries(printable.data as Row).map(([key, value]) => ({ key, value }))
  return [{ value: printable.data }]
}

function columnsOf(rows: Row[], printable: Printable): string[] {
  if (printable.columns) return printable.columns
  const seen: string[] = []
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key)
  return seen
}

const ANSI = /\x1b\[[0-9;]*m/g

/** Wraps text in the ANSI color of a CHIP color (default: none). */
export function chipAnsi(text: string, color: string): string {
  const code = ({ success: 32, error: 31, warning: 33, info: 36, primary: 34, secondary: 35 } as Record<string, number>)[color]
  return code ? `\x1b[${code}m${text}\x1b[0m` : text
}

/** The columns of a table that fit a width: how wide each shown column is, and how many are shown. */
export function fitColumns(natural: number[], width: number | undefined, gap = 2): { widths: number[]; shown: number } {
  if (!width || width <= 0) return { widths: [...natural], shown: natural.length }
  const minimum = natural.map((w) => Math.min(w, 8))
  // as many columns as fit at their minimum width, then the widest shrink until the row fits
  let shown = 0
  let used = 0
  while (shown < natural.length && used + (shown ? gap : 0) + minimum[shown]! <= width) used += (shown ? gap : 0) + minimum[shown++]!
  shown = Math.max(shown, 1)
  const widths = natural.slice(0, shown)
  let total = widths.reduce((a, b) => a + b, 0) + gap * (shown - 1)
  while (total > width) {
    let widest = -1
    for (let i = 0; i < shown; i++) if (widths[i]! > minimum[i]! && (widest < 0 || widths[i]! > widths[widest]!)) widest = i
    if (widest < 0) break
    widths[widest]!--
    total--
  }
  return { widths, shown }
}

/** A table laid out in a width: its text, and the columns left out because they did not fit. */
export function layoutTable(rows: Row[], columns: string[], headers: string[] = columns, options: { maxCell?: number; width?: number; cell?: (value: unknown) => string } = {}): { text: string; hidden: string[] } {
  const maxCell = options.maxCell ?? 60
  const toText = options.cell ?? cellText
  // ANSI color (a CHIP on a terminal) takes no width
  const visible = (text: string) => text.replace(ANSI, '').length
  const cut = (text: string, width: number) => {
    if (visible(text) <= width) return text
    const plain = text.replace(ANSI, '')
    return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`
  }
  const cells = rows.map((r) => columns.map((c) => cut(toText(r[c]).replace(/\s+/g, ' '), maxCell)))
  const natural = columns.map((c, i) => Math.max((headers[i] ?? c).length, ...cells.map((row) => visible(row[i]!))))
  const { widths, shown } = fitColumns(natural, options.width)
  const line = (values: string[]) => values.slice(0, shown).map((v, i) => {
    const text = cut(v, widths[i]!)
    return text + ' '.repeat(Math.max(0, widths[i]! - visible(text)))
  }).join('  ').trimEnd()
  const text = [line(columns.map((c, i) => headers[i] ?? c)), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n')
  return { text, hidden: columns.slice(shown) }
}

/**
 * Formats rows as an aligned text table with a header rule; wide cells are cut with an ellipsis.
 *
 * @param rows - Row objects.
 * @param columns - Column keys.
 * @param headers - Header labels (default: the keys).
 * @param maxCell - Longest cell before cutting (default 60).
 * @param width - Fit the table in this width (columns that do not fit are left out).
 */
export function formatTable(rows: Row[], columns: string[], headers: string[] = columns, maxCell = 60, width?: number): string {
  return layoutTable(rows, columns, headers, { maxCell, width }).text
}

function isPlainObject(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isObjectList(value: unknown): value is Row[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject)
}

/** Whether a result has nested lists or objects that {@link formatDocument} shows better than key/value rows of JSON. */
export function isNestedDocument(data: unknown): boolean {
  if (isObjectList(data)) return data.some((row) => Object.values(row).some((v) => isPlainObject(v) || isObjectList(v)))
  return isPlainObject(data) && Object.values(data).some((v) => isPlainObject(v) || isObjectList(v))
}

/** A list in one cell: scalars joined; objects by their label or name, else counted. */
function listText(list: unknown[]): string {
  if (!list.length) return ''
  if (list.every(isPlainObject)) {
    const names = list.map((o) => o.label ?? o.name ?? o.title)
    return names.every((n) => typeof n === 'string' || typeof n === 'number') ? names.join(', ') : `${list.length} item${list.length === 1 ? '' : 's'}`
  }
  return list.map(cellText).join(', ')
}

function documentCell(value: unknown): string {
  return Array.isArray(value) ? listText(value) : cellText(value)
}

/** A row with its nested objects flattened one level (`assignee: {name}` -> `assignee.name`). */
function flattenRow(row: Row): Row {
  const flat: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (isPlainObject(value) && Object.keys(value).length) for (const [inner, v] of Object.entries(value)) flat[`${key}.${inner}`] = v
    else flat[key] = value
  }
  return flat
}

function listTable(list: Row[], path: string, layout: DocumentLayout): string {
  const rows = list.map(flattenRow)
  const chosen = layout.columns?.[path] ?? layout.columns?.['*']
  const columns = chosen?.length ? chosen : columnsOf(rows, {} as Printable)
  // a chosen column may name a nested object as a whole (`assignee`): read it from the original row
  const shown = rows.map((row, i) => Object.fromEntries(columns.map((c) => [c, c in row ? row[c] : list[i]![c]])))
  const { text, hidden } = layoutTable(shown, columns, columns, { width: layout.width, cell: documentCell })
  return hidden.length ? `${text}\n(${hidden.length} more column${hidden.length === 1 ? '' : 's'} did not fit: ${hidden.join(', ')}; --columns chooses, --json shows everything)` : text
}

/**
 * Lays out a result for people: scalars as aligned key/value rows (nested objects as dotted
 * keys), and each list of objects as a sub-table under its key, its columns the union of the row
 * keys in first-seen order (or the layout's choice), nested objects flattened one level with
 * dotted keys, fitted to the layout's width.
 */
export function formatDocument(data: unknown, layout: DocumentLayout = {}): string {
  if (Array.isArray(data)) return isObjectList(data) ? listTable(data, '', layout) : data.length ? data.map(cellText).join('\n') : '(none)'
  if (!isPlainObject(data)) return cellText(data)
  const pairs: Array<[string, string]> = []
  const lists: Array<[string, Row[]]> = []
  const walk = (object: Row, prefix: string, depth: number) => {
    for (const [name, value] of Object.entries(object)) {
      const key = prefix ? `${prefix}.${name}` : name
      if (isObjectList(value)) lists.push([key, value])
      else if (isPlainObject(value) && Object.keys(value).length && depth < 3) walk(value, key, depth + 1)
      else if (Array.isArray(value)) pairs.push([key, value.length ? listText(value) : '(none)'])
      else pairs.push([key, cellText(value)])
    }
  }
  walk(data, '', 1)
  const keyWidth = Math.max(0, ...pairs.map(([k]) => k.length))
  const valueWidth = layout.width ? Math.max(8, layout.width - keyWidth - 2) : 60
  const blocks: string[] = []
  if (pairs.length) {
    blocks.push(pairs.map(([key, value]) => {
      const text = value.replace(/\s+/g, ' ')
      const shown = text.length > valueWidth ? `${text.slice(0, valueWidth - 1)}…` : text
      return `${key.padEnd(keyWidth)}  ${shown}`.trimEnd()
    }).join('\n'))
  }
  for (const [key, list] of lists) blocks.push(`${key} (${list.length})\n${listTable(list, key, layout)}`)
  return blocks.join('\n\n')
}

/** CSV with RFC 4180 quoting and a header row. */
export function formatCsv(rows: Row[], columns: string[], headers: string[] = columns, lineEnding = '\n'): string {
  const quote = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
  const lines = [headers.map(quote).join(',')]
  for (const row of rows) lines.push(columns.map((c) => quote(cellText(row[c]))).join(','))
  return lines.join(lineEnding) + lineEnding
}

/** Tab-separated values without a header: the `aws --output text` shape, made for cut and awk. */
export function formatText(rows: Row[], columns: string[]): string {
  return rows.map((row) => columns.map((c) => cellText(row[c]).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
}

/**
 * Renders a result in a format. `query` (JMESPath) is applied first and, when it reshapes the data
 * away from the rows the command prepared, the table is rebuilt from the reshaped data. Table
 * output of a nested result (or of any result given a `layout`) is laid out by
 * {@link formatDocument}.
 */
export function render(printable: Printable, format: OutputFormat, query?: string, options: RenderOptions = {}): string {
  // a query reshapes the data: the command's rows and column choices no longer apply
  const shaped: Printable = query ? { data: applyQuery(printable.data, query), ...(printable.layout ? { layout: {} } : {}) } : printable
  switch (format) {
    case 'json':
      return JSON.stringify(shaped.data, null, 2)
    case 'yaml':
      return toYaml(shaped.data ?? null).trimEnd()
    case 'csv': {
      const rows = rowsOf(shaped)
      const columns = columnsOf(rows, shaped)
      return formatCsv(rows, columns, shaped.headers ?? columns).trimEnd()
    }
    case 'text': {
      const rows = rowsOf(shaped)
      return formatText(rows, columnsOf(rows, shaped))
    }
    case 'table':
    default: {
      if (!shaped.rows && (shaped.layout || isNestedDocument(shaped.data))) {
        const text = formatDocument(shaped.data, { ...shaped.layout, width: options.width ?? shaped.layout?.width })
        return shaped.footer ? `${text}\n${shaped.footer}` : text
      }
      const rows = rowsOf(shaped)
      const columns = columnsOf(rows, shaped)
      const table = formatTable(rows, columns, shaped.headers ?? columns)
      return shaped.footer ? `${table}\n${shaped.footer}` : table
    }
  }
}

/** The default format: tables for people, JSON for pipes (`--output` and QQQ_OUTPUT override). */
export function defaultFormat(isTty: boolean, env: NodeJS.ProcessEnv = process.env): OutputFormat {
  const fromEnv = env.QQQ_OUTPUT as OutputFormat | undefined
  if (fromEnv && OUTPUT_FORMATS.includes(fromEnv)) return fromEnv
  return isTty ? 'table' : 'json'
}
