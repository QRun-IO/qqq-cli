/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A shareable saved-report table (the sample has none): records owned by the test user and by
 * someone else, the share processes and an audience possible value source.
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const savedReportMeta = {
  name: 'savedReport', label: 'Saved Report', primaryKeyField: 'id', capabilities: ['TABLE_QUERY', 'TABLE_GET'], editPermission: true,
  shareableTableMetaData: { audiencePossibleValueSourceName: 'shareAudience', thisTableOwnerIdFieldName: 'userId' },
  fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, label: { name: 'label', label: 'Label', type: 'STRING' }, userId: { name: 'userId', label: 'Owner', type: 'STRING' }, tableName: { name: 'tableName', label: 'Table', type: 'STRING' }, cron: { name: 'cron', label: 'Schedule', type: 'STRING' }, tz: { name: 'tz', label: 'Zone', type: 'STRING' } },
  sections: [
    { name: 's', label: 'Report', tier: 'T1', fieldNames: ['id', 'label', 'userId', 'tableName'] },
    { name: 'fc', label: 'Filter and columns', tier: 'T2', widgetName: 'reportSetup' },
    { name: 'pv', label: 'Pivot', tier: 'T2', widgetName: 'pivotSetup' },
    { name: 'cr', label: 'Schedule', tier: 'T2', widgetName: 'cronW' },
    { name: 'dy', label: 'Inputs', tier: 'T2', widgetName: 'dynW' },
    { name: 'db', label: 'Data', tier: 'T2', widgetName: 'bagW' },
    { name: 'ap', label: 'API setup', tier: 'T2', widgetName: 'apiSetup' },
  ],
}
const RECORDS: Record<string, J> = {
  1: { id: 1, label: 'Mine', userId: 'tester@fake.test', tableName: 'person', queryFilterJson: JSON.stringify({ criteria: [{ fieldName: 'lastName', operator: 'EQUALS', values: ['Odd'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: false }] }), columnsJson: JSON.stringify({ columns: [{ name: 'id', isVisible: true }, { name: 'firstName', isVisible: true }, { name: 'lastName', isVisible: false }] }), pivotTableJson: JSON.stringify({ rows: [{ fieldName: 'firstName' }], columns: [], values: [{ fieldName: 'id', function: 'COUNT' }] }), cron: '0 0 9 * * ?', tz: 'America/Chicago', inputValues: JSON.stringify({ region: 'North' }) },
  2: { id: 2, label: 'Theirs', userId: 'other@fake.test', tableName: 'person' },
}
export const savedReportWidgets = {
  reportSetup: { name: 'reportSetup', label: 'Filter and columns', type: 'filterAndColumnsSetup' },
  pivotSetup: { name: 'pivotSetup', label: 'Pivot', type: 'pivotTableSetup' },
  cronW: { name: 'cronW', label: 'Schedule', type: 'cronUI', defaultValues: { cronExpressionFieldName: 'cron', timeZoneFieldName: 'tz' } },
  dynW: { name: 'dynW', label: 'Inputs', type: 'dynamicForm' },
  bagW: { name: 'bagW', label: 'Data', type: 'dataBagViewer' },
  apiSetup: { name: 'apiSetup', label: 'API setup', type: 'filterAndColumnsSetup' },
}
export const updates: J[] = []
let shares: J[] = []
let next = 1

export function shareLog(): J[] {
  return shares
}

function values(body: unknown): J {
  const b = (body ?? {}) as J
  return typeof b.values === 'string' ? JSON.parse(b.values) as J : {}
}

export async function shareRoute(path: string, method: string, body: unknown): Promise<Response | undefined> {
  if (path === '/metaData/table/savedReport') return json(savedReportMeta)
  if (path === '/metaData/table/savedView') return json({ ...savedReportMeta, name: 'savedView', label: 'Saved View' })
  if (path === '/table/savedReport/query') return json({ records: Object.values(RECORDS).map((v) => ({ values: v, recordLabel: v.label })) })
  if (path === '/table/savedReport/count') return json({ count: 2 })
  const get = /^\/table\/savedReport\/(\d+)$/.exec(path)
  if (get && method === 'GET') return json({ record: { values: RECORDS[get[1]!], recordLabel: RECORDS[get[1]!]!.label } })
  if (get && method === 'PATCH') {
    updates.push(body as J)
    Object.assign(RECORDS[get[1]!]!, body as J)
    return json({ record: { values: RECORDS[get[1]!] } })
  }
  if (path === '/widget/reportSetup') return json({ type: 'filterAndColumnsSetup', label: 'Filter and columns' })
  if (path === '/widget/pivotSetup') return json({ type: 'pivotTableSetup', label: 'Pivot' })
  if (path === '/widget/cronW') return json({ type: 'cronUI', label: 'Schedule', cronDescription: 'At 09:00 every day' })
  if (path === '/widget/dynW') {
    const current = JSON.parse(String(RECORDS[1]!.inputValues ?? '{}')) as J
    return json({ type: 'dynamicForm', label: 'Inputs', fieldList: [{ name: 'region', label: 'Region', type: 'STRING', isRequired: true }, { name: 'limit', label: 'Limit', type: 'INTEGER' }], recordOfFieldValues: { values: current }, mergedDynamicFormValuesIntoFieldName: 'inputValues' })
  }
  if (path === '/widget/apiSetup') return json({ type: 'filterAndColumnsSetup', label: 'API setup', isApiVersioned: true, apiName: 'person', apiPath: 'person-api', apiVersion: '2023.Q1' })
  if (path === '/person-api/2023.Q1/metaData/table/person') return json({ table: { name: 'person', label: 'Person (API)', primaryKeyField: 'id', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, fullName: { name: 'fullName', label: 'Full Name', type: 'STRING' } } } })
  if (path === '/person-api/2023.Q1/table/person/query') return json({ records: [{ values: { id: 1, fullName: 'Avery Sample' } }] })
  if (path === '/person-api/2023.Q1/table/person/count') return json({ count: 1 })
  if (path === '/widget/bagW') return json({ type: 'dataBagViewer', label: 'Data', queryParams: { id: '4' } })
  if (path === '/table/dataBag/4') return json({ record: { values: { id: 4, name: 'Rates' } } })
  if (path === '/table/dataBagVersion/query') return json({ records: [{ values: { id: 42, sequenceNo: 2, commitMessage: 'raise', createDate: '2026-10-30T12:00:00Z', author: 'pat', data: '{"rate":2}' } }, { values: { id: 41, sequenceNo: 1, commitMessage: 'first', createDate: '2026-10-29T12:00:00Z', data: '{"rate":1}' } }] })
  if (path === '/possibleValues/shareAudience') return json({ options: [{ id: 'user:7', label: 'Pat Smith' }, { id: 'group:2', label: 'Sales' }] })
  if (path === '/processes/getSharedRecords/init') return json({ type: 'COMPLETE', processUUID: 'g', values: { resultList: shares.map((s) => ({ values: s })) } })
  if (path === '/processes/insertSharedRecord/init') {
    const v = values(body)
    shares.push({ shareId: next++, scopeId: v.scopeId, audienceType: v.audienceType, audienceId: v.audienceId, audienceLabel: v.audienceId === '7' ? 'Pat Smith' : 'Sales' })
    return json({ type: 'COMPLETE', processUUID: 'i', values: {} })
  }
  if (path === '/processes/editSharedRecord/init') {
    const v = values(body)
    shares = shares.map((s) => (s.shareId === v.shareId ? { ...s, scopeId: v.scopeId } : s))
    return json({ type: 'COMPLETE', processUUID: 'e', values: {} })
  }
  if (path === '/processes/deleteSharedRecord/init') {
    const v = values(body)
    shares = shares.filter((s) => s.shareId !== v.shareId)
    return json({ type: 'COMPLETE', processUUID: 'd', values: {} })
  }
  return undefined
}
