/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { displayDateTime, missingQBitMessage, valueText } from '@qrun-io/qqq-core'
import { glyphs } from '../theme'

/*
 * The clipping rule: no text may render outside its container. Every line the TUI draws is cut to the
 * cells it has with `trunc`/`pad` (an ellipsis marks the cut), measured in terminal cells, not
 * UTF-16 code units, so wide characters (CJK, emoji) cannot push a border or a highlight bar out.
 */

const NARROW = /^[\x20-\x7e]*$/

/** Terminal cells one string takes (wide characters count 2, combining marks 0). */
export function cellWidth(text: string): number {
  if (NARROW.test(text)) return text.length
  return typeof Bun !== 'undefined' ? Bun.stringWidth(text) : text.length
}

/** Cuts text to a width in cells, with an ellipsis when it was longer. */
export function trunc(text: string, width: number): string {
  if (width <= 0) return ''
  const flat = text.replace(/[\r\n\t]+/g, ' ')
  if (cellWidth(flat) <= width) return flat
  const ellipsis = glyphs().ellipsis
  if (width === 1) return ellipsis
  if (NARROW.test(flat)) return flat.slice(0, width - 1) + ellipsis
  let out = ''
  let used = 0
  for (const ch of flat) {
    const w = cellWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + ellipsis
}

/** Pads (or cuts) text to exactly `width` cells. */
export function pad(text: string, width: number): string {
  const t = trunc(text, width)
  return t + ' '.repeat(Math.max(0, width - cellWidth(t)))
}

/** Right-aligns text in `width` cells. */
export function padLeft(text: string, width: number): string {
  const t = trunc(text, width)
  return ' '.repeat(Math.max(0, width - cellWidth(t))) + t
}

/** Centres text in `width` cells. */
export function center(text: string, width: number): string {
  const t = trunc(text, width)
  const w = cellWidth(t)
  const left = Math.floor((width - w) / 2)
  return ' '.repeat(Math.max(0, left)) + t + ' '.repeat(Math.max(0, width - w - left))
}

/**
 * A one-line key hint ("a · b · c") in exactly `width` cells with one cell of indent: tokens that do not
 * fit are dropped whole (Esc, Enter and Ctrl+S tokens last), never cut in the middle.
 */
export function hintLine(text: string, width: number): string {
  return pad(` ${fitKeyLine(text.trim().split(KEY_SEP), Math.max(1, width - 2), 1)[0] ?? ''}`, width)
}

/** Cuts styled segments to `width` cells: the segment that crosses the edge ends in an ellipsis, later ones go. */
export function fitSegments<T extends { text: string }>(segs: T[], width: number): T[] {
  const out: T[] = []
  let used = 0
  for (const seg of segs) {
    const w = cellWidth(seg.text)
    if (used + w <= width) {
      out.push(seg)
      used += w
      continue
    }
    const room = width - used
    if (room > 0) out.push({ ...seg, text: trunc(seg.text, room) })
    break
  }
  return out
}

/** One entry of a key help line; a higher `drop` is dropped first when the line does not fit. */
export interface KeyToken {
  text: string
  drop?: number
}

export const KEY_SEP = ' · '

/** Plain-string key tokens that are kept longest: how to save, confirm and leave. */
const ESSENTIAL = /^(Esc|Enter|Ctrl\+S)\b/

/**
 * Lays out key help tokens in at most `maxLines` lines of `width` cells, breaking only between tokens
 * (at " · "), never inside one. When they do not fit, the tokens with the highest `drop` go first
 * (the last of equals first); a single token wider than the line is cut with an ellipsis.
 */
export function fitKeyLine(tokens: Array<KeyToken | string>, width: number, maxLines = 3): string[] {
  const all = tokens.map((t, i) => ({ ...(typeof t === 'string' ? { text: t, drop: ESSENTIAL.test(t) ? 0 : 1 } : t), i })).filter((t) => t.text)
  const pack = (list: typeof all): string[] => {
    const lines: string[] = []
    let line = ''
    for (const t of list) {
      const text = trunc(t.text, width)
      if (line && cellWidth(line + KEY_SEP + text) <= width) line += KEY_SEP + text
      else {
        if (line) lines.push(line)
        line = text
      }
    }
    if (line) lines.push(line)
    return lines
  }
  let kept = all
  let lines = pack(kept)
  while (lines.length > Math.max(1, maxLines) && kept.length > 1) {
    const victim = kept.reduce((worst, t) => ((t.drop ?? 0) >= (worst.drop ?? 0) ? t : worst))
    kept = kept.filter((t) => t !== victim)
    lines = pack(kept)
  }
  return lines.slice(0, Math.max(1, maxLines))
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
  // a server failure that only says a QBit is missing (attachments without Object Storage): one plain line
  const missing = missingQBitMessage(error)
  if (missing) return missing
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
