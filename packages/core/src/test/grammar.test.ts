/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFilter, parseCriterion, parseFilter, parseValue, printFilter, printValue } from '../filter/grammar.js'

test('criteria: operators, shorthand, lists, unary, quoting', () => {
  assert.deepEqual(parseCriterion('status EQUALS active'), { fieldName: 'status', operator: 'EQUALS', values: ['active'] })
  assert.deepEqual(parseCriterion('id >= 10'), { fieldName: 'id', operator: 'GREATER_THAN_OR_EQUALS', values: ['10'] })
  assert.deepEqual(parseCriterion('id IN 1, 2,3'), { fieldName: 'id', operator: 'IN', values: ['1', '2', '3'] })
  assert.deepEqual(parseCriterion('name ~ van der'), { fieldName: 'name', operator: 'CONTAINS', values: ['van der'] })
  assert.deepEqual(parseCriterion('name IS_BLANK'), { fieldName: 'name', operator: 'IS_BLANK', values: [] })
  assert.deepEqual(parseCriterion('city IN "St. Louis, MO",Chicago'), { fieldName: 'city', operator: 'IN', values: ['St. Louis, MO', 'Chicago'] })
  assert.throws(() => parseCriterion('nope EQUALS 1', ['id']), /No field "nope"/)
  assert.throws(() => parseCriterion('id ABOUT 1'), /Unknown operator/)
  assert.throws(() => parseCriterion('id BETWEEN 1'), /two values/)
  assert.throws(() => parseCriterion('id IS_BLANK x'), /takes no value/)
})

test('expressions parse and print both ways', () => {
  const cases: Array<[string, unknown, string]> = [
    ['now()', { type: 'Now' }, 'now()'],
    ['now(-7d)', { type: 'NowWithOffset', operator: 'MINUS', amount: 7, timeUnit: 'DAYS' }, 'now(-7d)'],
    ['now(+ 2 hours)', { type: 'NowWithOffset', operator: 'PLUS', amount: 2, timeUnit: 'HOURS' }, 'now(+2h)'],
    ['thisPeriod(month)', { type: 'ThisOrLastPeriod', operator: 'THIS', timeUnit: 'MONTHS' }, 'thisPeriod(month)'],
    ['lastPeriod(weeks)', { type: 'ThisOrLastPeriod', operator: 'LAST', timeUnit: 'WEEKS' }, 'lastPeriod(week)'],
    ['startOf(quarter, -1)', { type: 'StartOfPeriod', unit: 'QUARTERS', offset: -1 }, 'startOf(quarter, -1)'],
    ['startOf(year)', { type: 'StartOfPeriod', unit: 'YEARS', offset: 0 }, 'startOf(year)'],
    ['me()', { type: 'CurrentUser' }, 'me()'],
    ['${variable.region}', { type: 'FilterVariableExpression', variableName: 'region' }, '${variable.region}'],
    ['"a, b"', 'a, b', '"a, b"'],
  ]
  for (const [text, parsed, printed] of cases) {
    assert.deepEqual(parseValue(text), parsed, text)
    assert.equal(printValue(parseValue(text)), printed, text)
  }
  assert.throws(() => parseValue('now(-7 fortnights)'), /Unknown time unit/)
})

test('groups: AND / OR with parentheses, printed back identically', () => {
  const text = 'a EQUALS 1 AND (b IN x,y OR c IS_BLANK) AND createDate GREATER_THAN now(-7d)'
  const filter = parseFilter(text)
  assert.equal(filter.booleanOperator, 'AND')
  assert.equal(filter.criteria.length, 2)
  assert.equal(filter.subFilters?.length, 1)
  assert.equal(filter.subFilters?.[0]?.booleanOperator, 'OR')
  assert.equal(printFilter(filter), 'a EQUALS 1 AND createDate GREATER_THAN now(-7d) AND (b IN x,y OR c IS_BLANK)')
  assert.deepEqual(parseFilter('(a EQUALS 1)'), { criteria: [{ fieldName: 'a', operator: 'EQUALS', values: ['1'] }], booleanOperator: 'AND' })
  assert.throws(() => parseFilter('a EQUALS 1 AND b EQUALS 2 OR c EQUALS 3'), /Mixed AND and OR/)
  assert.throws(() => parseFilter('(a EQUALS 1'), /Missing "\)"/)
  assert.throws(() => parseFilter('AND a EQUALS 1'), /without a left side/)
})

test('buildFilter assembles where, group, or, order, skip and limit', () => {
  const filter = buildFilter({ where: ['status = active', 'ownerId EQUALS me()'], group: ['x IS_BLANK OR y IS_BLANK'], order: ['-id', 'name'], skip: 50, limit: 25 })
  assert.equal(filter.criteria.length, 2)
  assert.equal(filter.booleanOperator, 'AND')
  assert.deepEqual(filter.orderBys, [{ fieldName: 'id', isAscending: false }, { fieldName: 'name', isAscending: true }])
  assert.equal(filter.skip, 50)
  assert.equal(filter.limit, 25)
  assert.equal(printFilter(filter), 'status EQUALS active AND ownerId EQUALS me() AND (x IS_BLANK OR y IS_BLANK)')
  assert.equal(buildFilter({ where: ['a = 1', 'b = 2'], or: true }).booleanOperator, 'OR')
})
