/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The `/` search: one place to find apps, tables, processes, widgets, reports, records (quick
 * search) and commands, grouped under headers with the best match first. This file holds the
 * grouping and the record search; the overlay in overlays/center.tsx draws it.
 */

export interface PaletteItem {
  label: string
  kind: string
  context?: string
  /** Absent for a note (shown dimmed, not runnable). */
  run?: () => void
}

/** Where the Records group stands for the current text. */
export interface RecordState {
  /** absent: no record search on this server; idle: too little text; searching; done; error; none: the server has no search provider. */
  status: 'absent' | 'idle' | 'searching' | 'done' | 'error' | 'none'
  /** The quick search extension answers (otherwise the server's own search). */
  quick: boolean
  items: PaletteItem[]
  error?: string
}

export interface PaletteGroup {
  title: string
  items: PaletteItem[]
}

const TITLES: Record<string, string> = { recent: 'Recent', app: 'Apps', table: 'Tables', process: 'Processes', widget: 'Widgets', report: 'Reports', record: 'Records', command: 'Commands', help: 'Help' }

/** The note shown once, dimmed, when the server cannot search records. */
export const NO_QUICK_SEARCH = 'records: install the quick search extension'

function recordsGroup(r: RecordState): PaletteGroup | undefined {
  if (r.status === 'idle') return undefined
  const what = r.quick ? 'quick search' : 'server search'
  if (r.status === 'absent') return { title: 'Records', items: [{ label: NO_QUICK_SEARCH, kind: 'note' }] }
  if (r.status === 'none') return { title: 'Records', items: [{ label: 'records: this server has no search provider', kind: 'note' }] }
  if (r.status === 'searching') return { title: `Records · ${what}: searching…`, items: r.items }
  if (r.status === 'error') return { title: `Records · ${what}`, items: [{ label: `records: ${r.error ?? 'search failed'}`, kind: 'note' }] }
  const n = r.items.length
  return { title: `Records · ${what}: ${n} match${n === 1 ? '' : 'es'}`, items: n ? r.items : [{ label: 'no records match', kind: 'note' }] }
}

/**
 * Groups for typed text: the metadata matches (already ranked) by kind in the order their best
 * match appears, then Records, then Commands and Help. A group whose first entry starts with the
 * text moves ahead of groups whose first entry does not (best match first).
 */
export function paletteGroups(input: { text: string; index: PaletteItem[]; commands: PaletteItem[]; records: RecordState; help?: PaletteItem[]; recents?: PaletteItem[] }): PaletteGroup[] {
  const text = input.text.trim()
  if (!text) {
    return [
      { title: TITLES.recent!, items: input.recents ?? [] },
      { title: TITLES.command!, items: input.commands },
    ].filter((g) => g.items.length)
  }
  const needle = text.replace(/^=/, '').toLowerCase()
  const groups: PaletteGroup[] = []
  for (const item of input.index) {
    const title = TITLES[item.kind] ?? item.kind
    let g = groups.find((x) => x.title === title)
    if (!g) groups.push((g = { title, items: [] }))
    g.items.push(item)
  }
  const records = recordsGroup(input.records)
  if (records) groups.push(records)
  const commands = input.commands.filter((c) => `${c.label} ${c.context ?? ''}`.toLowerCase().includes(needle))
  commands.sort((a, b) => Number(!a.label.toLowerCase().startsWith(needle)) - Number(!b.label.toLowerCase().startsWith(needle)))
  if (commands.length) groups.push({ title: TITLES.command!, items: commands.slice(0, 12) })
  if (input.help?.length) groups.push({ title: TITLES.help!, items: input.help })
  const starts = (g: PaletteGroup) => Boolean(g.items[0]?.run) && (g.items[0]!.label.toLowerCase().startsWith(needle) || g.items[0]!.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(needle)))
  return [...groups.filter(starts), ...groups.filter((g) => !starts(g))]
}

/** Rows of the palette: a header per group, then its entries; `selectable` lists the entry rows. */
export function paletteRows(groups: PaletteGroup[]): { rows: Array<{ header?: string; item?: PaletteItem }>; selectable: number[] } {
  const rows: Array<{ header?: string; item?: PaletteItem }> = []
  const selectable: number[] = []
  for (const g of groups) {
    rows.push({ header: g.title })
    for (const item of g.items) {
      if (item.run) selectable.push(rows.length)
      rows.push({ item })
    }
  }
  return { rows, selectable }
}

/** One hit of POST /search (searchRecords). */
export interface SearchHit {
  tableName?: string
  tableLabel?: string
  recordId?: unknown
  primaryKey?: unknown
  recordLabel?: string
  label?: string
  highlights?: Array<{ text?: string; fieldLabel?: string }>
}

/**
 * A search hit as a palette entry: the record label (or, when the label is only the key, the first
 * highlighted text: "Ada Lovelace" rather than "1"), and the table name with the key.
 */
export function recordItem(hit: SearchHit, tableLabel: (table: string) => string | undefined, open: (table: string, key: string) => void): PaletteItem {
  const table = hit.tableName ?? ''
  const key = String(hit.recordId ?? hit.primaryKey ?? '')
  const label = hit.recordLabel ?? hit.label ?? ''
  const highlight = hit.highlights?.find((h) => h.text)?.text
  const shown = !label || label === key ? highlight ?? (label || key) : label
  const name = hit.tableLabel ?? tableLabel(table) ?? table
  return { label: shown, kind: 'record', context: `${name}${key && shown !== key ? ` #${key}` : ''}`, run: () => open(table, key) }
}
