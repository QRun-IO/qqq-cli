/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The screen saver's live tiles: each tile is a source (people online, jobs, health…) that is
 * loaded every refresh interval while the saver shows. A source whose extension or permission is
 * absent (not installed, 403, 404) is hidden for good; any other failure keeps the last value,
 * shown dimmed as stale, and backs off (interval × 2^failures, at most five minutes). Local sources
 * (ping, event rate) cost no request and are read every second.
 */

import { ExtensionNotInstalledError } from '@qrun-io/qqq-core'

export type Level = 'ok' | 'warn' | 'err'

export interface TileValue {
  /** The short value: `3`, `UP`, `12/min`. */
  value: string
  /** One more line of context: who, which table, the counts behind the value. */
  detail?: string
  level?: Level
  /** The number the Big numbers style draws in block digits (absent: not shown there). */
  big?: string
  /** How interesting the tile is now (Big numbers shows the highest first). */
  interest?: number
  /** A small series for a sparkline (events per minute over the last minutes). */
  spark?: number[]
}

export interface TileSource {
  id: string
  label: string
  /** The extension or feature the source needs (shown in help; `core` when none). */
  needs: string
  /** Whether the server has what the source needs (installed extension, feature). */
  present(): boolean
  load(): Promise<TileValue>
  /** Costs no request: read on every tick instead of every interval. */
  local?: boolean
}

export type TileStatus = 'loading' | 'ok' | 'stale' | 'error'

export interface TileState {
  id: string
  label: string
  needs: string
  status: TileStatus
  value?: TileValue
  error?: string
  updatedAt?: number
  failures: number
  nextAt: number
}

/** Thrown by a source when what it reads is not on this server: the tile hides. */
export class SourceAbsent extends Error {}

/** Whether an error means "not here" (hide the tile) rather than "failed now" (stale, retry). */
export function isAbsent(error: unknown): boolean {
  if (error instanceof SourceAbsent || error instanceof ExtensionNotInstalledError) return true
  const status = (error as { status?: unknown } | undefined)?.status
  return status === 403 || status === 404 || status === 501
}

export const MAX_BACKOFF_MS = 5 * 60_000

export class TileModel {
  private states = new Map<string, TileState>()
  private hidden = new Set<string>()
  private inFlight = new Set<string>()
  intervalMs: number

  constructor(private readonly sources: TileSource[], options: { intervalMs: number; now?: () => number } = { intervalMs: 15_000 }) {
    this.intervalMs = options.intervalMs
    this.now = options.now ?? Date.now
    for (const s of sources) this.states.set(s.id, { id: s.id, label: s.label, needs: s.needs, status: 'loading', failures: 0, nextAt: 0 })
  }

  readonly now: () => number

  /** The tiles to draw, in source order: absent sources left out. */
  tiles(): TileState[] {
    return this.sources.filter((s) => !this.hidden.has(s.id) && s.present()).map((s) => this.states.get(s.id)!)
  }

  /** A tile's state (also hidden ones), for tests and the Big numbers pick. */
  tile(id: string): TileState | undefined {
    return this.states.get(id)
  }

  isHidden(id: string): boolean {
    return this.hidden.has(id) || !this.sources.find((s) => s.id === id)?.present()
  }

  /** Delay before the next try after `failures` failures in a row. */
  backoff(failures: number): number {
    return Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** failures)
  }

  /** Loads every source that is due (local ones always); resolves when they settle. */
  async refresh(now = this.now()): Promise<void> {
    const due = this.sources.filter((s) => !this.hidden.has(s.id) && !this.inFlight.has(s.id) && s.present() && (s.local || now >= this.states.get(s.id)!.nextAt))
    await Promise.all(due.map((s) => this.load(s, now)))
  }

  private async load(source: TileSource, startedAt: number): Promise<void> {
    const state = this.states.get(source.id)!
    this.inFlight.add(source.id)
    try {
      const value = await source.load()
      state.value = value
      state.status = 'ok'
      state.error = undefined
      state.failures = 0
      state.updatedAt = this.now()
      state.nextAt = startedAt + this.intervalMs
    } catch (error) {
      if (isAbsent(error)) {
        this.hidden.add(source.id)
        return
      }
      state.failures++
      state.error = error instanceof Error ? error.message : String(error)
      state.status = state.value ? 'stale' : 'error'
      state.nextAt = startedAt + this.backoff(state.failures)
    } finally {
      this.inFlight.delete(source.id)
    }
  }

  /** A loaded value counts as stale once it is three intervals old (a slow or hung source). */
  isStale(state: TileState, now = this.now()): boolean {
    return state.status === 'stale' || (state.status === 'ok' && state.updatedAt !== undefined && now - state.updatedAt > this.intervalMs * 3)
  }
}

/** Events per minute from a stream of timestamps (the realtime stream the TUI keeps open). */
export class EventRate {
  private times: number[] = []

  constructor(private readonly keepMillis = 15 * 60_000) {}

  note(at = Date.now()): void {
    this.times.push(at)
    if (this.times.length > 5000 || (this.times[0] ?? at) < at - this.keepMillis) this.prune(at)
  }

  private prune(now: number): void {
    const from = now - this.keepMillis
    let i = 0
    while (i < this.times.length && this.times[i]! < from) i++
    this.times = this.times.slice(Math.max(i, this.times.length - 5000))
  }

  /** Events in the last minute. */
  perMinute(now = Date.now()): number {
    return this.times.filter((t) => t > now - 60_000 && t <= now).length
  }

  /** Counts per minute for the last `minutes` minutes, oldest first (for a sparkline). */
  buckets(now = Date.now(), minutes = 10): number[] {
    const out = new Array<number>(minutes).fill(0)
    for (const t of this.times) {
      const age = Math.floor((now - t) / 60_000)
      if (age >= 0 && age < minutes) out[minutes - 1 - age]!++
    }
    return out
  }

  get total(): number {
    return this.times.length
  }
}

/** The events of this session's realtime stream (store.ts notes each one). */
export const realtimeEvents = new EventRate()

/** A sparkline of values with the glyph ramp (`▁▂▃▄▅▆▇█`, or ` .:-=+*#` for ASCII). */
export function sparkline(values: number[], ramp: string): string {
  const max = Math.max(0, ...values)
  const steps = [...ramp]
  return values.map((v) => (max === 0 ? steps[0] : steps[Math.min(steps.length - 1, Math.round((v / max) * (steps.length - 1)))])).join('')
}
