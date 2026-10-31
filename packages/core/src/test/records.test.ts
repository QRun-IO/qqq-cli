/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { combineWithQuickSearch, quickSearchFields, quickSearchFilter } from '../query/quick-search.js'
import { findRecordByKey, gotoFilter, gotoKeys, isGotoKey } from '../records/goto.js'
import { copyRecordValues } from '../records/copy.js'
import { appHome, listReports } from '../metadata/navigation.js'
import { helpContentText, helpToText, processHelp, tableHelp } from '../help/help-content.js'

const person = {
  name: 'person', label: 'Person', primaryKeyField: 'id',
  fields: {
    id: { name: 'id', type: 'INTEGER', isEditable: false },
    firstName: { name: 'firstName', type: 'STRING', helpContents: [{ content: '<b>Given</b> name', format: 'HTML', roles: ['EDIT_SCREEN'] }] },
    email: { name: 'email', type: 'STRING' },
    notes: { name: 'notes', type: 'TEXT', isHidden: true },
    salary: { name: 'salary', type: 'DECIMAL' },
    photo: { name: 'photo', type: 'BLOB' },
    createDate: { name: 'createDate', type: 'DATE_TIME', isEditable: false },
  },
  sections: [{ name: 's', label: 'Identity', helpContents: [{ contentAsText: 'Who they are', content: '**Who**', format: 'MARKDOWN' }] }],
  helpContents: { help: [{ title: 'People', content: 'Everyone we know.' }] },
  supplementalMetaData: { materialDashboard: { gotoFieldNames: [['email'], ['firstName', 'nope']] } },
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('quick search ORs CONTAINS over visible string fields and ANDs it onto the filter', () => {
  assert.deepEqual(quickSearchFields(person), ['firstName', 'email'])
  assert.deepEqual(quickSearchFields(person, ['id', 'email']), ['email'])
  assert.equal(quickSearchFilter('  ', ['email']), undefined)
  const quick = quickSearchFilter(' ann ', ['firstName', 'email'])!
  assert.deepEqual(quick, { booleanOperator: 'OR', criteria: [{ fieldName: 'firstName', operator: 'CONTAINS', values: ['ann'] }, { fieldName: 'email', operator: 'CONTAINS', values: ['ann'] }] })
  // an empty filter becomes the quick group, keeping the sort
  assert.deepEqual(combineWithQuickSearch({ criteria: [], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: false }] }, quick), { ...quick, orderBys: [{ fieldName: 'id', isAscending: false }] })
  const combined = combineWithQuickSearch({ criteria: [{ fieldName: 'salary', operator: 'GREATER_THAN', values: ['5'] }], booleanOperator: 'OR', limit: 10 }, quick)
  assert.equal(combined.booleanOperator, 'AND')
  assert.equal(combined.limit, 10)
  assert.deepEqual(combined.subFilters, [{ criteria: [{ fieldName: 'salary', operator: 'GREATER_THAN', values: ['5'] }], booleanOperator: 'OR' }, quick])
})

test('go to: keys from gotoFieldNames with the primary key first; the lookup reports none, one or many', async () => {
  assert.deepEqual(gotoKeys(person), [['id'], ['email'], ['firstName']])
  assert.ok(isGotoKey(person, ['email']))
  assert.ok(!isGotoKey(person, ['salary']))
  assert.deepEqual(gotoFilter({ email: ' a@b ', firstName: '' }), { criteria: [{ fieldName: 'email', operator: 'EQUALS', values: ['a@b'] }], booleanOperator: 'AND', skip: 0, limit: 2 })
  const bodies: unknown[] = []
  let answer: unknown[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    assert.match(String(input), /\/qqq\/v1\/table\/person\/query$/)
    return json({ records: answer })
  }
  answer = []
  assert.deepEqual(await findRecordByKey('http://h', fetchImpl, person, { email: 'x' }), { found: 'none' })
  answer = [{ values: { id: 1 } }, { values: { id: 2 } }]
  assert.deepEqual(await findRecordByKey('http://h', fetchImpl, person, { email: 'x' }), { found: 'many' })
  answer = [{ values: { id: 9 } }]
  const one = await findRecordByKey('http://h', fetchImpl, person, { email: 'x' }, { tableVariant: { type: 'store', id: '3' } })
  assert.equal(one.found === 'one' && one.primaryKey, '9')
  assert.deepEqual((bodies[2] as { tableVariant: unknown }).tableVariant, { type: 'store', id: '3' })
})

test('copy keeps editable values and drops the primary key, non-editable, file and empty fields', () => {
  assert.deepEqual(copyRecordValues(person, { values: { id: 4, firstName: 'Ann', email: null, salary: 10, photo: 'x', createDate: 'now', extra: 1 } }), { firstName: 'Ann', salary: 10 })
})

test('app home groups sections, drops hidden and forbidden items, adds child apps; reports list their app', () => {
  const metaData = {
    apps: {
      a: { name: 'a', label: 'A', sections: [{ name: 's', label: 'S', tables: ['t1', 't2'], processes: ['p1'], reports: ['r1'] }], children: [{ type: 'APP', name: 'b', label: 'B' }, { type: 'REPORT', name: 'r1' }], widgets: ['w1', 'w2'] },
      b: { name: 'b', label: 'B', children: [{ type: 'TABLE', name: 't1', label: 'T1' }, { type: 'PROCESS', name: 'p1', label: 'P1' }] },
    },
    tables: { t1: { name: 't1', label: 'T1' }, t2: { name: 't2', label: 'T2', isHidden: true } },
    processes: { p1: { name: 'p1', label: 'P1' } },
    reports: { r1: { name: 'r1', label: 'R1', tableName: 't1' }, r2: { name: 'r2', label: 'R2', hasPermission: false } },
    widgets: { w1: { name: 'w1', label: 'W1' }, w2: { name: 'w2', hasPermission: false } },
  }
  assert.deepEqual(appHome(metaData, 'a'), {
    name: 'a', label: 'A', widgets: ['w1'],
    sections: [
      { name: 's', label: 'S', items: [{ type: 'PROCESS', name: 'p1', label: 'P1' }, { type: 'REPORT', name: 'r1', label: 'R1' }, { type: 'TABLE', name: 't1', label: 'T1' }] },
      { name: 'apps', label: 'Apps', items: [{ type: 'APP', name: 'b', label: 'B' }] },
    ],
  })
  assert.deepEqual(appHome(metaData, 'b')!.sections.map((s) => s.label), ['Actions', 'Data'])
  assert.equal(appHome(metaData, 'zz'), undefined)
  assert.deepEqual(listReports(metaData), [{ name: 'r1', label: 'R1', table: 't1', app: 'a' }])
})

test('help content: text siblings first, HTML stripped, slots and roles kept, steps included', () => {
  assert.equal(helpContentText({ content: '<p>a</p><p>b</p>', format: 'HTML' }), 'a\nb')
  assert.equal(helpContentText({ content: '**x**', contentAsText: 'x', format: 'MARKDOWN' }), 'x')
  const all = tableHelp(person)
  assert.deepEqual(all.map((e) => [e.where, e.text]), [['table', 'Everyone we know.'], ['section Identity', 'Who they are'], ['field firstName', 'Given name']])
  assert.deepEqual(tableHelp(person, { role: 'READ_SCREENS' }).map((e) => e.where), ['table', 'section Identity'])
  assert.deepEqual(tableHelp(person, { field: 'firstName' })[0]!.roles, ['EDIT_SCREEN'])
  assert.throws(() => tableHelp(person, { field: 'zz' }), /No field "zz"/)
  assert.match(helpToText(all), /^table: People\n {2}Everyone we know\./)
  const proc = processHelp({ helpContents: [{ content: 'Run it' }], frontendSteps: [{ name: 's1', label: 'Pick', components: [{ type: 'HELP_TEXT', values: { text: 'Choose one' } }], formFields: [{ name: 'f', helpContents: { help: [{ content: 'the f' }] } }] }] })
  assert.deepEqual(proc.map((e) => `${e.where}: ${e.text}`), ['process: Run it', 'step Pick: Choose one', 'step Pick field f: the f'])
})
