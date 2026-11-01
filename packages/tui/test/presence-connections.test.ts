/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { ExtensionRegistry, opaqueConnectionId } from '@qrun-io/qqq-core'
import { collaborationPresence, presenceText } from '../src/presence'

const registry = ExtensionRegistry.fromVersion({ extensions: [{ name: 'collaboration', version: '1.2.0' }] })

/** A client stub answering presence calls; records the GET queries. */
function client(answer: (query: Record<string, string | undefined>, own: string | undefined) => unknown) {
  const queries: Array<Record<string, string | undefined>> = []
  let own: string | undefined
  return {
    queries,
    call: async (id: string, input: { query?: Record<string, string | undefined>; json?: { connectionId?: string } }) => {
      if (input.json?.connectionId) own = input.json.connectionId
      if (id === 'getQbitCollaborationPresence') queries.push(input.query ?? {})
      const data = id === 'getQbitCollaborationPresence' ? answer(input.query ?? {}, own) : id === 'deleteQbitCollaborationPresence' ? { success: true } : { table: 'person', pk: '7', viewers: [] }
      return { status: 200, headers: new Headers(), data, contentType: 'application/json' }
    },
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 2))
}

test('the record presence asks per connection: "Admin ×2", this terminal marked among the terminals', async () => {
  const c = client((query, own) => ({
    table: 'person', pk: '7', viewers: [{ userId: 'admin', displayName: 'Admin', mode: 'VIEWING', connections: 2 }, { userId: 'pat', displayName: 'Pat', mode: 'VIEWING', connections: 2 }], leaseCount: 4,
    ...(query.perConnection === 'true' ? { leases: [
      { userId: 'admin', displayName: 'Admin', mode: 'VIEWING', connections: 1, connectionId: opaqueConnectionId('admin', own ?? ''), since: '2026-11-01T12:00:00Z' },
      { userId: 'admin', displayName: 'Admin', mode: 'EDITING', fieldName: 'name', connections: 1, connectionId: 'cffff', since: '2026-11-01T12:00:01Z' },
    ] } : {}),
  }))
  const source = collaborationPresence(registry, c as never, 'Admin')!
  source.enter!('record:person:7')
  await until(() => Boolean(source.get('record:person:7').everyone?.length))
  const p = source.get('record:person:7')
  expect(c.queries[0]!.perConnection).toBe('true')
  const admin = p.everyone!.find((x) => x.self)!
  expect(admin.connections).toBe(2)
  expect(admin.terminals!.map((t) => [t.mode, t.self ?? false])).toEqual([['VIEWING', true], ['EDITING', false]])
  expect(presenceText(p)).toBe('1 other viewing: Pat ×2')
  source.enter!(undefined)
})

test('a server without connections (collaboration 1.1.0) still shows everyone, once each', async () => {
  const c = client(() => ({ table: 'person', pk: '7', viewers: [{ userId: 'admin', displayName: 'Admin', mode: 'VIEWING' }, { userId: 'pat', displayName: 'Pat', mode: 'EDITING' }] }))
  const source = collaborationPresence(registry, c as never, 'Admin')!
  source.enter!('record:person:7')
  await until(() => Boolean(source.get('record:person:7').everyone?.length))
  const p = source.get('record:person:7')
  expect(p.everyone!.map((x) => [x.name, x.connections, x.terminals])).toEqual([['Admin', undefined, undefined], ['Pat', undefined, undefined]])
  expect(presenceText(p)).toBe('1 other viewing: Pat')
  source.enter!(undefined)
})
