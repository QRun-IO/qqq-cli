/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The collaboration extension (qbit-collaboration, `/qqq/v1/qbit/collaboration`) for both heads:
 * live presence on a table or record, comments, favorites, recents, follow, people and my work.
 *
 * Presence follows the qbit's contract: a lease is renewed with POST /presence every 20 seconds
 * (it expires after 45), DELETE /presence leaves, GET /presence is the snapshot, and
 * `presence.changed` events carry the same snapshot on the `record:{table}:{pk}` and
 * `table:{table}` realtime channels. Connection ids need not be stream connections, so a client
 * without the stream still takes part by polling on each heartbeat.
 *
 * When the server does not have the extension, presence is a no-op (`available: false`, nobody
 * there) and the other calls throw ExtensionNotInstalledError.
 */

import type { RealtimeMessage } from '@qrun-io/qqq-ui-api-client'
import type { CallInput, CallResult } from '../api/call.js'
import type { ExtensionRegistry } from './registry.js'

export const COLLABORATION = 'collaboration'

/** How the module reaches the server: the kernel's callOperation, and optionally the realtime stream. */
export interface CollaborationTransport {
  call(id: string, input: CallInput): Promise<CallResult>
  /** Opens GET /realtime/stream; without it presence is polled on each heartbeat. */
  openStream?(signal: AbortSignal): AsyncIterable<RealtimeMessage>
}

/** A navigation target (favorites and recents). */
export interface CollaborationTarget {
  targetType: 'TABLE' | 'APP' | 'RECORD' | 'PROCESS' | 'REPORT' | 'SAVED_VIEW'
  targetName: string
  recordId?: string
}

export interface FavoriteEntry {
  id?: number
  targetType?: string
  targetName?: string
  recordId?: string | null
  label?: string
  folder?: string | null
  sortOrder?: number | null
  available?: boolean
  href?: string | null
}

export interface CommentEntry {
  id?: number
  authorUserId?: string
  authorDisplayName?: string
  body?: string | null
  createdAt?: string
  editedAt?: string | null
  resolvedAt?: string | null
  deleted?: boolean
  fieldName?: string | null
  replies?: CommentEntry[]
  [key: string]: unknown
}

export interface CommentPage {
  threads: CommentEntry[]
  nextCursor?: string | null
}

export interface FollowState {
  following: boolean
  follow?: { notifyOnChange?: boolean; notifyOnComment?: boolean; reason?: string; mutedUntil?: string | null } | null
}

export interface PersonEntry {
  userId?: string
  displayName?: string
  email?: string | null
  lastSeenAt?: string | null
}

export interface MyWork {
  openTaskCount?: number
  unreadMentionCount?: number
  assignedRecordsByTable?: Record<string, number>
  tasks?: Record<string, unknown>[]
}

/** What presence is attached to: a table, or one record of it. */
export interface PresenceScope {
  table: string
  pk?: string
}

/** One person on the scope, merged across their tabs. */
export interface PresencePerson {
  userId: string
  name: string
  mode: 'VIEWING' | 'EDITING' | string
  fieldName?: string | null
  /** When this client first saw them there (the qbit does not send join times). */
  since: Date
}

export interface PresenceState {
  /** False when the server has no collaboration extension: nobody is ever shown. */
  available: boolean
  scope: PresenceScope
  count: number
  people: PresencePerson[]
  /** True while the realtime stream is connected and subscribed (else presence is polled). */
  live: boolean
  /** The last error (presence not enabled on the table, record not visible, ...), cleared on success. */
  error?: string
}

export interface PresenceOptions {
  /** Called after every change of the state. */
  onChange?: (state: PresenceState) => void
  /** VIEWING (default) or EDITING. */
  mode?: 'VIEWING' | 'EDITING'
  fieldName?: string
  /** Heartbeat period; default 20000 ms as the qbit asks. */
  heartbeatMs?: number
  /** Connection id for the lease; default a random `cli-...` id. */
  connectionId?: string
  /** False to only watch (snapshot plus events) without holding a lease. Default true. */
  announce?: boolean
  /** Delay before reconnecting a dropped stream; default 2000 ms, doubling to 30 s. */
  reconnectMs?: number
}

export interface PresenceHandle {
  readonly state: PresenceState
  readonly count: number
  readonly people: PresencePerson[]
  /** Re-reads the snapshot now. */
  refresh(): Promise<void>
  /** Changes mode or focused field and renews the lease at once. */
  setMode(mode: 'VIEWING' | 'EDITING', fieldName?: string): Promise<void>
  /** Leaves (DELETE /presence), stops the heartbeat and closes the stream. */
  stop(): Promise<void>
}

interface Viewer {
  userId?: string
  displayName?: string
  mode?: string
  fieldName?: string | null
}

interface Snapshot {
  table?: string
  pk?: string | null
  viewers?: Viewer[]
}

/** The channel presence events for a scope arrive on. */
export function presenceChannel(scope: PresenceScope): string {
  return scope.pk !== undefined ? `record:${scope.table}:${scope.pk}` : `table:${scope.table}`
}

function randomId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return `cli-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The collaboration calls for one server; gated by its extension registry. */
export class Collaboration {
  constructor(private readonly registry: ExtensionRegistry, private readonly transport: CollaborationTransport) {}

  /** Whether the server has the extension (presence works, the other calls do not throw). */
  get available(): boolean {
    return this.registry.has(COLLABORATION)
  }

  private async data<T>(id: string, input: CallInput = {}): Promise<T> {
    this.registry.require(COLLABORATION)
    return (await this.transport.call(id, input)).data as T
  }

  /** The signed-in user's favorites, in their order. */
  async favorites(): Promise<FavoriteEntry[]> {
    return (await this.data<{ items?: FavoriteEntry[] }>('getQbitCollaborationFavorites')).items ?? []
  }

  /** Stars a target (idempotent). */
  async addFavorite(target: CollaborationTarget): Promise<void> {
    await this.data('putQbitCollaborationFavorites', { json: target })
  }

  /** Unstars a target (idempotent). */
  async removeFavorite(target: CollaborationTarget): Promise<void> {
    await this.data('deleteQbitCollaborationFavorites', { json: target })
  }

  /** Recently viewed targets, newest first (at most 50). */
  async recents(limit?: number): Promise<FavoriteEntry[]> {
    return (await this.data<{ items?: FavoriteEntry[] }>('getQbitCollaborationRecents', { query: { limit: limit === undefined ? undefined : String(limit) } })).items ?? []
  }

  /** Records a view of a target (the server ignores repeats within a minute). */
  async recordView(target: CollaborationTarget): Promise<void> {
    await this.data('postQbitCollaborationRecents', { json: target })
  }

  /** A page of a record's comment threads, by latest activity, with replies. */
  async comments(table: string, pk: string, page: { cursor?: string; limit?: number } = {}): Promise<CommentPage> {
    const result = await this.data<{ threads?: CommentEntry[]; nextCursor?: string | null }>('getQbitCollaborationRecordsByTableByPkComments', {
      path: { table, pk },
      query: { cursor: page.cursor, limit: page.limit === undefined ? undefined : String(page.limit) },
    })
    return { threads: result.threads ?? [], nextCursor: result.nextCursor ?? null }
  }

  /** Posts a comment, or a reply with `parentCommentId`. Mentions are `@[Name](user:id)`. */
  async addComment(table: string, pk: string, body: string, options: { parentCommentId?: number; fieldName?: string } = {}): Promise<CommentEntry> {
    return this.data<CommentEntry>('postQbitCollaborationRecordsByTableByPkComments', { path: { table, pk }, json: { body, ...options } })
  }

  /** The signed-in user's follow state on a record. */
  async followState(table: string, pk: string): Promise<FollowState> {
    return this.data<FollowState>('getQbitCollaborationRecordsByTableByPkFollow', { path: { table, pk } })
  }

  /** Follows a record; omitted preferences keep their current values. */
  async follow(table: string, pk: string, preferences: { notifyOnChange?: boolean; notifyOnComment?: boolean } = {}): Promise<FollowState> {
    return this.data<FollowState>('putQbitCollaborationRecordsByTableByPkFollow', { path: { table, pk }, json: preferences })
  }

  /** Stops following a record. */
  async unfollow(table: string, pk: string): Promise<FollowState> {
    return this.data<FollowState>('deleteQbitCollaborationRecordsByTableByPkFollow', { path: { table, pk } })
  }

  /** Open tasks, assigned records per table and unread mentions of the signed-in user. */
  async myWork(): Promise<MyWork> {
    return this.data<MyWork>('getQbitCollaborationMyWork')
  }

  /** Searches the active people directory by name or email. */
  async people(q?: string, limit?: number): Promise<PersonEntry[]> {
    return (await this.data<{ items?: PersonEntry[] }>('getQbitCollaborationPeople', { query: { q, limit: limit === undefined ? undefined : String(limit) } })).items ?? []
  }

  /** Who is on a table or record right now, without joining. Empty when the extension is absent. */
  async presenceSnapshot(scope: PresenceScope): Promise<PresenceState> {
    const state: PresenceState = { available: this.available, scope, count: 0, people: [], live: false }
    if (!state.available) return state
    const snapshot = (await this.transport.call('getQbitCollaborationPresence', { query: { table: scope.table, pk: scope.pk } })).data as Snapshot
    const now = new Date()
    state.people = (snapshot.viewers ?? []).map((v) => ({ userId: String(v.userId ?? ''), name: String(v.displayName ?? v.userId ?? ''), mode: v.mode ?? 'VIEWING', fieldName: v.fieldName ?? null, since: now }))
    state.count = state.people.length
    return state
  }

  /**
   * Joins presence on a table or record: holds a lease (unless `announce: false`), subscribes to
   * the scope's realtime channel when a stream is available, and keeps `state` current. Returns
   * at once with a no-op handle when the extension is absent.
   */
  async joinPresence(scope: PresenceScope, options: PresenceOptions = {}): Promise<PresenceHandle> {
    const state: PresenceState = { available: this.available, scope, count: 0, people: [], live: false }
    const notify = () => options.onChange?.({ ...state, people: [...state.people] })
    if (!state.available) {
      return { state, get count() { return 0 }, get people() { return [] }, refresh: async () => {}, setMode: async () => {}, stop: async () => {} }
    }

    const announce = options.announce !== false
    const connectionId = options.connectionId ?? randomId()
    const firstSeen = new Map<string, Date>()
    let mode = options.mode ?? 'VIEWING'
    let fieldName = options.fieldName
    let stopped = false
    const abort = new AbortController()

    const apply = (snapshot: Snapshot) => {
      const now = new Date()
      const viewers = (snapshot.viewers ?? []).filter((v) => v.userId !== undefined)
      const ids = new Set(viewers.map((v) => String(v.userId)))
      for (const id of [...firstSeen.keys()]) if (!ids.has(id)) firstSeen.delete(id)
      state.people = viewers.map((v) => {
        const userId = String(v.userId)
        if (!firstSeen.has(userId)) firstSeen.set(userId, now)
        return { userId, name: String(v.displayName ?? userId), mode: v.mode ?? 'VIEWING', fieldName: v.fieldName ?? null, since: firstSeen.get(userId)! }
      })
      state.count = state.people.length
      state.error = undefined
      notify()
    }

    const refresh = async () => {
      try {
        apply((await this.transport.call('getQbitCollaborationPresence', { query: { table: scope.table, pk: scope.pk } })).data as Snapshot)
      } catch (error) {
        state.error = messageOf(error)
        notify()
      }
    }

    const heartbeat = async () => {
      if (stopped) return
      if (announce) {
        try {
          const result = await this.transport.call('postQbitCollaborationPresence', { json: { connectionId, table: scope.table, pk: scope.pk, mode, fieldName } })
          const data = result.data as Snapshot | undefined
          // The qbit answers the heartbeat with the snapshot; older builds answer {success}.
          if (data && Array.isArray(data.viewers)) {
            apply(data)
            return
          }
        } catch (error) {
          state.error = messageOf(error)
          notify()
          return
        }
      }
      await refresh()
    }

    const subscribe = async () => {
      if (!this.transport.openStream) return
      let delay = options.reconnectMs ?? 2000
      while (!stopped) {
        try {
          for await (const message of this.transport.openStream(abort.signal)) {
            if (stopped) break
            if (message.event === 'hello') {
              const hello = (message.data ?? {}) as { connectionId?: string }
              const result = await this.transport.call('updateRealtimeSubscriptions', { json: { connectionId: hello.connectionId, add: [presenceChannel(scope)] } })
              const active = ((result.data ?? {}) as { active?: string[] }).active ?? []
              state.live = active.includes(presenceChannel(scope))
              delay = options.reconnectMs ?? 2000
              await refresh()
            } else if (message.event === 'presence.changed') {
              const raw = message.data as Snapshot & { data?: Snapshot }
              const snapshot = raw && Array.isArray(raw.viewers) ? raw : raw?.data
              if (snapshot && snapshot.table === scope.table && (scope.pk === undefined ? snapshot.pk == null : String(snapshot.pk) === scope.pk)) apply(snapshot)
            } else if (message.event === 'resync') {
              await refresh()
            }
          }
        } catch (error) {
          if (stopped) break
          state.error = messageOf(error)
        }
        if (stopped) break
        state.live = false
        notify()
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30000)
      }
    }

    await heartbeat()
    const timer = setInterval(() => void heartbeat(), options.heartbeatMs ?? 20000)
    void subscribe()

    return {
      state,
      get count() { return state.count },
      get people() { return state.people },
      refresh,
      setMode: async (next, field) => {
        mode = next
        fieldName = field
        await heartbeat()
      },
      stop: async () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        abort.abort()
        state.live = false
        if (announce) {
          try {
            await this.transport.call('deleteQbitCollaborationPresence', { json: { connectionId, table: scope.table, pk: scope.pk } })
          } catch {
            // the lease expires on its own after 45 seconds
          }
        }
      },
    }
  }
}
