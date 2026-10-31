/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readFileSync } from 'node:fs'
import { displayDateTime, type DisplayOptions } from '@qrun-io/qqq-core'
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
  const text = source === '-' ? readFileSync(0, 'utf8') : source.trim().startsWith('{') || source.trim().startsWith('[') ? source : readFileSync(source, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${flag}: not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * A record's value as text: its display value when the server sent one. With the table's
 * metadata, DATE_TIME values are shown in the local zone (or raw with `display.utc`).
 */
export function valueText(record: Json, field: string, meta?: Json, display?: DisplayOptions): string {
  const shown = (record.displayValues as Json | undefined)?.[field]
  const raw = (record.values as Json | undefined)?.[field]
  if ((((meta?.fields ?? {}) as Record<string, Json>)[field])?.type === 'DATE_TIME') return displayDateTime(raw, shown, display)
  const value = shown ?? raw
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
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
