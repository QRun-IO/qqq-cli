/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * DATE and DATE_TIME entry for people: the display format a profile chose (the date order, a
 * 12- or 24-hour clock), lenient parsing of what people type (ISO, the display format, partial
 * dates completed, `t`/`today`, `n`/`now`, and the filter grammar's relative forms), and the
 * calendar arithmetic a month picker needs. Values come out in the forms the kernel already
 * sends: `YYYY-MM-DD` for a DATE, and a local wall-clock `YYYY-MM-DDTHH:MM:SS` for a DATE_TIME,
 * which `localToUtc` / `dateTimesToUtc` turn into the UTC instant the server takes. Slash dates
 * (`01/02/2026`) are accepted only when the date order says which part is the month: no guessing.
 * No terminal API is used here.
 */

import { readConfig, writeConfig } from '../session/profiles.js'
import { defaultTimeZone, isInstant, utcToLocalInput, zoneOffset, wallTimeToInstant } from './datetime.js'

/** The order of a date's parts in the display format: ISO (the default), US, or day first. */
export type DateOrder = 'YMD' | 'MDY' | 'DMY'

/** Saved date preferences (config.json `ui.dates`, globally or per profile). */
export interface DateSettings {
  /** Display and slash-entry order: YMD shows 2026-03-05, MDY 03/05/2026, DMY 05/03/2026. */
  order?: DateOrder
  /** The clock of times; absent: the locale's (LC_ALL, LC_TIME, LANG), else 24-hour. */
  clock?: '24h' | '12h'
  /** First day of the picker's week; absent: the locale's region, else Monday. */
  weekStart?: 'monday' | 'sunday'
  /** Show ISO week numbers beside the picker's weeks. */
  weekNumbers?: boolean
  /** Enter on an empty date field opens the picker (otherwise Enter moves on). */
  pickerOnEnter?: boolean
}

export type ResolvedDateSettings = Required<DateSettings>

/** A calendar date with a wall-clock time (month 1-12). */
export interface WallDate {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export type DateKind = 'DATE' | 'DATE_TIME'

/** Regions whose calendars start the week on Sunday (CLDR firstDay=sun, the common ones). */
const SUNDAY_REGIONS = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'PH', 'IN', 'ZA', 'AU', 'SA', 'PE', 'CO', 'VE', 'GT', 'HN', 'PA', 'DO', 'PR', 'TH', 'ID', 'KE'])

/** The locale people chose for times in the environment (`en_US.UTF-8` → `en-US`), or undefined. */
export function localeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.LC_ALL || env.LC_TIME || env.LANG
  if (!raw || raw === 'C' || raw === 'POSIX') return undefined
  const tag = raw.split('.')[0]!.split('@')[0]!.replace('_', '-')
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}

/** The settings in effect: what was saved, then the locale, then the defaults (ISO, 24-hour, Monday). */
export function resolveDateSettings(saved: DateSettings = {}, locale?: string): ResolvedDateSettings {
  let clock: '24h' | '12h' = '24h'
  let weekStart: 'monday' | 'sunday' = 'monday'
  if (locale) {
    try {
      const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
      if (cycle === 'h12' || cycle === 'h11') clock = '12h'
      const region = new Intl.Locale(locale).maximize().region
      if (region && SUNDAY_REGIONS.has(region)) weekStart = 'sunday'
    } catch {
      // an unknown locale keeps the defaults
    }
  }
  return {
    order: saved.order && ['YMD', 'MDY', 'DMY'].includes(saved.order) ? saved.order : 'YMD',
    clock: saved.clock === '12h' || saved.clock === '24h' ? saved.clock : clock,
    weekStart: saved.weekStart === 'sunday' || saved.weekStart === 'monday' ? saved.weekStart : weekStart,
    weekNumbers: saved.weekNumbers === true,
    pickerOnEnter: saved.pickerOnEnter === true,
  }
}

/** The saved date settings: the profile's `ui.dates` over the global `ui.dates`. */
export function readDateSettings(profile?: string, env: NodeJS.ProcessEnv = process.env): DateSettings {
  const config = readConfig(env)
  const global = config.ui?.dates ?? {}
  const own = (profile ? config.profiles[profile]?.ui?.dates : undefined) ?? {}
  return { ...global, ...own }
}

/** Saves date settings (merged into what is there) globally, or for one profile. */
export function writeDateSettings(patch: DateSettings, options: { profile?: string } = {}, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const target = options.profile && config.profiles[options.profile] ? (config.profiles[options.profile]!.ui ??= {}) : (config.ui ??= {})
  target.dates = { ...target.dates, ...patch }
  writeConfig(config, env)
}

// ---- calendar arithmetic -----------------------------------------------------------------

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}

/** Midnight UTC of a date (also for years before 100, which Date.UTC would read as 19xx). */
function utcDate(year: number, month: number, day: number): Date {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  return d
}

/** Day of the week: 0 Sunday … 6 Saturday. */
export function weekdayOf(year: number, month: number, day: number): number {
  return utcDate(year, month, day).getUTCDay()
}

/** The ISO 8601 week number (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeek(year: number, month: number, day: number): number {
  const d = utcDate(year, month, day)
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const start = utcDate(d.getUTCFullYear(), 1, 1)
  return Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7)
}

function fromUtcDate(d: Date, time: Pick<WallDate, 'hour' | 'minute' | 'second'>): WallDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: time.hour, minute: time.minute, second: time.second }
}

/** Moves a date by whole days (the time stays). */
export function addDays(w: WallDate, days: number): WallDate {
  return fromUtcDate(utcDate(w.year, w.month, w.day + days), w)
}

/** Moves a date by months; the day is clamped to the end of a shorter month (Jan 31 + 1 month = Feb 28). */
export function addMonths(w: WallDate, months: number): WallDate {
  const index = w.year * 12 + (w.month - 1) + months
  const year = Math.floor(index / 12)
  const month = index - year * 12 + 1
  return { ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) }
}

/** One cell of a month grid. */
export interface CalendarDay {
  year: number
  month: number
  day: number
  /** In the month shown (the others lead in or trail out, dimmed). */
  inMonth: boolean
}

/** Six weeks covering a month, each starting on the chosen weekday, with its ISO week number. */
export function monthGrid(year: number, month: number, weekStart: 'monday' | 'sunday' = 'monday'): Array<{ week: number; days: CalendarDay[] }> {
  const first = weekdayOf(year, month, 1)
  const lead = weekStart === 'monday' ? (first + 6) % 7 : first
  let cursor = addDays({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, -lead)
  const weeks: Array<{ week: number; days: CalendarDay[] }> = []
  for (let r = 0; r < 6; r++) {
    const days: CalendarDay[] = []
    for (let c = 0; c < 7; c++) {
      days.push({ year: cursor.year, month: cursor.month, day: cursor.day, inMonth: cursor.year === year && cursor.month === month })
      cursor = addDays(cursor, 1)
    }
    // the week number of the row's Thursday (Monday-start) or Monday (Sunday-start): its ISO week
    const ref = days[weekStart === 'monday' ? 3 : 1]!
    weeks.push({ week: isoWeek(ref.year, ref.month, ref.day), days })
  }
  return weeks
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Two-letter weekday headings in grid order. */
export function weekdayHeadings(weekStart: 'monday' | 'sunday' = 'monday'): string[] {
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
  return weekStart === 'monday' ? [...names.slice(1), names[0]!] : names
}

/** The wall clock now in a zone. */
export function nowIn(timeZone: string = defaultTimeZone(), now: Date = new Date()): WallDate {
  const local = utcToLocalInput(now.toISOString().replace(/\.\d+Z$/, 'Z'), timeZone)
  return parseCanonical(local)!
}

// ---- formats -------------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, '0')
const p4 = (n: number) => String(n).padStart(4, '0')

/** The value the kernel sends: `YYYY-MM-DD`, or the local `YYYY-MM-DDTHH:MM:SS` for a DATE_TIME. */
export function canonicalOf(w: WallDate, kind: DateKind): string {
  const date = `${p4(w.year)}-${p2(w.month)}-${p2(w.day)}`
  return kind === 'DATE' ? date : `${date}T${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`
}

const CANONICAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/

/** Reads a canonical value (`YYYY-MM-DD`, local `YYYY-MM-DDTHH:MM[:SS]`, or a zoned instant read in `timeZone`). */
export function parseCanonical(value: unknown, timeZone: string = defaultTimeZone()): WallDate | undefined {
  if (typeof value !== 'string') return undefined
  const text = isInstant(value) ? utcToLocalInput(value, timeZone) : (value as string).trim()
  const m = CANONICAL.exec(text)
  if (!m) return undefined
  const w = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0) }
  return rangeProblem(w) ? undefined : w
}

/** The format hint shown beside a field: `YYYY-MM-DD`, `MM/DD/YYYY HH:mm`, `DD/MM/YYYY hh:mm AM`… */
export function formatHint(kind: DateKind, settings: Pick<ResolvedDateSettings, 'order' | 'clock'>, withSeconds = false): string {
  const date = settings.order === 'MDY' ? 'MM/DD/YYYY' : settings.order === 'DMY' ? 'DD/MM/YYYY' : 'YYYY-MM-DD'
  if (kind === 'DATE') return date
  const time = settings.clock === '12h' ? `hh:mm${withSeconds ? ':ss' : ''} AM` : `HH:mm${withSeconds ? ':ss' : ''}`
  return `${date} ${time}`
}

/** The date part in the display format. */
export function formatDatePart(w: Pick<WallDate, 'year' | 'month' | 'day'>, order: DateOrder): string {
  if (order === 'MDY') return `${p2(w.month)}/${p2(w.day)}/${p4(w.year)}`
  if (order === 'DMY') return `${p2(w.day)}/${p2(w.month)}/${p4(w.year)}`
  return `${p4(w.year)}-${p2(w.month)}-${p2(w.day)}`
}

/** The time part on the chosen clock: `14:30`, `02:30 PM` (seconds when asked). */
export function formatTimePart(w: Pick<WallDate, 'hour' | 'minute' | 'second'>, clock: '24h' | '12h', withSeconds = false): string {
  const sec = withSeconds ? `:${p2(w.second)}` : ''
  if (clock === '24h') return `${p2(w.hour)}:${p2(w.minute)}${sec}`
  const h = w.hour % 12 || 12
  return `${p2(h)}:${p2(w.minute)}${sec} ${w.hour < 12 ? 'AM' : 'PM'}`
}

/** A wall date in the display format. */
export function formatWall(w: WallDate, kind: DateKind, settings: Pick<ResolvedDateSettings, 'order' | 'clock'>, withSeconds = false): string {
  const date = formatDatePart(w, settings.order)
  return kind === 'DATE' ? date : `${date} ${formatTimePart(w, settings.clock, withSeconds)}`
}

/**
 * A stored value in the display format: canonical values and instants (read in the zone) are
 * formatted, anything else (an expression, text the server sent) is returned unchanged.
 */
export function formatDateValue(value: unknown, kind: DateKind, settings: Pick<ResolvedDateSettings, 'order' | 'clock'>, options: { timeZone?: string; withSeconds?: boolean } = {}): string {
  if (value === null || value === undefined) return ''
  const w = parseCanonical(value, options.timeZone)
  return w ? formatWall(w, kind, settings, options.withSeconds ?? (kind === 'DATE_TIME' && w.second !== 0)) : String(value)
}

// ---- parsing -------------------------------------------------------------------------------

/** Why a wall date does not exist, or undefined when it does. */
function rangeProblem(w: WallDate): string | undefined {
  if (w.year < 1 || w.year > 9999) return `year ${w.year} is out of range (1-9999)`
  if (w.month < 1 || w.month > 12) return `month ${w.month} does not exist (1-12)`
  const dim = daysInMonth(w.year, w.month)
  if (w.day < 1 || w.day > dim) return w.day < 1 ? `day ${w.day} does not exist` : `${MONTH_NAMES[w.month - 1]} ${w.year} has ${dim} days`
  if (w.hour < 0 || w.hour > 23) return `hour ${w.hour} is out of range (0-23)`
  if (w.minute < 0 || w.minute > 59) return `minute ${w.minute} is out of range (0-59)`
  if (w.second < 0 || w.second > 59) return `second ${w.second} is out of range (0-59)`
  return undefined
}

export type DateParse =
  | { ok: true; value: null }
  | { ok: true; value: string; wall: WallDate }
  /** A filter expression kept for the server (`now(-7d)`, `thisPeriod(month)`), in `expressions: 'keep'` mode. */
  | { ok: true; value: string; expression: true }
  | { ok: false; reason: string }

export interface DateParseOptions {
  kind: DateKind
  settings?: Pick<ResolvedDateSettings, 'order' | 'weekStart'>
  /** The zone of wall-clock times and of `now` (default: the TZ environment). */
  timeZone?: string
  /** The moment `now` and `today` mean (tests pin it). */
  now?: Date
  /** Relative forms: resolved to a date (forms, the default) or kept as expressions (filters). */
  expressions?: 'resolve' | 'keep'
  /** Keep seconds of `now` (when the field shows seconds); otherwise they are zero. */
  withSeconds?: boolean
}

const TIME_UNITS: Record<string, 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'> = {
  s: 'second', sec: 'second', second: 'second', min: 'minute', minute: 'minute', h: 'hour', hr: 'hour', hour: 'hour',
  d: 'day', day: 'day', w: 'week', week: 'week', mo: 'month', month: 'month', y: 'year', year: 'year',
}
const PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year'])

/** The two-digit year 26 as 2026, 85 as 1985: within 20 years ahead of now, else the century before. */
function fullYear(two: number, now: WallDate): number {
  const century = Math.floor(now.year / 100) * 100
  const y = century + two
  return y > now.year + 20 ? y - 100 : y
}

/** A time typed alone or after a date: `14:30`, `14:30:15`, `2:30 pm`, `2pm`, `2.30pm`. */
function parseTime(text: string): { hour: number; minute: number; second: number } | string | undefined {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2})(?:\.\d+)?)?\s*([ap])\.?(?:m\.?)?$/i.exec(text) ?? /^(\d{1,2})[:.](\d{2})(?::(\d{2})(?:\.\d+)?)?()$/.exec(text)
  if (!m) return undefined
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const second = Number(m[3] ?? 0)
  const ampm = (m[4] ?? '').toLowerCase()
  if (ampm) {
    if (hour < 1 || hour > 12) return `12-hour times take hours 1-12 (got ${hour} ${ampm}m)`
    hour = (hour % 12) + (ampm === 'p' ? 12 : 0)
  }
  if (hour > 23) return `hour ${hour} is out of range (0-23)`
  if (minute > 59) return `minute ${minute} is out of range (0-59)`
  if (second > 59) return `second ${second} is out of range (0-59)`
  return { hour, minute, second }
}

/** A date typed in any accepted form, or a reason it is not one. */
function parseDatePart(text: string, order: DateOrder, now: WallDate): Pick<WallDate, 'year' | 'month' | 'day'> | string | undefined {
  let m: RegExpExecArray | null
  // year first is never ambiguous: 2026-03-05, 2026-3-5, 2026/3/5, 2026.3.5
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text))) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(text))) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  if ((m = /^(\d{1,2})([/.])(\d{1,2})(?:\2(\d{4}|\d{2}))?$/.exec(text))) {
    if (order === 'YMD') return `"${text}" could be month/day or day/month: type YYYY-MM-DD, or set the date order (:dates order mdy or dmy)`
    const [a, b] = [Number(m[1]), Number(m[3])]
    const year = m[4] === undefined ? now.year : m[4].length === 2 ? fullYear(Number(m[4]), now) : Number(m[4])
    return order === 'MDY' ? { year, month: a, day: b } : { year, month: b, day: a }
  }
  return undefined
}

/** Resolves a relative form against now: `now(-7d)` and `startOf(month, -1)`. */
function resolveRelative(text: string, now: WallDate, timeZone: string, weekStart: 'monday' | 'sunday'): WallDate | string | undefined {
  let m: RegExpExecArray | null
  const nowInstant = wallTimeToInstant(now.year, now.month, now.day, now.hour, now.minute, now.second, 0, timeZone)
  if (/^now\(\s*\)$/i.test(text)) return now
  if ((m = /^now\(\s*([+-])\s*(\d+)\s*([a-z]+?)s?\s*\)$/i.exec(text))) {
    const unit = TIME_UNITS[m[3]!.toLowerCase()]
    if (!unit) return `unknown time unit "${m[3]}"; use s, min, h, d, w, mo or y`
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1)
    if (unit === 'second' || unit === 'minute' || unit === 'hour') {
      const ms = nowInstant + n * { second: 1000, minute: 60_000, hour: 3_600_000 }[unit]
      return parseCanonical(utcToLocalInput(new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'), timeZone))!
    }
    if (unit === 'day') return addDays(now, n)
    if (unit === 'week') return addDays(now, n * 7)
    return addMonths(now, unit === 'month' ? n : n * 12)
  }
  if ((m = /^startOf\(\s*([a-z]+?)s?\s*(?:,\s*([+-]?\d+)\s*)?\)$/i.exec(text))) {
    const unit = m[1]!.toLowerCase()
    if (!PERIODS.has(unit)) return `unknown period "${m[1]}"; use day, week, month, quarter or year`
    const offset = Number(m[2] ?? 0)
    const midnight: WallDate = { ...now, hour: 0, minute: 0, second: 0 }
    if (unit === 'day') return addDays(midnight, offset)
    if (unit === 'week') {
      const back = weekStart === 'monday' ? (weekdayOf(now.year, now.month, now.day) + 6) % 7 : weekdayOf(now.year, now.month, now.day)
      return addDays(midnight, -back + offset * 7)
    }
    const first: WallDate = { ...midnight, day: 1 }
    if (unit === 'month') return addMonths(first, offset)
    if (unit === 'quarter') return addMonths({ ...first, month: Math.floor((now.month - 1) / 3) * 3 + 1 }, offset * 3)
    return addMonths({ ...first, month: 1 }, offset * 12)
  }
  if (/^(this|last)Period\(/i.test(text)) return `"${text}" is a period, not one date: use it in a filter, or startOf(...) for its first day`
  return undefined
}

/**
 * Reads what a person typed for a DATE or DATE_TIME. Accepts ISO (`2026-03-05`, `2026-03-05T14:30`,
 * zoned instants), the display format (`03/05/2026 2:30 PM` when the order is MDY), partial input
 * completed (`2026-3-5`, `3/5` in the current year, `3/5/26`, `20260305`), `t`/`today`,
 * `n`/`now`, a time alone for a DATE_TIME (today at that time), and the filter grammar's relative
 * forms (`now()`, `now(-7d)`, `startOf(month)`, `startOf(month, -1)`). Empty text is no value.
 * The reason of a refusal names what was wrong (`February 2026 has 28 days`).
 */
export function parseDateInput(input: string, options: DateParseOptions): DateParse {
  const text = input.trim().replace(/\s+/g, ' ')
  if (!text) return { ok: true, value: null }
  const kind = options.kind
  const order = options.settings?.order ?? 'YMD'
  const timeZone = options.timeZone ?? defaultTimeZone()
  const nowDate = options.now ?? new Date()
  const nowWall = nowIn(timeZone, nowDate)
  const nowShown: WallDate = options.withSeconds ? nowWall : { ...nowWall, second: 0 }
  const done = (w: WallDate): DateParse => {
    const problem = rangeProblem(w)
    if (problem) return { ok: false, reason: problem }
    const wall = kind === 'DATE' ? { ...w, hour: 0, minute: 0, second: 0 } : w
    return { ok: true, value: canonicalOf(wall, kind), wall }
  }
  const lower = text.toLowerCase()
  if (lower === 't' || lower === 'today') return done({ ...nowWall, hour: 0, minute: 0, second: 0 })
  if (lower === 'n' || lower === 'now') return done(nowShown)
  if (/^[a-z]+\(.*\)$/i.test(text)) {
    if (options.expressions === 'keep') {
      if (/^(now|startOf|thisPeriod|lastPeriod)\(/i.test(text)) return { ok: true, value: text, expression: true }
      return { ok: false, reason: `"${text}" is not a date expression; use now(-7d), startOf(month), thisPeriod(week)` }
    }
    const r = resolveRelative(text, nowShown, timeZone, options.settings?.weekStart ?? 'monday')
    if (typeof r === 'string') return { ok: false, reason: r }
    if (r) return done(r)
    return { ok: false, reason: `"${text}" is not a date expression; use now(-7d) or startOf(month)` }
  }
  if (isInstant(text)) {
    if (kind === 'DATE') return { ok: false, reason: `"${text}" is a date and time; a date takes YYYY-MM-DD` }
    const ms = Date.parse(text.replace(' ', 'T'))
    const w = parseCanonical(utcToLocalInput(new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), timeZone))
    if (w) return done(w)
  }
  // a date, optionally followed by a time (after T or a space)
  const split = /^(\S+?)(?:[T ](.+))?$/i.exec(text)!
  const datePart = parseDatePart(split[1]!, order, nowWall)
  if (typeof datePart === 'string') return { ok: false, reason: datePart }
  if (datePart) {
    if (split[2] === undefined) return done({ ...datePart, hour: 0, minute: 0, second: 0 })
    if (kind === 'DATE') return { ok: false, reason: `a date has no time: type ${formatHint('DATE', { order, clock: '24h' })}` }
    const time = parseTime(split[2].trim())
    if (typeof time === 'string') return { ok: false, reason: time }
    if (!time) return { ok: false, reason: `"${split[2].trim()}" is not a time: type HH:mm, HH:mm:ss or 2:30 PM` }
    return done({ ...datePart, ...time })
  }
  // a time alone: today at that time
  const timeOnly = parseTime(text)
  if (typeof timeOnly === 'string') return { ok: false, reason: timeOnly }
  if (timeOnly) {
    if (kind === 'DATE') return { ok: false, reason: `"${text}" is a time; a date takes ${formatHint('DATE', { order, clock: '24h' })}` }
    return done({ ...nowWall, ...timeOnly })
  }
  return { ok: false, reason: `"${text}" is not a ${kind === 'DATE' ? 'date' : 'date and time'}: type ${formatHint(kind, { order, clock: '24h' })}, t for today${kind === 'DATE_TIME' ? ', n for now' : ''}, or now(-7d)` }
}

/** The zone's short name and UTC offset at a wall time (`CDT, UTC-05:00`), for the picker's zone line. */
export function zoneLabel(w: WallDate, timeZone: string = defaultTimeZone()): string {
  const ms = wallTimeToInstant(w.year, w.month, w.day, w.hour, w.minute, w.second, 0, timeZone)
  const off = zoneOffset(ms, timeZone) / 60_000
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  let short = ''
  try {
    short = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    short = ''
  }
  const utc = `UTC${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
  return short && short !== utc && !/^GMT[+-]/.test(short) ? `${short}, ${utc}` : utc
}
