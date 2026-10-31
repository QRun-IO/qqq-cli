/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * DATE_TIME values between people and the server. The server stores and sends UTC instants
 * (`2026-10-31T19:30:00Z`); people type and read wall-clock times in their own zone. Typed local
 * times (`2026-10-31T14:30`, `2026-10-31 14:30:15`) become UTC instants; instants are shown in the
 * zone (the TZ environment, or an explicit IANA zone). Daylight-saving edges follow what a clock
 * does: a time skipped by a spring-forward gap moves forward by the gap, and a time repeated by a
 * fall-back hour means its first occurrence (the earlier instant), the same choices JavaScript's
 * `Date` makes. No terminal API is used here.
 */

import type { FieldMeta, FieldValues } from './fields.js'
import type { QueryFilter } from '../filter/grammar.js'

/** An ISO instant with a zone designator (Z or an offset). */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

/** A local wall-clock date and time without a zone. */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/

/** A date alone. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A display value the server already formatted in a declared zone: `2026-10-31 2:30:00 PM CDT`. */
const SERVER_ZONED = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(:\d{2})? [AP]M \S+$/i

/** The zone in effect: the TZ environment as the runtime resolved it, else UTC. */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Whether a zone name is one this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()
function wallFormat(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
    formats.set(timeZone, format)
  }
  return format
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number; zoneName: string }

/** The wall clock of an instant in a zone. */
function wallOf(ms: number, timeZone: string): Wall {
  const parts = Object.fromEntries(wallFormat(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), zoneName: String(parts.timeZoneName ?? '') }
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function zoneOffset(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone)
  const whole = Math.floor(ms / 1000) * 1000
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole
}

/** The instant a wall-clock time names in a zone (DST gaps move forward; repeated hours take the first). */
export function wallTimeToInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, millis: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis)
  const day1 = 86_400_000
  const offsets = [...new Set([zoneOffset(wall - day1, timeZone), zoneOffset(wall, timeZone), zoneOffset(wall + day1, timeZone)])]
  const valid = offsets.map((o) => wall - o).filter((t) => zoneOffset(t, timeZone) === wall - t).sort((a, b) => a - b)
  if (valid.length) return valid[0]!
  // a gap: read the time with the offset in force before it, as a clock moved forward would
  return wall - zoneOffset(wall - day1, timeZone)
}

/** Formats epoch milliseconds as a UTC instant, keeping fractional seconds only when present. */
function isoInstant(ms: number, fraction?: string): string {
  const base = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, '')
  return `${base}${fraction ?? ''}Z`
}

export interface ToUtcOptions {
  timeZone?: string
  /**
   * The value before editing: when the typed text names the same wall-clock time, the original
   * instant comes back unchanged (its offset in a repeated hour, and precision finer than seconds).
   */
  original?: unknown
  /** A date alone (`2026-10-31`) means local midnight (filters); otherwise it is not converted. */
  dateMeansMidnight?: boolean
}

/**
 * Converts what a person typed for a DATE_TIME to the UTC instant the server takes. Zoned instants
 * pass through; local wall-clock times are read in the zone; anything else is returned unchanged
 * for validation to report.
 */
export function localToUtc(text: string, options: ToUtcOptions = {}): string {
  const value = text.trim()
  if (!value) return value
  if (ZONED_ISO.test(value)) return value.replace(' ', 'T')
  const timeZone = options.timeZone ?? defaultTimeZone()
  let match = LOCAL.exec(value)
  if (!match && options.dateMeansMidnight) {
    const d = DATE_ONLY.exec(value)
    if (d) match = [value, d[1]!, d[2]!, d[3]!, '00', '00', '00', ''] as unknown as RegExpExecArray
  }
  if (!match) return value
  const [, y, mo, d, h, mi, s, fraction] = match
  if (isInstant(options.original) && utcToLocalInput(String(options.original), timeZone) === `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}` && !fraction) return String(options.original)
  const ms = wallTimeToInstant(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? 0), 0, timeZone)
  return isoInstant(ms, fraction || undefined)
}

/** Whether a value is a zoned ISO instant. */
export function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ZONED_ISO.test(value.trim()) && !Number.isNaN(Date.parse(value.trim().replace(' ', 'T')))
}

/** An instant as local `YYYY-MM-DDTHH:MM:SS` in the zone (what an editor pre-fills). */
export function utcToLocalInput(instant: string, timeZone: string = defaultTimeZone()): string {
  if (!isInstant(instant)) return instant
  const w = wallOf(Date.parse(instant.trim().replace(' ', 'T')), timeZone)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}`
}

/** An instant for people: `2026-10-31 14:30:00 CDT` in the zone; other values unchanged. */
export function utcToLocal(instant: string, timeZone: string = defaultTimeZone()): string {
  if (!isInstant(instant)) return instant
  const w = wallOf(Date.parse(instant.trim().replace(' ', 'T')), timeZone)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}:${p(w.second)} ${w.zoneName}`
}

export interface DisplayOptions {
  timeZone?: string
  /** Show the raw UTC instant (`--utc`). */
  utc?: boolean
}

/**
 * The text to show for a DATE_TIME value: the server's display value when it is formatted in a
 * declared zone (a field with a fixed or per-record zone), else the instant in the viewer's zone,
 * else the raw value (`utc`).
 */
export function displayDateTime(value: unknown, displayValue?: unknown, options: DisplayOptions = {}): string {
  if (value === null || value === undefined || value === '') return displayValue === null || displayValue === undefined ? '' : String(displayValue)
  if (options.utc) return String(value)
  if (typeof displayValue === 'string' && SERVER_ZONED.test(displayValue.trim())) return displayValue.trim()
  return isInstant(value) ? utcToLocal(value, options.timeZone) : String(displayValue ?? value)
}

/** Converts the DATE_TIME values among `values` (by field type) to UTC instants; returns a new object. */
export function dateTimesToUtc(fields: Iterable<FieldMeta>, values: FieldValues, options: Omit<ToUtcOptions, 'original'> & { originals?: FieldValues } = {}): FieldValues {
  const out = { ...values }
  for (const field of fields) {
    if (field.type !== 'DATE_TIME') continue
    const v = out[field.name]
    if (typeof v === 'string') out[field.name] = localToUtc(v, { ...options, original: options.originals?.[field.name] })
  }
  return out
}

/**
 * Converts the values of criteria on DATE_TIME fields (local times and dates) to UTC instants,
 * in place through sub-filters. Expression values (`now(-7d)`, `thisPeriod(month)`) are left to the server.
 */
export function filterDateTimesToUtc<F extends Pick<QueryFilter, 'criteria'> & { subFilters?: unknown[] }>(filter: F, fields: Record<string, Pick<FieldMeta, 'type'>>, timeZone: string = defaultTimeZone()): F {
  for (const criterion of filter.criteria ?? []) {
    if (fields[criterion.fieldName]?.type !== 'DATE_TIME') continue
    criterion.values = (criterion.values ?? []).map((v) => (typeof v === 'string' ? localToUtc(v, { timeZone, dateMeansMidnight: true }) : v)) as typeof criterion.values
  }
  for (const sub of filter.subFilters ?? []) filterDateTimesToUtc(sub as F, fields, timeZone)
  return filter
}
