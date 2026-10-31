/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayDateTime, readFilePreferences, saveDownload, valueText as recordValueText, type DisplayOptions, type FieldMeta, type RecordLike } from '@qrun-io/qqq-core'
import { UsageError } from '../context.js'

export type Json = Record<string, unknown>

/** Parses `name=value` pairs (`--set`, `--values`). */
export function parsePairs(pairs: string[] | undefined, flag: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    const at = pair.indexOf('=')
    if (at < 1) throw new UsageError(`${flag} takes name=value: ${pair}`)
    values[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return values
}

/** Reads a JSON argument: inline text, a file path, or `-` for stdin. */
export function readJson(source: string, flag: string): unknown {
  const inline = source.trim().startsWith('{') || source.trim().startsWith('[')
  const text = inline ? source : new TextDecoder().decode(readFileArg(source === '-' ? 0 : source, flag))
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${flag}: not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * A record's value as text in a list cell (query rows, child lists, joined fields): the same
 * adornment rules as the record view (REVEAL masked unless `reveal`, CHIP, ERROR, DATE_TIME in the
 * local zone or raw with `display.utc`), without link targets or hints. Without field metadata,
 * the display value when the server sent one, else the raw value.
 */
export function valueText(record: Json, field: string, meta?: Json, display?: DisplayOptions, reveal?: boolean): string {
  const fieldMeta = (((meta?.fields ?? {}) as Record<string, Json>)[field]) as FieldMeta | undefined
  const values = (record.values ?? {}) as Record<string, unknown>
  const displayValues = record.displayValues as Record<string, unknown> | undefined
  if (fieldMeta) return recordValueText({ ...fieldMeta, name: field }, { values, displayValues } as RecordLike, { cell: true, dateTime: display, reveal }).text
  const value = displayValues?.[field] ?? values[field]
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** A DATE_TIME instant outside a record (audits, comments, extension payloads) as the record view shows one. */
export function instantText(value: unknown, display?: DisplayOptions): string {
  return displayDateTime(value, undefined, display)
}

/** Reads a file a flag names (`--upload`, `--file`, `--form @file`, `--bytes`); a missing file is a usage error. */
export function readFileArg(path: string | number, flag: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path))
  } catch (error) {
    throw new UsageError(`${flag}: cannot read ${path === 0 ? 'stdin' : path} (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Where a download goes when no --out / --out-dir names a place: the download directory of the
 * file preferences the TUI shares (`qqq config set download-dir`), created when missing, else the
 * current directory.
 */
export function downloadDir(): string {
  const dir = readFilePreferences().downloadDir
  if (!dir) return '.'
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The one way a command writes a downloaded file: `-` writes to stdout; a path the user named is
 * written as given (replacing a file); otherwise `defaultName` (already a safe file name) goes
 * into the download directory without replacing anything (name-1.ext, …). Returns the path
 * written, or undefined for stdout.
 */
export function writeDownload(out: string | undefined, defaultName: string, bytes: Uint8Array): string | undefined {
  if (out === '-') {
    process.stdout.write(bytes)
    return undefined
  }
  if (out !== undefined) return saveDownload(out, bytes, { explicit: true })
  const dir = downloadDir()
  return saveDownload(dir === '.' ? defaultName : join(dir, defaultName), bytes, { explicit: false })
}

/** `n record`/`n records`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/** The footer every list ends with: `(3 records; joined: pet; more may exist: …)`. */
export function countFooter(n: number, singular: string, parts: Array<string | number | false | undefined | null> = [], pluralForm?: string): string {
  return `(${[plural(n, singular, pluralForm), ...parts.filter(Boolean)].join('; ')})`
}

/** A whole number option (`--limit`, `--skip`, …), checked: a usage error otherwise. */
export function intOption(text: string | undefined, flag: string, min = 0): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} must be a whole number${min > 0 ? ` of at least ${min}` : ' (0 or more)'}: ${text}`)
  return n
}

/** A positive whole number option. */
export function positiveInt(text: string, flag: string): number {
  return intOption(text, flag, 1)!
}

/** The fields a query shows by default: the primary key, then the sections' fields by tier, then the rest; capped. */
export function defaultFields(meta: Json, cap = 8): string[] {
  const fields = (meta.fields ?? {}) as Record<string, Json>
  const pk = String(meta.primaryKeyField ?? 'id')
  const order: string[] = [pk]
  const sections = (meta.sections ?? []) as Json[]
  for (const tier of ['T1', 'T2', 'T3']) {
    for (const section of sections.filter((s) => s.tier === tier)) {
      for (const name of (section.fieldNames ?? []) as string[]) if (!order.includes(name) && fields[name] && !fields[name].isHidden) order.push(name)
    }
  }
  for (const name of Object.keys(fields)) if (!order.includes(name) && !fields[name]!.isHidden && !fields[name]!.isHeavy) order.push(name)
  return order.slice(0, cap)
}

/** Field labels for column headers. */
export function labelsFor(meta: Json, names: string[]): string[] {
  const fields = (meta.fields ?? {}) as Record<string, Json>
  return names.map((n) => String(fields[n]?.label ?? n))
}
