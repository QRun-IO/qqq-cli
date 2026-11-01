/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Record search (POST /search, answered by the quick search extension when it is installed): the
 * results grouped by table with their counts, each hit's label, key and highlighted snippet, what
 * the quick search query language supports, and the quick search status line. Shared by the CLI's
 * `qqq search` and the TUI's Search screen.
 */

type J = Record<string, unknown>

export interface SearchHighlight {
  text?: string
  fieldName?: string
  fieldLabel?: string
  matches?: Array<{ start?: number; end?: number }>
}

export interface SearchHit {
  table: string
  tableLabel: string
  key: string
  label: string
  /** The first highlight: the matched field's label and the text around the match. */
  snippet?: string
  field?: string
  highlights: SearchHighlight[]
  score?: number
}

export interface SearchGroup {
  table: string
  label: string
  /** Matches in the table (the provider's total when it reports one, else the hits returned). */
  total: number
  hasMore: boolean
  hits: SearchHit[]
}

export interface RecordSearchResult {
  groups: SearchGroup[]
  /** Matches across every table. */
  total: number
  /** OK, NONE (no provider: nothing searches records) or the provider's state. */
  provider: string
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The snippet of a highlight: "Email: ada@example.test", the match marked with the given brackets. */
export function highlightText(h: SearchHighlight, mark: [string, string] = ['', '']): string {
  const text = str(h.text).replace(/\s+/g, ' ')
  let out = text
  if (mark[0] || mark[1]) {
    const spans = (h.matches ?? []).filter((m) => typeof m.start === 'number' && typeof m.end === 'number' && m.end! > m.start!).sort((a, b) => b.start! - a.start!)
    for (const m of spans) out = `${out.slice(0, m.start)}${mark[0]}${out.slice(m.start, m.end)}${mark[1]}${out.slice(m.end)}`
  }
  const label = h.fieldLabel ?? h.fieldName
  return label ? `${label}: ${out}` : out
}

/** One hit of the response. When the record label is only its key, the first highlighted text stands in. */
export function searchHit(r: J): SearchHit {
  const highlights = (Array.isArray(r.highlights) ? r.highlights : []) as SearchHighlight[]
  const key = str(r.recordId ?? r.primaryKey)
  const rawLabel = str(r.recordLabel ?? r.label)
  const first = highlights.find((h) => h.text)
  return {
    table: str(r.tableName ?? r.table),
    tableLabel: str(r.tableLabel ?? r.tableName ?? r.table),
    key,
    label: rawLabel && rawLabel !== key ? rawLabel : first?.text ? str(first.text) : rawLabel || key,
    ...(first ? { snippet: highlightText(first), field: first.fieldLabel ?? first.fieldName } : {}),
    highlights,
    ...(typeof r.score === 'number' ? { score: r.score } : {}),
  }
}

/** The response grouped by table, in the order the server lists the tables; tables without hits are left out. */
export function groupSearchResults(data: J): RecordSearchResult {
  const hits = ((data.results ?? []) as J[]).map(searchHit)
  const tables = (Array.isArray(data.tables) ? data.tables : []) as J[]
  const order = [...tables.map((t) => str(t.tableName)), ...hits.map((h) => h.table)].filter((t, i, all) => t && all.indexOf(t) === i)
  const groups: SearchGroup[] = []
  for (const table of order) {
    const mine = hits.filter((h) => h.table === table)
    if (!mine.length) continue
    const info = tables.find((t) => str(t.tableName) === table)
    const total = typeof info?.totalCount === 'number' ? Math.max(info.totalCount, mine.length) : mine.length
    groups.push({ table, label: str(info?.tableLabel) || mine[0]!.tableLabel || table, total, hasMore: Boolean(info?.hasMore) || total > mine.length, hits: mine })
  }
  const provider = str((data.provider as J | undefined)?.status) || 'OK'
  return { groups, total: groups.reduce((n, g) => n + g.total, 0), provider }
}

/**
 * What the quick search query language is, from the extension's matching (qbit-quick-search): every
 * word must match (AND), a word matches the start of words, case does not matter, keyword
 * and exact fields need the whole word or value. There are no phrases, field:value terms, wildcards
 * or OR.
 */
export const QUICK_SEARCH_SYNTAX: string[] = [
  'Type words: a record matches when every word matches (AND), in any of its searched fields.',
  'Words match from their start, so partial typing finds records: "ada lov" finds Ada Lovelace.',
  'Case does not matter. Fields set up as keywords match whole words only; exact fields (codes, ids) match only the whole value.',
  'Not supported: quotes for phrases, field:value, wildcards (* ?), OR and minus. Those characters are searched as plain text.',
]

/** Notes for text that uses syntax quick search does not have (it searches the words instead). */
export function unsupportedSyntax(text: string): string[] {
  const notes: string[] = []
  if (/"[^"]*"/.test(text)) notes.push('quotes are not phrases: the words are searched')
  const field = /(?:^|\s)([A-Za-z_][\w.]*):(\S+)/.exec(text)
  if (field) notes.push(`${field[1]}:${field[2]} is not a field search: searched for ${field[2]} in every field`)
  if (/[*?]/.test(text)) notes.push('* and ? are not wildcards: words already match from their start')
  if (/(?:^|\s)(?:OR(?=\s|$)|-\w)/.test(text)) notes.push('OR and minus are not operators: every word must match')
  return notes
}

/** The text sent to quick search: `field:value` becomes `value` (it has no field terms; the value is what was meant). */
export function plainSearchText(text: string): string {
  return text.replace(/(^|\s)[A-Za-z_][\w.]*:(?=\S)/g, '$1').trim()
}

/**
 * The empty state when quick search finds nothing: what it covers (N of all tables, the first five
 * names and "and N more", records, last reindex), that other tables cannot be found here, and where
 * to add them; `fallback` is the last clause (what to press instead).
 */
export function searchCoverageText(text: string, status: QuickSearchStatusSummary | undefined, options: { totalTables?: number; label?: (table: string) => string; clock?: (iso: string) => string; fallback?: string } = {}): string {
  const head = `No records match "${text.trim()}".`
  if (!status) return head
  const label = options.label ?? ((t: string) => t)
  const names = status.tables.map(label)
  const shown = names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ')
  const of = options.totalTables ? ` of ${options.totalTables.toLocaleString('en-US')}` : ''
  const parts = [`Quick search indexes ${status.tables.length}${of} table${status.tables.length === 1 && !of ? '' : 's'}${shown ? ` (${shown})` : ''}`, `${status.documents.toLocaleString('en-US')} record${status.documents === 1 ? '' : 's'}`]
  if (status.lastSync) parts.push(`last reindex ${(options.clock ?? ((iso: string) => new Date(iso).toTimeString().slice(0, 5)))(status.lastSync)}`)
  const fallback = options.fallback ?? 'press / to find a table by name'
  return `${head} ${parts.join(' · ')}. Tables not indexed cannot be found here; add them in Quick Search Admin › Quick Search Index, or ${fallback}.`
}

export interface QuickSearchStatusSummary {
  /** Enabled, searchable tables. */
  tables: string[]
  /** Documents in the index. */
  documents: number
  /** The last successful sync (ISO), if any. */
  lastSync?: string
  state: string
}

/** The quick search status (GET /qbit/quick-search/status) in a few numbers. */
export function quickSearchStatus(data: J): QuickSearchStatusSummary {
  const indexes = (Array.isArray(data.indexes) ? data.indexes : []) as J[]
  const enabled = indexes.filter((i) => i.enabled !== false)
  return {
    tables: enabled.map((i) => str(i.tableName)).filter(Boolean),
    documents: enabled.reduce((n, i) => n + (typeof i.documentCount === 'number' ? i.documentCount : 0), 0),
    ...(data.lastSuccessfulSync ? { lastSync: str(data.lastSuccessfulSync) } : {}),
    state: str(data.state) || 'UNKNOWN',
  }
}

/** "N matches in M tables · 42 ms · index 1,234 records in 2 tables · last reindex 10:12". */
export function searchStatusLine(result: { total: number; groups: unknown[] } | undefined, ms: number | undefined, status: QuickSearchStatusSummary | undefined, clock: (iso: string) => string = (iso) => new Date(iso).toTimeString().slice(0, 5)): string {
  const parts: string[] = []
  if (result) parts.push(`${result.total.toLocaleString('en-US')} match${result.total === 1 ? '' : 'es'} in ${result.groups.length} table${result.groups.length === 1 ? '' : 's'}`)
  if (ms !== undefined) parts.push(`${Math.round(ms)} ms`)
  if (status) {
    parts.push(`index ${status.documents.toLocaleString('en-US')} record${status.documents === 1 ? '' : 's'} in ${status.tables.length} table${status.tables.length === 1 ? '' : 's'}`)
    if (status.lastSync) parts.push(`last reindex ${clock(status.lastSync)}`)
    if (status.state && status.state !== 'OK') parts.push(`state ${status.state}`)
  }
  return parts.join(' · ')
}
