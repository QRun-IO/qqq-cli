/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * An acceptance-style table for features the sample server lacks: CHIP, WIDGET and LINK
 * adornments, help by role, a form adjuster, audits, column statistics, developer scripts,
 * table APIs, a record section widget, a composite association; and a process with a back step,
 * a DOWNLOAD_FORM, a named widget and a RECORD_LIST.
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const accMeta = {
  name: 'acc', label: 'Acc', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, capabilities: ['TABLE_QUERY', 'QUERY_STATS'],
  helpContents: { overview: [{ contentAsText: 'Acc table help for viewers.', roles: ['VIEW_SCREEN'] }] },
  fields: {
    id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false },
    name: { name: 'name', label: 'Name', type: 'STRING', helpContents: [{ contentAsText: 'Name help when editing.', roles: ['EDIT_SCREEN'] }], supplementalMetaData: { materialDashboard: { formAdjusterIdentifier: 'acc.name' } } },
    status: { name: 'status', label: 'Status', type: 'STRING', adornments: [{ type: 'CHIP', values: { 'color.Active': 'success' } }] },
    payload: { name: 'payload', label: 'Payload', type: 'STRING', adornments: [{ type: 'WIDGET', values: { widgetName: 'payloadWidget' } }] },
    when: { name: 'when', label: 'When', type: 'DATE_TIME' },
    personId: { name: 'personId', label: 'Person', type: 'INTEGER', possibleValueSourceName: 'person' },
  },
  sections: [
    { name: 's', label: 'Main', tier: 'T1', fieldNames: ['id', 'name', 'status', 'when', 'personId'], helpContents: [{ contentAsText: 'Main section help.', roles: ['VIEW_SCREEN'] }] },
    { name: 'w', label: 'Widget field', tier: 'T2', fieldNames: ['payload'] },
    { name: 'sw', label: 'Context widget', tier: 'T2', widgetName: 'ctxWidget' },
  ],
  associations: [{ name: 'parts', associatedTableName: 'part', join: { name: 'accPart', type: 'ONE_TO_MANY', joinOns: [{ leftField: 'id', rightField: 'accId' }, { leftField: 'name', rightField: 'accName' }] } }],
  clientCapabilities: { audits: { available: true, processName: 'GetAuditsForRecord' } },
}

const partMeta = { name: 'part', label: 'Part', primaryKeyField: 'id', insertPermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, accId: { name: 'accId', label: 'Acc', type: 'INTEGER' }, accName: { name: 'accName', label: 'Acc name', type: 'STRING' }, title: { name: 'title', label: 'Title', type: 'STRING' } }, sections: [{ name: 's', label: 'Part', tier: 'T1', fieldNames: ['id', 'accId', 'accName', 'title'] }] }

export const ACC_RECORD = { values: { id: 1, name: 'Alpha', status: 'Active', payload: { type: 'statistics', count: 42, countContext: 'in the payload' }, when: '2026-10-31T22:00:00Z', personId: 3 }, displayValues: { personId: 'Casey Sample' }, recordLabel: 'Alpha', associatedRecords: { parts: [] } }

/** Handles acc routes; undefined when the request is not one of them. */
const ADHOC_STEP = { name: 'scan', label: 'Scan', components: [{ type: 'WIDGET', values: { isAdHocWidget: true, blocks: [
  { blockTypeName: 'TEXT', values: { text: 'Order ${orderNo}' } },
  { blockTypeName: 'TEXT', conditional: 'showHint', values: { text: 'Hint: scan the label' } },
  { blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'barcode', label: 'Barcode', type: 'STRING', isRequired: true }, submitOnEnter: true } },
  { blockTypeName: 'BUTTON', values: { label: 'Skip', actionCode: 'skip' } },
  { blockTypeName: 'BUTTON', values: { label: 'Finish', actionCode: 'finish' } },
] } }] }
const ADHOC_META = { name: 'adhoc', label: 'Ad hoc', frontendSteps: [ADHOC_STEP, { name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'message', label: 'Message', type: 'STRING' }] }] }

const ADHOC_FILE_META = { name: 'adhocfile', label: 'Ad hoc file', frontendSteps: [
  { name: 'up', label: 'Upload', components: [{ type: 'WIDGET', values: { isAdHocWidget: true, blocks: [{ blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'photo', label: 'Photo', type: 'BLOB', isRequired: true } } }, { blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'qty', label: 'Quantity', type: 'INTEGER', isRequired: true } } }] } }] },
  { name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'message', label: 'Message', type: 'STRING' }] },
] }

const SETUP_META = { name: 'setupProc', label: 'Report setup', frontendSteps: [
  { name: 'f', label: 'Filter', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'tableName', label: 'Table', type: 'STRING', defaultValue: 'person' }, { name: 'filterJson', label: 'Filter', type: 'STRING', adornments: [{ type: 'WIDGET', values: { widgetName: 'reportSetup' } }] }] },
  { name: 'done', label: 'Done', components: [{ type: 'VIEW_FORM' }], viewFields: [{ name: 'message', label: 'Message', type: 'STRING' }] },
] }

export async function accRoute(path: string, method: string, body: unknown, url: URL): Promise<Response | undefined> {
  if (path === '/metaData/process/setupProc') return json(SETUP_META)
  if (path === '/processes/setupProc/init') return json({ type: 'COMPLETE', processUUID: 'sp', nextStep: 'f', values: { tableName: 'person' } })
  if (path === '/processes/setupProc/sp/step/f') return json({ type: 'COMPLETE', processUUID: 'sp', nextStep: 'done', values: { message: `filter ${String((JSON.parse(String((body as J).values ?? '{}')) as J).filterJson)}` } })
  if (path === '/metaData/process/adhocfile') return json(ADHOC_FILE_META)
  if (path === '/processes/adhocfile/init') return json({ type: 'COMPLETE', processUUID: 'af', nextStep: 'up', values: {} })
  if (path === '/processes/adhocfile/af/step/up') {
    const b = body as J
    const file = b.photo as File | undefined
    const v = JSON.parse(String(b.values ?? '{}')) as J
    return json({ type: 'COMPLETE', processUUID: 'af', nextStep: 'done', values: { message: `got ${file ? `${file.name} ${(await file.text()).length} bytes` : 'no file'} qty ${String(v.qty)}` } })
  }
  if (path === '/metaData/process/adhoc') return json(ADHOC_META)
  if (path === '/processes/adhoc/init') return json({ type: 'COMPLETE', processUUID: 'ah', nextStep: 'scan', values: { orderNo: 'SO-9', showHint: false } })
  if (path === '/processes/adhoc/ah/step/scan') {
    const v = JSON.parse(String((body as J).values ?? '{}')) as J
    return json({ type: 'COMPLETE', processUUID: 'ah', nextStep: 'done', values: { message: `${String(v.actionCode)} ${String(v.barcode)}` } })
  }
  const b = (body ?? {}) as J
  if (path === '/metaData/table/acc') return json(accMeta)
  if (path === '/metaData/table/part') return json(partMeta)
  if (path === '/table/acc/count') return json({ count: 1 })
  if (path === '/table/acc/query') return json({ records: [ACC_RECORD] })
  if (path === '/table/acc/1' && method === 'GET') return json({ record: ACC_RECORD })
  if (path === '/table/acc/formAdjuster/acc.name/onChange') return json({ updatedFieldValues: { status: `changed by adjuster for ${String(b.newValue)}` } })
  if (path === '/widget/ctxWidget') return json({ type: 'statistics', label: 'Context', count: 1, countContext: `record ${String(b.id)} of ${String(b.tableName ?? 'acc')}` })
  if (path === '/processes/GetAuditsForRecord/init') {
    return json({ type: 'COMPLETE', processUUID: 'a', values: { audits: [
      { values: { id: 2, timestamp: '2026-10-31T23:00:00Z', auditUserId: 'bob', message: 'Record was Edited', 'auditDetail.id': 9, 'auditDetail.fieldName': 'name', 'auditDetail.oldValue': 'Alfa', 'auditDetail.newValue': 'Alpha' } },
      { values: { id: 1, timestamp: '2026-10-30T10:00:00Z', auditUserId: 'alice', message: 'Record was Inserted' } },
    ], distinctCount: 2 } })
  }
  if (path === '/processes/columnStats/init') return json({ type: 'COMPLETE', processUUID: 'cs', values: { statsFields: [{ name: 'count', label: 'Count' }, { name: 'countDistinct', label: 'Distinct' }], statsRecord: { values: { count: 1, countDistinct: 1 } }, valueCounts: [{ values: { name: 'Alpha', count: 1 } }] } })
  if (path === '/table/acc/1/developer') return json({ record: ACC_RECORD, associatedScripts: [{ associatedScript: { fieldName: 'codeRef' }, script: { values: { id: 5, name: 'acc-script' } }, scriptRevisions: [{ values: { id: 51, sequenceNo: 2, commitMessage: 'second', author: 'bob' } }], testInputFields: [], testOutputFields: [] }] })
  if (path === '/table/acc/1/developer/panels') return json({ panels: [{ id: 'p', title: 'Panel One', order: 1, blocks: [{ type: 'TEXT', text: 'panel text' }] }] })
  if (path === '/table/acc/1/developer/associatedScript/codeRef/51/logs') return json({ scriptLogRecords: [{ values: { id: 1, startTimestamp: 's', endTimestamp: 'e', hadError: false, scriptLogLine: [{ values: { timestamp: 't1', text: 'log line one' } }] } }] })
  if (path === '/table/scriptRevisionFile/query') return json({ records: [{ values: { fileName: 'main.js', contents: 'return 42' } }] })
  if (path === '/table/acc/apis') return json({ apis: [{ name: 'pub', label: 'Public API', path: '/api/pub', currentVersion: 'v1', versions: [{ version: 'v1' }] }] })
  if (path === '/table/acc/apis/pub/v1/openapi') return json({ openapi: '3.0.0', info: { title: 'Public API' } })
  if (path === '/metaData/process/wizard') {
    return json({ name: 'wizard', label: 'Wizard', frontendSteps: [
      { name: 'one', label: 'One', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'a', label: 'A', type: 'STRING' }] },
      { name: 'two', label: 'Two', components: [{ type: 'WIDGET', values: { widgetName: 'stepWidget' } }, { type: 'RECORD_LIST' }, { type: 'EDIT_FORM' }], formFields: [{ name: 'b', label: 'B', type: 'STRING' }], recordListFields: [{ name: 'id', label: 'Id', type: 'INTEGER' }, { name: 'name', label: 'Name', type: 'STRING' }] },
      { name: 'done', label: 'Done', components: [{ type: 'DOWNLOAD_FORM' }, { type: 'VIEW_FORM' }], viewFields: [{ name: 'result', label: 'Result', type: 'STRING' }] },
    ] })
  }
  if (path === '/processes/wizard/init') return json({ type: 'COMPLETE', processUUID: 'w1', nextStep: 'one', values: {} })
  if (path === '/processes/wizard/w1/step/one') {
    // going back (isStepBack) shows step one again; otherwise on to two
    if (url.searchParams.get('isStepBack') === 'true') return json({ type: 'COMPLETE', processUUID: 'w1', nextStep: 'one', values: { a: 'x' } })
    return json({ type: 'COMPLETE', processUUID: 'w1', nextStep: 'two', backStep: 'one', values: { a: 'x' } })
  }
  if (path === '/processes/wizard/w1/step/two') {
    if (url.searchParams.get('isStepBack') === 'true') return json({ type: 'COMPLETE', processUUID: 'w1', nextStep: 'one', values: { a: 'x' } })
    return json({ type: 'COMPLETE', processUUID: 'w1', nextStep: 'done', values: { result: 'all done', downloadFileName: 'report.csv', serverFilePath: '/tmp/report.csv' } })
  }
  if (path === '/processes/wizard/w1/records') {
    const skip = Number(url.searchParams.get('skip') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 50)
    return json({ records: Array.from({ length: Math.max(0, Math.min(limit, 120 - skip)) }, (_, i) => ({ values: { id: skip + i + 1, name: `row ${skip + i + 1}` } })), totalRecords: 120 })
  }
  if (path === '/widget/stepWidget') return json({ type: 'statistics', label: 'Step widget', count: 7, countContext: `process ${String(b.processUUID ?? '')}` })
  if (path === '/download/report.csv') return new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } })
  return undefined
}
