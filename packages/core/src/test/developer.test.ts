/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeveloperError, findAssociatedScript, getRecordDeveloper, getScriptLogs, getScriptRevisionFiles, getTableApiDocument, listDeveloperPanels, listTableApis, panelToBlocks, pickRevision, scriptText, storeScript } from '../records/developer.js'
import { blocksToText } from '../widgets/render-model.js'

function fake(routes: Record<string, unknown>, seen: Array<{ method: string; url: string; body?: unknown }> = []): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    seen.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const developerResponse = {
  record: { values: { id: 1, greetingScriptId: 7 }, recordLabel: 'Darin' },
  associatedScripts: [{
    associatedScript: { fieldName: 'greetingScriptId', scriptTypeId: 1 },
    script: { values: { id: 7, name: 'Greeting', currentScriptRevisionId: 12 } },
    scriptRevisions: [{ values: { id: 13, sequenceNo: 3, commitMessage: 'draft' } }, { values: { id: 12, sequenceNo: 2, commitMessage: 'Say hello' } }],
    testInputFields: [{ name: 'name' }],
  }, { associatedScript: { fieldName: 'otherScriptId' } }],
}

test('developer mode: scripts, revisions (current by default, by sequence number or id), files as text', async () => {
  const seen: Array<{ method: string; url: string; body?: unknown }> = []
  const fetchImpl = fake({ '/table/person/1/developer': developerResponse, '/table/scriptRevisionFile/query': { records: [{ values: { fileName: 'main.js', contents: 'return 1' } }] } }, seen)
  const developer = await getRecordDeveloper('http://h', fetchImpl, 'person', '1')
  assert.deepEqual(developer.scripts.map((s) => [s.fieldName, s.revisions.length, Boolean(s.script)]), [['greetingScriptId', 2, true], ['otherScriptId', 0, false]])
  const script = findAssociatedScript(developer, 'greetingScriptId')
  assert.throws(() => findAssociatedScript(developer, 'zz'), DeveloperError)
  assert.equal((pickRevision(script)!.values as { id: number }).id, 12)
  assert.equal((pickRevision(script, '3')!.values as { id: number }).id, 13)
  assert.equal((pickRevision(script, '12')!.values as { id: number }).id, 12)
  assert.throws(() => pickRevision(script, '99'), /No revision 99/)
  assert.equal(pickRevision(findAssociatedScript(developer, 'otherScriptId')), undefined)
  const files = await getScriptRevisionFiles('http://h', fetchImpl, '12')
  assert.deepEqual(files, [{ fileName: 'main.js', contents: 'return 1' }])
  assert.deepEqual((seen[1]!.body as { filter: { criteria: unknown[] } }).filter.criteria, [{ fieldName: 'scriptRevisionId', operator: 'EQUALS', values: ['12'] }])
  assert.equal(scriptText(undefined, files), 'return 1')
  assert.equal(scriptText(undefined, [{ fileName: 'a', contents: 'x' }, { fileName: 'b', contents: 'y' }]), '// file: a\nx\n\n// file: b\ny')
  assert.equal(scriptText({ values: { contents: 'old' } }, []), 'old')
})

test('store and logs go to the associated-script routes', async () => {
  const seen: Array<{ method: string; url: string; body?: unknown }> = []
  const fetchImpl = fake({
    '/developer/associatedScript/greetingScriptId/12/logs': { scriptLogRecords: [{ values: { id: 101, startTimestamp: 't', hadError: true, error: 'boom', scriptLogLine: [{ values: { timestamp: 't1', text: 'Hello' } }] } }] },
    '/developer/associatedScript/greetingScriptId': { scriptId: 7, scriptName: 'Greeting', scriptRevisionId: 14, scriptRevisionSequenceNo: 4 },
  }, seen)
  assert.deepEqual(await storeScript('http://h', fetchImpl, 'person', '1', 'greetingScriptId', 'return 2', 'v4'), { scriptId: 7, scriptName: 'Greeting', scriptRevisionId: 14, scriptRevisionSequenceNo: 4 })
  assert.equal(seen[0]!.method, 'POST')
  assert.deepEqual(seen[0]!.body, { contents: 'return 2', commitMessage: 'v4' })
  const logs = await getScriptLogs('http://h', fetchImpl, 'person', '1', 'greetingScriptId', '12')
  assert.deepEqual([logs[0]!.hadError, logs[0]!.error, logs[0]!.lines], [true, 'boom', [{ timestamp: 't1', text: 'Hello' }]])
})

test('panels render every block type; APIs and their documents list', async () => {
  const fetchImpl = fake({
    '/developer/panels': { panels: [{ id: 'p', title: 'Security', order: 1, statusLabel: '1 lock', blocks: [
      { type: 'TEXT', text: 'Careful', tone: 'WARNING' },
      { type: 'KEY_VALUES', label: 'Attrs', items: [{ label: 'type', value: 'x', href: '/app/x' }] },
      { type: 'TABLE', label: 'Locks', columns: ['Key', 'Field'], rows: [['store', 'storeId']] },
      { type: 'CODE', label: 'Sample', language: 'json', code: '{}' },
      { type: 'LINKS', links: [{ label: 'Overview', href: '/app/esb' }] },
      { type: 'ACTIONS', actions: [{ label: 'Replay', processName: 'replay', includeRecordId: true }] },
      { type: 'NEW_KIND' },
    ] }, { id: 'q', title: 'Broken', order: 2, error: 'provider failed' }] },
    '/table/person/apis/api/v1/openapi': { openapi: '3.0.3' },
    '/table/person/apis': { apis: [{ name: 'api', label: 'API', path: '/api/', currentVersion: 'v1', versions: [{ version: 'v1', tableSpecPath: '/api/v1/person/openapi.json' }] }] },
  })
  const panels = await listDeveloperPanels('http://h', fetchImpl, 'person', '1')
  const text = blocksToText(panelToBlocks(panels[0]!))
  assert.match(text, /^Security — 1 lock\n\[WARNING\] Careful\nAttrs\ntype {2}x \(\/app\/x\)\nLocks\n/)
  assert.match(text, /store +storeId/)
  assert.match(text, /Sample \(json\):\n\{\}/)
  assert.match(text, /Overview: \/app\/esb/)
  assert.match(text, /qqq process run replay -r <id>/)
  assert.match(text, /\(NEW_KIND widget/)
  assert.match(blocksToText(panelToBlocks(panels[1]!)), /\[ERROR\] provider failed/)
  const apis = await listTableApis('http://h', fetchImpl, 'person')
  assert.deepEqual(apis[0], { name: 'api', label: 'API', path: '/api/', currentVersion: 'v1', versions: [{ version: 'v1', tableSpecPath: '/api/v1/person/openapi.json' }] })
  assert.deepEqual(await getTableApiDocument('http://h', fetchImpl, 'person', 'api', 'v1'), { openapi: '3.0.3' })
})
