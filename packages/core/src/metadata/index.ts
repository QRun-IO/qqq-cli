/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A search index over the navigable metadata (apps, tables, processes, reports, widgets), built
 * once from the cached GET /metaData document, so palettes, menus and trees on an instance with
 * thousands of objects never walk the tree per keystroke. Matching: exact, prefix, word prefix,
 * substring, then subsequence (fuzzy), over label and name; ranked by match then label.
 */

import type { MetaDataDocument } from './cache.js'

export type IndexKind = 'app' | 'table' | 'process' | 'report' | 'widget'

export interface IndexEntry {
  kind: IndexKind
  name: string
  label: string
  /** Labels of the enclosing apps, outermost first (empty for objects outside the app tree). */
  path: string[]
  /** Lower-cased label, name and path words, precomputed for matching. */
  readonly haystack: string
  readonly labelLower: string
  readonly nameLower: string
  hidden: boolean
  /** Whether it sits in the app tree (navigable) rather than only in the maps. */
  inTree: boolean
}

export interface SearchOptions {
  kinds?: IndexKind[]
  limit?: number
  offset?: number
  includeHidden?: boolean
}

export interface SearchResult {
  entries: IndexEntry[]
  /** How many matched in all (for "more…"). */
  total: number
}

interface TreeNode { type?: string; name?: string; label?: string; children?: TreeNode[] }

function entry(kind: IndexKind, name: string, label: string, path: string[], hidden: boolean, inTree: boolean): IndexEntry {
  const labelLower = label.toLowerCase()
  const nameLower = name.toLowerCase()
  return { kind, name, label, path, hidden, inTree, labelLower, nameLower, haystack: `${labelLower} ${nameLower} ${path.join(' ').toLowerCase()}` }
}

/** Subsequence match: every character of the needle appears in order. */
function subsequence(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

/** A rank for one entry against a needle (lower is better; Infinity: no match). */
function rank(e: IndexEntry, needle: string): number {
  if (!needle) return 5
  if (e.labelLower === needle || e.nameLower === needle) return 0
  if (e.labelLower.startsWith(needle) || e.nameLower.startsWith(needle)) return 1
  if (e.labelLower.includes(` ${needle}`) || e.nameLower.includes(`.${needle}`) || e.nameLower.includes(`_${needle}`)) return 2
  if (e.labelLower.includes(needle) || e.nameLower.includes(needle)) return 3
  if (e.haystack.includes(needle)) return 4
  if (needle.length >= 2 && (subsequence(needle, e.labelLower) || subsequence(needle, e.nameLower))) return 6
  return Infinity
}

export class MetaDataIndex {
  readonly entries: IndexEntry[] = []
  readonly counts: Record<IndexKind, number> = { app: 0, table: 0, process: 0, report: 0, widget: 0 }
  /** Milliseconds the build took. */
  readonly buildMillis: number
  private byKey = new Map<string, IndexEntry>()

  constructor(meta: MetaDataDocument) {
    const started = performance.now()
    const kinds: Record<string, IndexKind> = { APP: 'app', TABLE: 'table', PROCESS: 'process', REPORT: 'report' }
    const walk = (nodes: TreeNode[], path: string[]) => {
      for (const n of nodes) {
        const kind = kinds[String(n.type)]
        if (kind && n.name) this.add(entry(kind, n.name, n.label ?? n.name, path, false, true))
        if (n.children?.length) walk(n.children, [...path, n.label ?? n.name ?? ''])
      }
    }
    walk((meta.appTree ?? []) as TreeNode[], [])
    const maps: Array<[IndexKind, Record<string, { name: string; label?: string; isHidden?: boolean }> | undefined]> = [
      ['app', meta.apps as never], ['table', meta.tables as never], ['process', meta.processes as never], ['report', meta.reports as never], ['widget', meta.widgets as never],
    ]
    for (const [kind, map] of maps) {
      for (const [name, v] of Object.entries(map ?? {})) {
        const existing = this.byKey.get(`${kind}:${name}`)
        if (existing) {
          existing.hidden = Boolean(v.isHidden)
          continue
        }
        this.add(entry(kind, name, String(v.label ?? name), [], Boolean(v.isHidden), false))
      }
    }
    for (const e of this.entries) if (!e.hidden) this.counts[e.kind]++
    this.buildMillis = performance.now() - started
  }

  private add(e: IndexEntry): void {
    const key = `${e.kind}:${e.name}`
    if (this.byKey.has(key)) return
    this.byKey.set(key, e)
    this.entries.push(e)
  }

  get(kind: IndexKind, name: string): IndexEntry | undefined {
    return this.byKey.get(`${kind}:${name}`)
  }

  /** Matches by relevance then label; every word of the text must match. */
  search(text: string, options: SearchOptions = {}): SearchResult {
    const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const kinds = options.kinds ? new Set(options.kinds) : undefined
    const scored: Array<{ e: IndexEntry; r: number }> = []
    for (const e of this.entries) {
      if (kinds && !kinds.has(e.kind)) continue
      if (e.hidden && !options.includeHidden) continue
      let r = 0
      for (const w of words) {
        const wr = rank(e, w)
        if (wr === Infinity) {
          r = Infinity
          break
        }
        r = Math.max(r, wr)
      }
      if (r !== Infinity) scored.push({ e, r })
    }
    scored.sort((a, b) => a.r - b.r || Number(b.e.inTree) - Number(a.e.inTree) || a.e.label.localeCompare(b.e.label))
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    return { entries: scored.slice(offset, offset + limit).map((s) => s.e), total: scored.length }
  }

  /** "12 apps, 1,000 tables, 500 processes" for a header line. */
  describe(): string {
    const parts: string[] = []
    for (const [kind, label] of [['app', 'apps'], ['table', 'tables'], ['process', 'processes'], ['report', 'reports'], ['widget', 'widgets']] as const) {
      if (this.counts[kind]) parts.push(`${this.counts[kind].toLocaleString('en-US')} ${label}`)
    }
    return parts.join(', ')
  }
}

/** A generated metadata document of a given size (tests and the large-instance fake server). */
export function generateMetaData(sizes: { apps?: number; tables: number; processes: number; widgets?: number; reports?: number }): MetaDataDocument {
  const appCount = sizes.apps ?? 20
  const apps: Record<string, unknown> = {}
  const tables: Record<string, unknown> = {}
  const processes: Record<string, unknown> = {}
  const widgets: Record<string, unknown> = {}
  const reports: Record<string, unknown> = {}
  const words = ['order', 'invoice', 'customer', 'shipment', 'product', 'warehouse', 'vendor', 'payment', 'ledger', 'contact', 'carrier', 'price']
  const tree: TreeNode[] = []
  for (let a = 0; a < appCount; a++) {
    const name = `app${a}`
    const node: TreeNode = { type: 'APP', name, label: `App ${a} ${words[a % words.length]}`, children: [] }
    tree.push(node)
    apps[name] = { name, label: node.label, widgets: [] as string[], children: node.children }
  }
  for (let t = 0; t < sizes.tables; t++) {
    const name = `${words[t % words.length]}_${t}`
    const label = `${words[t % words.length]![0]!.toUpperCase()}${words[t % words.length]!.slice(1)} ${t}`
    tables[name] = { name, label, insertPermission: true, readPermission: true }
    tree[t % appCount]!.children!.push({ type: 'TABLE', name, label })
  }
  for (let p = 0; p < sizes.processes; p++) {
    const name = `process${p}`
    const label = `Recalculate ${words[p % words.length]} ${p}`
    processes[name] = { name, label }
    tree[p % appCount]!.children!.push({ type: 'PROCESS', name, label })
  }
  for (let w = 0; w < (sizes.widgets ?? 0); w++) {
    const name = `widget${w}`
    widgets[name] = { name, label: `Widget ${w}`, type: 'statistics', hasPermission: true }
    ;(apps[`app${w % appCount}`] as { widgets: string[] }).widgets.push(name)
  }
  for (let r = 0; r < (sizes.reports ?? 0); r++) reports[`report${r}`] = { name: `report${r}`, label: `Report ${r}` }
  return { apps: apps as never, appTree: tree, tables: tables as never, processes: processes as never, widgets: widgets as never, reports: reports as never, branding: { appName: 'Large Instance' } }
}
