/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { writeFileSync } from 'node:fs'
import { ResultCursor, buildViewJson, columnStatsAvailability, combineWithQuickSearch, deleteSavedView, exposedJoins, findRecordByKey, gotoKeys, listSavedViews, listTableVariants, printFilter, quickSearchFields, quickSearchFilter, runColumnStats, savedViewProcesses, storeSavedView, usesVariants, variantLabel, variantParam, viewToQuery, type TableVariant, readViewSettings, type QueryFilter, type QueryRecord, type ViewSettings } from '@qrun-io/qqq-core'
import type { FieldMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openForm, openProcess, openRecord } from '../nav'
import { ChoiceOverlay, PromptOverlay } from '../overlays/basic'
import { FilterOverlay } from '../overlays/filter'
import { saveFile } from '../overlays/files-helpers'
import { actionsOverlay } from '../overlays/actions'
import { TableApisScreen } from './developer'
import { GridViewSettingsOverlay } from '../overlays/view-settings'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { errorText, fieldCell, num, pad, padLeft, shellQuote, trunc } from '../util/text'
import { Panel } from './list'

export interface GridColumn {
  name: string
  label: string
  type: string
  width: number
  numeric: boolean
}

/** The default column order: primary key, then section fields by tier, then the rest (hidden and heavy left out). */
export function defaultColumns(meta: TableMetaData): string[] {
  const order: string[] = [meta.primaryKeyField]
  for (const tier of ['T1', 'T2', 'T3']) {
    for (const s of (meta.sections ?? []).filter((x) => x.tier === tier && !x.hidden)) {
      for (const f of s.fieldNames ?? []) if (!order.includes(f) && meta.fields[f] && !meta.fields[f]!.isHidden) order.push(f)
    }
  }
  for (const [name, f] of Object.entries(meta.fields)) if (!order.includes(name) && !f.isHidden && !f.isHeavy) order.push(name)
  return order.filter((n) => meta.fields[n])
}

/**
 * Column widths that use the available width: each column starts at the longest of its header and
 * the visible values (capped at 40, or its saved width), truncated columns then get the spare width,
 * and with "fill" what remains is spread over every column. Only when the natural widths do not fit
 * does the grid scroll horizontally.
 */
export function layoutColumns(fields: FieldMetaData[], rows: QueryRecord[], available: number, view: ViewSettings): GridColumn[] {
  const gap = 1
  const cols = fields.map((f) => {
    const numeric = ['INTEGER', 'LONG', 'DECIMAL'].includes(f.type) && !f.possibleValueSourceName
    const longest = Math.max(f.label.length + 1, ...rows.map((r) => fieldCell(r, f).length), 3)
    const saved = view.widths?.[f.name]
    return { name: f.name, label: f.label, type: f.type, numeric, longest, width: saved ?? Math.min(40, longest) }
  })
  const total = () => cols.reduce((a, c) => a + c.width + gap, 0)
  let spare = available - total()
  if (spare > 0) {
    // first give truncated columns what they need, the shortest need first
    for (const c of [...cols].filter((x) => !view.widths?.[x.name] && x.longest > x.width).sort((a, b) => (a.longest - a.width) - (b.longest - b.width))) {
      const add = Math.min(spare, c.longest - c.width)
      c.width += add
      spare -= add
    }
    // room for longer values on later pages: text columns grow toward 40 cells from what is left
    // (the layout is frozen for the life of the grid, so this is decided once)
    const growable = cols.filter((c) => !view.widths?.[c.name] && !c.numeric && ['STRING', 'TEXT', 'HTML'].includes(c.type) && c.width < 40)
    while (spare > 0 && view.fit !== 'fill' && growable.some((c) => c.width < 40)) {
      for (const c of growable) {
        if (spare <= 0) break
        if (c.width < 40) {
          c.width++
          spare--
        }
      }
    }
    if (spare > 0 && view.fit === 'fill' && cols.length) {
      const each = Math.floor(spare / cols.length)
      cols.forEach((c, i) => { c.width += each + (i < spare - each * cols.length ? 1 : 0) })
    }
  }
  return cols.map(({ longest: _l, ...c }) => c)
}

/** The columns from `left` that fit in a width (at least one). */
export function visibleFrom(cols: GridColumn[], left: number, width: number): GridColumn[] {
  const out: GridColumn[] = []
  let used = 0
  for (let i = left; i < cols.length; i++) {
    if (used + cols[i]!.width + 1 > width && out.length) break
    out.push(cols[i]!)
    used += cols[i]!.width + 1
  }
  return out
}

/** A table query screen: a server-paged grid over a ResultCursor, with filter, sort, selection and export. */
export class TableScreen implements Screen {
  readonly kind = 'table'
  readonly id: string
  meta?: TableMetaData
  cursor?: ResultCursor
  filter: QueryFilter
  sort?: { field: string; asc: boolean }
  colCursor = 0
  leftCol = 0
  selection = new Set<string>()
  rows: QueryRecord[] = []
  rowsPage = -1
  loading = false
  error?: string
  fetchMs?: number
  pageSize = 20
  view: ViewSettings = {}
  private generation = 0
  /** Quick search text (CONTAINS on the visible string columns, ANDed onto the filter). */
  quick = ''
  /** The table variant, for tables that need one. */
  variant?: TableVariant
  /** The column layout, frozen while paging, sorting, filtering and stepping. */
  private frozen?: { key: string; fromEmpty: boolean; cols: GridColumn[] }

  constructor(private store: AppStore, readonly tableName: string, filter?: QueryFilter, options: { index?: number } = {}) {
    this.id = `table:${tableName}:${Date.now()}`
    this.filter = { criteria: [], booleanOperator: 'AND', ...(filter ?? {}) }
    if (this.filter.orderBys?.[0]) this.sort = { field: this.filter.orderBys[0].fieldName, asc: this.filter.orderBys[0].isAscending }
    delete this.filter.orderBys
    this.view = readViewSettings(`table:${tableName}`)
    const savedSort = this.view.sort as { field: string; asc: boolean } | undefined
    if (!this.sort && savedSort) this.sort = savedSort
    store.run(store.client!.tableMeta(tableName), (meta) => {
      this.meta = meta
      if (usesVariants(meta as never)) return this.chooseVariant(options.index ?? 0)
      this.newCursor(options.index ?? 0)
      this.store.remember({ kind: 'table', table: tableName, label: meta.label })
    })
  }

  title(): string {
    return this.meta?.label ?? this.tableName
  }

  presenceScope(): string {
    return `table:${this.tableName}`
  }

  helpTopic() {
    return { kind: 'table' as const, name: this.tableName }
  }

  /** The query as the CLI says it. */
  cliEquivalent(): string {
    const parts = ['table', 'query', this.tableName]
    const text = printFilter(this.filter)
    if (text) parts.push('-g', shellQuote(text))
    if (this.sort) parts.push('-o', (this.sort.asc ? '' : '-') + this.sort.field)
    return parts.join(' ')
  }

  fullFilter(): QueryFilter {
    const quick = this.meta && this.quick.trim() ? quickSearchFilter(this.quick, quickSearchFields(this.meta as never, this.fields().map((f) => f.name))) : undefined
    const base = combineWithQuickSearch({ ...this.filter }, quick)
    return { ...base, ...(this.sort ? { orderBys: [{ fieldName: this.sort.field, isAscending: this.sort.asc }] } : {}) }
  }

  quickSearch(): void {
    this.store.open(new PromptOverlay(this.store, `Quick search ${this.title()}`, 'Text matched (contains) in the visible text columns, together with the filter; empty clears.', (text) => {
      this.quick = text.trim()
      this.newCursor(0)
    }, this.quick))
  }

  columnStats(): void {
    const meta = this.meta
    const field = this.fields()[this.colCursor]
    if (!meta || !field) return
    const avail = columnStatsAvailability(meta as never, this.store.meta as never)
    if (!avail.available) return this.store.message(avail.reason ?? 'Column statistics are not available for this table.', 'info', 'Column statistics')
    const c = this.store.client!
    this.store.run(runColumnStats(c.server, c.fetch, { table: this.tableName, field: field.name, filter: this.fullFilter(), tableVariant: this.variant }), (stats) => {
      const lines = [...stats.fields.map((f) => `${f.label}: ${String(stats.stats.displayValues[f.name] ?? stats.stats.values[f.name] ?? '')}`), '', 'Most common values:', ...stats.valueCounts.slice(0, 15).map((v) => `  ${String(v.displayValues[field.name] ?? v.values[field.name] ?? '(empty)')}  ×${String(v.values.count ?? '')}`)]
      this.store.message(lines.join('\n'), 'info', `Column statistics · ${field.label}`)
    })
  }

  savedViews(): void {
    const meta = this.meta
    if (!meta) return
    const c = this.store.client!
    const procs = savedViewProcesses(meta as never, this.store.meta as never)
    if (!procs.query) return this.store.message('Saved views are not available for this table.', 'info', 'Saved views')
    this.store.run(listSavedViews(c.server, c.fetch, procs, this.tableName), (views) => {
      type Pick = { kind: 'open' | 'delete'; v: (typeof views)[number] } | { kind: 'save' }
      const choices: Array<{ label: string; value: Pick; detail?: string }> = [
        ...views.map((v) => ({ label: v.label, value: { kind: 'open' as const, v }, detail: v.type ?? '' })),
        ...(procs.store ? [{ label: '+ Save the current query as a view…', value: { kind: 'save' as const } }] : []),
        ...(procs.delete ? views.map((v) => ({ label: `Delete "${v.label}"`, value: { kind: 'delete' as const, v } })) : []),
      ]
      this.store.open(new ChoiceOverlay<Pick>(this.store, `Saved views · ${this.title()}`, choices, (choice) => {
        if (choice.kind === 'open') {
          const q = viewToQuery(meta as never, exposedJoins(meta as never), choice.v.view)
          this.view = { ...this.view, columns: q.columns.filter((n) => meta.fields[n]) }
          this.setFilter(q.filter)
          this.store.flash(`view ${choice.v.label}${q.warnings.length ? ` (${q.warnings.join('; ')})` : ''}`)
        } else if (choice.kind === 'save') {
          this.store.open(new PromptOverlay(this.store, 'Save view as', 'A name for this filter, sort and these columns.', (label) => {
            if (!label.trim()) return
            this.store.run(storeSavedView(c.server, c.fetch, procs, { table: this.tableName, label: label.trim(), view: buildViewJson({ filter: this.fullFilter(), columns: this.fields().map((f) => f.name), allColumns: Object.keys(meta.fields), rowsPerPage: this.pageSize }) }), (v) => this.store.flash(`saved view ${v.label}`))
          }))
        } else if (choice.kind === 'delete') {
          const v = choice.v
          this.store.confirm(`Delete the saved view "${v.label}"?`, () => this.store.run(deleteSavedView(c.server, c.fetch, procs, v.id), () => this.store.flash(`deleted view ${v.label}`)))
        }
      }))
    })
  }

  /** Tables with variants ask for one first; dismissing the prompt queries nothing. */
  chooseVariant(index = 0): void {
    const c = this.store.client!
    this.store.run(listTableVariants(c.server, c.fetch, this.tableName), (variants) => {
      this.store.open(new ChoiceOverlay(this.store, `${variantLabel(this.meta as never)} for ${this.title()}`, variants.map((v) => ({ label: v.name ?? v.id, value: v, detail: `${v.type} ${v.id}` })), (v) => {
        this.variant = v
        this.newCursor(index)
      }, 'required before querying', 0, () => { this.error = `choose a ${variantLabel(this.meta as never)} to query (F5)` }))
    })
  }

  newCursor(index = 0): void {
    if (!this.meta) return
    if (usesVariants(this.meta as never) && !this.variant) return
    this.cursor = new ResultCursor({ baseUrl: this.store.client!.server, fetch: this.store.client!.fetch, table: this.tableName, filter: this.fullFilter(), pageSize: this.pageSize, primaryKeyField: this.meta.primaryKeyField, index, query: this.variant ? { tableVariant: variantParam(this.variant) } : undefined })
    this.rowsPage = -1
    this.load()
  }

  /** Loads the page holding the cursor's index (ignores stale answers). */
  load(refresh = false): void {
    const cursor = this.cursor
    if (!cursor) return
    const page = cursor.pageOf(cursor.index)
    const gen = ++this.generation
    this.loading = true
    const started = performance.now()
    cursor.page(page, { refresh }).then((records) => {
      if (gen !== this.generation) return
      this.rows = records
      this.rowsPage = page
      this.loading = false
      this.error = undefined
      this.fetchMs = performance.now() - started
      if (cursor.total !== undefined && cursor.index >= cursor.total) cursor.index = Math.max(0, cursor.total - 1)
      this.store.bump()
    }).catch((e) => {
      if (gen !== this.generation) return
      this.loading = false
      this.error = errorText(e)
      this.store.bump()
    })
  }

  get rowIndex(): number {
    return this.cursor ? this.cursor.index - this.rowsPage * this.cursor.pageSize : 0
  }

  get currentRecord(): QueryRecord | undefined {
    return this.rows[this.rowIndex]
  }

  keyOf(record: QueryRecord | undefined): string | undefined {
    const v = record?.values?.[this.meta?.primaryKeyField ?? 'id']
    return v === undefined || v === null ? undefined : String(v)
  }

  fields(): FieldMetaData[] {
    if (!this.meta) return []
    const names = (this.view.columns?.length ? this.view.columns : defaultColumns(this.meta)).filter((n) => this.meta!.fields[n])
    return names.map((n) => this.meta!.fields[n]!)
  }

  moveTo(index: number): void {
    const c = this.cursor
    if (!c) return
    const max = Math.max(0, (c.total ?? 1) - 1)
    c.index = Math.max(0, Math.min(max, index))
    if (c.pageOf(c.index) !== this.rowsPage) this.load()
  }

  resume(): void {
    // back from a record or form: the cursor may have moved (next/previous) or records changed
    this.view = readViewSettings(`table:${this.tableName}`)
    this.cursor?.invalidate()
    this.load(true)
  }

  refresh(): void {
    if (this.meta && usesVariants(this.meta as never) && !this.variant) return this.chooseVariant(0)
    this.cursor?.invalidate()
    this.load(true)
  }

  setFilter(filter: QueryFilter, sort?: { field: string; asc: boolean } | null): void {
    this.filter = { criteria: filter.criteria, booleanOperator: filter.booleanOperator, ...(filter.subFilters?.length ? { subFilters: filter.subFilters } : {}) }
    if (sort !== undefined) this.sort = sort ?? undefined
    else if (filter.orderBys?.[0]) this.sort = { field: filter.orderBys[0].fieldName, asc: filter.orderBys[0].isAscending }
    this.selection.clear()
    this.newCursor(0)
  }

  openCurrent(): void {
    const rec = this.currentRecord
    const key = this.keyOf(rec)
    if (key === undefined || !this.cursor) return this.store.flash('no record under the cursor')
    openRecord(this.store, this.tableName, key, { cursor: this.cursor, label: rec?.recordLabel })
  }

  deleteCurrent(): void {
    const rec = this.currentRecord
    const key = this.keyOf(rec)
    if (key === undefined) return this.store.flash('no record under the cursor')
    if (this.meta?.deletePermission === false) return this.store.flash('you may not delete records of this table', 'error')
    this.store.confirm(`Delete ${this.title()} ${key}${rec?.recordLabel ? ` "${rec.recordLabel}"` : ''}?`, () => {
      this.store.run(this.store.client!.remove(this.tableName, key), () => {
        this.cursor?.removed(this.cursor.index)
        this.selection.delete(key)
        this.load(true)
        this.store.flash(`deleted ${this.title()} ${key}`)
      })
    })
  }

  /** Table processes for the bulk bar and the menu (bulk-load file processes are parked). */
  tableProcesses(): Array<{ name: string; label: string; parked?: string }> {
    const procs = Object.values(this.store.meta?.processes ?? {}).filter((p) => p.tableName === this.tableName)
    return procs.map((p) => ({ name: p.name, label: p.label, parked: /bulkInsert|bulkEditWithFile|bulkLoad/i.test(p.name) ? 'parked: bulk load needs file uploads' : undefined }))
      .sort((a, b) => Number(Boolean(a.parked)) - Number(Boolean(b.parked)) || a.label.localeCompare(b.label))
  }

  runProcess(name: string): void {
    const ids = [...this.selection]
    const tableVariant = variantParam(this.variant)
    if (ids.length) openProcess(this.store, name, { recordIds: ids, tableVariant })
    else {
      const key = this.keyOf(this.currentRecord)
      openProcess(this.store, name, key !== undefined ? { recordIds: [key], tableVariant } : { filter: this.fullFilter(), tableVariant })
    }
  }

  bulkActions(): void {
    const procs = this.tableProcesses()
    if (!procs.length) return this.store.flash('this table has no processes')
    const what = this.selection.size ? `${this.selection.size} selected` : 'the record under the cursor'
    this.store.open(new ChoiceOverlay(this.store, `Run on ${what}`, procs.map((p) => ({ label: p.label, value: p.name, detail: p.name, disabled: p.parked })), (name) => this.runProcess(name)))
  }

  exportDialog(): void {
    const formats = ['csv', 'xlsx', 'json', 'tsv']
    this.store.open(new ChoiceOverlay(this.store, 'Export to a file', formats.map((f) => ({ label: f, value: f, detail: f === 'xlsx' ? 'Excel' : undefined })), (format) => this.exportAs(format)))
  }

  /** Go to a record by its primary key or a configured unique key (kernel gotoKeys / findRecordByKey). */
  gotoKey(): void {
    const meta = this.meta
    if (!meta) return
    const keys = gotoKeys(meta as never)
    const ask = (key: string[]) => {
      const labels = key.map((n) => meta.fields[n]?.label ?? n)
      this.store.open(new PromptOverlay(this.store, `Go to ${this.title()} by ${labels.join(' + ')}`, key.length > 1 ? `Values for ${labels.join(', ')}, separated by commas.` : 'Opens the record with this value.', (text) => {
        const parts = key.length > 1 ? text.split(',').map((x) => x.trim()) : [text.trim()]
        if (!parts.some(Boolean)) return
        const values = Object.fromEntries(key.map((n, i) => [n, parts[i] ?? '']))
        if (key.length === 1 && key[0] === meta.primaryKeyField) return openRecord(this.store, this.tableName, parts[0])
        this.store.run(findRecordByKey(this.store.client!.server, this.store.client!.fetch, meta as never, values), (r) => {
          if (r.found === 'one') openRecord(this.store, this.tableName, r.primaryKey)
          else this.store.flash(r.found === 'none' ? 'no record has that key' : 'more than one record has that key', 'error')
        })
      }))
    }
    if (keys.length === 1) return ask(keys[0]!)
    this.store.open(new ChoiceOverlay(this.store, 'Go to by which key?', keys.map((k) => ({ label: k.map((n) => meta.fields[n]?.label ?? n).join(' + '), value: k })), ask))
  }

  filterDialog(): void {
    if (!this.meta) return
    this.store.open(new FilterOverlay(this.store, this.meta, this.filter, this.sort, (filter, sort) => this.setFilter(filter, sort)))
  }

  viewSettings(): Overlay | undefined {
    if (!this.meta) return undefined
    return new GridViewSettingsOverlay(this.store, this.meta, `table:${this.tableName}`, this.fields().map((f) => f.name), () => {
      this.view = readViewSettings(`table:${this.tableName}`)
      const sort = this.view.sort as { field: string; asc: boolean } | undefined
      if (JSON.stringify(sort) !== JSON.stringify(this.sort)) {
        this.sort = sort
        this.newCursor(0)
      }
      this.store.bump()
    })
  }

  fkeys(): FKeyLabels {
    const m = this.meta
    return { 3: 'View', 4: m?.editPermission === false ? null : 'Edit', 6: 'Filter', 7: m?.insertPermission === false ? null : 'New', 8: m?.deletePermission === false ? null : 'Delete' }
  }

  onKey(key: Key): boolean {
    const c = this.cursor
    if (!this.meta || !c) return key.name !== 'escape' && key.name !== 'tab' && !key.name.startsWith('f')
    const ch = charOf(key)
    const single = this.store.singleKeys
    switch (key.name) {
      case 'down': this.moveTo(c.index + 1); return true
      case 'up': this.moveTo(c.index - 1); return true
      case 'pagedown': this.moveTo(this.rowIndex === this.rows.length - 1 || this.rows.length < c.pageSize ? c.index + c.pageSize : (this.rowsPage + 1) * c.pageSize - 1); return true
      case 'pageup': this.moveTo(this.rowIndex === 0 ? c.index - c.pageSize : this.rowsPage * c.pageSize); return true
      case 'home': this.moveTo(0); return true
      case 'end': this.moveTo((c.total ?? 1) - 1); return true
      case 'right': this.colCursor = Math.min(this.fields().length - 1, this.colCursor + 1); return true
      case 'left': this.colCursor = Math.max(0, this.colCursor - 1); return true
      case 'return': case 'f3': this.openCurrent(); return true
      case 'f4': {
        const key2 = this.keyOf(this.currentRecord)
        if (key2 !== undefined) openForm(this.store, this.tableName, { mode: 'edit', primaryKey: key2, cursor: c })
        return true
      }
      case 'f6': this.filterDialog(); return true
      case 'f7': openForm(this.store, this.tableName, { mode: 'create' }); return true
      case 'f8': this.deleteCurrent(); return true
      case 'space': {
        const k = this.keyOf(this.currentRecord)
        if (k !== undefined) {
          if (this.selection.has(k)) this.selection.delete(k)
          else this.selection.add(k)
          this.moveTo(c.index + 1)
        }
        return true
      }
      case 'escape':
        if (this.selection.size) {
          this.selection.clear()
          return true
        }
        if (this.quick) {
          this.quick = ''
          this.newCursor(0)
          return true
        }
        return false
      default: break
    }
    if (key.ctrl && key.name === 'a') {
      for (const r of this.rows) { const k = this.keyOf(r); if (k !== undefined) this.selection.add(k) }
      return true
    }
    if (!single) return false
    switch (ch) {
      case 's': {
        const field = this.fields()[this.colCursor]?.name
        if (!field) return true
        this.sort = !this.sort || this.sort.field !== field ? { field, asc: true } : this.sort.asc ? { field, asc: false } : undefined
        this.newCursor(0)
        return true
      }
      case 'f': this.filterDialog(); return true
      case 'n': openForm(this.store, this.tableName, { mode: 'create' }); return true
      case 'r': this.refresh(); return true
      case 'g': this.gotoKey(); return true
      case 'x': this.exportDialog(); return true
      case 'b': this.bulkActions(); return true
      case 'a': actionsOverlay(this.store, this); return true
      case 'q': this.quickSearch(); return true
      case 'S': this.columnStats(); return true
      case 'D': this.store.push(new TableApisScreen(this.store, this.tableName)); return true
      default: return false
    }
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = [
      { section: 'Context', label: 'View the record under the cursor', key: 'F3 Enter', run: () => this.openCurrent() },
      { section: 'Context', label: 'Edit the record under the cursor', key: 'F4', run: () => this.onKey({ name: 'f4', sequence: '' }) },
      { section: 'Context', label: `New ${this.title()}`, key: 'F7 n', run: () => openForm(this.store, this.tableName, { mode: 'create' }) },
      { section: 'Context', label: 'Delete the record under the cursor', key: 'F8', run: () => this.deleteCurrent() },
      { section: 'Context', label: 'Filter and sort', key: 'F6 f', command: 'filter', run: () => this.filterDialog() },
      { section: 'Context', label: 'Clear the filter', command: 'filter clear', run: () => this.setFilter({ criteria: [], booleanOperator: 'AND' }) },
      { section: 'Context', label: 'Go to a record by key', key: 'g', run: () => this.gotoKey() },
      { section: 'Context', label: 'Refresh', key: 'F5 r', run: () => this.refresh() },
      { section: 'Context', label: 'View settings (columns, widths, stripes, density)', key: 'v', command: 'view', run: () => { const o = this.viewSettings(); if (o) this.store.open(o) } },
      { section: 'Context', label: 'Copy as a CLI command', detail: this.cliEquivalent(), run: () => this.store.message(`qqq ${this.cliEquivalent()}`, 'info', 'CLI equivalent') },
    ]
    for (const f of ['csv', 'xlsx', 'json', 'tsv']) out.push({ section: 'Context', label: `Export as ${f}`, key: f === 'csv' ? 'x' : undefined, command: `export ${f}`, run: () => this.exportAs(f) })
    for (const p of this.tableProcesses()) out.push({ section: 'Context', label: `Run ${p.label}`, detail: this.selection.size ? `${this.selection.size} selected` : 'cursor record', disabled: p.parked, run: () => this.runProcess(p.name) })
    out.push({ section: 'Context', label: 'Developer: application APIs of this table', key: 'D', command: 'dev', run: () => this.store.push(new TableApisScreen(this.store, this.tableName)) })
    out.push({ section: 'Context', label: 'Saved views: open, save, delete', command: 'views', run: () => this.savedViews() })
    out.push({ section: 'Context', label: `Column statistics: ${this.fields()[this.colCursor]?.label ?? ''}`, key: 'S', run: () => this.columnStats() })
    out.push({ section: 'Context', label: 'Quick search', key: 'q', detail: this.quick || undefined, run: () => this.quickSearch() })
    if (this.meta && usesVariants(this.meta as never)) out.push({ section: 'Context', label: `Change ${variantLabel(this.meta as never)}`, detail: this.variant?.name ?? this.variant?.id, run: () => this.chooseVariant(0) })
    return out
  }

  /** Exports with the current filter, sort and visible columns, to a file chosen in the file dialog (or silently to the download directory). */
  exportAs(format: string): void {
    const write = (out: string) => {
      this.store.run(this.store.client!.export(this.tableName, format, this.fullFilter(), this.fields().map((f) => f.name)), ({ bytes }) => {
        writeFileSync(out, bytes)
        this.store.message(`Wrote ${out} (${num(bytes.length)} bytes).`)
      })
    }
    saveFile(this.store, `Export ${this.title()} as ${format}`, `${this.tableName}.${format}`, write)
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const g = glyphs()
    const inner = width - 2
    const comfortable = this.view.density === 'comfortable'
    const headerRule = this.view.headerRule ?? true
    const chrome = 1 + (headerRule ? 1 : 0) + 2 + (this.selection.size ? 1 : 0)
    const bodyLines = Math.max(1, height - 2 - chrome)
    const pageSize = Math.max(1, comfortable ? Math.ceil(bodyLines / 2) : bodyLines)
    if (this.cursor && pageSize !== this.cursor.pageSize) {
      const index = this.cursor.index
      this.pageSize = pageSize
      this.cursor.pageSize = pageSize
      this.cursor.invalidate()
      this.cursor.index = index
      this.rowsPage = -1
      queueMicrotask(() => this.load())
    }
    const fields = this.fields()
    // column widths are fixed for the life of the grid: computed once from the metadata, the saved view
    // and the first page, and again only when the width or the view settings change (never per page)
    const viewKey = `${inner}|${JSON.stringify(this.view)}|${fields.map((f) => f.name).join(',')}`
    if (!this.frozen || this.frozen.key !== viewKey || (this.frozen.fromEmpty && this.rows.length)) {
      this.frozen = { key: viewKey, fromEmpty: this.rows.length === 0, cols: layoutColumns(fields, this.rows, inner - 2, this.view) }
    }
    const cols = this.frozen.cols
    this.colCursor = Math.min(this.colCursor, Math.max(0, cols.length - 1))
    if (this.colCursor < this.leftCol) this.leftCol = this.colCursor
    while (this.leftCol < this.colCursor && !visibleFrom(cols, this.leftCol, inner - 2).some((c) => c.name === cols[this.colCursor]!.name)) this.leftCol++
    const shown = visibleFrom(cols, this.leftCol, inner - 2).map((c) => ({ ...c }))
    if (this.view.fit === 'fill' && shown.length) {
      // fill: spread what is left of the width over the visible columns
      const spare = inner - 2 - shown.reduce((a, c) => a + c.width + 1, 0)
      if (spare > 0) shown.forEach((c, i) => { c.width += Math.floor(spare / shown.length) + (i < spare % shown.length ? 1 : 0) })
    }
    const zebra = this.view.zebra ?? t.zebraByDefault
    const header = '  ' + shown.map((c) => {
      const mark = this.sort?.field === c.name ? (this.sort.asc ? g.up : g.down) : ''
      const label = trunc(c.label, c.width - mark.length) + mark
      return c.numeric ? padLeft(label, c.width) : pad(label, c.width)
    }).join(' ')
    const lines: React.ReactNode[] = []
    lines.push(
      <text flexShrink={0} wrapMode="none" key="h">
        {shown.map((c, i) => {
          const hot = cols.findIndex((x) => x.name === c.name) === this.colCursor
          const mark = this.sort?.field === c.name ? (this.sort.asc ? g.up : g.down) : ''
          const label = trunc(c.label, c.width - mark.length) + mark
          return <span key={c.name} fg={hot && focused ? t.acc2 : t.acc}>{(i === 0 ? '  ' : ' ') + (c.numeric ? padLeft(label, c.width) : pad(label, c.width))}</span>
        })}
        <span>{' '.repeat(Math.max(0, inner - header.length))}</span>
      </text>,
    )
    if (headerRule) lines.push(<text flexShrink={0} wrapMode="none" key="r" fg={t.border}>{pad(g.rule.repeat(Math.min(inner, header.length)), inner)}</text>)
    const pk = this.meta?.primaryKeyField ?? 'id'
    this.rows.forEach((r, i) => {
      const sel = i === this.rowIndex
      const key = String(r.values?.[pk] ?? '')
      const marked = this.selection.has(key)
      const text = (marked ? g.mark + ' ' : '  ') + shown.map((c) => (c.numeric ? padLeft(fieldCell(r, c), c.width) : pad(fieldCell(r, c), c.width))).join(' ')
      const bg = sel ? (focused ? t.selBg : t.selInactiveBg) : zebra && i % 2 === 1 ? t.zebraBg : undefined
      lines.push(<text flexShrink={0} wrapMode="none" key={`r${i}`} fg={sel ? (focused ? t.selFg : t.fg) : marked ? t.markFg : t.fg} bg={bg}>{pad(text, inner)}</text>)
      if (comfortable) lines.push(<text flexShrink={0} wrapMode="none" key={`s${i}`}>{pad('', inner)}</text>)
    })
    const used = lines.length - 1 - (headerRule ? 1 : 0)
    for (let i = used; i < bodyLines; i++) {
      lines.push(<text flexShrink={0} wrapMode="none" key={`e${i}`} fg={this.error ? t.err : t.dim}>{pad(i === 0 && !this.rows.length ? (this.error ? ` ${this.error}` : this.loading || !this.meta ? ' loading…' : ' (no records match)') : '', inner)}</text>)
    }
    if (this.selection.size) {
      lines.push(<text flexShrink={0} wrapMode="none" key="bulk" fg={t.selFg} bg={t.acc}>{pad(` ${this.selection.size} selected · b run a process on them · Ctrl+A select page · Space toggle · Esc clear`, inner)}</text>)
    }
    const c = this.cursor
    const filterText = `${printFilter(this.filter) || 'no filter'}${this.quick ? ` · quick "${this.quick}"` : ''}${this.variant ? ` · ${variantLabel(this.meta as never)} ${this.variant.name ?? this.variant.id}` : ''}`
    lines.push(<text flexShrink={0} wrapMode="none" key="f" fg={t.dim}>{pad(` ${filterText}`, inner)}</text>)
    const status = c ? `${c.total === undefined ? '…' : num(c.total)} records · row ${num(c.index + 1)} · page ${this.rowsPage + 1}/${c.pageCount}${this.sort ? ` · sort ${this.sort.field} ${this.sort.asc ? 'asc' : 'desc'}` : ''} · col ${this.colCursor + 1}/${cols.length}${this.fetchMs !== undefined ? ` · ${this.fetchMs.toFixed(0)} ms` : ''}${this.loading ? ' · loading' : ''}` : 'loading…'
    const hint = this.store.singleKeys ? ' · a actions · s sort · f filter · q search · S stats · v view · x export · Space select' : ''
    lines.push(<text flexShrink={0} wrapMode="none" key="s" fg={t.dim}>{pad(` ${status}${hint}`, inner)}</text>)
    return <Panel title={this.title()} width={width} height={height} focused={focused}>{lines}</Panel>
  }
}
