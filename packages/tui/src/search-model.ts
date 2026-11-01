/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Search screen's state (F2): the text, the results grouped by table, the cursor, marked hits,
 * the table it is narrowed to, recent searches and the quick search status. Without the quick
 * search extension it searches names instead (tables, apps, processes) and the record labels of the
 * table the screen was opened from. Pure: the server calls come in as functions, so tests drive it.
 */

import { plainSearchText, groupSearchResults, quickSearchStatus, searchStatusLine, unsupportedSyntax, type QuickSearchStatusSummary, type SearchGroup, type SearchHit } from '@qrun-io/qqq-core'

type J = Record<string, unknown>

/** A hit: a record (quick search or the table's query), or a table, app or process found by name. */
export interface Hit extends SearchHit {
  /** What Enter opens; a record when absent. */
  target?: { kind: 'table' | 'app' | 'process'; name: string }
}

export interface HitGroup extends Omit<SearchGroup, 'hits'> {
  hits: Hit[]
}

export interface SearchDeps {
  /** The quick search extension is installed. */
  quick: boolean
  /** POST /search; resolves the raw response. */
  searchRecords(text: string, tables: string[] | undefined, limitPerTable: number): Promise<J>
  /** GET /qbit/quick-search/status. */
  status?(): Promise<J>
  /** Names (tables, apps, processes) matching the text, for the fallback. */
  names(text: string): Hit[]
  /** Records of the context table whose label fields contain the text, for the fallback. */
  contextRecords?(text: string): Promise<HitGroup | undefined>
  /** Recent searches of this profile, newest first, and adding one. */
  history: { entries(): string[]; add(text: string): void }
  now?(): number
}

/** The key of a hit for marks. */
export const hitKey = (h: { table: string; key: string }) => `${h.table}\u0000${h.key}`

export class SearchModel {
  text = ''
  groups: HitGroup[] = []
  total = 0
  /** Flat index over every hit. */
  cursor = 0
  marked = new Set<string>()
  /** Narrowed to one table (f). */
  table?: string
  searching = false
  error?: string
  ms?: number
  notes: string[] = []
  status?: QuickSearchStatusSummary
  provider = 'OK'
  private generation = 0

  constructor(readonly deps: SearchDeps) {}

  /** The hits in order, each with its group index. */
  flat(): Array<{ group: number; hit: Hit }> {
    return this.groups.flatMap((g, group) => g.hits.map((hit) => ({ group, hit })))
  }

  current(): { group: number; hit: Hit } | undefined {
    return this.flat()[this.cursor]
  }

  placeholder(): string {
    if (!this.deps.quick) return 'search tables, apps, processes and the records of this table by name'
    const n = this.status?.tables.length
    return `search records across ${n ?? 'the indexed'} table${n === 1 ? '' : 's'} (quick search)`
  }

  /** The status line: counts, time, index size and last reindex; names-only without quick search. */
  statusLine(clock?: (iso: string) => string): string {
    if (!this.deps.quick) {
      const found = this.text.trim() ? `${this.total} match${this.total === 1 ? '' : 'es'} · ` : ''
      return `${found}quick search not installed: searching names only`
    }
    if (this.provider === 'NONE') return 'this server has no search provider: nothing searches records'
    return searchStatusLine(this.text.trim() ? { total: this.total, groups: this.groups } : undefined, this.text.trim() ? this.ms : undefined, this.status, clock) || 'type to search'
  }

  async loadStatus(): Promise<void> {
    if (!this.deps.quick || !this.deps.status) return
    try {
      this.status = quickSearchStatus(await this.deps.status())
    } catch {
      this.status = undefined
    }
  }

  /** Runs the search for the current text (the screen debounces); a newer run wins. */
  async run(): Promise<void> {
    const text = this.text.trim()
    const gen = ++this.generation
    this.notes = this.deps.quick ? unsupportedSyntax(text) : []
    if (!text) {
      this.groups = []
      this.total = 0
      this.cursor = 0
      this.error = undefined
      return
    }
    this.searching = true
    const started = (this.deps.now ?? Date.now)()
    try {
      let groups: HitGroup[]
      let total: number
      if (this.deps.quick) {
        const data = await this.deps.searchRecords(plainSearchText(text) || text, this.table ? [this.table] : undefined, this.table ? 50 : 10)
        const r = groupSearchResults(data)
        if (gen !== this.generation) return
        this.provider = r.provider
        groups = r.groups
        total = r.total
      } else {
        const names = this.deps.names(text)
        const kinds: Array<[string, string]> = [['table', 'Tables'], ['app', 'Apps'], ['process', 'Processes']]
        groups = kinds.map(([kind, label]) => {
          const hits = names.filter((h) => h.target?.kind === kind)
          return { table: `:${kind}`, label, total: hits.length, hasMore: false, hits }
        }).filter((g) => g.hits.length)
        const records = await this.deps.contextRecords?.(text)
        if (records?.hits.length) groups.unshift(records)
        if (this.table) groups = groups.filter((g) => g.table === this.table)
        total = groups.reduce((n, g) => n + g.total, 0)
      }
      if (gen !== this.generation) return
      this.groups = groups
      this.total = total
      this.error = undefined
      this.ms = (this.deps.now ?? Date.now)() - started
      this.cursor = Math.min(this.cursor, Math.max(0, this.flat().length - 1))
    } catch (e) {
      if (gen !== this.generation) return
      this.error = e instanceof Error ? e.message : String(e)
      this.groups = []
      this.total = 0
    } finally {
      if (gen === this.generation) this.searching = false
    }
  }

  move(delta: number): void {
    const n = this.flat().length
    this.cursor = Math.max(0, Math.min(n - 1, this.cursor + delta))
  }

  /** ←→ / Tab: the first hit of the next (or previous) table group, wrapping. */
  cycleGroup(dir: 1 | -1): void {
    const flat = this.flat()
    if (!flat.length) return
    const at = flat[this.cursor]?.group ?? 0
    const next = (at + dir + this.groups.length) % this.groups.length
    this.cursor = flat.findIndex((x) => x.group === next)
  }

  toggleMark(): void {
    const c = this.current()
    if (!c || c.hit.target) return
    const k = hitKey(c.hit)
    if (this.marked.has(k)) this.marked.delete(k)
    else this.marked.add(k)
  }

  /** Marked record keys by table. */
  markedByTable(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const k of this.marked) {
      const [table, key] = k.split('\u0000') as [string, string]
      out.set(table, [...(out.get(table) ?? []), key])
    }
    return out
  }

  /** The record keys `o` opens for the current group: the marked ones in it, else every hit shown. */
  keysForGrid(group: number): string[] {
    const g = this.groups[group]
    if (!g) return []
    const marked = this.markedByTable().get(g.table)
    return marked?.length ? marked : g.hits.filter((h) => !h.target).map((h) => h.key)
  }

  /** Recent searches, newest first, without repeats. */
  recent(max = 20): string[] {
    return [...new Set(this.deps.history.entries())].slice(0, max)
  }

  remember(): void {
    if (this.text.trim()) this.deps.history.add(this.text.trim())
  }
}
