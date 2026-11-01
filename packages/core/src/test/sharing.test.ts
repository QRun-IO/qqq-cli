/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SharingError, addShare, audienceOptions, changeShare, isRecordOwner, listShares, removeShare, shareable, sharingProcess, splitAudienceOption } from '../records/sharing.js'

const sharing = { audiencePossibleValueSourceName: 'shareAudience', thisTableOwnerIdFieldName: 'userId' }
const meta = { name: 'savedReport', shareableTableMetaData: sharing }

function server() {
  const calls: Array<{ path: string; values: Record<string, unknown> }> = []
  const f: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)
    let values: Record<string, unknown> = {}
    if (/form/.test(request.headers.get('content-type') ?? '')) values = JSON.parse(String((await request.formData()).get('values') ?? '{}')) as Record<string, unknown>
    else if (request.method === 'POST') values = await request.json() as Record<string, unknown>
    calls.push({ path: url.pathname, values })
    const body = /getSharedRecords/.test(url.pathname) ? { type: 'COMPLETE', values: { resultList: [{ values: { shareId: 4, scopeId: 'READ_ONLY', audienceType: 'user', audienceId: '3', audienceLabel: 'Pat' } }] } }
      : /possibleValues/.test(url.pathname) ? { options: [{ id: 'user:3', label: 'Pat' }] }
        : /refuse/.test(url.pathname) ? { error: 'Only the owner may share' } : { type: 'COMPLETE', values: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { f, calls }
}

test('shareable: metadata present and (when capabilities are sent) sharing available', () => {
  assert.equal(shareable({ name: 't' }), undefined)
  assert.deepEqual(shareable(meta), sharing)
  assert.equal(shareable({ ...meta, clientCapabilities: { sharing: { available: false } } }), undefined)
  assert.equal(sharingProcess({ ...meta, clientCapabilities: { sharing: { available: true, insertProcessName: 'x.share' } } }, 'insert'), 'x.share')
  assert.throws(() => sharingProcess({ ...meta, clientCapabilities: { sharing: { available: true } } }, 'delete'), SharingError)
  assert.equal(sharingProcess(meta, 'list'), 'getSharedRecords')
})

test('only the owner may share; audience ids split into type and id', () => {
  assert.equal(isRecordOwner(sharing, { values: { userId: 'me' } }, 'me'), true)
  assert.equal(isRecordOwner(sharing, { values: { userId: 'you' } }, 'me'), false)
  assert.equal(isRecordOwner({}, { values: {} }, undefined), true)
  assert.deepEqual(splitAudienceOption('group:7'), { audienceType: 'group', audienceId: '7' })
  assert.equal(splitAudienceOption('nope'), undefined)
})

test('list, add, change and remove shares through the share processes', async () => {
  const { f, calls } = server()
  const shares = await listShares('http://q.test', f, meta, 9)
  assert.deepEqual(shares, [{ shareId: 4, scopeId: 'READ_ONLY', audienceType: 'user', audienceId: '3', audienceLabel: 'Pat' }])
  await addShare('http://q.test', f, meta, 9, 'user:3', 'READ_ONLY')
  await changeShare('http://q.test', f, meta, 9, 4, 'READ_WRITE')
  await removeShare('http://q.test', f, meta, 9, 4)
  assert.deepEqual(calls.slice(1).map((c) => [c.path.split('/').slice(-2).join('/'), c.values]), [
    ['insertSharedRecord/init', { tableName: 'savedReport', recordId: 9, audienceType: 'user', audienceId: '3', scopeId: 'READ_ONLY' }],
    ['editSharedRecord/init', { tableName: 'savedReport', recordId: 9, shareId: 4, scopeId: 'READ_WRITE' }],
    ['deleteSharedRecord/init', { tableName: 'savedReport', recordId: 9, shareId: 4 }],
  ])
  assert.deepEqual(await audienceOptions('http://q.test', f, sharing), [{ id: 'user:3', label: 'Pat' }])
  await assert.rejects(addShare('http://q.test', f, { ...meta, clientCapabilities: { sharing: { available: true, insertProcessName: 'refuse' } } }, 9, 'user:3', 'READ_ONLY'), /Only the owner may share/)
})
