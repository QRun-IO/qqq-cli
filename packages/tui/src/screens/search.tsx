/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Search screen (F2): the main way into the data. A search line on top, results as you type
 * grouped by table (label and count), each hit with its record label, key and the highlighted
 * snippet with the matched field. ↑↓ move, ←→ or Tab cycle the tables, Enter opens the record (Esc
 * comes back to the same hit), `o` opens the table's grid filtered to the hits, Space marks hits for
 * `a` (grid, export, print, bulk, processes), `f` narrows to one table, `h` recent searches, `?` the
 * quick search syntax. Without the quick search extension it searches names only.
 */

import { History, lastClockTime, QUICK_SEARCH_SYNTAX, displayDateTime, quickSearchFields, quickSearchFilter, type QueryRecord } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf, isPrintable } from '../keys'
import { LineEditor } from '../line-editor'
import { openApp, openProcess, openRecord, openTable } from '../nav'
import { ChoiceOverlay, EditorLine } from '../overlays/basic'
import { SearchModel, hitKey, type Hit, type HitGroup, type SearchDeps } from '../search-model'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { pad, trunc } from '../util/text'
import { Panel } from './list'

type J = Record<string, unknown>

/** The searches of this profile (`h`), kept with the other local history. */
export function searchHistory(store: AppStore): History {
  return new History(`search-${store.status.profile || store.target?.name || 'default'}`, 200)
}

/** The server calls of the Search screen for a store; `contextTable` is the table it was opened from. */
export function searchDeps(store: AppStore, contextTable?: string): SearchDeps {
  const client = store.client!
  const quick = store.extensions.has('quick-search')
  const history = searchHistory(store)
  return {
    quick,
    searchRecords: (text, tables, limitPerTable) => client.data<J>('searchRecords', { json: { searchTerm: text, ...(tables ? { tableNames: tables } : {}), limitPerTable } }),
    status: () => client.data<J>('getQuickSearchStatus'),
    names: (text) => (store.index?.search(text, { limit: 30, kinds: ['table', 'app', 'process'] }).entries ?? []).map((e) => ({
      table: `:${e.kind}`, tableLabel: e.kind, key: e.name, label: e.label, snippet: e.path.join(' › ') || e.name, highlights: [], target: { kind: e.kind as 'table' | 'app' | 'process', name: e.name },
    })),
    contextRecords: contextTable ? async (text) => {
      const meta = await client.tableMeta(contextTable)
      const fields = quickSearchFields(meta as never).slice(0, 8)
      const filter = quickSearchFilter(text, fields)
      if (!filter) return undefined
      const records: QueryRecord[] = await client.query(contextTable, { ...filter, limit: 25 } as never)
      const needle = text.trim().toLowerCase()
      const hits: Hit[] = records.map((r) => {
        const values = (r.values ?? {}) as J
        const key = String(values[meta.primaryKeyField] ?? '')
        const field = fields.find((f) => String(values[f] ?? '').toLowerCase().includes(needle))
        return { table: contextTable, tableLabel: meta.label, key, label: String(r.recordLabel ?? key), ...(field ? { snippet: `${meta.fields[field]?.label ?? field}: ${String(values[field])}`, field: meta.fields[field]?.label ?? field } : {}), highlights: [] }
      })
      return { table: contextTable, label: `${meta.label} (records of this table)`, total: hits.length, hasMore: hits.length >= 25, hits } as HitGroup
    } : undefined,
    history: { entries: () => history.entries(), add: (t) => history.add(t) },
  }
}

export class SearchScreen implements Screen {
  readonly kind = 'search'
  readonly id = `search:${Date.now()}`
  readonly input: LineEditor
  readonly model: SearchModel
  focus: 'line' | 'results' = 'line'
  top = 0
  private timer?: ReturnType<typeof setTimeout>
  private rows = 10

  constructor(private store: AppStore, initial = '', deps?: SearchDeps) {
    const context = (store.screen as { tableName?: string } | undefined)?.tableName
    this.model = new SearchModel(deps ?? searchDeps(store, context))
    this.input = new LineEditor(initial)
    this.model.text = initial
    void this.model.loadStatus().then(() => store.bump())
    if (initial.trim()) this.schedule(0)
  }

  title(): string {
    return this.model.text.trim() ? `Search: ${this.model.text.trim()}` : 'Search'
  }

  fkeys(): FKeyLabels {
    return { 2: 'Search', 3: 'Open', 4: null, 6: null, 7: null, 8: null }
  }

  capturesText(): boolean {
    return this.focus === 'line'
  }

  /** F2 again: back to the search line. */
  focusLine(): void {
    this.focus = 'line'
  }

  private schedule(ms = 250): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.model.run().finally(() => this.store.bump())
      this.store.bump()
    }, ms)
  }

  refresh(): void {
    void this.model.loadStatus().then(() => this.store.bump())
    this.schedule(0)
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  setText(text: string): void {
    this.input.set(text)
    this.model.text = text
    this.model.cursor = 0
    this.schedule(0)
  }

  onKey(key: Key): boolean {
    const m = this.model
    const ch = charOf(key)
    if (this.focus === 'line') {
      if (key.name === 'escape') return false
      if (key.name === 'return') {
        m.remember()
        this.schedule(0)
        if (m.flat().length || m.text.trim()) this.focus = 'results'
        return true
      }
      if (key.name === 'down' || (key.name === 'tab' && !key.shift)) {
        if (m.flat().length) this.focus = 'results'
        return true
      }
      if (!this.input.value && ch === '?') return this.syntax(), true
      if (this.input.handle(key)) {
        if (this.input.value !== m.text) {
          m.text = this.input.value
          m.cursor = 0
          this.schedule()
        }
        return true
      }
      return false
    }
    switch (key.name) {
      case 'up':
        if (m.cursor === 0) this.focus = 'line'
        else m.move(-1)
        return true
      case 'down': m.move(1); return true
      case 'pagedown': m.move(Math.max(1, this.rows - 2)); return true
      case 'pageup': m.move(-Math.max(1, this.rows - 2)); return true
      case 'home': m.cursor = 0; return true
      case 'end': m.move(m.flat().length); return true
      case 'right': m.cycleGroup(1); return true
      case 'left': m.cycleGroup(-1); return true
      case 'tab': m.cycleGroup(key.shift ? -1 : 1); return true
      case 'return': case 'f3': this.open(); return true
      case 'space': m.toggleMark(); m.move(1); return true
      default: break
    }
    switch (ch) {
      case 'o': this.openGrid(); return true
      case 'f': this.narrow(); return true
      case 'h': this.recent(); return true
      case '?': this.syntax(); return true
      case 'a': this.actions(); return true
      default: break
    }
    // any other text goes back to the search line
    if (isPrintable(key) && ch && ch !== '/' && ch !== ':' && ch !== '.') {
      this.focus = 'line'
      this.input.handle(key)
      m.text = this.input.value
      m.cursor = 0
      this.schedule()
      return true
    }
    return false
  }

  /** Enter: the record (or the table, app or process found by name). Esc on it comes back here. */
  open(): void {
    const c = this.model.current()
    if (!c) return
    this.model.remember()
    const h = c.hit
    if (h.target?.kind === 'table') return openTable(this.store, h.target.name)
    if (h.target?.kind === 'app') return openApp(this.store, h.target.name)
    if (h.target?.kind === 'process') return openProcess(this.store, h.target.name)
    openRecord(this.store, h.table, h.key, { label: h.label })
  }

  /** o: the current table's grid, filtered to the marked hits there (else every hit shown). */
  openGrid(): void {
    const c = this.model.current()
    if (!c || c.hit.target) return this.store.flash('o opens a table of record hits')
    const group = this.model.groups[c.group]!
    this.gridOf(group.table, this.model.keysForGrid(c.group))
  }

  private gridOf(table: string, keys: string[]): void {
    const s = this.store
    this.model.remember()
    s.run(s.client!.tableMeta(table), (meta) => openTable(s, table, { criteria: [{ fieldName: meta.primaryKeyField, operator: 'IN', values: keys }], booleanOperator: 'AND' }))
  }

  /** a: what to do with the marked hits, per table: the grid (print, export, bulk there), a process. */
  actions(): void {
    const s = this.store
    const byTable = this.model.markedByTable()
    if (!byTable.size) return s.flash('Space marks hits; a then offers the grid (export, print, bulk) and processes for them')
    const label = (t: string) => this.model.groups.find((g) => g.table === t)?.label ?? s.meta?.tables?.[t]?.label ?? t
    type A = { run: () => void }
    const choices: Array<{ label: string; value: A; detail?: string }> = []
    for (const [table, keys] of byTable) {
      choices.push({ label: `Open the ${keys.length} marked ${label(table)} in a grid`, value: { run: () => this.gridOf(table, keys) }, detail: 'export x, print, bulk a from there' })
      for (const p of Object.values(s.meta?.processes ?? {}).filter((p) => p.tableName === table && (p as { hasPermission?: boolean }).hasPermission !== false).slice(0, 12)) {
        choices.push({ label: `Run ${p.label} on the ${keys.length} marked`, value: { run: () => openProcess(s, p.name, { recordIds: keys }) } })
      }
    }
    choices.push({ label: 'Clear the marks', value: { run: () => this.model.marked.clear() } })
    s.open(new ChoiceOverlay(s, `${this.model.marked.size} marked`, choices, (a) => a.run()))
  }

  /** f: search one table (or every table again). */
  narrow(): void {
    const s = this.store
    const m = this.model
    const tables = m.deps.quick ? (m.status?.tables.length ? m.status.tables : m.groups.map((g) => g.table)) : m.groups.map((g) => g.table)
    const label = (t: string) => m.groups.find((g) => g.table === t)?.label ?? s.meta?.tables?.[t]?.label ?? t
    s.open(new ChoiceOverlay<string>(s, 'Search in', [{ label: 'Every table', value: '' }, ...tables.map((t) => ({ label: label(t), value: t, detail: t === m.table ? 'current' : undefined }))], (t) => {
      m.table = t || undefined
      m.cursor = 0
      this.schedule(0)
    }))
  }

  /** h: the recent searches of this profile. */
  recent(): void {
    const list = this.model.recent()
    if (!list.length) return this.store.flash('no recent searches yet')
    this.store.open(new ChoiceOverlay(this.store, 'Recent searches', list.map((t) => ({ label: t, value: t })), (t) => {
      this.setText(t)
      this.focus = 'line'
    }))
  }

  /** ?: what the quick search query language is (only what it supports). */
  syntax(): void {
    const lines = this.model.deps.quick
      ? [...QUICK_SEARCH_SYNTAX, '', 'Here: f narrows to one table; o opens the table with the hits, where F6 filters on fields.']
      : ['Quick search is not installed on this server, so Search finds tables, apps and processes by name,', 'and the records of the table you came from whose text fields contain what you typed.']
    this.store.message(lines.join('\n'), 'info', 'Quick search syntax')
  }

  menu(): MenuEntry[] {
    return [
      { section: 'Context', label: 'Open the hit', key: 'Enter', run: () => this.open() },
      { section: 'Context', label: 'Open the table with these hits', key: 'o', run: () => this.openGrid() },
      { section: 'Context', label: 'Mark the hit', key: 'Space', run: () => this.model.toggleMark() },
      { section: 'Context', label: 'Actions for the marked hits', key: 'a', run: () => this.actions() },
      { section: 'Context', label: 'Search one table', key: 'f', run: () => this.narrow() },
      { section: 'Context', label: 'Recent searches', key: 'h', run: () => this.recent() },
      { section: 'Context', label: 'Quick search syntax', key: '?', run: () => this.syntax() },
      { section: 'Context', label: 'Next / previous table', key: '← → Tab', run: () => this.model.cycleGroup(1) },
    ]
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const g = glyphs()
    const m = this.model
    const inner = width - 2
    const lines: Array<{ text: string; fg?: string; bg?: string; bold?: boolean }> = []
    const scope = m.table ? ` in ${m.groups.find((x) => x.table === m.table)?.label ?? this.store.meta?.tables?.[m.table]?.label ?? m.table} (f: every table)` : ''
    const info = m.error ? { text: ` ${m.error}`, fg: t.err } : m.notes.length ? { text: ` ${m.notes.join(' · ')}`, fg: t.warn } : { text: ` ${m.searching ? 'searching…' : scope ? scope.trim() : m.text.trim() && !m.flat().length ? 'no records match' : ''}`, fg: t.dim }
    const flat = m.flat()
    let selRow = -1
    let index = 0
    m.groups.forEach((grp) => {
      const count = grp.total > grp.hits.length ? `${grp.hits.length} of ${grp.total.toLocaleString('en-US')} matches` : `${grp.total} match${grp.total === 1 ? '' : 'es'}`
      lines.push({ text: ` ${grp.label} · ${count}`, fg: t.acc, bold: true })
      for (const h of grp.hits) {
        const sel = index === m.cursor
        if (sel) selRow = lines.length
        const mark = h.target ? '   ' : m.marked.has(hitKey(h)) ? `${g.mark}  ` : '   '
        const key = h.target ? '' : `#${h.key}`
        const labelWidth = Math.max(12, Math.min(36, Math.floor(inner * 0.35)))
        const keyWidth = Math.min(10, Math.max(4, key.length + 1))
        const text = `  ${mark}${pad(trunc(h.label, labelWidth), labelWidth)} ${pad(key, keyWidth)} ${h.snippet ?? ''}`
        lines.push({ text: trunc(text, inner), fg: sel && focused && this.focus === 'results' ? t.selFg : t.fg, bg: sel && this.focus === 'results' ? (focused ? t.selBg : t.selInactiveBg) : undefined })
        index++
      }
    })
    if (!flat.length && !m.text.trim()) {
      lines.push({ text: ' Type to search. Enter or ↓ goes to the results; ? syntax · h recent searches · f one table', fg: t.dim })
      const recent = m.recent(8)
      if (recent.length) lines.push({ text: ` Recent: ${recent.join(' · ')}`, fg: t.dim })
    }
    const body = Math.max(3, height - 6)
    this.rows = body
    if (selRow >= 0) {
      if (selRow < this.top + 1) this.top = Math.max(0, selRow - 1)
      if (selRow >= this.top + body) this.top = selRow - body + 1
    } else this.top = 0
    this.top = Math.max(0, Math.min(this.top, Math.max(0, lines.length - body)))
    const shown = lines.slice(this.top, this.top + body)
    while (shown.length < body) shown.push({ text: '' })
    const status = m.statusLine((iso) => { const shown = displayDateTime(iso); return lastClockTime(shown) ?? shown })
    const keys = this.focus === 'line' ? 'type · Enter/↓ results · h recent · ? syntax · Esc back' : '↑↓ move · ←→ Tab tables · Enter open · o grid · Space mark · a actions · f table · h recent · ? syntax'
    return (
      <Panel title={this.title()} width={width} height={height} focused={focused}>
        <box flexDirection="row">
          <text flexShrink={0} wrapMode="none" fg={t.acc2}>{' Search ▸ '}</text>
          <EditorLine editor={this.input} width={inner - 10} focused={focused && this.focus === 'line'} placeholder={m.placeholder()} />
        </box>
        <text flexShrink={0} wrapMode="none" fg={info.fg}>{pad(trunc(info.text, inner), inner)}</text>
        {shown.map((l, i) => <text flexShrink={0} wrapMode="none" key={i} fg={l.fg ?? t.fg} bg={l.bg}>{l.bold ? <strong>{pad(l.text, inner)}</strong> : pad(l.text, inner)}</text>)}
        <text flexShrink={0} wrapMode="none" fg={m.deps.quick ? t.acc2 : t.warn}>{pad(trunc(` ${status}`, inner), inner)}</text>
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(trunc(` ${keys}`, inner), inner)}</text>
      </Panel>
    )
  }
}

