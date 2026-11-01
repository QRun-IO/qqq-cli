/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Optional server features for tests: the collaboration and quick-search extensions (off unless a
 * test turns them on with `fakeExtensions`), the collaboration routes of one record, and POST /search.
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** Extensions /version reports; tests push entries and clear them afterwards. */
export const fakeExtensions: J[] = []

export const COLLABORATION = { name: 'collaboration', version: '1.1.0', pathPrefix: '/qbit/collaboration', description: 'Record collaboration' }
export const QUICK_SEARCH = { name: 'quick-search', version: '1.1.0', pathPrefix: '/qbit/quick-search', description: 'Quick search' }

export interface CollabState {
  comments: J[]
  following: boolean
  attachments: J[]
  tasks: J[]
  uploads: J[]
  shares: J[]
}

export const collabState: CollabState = { comments: [], following: false, attachments: [], tasks: [], uploads: [], shares: [] }

export function resetCollab(): void {
  collabState.comments = [{ id: 1, body: 'first note', authorDisplayName: 'Pat', createdAt: '2026-11-01T10:00:00Z', replies: [{ id: 2, body: 'a reply', authorDisplayName: 'Lee', createdAt: '2026-11-01T11:00:00Z' }] }]
  collabState.following = false
  collabState.attachments = [{ id: 7, fileName: 'notes.txt', sizeBytes: 5, createdByDisplayName: 'Pat', createDate: '2026-11-01T10:00:00Z', canDelete: true }]
  collabState.tasks = [{ id: 3, title: 'Call back', status: 'OPEN' }]
  collabState.uploads = []
  collabState.shares = []
}
resetCollab()

export async function collabRoute(path: string, method: string, body: unknown): Promise<Response | undefined> {
  const on = (name: string) => fakeExtensions.some((e) => e.name === name)
  if (path === '/search' && method === 'POST' && on('quick-search')) {
    const term = String((body as J | undefined)?.searchTerm ?? '').toLowerCase()
    const hits = 'ada lovelace'.includes(term) ? [{ tableName: 'person', tableLabel: 'Person', recordId: '1', recordLabel: '1', highlights: [{ text: 'Ada Lovelace', fieldLabel: 'Name' }] }] : []
    return json({ results: hits, provider: { status: 'OK' } })
  }
  if (path === '/qbit/quick-search/status' && on('quick-search')) return json({ state: 'OK', indexes: [{ tableName: 'person', enabled: true, documentCount: 30 }, { tableName: 'order', enabled: true, documentCount: 2 }], lastSuccessfulSync: '2026-11-01T10:12:00Z' })
  if (!path.startsWith('/qbit/collaboration') || !on('collaboration')) return undefined
  const rest = path.slice('/qbit/collaboration'.length)
  const rec = /^\/records\/([^/]+)\/([^/]+)\/(\w+)(\/preview)?$/.exec(rest)
  if (rec) {
    const what = rec[3]
    if (what === 'tags') return json({ items: [] })
    if (what === 'comments' && method === 'GET') return json({ threads: collabState.comments, nextCursor: null })
    if (what === 'comments' && method === 'POST') {
      const b = body as J
      const c = { id: collabState.comments.length + 10, body: b.body, parentCommentId: b.parentCommentId, authorDisplayName: 'Tester', createdAt: '2026-11-01T12:00:00Z', replies: [] }
      collabState.comments.unshift(c)
      return json(c)
    }
    if (what === 'follow' && method === 'GET') return json({ following: collabState.following })
    if (what === 'follow' && method === 'PUT') { collabState.following = true; return json({ following: true }) }
    if (what === 'follow' && method === 'DELETE') { collabState.following = false; return json({ following: false }) }
    if (what === 'attachments' && method === 'GET') return json({ items: collabState.attachments, nextCursor: null })
    if (what === 'attachments' && method === 'POST') {
      const b = body as J
      const file = b.file as File
      const entry = { name: file.name, size: file.size, description: b.description }
      collabState.uploads.push(entry)
      return json({ id: 99, fileName: file.name })
    }
    if (what === 'timeline') return json({ items: [{ kind: 'AUDIT', id: 1, at: '2026-11-01T10:00:00Z', actorName: 'Pat', summary: 'Edited by Pat: Email', details: [{ message: 'Changed Email from "a" to "b"' }] }] })
    if (what === 'tasks' && method === 'GET') return json({ items: collabState.tasks })
    if (what === 'tasks' && method === 'POST') { const t = { id: collabState.tasks.length + 10, title: (body as J).title, status: 'OPEN' }; collabState.tasks.push(t); return json(t) }
    if (what === 'shares' && rec[4]) return json({ recipients: ((body as J).toUserIds as string[]).map((id) => ({ userId: id, displayName: id === 'u1' ? 'Pat Smith' : id, canRead: id === 'u1' })) })
    if (what === 'shares') { collabState.shares.push(body as J); return json({ items: [] }) }
  }
  const dl = /^\/attachments\/(\d+)\/download$/.exec(rest)
  if (dl) return json({ url: `/qqq/v1/qbit/collaboration/files/${dl[1]}` })
  const file = /^\/files\/(\d+)$/.exec(rest)
  if (file) return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
  const task = /^\/tasks\/(\d+)$/.exec(rest)
  if (task && method === 'PATCH') {
    const t = collabState.tasks.find((x) => String(x.id) === task[1])
    if (t) t.status = (body as J).status
    return json(t ?? {})
  }
  if (rest === '/people') return json({ items: [{ userId: 'u1', displayName: 'Pat Smith', email: 'pat@fake.test' }, { userId: 'u2', displayName: 'Lee Jones' }] })
  if (rest === '/presence') return json({ table: 'person', pk: '1', viewers: [{ userId: 'u1', displayName: 'Pat Smith', mode: 'VIEWING' }, { userId: 't', displayName: 'Tester', mode: 'VIEWING' }] })
  return undefined
}
