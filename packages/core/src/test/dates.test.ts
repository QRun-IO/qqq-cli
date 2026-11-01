/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  addDays, addMonths, daysInMonth, formatDateValue, formatHint, isoWeek, localeFromEnv, monthGrid, parseCanonical, parseDateInput, readDateSettings, resolveDateSettings, weekdayHeadings, weekdayOf, writeDateSettings, zoneLabel,
  type DateKind, type DateOrder, type DateParseOptions,
} from '../forms/dates.js'
import { localToUtc } from '../forms/datetime.js'
import { upsertProfile } from '../session/profiles.js'

/** Monday 2026-06-15 15:20:45 UTC. */
const NOW = new Date('2026-06-15T15:20:45Z')

function parse(text: string, kind: DateKind = 'DATE', order: DateOrder = 'YMD', extra: Partial<DateParseOptions> = {}): string | null {
  const r = parseDateInput(text, { kind, settings: { order, weekStart: 'monday' }, timeZone: 'UTC', now: NOW, ...extra })
  if (!r.ok) throw new Error(`refused ${text}: ${r.reason}`)
  return r.value
}

function reason(text: string, kind: DateKind = 'DATE', order: DateOrder = 'YMD', extra: Partial<DateParseOptions> = {}): string {
  const r = parseDateInput(text, { kind, settings: { order, weekStart: 'monday' }, timeZone: 'UTC', now: NOW, ...extra })
  if (r.ok) throw new Error(`accepted ${text} as ${String(r.value)}`)
  return r.reason
}

test('ISO dates, partial ISO completed, year-first with other separators, compact', () => {
  assert.equal(parse('2026-03-05'), '2026-03-05')
  assert.equal(parse('2026-3-5'), '2026-03-05')
  assert.equal(parse(' 2026-3-5 '), '2026-03-05')
  assert.equal(parse('2026/3/5'), '2026-03-05')
  assert.equal(parse('2026.03.05'), '2026-03-05')
  assert.equal(parse('20260305'), '2026-03-05')
  assert.equal(parse('2024-02-29'), '2024-02-29')
})

test('empty text is no value', () => {
  assert.equal(parse(''), null)
  assert.equal(parse('   ', 'DATE_TIME'), null)
})

test('t, today, n, now', () => {
  assert.equal(parse('t'), '2026-06-15')
  assert.equal(parse('Today'), '2026-06-15')
  assert.equal(parse('n'), '2026-06-15')
  assert.equal(parse('now'), '2026-06-15')
  assert.equal(parse('t', 'DATE_TIME'), '2026-06-15T00:00:00')
  assert.equal(parse('n', 'DATE_TIME'), '2026-06-15T15:20:00')
  assert.equal(parse('now', 'DATE_TIME', 'YMD', { withSeconds: true }), '2026-06-15T15:20:45')
  // today in the zone: 15:20 UTC is already tomorrow in Auckland
  assert.equal(parse('t', 'DATE', 'YMD', { timeZone: 'Pacific/Auckland' }), '2026-06-16')
})

test('relative forms of the filter grammar resolve to a date in forms', () => {
  assert.equal(parse('now()'), '2026-06-15')
  assert.equal(parse('now(-7d)'), '2026-06-08')
  assert.equal(parse('now(+2w)'), '2026-06-29')
  assert.equal(parse('now(-1mo)'), '2026-05-15')
  assert.equal(parse('now(-1y)'), '2025-06-15')
  assert.equal(parse('now(+3h)', 'DATE_TIME'), '2026-06-15T18:20:00')
  assert.equal(parse('now(-30min)', 'DATE_TIME'), '2026-06-15T14:50:00')
  assert.equal(parse('startOf(month)'), '2026-06-01')
  assert.equal(parse('startOf(month, -1)'), '2026-05-01')
  assert.equal(parse('startOf(year)'), '2026-01-01')
  assert.equal(parse('startOf(quarter)'), '2026-04-01')
  assert.equal(parse('startOf(week)'), '2026-06-15')
  assert.equal(parse('startOf(week)', 'DATE', 'YMD', { settings: { order: 'YMD', weekStart: 'sunday' } }), '2026-06-14')
  assert.equal(parse('startOf(day)', 'DATE_TIME'), '2026-06-15T00:00:00')
  assert.equal(parse('startOf(days, 1)', 'DATE_TIME'), '2026-06-16T00:00:00')
})

test('relative forms are kept as expressions for filters', () => {
  const keep = { expressions: 'keep' as const }
  assert.deepEqual(parseDateInput('now(-7d)', { kind: 'DATE', timeZone: 'UTC', now: NOW, ...keep }), { ok: true, value: 'now(-7d)', expression: true })
  assert.deepEqual(parseDateInput('thisPeriod(month)', { kind: 'DATE', timeZone: 'UTC', now: NOW, ...keep }), { ok: true, value: 'thisPeriod(month)', expression: true })
  assert.equal(parse('t', 'DATE', 'YMD', keep), '2026-06-15')
})

test('relative forms that are not one date, or unknown, are refused with the reason', () => {
  assert.match(reason('thisPeriod(month)'), /is a period, not one date/)
  assert.match(reason('now(-7q)'), /unknown time unit "q"/)
  assert.match(reason('startOf(fortnight)'), /unknown period "fortnight"/)
  assert.match(reason('tomorrow(1)'), /is not a date expression/)
  assert.match(reason('me()', 'DATE', 'YMD', { expressions: 'keep' }), /is not a date expression/)
})

test('slash and dot dates follow the profile order; current year when it is left out; two-digit years', () => {
  assert.equal(parse('3/5', 'DATE', 'MDY'), '2026-03-05')
  assert.equal(parse('3/5', 'DATE', 'DMY'), '2026-05-03')
  assert.equal(parse('01/02/2026', 'DATE', 'MDY'), '2026-01-02')
  assert.equal(parse('01/02/2026', 'DATE', 'DMY'), '2026-02-01')
  assert.equal(parse('5.3.2026', 'DATE', 'DMY'), '2026-03-05')
  assert.equal(parse('3/5/26', 'DATE', 'MDY'), '2026-03-05')
  assert.equal(parse('3/5/85', 'DATE', 'MDY'), '1985-03-05')
  assert.equal(parse('3/5/46', 'DATE', 'MDY'), '2046-03-05')
  assert.equal(parse('3/5/47', 'DATE', 'MDY'), '1947-03-05')
})

test('slash dates are refused under the ISO order: no guessing which part is the month', () => {
  assert.match(reason('01/02/2026'), /could be month\/day or day\/month.*:dates order mdy or dmy/)
  assert.match(reason('3/5'), /could be month\/day or day\/month/)
  // mixed separators are not a date
  assert.match(reason('3/5.2026', 'DATE', 'MDY'), /is not a date/)
})

test('dates that do not exist are refused with the exact reason', () => {
  assert.equal(reason('2026-02-29'), 'February 2026 has 28 days')
  assert.equal(reason('2026-04-31'), 'April 2026 has 30 days')
  assert.equal(reason('2026-13-01'), 'month 13 does not exist (1-12)')
  assert.equal(reason('2026-00-10'), 'month 0 does not exist (1-12)')
  assert.equal(reason('2026-01-00'), 'day 0 does not exist')
  assert.equal(reason('0000-01-01'), 'year 0 is out of range (1-9999)')
  assert.equal(reason('13/13', 'DATE', 'MDY'), 'month 13 does not exist (1-12)')
})

test('garbage and times on a DATE are refused', () => {
  assert.match(reason('next tuesday'), /"next tuesday" is not a date: type YYYY-MM-DD, t for today, or now\(-7d\)/)
  assert.match(reason('2026-03'), /is not a date/)
  assert.match(reason('2026-03-05 14:30'), /a date has no time: type YYYY-MM-DD/)
  assert.match(reason('2026-03-05T14:30:00Z'), /a date takes YYYY-MM-DD/)
  assert.match(reason('14:30'), /is a time; a date takes YYYY-MM-DD/)
  assert.match(reason('abc', 'DATE', 'DMY'), /type DD\/MM\/YYYY/)
})

test('date-times: ISO, display format, 12-hour, seconds, a time alone (today), a date alone (midnight)', () => {
  assert.equal(parse('2026-03-05T14:30', 'DATE_TIME'), '2026-03-05T14:30:00')
  assert.equal(parse('2026-03-05 14:30:15', 'DATE_TIME'), '2026-03-05T14:30:15')
  assert.equal(parse('2026-3-5 9:05', 'DATE_TIME'), '2026-03-05T09:05:00')
  assert.equal(parse('2026-03-05', 'DATE_TIME'), '2026-03-05T00:00:00')
  assert.equal(parse('03/05/2026 02:30 PM', 'DATE_TIME', 'MDY'), '2026-03-05T14:30:00')
  assert.equal(parse('3/5 2pm', 'DATE_TIME', 'MDY'), '2026-03-05T14:00:00')
  assert.equal(parse('05/03/2026 12:15 am', 'DATE_TIME', 'DMY'), '2026-03-05T00:15:00')
  assert.equal(parse('2026-03-05 12:00 p.m.', 'DATE_TIME'), '2026-03-05T12:00:00')
  assert.equal(parse('14:30', 'DATE_TIME'), '2026-06-15T14:30:00')
  assert.equal(parse('2:30 pm', 'DATE_TIME'), '2026-06-15T14:30:00')
  assert.equal(parse('2026-03-05T14:30:00.250', 'DATE_TIME'), '2026-03-05T14:30:00')
})

test('zoned instants are read in the zone of the person', () => {
  assert.equal(parse('2026-03-05T20:30:00Z', 'DATE_TIME', 'YMD', { timeZone: 'America/Chicago' }), '2026-03-05T14:30:00')
  assert.equal(parse('2026-07-05T12:00:00+02:00', 'DATE_TIME', 'YMD', { timeZone: 'UTC' }), '2026-07-05T10:00:00')
})

test('times out of range are refused with the reason', () => {
  assert.equal(reason('2026-03-05 25:00', 'DATE_TIME'), 'hour 25 is out of range (0-23)')
  assert.equal(reason('2026-03-05 10:61', 'DATE_TIME'), 'minute 61 is out of range (0-59)')
  assert.equal(reason('2026-03-05 10:30:75', 'DATE_TIME'), 'second 75 is out of range (0-59)')
  assert.equal(reason('2026-03-05 13pm', 'DATE_TIME'), '12-hour times take hours 1-12 (got 13 pm)')
  assert.equal(reason('2026-03-05 0:30 am', 'DATE_TIME'), '12-hour times take hours 1-12 (got 0 am)')
  assert.match(reason('2026-03-05 noonish', 'DATE_TIME'), /"noonish" is not a time/)
  assert.match(reason('soon', 'DATE_TIME'), /type YYYY-MM-DD HH:mm, t for today, n for now/)
})

test('what the form sends: the canonical local value becomes the same UTC instant the kernel already makes', () => {
  const local = parse('03/05/2026 02:30 PM', 'DATE_TIME', 'MDY')!
  assert.equal(localToUtc(local, { timeZone: 'America/Chicago' }), '2026-03-05T20:30:00Z')
  assert.equal(localToUtc(parse('2026-03-05T14:30', 'DATE_TIME')!, { timeZone: 'America/Chicago' }), localToUtc('2026-03-05T14:30', { timeZone: 'America/Chicago' }))
})

test('display formats and hints', () => {
  const iso = { order: 'YMD' as const, clock: '24h' as const }
  const us = { order: 'MDY' as const, clock: '12h' as const }
  const eu = { order: 'DMY' as const, clock: '24h' as const }
  assert.equal(formatHint('DATE', iso), 'YYYY-MM-DD')
  assert.equal(formatHint('DATE_TIME', iso), 'YYYY-MM-DD HH:mm')
  assert.equal(formatHint('DATE_TIME', us, true), 'MM/DD/YYYY hh:mm:ss AM')
  assert.equal(formatHint('DATE', eu), 'DD/MM/YYYY')
  assert.equal(formatDateValue('2026-03-05', 'DATE', iso), '2026-03-05')
  assert.equal(formatDateValue('2026-03-05', 'DATE', us), '03/05/2026')
  assert.equal(formatDateValue('2026-03-05', 'DATE', eu), '05/03/2026')
  assert.equal(formatDateValue('2026-03-05T14:30:00', 'DATE_TIME', iso), '2026-03-05 14:30')
  assert.equal(formatDateValue('2026-03-05T00:05:00', 'DATE_TIME', us), '03/05/2026 12:05 AM')
  assert.equal(formatDateValue('2026-03-05T14:30:15', 'DATE_TIME', iso), '2026-03-05 14:30:15')
  assert.equal(formatDateValue('2026-03-05T20:30:00Z', 'DATE_TIME', iso, { timeZone: 'America/Chicago' }), '2026-03-05 14:30')
  assert.equal(formatDateValue('now(-7d)', 'DATE', iso), 'now(-7d)')
  assert.equal(formatDateValue(null, 'DATE', iso), '')
  // what is shown parses back to what was stored, in every order and clock
  for (const s of [iso, us, eu]) {
    for (const v of ['2026-03-05T14:30:00', '2026-12-31T00:00:00', '2026-01-09T12:59:00']) {
      assert.equal(parse(formatDateValue(v, 'DATE_TIME', s), 'DATE_TIME', s.order), v)
    }
    assert.equal(parse(formatDateValue('2026-11-30', 'DATE', s), 'DATE', s.order), '2026-11-30')
  }
})

test('canonical values read back; invalid ones do not', () => {
  assert.deepEqual(parseCanonical('2026-03-05'), { year: 2026, month: 3, day: 5, hour: 0, minute: 0, second: 0 })
  assert.deepEqual(parseCanonical('2026-03-05T14:30'), { year: 2026, month: 3, day: 5, hour: 14, minute: 30, second: 0 })
  assert.equal(parseCanonical('2026-02-30'), undefined)
  assert.equal(parseCanonical('03/05/2026'), undefined)
  assert.equal(parseCanonical(12), undefined)
})

test('calendar arithmetic: month lengths, weekdays, ISO weeks, adding days and months', () => {
  assert.equal(daysInMonth(2024, 2), 29)
  assert.equal(daysInMonth(1900, 2), 28)
  assert.equal(daysInMonth(2000, 2), 29)
  assert.equal(weekdayOf(2026, 6, 15), 1)
  assert.equal(weekdayOf(2026, 11, 1), 0)
  assert.equal(isoWeek(2026, 1, 1), 1)
  assert.equal(isoWeek(2027, 1, 1), 53)
  assert.equal(isoWeek(2026, 12, 31), 53)
  assert.equal(isoWeek(2024, 12, 30), 1)
  const d = { year: 2026, month: 1, day: 31, hour: 9, minute: 0, second: 0 }
  assert.deepEqual(addMonths(d, 1), { ...d, month: 2, day: 28 })
  assert.deepEqual(addMonths(d, -2), { ...d, year: 2025, month: 11, day: 30 })
  assert.deepEqual(addMonths(d, 12), { ...d, year: 2027 })
  assert.deepEqual(addDays(d, 1), { ...d, month: 2, day: 1 })
  assert.deepEqual(addDays({ ...d, year: 2024, month: 2, day: 28 }, 1), { ...d, year: 2024, month: 2, day: 29 })
  assert.deepEqual(addDays(d, -31), { ...d, month: 12, day: 31, year: 2025 })
})

test('month grids start on the chosen weekday and carry week numbers', () => {
  const mon = monthGrid(2026, 6, 'monday')
  assert.equal(mon.length, 6)
  assert.deepEqual(mon[0]!.days[0], { year: 2026, month: 6, day: 1, inMonth: true })
  assert.equal(mon[0]!.week, 23)
  const sun = monthGrid(2026, 6, 'sunday')
  assert.deepEqual(sun[0]!.days[0], { year: 2026, month: 5, day: 31, inMonth: false })
  assert.deepEqual(sun[0]!.days[1], { year: 2026, month: 6, day: 1, inMonth: true })
  const feb = monthGrid(2026, 2, 'monday')
  assert.deepEqual(feb[0]!.days.map((x) => x.day), [26, 27, 28, 29, 30, 31, 1])
  assert.deepEqual(weekdayHeadings('monday'), ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
  assert.deepEqual(weekdayHeadings('sunday'), ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
})

test('settings: saved values win, then the locale, then ISO / 24-hour / Monday', () => {
  assert.deepEqual(resolveDateSettings(), { order: 'YMD', clock: '24h', weekStart: 'monday', weekNumbers: false, pickerOnEnter: false })
  assert.deepEqual(resolveDateSettings({}, 'en-US'), { order: 'YMD', clock: '12h', weekStart: 'sunday', weekNumbers: false, pickerOnEnter: false })
  assert.equal(resolveDateSettings({}, 'de-DE').clock, '24h')
  assert.equal(resolveDateSettings({}, 'de-DE').weekStart, 'monday')
  assert.equal(resolveDateSettings({ clock: '24h', weekStart: 'monday' }, 'en-US').clock, '24h')
  assert.equal(resolveDateSettings({ order: 'XYZ' as never }).order, 'YMD')
  assert.equal(localeFromEnv({ LANG: 'en_US.UTF-8' }), 'en-US')
  assert.equal(localeFromEnv({ LANG: 'de_DE.UTF-8', LC_TIME: 'fr_FR.UTF-8' }), 'fr-FR')
  assert.equal(localeFromEnv({ LANG: 'C' }), undefined)
  assert.equal(localeFromEnv({}), undefined)
})

test('settings are saved globally and per profile; the profile wins', () => {
  const env = { QQQ_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'qqq-dates-')) }
  upsertProfile('p1', { server: 'http://x.test' }, {}, env)
  writeDateSettings({ order: 'MDY', weekNumbers: true }, {}, env)
  writeDateSettings({ order: 'DMY' }, { profile: 'p1' }, env)
  writeDateSettings({ clock: '12h' }, {}, env)
  assert.deepEqual(readDateSettings(undefined, env), { order: 'MDY', weekNumbers: true, clock: '12h' })
  assert.deepEqual(readDateSettings('p1', env), { order: 'DMY', weekNumbers: true, clock: '12h' })
})

test('the zone line names the zone and its offset at that date', () => {
  assert.equal(zoneLabel({ year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 }, 'America/Chicago'), 'CST, UTC-06:00')
  assert.equal(zoneLabel({ year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 }, 'America/Chicago'), 'CDT, UTC-05:00')
  assert.equal(zoneLabel({ year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 }, 'UTC'), 'UTC, UTC+00:00')
  assert.equal(zoneLabel({ year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 }, 'Asia/Kolkata'), 'UTC+05:30')
})
