/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Extension output (an operation's JSON, a widget payload the kernel has no block for) drawn as
 * the TUI draws records: scalars as aligned key/value rows, arrays of objects as sub-tables (the
 * widget table lines, clipped to a number of rows), nested objects indented under their key.
 * The raw JSON stays one key away on the screens that use this.
 */

import { theme } from './theme'
import { trunc } from './util/text'
import { tableLines, type StyledLine } from './widgets'

type J = Record<string, unknown>

export interface StructuredOptions {
  /** Most rows of a sub-table before "… N more" (default 15). */
  maxRows?: number
  /** Most columns of a sub-table (default 8). */
  maxColumns?: number
}

const isObject = (v: unknown): v is J => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v: unknown) => v === null || v === undefined || typeof v !== 'object'

/** A value as one table cell or key/value text: scalars as they are, small structures as compact JSON. */
export function scalarText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.replace(/\s*\n\s*/g, ' ')
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v) && v.every(isScalar)) return v.map(scalarText).join(', ')
  return JSON.stringify(v)
}

/** The columns of a list of objects: keys with scalar values first, in first-seen order. */
function columnsOf(items: J[], max: number): string[] {
  const keys: string[] = []
  for (const it of items) for (const k of Object.keys(it)) if (!keys.includes(k)) keys.push(k)
  const scalar = keys.filter((k) => items.every((it) => isScalar(it[k]) || (Array.isArray(it[k]) && (it[k] as unknown[]).every(isScalar))))
  return [...scalar, ...keys.filter((k) => !scalar.includes(k))].slice(0, max)
}

/** Lines for any JSON value, fitted to a width. */
export function structuredLines(value: unknown, width: number, options: StructuredOptions = {}, indent = 0): StyledLine[] {
  const t = theme()
  const maxRows = options.maxRows ?? 15
  const maxColumns = options.maxColumns ?? 8
  const prefix = ' '.repeat(indent)
  const room = Math.max(10, width - indent)
  const out: StyledLine[] = []
  const shift = (lines: StyledLine[]) => lines.map((l) => ({ ...l, text: prefix + l.text }))
  if (Array.isArray(value)) {
    if (!value.length) return [{ text: `${prefix}(empty)`, fg: t.dim }]
    if (value.every(isObject)) {
      const items = value as J[]
      const columns = columnsOf(items, maxColumns)
      const shown = items.slice(0, maxRows)
      out.push(...shift(tableLines(columns, shown.map((it) => columns.map((c) => scalarText(it[c]))), room)))
      const more = items.length - shown.length
      const hidden = columnsOf(items, 1000).length - columns.length
      if (more > 0 || hidden > 0) out.push({ text: trunc(`${prefix}… ${[more > 0 && `${more} more row${more === 1 ? '' : 's'}`, hidden > 0 && `${hidden} more column${hidden === 1 ? '' : 's'}`].filter(Boolean).join(', ')} (J shows the raw JSON)`, width), fg: t.dim })
      return out
    }
    if (value.every(isScalar)) return [{ text: trunc(prefix + value.map(scalarText).join(', '), width) }]
    value.forEach((v, i) => {
      out.push({ text: trunc(`${prefix}[${i}]`, width), fg: t.acc })
      out.push(...structuredLines(v, width, options, indent + 2))
    })
    return out
  }
  if (!isObject(value)) return [{ text: trunc(prefix + scalarText(value), width) }]
  const entries = Object.entries(value)
  if (!entries.length) return [{ text: `${prefix}(empty)`, fg: t.dim }]
  const scalars = entries.filter(([, v]) => isScalar(v) || (Array.isArray(v) && v.every(isScalar)))
  const keyWidth = Math.min(28, Math.max(...scalars.map(([k]) => k.length), 1))
  for (const [k, v] of entries) {
    if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) {
      out.push({ text: trunc(`${prefix}${k.padEnd(keyWidth)}  ${scalarText(v)}`, width) })
      continue
    }
    const count = Array.isArray(v) ? ` (${v.length})` : ''
    out.push({ text: trunc(`${prefix}${k}${count}`, width), fg: t.acc, bold: true })
    out.push(...structuredLines(v, width, options, indent + 2))
  }
  return out
}
