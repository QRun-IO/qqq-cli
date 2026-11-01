/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The F6 filter dialog: condition rows of three cells, each value cell edited the way its type asks. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { readViewSettings, writeViewSettings } from '@qrun-io/qqq-core'
import type { TableMetaData } from '../src/client'
import {
  FilterOverlay, defaultOperator, fieldKind, filterOf, guidedProblem, isApplied, levelsOf, mixedJoinAt, operatorLabel, operatorsFor, valuesFromText,
} from '../src/overlays/filter'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const key = (k: string, mods?: { ctrl?: boolean; shift?: boolean }) => press(h!, () => h!.setup.mockInput.pressKey(k, mods))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())
const esc = () => press(h!, () => h!.setup.mockInput.pressEscape())
const arrow = (d: 'up' | 'down' | 'left' | 'right') => press(h!, () => h!.setup.mockInput.pressArrow(d))

const text = { name: 't', label: 'T', type: 'STRING' }
const num = { name: 'n', label: 'N', type: 'INTEGER' }
const date = { name: 'd', label: 'D', type: 'DATE' }
const bool = { name: 'b', label: 'B', type: 'BOOLEAN' }
const choice = { name: 'c', label: 'C', type: 'STRING', possibleValueSourceName: 'x' }

test('each field kind gets its own default comparison and operator list', () => {
  expect([text, num, date, bool, choice].map((f) => fieldKind(f as never))).toEqual(['text', 'number', 'date', 'bool', 'choice'])
  expect([text, num, date, bool, choice].map((f) => defaultOperator(f as never))).toEqual(['CONTAINS', 'EQUALS', 'EQUALS', 'EQUALS', 'IN'])
  expect(operatorsFor(num as never).slice(0, 8)).toEqual(['EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'BETWEEN', 'NOT_BETWEEN'])
  expect(operatorsFor(num as never)).toContain('IS_BLANK')
  expect(operatorsFor(bool as never)).toEqual(['EQUALS', 'IS_BLANK', 'IS_NOT_BLANK', 'NOT_EQUALS'])
  expect(operatorLabel('EQUALS', 'bool')).toBe('is')
  expect(operatorLabel('TRUE', 'bool')).toBe('is')
  expect(operatorLabel('NOT_EQUALS', 'number')).toBe('≠')
  expect(operatorLabel('NOT_EQUALS', 'text')).toBe('is not')
  expect(operatorLabel('IN', 'choice')).toBe('is any of')
  expect(operatorLabel('IN', 'date', true)).toBe('weekday is')
})

test('typed values: text as typed, numbers and dates checked, lists and ranges split, empty means no value', () => {
  expect(valuesFromText(text as never, 'CONTAINS', ' a, b ')).toEqual(['a, b'])
  expect(valuesFromText(text as never, 'IN', 'a, "b, c";d')).toEqual(['a', 'b, c', 'd'])
  expect(valuesFromText(num as never, 'EQUALS', '42')).toEqual(['42'])
  expect(() => valuesFromText(num as never, 'EQUALS', 'abc')).toThrow('is not a number')
  expect(valuesFromText(num as never, 'BETWEEN', '1 and 10')).toEqual(['1', '10'])
  expect(() => valuesFromText(num as never, 'BETWEEN', '1')).toThrow('two values')
  expect(valuesFromText(date as never, 'BETWEEN', '2026-01-01, now(-7d)')).toEqual(['2026-01-01', { type: 'NowWithOffset', operator: 'MINUS', amount: 7, timeUnit: 'DAYS' }])
  expect(() => valuesFromText(date as never, 'EQUALS', 'yesterday')).toThrow('is not a date')
  expect(valuesFromText(text as never, 'CONTAINS', '   ')).toEqual([])
})

test('levels and filters round trip; rows without a value are left out; EQUALS true reads as TRUE', () => {
  const l = levelsOf({ booleanOperator: 'OR', criteria: [{ fieldName: 'b', operator: 'EQUALS', values: ['true'] }, { fieldName: 't', operator: 'CONTAINS', values: ['x'], options: ['CASE_INSENSITIVE'] }], subFilters: [{ booleanOperator: 'AND', criteria: [{ fieldName: 'n', operator: 'GREATER_THAN', values: ['3'] }] }] })
  expect(l.top.conds[0]).toEqual({ field: 'b', operator: 'TRUE', values: [] })
  l.top.conds.push({ field: 'n', operator: 'EQUALS', values: [] })
  l.groups.push({ booleanOperator: 'OR', conds: [{ field: 't', operator: 'CONTAINS', values: [] }] })
  expect(isApplied(l.top.conds[2]!)).toBe(false)
  expect(filterOf(l.top, l.groups)).toEqual({ booleanOperator: 'OR', criteria: [{ fieldName: 'b', operator: 'TRUE', values: [] }, { fieldName: 't', operator: 'CONTAINS', values: ['x'], options: ['CASE_INSENSITIVE'] }], subFilters: [{ booleanOperator: 'AND', criteria: [{ fieldName: 'n', operator: 'GREATER_THAN', values: ['3'] }] }] })
  expect(guidedProblem({ booleanOperator: 'AND', criteria: [], subFilters: [{ booleanOperator: 'OR', criteria: [], subFilters: [{ booleanOperator: 'AND', criteria: [] }] }] })).toContain('group inside a group')
  expect(mixedJoinAt('a = 1 OR b = 2 AND c = 3')).toBe(15)
  expect(mixedJoinAt('a = 1 OR (b = 2 AND c = 3) OR d > now(-1d)')).toBeUndefined()
})

/** The address table with a true/false field added to its quick fields. */
async function addressDialog(): Promise<FilterOverlay> {
  await command(h!, 'table query address')
  await waitFor(h!, (x) => x.includes('records'))
  const meta = (h!.store.screen as unknown as { meta: TableMetaData }).meta
  const withBool = { ...meta, fields: { ...meta.fields, active: { name: 'active', label: 'Active', type: 'BOOLEAN' } }, sections: [{ name: 's', label: 'Address', tier: 'T1', fieldNames: ['id', 'label', 'countryId', 'active'] }] } as unknown as TableMetaData
  const o = new FilterOverlay(h!.store, withBool, { criteria: [], booleanOperator: 'AND' }, undefined, () => undefined)
  h!.store.open(o)
  await press(h!, () => undefined)
  return o
}

const row = (o: FilterOverlay, field: string) => o.top.conds.findIndex((c) => c.field === field)

test('a true/false quick row: Space cycles (any), true, false; t and f set it; Backspace clears; the help line says so', async () => {
  h = await startTui(120, 36)
  const o = await addressDialog()
  o.focusCond(-1, row(o, 'active'))
  let f = await waitFor(h, (x) => x.includes('Active') && x.includes('Space or Enter cycles (any) → true → false'))
  expect(f).toMatch(/quick and Active\s+is\s+\(any\)/)
  f = await key(' ')
  expect(f).toContain('active TRUE')
  f = await key(' ')
  expect(f).toContain('active FALSE')
  expect(f).toContain('-g "active FALSE"')
  f = await key(' ')
  expect(f).toContain('(no criteria: every record)')
  f = await type('t')
  expect(f).toContain('active TRUE')
  f = await type('f')
  expect(f).toContain('active FALSE')
  f = await key(KeyCodes.BACKSPACE)
  expect(f).toMatch(/Active\s+is\s+\(any\)/)
  expect(o.current().criteria).toEqual([])
})

test('a choice quick row: Enter opens the list, Enter toggles values, Esc keeps them; Backspace clears', async () => {
  h = await startTui(120, 36)
  const o = await addressDialog()
  o.focusCond(-1, row(o, 'countryId'))
  await waitFor(h, (x) => x.includes('Country: Enter or typing opens the list (Enter toggles values)'))
  await enter()
  await waitFor(h, (x) => x.includes('[ ] Canada') && x.includes('[ ] USA'))
  await enter() // the cursor starts on the first value
  await waitFor(h, (x) => x.includes('[x] USA') && x.includes('1 chosen'))
  await arrow('down')
  await enter()
  await waitFor(h, (x) => x.includes('[x] Canada') && x.includes('2 chosen'))
  await enter() // toggles Canada off again
  await waitFor(h, (x) => x.includes('[ ] Canada') && x.includes('1 chosen'))
  await esc()
  let f = await waitFor(h, (x) => x.includes('countryId IN USA'))
  expect(f).toMatch(/Country\s+is any of\s+USA/)
  f = await key(KeyCodes.BACKSPACE)
  expect(f).toMatch(/Country\s+is any of\s+\(any\)/)
  // typing on the cell opens the list searching
  await type('can')
  await waitFor(h, (x) => x.includes('[ ] Canada') && !x.includes('[ ] USA'))
  await enter()
  await esc()
  await waitFor(h, (x) => x.includes('countryId IN CAN'))
})

test('a text quick row: typing edits in place, contains ignores case, Backspace clears; Esc asks before discarding', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  await key(KeyCodes.F6)
  await waitFor(h, (x) => x.includes('quick and First Name'))
  await arrow('down')
  await type('Av')
  let f = await waitFor(h, (x) => x.includes('First Name: type text (any case); Enter confirms'))
  expect(f).toContain('Enter confirm · Esc cancel edit')
  await enter()
  f = await waitFor(h, (x) => x.includes('firstName CONTAINS Av'))
  expect(f).toMatch(/First Name\s+contains\s+Av/)
  const o = h.store.overlays.at(-1) as FilterOverlay
  expect(o.current().criteria[0]!.options).toEqual(['CASE_INSENSITIVE'])
  // the live count asks the server with the filter
  await waitFor(h, () => h!.log.requests.some((r) => r.path === '/table/person/count' && JSON.stringify(r.body).includes('"Av"')))
  await waitFor(h, (x) => /matches \d+ of \d+ records/.test(x))
  await key(KeyCodes.BACKSPACE)
  f = await waitFor(h, (x) => x.includes('(no criteria: every record)'))
  await type('x')
  await enter()
  await esc()
  await waitFor(h, (x) => x.includes('Discard the changes to the filter?'))
  await type('y')
  await waitFor(h, () => !h!.store.overlays.includes(o))
})

test('numbers are checked; a date row takes between from the operator list and two dates', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  await key(KeyCodes.F6)
  await waitFor(h, (x) => x.includes('quick     Id'))
  await type('abc')
  await enter()
  await waitFor(h, (x) => x.includes('"abc" is not a number'))
  await key('u', { ctrl: true })
  await type('3')
  await enter()
  await waitFor(h, (x) => x.includes('id EQUALS 3'))
  await key('n', { ctrl: true })
  await waitFor(h, (x) => x.includes('Add a condition: which field?'))
  await type('birth')
  await enter()
  await waitFor(h, (x) => x.includes('Birth Date: type YYYY-MM-DD or now(-7d), startOf(month)'))
  await esc()
  await arrow('left')
  await waitFor(h, (x) => x.includes('Enter or typing picks the comparison'))
  await enter()
  await waitFor(h, (x) => x.includes('Birth Date: which comparison?') && x.includes('≤'))
  await type('between')
  await enter()
  await type('2000-01-01 and 2001-01-01')
  await enter()
  const f = await waitFor(h, (x) => x.includes('birthDate BETWEEN 2000-01-01,2001-01-01'))
  expect(f).toMatch(/and\s+Birth Date\s+between\s+2000-01-01 and 2001-01-01/)
})

test('OR, a group, Advanced and back; a nested group or a syntax error keeps you in Advanced and says why', async () => {
  h = await startTui(120, 40)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  await key(KeyCodes.F6)
  await waitFor(h, (x) => x.includes('quick and First Name'))
  await arrow('down')
  await type('a')
  await enter()
  await key('o', { ctrl: true })
  await key('g', { ctrl: true })
  await waitFor(h, (x) => x.includes('first field?'))
  await type('last')
  await enter()
  await type('b')
  await enter()
  let f = await waitFor(h, (x) => x.includes('firstName CONTAINS a OR (lastName CONTAINS b)'))
  expect(f).toContain('( group: its conditions joined by AND )')
  expect(f).toMatch(/quick or\s+Last Name/)
  await key(KeyCodes.F2)
  const o = h.store.overlays.at(-1) as FilterOverlay
  expect(o.mode).toBe('advanced')
  expect(o.text.value).toBe('firstName CONTAINS a OR (lastName CONTAINS b)')
  f = await waitFor(h, (x) => x.includes('cheat sheet') && x.includes('~= x'))
  await type(' AND id > 1')
  f = await waitFor(h, (x) => x.includes('Mixed AND and OR need parentheses'))
  expect(f.split('\n').some((l) => /║\s+\^\s+║/.test(l))).toBe(true)
  await key(KeyCodes.F2)
  expect(o.mode).toBe('advanced')
  await waitFor(h, (x) => x.includes('Guided needs a filter that parses'))
  o.text.set('firstName ~ a OR (lastName ~ b AND (id > 1 OR id < 0))')
  o.complete()
  await key(KeyCodes.F2)
  await waitFor(h, (x) => x.includes('a group inside a group'))
  expect(o.mode).toBe('advanced')
  o.text.set('firstName ~ a OR (lastName ~ b AND id > 1)')
  o.complete()
  await key(KeyCodes.F2)
  expect(o.mode).toBe('guided')
  f = await waitFor(h, (x) => x.includes('firstName CONTAINS a OR (lastName CONTAINS b AND id GREATER_THAN 1)'))
  expect(f).toMatch(/and\s+Id\s+>\s+1/)
  await key(KeyCodes.F10)
  await waitFor(h, () => !h!.store.overlays.includes(o))
})

test('Ctrl+D on an added quick row forgets it (also after reopening); a table quick row is only cleared', async () => {
  h = await startTui(120, 36)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  writeViewSettings('table:person', { quickFilterFields: ['birthDate'] })
  await key(KeyCodes.F6)
  await waitFor(h, (x) => x.includes('quick and Birth Date'))
  const o = h.store.overlays.at(-1) as FilterOverlay
  o.focusCond(-1, row(o, 'birthDate'))
  await key('d', { ctrl: true })
  let f = await waitFor(h, (x) => !x.includes('quick and Birth Date'))
  expect(readViewSettings('table:person').quickFilterFields).toEqual([])
  o.focusCond(-1, row(o, 'lastName'))
  await type('x')
  await enter()
  await key('d', { ctrl: true })
  f = await waitFor(h, (x) => x.includes('a quick field of the table: cleared'))
  expect(f).toMatch(/quick and Last Name\s+contains\s+\(any\)/)
  await esc()
  await key(KeyCodes.F6)
  f = await waitFor(h, (x) => x.includes('quick and Last Name'))
  expect(f).not.toContain('Birth Date')
})
