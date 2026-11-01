/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Column statistics over rows a client already holds, for a table whose server offers none (no
 * QUERY_STATS capability, or the `columnStats` process answered 403 or 404). A pure function of
 * the rows and the field's metadata: counts and nulls for every kind of field; sum, mean and
 * median for numbers; the shortest and longest value for text; earliest, latest and the busiest
 * days for dates; the five most common values for everything but numbers.
 */

type J = Record<string, unknown>

/** How many of the most common values (or days) are kept. */
export const LOADED_STATS_TOP = 5

export type LoadedStatsKind = 'number' | 'string' | 'date' | 'other'

export interface LoadedStatsValue {
  /** The value as text (a date's day for DATE and DATE_TIME). */
  value: string
  count: number
}

export interface LoadedColumnStats {
  kind: LoadedStatsKind
  /** Rows looked at. */
  rows: number
  /** Rows with a value. */
  count: number
  /** Rows without one (null, undefined or the empty string). */
  nulls: number
  /** Distinct values among those present. */
  distinct: number
  /** Smallest and largest present value (text, so numbers keep their form); undefined when none. */
  min?: string
  max?: string
  /** Numbers only. */
  sum?: number
  mean?: number
  median?: number
  /** Text only: the shortest and longest present value. */
  shortest?: string
  longest?: string
  /** The most common values (days for dates), most common first, ties by value; none for numbers. */
  top: LoadedStatsValue[]
}

const NUMBER_TYPES = new Set(['INTEGER', 'LONG', 'DECIMAL'])
const DATE_TYPES = new Set(['DATE', 'DATE_TIME'])
const STRING_TYPES = new Set(['STRING', 'TEXT', 'HTML', 'PASSWORD', 'SECRET', 'TIME'])

/** The kind of statistics a field gets: ids of a possible-value source are labels, not quantities. */
export function loadedStatsKind(field: { type?: unknown; possibleValueSourceName?: unknown }): LoadedStatsKind {
  const type = String(field.type ?? 'STRING')
  if (field.possibleValueSourceName) return 'other'
  if (NUMBER_TYPES.has(type)) return 'number'
  if (DATE_TYPES.has(type)) return 'date'
  if (STRING_TYPES.has(type)) return 'string'
  return 'other'
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

/** The statistics of one field over records (query results). */
export function computeLoadedColumnStats(records: Array<{ values?: J; displayValues?: Record<string, string> }>, fieldName: string, field: { type?: unknown; possibleValueSourceName?: unknown } = {}): LoadedColumnStats {
  const kind = loadedStatsKind(field)
  const counts = new Map<string, number>()
  const numbers: number[] = []
  const texts: string[] = []
  let nulls = 0
  for (const record of records) {
    const raw = record.values?.[fieldName]
    if (raw === null || raw === undefined || raw === '') {
      nulls++
      continue
    }
    if (kind === 'number') {
      const n = Number(raw)
      if (Number.isNaN(n)) continue
      numbers.push(n)
      texts.push(String(raw))
      counts.set(String(raw), (counts.get(String(raw)) ?? 0) + 1)
      continue
    }
    const text = kind === 'date' ? String(raw).slice(0, 10) : kind === 'other' ? String(record.displayValues?.[fieldName] ?? raw) : String(raw)
    texts.push(kind === 'date' ? String(raw) : text)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  const stats: LoadedColumnStats = { kind, rows: records.length, count: texts.length, nulls, distinct: counts.size, top: [] }
  if (kind === 'number') {
    if (numbers.length) {
      const sorted = [...numbers].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      const sum = numbers.reduce((a, b) => a + b, 0)
      stats.min = String(sorted[0])
      stats.max = String(sorted[sorted.length - 1])
      stats.sum = round(sum)
      stats.mean = round(sum / numbers.length)
      stats.median = sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1]! + sorted[middle]!) / 2)
    }
    return stats
  }
  if (texts.length) {
    const ordered = [...texts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    stats.min = ordered[0]
    stats.max = ordered[ordered.length - 1]
    if (kind === 'string') {
      stats.shortest = texts.reduce((a, b) => (b.length < a.length ? b : a))
      stats.longest = texts.reduce((a, b) => (b.length > a.length ? b : a))
    }
  }
  stats.top = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, LOADED_STATS_TOP)
  return stats
}
