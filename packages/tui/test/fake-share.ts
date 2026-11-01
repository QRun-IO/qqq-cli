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
  fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, label: { name: 'label', label: 'Label', type: 'STRING' }, userId: { name: 'userId', label: 'Owner', type: 'STRING' } },
  sections: [{ name: 's', label: 'Report', tier: 'T1', fieldNames: ['id', 'label', 'userId'] }],
}
const RECORDS: Record<string, J> = { 1: { id: 1, label: 'Mine', userId: 'tester@fake.test' }, 2: { id: 2, label: 'Theirs', userId: 'other@fake.test' } }
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
