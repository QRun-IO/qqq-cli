/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { computeLoadedColumnStats, type LoadedColumnStats, type QueryRecord } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import type { AppStore } from '../store'
import { Zone } from '../mouse/zone'
import { theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, num, trunc } from '../util/text'
import { wrap, overlayId } from './basic'
import { Frame, Line } from './frame'

/** The most rows "a" loads for the statistics. */
export const STATS_LOAD_CAP = 10_000

const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))

/** The statistics as the server's dialog lays them out: "Label: value" lines, a blank, the most common values. */
export function loadedStatsLines(stats: LoadedColumnStats): string[] {
  const lines = [`Count: ${num(stats.count)}`, `Nulls: ${num(stats.nulls)}`, `Distinct: ${num(stats.distinct)}`]
  if (stats.kind === 'number') lines.push(`Sum: ${dash(stats.sum)}`, `Mean: ${dash(stats.mean)}`, `Median: ${dash(stats.median)}`, `Min: ${dash(stats.min)}`, `Max: ${dash(stats.max)}`)
  else if (stats.kind === 'date') lines.push(`Earliest: ${dash(stats.min)}`, `Latest: ${dash(stats.max)}`)
  else {
    lines.push(`Min: ${dash(stats.min)}`, `Max: ${dash(stats.max)}`)
    if (stats.kind === 'string') lines.push(`Shortest: ${dash(stats.shortest)}`, `Longest: ${dash(stats.longest)}`)
  }
  if (stats.top.length) lines.push('', stats.kind === 'date' ? 'Most common days:' : 'Most common values:', ...stats.top.map((v) => `  ${v.value || '(empty)'}  ×${num(v.count)}`))
  return lines
}

export interface LoadedStatsSource {
  tableLabel: string
  columnLabel: string
  fieldName: string
  field: { type?: unknown; possibleValueSourceName?: unknown }
  /** The rows the grid has loaded. */
  records: QueryRecord[]
  /** The size of the result, when known. */
  total?: number
  /** Pages through the result up to `cap` rows with the grid's filter and sort, reporting progress; returns what it has when stopped. */
  loadAll(cap: number, progress: (loaded: number, of: number) => void, signal: AbortSignal): Promise<{ records: QueryRecord[]; total: number }>
}

/** Column statistics computed here from loaded rows, for tables the server offers none for. */
export class LoadedColumnStatsOverlay implements Overlay {
  readonly id = overlayId('column-stats')
  private records: QueryRecord[]
  private total?: number
  private stats: LoadedColumnStats
  private progress?: string
  private abort?: AbortController
  private error?: string

  constructor(private store: AppStore, private source: LoadedStatsSource) {
    this.records = source.records
    this.total = source.total
    this.stats = this.compute()
  }

  private compute(): LoadedColumnStats {
    return computeLoadedColumnStats(this.records, this.source.fieldName, this.source.field)
  }

  get title(): string {
    return `Column statistics · ${this.source.columnLabel}`
  }

  /** The line that says where the numbers come from. */
  get banner(): string {
    const n = this.records.length
    const base = `from the ${num(n)} loaded rows (the server offers no column statistics for ${this.source.tableLabel})`
    if (this.total !== undefined && n < this.total) return `${base} · ${n >= STATS_LOAD_CAP ? `the first ${num(STATS_LOAD_CAP)} of ${num(this.total)} rows` : 'load more rows to widen'}`
    return base
  }

  private get canLoadMore(): boolean {
    return this.total === undefined ? true : this.records.length < Math.min(this.total, STATS_LOAD_CAP)
  }

  private loadAll(): void {
    const abort = new AbortController()
    this.abort = abort
    this.error = undefined
    this.progress = 'loading rows…'
    this.store.bump()
    this.source.loadAll(STATS_LOAD_CAP, (loaded, of) => {
      this.progress = `loading rows ${num(loaded)} of ${num(of)}`
      this.store.bump()
    }, abort.signal).then((result) => {
      // stopping keeps what was loaded, never fewer rows than the grid had
      if (result.records.length >= this.records.length) this.records = result.records
      this.total = result.total
      this.stats = this.compute()
    }).catch((e) => {
      this.error = errorText(e)
    }).finally(() => {
      this.progress = undefined
      this.abort = undefined
      this.store.bump()
    })
  }

  onKey(key: Key): void {
    if (this.abort) {
      if (key.name === 'escape') this.abort.abort()
      return
    }
    if (charOf(key).toLowerCase() === 'a' && this.canLoadMore) return this.loadAll()
    this.store.closeOverlay(this)
  }

  render(sw: number, sh: number) {
    const width = Math.min(sw - 4, 100)
    const inner = width - 4
    const banner = wrap(this.banner, inner)
    const body = loadedStatsLines(this.stats).slice(0, Math.max(3, sh - 10 - banner.length)).map((l) => trunc(l, inner))
    const footer = this.progress
      ? ` ${this.progress} · Esc stops`
      : this.error ? ` ${this.error}`
        : this.canLoadMore ? ` a loads all rows up to ${num(STATS_LOAD_CAP)} and recomputes · any other key closes` : ' any key closes'
    return (
      <Frame title={this.title} width={width} height={banner.length + body.length + 5} screenWidth={sw} screenHeight={sh}>
        {banner.map((l, i) => <Line key={`b${i}`} text={` ${l}`} width={width - 2} fg={theme().dim} />)}
        <Line text="" width={width - 2} />
        {body.map((l, i) => <Line key={i} text={` ${l}`} width={width - 2} fg={theme().fg} />)}
        <Line text="" width={width - 2} />
        <Zone onClick={() => { if (!this.abort) this.store.closeOverlay(this) }}><Line text={trunc(footer, width - 2)} width={width - 2} fg={this.error ? theme().err : theme().dim} /></Zone>
      </Frame>
    )
  }
}
