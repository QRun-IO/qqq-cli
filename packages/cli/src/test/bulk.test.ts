/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The bulk commands against a stub server: saved bulk load profiles (the sample app has none),
 * a load with a saved profile, upload templates, and the confirmation rules.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'

type J = Record<string, unknown>

const fields = { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, firstName: { name: 'firstName', label: 'First Name', type: 'STRING', isRequired: true }, lastName: { name: 'lastName', label: 'Last Name', type: 'STRING', isRequired: true } }
const structure = { isMain: true, isMany: false, tableName: 'person', label: 'Person', associationPath: null, associations: null, fields: [fields.firstName, fields.lastName] }
const upload = { headerValues: ['First', 'Last'], headerLetters: ['A', 'B'], bodyValuesPreview: [['Ann'], ['Lee']], fileBaseName: 'p.csv', tableStructure: structure, suggestedBulkLoadProfile: { version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [] } }
const steps = [
  { name: 'upload', label: 'Upload File', components: [{ type: 'HTML' }, { type: 'EDIT_FORM' }], formFields: [{ name: 'theFile', label: 'File', type: 'BLOB', isRequired: true }] },
  { name: 'fileMapping', label: 'File Mapping', components: [{ type: 'BULK_LOAD_FILE_MAPPING_FORM' }] },
  { name: 'review', label: 'Review', components: [{ type: 'BULK_LOAD_PROFILE_FORM' }, { type: 'VALIDATION_REVIEW_SCREEN' }] },
  { name: 'result', label: 'Result', components: [{ type: 'BULK_LOAD_PROFILE_FORM' }, { type: 'PROCESS_SUMMARY_RESULTS' }] },
]

interface Seen { path: string; values: J; body: string }

async function stub(): Promise<{ url: string; seen: Seen[]; profiles: J[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  let validated = false
  const profiles: J[] = [
    { id: 1, label: 'Mine', tableName: 'person', userId: 'me@example.com', isBulkEdit: false, mappingJson: JSON.stringify({ version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [{ fieldName: 'firstName', columnIndex: 0, headerName: 'First' }, { fieldName: 'lastName', columnIndex: 1, headerName: 'Last' }] }) },
    { id: 2, label: 'Theirs', tableName: 'person', userId: 'bob@example.com', isBulkEdit: false, mappingJson: JSON.stringify({ version: 'v1', layout: 'FLAT', hasHeaderRow: true, fieldList: [{ fieldName: 'lastName', defaultValue: 'X' }] }) },
  ]
  const send = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handle = (req: IncomingMessage, body: string, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/qqq\/v1/, '')
    const m = /name="values"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)
    const values = m ? JSON.parse(m[1]!) as J : {}
    seen.push({ path: `${req.method} ${path}`, values, body })
    if (path === '/version') return send(res, { apiVersion: '1.8.0', supportedMajorVersions: [1], features: [], extensions: [] })
    if (path === '/metaData') return send(res, { tables: { person: { name: 'person', label: 'Person' } }, processes: { 'person.bulkInsert': { name: 'person.bulkInsert', label: 'Person Bulk Insert', tableName: 'person', isHidden: true }, querySavedBulkLoadProfile: {}, storeSavedBulkLoadProfile: {}, deleteSavedBulkLoadProfile: {} }, apps: {} })
    if (path === '/metaData/table/person') return send(res, { name: 'person', label: 'Person', primaryKeyField: 'id', fields, clientCapabilities: { bulkInsert: { available: true, processName: 'person.bulkInsert' } } })
    if (path === '/metaData/process/person.bulkInsert') return send(res, { name: 'person.bulkInsert', label: 'Person Bulk Insert', tableName: 'person', frontendSteps: steps })
    if (path === '/processes/querySavedBulkLoadProfile/init') return send(res, { type: 'COMPLETE', processUUID: 'q', values: { savedBulkLoadProfileList: profiles.map((v) => ({ values: v })) } })
    if (path === '/processes/storeSavedBulkLoadProfile/init') {
      const record = { ...values, id: values.id ?? 3, userId: 'me@example.com' }
      const i = profiles.findIndex((p) => p.id === record.id)
      if (i >= 0) profiles[i] = record
      else profiles.push(record)
      return send(res, { type: 'COMPLETE', processUUID: 's', values: { savedBulkLoadProfileList: [{ values: record }] } })
    }
    if (path === '/processes/deleteSavedBulkLoadProfile/init') {
      profiles.splice(profiles.findIndex((p) => p.id === values.id), 1)
      return send(res, { type: 'COMPLETE', processUUID: 'd', values: {} })
    }
    if (path === '/processes/person.bulkInsert/init') validated = false
    if (path === '/processes/person.bulkInsert/init') return send(res, { type: 'COMPLETE', processUUID: 'u', nextStep: 'upload', values: { tableName: 'person', tableStructure: structure, 'upload.html': '<p>Upload a file.</p><a href="data:text/csv;base64,Rmlyc3QsTGFzdAo=" download="Person - Flat.csv">Person - Flat.csv</a>' } })
    if (path === '/processes/person.bulkInsert/u/step/upload') return send(res, { type: 'COMPLETE', processUUID: 'u', nextStep: 'fileMapping', backStep: 'prepareFileUpload', values: upload })
    if (path === '/processes/person.bulkInsert/u/step/fileMapping') return send(res, { type: 'COMPLETE', processUUID: 'u', nextStep: 'review', values: { supportsFullValidation: true, previewMessage: 'This is a preview.' } })
    if (path === '/processes/person.bulkInsert/u/step/review') {
      if (values.doFullValidation === 'true' && !validated) {
        validated = true
        return send(res, { type: 'COMPLETE', processUUID: 'u', nextStep: 'review', values: { supportsFullValidation: true, validationSummary: [{ status: 'OK', count: 1, message: 'Person record will be inserted.' }] } })
      }
      return send(res, { type: 'COMPLETE', processUUID: 'u', nextStep: 'result', values: { processResults: [{ status: 'OK', count: 1, message: 'Person record was inserted.' }] } })
    }
    if (/\/cancel$/.test(path)) return send(res, {})
    if (/\/records$/.test(path)) return send(res, { records: [{ values: { firstName: 'Ann', lastName: 'Lee' } }], totalRecords: 1 })
    if (path === '/manageSession') return send(res, { uuid: 's1', values: { user: { email: 'me@example.com' } } })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: `no route ${req.method} ${path}` }))
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handle(req, Buffer.concat(chunks).toString('utf8'), res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, profiles, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

describe('bulk commands against a stub server', () => {
  let server: Awaited<ReturnType<typeof stub>>
  let box: ReturnType<typeof sandbox>
  let dir: string
  // a JWT whose claims name the user (the owner of profile 1)
  const token = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.y`
  const qqq = (args: string[]) => runCli(['--server', server.url, ...args], { QQQ_TOKEN: token, ...box.env })

  before(async () => {
    server = await stub()
    box = sandbox()
    dir = mkdtempSync(join(tmpdir(), 'qqq-bulk-'))
    writeFileSync(join(dir, 'p.csv'), 'First,Last\nAnn,Lee\n')
  })
  after(async () => {
    await server.close()
    box.dispose()
  })

  test('bulk-profile list shows yours first, then shared with you', async () => {
    const r = await qqq(['bulk-profile', 'list', 'person', '-O', 'csv'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^id,label,owner,layout,fields\n1,Mine,you,FLAT,"firstName, lastName"\n2,Theirs,shared by bob@example.com,FLAT,lastName\n/)
  })

  test('only the owner may rename or delete a profile', async () => {
    const r = await qqq(['bulk-profile', 'delete', 'person', 'Theirs', '--yes'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /shared with you by bob@example.com; only its owner may delete it/)
    const rename = await qqq(['bulk-profile', 'rename', 'person', 'Theirs', 'Nope'])
    assert.equal(rename.code, 2)
  })

  test('saving over your profile shows the changes and needs --yes without a terminal', async () => {
    writeFileSync(join(dir, 'm.yaml'), 'fields:\n  firstName: Last\n  lastName: Last\n')
    const refused = await qqq(['bulk-profile', 'save', 'person', '-n', 'Mine', '--mapping', join(dir, 'm.yaml'), '--file', join(dir, 'p.csv'), '--replace'])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /Changes to "Mine":\n {2}First Name: column First -> Last/)
    const dup = await qqq(['bulk-profile', 'save', 'person', '-n', 'mine', '--mapping', join(dir, 'm.yaml'), '--file', join(dir, 'p.csv')])
    assert.match(dup.stderr, /already have a profile "Mine"/)
    const ok = await qqq(['bulk-profile', 'save', 'person', '-n', 'Mine', '--mapping', join(dir, 'm.yaml'), '--file', join(dir, 'p.csv'), '--replace', '--yes', '-O', 'csv'])
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /1,Mine,updated/)
    const stored = JSON.parse(String(server.profiles.find((p) => p.id === 1)!.mappingJson)) as { fieldList: J[] }
    assert.deepEqual(stored.fieldList[0], { fieldName: 'firstName', columnIndex: 1, headerName: 'Last', doValueMapping: false, clearIfEmpty: false })
  })

  test('rename and delete your own profile', async () => {
    const r = await qqq(['bulk-profile', 'rename', 'person', '1', 'Renamed', '-O', 'csv'])
    assert.match(r.stdout, /1,Renamed,Mine/)
    const save = await qqq(['bulk-profile', 'save', 'person', '-n', 'Temp', '--mapping', join(dir, 'm.yaml'), '--file', join(dir, 'p.csv'), '-O', 'csv'])
    assert.match(save.stdout, /3,Temp,created/)
    const d = await qqq(['bulk-profile', 'delete', 'person', 'Temp', '--yes'])
    assert.equal(d.code, 0, d.stderr)
    assert.ok(!server.profiles.some((p) => p.label === 'Temp'))
  })

  test('bulk-insert with a saved profile sends its id and the flat profile values; --yes loads', async () => {
    const r = await qqq(['table', 'bulk-insert', 'person', '--file', join(dir, 'p.csv'), '--saved', 'Theirs', '--column', 'firstName=First', '--yes', '-O', 'table'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /\[OK\] 1 Person record was inserted\./)
    const mapping = server.seen.find((s) => s.path.endsWith('/step/fileMapping'))!
    assert.equal(mapping.values.savedBulkLoadProfileId, '2')
    assert.deepEqual(JSON.parse(String(mapping.values.fieldListJSON)), [{ fieldName: 'lastName', defaultValue: 'X' }, { fieldName: 'firstName', columnIndex: 0, headerName: 'First', doValueMapping: false, clearIfEmpty: false }])
    assert.ok(server.seen.some((s) => s.path.endsWith('/step/upload') && /filename="p.csv"/.test(s.body)))
    assert.match(r.stderr, /Validation:\n\[OK\] 1 Person record will be inserted\./)
  })

  test('without a terminal and without --yes the load is cancelled with exit 2', async () => {
    const r = await qqq(['table', 'bulk-insert', 'person', '--file', join(dir, 'p.csv'), '--column', 'firstName=A', '--column', 'lastName=B', '--quiet'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Confirmation needed: pass --yes/)
    assert.ok(server.seen.some((s) => s.path.endsWith('/u/cancel')))
  })

  test('an incomplete mapping is refused before the step, naming the field', async () => {
    const r = await qqq(['table', 'bulk-insert', 'person', '--file', join(dir, 'p.csv'), '--quiet', '--yes'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /First Name: choose a column or give a default value/)
  })

  test('--template saves the template the instructions link to', async () => {
    const out = join(dir, 't.csv')
    const r = await qqq(['table', 'bulk-insert', 'person', '--template', 'flat', '--out', out])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(out, 'utf8'), 'First,Last\n')
  })
})
