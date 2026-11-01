/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RealtimeMessage } from '@qrun-io/qqq-ui-api-client'
import type { CallInput, CallResult } from '../api/call.js'
import { Collaboration, presenceChannel, type CollaborationTransport, type PresenceState } from '../extensions/collaboration.js'
import { ExtensionNotInstalledError, ExtensionRegistry } from '../extensions/registry.js'

const withCollab = ExtensionRegistry.fromVersion({ extensions: [{ name: 'collaboration', version: '1.1.0' }] })
const without = ExtensionRegistry.fromVersion({ extensions: [{ name: 'esb', version: '1.1.0' }] })
const result = (data: unknown): CallResult => ({ status: 200, headers: new Headers(), data, contentType: 'application/json' })
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for a condition instead of a fixed delay: Windows timers fire in ~15 ms steps, so a few
 * `tick(2)` pauses take several times longer there than on macOS or Linux.
 */
async function until(what: string, condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await tick(2)
  }
}

/** A fake server: records calls, answers from a handler. */
function fake(handler: (id: string, input: CallInput) => unknown, stream?: (signal: AbortSignal) => AsyncIterable<RealtimeMessage>) {
  const calls: { id: string; input: CallInput }[] = []
  const transport: CollaborationTransport = {
    call: async (id, input) => {
      calls.push({ id, input })
      return result(handler(id, input))
    },
    openStream: stream,
  }
  return { calls, transport }
}

test('without the extension, presence is a no-op and other calls throw the typed error before any request', async () => {
  const { calls, transport } = fake(() => ({}))
  const collab = new Collaboration(without, transport)
  assert.equal(collab.available, false)
  const handle = await collab.joinPresence({ table: 'person', pk: '1' })
  assert.deepEqual([handle.count, handle.people, handle.state.available], [0, [], false])
  await handle.stop()
  assert.equal((await collab.presenceSnapshot({ table: 'person' })).count, 0)
  await assert.rejects(collab.favorites(), (e: unknown) => e instanceof ExtensionNotInstalledError && /installed: esb 1\.1\.0/.test(e.message))
  assert.equal(calls.length, 0)
})

test('favorites, recents, comments, follow, people and my work call the qbit operations', async () => {
  const { calls, transport } = fake((id) => {
    if (id === 'getQbitCollaborationFavorites') return { items: [{ id: 1, targetType: 'RECORD', targetName: 'person', recordId: '1', label: 'Avery' }], nextCursor: null }
    if (id === 'getQbitCollaborationRecordsByTableByPkComments') return { threads: [{ id: 5, body: 'hi' }], nextCursor: 'c2' }
    if (id === 'postQbitCollaborationRecordsByTableByPkComments') return { id: 6, body: 'new' }
    if (id.includes('Follow')) return { following: id !== 'deleteQbitCollaborationRecordsByTableByPkFollow' }
    if (id === 'getQbitCollaborationPeople') return { items: [{ userId: 'bob', displayName: 'Bob Chen' }] }
    if (id === 'getQbitCollaborationMyWork') return { openTaskCount: 2, unreadMentionCount: 1 }
    return { items: [], success: true }
  })
  const collab = new Collaboration(withCollab, transport)
  assert.equal((await collab.favorites())[0]?.label, 'Avery')
  await collab.addFavorite({ targetType: 'RECORD', targetName: 'person', recordId: '1' })
  await collab.removeFavorite({ targetType: 'TABLE', targetName: 'person' })
  await collab.recents(10)
  assert.deepEqual(await collab.comments('person', '1', { limit: 5 }), { threads: [{ id: 5, body: 'hi' }], nextCursor: 'c2' })
  assert.equal((await collab.addComment('person', '1', 'new', { parentCommentId: 5 })).id, 6)
  assert.equal((await collab.follow('person', '1', { notifyOnComment: true })).following, true)
  assert.equal((await collab.unfollow('person', '1')).following, false)
  assert.equal((await collab.people('bo'))[0]?.displayName, 'Bob Chen')
  assert.equal((await collab.myWork()).openTaskCount, 2)
  const byId = Object.fromEntries(calls.map((c) => [c.id, c.input]))
  assert.deepEqual(byId.putQbitCollaborationFavorites, { json: { targetType: 'RECORD', targetName: 'person', recordId: '1' } })
  assert.deepEqual(byId.getQbitCollaborationRecents, { query: { limit: '10' } })
  assert.deepEqual(byId.postQbitCollaborationRecordsByTableByPkComments, { path: { table: 'person', pk: '1' }, json: { body: 'new', parentCommentId: 5 } })
  assert.deepEqual(byId.getQbitCollaborationPeople, { query: { q: 'bo', limit: undefined } })
})

test('joinPresence holds a lease, polls on each heartbeat without a stream, tracks since, and leaves on stop', async () => {
  let viewers = [{ userId: 'bob', displayName: 'Bob Chen', mode: 'VIEWING' }]
  const { calls, transport } = fake((id) => (id === 'deleteQbitCollaborationPresence' ? { success: true } : { table: 'person', pk: '1', viewers }))
  const states: PresenceState[] = []
  const handle = await new Collaboration(withCollab, transport).joinPresence({ table: 'person', pk: '1' }, { heartbeatMs: 20, connectionId: 'cli-test', onChange: (s) => states.push(s) })
  try {
    assert.equal(handle.count, 1)
    const bobSince = handle.people[0]!.since
    viewers = [...viewers, { userId: 'carol', displayName: 'Carol', mode: 'EDITING' }]
    await until('the heartbeat to pick up carol', () => handle.count === 2)
    assert.deepEqual(handle.people.map((p) => [p.name, p.mode]), [['Bob Chen', 'VIEWING'], ['Carol', 'EDITING']])
    assert.equal(handle.people[0]!.since, bobSince)
  } finally {
    await handle.stop()
  }
  const posts = calls.filter((c) => c.id === 'postQbitCollaborationPresence')
  assert.ok(posts.length >= 2)
  assert.deepEqual(posts[0]!.input.json, { connectionId: 'cli-test', table: 'person', pk: '1', mode: 'VIEWING', fieldName: undefined })
  assert.deepEqual(calls.at(-1), { id: 'deleteQbitCollaborationPresence', input: { json: { connectionId: 'cli-test', table: 'person', pk: '1' } } })
  const after = calls.length
  await tick(60)
  assert.equal(calls.length, after, 'no heartbeat after stop')
  assert.ok(states.length >= 2)
})

test('joinPresence subscribes the scope channel on hello and applies presence.changed for its scope only', async () => {
  const events: RealtimeMessage[] = [
    { event: 'hello', data: { connectionId: 'sse-1', heartbeatSeconds: 25 } },
    { event: 'presence.changed', data: { table: 'person', viewers: [{ userId: 'zed', displayName: 'Zed' }] } },
    { event: 'presence.changed', data: { table: 'person', pk: '1', viewers: [{ userId: 'bob', displayName: 'Bob Chen', mode: 'EDITING', fieldName: 'email' }] } },
  ]
  const emptied: RealtimeMessage = { event: 'presence.changed', data: { table: 'person', pk: '1' } }
  async function* stream(signal: AbortSignal): AsyncIterable<RealtimeMessage> {
    let next = 0
    while (!signal.aborted) {
      await tick(2)
      if (next < events.length) yield events[next++]!
    }
  }
  const { calls, transport } = fake((id, input) => {
    if (id === 'updateRealtimeSubscriptions') return { active: (input.json as { add: string[] }).add, refused: [] }
    if (id === 'deleteQbitCollaborationPresence') return { success: true }
    return { table: 'person', pk: '1', viewers: [] }
  }, stream)
  const handle = await new Collaboration(withCollab, transport).joinPresence({ table: 'person', pk: '1' }, { announce: false, heartbeatMs: 10000 })
  try {
    await until('the channel subscription and the scoped presence.changed', () => handle.state.live && handle.count === 1)
    assert.deepEqual(calls.find((c) => c.id === 'updateRealtimeSubscriptions')?.input.json, { connectionId: 'sse-1', add: ['record:person:1'] })
    assert.deepEqual(handle.people.map((p) => [p.userId, p.mode, p.fieldName]), [['bob', 'EDITING', 'email']])
    events.push(emptied)
    await until('the emptied scope', () => handle.count === 0)
  } finally {
    await handle.stop()
  }
  assert.equal(calls.some((c) => c.id === 'postQbitCollaborationPresence' || c.id === 'deleteQbitCollaborationPresence'), false, 'watch-only never takes a lease')
  assert.equal(presenceChannel({ table: 'person' }), 'table:person')
})

test('a refused heartbeat is reported as the state error', async () => {
  const transport: CollaborationTransport = { call: async (id) => { if (id === 'postQbitCollaborationPresence') throw new Error('Not found'); return result({ success: true }) } }
  const handle = await new Collaboration(withCollab, transport).joinPresence({ table: 'secret' }, { heartbeatMs: 10000 })
  try {
    assert.equal(handle.state.error, 'Not found')
  } finally {
    await handle.stop()
  }
})

test('tags: vocabulary search, create, record tags and apply call the qbit operations', async () => {
  const { calls, transport } = fake((id) => {
    if (id === 'getQbitCollaborationTags') return { items: [{ id: 1, label: 'VIP', approved: true }] }
    if (id === 'postQbitCollaborationTags') return { id: 9, label: 'New one', approved: true }
    return { items: [{ id: 1, label: 'VIP' }, { id: 9, label: 'New one' }] }
  })
  const collab = new Collaboration(withCollab, transport)
  assert.deepEqual((await collab.tags('person', 'vi')).map((t) => t.label), ['VIP'])
  assert.equal((await collab.createTag('person', 'New one', 'teal')).id, 9)
  assert.equal((await collab.recordTags('person', '3')).length, 2)
  await collab.applyTags('person', '3', { add: [9], remove: [] })
  assert.deepEqual(calls.map((c) => c.id), ['getQbitCollaborationTags', 'postQbitCollaborationTags', 'getQbitCollaborationRecordsByTableByPkTags', 'putQbitCollaborationRecordsByTableByPkTags'])
  assert.deepEqual(calls[0]!.input.query, { table: 'person', q: 'vi', limit: '50' })
  assert.deepEqual(calls[1]!.input.json, { table: 'person', label: 'New one', color: 'teal' })
  assert.deepEqual(calls[3]!.input, { path: { table: 'person', pk: '3' }, json: { add: [9] } })
})
