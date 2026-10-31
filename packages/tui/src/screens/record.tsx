/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { ResultCursor, associationGroups, childFilter, childListFields, readViewSettings, relatedRecordTarget, saveDownload, valueText, widgetToBlocks, writeViewSettings, type AssociationGroup, type FieldMeta, type TagEntry, type QueryRecord, type RenderBlock, type TableMetaLike } from '@qrun-io/qqq-core'
import { saveFile } from '../overlays/files-helpers'
import { actionsOverlay } from '../overlays/actions'
import { TagOverlay, collaborationOf } from '../overlays/tags'
import { AuditScreen } from './audits'
import { DeveloperScreen } from './developer'
import type { FieldMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openForm, openProcess, openRecord } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { cell, errorText, fieldCell, pad, trunc } from '../util/text'
import { blockLines } from '../widgets'
import { ListModel, Panel, type Row } from './list'
import { defaultColumns } from './table'

type FullRecord = QueryRecord & { associatedRecords?: Record<string, QueryRecord[]> }

/** The record a field links to (LINK adornment, or a possible-value source that is a table), through the kernel. */
export function linkTarget(store: AppStore, field: FieldMetaData, record?: QueryRecord): string | undefined {
  const tables = Object.keys(store.meta?.tables ?? {})
  if (record) return relatedRecordTarget(field as FieldMeta, record as never, tables)?.tableName
  const pvs = field.possibleValueSourceName
  return pvs && tables.includes(pvs) ? pvs : undefined
}

/** Sections in tier order (T1, then T2, then T3, then the rest), hidden ones left out. */
export function orderedSections(meta: TableMetaData) {
  const rank = (tier?: string) => (tier === 'T1' ? 0 : tier === 'T2' ? 1 : tier === 'T3' ? 2 : 3)
  return [...(meta.sections ?? [])].filter((s) => !s.hidden).sort((a, b) => rank(a.tier) - rank(b.tier))
}

/**
 * A record: sections by tier, child lists from associations, widget sections. Opened from a grid it
 * shares the grid's ResultCursor, so PgDn/PgUp step through the same result and the grid lands on
 * the last record viewed when the person goes back.
 */
export class RecordScreen implements Screen {
  readonly kind = 'record'
  readonly id: string
  meta?: TableMetaData
  record?: FullRecord
  error?: string
  childMeta = new Map<string, TableMetaData>()
  widgets = new Map<string, RenderBlock[] | { error: string }>()
  readonly list = new ListModel()
  width = 100
  private generation = 0

  constructor(private store: AppStore, readonly tableName: string, public primaryKey: string | undefined, readonly cursor?: ResultCursor, private label?: string) {
    this.id = `record:${tableName}:${Date.now()}`
    this.load()
  }

  title(): string {
    return String(this.record?.recordLabel ?? this.label ?? this.primaryKey ?? '')
  }

  presenceScope(): string {
    return `record:${this.tableName}:${this.primaryKey}`
  }

  helpTopic() {
    return { kind: 'table' as const, name: this.tableName }
  }

  cliEquivalent(): string {
    return `table get ${this.tableName} ${this.primaryKey}`
  }

  load(): void {
    const client = this.store.client!
    const gen = ++this.generation
    const work = async () => {
      this.meta ??= await client.tableMeta(this.tableName)
      if (this.cursor && this.primaryKey === undefined) this.primaryKey = String(this.cursor.keyOf(await this.cursor.current()) ?? '')
      if (this.primaryKey === undefined || this.primaryKey === '') throw new Error('no record')
      const record = await client.record(this.tableName, this.primaryKey, Boolean(this.meta.associations?.length))
      for (const a of this.meta.associations ?? []) if (!this.childMeta.has(a.associatedTableName)) this.childMeta.set(a.associatedTableName, await client.tableMeta(a.associatedTableName))
      return record
    }
    work().then((record) => {
      if (gen !== this.generation) return
      this.record = record
      this.error = undefined
      this.label = record.recordLabel
      this.store.remember({ kind: 'record', table: this.tableName, key: this.primaryKey, label: record.recordLabel ?? String(this.primaryKey) })
      this.loadWidgets()
      this.loadTags()
      this.build()
      this.store.bump()
    }).catch((e) => {
      if (gen !== this.generation) return
      this.error = errorText(e)
      this.build()
      this.store.bump()
    })
  }

  loadWidgets(): void {
    for (const s of this.meta?.sections ?? []) {
      if (!s.widgetName) continue
      const name = s.widgetName
      this.store.client!.widget(name, { id: this.primaryKey }).then((d) => this.widgets.set(name, widgetToBlocks(d))).catch((e) => this.widgets.set(name, { error: errorText(e) })).finally(() => { this.build(); this.store.bump() })
    }
  }

  /** Steps through the result the record came from. */
  step(direction: 1 | -1): void {
    const c = this.cursor
    if (!c) return this.store.flash('this record was not opened from a list; there is nothing to step through')
    this.store.run((direction === 1 ? c.next() : c.previous()).then((rec) => {
      if (!rec) return this.store.flash(direction === 1 ? 'last record of the result' : 'first record of the result')
      this.primaryKey = String(c.keyOf(rec))
      this.label = rec.recordLabel
      this.record = undefined
      this.list.cursor = 0
      this.list.top = 0
      this.widgets.clear()
      this.load()
    }))
  }

  resume(): void {
    this.load()
  }

  refresh(): void {
    this.widgets.clear()
    this.load()
  }

  view() {
    return readViewSettings(`record:${this.tableName}`)
  }

  build(): void {
    const t = theme()
    const g = glyphs()
    const rows: Row[] = []
    const meta = this.meta
    const rec = this.record
    if (this.error && !rec) {
      rows.push({ text: this.error, fg: t.err })
      this.list.setRows(rows)
      return
    }
    if (!meta || !rec) {
      rows.push({ text: 'loading…', fg: t.dim })
      this.list.setRows(rows)
      return
    }
    const inner = this.width - 2
    const view = this.view()
    const labelWidth = view.labelWidth ?? Math.min(28, Math.max(8, ...Object.values(meta.fields).map((f) => f.label.length + 1)))
    rows.push({ text: `${rec.recordLabel ?? this.primaryKey}${this.cursor ? `   (${this.cursor.describe()})` : ''}`, fg: t.fg, bold: true })
    if (this.tags) rows.push({ text: `Tags: ${this.tags.length ? this.tags.map((x) => x.label ?? x.name).join(' · ') : '(none)'}   t edits`, fg: t.acc2, key: 'tags', action: () => this.openTags() })
    for (const s of orderedSections(meta)) {
      if (s.widgetName) {
        rows.push({ text: '' })
        rows.push({ text: `${s.label} ${g.rule.repeat(Math.max(0, Math.min(60, inner - s.label.length - 2)))}`, fg: t.acc, bold: true })
        const w = this.widgets.get(s.widgetName)
        if (!w) rows.push({ text: '  loading…', fg: t.dim })
        else if ('error' in w) rows.push({ text: `  ${w.error}`, fg: t.err })
        else rows.push(...blockLines(w.filter((b) => b.kind !== 'heading'), inner - 2).map((l) => ({ ...l, text: '  ' + l.text })))
        continue
      }
      const fields = (s.fieldNames ?? []).map((n) => meta.fields[n]).filter((f): f is FieldMetaData => Boolean(f) && !f!.isHidden)
      if (!fields.length) continue
      rows.push({ text: '' })
      rows.push({ text: `${s.label}${s.tier ? ` (${s.tier})` : ''} ${g.rule.repeat(Math.max(0, Math.min(60, inner - s.label.length - 8)))}`, fg: t.acc, bold: true })
      const tableNames = Object.keys(this.store.meta?.tables ?? {})
      const valueOf = (f: FieldMetaData) => valueText(f as FieldMeta, rec as never, { reveal: this.revealed.has(f.name), tableNames, tableName: this.tableName, primaryKey: this.primaryKey, widgets: this.store.meta?.widgets as never }).text
      // the value column is sized once per section (first record shown) and kept while stepping records
      const frozenKey = `${s.name}|${inner}`
      if (!this.sectionWidths.has(frozenKey)) this.sectionWidths.set(frozenKey, Math.max(...fields.map((f) => valueOf(f).length + (linkTarget(this.store, f) ? 2 : 0)), 12))
      const longest = this.sectionWidths.get(frozenKey)!
      const colWidth = Math.min(60, labelWidth + 2 + longest)
      const two = (view.recordColumns ?? (inner >= 2 * colWidth + 6 ? 2 : 1)) === 2 && inner >= 2 * Math.min(colWidth, 30) + 6
      const fieldText = (f: FieldMetaData) => {
        const v = valueText(f as FieldMeta, rec as never, { tableNames, widgets: this.store.meta?.widgets as never })
        const link = v.link ? ` ${g.link}` : v.file ? ' [file: Enter saves]' : v.masked ? ' [Enter reveals]' : ''
        return `${pad(f.label, labelWidth)}  ${trunc(valueOf(f) + link, (two ? colWidth : Math.min(inner - 4, 100)) - labelWidth - 2)}`
      }
      for (let i = 0; i < fields.length; i += two ? 2 : 1) {
        const pair = two ? fields.slice(i, i + 2) : [fields[i]!]
        const links = pair.filter((f) => { const v = valueText(f as FieldMeta, rec as never, { tableNames }); return Boolean(v.link || v.file || v.masked) })
        const text = '  ' + (two ? pad(fieldText(pair[0]!), colWidth) + '    ' + (pair[1] ? fieldText(pair[1]) : '') : fieldText(pair[0]!))
        rows.push({ text, key: `f:${pair[0]!.name}`, action: () => this.follow(links) })
      }
    }
    const tables: Record<string, TableMetaLike | undefined> = Object.fromEntries([...this.childMeta].map(([k, v]) => [k, v as unknown as TableMetaLike]))
    this.groups = associationGroups(rec as never, meta as unknown as TableMetaLike, tables, { widgets: this.store.meta?.widgets as never, maxDepth: 1 })
    this.groups.forEach((group, gi) => this.childRows(group, gi, rows, inner))
    this.list.setRows(rows)
    // back from a child record: land on the child that was viewed last (it may have stepped)
    if (this.openedChild) {
      const key = `c:${this.openedChild.gi}:${this.openedChild.cursor.index}`
      const at = rows.findIndex((r) => r.key === key)
      if (at >= 0) this.list.cursor = at
    }
  }

  /** The child list and cursor of the child record opened last. */
  openedChild?: { gi: number; cursor: ResultCursor }

  groups: AssociationGroup[] = []
  /** Frozen layout: value width per section and child-list column widths, kept while stepping. */
  sectionWidths = new Map<string, number>()
  childWidths = new Map<string, number[]>()
  revealed = new Set<string>()

  childRows(group: AssociationGroup, gi: number, rows: Row[], inner: number): void {
    const t = theme()
    const g = glyphs()
    const child = this.childMeta.get(group.table)
    const records = group.records as QueryRecord[]
    rows.push({ text: '' })
    rows.push({ text: `${group.label} (${records.length}) ${g.rule.repeat(Math.max(0, Math.min(60, inner - group.label.length - 8)))}`, fg: t.acc, bold: true, key: `c:${gi}`, action: () => this.newChild(group) })
    if (group.unavailable || !child) {
      rows.push({ text: `  ${group.unavailable ?? 'no metadata'}`, fg: t.dim })
      return
    }
    const binding = (group.association.join?.joinOns ?? []).map((j) => j.rightField)
    const names = childListFields(child as unknown as TableMetaLike, binding)
    const wkey = `${group.association.name}|${names.join(',')}`
    if (!this.childWidths.has(wkey) || (records.length && this.childWidths.get(wkey)!.every((w, i) => w === child.fields[names[i]!]!.label.length))) {
      this.childWidths.set(wkey, names.map((n) => Math.min(30, Math.max(child.fields[n]!.label.length, ...records.map((r) => fieldCell(r, child.fields[n]!).length)))))
    }
    const widths = this.childWidths.get(wkey)!
    rows.push({ text: '  ' + names.map((n, i) => pad(child.fields[n]!.label, widths[i]!)).join('  '), fg: t.dim })
    records.forEach((r, idx) => {
      rows.push({ text: '  ' + names.map((n, i) => pad(fieldCell(r, child.fields[n]!), widths[i]!)).join('  '), key: `c:${gi}:${idx}`, action: () => this.openChild(group, idx) })
    })
    if (!records.length) rows.push({ text: '  (none) · Enter on the heading or F7 adds one', fg: t.dim })
  }

  /** The filter selecting this record's children of a group (kernel childFilter). */
  childFilterOf(group: AssociationGroup) {
    const child = this.childMeta.get(group.table)!
    const f = childFilter(group.association, this.meta as unknown as TableMetaLike, this.record as never, child as unknown as TableMetaLike)
    return { criteria: f.criteria, booleanOperator: f.booleanOperator, ...(f.subFilters ? { subFilters: f.subFilters } : {}) }
  }

  /** Opens a child record with a cursor over its siblings, so PgDn steps through them. */
  openChild(group: AssociationGroup, index: number): void {
    const child = this.childMeta.get(group.table)
    if (!child) return
    const records = group.records as QueryRecord[]
    const cursor = new ResultCursor({ baseUrl: this.store.client!.server, fetch: this.store.client!.fetch, table: group.table, filter: this.childFilterOf(group), pageSize: 50, primaryKeyField: child.primaryKeyField, index })
    cursor.seed(0, records.slice(0, 50), records.length)
    this.openedChild = { gi: this.groups.indexOf(group), cursor }
    openRecord(this.store, group.table, String(records[index]?.values?.[child.primaryKeyField] ?? ''), { cursor, label: records[index]?.recordLabel })
  }

  newChild(group: AssociationGroup): void {
    const values = Object.fromEntries((group.association.join?.joinOns ?? []).map((j) => [j.rightField, this.record?.values?.[j.leftField]]))
    openForm(this.store, group.table, { mode: 'create', initial: values })
  }

  /** Saves a FILE_DOWNLOAD field to a file (kernel fileDownload, safe names, no overwrite unless named). */
  download(f: FieldMetaData): void {
    const v = valueText(f as FieldMeta, this.record as never, {})
    const file = v.file
    if (!file) return
    if (!file.route) return this.store.message(`This file is outside the server: ${file.url ?? ''}`, 'info', 'Download')
    const route = file.route
    saveFile(this.store, `Save ${file.fileName}`, file.fileName, (out) => {
      this.store.run(this.store.client!.call('downloadRecordFieldFile', { path: { tableName: route.tableName, primaryKey: route.primaryKey, fieldName: route.fieldName, filename: route.filename } }), (r) => {
        const bytes = r.bytes ?? new TextEncoder().encode(typeof r.data === 'string' ? r.data : JSON.stringify(r.data))
        const saved = saveDownload(out, bytes, { explicit: true })
        this.store.message(`Saved ${saved} (${bytes.length} bytes).`)
      })
    })
  }

  follow(fields: FieldMetaData[]): void {
    const go = (f: FieldMetaData) => {
      const v = valueText(f as FieldMeta, this.record as never, { tableNames: Object.keys(this.store.meta?.tables ?? {}) })
      if (v.file) return this.download(f)
      if (v.masked) {
        this.revealed.add(f.name)
        return this.build()
      }
      if (v.link && 'tableName' in v.link) return openRecord(this.store, v.link.tableName, v.link.primaryKey)
      if (v.link && 'url' in v.link) return this.store.message(v.link.url, 'info', 'Link (open it in a browser)')
    }
    if (!fields.length) return this.store.flash('no link on this line (links are marked ' + glyphs().link + ')')
    if (fields.length === 1) return go(fields[0]!)
    this.store.open(new ChoiceOverlay(this.store, 'Follow which link?', fields.map((f) => ({ label: f.label, value: f, detail: cell(this.record, f.name) })), go))
  }

  currentAssociation(): AssociationGroup | undefined {
    const key = this.list.current?.key ?? ''
    if (!key.startsWith('c:')) return undefined
    return this.groups[Number(key.split(':')[1])]
  }

  deleteRecord(): void {
    if (this.meta?.deletePermission === false) return this.store.flash('you may not delete records of this table', 'error')
    this.store.confirm(`Delete ${this.meta?.label ?? this.tableName} ${this.primaryKey}${this.record?.recordLabel ? ` "${this.record.recordLabel}"` : ''}?`, () => {
      this.store.run(this.store.client!.remove(this.tableName, this.primaryKey), () => {
        this.store.flash(`deleted ${this.meta?.label ?? this.tableName} ${this.primaryKey}`)
        const c = this.cursor
        if (!c) return this.store.back()
        c.removed(c.index)
        if (c.total === 0) return this.store.back()
        this.primaryKey = undefined
        this.record = undefined
        this.load()
      })
    })
  }

  /** The record's tags (collaboration extension), shown under the header. */
  tags?: TagEntry[]

  loadTags(): void {
    const collab = collaborationOf(this.store)
    if (!collab || this.primaryKey === undefined) return
    collab.recordTags(this.tableName, this.primaryKey).then((t) => { this.tags = t; this.build(); this.store.bump() }).catch(() => undefined)
  }

  openTags(): void {
    const collab = collaborationOf(this.store)
    if (!collab) return this.store.flash(this.store.extensions.missing('collaboration'), 'error')
    if (this.primaryKey === undefined) return
    this.store.open(new TagOverlay(this.store, collab, this.tableName, this.primaryKey, (t) => { this.tags = t; this.build() }))
  }

  openAudits(): void {
    if (this.primaryKey !== undefined) this.store.push(new AuditScreen(this.store, this.tableName, this.primaryKey, this.record?.recordLabel))
  }

  openDeveloper(): void {
    if (this.primaryKey !== undefined) this.store.push(new DeveloperScreen(this.store, this.tableName, this.primaryKey))
  }

  recordProcesses() {
    return Object.values(this.store.meta?.processes ?? {}).filter((p) => p.tableName === this.tableName && !/bulkInsert|bulkEditWithFile|bulkLoad/i.test(p.name))
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: this.meta?.editPermission === false ? null : 'Edit', 6: null, 7: this.currentAssociation() ? 'NewChild' : this.meta?.insertPermission === false ? null : 'New', 8: this.meta?.deletePermission === false ? null : 'Delete' }
  }

  onKey(key: Key): boolean {
    const ch = charOf(key)
    if (key.name === 'pagedown' || ch === ']' || (key.ctrl && key.name === 'n')) {
      if (this.cursor) this.step(1)
      else this.list.onKey({ name: 'pagedown', sequence: '' })
      return true
    }
    if (key.name === 'pageup' || ch === '[' || (key.ctrl && key.name === 'p')) {
      if (this.cursor) this.step(-1)
      else this.list.onKey({ name: 'pageup', sequence: '' })
      return true
    }
    switch (key.name) {
      case 'f4': if (this.primaryKey !== undefined) openForm(this.store, this.tableName, { mode: 'edit', primaryKey: this.primaryKey }); return true
      case 'f7': {
        const a = this.currentAssociation()
        if (a) this.newChild(a)
        else openForm(this.store, this.tableName, { mode: 'create' })
        return true
      }
      case 'f8': this.deleteRecord(); return true
      default: break
    }
    if (this.list.onKey(key)) return true
    if (!this.store.singleKeys) return false
    switch (ch) {
      case 'e': return this.onKey({ name: 'f4', sequence: '' })
      case 'c': if (this.primaryKey !== undefined) openForm(this.store, this.tableName, { mode: 'copy', primaryKey: this.primaryKey }); return true
      case 'd': this.deleteRecord(); return true
      case 'n': openForm(this.store, this.tableName, { mode: 'create' }); return true
      case 'r': this.refresh(); return true
      case 'l': this.list.current?.action?.(); return true
      case 'A': this.openAudits(); return true
      case 't': if (collaborationOf(this.store)) { this.openTags(); return true } return false
      case 'D': this.openDeveloper(); return true
      case 'a': actionsOverlay(this.store, this); return true
      default: return false
    }
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = [
      { section: 'Context', label: 'Edit this record', key: 'F4 e', run: () => this.onKey({ name: 'f4', sequence: '' }) },
      { section: 'Context', label: 'Copy into a new record', key: 'c', run: () => openForm(this.store, this.tableName, { mode: 'copy', primaryKey: this.primaryKey }) },
      { section: 'Context', label: 'Delete this record', key: 'F8 d', run: () => this.deleteRecord() },
      { section: 'Context', label: `New ${this.meta?.label ?? this.tableName}`, key: 'F7 n', run: () => openForm(this.store, this.tableName, { mode: 'create' }) },
      { section: 'Context', label: 'Next record', key: 'PgDn ] Ctrl+N', disabled: this.cursor ? undefined : 'not opened from a list', run: () => this.step(1) },
      { section: 'Context', label: 'Previous record', key: 'PgUp [ Ctrl+P', disabled: this.cursor ? undefined : 'not opened from a list', run: () => this.step(-1) },
      { section: 'Context', label: 'Refresh', key: 'F5 r', run: () => this.refresh() },
      { section: 'Context', label: 'View settings (columns, label width)', key: 'v', run: () => { const o = this.viewSettings(); if (o) this.store.open(o) } },
      { section: 'Context', label: 'Copy as a CLI command', detail: `qqq ${this.cliEquivalent()}`, run: () => this.store.message(`qqq ${this.cliEquivalent()}`, 'info', 'CLI equivalent') },
    ]
    for (const group of this.groups) {
      out.push({ section: 'Context', label: `New ${group.label} for this record`, key: 'F7', run: () => this.newChild(group) })
      out.push({ section: 'Context', label: `Query all ${group.label} of this record`, run: () => import('../nav').then((n) => n.openTable(this.store, group.table, this.childFilterOf(group))) })
    }
    const tableNames = Object.keys(this.store.meta?.tables ?? {})
    for (const f of Object.values(this.meta?.fields ?? {})) {
      if (!this.record) break
      const v = valueText(f as FieldMeta, this.record as never, { tableNames })
      if (v.link) out.push({ section: 'Context', label: `Follow ${f.label}`, detail: cell(this.record, f.name), run: () => this.follow([f]) })
      if (v.file) out.push({ section: 'Context', label: `Download ${f.label}`, detail: v.file.fileName, run: () => this.download(f) })
      if (v.masked) out.push({ section: 'Context', label: `Reveal ${f.label}`, run: () => this.follow([f]) })
    }
    for (const p of this.recordProcesses()) out.push({ section: 'Context', label: `Run ${p.label} on this record`, run: () => openProcess(this.store, p.name, { recordIds: [String(this.primaryKey)] }) })
    if (this.store.extensions.has('collaboration')) out.push({ section: 'Context', label: 'Tags…', key: 't', command: 'tags', detail: this.tags?.map((x) => x.label).join(', '), run: () => this.openTags() })
    out.push({ section: 'Context', label: 'Audit history', key: 'A', command: 'audits', run: () => this.openAudits() })
    out.push({ section: 'Context', label: 'Developer: panels and associated scripts', key: 'D', command: 'dev', run: () => this.openDeveloper() })
    return out
  }

  viewSettings(): Overlay | undefined {
    const key = `record:${this.tableName}`
    const v = readViewSettings(key)
    const choices = [
      { label: 'Automatic columns (two when there is room)', value: 'auto' },
      { label: 'One column', value: '1' },
      { label: 'Two columns', value: '2' },
      { label: 'Label width: narrower (-4)', value: 'narrow' },
      { label: 'Label width: wider (+4)', value: 'wide' },
      { label: 'Reset record view settings', value: 'reset' },
    ]
    return new ChoiceOverlay(this.store, `Record view settings · ${this.meta?.label ?? this.tableName}`, choices, (value) => {
      const next = { ...v }
      if (value === 'auto') delete next.recordColumns
      else if (value === '1' || value === '2') next.recordColumns = Number(value) as 1 | 2
      else if (value === 'narrow' || value === 'wide') next.labelWidth = Math.max(6, Math.min(40, (v.labelWidth ?? 20) + (value === 'wide' ? 4 : -4)))
      writeViewSettings(key, value === 'reset' ? undefined : next)
      this.build()
    })
  }

  render(width: number, height: number, focused: boolean) {
    if (width !== this.width) {
      this.width = width
      this.build()
    }
    const t = theme()
    const hint = `${this.cursor ? `${this.cursor.describe()} · PgDn/PgUp next/previous · ` : ''}a actions · A audits · D developer · Enter follows ${glyphs().link} or opens a child · Esc back`
    return (
      <Panel title={`${this.meta?.label ?? this.tableName} › ${this.title()}`} width={width} height={height} focused={focused}>
        {this.list.view(width - 2, height - 3, focused)}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(` ${hint}`, width - 2)}</text>
      </Panel>
    )
  }
}
