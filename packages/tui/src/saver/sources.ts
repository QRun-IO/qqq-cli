/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The screen saver's tile sources and the extension or feature each needs:
 *
 * | tile    | needs                | reads                                                    |
 * |---------|----------------------|----------------------------------------------------------|
 * | people  | session store, or collaboration | the session table (sessions active in the last 10 minutes), else GET presence per table, a few tables per refresh |
 * | jobs    | durableJobs feature  | GET /jobs?state=recent (scope all, else mine)            |
 * | health  | health               | GET /health/summary                                       |
 * | db      | db-performance       | GET overview + activity                                   |
 * | esb     | esb                  | GET /esb/overview                                         |
 * | alerts  | alerts               | GET /alerts/inbox/summary                                 |
 * | events  | realtime feature     | the TUI's open realtime stream (no request)               |
 * | server  | core                 | the version and the footer's ping (no request)            |
 * | table:x | core                 | POST count, for the profile's favourite tables            |
 *
 * A 403 or 404 hides the tile (see model.ts); nothing here asks for more than one page.
 */

import type { TuiClient } from '../client'
import { SourceAbsent, type EventRate, type Level, type TileSource, type TileValue } from './model'

export interface SaverContext {
  client: TuiClient
  /** Installed extension (registry.has). */
  has(extension: string): boolean
  features: string[]
  /** The footer's ping and API version, read live. */
  status(): { apiVersion: string; pingMs: number | null; stream: string; lastEvent: string; user: string; userId?: string }
  events: EventRate
  /** Tables to sample for presence, most likely first (favourites, recents, then the rest). */
  presenceTables(): string[]
  /** The server's session table (the session store qbit's), when it has one the user can read. */
  sessionTable?(): string | undefined
  /** The profile's favourite tables (count tiles). */
  favouriteTables: string[]
  tableLabel(name: string): string
  /** The refresh interval now (presence uses it to age out people not seen again). */
  intervalMs(): number
  now?: () => number
}

/** Tables asked for presence per refresh: the sweep goes round the list a few at a time. */
export const PRESENCE_TABLES_PER_REFRESH = 4

interface Viewer {
  userId: string
  displayName: string
  mode?: string
  /** Live connections (tabs, terminals) of this user on the table; absent before collaboration 1.2.0. */
  connections?: number
}

/** Sessions that count as online: active in the last 10 minutes. */
export const SESSION_ACTIVE_MILLIS = 10 * 60_000

function userLabel(userId: string): string {
  return userId.includes(':') ? userId.slice(userId.indexOf(':') + 1) : userId
}

/**
 * Who is online: signed-in sessions from the session store's table when the server has one and it
 * holds sessions active in the last 10 minutes (own sessions count: "2 sessions · 1 user (you ×2)"),
 * else this terminal plus everyone seen in collaboration presence across a few tables per refresh
 * (the saver keeps its lease, so the signed-in viewer is always one of them). Collaboration 1.2.0
 * counts connections, so two terminals of one user are "2 online · you ×2"; older servers count each
 * person once. Never "nobody around" while the viewer is signed in.
 */
export function presenceSource(ctx: SaverContext): TileSource {
  // keyed by user and table: a user's terminals on different tables add up
  const seen = new Map<string, { userId: string; name: string; table: string; mode?: string; connections?: number; self: boolean; at: number }>()
  const skip = new Set<string>()
  let cursor = 0
  let sessionsGone = false
  const now = ctx.now ?? Date.now
  const names = new Map<string, string>()

  async function sessions(): Promise<TileValue | undefined> {
    const table = ctx.sessionTable?.()
    if (!table || sessionsGone) return undefined
    const cutoff = new Date(now() - SESSION_ACTIVE_MILLIS).toISOString()
    let rows: Array<{ values: Record<string, unknown> }>
    try {
      rows = await ctx.client.query(table, {
        criteria: [{ fieldName: 'modifyDate', operator: 'GREATER_THAN', values: [cutoff] }, { fieldName: 'expiresAt', operator: 'GREATER_THAN', values: [new Date(now()).toISOString()] }],
        booleanOperator: 'AND', limit: 500,
      })
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 403 || status === 404) sessionsGone = true
      return undefined
    }
    if (!rows.length) return undefined
    const self = ctx.status()
    const perUser = new Map<string, number>()
    for (const r of rows) {
      const id = String(r.values.userId ?? '')
      if (id) perUser.set(id, (perUser.get(id) ?? 0) + 1)
    }
    const isSelf = (id: string) => id === self.userId || (Boolean(self.user) && (names.get(id) === self.user || userLabel(id).toLowerCase() === self.user.toLowerCase()))
    const list = [...perUser.entries()].sort((a, b) => Number(isSelf(b[0])) - Number(isSelf(a[0])) || a[0].localeCompare(b[0]))
    const who = list.map(([id, n]) => `${isSelf(id) ? 'you' : names.get(id) ?? userLabel(id)}${n > 1 ? ` ×${n}` : ''}`)
    const total = rows.length
    const users = perUser.size
    return {
      value: `${total} online`,
      detail: `${total} session${total === 1 ? '' : 's'} · ${users} user${users === 1 ? '' : 's'} (${who.join(', ')})`,
      big: String(total), interest: 50 + total, level: 'ok',
    }
  }

  return {
    id: 'people', label: 'Online', needs: 'collaboration or the session store',
    present: () => ctx.has('collaboration') || Boolean(ctx.sessionTable?.()),
    async load(): Promise<TileValue> {
      const bySession = await sessions()
      if (bySession) return bySession
      const self = ctx.status()
      const signedIn = Boolean(self.userId || self.user)
      const all = ctx.has('collaboration') ? ctx.presenceTables().filter((t) => !skip.has(t)) : []
      if (!all.length && !signedIn) throw new SourceAbsent('no tables to watch')
      const batch: string[] = []
      for (let i = 0; i < Math.min(PRESENCE_TABLES_PER_REFRESH, all.length); i++) batch.push(all[(cursor + i) % all.length]!)
      cursor = (cursor + batch.length) % Math.max(1, all.length)
      let failures = 0
      await Promise.all(batch.map(async (table) => {
        try {
          const snap = await ctx.client.data<{ viewers?: Viewer[] }>('getQbitCollaborationPresence', { query: { table } })
          const t = now()
          for (const [id, v] of seen) if (v.table === table) seen.delete(id)
          for (const v of snap.viewers ?? []) {
            const you = v.userId === self.userId || (Boolean(self.user) && v.displayName === self.user)
            const connections = typeof v.connections === 'number' && v.connections > 0 ? v.connections : undefined
            if (!you) names.set(v.userId, v.displayName || v.userId)
            seen.set(`${v.userId}\u0000${table}`, { userId: v.userId, name: v.displayName || v.userId, table, mode: v.mode, connections, self: you, at: t })
          }
        } catch (error) {
          const status = (error as { status?: number }).status
          if (status === 403 || status === 404) skip.add(table)
          else failures++
        }
      }))
      if (batch.length && failures === batch.length && !signedIn) throw new Error('presence did not answer')
      // a person not seen again within one sweep of the list (plus a lease) has left
      const ttl = Math.ceil(Math.max(1, all.length) / PRESENCE_TABLES_PER_REFRESH) * ctx.intervalMs() + 45_000
      const t = now()
      for (const [id, v] of seen) if (t - v.at > ttl) seen.delete(id)
      // one entry per person, their connections summed over the tables they are on; a server
      // before collaboration 1.2.0 sends no connections, and then each person counts once
      const people = new Map<string, { name: string; table: string; mode?: string; connections: number; counted: boolean; self: boolean }>()
      for (const v of seen.values()) {
        const p = people.get(v.userId)
        if (!p) people.set(v.userId, { name: v.name, table: v.table, mode: v.mode, connections: v.connections ?? 1, counted: v.connections !== undefined, self: v.self })
        else if (p.counted && v.connections !== undefined) p.connections += v.connections
        else p.connections = 1, p.counted = false
      }
      const others = [...people.values()].filter((p) => !p.self).sort((a, b) => a.name.localeCompare(b.name))
      // this terminal is you (it keeps its lease while the saver shows); your other terminals count too
      const yours = signedIn ? Math.max(1, [...people.values()].filter((p) => p.self).reduce((n, p) => n + p.connections, 0)) : 0
      const times = (n: number) => (n > 1 ? ` ×${n}` : '')
      const total = others.reduce((n, p) => n + p.connections, 0) + yours
      const parts = [...(signedIn ? [`you${times(yours)}`] : []), ...others.map((p) => `${p.name}${times(p.connections)}${p.mode === 'EDITING' ? ' editing' : ''} · ${ctx.tableLabel(p.table)}`)]
      const detail = parts.length ? `${total} online · ${parts.join(', ')}` : 'nobody around'
      return { value: String(total), detail, big: String(total), interest: total ? 50 + total : 5 }
    },
  }
}

interface JobSummary {
  status?: string
  label?: string
  processName?: string
}

/** Counts jobs by status: running, queued, failed. */
export function countJobs(jobs: JobSummary[]): { running: number; queued: number; failed: number } {
  let running = 0
  let queued = 0
  let failed = 0
  for (const j of jobs) {
    const s = (j.status ?? '').toUpperCase()
    if (/QUEUE|PENDING|WAIT|SCHEDULED/.test(s)) queued++
    else if (/RUN|PROGRESS|ACTIVE|START/.test(s)) running++
    else if (/FAIL|ERROR|CANCEL/.test(s)) failed++
  }
  return { running, queued, failed }
}

export function jobsSource(ctx: SaverContext): TileSource {
  let scope: 'all' | 'mine' = 'all'
  return {
    id: 'jobs', label: 'Jobs', needs: 'durableJobs',
    present: () => ctx.features.includes('durableJobs'),
    async load(): Promise<TileValue> {
      let data: { jobs?: JobSummary[]; activeCount?: number }
      try {
        data = await ctx.client.data('listJobs', { query: { scope, state: 'recent', limit: '200' } })
      } catch (error) {
        if ((error as { status?: number }).status !== 403 || scope === 'mine') throw error
        scope = 'mine'
        data = await ctx.client.data('listJobs', { query: { scope, state: 'recent', limit: '200' } })
      }
      const c = countJobs(data.jobs ?? [])
      const level: Level | undefined = c.failed ? 'warn' : c.running ? 'ok' : undefined
      return {
        value: `${c.running} running`, detail: `${c.queued} queued · ${c.failed} failed recently${scope === 'mine' ? ' (yours)' : ''}`, level,
        big: String(c.running), interest: c.running * 10 + c.failed * 5 + c.queued * 3,
      }
    },
  }
}

const HEALTH_LEVEL: Record<string, Level> = { UP: 'ok', DEGRADED: 'warn', DOWN: 'err' }

export function healthSource(ctx: SaverContext): TileSource {
  return {
    id: 'health', label: 'Health', needs: 'health',
    present: () => ctx.has('health'),
    async load(): Promise<TileValue> {
      const s = await ctx.client.data<{ status?: string | null; counts?: { up?: number; degraded?: number; down?: number; unknown?: number } }>('getHealthSummary')
      const c = s.counts ?? {}
      const total = (c.up ?? 0) + (c.degraded ?? 0) + (c.down ?? 0) + (c.unknown ?? 0)
      const status = (s.status ?? 'UNKNOWN').toUpperCase()
      return {
        value: status, level: HEALTH_LEVEL[status],
        detail: `${c.up ?? 0} up · ${c.degraded ?? 0} degraded · ${c.down ?? 0} down · ${c.unknown ?? 0} unknown`,
        big: `${c.up ?? 0}/${total}`, interest: (c.down ?? 0) * 20 + (c.degraded ?? 0) * 8 + 10,
      }
    },
  }
}

export function dbSource(ctx: SaverContext): TileSource {
  return {
    id: 'db', label: 'Database', needs: 'db-performance',
    present: () => ctx.has('db-performance'),
    async load(): Promise<TileValue> {
      const [overview, activity] = await Promise.all([
        ctx.client.data<{ settings?: { provider?: string; statsAccess?: string }; snapshot?: { connectionsTotal?: number | null; maxConnections?: number | null; cacheHitRatio?: number | null } }>('dbPerformanceOverview'),
        ctx.client.data<{ sessions?: unknown[]; blockingChains?: unknown[] }>('dbPerformanceActivity').catch(() => ({ sessions: undefined, blockingChains: undefined })),
      ])
      const snap = overview.snapshot ?? {}
      const sessions = activity.sessions?.length
      const blocked = activity.blockingChains?.length ?? 0
      const conn = snap.connectionsTotal ?? undefined
      const parts = [`connections ${conn ?? '—'}/${snap.maxConnections ?? '—'}`]
      if (typeof snap.cacheHitRatio === 'number') parts.push(`cache ${(snap.cacheHitRatio * (snap.cacheHitRatio <= 1 ? 100 : 1)).toFixed(1)}%`)
      if (blocked) parts.push(`${blocked} blocking`)
      if (overview.settings?.provider === 'UNSUPPORTED') parts.push('stats need PostgreSQL')
      return {
        value: sessions === undefined ? (conn === undefined ? 'n/a' : `${conn} conn`) : `${sessions} sessions`,
        detail: parts.join(' · '), level: blocked ? 'warn' : undefined,
        big: sessions !== undefined ? String(sessions) : conn !== undefined ? String(conn) : undefined, interest: blocked * 20 + (sessions ?? 0),
      }
    },
  }
}

interface EsbDestination {
  queueInfo?: { messageCount?: number } | null
  counters?: { deadLettered?: number; inFlight?: number }
}

export function esbSource(ctx: SaverContext): TileSource {
  return {
    id: 'esb', label: 'ESB', needs: 'esb',
    present: () => ctx.has('esb'),
    async load(): Promise<TileValue> {
      const o = await ctx.client.data<{ providers?: Array<{ connected?: boolean }>; destinations?: EsbDestination[] }>('getEsbOverview')
      const dest = o.destinations ?? []
      const depth = dest.reduce((n, d) => n + (d.queueInfo?.messageCount ?? 0), 0)
      const dead = dest.reduce((n, d) => n + (d.counters?.deadLettered ?? 0), 0)
      const inFlight = dest.reduce((n, d) => n + (d.counters?.inFlight ?? 0), 0)
      const down = (o.providers ?? []).filter((p) => p.connected === false).length
      return {
        value: `${depth} queued`, detail: `${dead} dead letters · ${inFlight} in flight · ${dest.length} destinations${down ? ` · ${down} broker down` : ''}`,
        level: down ? 'err' : dead ? 'warn' : undefined, big: String(depth), interest: dead * 6 + depth + down * 30,
      }
    },
  }
}

const SEVERITY_LEVEL: Record<string, Level> = { ERROR: 'err', CRITICAL: 'err', WARNING: 'warn', WARN: 'warn' }

export function alertsSource(ctx: SaverContext): TileSource {
  return {
    id: 'alerts', label: 'Alerts', needs: 'alerts',
    present: () => ctx.has('alerts'),
    async load(): Promise<TileValue> {
      const s = await ctx.client.data<{ unreadCount?: number; highestUnreadSeverity?: string | null; items?: Array<{ title?: string; unread?: boolean }> }>('alertsInboxSummary')
      const unread = s.unreadCount ?? 0
      const latest = s.items?.find((i) => i.unread)?.title
      return {
        value: `${unread} unread`, detail: latest ? `latest: ${latest}` : 'inbox clear', level: unread ? SEVERITY_LEVEL[(s.highestUnreadSeverity ?? '').toUpperCase()] : 'ok',
        big: String(unread), interest: unread * 2,
      }
    },
  }
}

export function eventsSource(ctx: SaverContext): TileSource {
  const now = ctx.now ?? Date.now
  return {
    id: 'events', label: 'Events', needs: 'realtime', local: true,
    present: () => ctx.features.includes('realtime'),
    async load(): Promise<TileValue> {
      const t = now()
      const rate = ctx.events.perMinute(t)
      const s = ctx.status()
      return { value: `${rate}/min`, detail: s.stream === 'connected' ? `last: ${s.lastEvent}` : `stream ${s.stream}`, spark: ctx.events.buckets(t, 10), big: String(rate), interest: rate * 4 }
    },
  }
}

export function serverSource(ctx: SaverContext): TileSource {
  return {
    id: 'server', label: 'Server', needs: 'core', local: true,
    present: () => true,
    async load(): Promise<TileValue> {
      const s = ctx.status()
      const ping = s.pingMs === null ? undefined : Math.round(s.pingMs)
      return {
        value: ping === undefined ? 'no ping' : `${ping} ms`, detail: `UI API ${s.apiVersion} · stream ${s.stream}`,
        level: ping === undefined ? 'err' : ping > 500 ? 'warn' : 'ok', big: ping === undefined ? undefined : `${ping}`, interest: ping === undefined ? 40 : ping > 500 ? 30 : 1,
      }
    },
  }
}

export function tableCountSource(ctx: SaverContext, table: string): TileSource {
  return {
    id: `table:${table}`, label: ctx.tableLabel(table), needs: 'core',
    present: () => true,
    async load(): Promise<TileValue> {
      const n = await ctx.client.count(table, { criteria: [], booleanOperator: 'AND' })
      return { value: n.toLocaleString('en-US'), detail: `records in ${table}`, big: compact(n), interest: 12 }
    },
  }
}

/** 1234 → `1.2k`, 3400000 → `3.4M` (for block digits). */
export function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/** Every source, in the order the HUD lists them. */
export function saverSources(ctx: SaverContext): TileSource[] {
  return [
    presenceSource(ctx), jobsSource(ctx), healthSource(ctx), dbSource(ctx), esbSource(ctx), alertsSource(ctx), eventsSource(ctx), serverSource(ctx),
    ...ctx.favouriteTables.map((t) => tableCountSource(ctx, t)),
  ]
}
