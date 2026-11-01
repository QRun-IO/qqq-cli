/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Permission cases the sample (MOCK, everything allowed) cannot show: a disabled table, process
 * and app (listed, hasPermission false); a read-only table by capabilities with a password and a
 * hidden field; a table whose edit permission is revoked on the server mid-session.
 */

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const secTables = {
  secret: { name: 'secret', label: 'Secret', hasPermission: false },
  ro: { name: 'ro', label: 'Read Only', capabilities: ['TABLE_QUERY', 'TABLE_GET', 'TABLE_COUNT'] },
  locked: { name: 'locked', label: 'Locked', editPermission: true, insertPermission: true },
}
export const secProcesses = { denyProc: { name: 'denyProc', label: 'Deny Proc', hasPermission: false } }
export const secApps = { denyApp: { name: 'denyApp', label: 'Deny App', hasPermission: false, children: [] } }

const roMeta = { name: 'ro', label: 'Read Only', primaryKeyField: 'id', capabilities: ['TABLE_QUERY', 'TABLE_GET', 'TABLE_COUNT'], insertPermission: true, editPermission: true, deletePermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, name: { name: 'name', label: 'Name', type: 'STRING' }, pin: { name: 'pin', label: 'Pin', type: 'PASSWORD' }, internal: { name: 'internal', label: 'Internal', type: 'STRING', isHidden: true } } }
const lockedMeta = { name: 'locked', label: 'Locked', primaryKeyField: 'id', editPermission: true, insertPermission: true, fields: { id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false }, name: { name: 'name', label: 'Name', type: 'STRING' } } }

export async function secRoute(path: string, method: string): Promise<Response | undefined> {
  if (path === '/metaData/table/ro') return json(roMeta)
  if (path === '/table/ro/query') return json({ records: [{ values: { id: 1, name: 'One', pin: 'hunter2', internal: 'do-not-show' } }] })
  if (path === '/table/ro/count') return json({ count: 1 })
  if (path === '/table/ro/1' && method === 'GET') return json({ record: { values: { id: 1, name: 'One', pin: 'hunter2', internal: 'do-not-show' }, recordLabel: 'One' } })
  if (path === '/metaData/table/locked') return json(lockedMeta)
  if (path === '/table/locked/1' && method === 'GET') return json({ record: { values: { id: 1, name: 'Before' }, recordLabel: 'Before' } })
  if (path === '/table/locked/1' && method === 'PATCH') return json({ error: 'You do not have permission to edit Locked records.' }, 403)
  if (path === '/metaData/table/secret' || path.startsWith('/table/secret')) return json({ error: 'Permission denied' }, 403)
  return undefined
}
