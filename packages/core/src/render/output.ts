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

/**
 * Formats rows as an aligned text table with a header rule; wide cells are cut with an ellipsis.
 *
 * @param rows - Row objects.
 * @param columns - Column keys.
 * @param headers - Header labels (default: the keys).
 * @param maxCell - Longest cell before cutting (default 60).
 */
export function formatTable(rows: Row[], columns: string[], headers: string[] = columns, maxCell = 60): string {
  // ANSI color (a CHIP on a terminal) takes no width
  const visible = (text: string) => text.replace(ANSI, '').length
  const cell = (v: unknown) => {
    const text = cellText(v).replace(/\s+/g, ' ')
    if (visible(text) <= maxCell) return text
    const plain = text.replace(ANSI, '')
    return `${plain.slice(0, maxCell - 1)}…`
  }
  const widths = columns.map((c, i) => Math.max((headers[i] ?? c).length, ...rows.map((r) => visible(cell(r[c])))))
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visible(c)))).join('  ').trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n')
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
 * away from the rows the command prepared, the table is rebuilt from the reshaped data.
 */
export function render(printable: Printable, format: OutputFormat, query?: string): string {
  const shaped: Printable = query ? { data: applyQuery(printable.data, query) } : printable
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
