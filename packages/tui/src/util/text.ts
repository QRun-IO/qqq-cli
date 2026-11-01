/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { displayDateTime, valueText } from '@qrun-io/qqq-core'
import { glyphs } from '../theme'

/** Cuts text to a width, with an ellipsis when it was longer. */
export function trunc(text: string, width: number): string {
  if (width <= 0) return ''
  const flat = text.replace(/[\r\n\t]+/g, ' ')
  return flat.length <= width ? flat : width === 1 ? glyphs().ellipsis : flat.slice(0, width - 1) + glyphs().ellipsis
}

/** Pads (or cuts) text to exactly `width` cells. */
export function pad(text: string, width: number): string {
  const t = trunc(text, width)
  return t + ' '.repeat(Math.max(0, width - t.length))
}

/** Right-aligns text in `width` cells. */
export function padLeft(text: string, width: number): string {
  const t = trunc(text, width)
  return ' '.repeat(Math.max(0, width - t.length)) + t
}

/** Centres text in `width` cells. */
export function center(text: string, width: number): string {
  const t = trunc(text, width)
  const left = Math.floor((width - t.length) / 2)
  return ' '.repeat(Math.max(0, left)) + t + ' '.repeat(Math.max(0, width - t.length - left))
}

export function num(n: number | undefined | null): string {
  return n === undefined || n === null ? '…' : n.toLocaleString('en-US')
}

/** A value as text: display value when present. */
export function cell(record: { values?: Record<string, unknown>; displayValues?: Record<string, string> } | undefined, field: string): string {
  if (!record) return ''
  const display = record.displayValues?.[field]
  const raw = record.values?.[field]
  const v = display ?? raw
  if (v === null || v === undefined) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** A value as text for a field: DATE_TIME in the viewer's zone (kernel displayDateTime), else the display value. */
export function fieldCell(record: { values?: Record<string, unknown>; displayValues?: Record<string, string> } | undefined, field: { name: string; type: string; adornments?: unknown[] | null }): string {
  // adorned fields as the record view shows them, in one cell: REVEAL masked, RENDER_HTML as text, CHIP, LINK…
  if (record && field.adornments?.length) {
    const text = valueText(field as never, { values: record.values ?? {}, displayValues: record.displayValues } as never, { cell: true }).text
    return text.replace(/\s*\n\s*/g, ' ')
  }
  if (field.type === 'PASSWORD') {
    const raw = record?.values?.[field.name]
    return raw === null || raw === undefined || raw === '' ? '' : '••••••'
  }
  if (record && field.type === 'DATE_TIME') {
    const raw = record.values?.[field.name]
    if (raw !== null && raw !== undefined && raw !== '') return displayDateTime(raw, record.displayValues?.[field.name])
  }
  return cell(record, field.name)
}

/** Splits a command line into arguments as a shell would (quotes, backslash escapes; no expansion). */
export function shellSplit(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current)
      current = ''
      has = false
    } else {
      current += ch
    }
  }
  if (has || current) out.push(current)
  return out
}

/** Quotes an argument for a command line when it needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`
}

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'fieldErrors' in error && Array.isArray((error as { fieldErrors: unknown[] }).fieldErrors) && (error as { fieldErrors: unknown[] }).fieldErrors.length) {
    const e = error as { message: string; fieldErrors: Array<{ field: string; message: string }> }
    return `${e.message}: ${e.fieldErrors.map((f) => `${f.field} ${f.message}`).join('; ')}`
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { message?: string } }).cause
    if (/fetch failed|Unable to connect|ECONNREFUSED/i.test(error.message + String(cause?.message ?? ''))) return `cannot reach the server (${cause?.message ?? error.message})`
    return error.message
  }
  return String(error)
}
