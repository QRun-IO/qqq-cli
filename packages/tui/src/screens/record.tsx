/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { ResultCursor, readViewSettings, widgetToBlocks, writeViewSettings, type QueryRecord, type RenderBlock } from '@qrun-io/qqq-core'
import type { Association, FieldMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openForm, openProcess, openRecord } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { cell, errorText, pad, trunc } from '../util/text'
import { blockLines } from '../widgets'
import { ListModel, Panel, type Row } from './list'
import { defaultColumns } from './table'

type FullRecord = QueryRecord & { associatedRecords?: Record<string, QueryRecord[]> }

/** A field whose value names a record of another table (a possible-value source that is a table). */
export function linkTarget(store: AppStore, field: FieldMetaData): string | undefined {
  const pvs = field.possibleValueSourceName
  if (pvs && store.meta?.tables?.[pvs]) return pvs
  const link = field.adornments?.find((a) => a.type === 'LINK')?.values as { toRecordFromTable?: string } | undefined
  return link?.toRecordFromTable && store.meta?.tables?.[link.toRecordFromTable] ? link.toRecordFromTable : undefined
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
    const name = this.record?.recordLabel ?? this.label ?? this.primaryKey ?? ''
    return `${this.meta?.label ?? this.tableName} › ${name}`
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
      const valueOf = (f: FieldMetaData) => {
        const masked = f.type === 'PASSWORD' || f.adornments?.some((a) => a.type === 'REVEAL')
        const v = cell(rec, f.name)
        return masked && v ? '••••••' : v
      }
      const longest = Math.max(...fields.map((f) => valueOf(f).length), 4)
      const colWidth = Math.min(60, labelWidth + 2 + longest)
      const two = (view.recordColumns ?? (inner >= 2 * colWidth + 6 ? 2 : 1)) === 2 && inner >= 2 * Math.min(colWidth, 30) + 6
      const fieldText = (f: FieldMetaData) => {
        const link = linkTarget(this.store, f) && rec.values?.[f.name] !== null && rec.values?.[f.name] !== undefined ? ` ${g.link}` : ''
        return `${pad(f.label, labelWidth)}  ${trunc(valueOf(f) + link, (two ? colWidth : Math.min(inner - 4, 100)) - labelWidth - 2)}`
      }
      for (let i = 0; i < fields.length; i += two ? 2 : 1) {
        const pair = two ? fields.slice(i, i + 2) : [fields[i]!]
        const links = pair.filter((f) => linkTarget(this.store, f) && rec.values?.[f.name] !== null && rec.values?.[f.name] !== undefined)
        const text = '  ' + (two ? pad(fieldText(pair[0]!), colWidth) + '    ' + (pair[1] ? fieldText(pair[1]) : '') : fieldText(pair[0]!))
        rows.push({ text, key: `f:${pair[0]!.name}`, action: () => this.follow(links) })
      }
    }
    for (const a of meta.associations ?? []) this.childRows(a, rows, inner)
    this.list.setRows(rows)
  }

  childRows(a: Association, rows: Row[], inner: number): void {
    const t = theme()
    const g = glyphs()
    const child = this.childMeta.get(a.associatedTableName)
    const records = this.record?.associatedRecords?.[a.name] ?? []
    const label = a.label ?? child?.label ?? a.name
    rows.push({ text: '' })
    rows.push({ text: `${label} (${records.length}) ${g.rule.repeat(Math.max(0, Math.min(60, inner - label.length - 8)))}`, fg: t.acc, bold: true, key: `c:${a.name}`, action: () => this.newChild(a) })
    if (!child) return
    const joinFields = new Set((a.join?.joinOns ?? []).map((j) => j.rightField))
    const names = defaultColumns(child).filter((n) => !joinFields.has(n)).slice(0, 6)
    const widths = names.map((n) => Math.min(30, Math.max(child.fields[n]!.label.length, ...records.map((r) => cell(r, n).length))))
    rows.push({ text: '  ' + names.map((n, i) => pad(child.fields[n]!.label, widths[i]!)).join('  '), fg: t.dim })
    records.forEach((r, idx) => {
      rows.push({ text: '  ' + names.map((n, i) => pad(cell(r, n), widths[i]!)).join('  '), key: `c:${a.name}:${idx}`, action: () => this.openChild(a, idx) })
    })
    if (!records.length) rows.push({ text: '  (none) · Enter on the heading or F7 adds one', fg: t.dim })
  }

  /** The filter selecting this record's children of an association. */
  childFilter(a: Association) {
    return { criteria: (a.join?.joinOns ?? []).map((j) => ({ fieldName: j.rightField, operator: 'EQUALS' as const, values: [String(this.record?.values?.[j.leftField] ?? '')] })), booleanOperator: 'AND' as const }
  }

  /** Opens a child record with a cursor over its siblings, so PgDn steps through them. */
  openChild(a: Association, index: number): void {
    const child = this.childMeta.get(a.associatedTableName)
    if (!child) return
    const cursor = new ResultCursor({ baseUrl: this.store.client!.server, fetch: this.store.client!.fetch, table: a.associatedTableName, filter: this.childFilter(a), pageSize: 50, primaryKeyField: child.primaryKeyField, index })
    const records = this.record?.associatedRecords?.[a.name] ?? []
    cursor.seed(0, records.slice(0, 50), records.length)
    openRecord(this.store, a.associatedTableName, String(records[index]?.values?.[child.primaryKeyField] ?? ''), { cursor, label: records[index]?.recordLabel })
  }

  newChild(a: Association): void {
    const values = Object.fromEntries((a.join?.joinOns ?? []).map((j) => [j.rightField, this.record?.values?.[j.leftField]]))
    openForm(this.store, a.associatedTableName, { mode: 'create', initial: values })
  }

  follow(fields: FieldMetaData[]): void {
    const go = (f: FieldMetaData) => openRecord(this.store, linkTarget(this.store, f)!, String(this.record?.values?.[f.name]))
    if (!fields.length) return this.store.flash('no link on this line (links are marked ' + glyphs().link + ')')
    if (fields.length === 1) return go(fields[0]!)
    this.store.open(new ChoiceOverlay(this.store, 'Follow which link?', fields.map((f) => ({ label: f.label, value: f, detail: cell(this.record, f.name) })), go))
  }

  currentAssociation(): Association | undefined {
    const key = this.list.current?.key ?? ''
    if (!key.startsWith('c:')) return undefined
    const name = key.split(':')[1]
    return this.meta?.associations?.find((a) => a.name === name)
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
    for (const a of this.meta?.associations ?? []) {
      out.push({ section: 'Context', label: `New ${this.childMeta.get(a.associatedTableName)?.label ?? a.name} for this record`, run: () => this.newChild(a) })
      out.push({ section: 'Context', label: `Query all ${this.childMeta.get(a.associatedTableName)?.label ?? a.name} of this record`, run: () => import('../nav').then((n) => n.openTable(this.store, a.associatedTableName, this.childFilter(a))) })
    }
    for (const f of Object.values(this.meta?.fields ?? {})) {
      if (linkTarget(this.store, f) && this.record?.values?.[f.name] !== null && this.record?.values?.[f.name] !== undefined) out.push({ section: 'Context', label: `Follow ${f.label}`, detail: cell(this.record, f.name), run: () => this.follow([f]) })
    }
    for (const p of this.recordProcesses()) out.push({ section: 'Context', label: `Run ${p.label} on this record`, run: () => openProcess(this.store, p.name, { recordIds: [String(this.primaryKey)] }) })
    out.push({ section: 'Context', label: 'Audits', disabled: 'audits arrive with the kernel support (another branch)' })
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
    const hint = this.cursor ? `${this.cursor.describe()} · PgDn/PgUp next/previous · Enter follows ${glyphs().link} or opens a child · Esc back` : `Enter follows ${glyphs().link} or opens a child · Esc back`
    return (
      <Panel title={this.title()} width={width} height={height} focused={focused}>
        {this.list.view(width - 2, height - 3, focused)}
        <text fg={t.dim}>{pad(` ${hint}`, width - 2)}</text>
      </Panel>
    )
  }
}
