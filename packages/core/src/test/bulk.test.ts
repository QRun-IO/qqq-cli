/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bulkEditValues, checkMapping, cleanSuggestion, columnLetter, diffMappings, findColumn, mappingDocument, mappingFromProfile, parseMappingDocument, profileFromMapping, profileSubmitValues,
  readFileDescription, setHasHeaderRow, structureFields, uploadTemplates, type BulkLoadProfile, type BulkLoadTableStructure,
} from '../bulk/mapping.js'
import { BACK, type ProcessMeta } from '../process/runner.js'
import { BulkDeclinedError, bulkProcesses, findSavedBulkLoadProfile, isProfileOwner, listSavedBulkLoadProfiles, runBulkProcess, savedBulkLoadProfilesAvailable, splitProfilesByOwner, storeSavedBulkLoadProfile } from '../bulk/run.js'

const structure: BulkLoadTableStructure = {
  isMain: true, isMany: false, tableName: 'person', label: 'Person', associationPath: null, isBulkEdit: false,
  fields: [
    { name: 'firstName', label: 'First Name', type: 'STRING', isRequired: true },
    { name: 'lastName', label: 'Last Name', type: 'STRING', isRequired: true },
    { name: 'birthDate', label: 'Birth Date', type: 'DATE' },
    { name: 'isEmployed', label: 'Is Employed', type: 'BOOLEAN' },
  ],
  associations: [{ isMain: false, isMany: true, tableName: 'pet', label: 'Pet', associationPath: 'pets', associations: null, fields: [{ name: 'name', label: 'Name', type: 'STRING', isRequired: true }, { name: 'birthDate', label: 'Birth Date', type: 'DATE' }] }],
}
const fileValues = { headerValues: ['First Name', 'Last Name', 'Birth Date', 'Birth Date'], headerLetters: ['A', 'B', 'C', 'D'], bodyValuesPreview: [['Ann'], ['Lee'], ['1990-01-02'], ['x']], fileBaseName: 'p.csv' }
const file = readFileDescription(fileValues)

test('structure fields are qualified for child tables and labelled with the child table', () => {
  assert.deepEqual(structureFields(structure).map((f) => `${f.name}=${f.label}`), ['firstName=First Name', 'lastName=Last Name', 'birthDate=Birth Date', 'isEmployed=Is Employed', 'pets.name=Pet: Name', 'pets.birthDate=Pet: Birth Date'])
})

test('the file description marks repeated headers; columns are found by header or letter', () => {
  assert.deepEqual(file.duplicates, [false, false, false, true])
  assert.equal(findColumn(file, 'last name', true), 1)
  assert.equal(findColumn(file, 'D', true), 3)
  assert.equal(findColumn(file, 'Column C', false), 2)
  assert.equal(findColumn(file, 'Nope', true), undefined)
  assert.equal(columnLetter(27), 'AB')
})

test('the suggestion drops child fields that reuse a main column and becomes FLAT (finding 11)', () => {
  const suggested: BulkLoadProfile = { version: 'v1', layout: 'TALL', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [
    { fieldName: 'firstName', columnIndex: 0, headerName: 'First Name' }, { fieldName: 'birthDate', columnIndex: 2, headerName: 'Birth Date' }, { fieldName: 'pets.birthDate', columnIndex: 2, headerName: 'Birth Date' },
  ] }
  const mapping = cleanSuggestion(suggested, structure, file)
  assert.equal(mapping.layout, 'FLAT')
  assert.deepEqual(mapping.fields.map((f) => f.name), ['firstName', 'birthDate', 'lastName'])
  // lastName is required and was not suggested: it stays, unmapped, so the mapping is not ready
  assert.deepEqual(checkMapping(mapping, structure, file).errors, ['Last Name: choose a column or give a default value'])
})

test('profile submit values are flat strings with fieldListJSON (the server rejects objects)', () => {
  const mapping = parseMappingDocument({ fields: { firstName: 'First Name', lastName: { column: 'B' }, isEmployed: { default: true } } }, structure, file)
  const values = profileSubmitValues(mapping)
  assert.equal(values.version, 'v1')
  assert.equal(values.layout, 'FLAT')
  assert.equal(values.hasHeaderRow, 'true')
  assert.equal(values.isBulkEdit, 'false')
  assert.deepEqual(JSON.parse(values.fieldListJSON!), [
    { fieldName: 'firstName', columnIndex: 0, headerName: 'First Name', doValueMapping: false, clearIfEmpty: false },
    { fieldName: 'lastName', columnIndex: 1, headerName: 'Last Name', doValueMapping: false, clearIfEmpty: false },
    { fieldName: 'isEmployed', defaultValue: true },
  ])
  for (const v of Object.values(values)) assert.equal(typeof v, 'string')
})

test('a mapping document takes labels, child fields, value mappings and reports every problem', () => {
  const mapping = parseMappingDocument({ layout: 'tall', fields: { 'First Name': 'A', lastName: 'Last Name', 'pets.name': { column: 'Birth Date', values: { x: 'Rex' } } } }, structure, file)
  assert.equal(mapping.layout, 'TALL')
  assert.deepEqual(mapping.fields.find((f) => f.name === 'pets.name'), { name: 'pets.name', column: 2, header: 'Birth Date', doValueMapping: true, valueMappings: { x: 'Rex' } })
  assert.throws(() => parseMappingDocument({ layout: 'ROUND', fields: { bogus: 'A', firstName: 'Nowhere', lastName: {} } }, structure, file), (e: Error) => /ROUND/.test(e.message) && /bogus: no such field/.test(e.message) && /no column Nowhere/.test(e.message) && /lastName: give a column or a default/.test(e.message))
})

test('a document round-trips through mappingDocument, and a v1 profile is read as a document', () => {
  const mapping = parseMappingDocument({ fields: { firstName: 'First Name', lastName: 'Last Name', isEmployed: { default: 'yes' } } }, structure, file)
  assert.deepEqual(parseMappingDocument(mappingDocument(mapping, file), structure, file), mapping)
  const fromProfile = parseMappingDocument(profileFromMapping(mapping), structure, file)
  assert.deepEqual(fromProfile.fields, mapping.fields)
})

test('checks: unknown column, WIDE needs a repetition, bulk edit needs mapped keys, duplicate header warns', () => {
  const mapping = parseMappingDocument({ layout: 'WIDE', fields: { firstName: 'A', 'pets.name': 'B', birthDate: 'D' } }, structure, file)
  mapping.fields.push({ name: 'lastName', column: 9 })
  assert.throws(() => parseMappingDocument({ fields: { lastName: { column: 9 } } }, structure, file), /no column 9/)
  const { errors, warnings } = checkMapping(mapping, structure, file)
  assert.ok(errors.includes('Last Name: the file has no column J'))
  assert.ok(errors.some((e) => /WIDE layout needs a repetition/.test(e)))
  assert.ok(warnings.some((w) => /repeats an earlier header/.test(w)))
  const edit = { ...parseMappingDocument({ fields: { lastName: 'B' } }, { ...structure, isBulkEdit: true }, file), keyFields: 'firstName' }
  assert.deepEqual(checkMapping(edit, structure, file).errors, ['key field First Name is not mapped to a column'])
})

test('turning the header row off drops header names; on again clears duplicate-header columns', () => {
  const mapping = parseMappingDocument({ fields: { firstName: 'A', birthDate: 'D' } }, structure, file)
  setHasHeaderRow(mapping, false, file)
  assert.equal(mapping.fields[0]!.header, undefined)
  const warnings = setHasHeaderRow(mapping, true, file)
  assert.equal(mapping.fields[0]!.header, 'First Name')
  assert.equal(mapping.fields[1]!.column, undefined)
  assert.equal(warnings.length, 1)
})

test('diffs list what an update to a saved profile changes', () => {
  const a = mappingFromProfile({ version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [{ fieldName: 'firstName', columnIndex: 0, headerName: 'First Name' }, { fieldName: 'isEmployed', defaultValue: true }] }, structure)
  const b = parseMappingDocument({ fields: { firstName: 'B', lastName: 'B', isEmployed: { default: false } } }, structure, file)
  assert.deepEqual(diffMappings(a, b, structure, file), ['added: Last Name', 'First Name: column First Name -> Last Name', 'Is Employed: default true -> false'])
})

test('bulk edit values switch on fields and clear empty ones with ""', () => {
  assert.deepEqual(bulkEditValues({ a: 1, b: null, c: 3 }, ['a', 'b']), { a: 1, b: '', bulkEditEnabledFields: 'a,b' })
})

test('upload templates come from the data: links of the instructions', () => {
  const html = '<a href="data:text/csv;base64,YSxiCg==" download="Person - Flat.csv">Flat</a> | <a download="T &amp; U.csv" href="data:text/csv,x%2Cy">T</a>'
  const t = uploadTemplates(html)
  assert.deepEqual(t.map((x) => x.name), ['Person - Flat.csv', 'T & U.csv'])
  assert.equal(new TextDecoder().decode(t[0]!.bytes), 'a,b\n')
  assert.equal(new TextDecoder().decode(t[1]!.bytes), 'x,y')
})

test('bulk processes come from clientCapabilities, else the standard names the user may run', () => {
  assert.deepEqual(bulkProcesses({ name: 'person', clientCapabilities: { bulkInsert: { available: true, processName: 'p.bi' }, bulkDelete: { available: false } } }, {}), { insert: 'p.bi' })
  assert.deepEqual(bulkProcesses({ name: 'pet' }, { processes: { 'pet.bulkEdit': {}, 'pet.bulkDelete': { hasPermission: false } } }), { edit: 'pet.bulkEdit' })
})

// ---- the driver against a fake server ----

type Route = [RegExp, (values: Record<string, unknown>, query: URLSearchParams) => unknown]
function fake(routes: Route[]): { fetch: typeof fetch; calls: Array<{ path: string; values: Record<string, unknown>; files: string[]; query: string }> } {
  const calls: Array<{ path: string; values: Record<string, unknown>; files: string[]; query: string }> = []
  const f: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    let values: Record<string, unknown> = {}
    const files: string[] = []
    if (/multipart/.test(request.headers.get('content-type') ?? '')) {
      const form = await request.formData()
      values = JSON.parse(String(form.get('values') ?? '{}')) as Record<string, unknown>
      for (const [k, v] of form.entries()) if (typeof v !== 'string') files.push(`${k}:${(v as File).name}`)
    } else if (request.method === 'POST') {
      try { values = await request.json() as Record<string, unknown> } catch { values = {} }
    }
    calls.push({ path: `${request.method} ${url.pathname}`, values, files, query: url.search })
    const route = routes.find(([re]) => re.test(`${request.method} ${url.pathname}`))
    const body = route ? route[1](values, url.searchParams) : { code: 'NOT_FOUND', message: url.pathname }
    return new Response(JSON.stringify(body), { status: route ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: f, calls }
}

const insertMeta: ProcessMeta = { name: 'person.bulkInsert', label: 'Person Bulk Insert', tableName: 'person', frontendSteps: [
  { name: 'upload', label: 'Upload File', components: [{ type: 'HTML' }, { type: 'EDIT_FORM' }], formFields: [{ name: 'theFile', label: 'File', type: 'BLOB', isRequired: true }] },
  { name: 'fileMapping', label: 'File Mapping', components: [{ type: 'BULK_LOAD_FILE_MAPPING_FORM' }], formFields: [{ name: 'hasHeaderRow', label: 'Header', type: 'BOOLEAN' }, { name: 'layout', label: 'Layout', type: 'STRING' }] },
  { name: 'valueMapping', label: 'Value Mapping', components: [{ type: 'BULK_LOAD_VALUE_MAPPING_FORM' }] },
  { name: 'review', label: 'Review', components: [{ type: 'BULK_LOAD_PROFILE_FORM' }, { type: 'VALIDATION_REVIEW_SCREEN' }] },
  { name: 'result', label: 'Result', components: [{ type: 'BULK_LOAD_PROFILE_FORM' }, { type: 'PROCESS_SUMMARY_RESULTS' }] },
] }

function insertServer(): ReturnType<typeof fake> {
  const shape = { tableStructure: structure, ...fileValues, suggestedBulkLoadProfile: { version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [{ fieldName: 'firstName', columnIndex: 0, headerName: 'First Name' }, { fieldName: 'lastName', columnIndex: 1, headerName: 'Last Name' }] } }
  let validated = false
  let backs = 0
  return fake([
    [/POST .*\/person.bulkInsert\/init$/, () => ({ type: 'COMPLETE', processUUID: 'u', nextStep: 'upload', values: { tableName: 'person', 'upload.html': '<p>Upload</p>' } })],
    [/POST .*\/u\/step\/upload$/, () => ({ type: 'COMPLETE', processUUID: 'u', nextStep: 'fileMapping', backStep: 'prepareFileUpload', values: shape })],
    [/POST .*\/u\/step\/prepareFileUpload$/, () => { backs++; return { type: 'COMPLETE', processUUID: 'u', nextStep: 'upload', values: {} } }],
    [/POST .*\/u\/step\/prepareFileMapping$/, () => ({ type: 'COMPLETE', processUUID: 'u', nextStep: 'fileMapping', backStep: 'prepareFileUpload', values: shape })],
    [/POST .*\/u\/step\/fileMapping$/, (v) => ({ type: 'COMPLETE', processUUID: 'u', nextStep: 'valueMapping', backStep: 'prepareFileMapping', values: { ...shape, valueMappingFullFieldName: 'isEmployed', valueMappingField: structure.fields[3], valueMappingFieldTableName: 'person', fileValues: ['Y', 'N'], valueMapping: {}, valueMappingFieldIndex: 0, fieldNamesToDoValueMapping: ['isEmployed'], echo: v } })],
    [/POST .*\/u\/step\/valueMapping$/, () => ({ type: 'COMPLETE', processUUID: 'u', nextStep: 'review', backStep: 'prepareFileMapping', values: { supportsFullValidation: true } })],
    [/POST .*\/u\/step\/review$/, (v) => {
      if (v.doFullValidation === 'true' && !validated) {
        validated = true
        return { type: 'COMPLETE', processUUID: 'u', nextStep: 'review', backStep: 'prepareFileMapping', values: { supportsFullValidation: true, validationSummary: [{ status: 'OK', count: 1, message: 'will be inserted' }] } }
      }
      return { type: 'COMPLETE', processUUID: 'u', nextStep: 'result', values: { processResults: [{ status: 'OK', count: 1, message: `inserted after ${backs} back` }] } }
    }],
    [/POST .*\/u\/cancel$/, () => ({})],
    [/GET .*\/u\/records$/, () => ({ records: [], totalRecords: 0 })],
  ])
}

test('a bulk insert uploads, maps (flat values), maps values (typed), validates and loads', async () => {
  const server = insertServer()
  let mappedOnce = false
  const reviews: boolean[] = []
  const outcome = await runBulkProcess({
    baseUrl: 'http://q.test', fetch: server.fetch, meta: insertMeta, pollMillis: 1,
    file: { name: 'p.csv', bytes: new TextEncoder().encode('a') },
    values: { tableName: 'person' },
    chooseMapping: async (ctx) => {
      assert.deepEqual(ctx.suggestion.fields.map((f) => f.name), ['firstName', 'lastName'])
      if (!mappedOnce) {
        mappedOnce = true
        return BACK
      }
      return { ...ctx.suggestion, fields: [...ctx.suggestion.fields, { name: 'isEmployed', column: 2, header: 'Birth Date', doValueMapping: true }] }
    },
    mapValues: async (ctx) => {
      assert.deepEqual(ctx.fileValues, ['Y', 'N'])
      return { Y: 'yes', N: 'no' }
    },
    review: async (ctx) => {
      reviews.push(ctx.validated)
      return ctx.validated ? 'submit' : 'validate'
    },
  })
  assert.deepEqual(reviews, [false, true])
  const uploads = server.calls.filter((c) => /step\/upload$/.test(c.path))
  assert.equal(uploads.length, 2, 'the file is sent again after going back to the upload')
  for (const u of uploads) assert.deepEqual(u.files, ['theFile:p.csv'])
  const mapping = server.calls.find((c) => /step\/fileMapping$/.test(c.path))!
  assert.equal(typeof mapping.values.fieldListJSON, 'string')
  const valueStep = server.calls.find((c) => /step\/valueMapping$/.test(c.path))!
  assert.deepEqual(JSON.parse(String(valueStep.values.mappedValuesJSON)), { Y: true, N: false })
  assert.match(String(valueStep.values.fieldListJSON), /"valueMappings":\{"Y":true,"N":false\}/)
  assert.equal(outcome.mapping?.fields.length, 3)
  assert.equal((outcome.values.processResults as Array<{ message: string }>)[0]!.message, 'inserted after 1 back')
})

test('declining at the review cancels the run on the server', async () => {
  const server = insertServer()
  await assert.rejects(runBulkProcess({
    baseUrl: 'http://q.test', fetch: server.fetch, meta: insertMeta, pollMillis: 1, file: { name: 'p.csv', bytes: new Uint8Array() },
    chooseMapping: async (ctx) => ctx.suggestion,
    mapValues: async () => ({}),
    review: async () => 'cancel',
  }), BulkDeclinedError)
  assert.ok(server.calls.some((c) => /\/cancel$/.test(c.path)))
})

test('a mapping that cannot be submitted stops before the step is sent', async () => {
  const server = insertServer()
  await assert.rejects(runBulkProcess({
    baseUrl: 'http://q.test', fetch: server.fetch, meta: insertMeta, pollMillis: 1, file: { name: 'p.csv', bytes: new Uint8Array() },
    chooseMapping: async (ctx) => ({ ...ctx.suggestion, fields: [] }),
    review: async () => 'submit',
  }), /map at least 1 field/)
  assert.ok(!server.calls.some((c) => /step\/fileMapping$/.test(c.path)))
})

test('bulk edit sends the switched-on fields with bulkEditEnabledFields and the records', async () => {
  const server = fake([
    [/POST .*\/init$/, () => ({ type: 'COMPLETE', processUUID: 'e', nextStep: 'edit', values: {} })],
    [/POST .*\/e\/step\/edit$/, () => ({ type: 'COMPLETE', processUUID: 'e', nextStep: 'review', values: { supportsFullValidation: false } })],
    [/POST .*\/e\/step\/review$/, () => ({ type: 'COMPLETE', processUUID: 'e', nextStep: 'result', values: { processResults: [] } })],
    [/GET .*\/records$/, () => ({ records: [], totalRecords: 0 })],
  ])
  await runBulkProcess({
    baseUrl: 'http://q.test', fetch: server.fetch, pollMillis: 1, records: { ids: ['1', '2'] },
    meta: { name: 'person.bulkEdit', frontendSteps: [{ name: 'edit', components: [{ type: 'BULK_EDIT_FORM' }], formFields: [{ name: 'a', label: 'A', type: 'STRING' }, { name: 'b', label: 'B', type: 'STRING' }] }, { name: 'review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] }, { name: 'result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] }] },
    editForm: async () => ({ values: { a: 'x', b: null }, enabled: ['a', 'b'] }),
    review: async (ctx) => (ctx.supportsFullValidation ? 'validate' : 'submit'),
  })
  const init = server.calls[0]!
  assert.equal(init.values.recordIds, undefined)
  const edit = server.calls.find((c) => /step\/edit$/.test(c.path))!
  assert.deepEqual({ a: edit.values.a, b: edit.values.b, enabled: edit.values.bulkEditEnabledFields }, { a: 'x', b: '', enabled: 'a,b' })
  const review = server.calls.find((c) => /step\/review$/.test(c.path))!
  assert.equal(review.values.doFullValidation, 'false')
})

test('saved bulk load profiles: list, find, store; ownership', async () => {
  const records = [{ values: { id: 2, label: 'Zed', tableName: 'person', userId: 'bob', isBulkEdit: false, mappingJson: '{"version":"v1","fieldList":[],"layout":"FLAT","hasHeaderRow":true}' } }, { values: { id: 1, label: 'Mine', tableName: 'person', userId: 'me', isBulkEdit: false, mappingJson: '{"version":"v1","fieldList":[{"fieldName":"firstName","columnIndex":0}]}' } }]
  const server = fake([
    [/querySavedBulkLoadProfile\/init$/, () => ({ type: 'COMPLETE', processUUID: 'q', values: { savedBulkLoadProfileList: records } })],
    [/storeSavedBulkLoadProfile\/init$/, () => ({ type: 'COMPLETE', processUUID: 's', values: { savedBulkLoadProfileList: [{ values: { id: 3, label: 'New', tableName: 'person', userId: 'me', mappingJson: '{}' } }] } })],
  ])
  const list = await listSavedBulkLoadProfiles('http://q.test', server.fetch, 'person', false)
  assert.deepEqual(list.map((p) => p.label), ['Mine', 'Zed'])
  assert.equal(list[0]!.profile.fieldList[0]!.fieldName, 'firstName')
  assert.deepEqual(server.calls[0]!.values, { tableName: 'person', isBulkEdit: false })
  assert.equal(findSavedBulkLoadProfile(list, 'mine').id, 1)
  assert.throws(() => findSavedBulkLoadProfile(list, 'x'), /saved: Mine, Zed/)
  const { yours, shared } = splitProfilesByOwner(list, 'me')
  assert.deepEqual([yours.map((p) => p.id), shared.map((p) => p.id)], [[1], [2]])
  assert.equal(isProfileOwner(list[1]!, undefined), false)
  const stored = await storeSavedBulkLoadProfile('http://q.test', server.fetch, { table: 'person', label: 'New', isBulkEdit: false, profile: { version: 'v1', fieldList: [], hasHeaderRow: true, layout: 'FLAT', isBulkEdit: false, keyFields: null } })
  assert.equal(stored.id, 3)
  assert.equal(typeof server.calls[1]!.values.mappingJson, 'string')
  assert.equal(savedBulkLoadProfilesAvailable({ processes: { querySavedBulkLoadProfile: {}, storeSavedBulkLoadProfile: {}, deleteSavedBulkLoadProfile: {} } }), true)
  assert.equal(savedBulkLoadProfilesAvailable({ processes: {} }), false)
})

test('a profile error from the server is a SavedBulkLoadProfileError with its message', async () => {
  const server = fake([[/storeSavedBulkLoadProfile\/init$/, () => ({ type: 'ERROR', processUUID: 's', userFacingError: 'You already have a saved Bulk Load Profile on this table with this name.' })]])
  await assert.rejects(storeSavedBulkLoadProfile('http://q.test', server.fetch, { table: 'person', label: 'x', isBulkEdit: false, profile: { version: 'v1', fieldList: [], hasHeaderRow: true, layout: 'FLAT', isBulkEdit: false, keyFields: null } }), /already have a saved/)
})
