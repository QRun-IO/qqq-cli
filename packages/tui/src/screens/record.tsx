/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { FormSession, dynamicFormFields, dynamicFormMissing, dynamicFormSubmission, dynamicFormValues, type DynamicFormPayload, ResultCursor, associationGroups, childFilter, exposedJoins, formatSize, helpEntryText, selectHelpContent, planJoins, readViewSettings, withJoinFields, readChildRows, relatedRecordTarget, saveDownload, widgetAssociation, valueText, widgetToBlocks, writeViewSettings, type AssociationGroup, type FieldMeta, type TagEntry, type QueryRecord, type RenderBlock, type TableMetaLike } from '@qrun-io/qqq-core'
import { openShareDialog, shareState } from '../overlays/share'
import { FieldsFormScreen } from './fields-form'
import { WidgetView } from '../widget-view'
import { saveFile } from '../overlays/files-helpers'
import { actionsOverlay } from '../overlays/actions'
import { TagOverlay, collaborationOf } from '../overlays/tags'
import { AuditScreen } from './audits'
import { DeveloperScreen } from './developer'
import type { FieldMetaData, SectionMetaData, TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openForm, openProcess, openRecord, permits } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { cell, errorText, fieldCell, pad, trunc } from '../util/text'
import { blockLines } from '../widgets'
import { ListModel, Panel, type Row } from './list'
import { childBox, childColumnWidth, clampOffset, padRows, planRecordLayout, type LayoutItem } from './record-layout'
import { defaultColumns } from './table'

type FullRecord = QueryRecord & { associatedRecords?: Record<string, QueryRecord[]> }

/** The record a field links to (LINK adornment, or a possible-value source that is a table), through the kernel. */
export function linkTarget(store: AppStore, field: FieldMetaData, record?: QueryRecord): string | undefined {
  const tables = Object.keys(store.meta?.tables ?? {})
  if (record) return relatedRecordTarget(field as FieldMeta, record as never, tables)?.tableName
  const pvs = field.possibleValueSourceName
  return pvs && tables.includes(pvs) ? pvs : undefined
}

/** A BLOB value stored in the record itself (base64), not behind a FILE_DOWNLOAD route. */
export function isBlob(record: QueryRecord | undefined, f: FieldMetaData): boolean {
  const raw = record?.values?.[f.name]
  return f.type === 'BLOB' && typeof raw === 'string' && raw !== '' && !f.adornments?.some((a) => a.type === 'FILE_DOWNLOAD')
}

export function blobText(record: QueryRecord, field: string): string {
  const raw = record.values?.[field]
  if (typeof raw !== 'string' || !raw) return ''
  return `file, ${formatSize(Math.floor((raw.length * 3) / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0))}`
}

/** Saves a BLOB value (base64 in the record) through the save dialog. */
export function saveBlob(store: AppStore, record: QueryRecord, table: string, pk: string, f: FieldMetaData): void {
  const bytes = new Uint8Array(Buffer.from(String(record.values?.[f.name] ?? ''), 'base64'))
  saveFile(store, `Save ${f.label}`, `${table}-${pk}-${f.name}`, (path) => {
    const out = saveDownload(path, bytes, { explicit: true })
    store.message(`Saved ${out} (${bytes.length} bytes).`)
  })
}

/** A CHIP value's color: the adornment's color for the value mapped onto the theme (success, warning, error, info), else the accent. */
export function chipColor(f: FieldMetaData, rec: QueryRecord): string {
  const t = theme()
  const values = (f.adornments?.find((a) => a.type === 'CHIP')?.values ?? {}) as Record<string, unknown>
  const raw = String(rec.values?.[f.name] ?? '')
  const color = String(values[`color.${raw}`] ?? values.color ?? '').toLowerCase()
  if (/success|green/.test(color)) return t.ok
  if (/warn|yellow|orange/.test(color)) return t.warn
  if (/error|red|danger/.test(color)) return t.err
  return t.acc2
}

/** Sections in tier order (T1, then T2, then T3, then the rest), hidden ones left out. */
export function orderedSections(meta: TableMetaData) {
  const rank = (tier?: string) => (tier === 'T1' ? 0 : tier === 'T2' ? 1 : tier === 'T3' ? 2 : 3)
  const sections = [...(meta.sections ?? [])].filter((s) => !s.hidden).sort((a, b) => rank(a.tier) - rank(b.tier))
  // a table without sections shows all its (visible) fields in one
  if (!(meta.sections ?? []).length) return [{ name: '_all', label: meta.label, tier: 'T1', fieldNames: Object.keys(meta.fields).filter((n) => !meta.fields[n]!.isHidden) }] as typeof sections
  return sections
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

  constructor(private store: AppStore, readonly tableName: string, public primaryKey: string | undefined, readonly cursor?: ResultCursor, private label?: string, readonly tableVariant?: string) {
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
      const record = await client.record(this.tableName, this.primaryKey, Boolean(this.meta.associations?.length), this.tableVariant)
      await this.loadJoinedFields(record)
      // child tables three levels down (pets, then each pet's notes), for nested child lists
      let level: TableMetaData[] = [this.meta]
      for (let depth = 0; depth < 3 && level.length; depth++) {
        const next: TableMetaData[] = []
        for (const m of level) for (const a of m.associations ?? []) {
          if (this.childMeta.has(a.associatedTableName)) continue
          const cm = await client.tableMeta(a.associatedTableName)
          this.childMeta.set(a.associatedTableName, cm)
          next.push(cm)
        }
        level = next
      }
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

  /** Metadata with exposed-join fields under qualified names (sections may list `joinTable.field`). */
  fullMeta?: TableMetaData

  /** Section fields from readable exposed joins: read through a query with those joins for this record. */
  async loadJoinedFields(record: QueryRecord): Promise<void> {
    const meta = this.meta!
    const qualified = [...new Set((meta.sections ?? []).flatMap((x) => x.fieldNames ?? []).filter((n) => n.includes('.') && !meta.fields[n]))]
    const joins = exposedJoins(meta as never, this.store.meta?.tables as never)
    const full = withJoinFields(meta as never, joins) as unknown as TableMetaData
    for (const j of joins) for (const [n, f] of Object.entries(j.tableMeta.fields as Record<string, FieldMetaData>)) if (full.fields[`${j.table}.${n}`]) full.fields[`${j.table}.${n}`]!.label = `${j.label}: ${f.label}`
    this.fullMeta = full
    const wanted = qualified.filter((n) => full.fields[n])
    if (!wanted.length) return
    const plan = planJoins(joins, { columns: wanted })
    const filter = { criteria: [{ fieldName: meta.primaryKeyField, operator: 'EQUALS', values: [String(this.primaryKey)] }], booleanOperator: 'AND', limit: 1 }
    const rows = ((await this.store.client!.data<{ records?: QueryRecord[] }>('queryTable', { path: { tableName: this.tableName }, query: this.tableVariant ? { tableVariant: this.tableVariant } : undefined, json: { filter, joins: plan.joins } })).records ?? [])
    const row = rows[0]
    if (!row) return
    for (const n of wanted) {
      record.values[n] = row.values?.[n]
      if (row.displayValues?.[n] !== undefined) (record.displayValues ??= {})[n] = row.displayValues[n]!
    }
  }

  /** Section widgets' raw payloads (a dynamicForm is edited from its payload). */
  widgetPayloads = new Map<string, unknown>()

  /** Edits a dynamicForm widget's fields: required checked, saved in the record field it names (JSON) or as record fields. */
  editDynamicForm(widgetName: string): void {
    const payload = this.widgetPayloads.get(widgetName) as DynamicFormPayload | undefined
    if (!payload) return
    const fields = dynamicFormFields(payload)
    if (!fields.length) return this.store.flash(payload.noFieldsMessage ?? 'this form has no fields', 'error')
    const c = this.store.client!
    const session = new FormSession({ baseUrl: c.server, fetch: c.fetch, scope: { table: this.tableName }, fields, initialValues: dynamicFormValues(payload, (this.record?.values ?? {}) as Record<string, unknown>) })
    const label = (this.meta?.sections ?? []).find((x) => x.widgetName === widgetName)?.label ?? widgetName
    this.store.push(new FieldsFormScreen(this.store, `${label}: ${this.title()}`, session, async (values) => {
      const body = dynamicFormSubmission(payload, values)
      await c.update(this.tableName, this.primaryKey!, body)
      this.refresh()
      return `saved ${label} in ${Object.keys(body).join(', ')}`
    }, (values) => dynamicFormMissing(payload, values)))
  }

  /** Section widgets with their controls (dropdowns, export, setup editors), by widget name. */
  widgetViews = new Map<string, WidgetView>()

  loadWidgets(): void {
    for (const s of this.meta?.sections ?? []) {
      if (!s.widgetName) continue
      // a widget section that lists an association is drawn from the record's associated records
      if (widgetAssociation((this.store.meta?.widgets as Record<string, never> | undefined)?.[s.widgetName], this.meta as never)) continue
      const name = s.widgetName
      const rec = this.record
      const view = new WidgetView(this.store, name, {
        params: { id: String(this.primaryKey ?? '') },
        record: { tableName: this.tableName, primaryKey: String(this.primaryKey ?? ''), values: rec?.values as Record<string, unknown> | undefined, displayValues: rec?.displayValues as Record<string, unknown> | undefined, fields: Object.fromEntries(Object.entries(this.meta?.fields ?? {}).map(([k, f]) => [k, { label: f.label }])), editable: (this.meta as { editPermission?: boolean } | undefined)?.editPermission !== false, refresh: () => this.refresh() },
        onChange: () => {
          if (view.data) this.widgetPayloads.set(name, view.data)
          this.widgets.set(name, view.error ? { error: view.error } : view.blocks ?? [])
          this.build()
          this.store.bump()
        },
      })
      this.widgetViews.set(name, view)
      void view.load()
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
      this.childOffsets.clear()
      this.tags = undefined
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
    const labelWidth = view.labelWidth ?? Math.min(28, Math.max(8, ...Object.values({ ...meta.fields, ...Object.fromEntries((meta.sections ?? []).flatMap((x) => x.fieldNames ?? []).filter((n) => this.fullMeta?.fields[n]).map((n) => [n, this.fullMeta!.fields[n]!])) }).map((f) => f.label.length + 1)))
    rows.push({ text: `${rec.recordLabel ?? this.primaryKey}${this.cursor ? `   (${this.cursor.describe()})` : ''}`, fg: t.fg, bold: true })
    // the tags line is there for every record (collaboration), loaded or not, so nothing below moves
    if (this.store.extensions.has('collaboration')) rows.push({ text: `Tags: ${!this.tags ? '…' : this.tags.length ? this.tags.map((x) => x.label ?? x.name).join(' · ') : '(none)'}   t edits`, fg: t.acc2, key: 'tags', action: () => this.openTags() })
    const tables: Record<string, TableMetaLike | undefined> = Object.fromEntries([...this.childMeta].map(([k, v]) => [k, v as unknown as TableMetaLike]))
    this.groups = associationGroups(rec as never, meta as unknown as TableMetaLike, tables, { widgets: this.store.meta?.widgets as never, maxDepth: 3 })
    for (const item of planRecordLayout(orderedSections(meta), meta, this.groups, this.store.meta?.widgets as never, this.childMeta)) {
      if (item.kind === 'children') rows.push(...this.childRows(item, inner))
      else if (item.kind === 'widget') rows.push(...this.widgetRows(item.section, inner))
      else rows.push(...this.fieldRows(item.section, rec, labelWidth, inner))
    }
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
  /** First record shown by each scrolled child list (by group title); reset when stepping records. */
  childOffsets = new Map<string, number>()
  /** Tallest a widget section has been on this screen: it keeps that height while stepping records. */
  widgetHeights = new Map<string, number>()
  revealed = new Set<string>()

  /** Data rows of each child list: this table's view setting, else the profile's, else 5. */
  childRowCount(): number {
    const n = Number(this.view().childRows)
    return Number.isInteger(n) && n >= 1 && n <= 50 ? n : readChildRows(this.store.status.profile || undefined)
  }

  private offsetKey(group: AssociationGroup): string {
    return `${group.association.name}|${group.title}`
  }

  /** A section of fields. Column positions come from the field metadata, so they are the same for every record. */
  fieldRows(s: SectionMetaData, rec: FullRecord, labelWidth: number, inner: number): Row[] {
    const t = theme()
    const g = glyphs()
    const meta = this.meta!
    const view = this.view()
    const rows: Row[] = []
    const fields = (s.fieldNames ?? []).map((n) => meta.fields[n] ?? this.fullMeta?.fields[n]).filter((f): f is FieldMetaData => Boolean(f) && !f!.isHidden)
    if (!fields.length) return rows
    rows.push({ text: '' })
    rows.push({ text: `${s.label}${s.tier ? ` (${s.tier})` : ''} ${g.rule.repeat(Math.max(0, Math.min(60, inner - s.label.length - 8)))}`, fg: t.acc, bold: true })
    // section help for the view screen (helpContents by role)
    const sectionHelp = helpEntryText(selectHelpContent((s as { helpContents?: unknown }).helpContents))
    if (sectionHelp) rows.push({ text: `  ${trunc(sectionHelp, inner - 4)}`, fg: t.dim })
    const tableNames = Object.keys(this.store.meta?.tables ?? {})
    const valueOf = (f: FieldMetaData) => f.type === 'BLOB' && !f.adornments?.some((a) => a.type === 'FILE_DOWNLOAD') ? blobText(rec, f.name) : valueText(f as FieldMeta, rec as never, { reveal: this.revealed.has(f.name), tableNames, tableName: this.tableName, primaryKey: this.primaryKey, widgets: this.store.meta?.widgets as never }).text
    // the value column is as wide as the field types need (metadata), never the values of this record
    const typeWidth = (f: FieldMetaData) => (f.type === 'DATE_TIME' ? 30 : f.type === 'DATE' ? 10 : f.type === 'TIME' ? 8 : f.type === 'BOOLEAN' ? 5 : ['INTEGER', 'LONG', 'DECIMAL'].includes(f.type) && !f.possibleValueSourceName ? 14 : Math.min(40, Number((f as { maxLength?: number }).maxLength ?? 24)))
    const longest = Math.max(12, ...fields.map((f) => typeWidth(f) + (linkTarget(this.store, f) ? 2 : 0)))
    const colWidth = Math.min(60, labelWidth + 2 + longest)
    const two = (view.recordColumns ?? (inner >= 2 * colWidth + 6 ? 2 : 1)) === 2 && inner >= 2 * Math.min(colWidth, 30) + 6
    const fieldText = (f: FieldMetaData) => {
      const v = valueText(f as FieldMeta, rec as never, { tableNames, widgets: this.store.meta?.widgets as never })
      const link = v.link ? ` ${g.link}` : v.file || isBlob(rec, f) ? ' [file: Enter saves]' : v.masked ? ' [Enter reveals]' : ''
      return `${pad(f.label, labelWidth)}  ${trunc(valueOf(f) + link, (two ? colWidth : Math.min(inner - 4, 100)) - labelWidth - 2)}`
    }
    // WIDGET-adorned fields (by metadata, so the same for every record): the value drawn as blocks under its label
    const widgetFields = fields.filter((f) => f.adornments?.some((a) => a.type === 'WIDGET'))
    for (const f of widgetFields) {
      rows.push({ text: `  ${f.label}`, fg: t.fg, bold: true })
      const wv = rec.values?.[f.name]
      if (wv === null || wv === undefined || wv === '') rows.push({ text: '    (none)', fg: t.dim })
      // a WIDGET-adorned field whose value is plain text (not a widget payload) shows the text
      else if (typeof wv !== 'object') rows.push({ text: `    ${String(wv)}` })
      else rows.push(...blockLines(widgetToBlocks(wv), inner - 6).map((l) => ({ ...l, text: `    ${l.text}` })))
    }
    const plainFields = fields.filter((f) => !widgetFields.includes(f))
    for (let i = 0; i < plainFields.length; i += two ? 2 : 1) {
      const pair = two ? plainFields.slice(i, i + 2) : [plainFields[i]!]
      const links = pair.filter((f) => { const v = valueText(f as FieldMeta, rec as never, { tableNames }); return Boolean(v.link || v.file || v.masked || isBlob(rec, f)) })
      const text = '  ' + (two ? pad(fieldText(pair[0]!), colWidth) + '    ' + (pair[1] ? fieldText(pair[1]) : '') : fieldText(pair[0]!))
      const chip = pair.some((f) => valueText(f as FieldMeta, rec as never, {}).adornment === 'CHIP' && cell(rec, f.name))
      rows.push({ text, key: `f:${pair[0]!.name}`, action: () => this.follow(links), ...(chip ? { fg: chipColor(pair.find((f) => valueText(f as FieldMeta, rec as never, {}).adornment === 'CHIP')!, rec) } : {}) })
    }
    return rows
  }

  /** A widget section. It keeps the tallest height it has had here, so stepping records (and loading) does not shrink it. */
  widgetRows(s: SectionMetaData, inner: number): Row[] {
    const t = theme()
    const g = glyphs()
    const meta = this.meta!
    const wname = s.widgetName!
    const rows: Row[] = [{ text: '' }]
    rows.push({ text: `${s.label} ${g.rule.repeat(Math.max(0, Math.min(60, inner - s.label.length - 2)))}`, fg: t.acc, bold: true, key: `w:${wname}`, action: () => this.widgetViews.get(wname)?.actionsMenu() })
    const w = this.widgets.get(wname)
    if (!w) rows.push({ text: '  loading…', fg: t.dim })
    else if ('error' in w) rows.push({ text: `  ${w.error}`, fg: t.err })
    else rows.push(...blockLines(w.filter((b) => b.kind !== 'heading'), inner - 2).map((l) => ({ ...l, text: '  ' + l.text })))
    const payload = this.widgetPayloads.get(wname) as { type?: string } | undefined
    if (payload && (payload.type ?? (this.store.meta?.widgets as Record<string, { type?: string }> | undefined)?.[wname]?.type) === 'dynamicForm' && (meta as { editPermission?: boolean }).editPermission !== false) {
      rows.push({ text: `  ${g.pointer} Edit these fields`, fg: t.acc, key: `dyn:${wname}`, action: () => this.editDynamicForm(wname) })
    }
    const height = Math.max(rows.length, this.widgetHeights.get(wname) ?? 0)
    if (w) this.widgetHeights.set(wname, height)
    return padRows(rows, height)
  }

  /** A child list: a box of fixed height (childRowCount data rows), padded when short, scrolled when long. */
  childRows(item: Extract<LayoutItem, { kind: 'children' }>, inner: number): Row[] {
    const t = theme()
    const g = glyphs()
    const { group, gi } = item
    const child = this.childMeta.get(group.table)
    const records = group.records as QueryRecord[]
    const rows = this.childRowCount()
    let offset = this.childOffsets.get(this.offsetKey(group)) ?? 0
    // back from a child record: scroll the list to the child viewed last
    if (this.openedChild?.gi === gi) {
      const at = this.openedChild.cursor.index
      if (at < offset) offset = at
      else if (at >= offset + rows) offset = at - rows + 1
    }
    offset = clampOffset(offset, records.length, rows)
    this.childOffsets.set(this.offsetKey(group), offset)
    const names = child ? item.columns.filter((n) => child.fields[n]) : []
    return childBox({
      heading: item.label,
      indent: '  '.repeat(Math.max(0, group.depth - 1)),
      inner,
      rows,
      offset,
      columns: names.map((n) => ({ label: child!.fields[n]!.label, width: childColumnWidth(child!.fields[n]!) })),
      cells: child ? records.map((r) => names.map((n) => fieldCell(r, child.fields[n]!))) : [],
      unavailable: group.unavailable ?? (child ? undefined : 'no metadata'),
      key: (index) => (index === undefined ? `c:${gi}` : `c:${gi}:${index}`),
      onHeading: () => this.newChild(group),
      onOpen: (index) => this.openChild(group, index),
      rule: g.rule,
      colors: { heading: t.acc, dim: t.dim },
    })
  }

  /** The child list the cursor is on (its heading or one of its rows), with the record index under the cursor. */
  focusedList(): { gi: number; group: AssociationGroup; index?: number } | undefined {
    const m = /^c:(\d+)(?::(\d+))?$/.exec(this.list.current?.key ?? '')
    if (!m) return undefined
    const gi = Number(m[1])
    const group = this.groups[gi]
    return group ? { gi, group, ...(m[2] !== undefined ? { index: Number(m[2]) } : {}) } : undefined
  }

  /**
   * Keys of a focused child list that has more rows than its box: PgDn/PgUp scroll it a box at a
   * time; Down/Up (j/k) scroll it a row at its edges. ] and [ still step records.
   */
  scrollList(key: Key): boolean {
    const focus = this.focusedList()
    if (!focus) return false
    const count = focus.group.records.length
    const rows = this.childRowCount()
    if (count <= rows) return false
    const okey = this.offsetKey(focus.group)
    const offset = this.childOffsets.get(okey) ?? 0
    const ch = charOf(key)
    const single = this.store.singleKeys
    let next = offset
    let index = focus.index
    if (key.name === 'pagedown' || key.name === 'pageup') {
      next = clampOffset(offset + (key.name === 'pagedown' ? rows : -rows), count, rows)
      if (next === offset) {
        this.store.flash(key.name === 'pagedown' ? `last rows of ${focus.group.label} (] steps to the next record)` : `first rows of ${focus.group.label} ([ steps to the previous record)`)
        return true
      }
      if (index !== undefined) index = Math.min(count - 1, Math.max(0, index + next - offset))
    } else if ((key.name === 'down' || (single && ch === 'j')) && index !== undefined && index === offset + rows - 1 && index < count - 1) {
      next = offset + 1
      index++
    } else if ((key.name === 'up' || (single && ch === 'k')) && index !== undefined && index === offset && offset > 0) {
      next = offset - 1
      index--
    } else if (single && (ch === 'j' || ch === 'k')) {
      return this.list.onKey({ name: ch === 'j' ? 'down' : 'up', sequence: '' })
    } else return false
    this.childOffsets.set(okey, next)
    this.build()
    const at = this.list.rows.findIndex((r) => r.key === (index === undefined ? `c:${focus.gi}` : `c:${focus.gi}:${index}`))
    if (at >= 0) this.list.cursor = at
    return true
  }

  /** The filter selecting this record's children of a group (kernel childFilter). */
  childFilterOf(group: AssociationGroup) {
    const child = this.childMeta.get(group.table)!
    const parentMeta = group.parentTable === this.tableName ? this.meta : this.childMeta.get(group.parentTable)
    const f = childFilter(group.association, parentMeta as unknown as TableMetaLike, group.parent as never, child as unknown as TableMetaLike)
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
    const values = Object.fromEntries((group.association.join?.joinOns ?? []).map((j) => [j.rightField, (group.parent as QueryRecord).values?.[j.leftField]]))
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
      if (isBlob(this.record, f)) return saveBlob(this.store, this.record!, this.tableName, String(this.primaryKey), f)
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
    if (!permits(this.meta as never, 'delete')) return this.store.flash('you may not delete records of this table', 'error')
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
    return { 3: null, 4: !permits(this.meta as never, 'edit') ? null : 'Edit', 6: null, 7: this.currentAssociation() ? 'NewChild' : !permits(this.meta as never, 'insert') ? null : 'New', 8: !permits(this.meta as never, 'delete') ? null : 'Delete' }
  }

  onKey(key: Key): boolean {
    const ch = charOf(key)
    if (this.scrollList(key)) return true
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
      case 'f4': if (this.primaryKey !== undefined) openForm(this.store, this.tableName, { mode: 'edit', primaryKey: this.primaryKey, tableVariant: this.tableVariant }); return true
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
      case 'c': if (this.primaryKey !== undefined) openForm(this.store, this.tableName, { mode: 'copy', primaryKey: this.primaryKey, tableVariant: this.tableVariant }); return true
      case 'd': this.deleteRecord(); return true
      case 'n': openForm(this.store, this.tableName, { mode: 'create' }); return true
      case 'r': this.refresh(); return true
      case 'l': this.list.current?.action?.(); return true
      case 'A': this.openAudits(); return true
      case 't': if (collaborationOf(this.store)) { this.openTags(); return true } return false
      case 'D': this.openDeveloper(); return true
      case 'Z': {
        const entry = this.shareEntry()[0]
        if (!entry) return false
        if (entry.disabled) this.store.flash(entry.disabled, 'error')
        else entry.run?.()
        return true
      }
      case 'a': actionsOverlay(this.store, this); return true
      default: return false
    }
  }

  /** Share (shareable tables): only the owner may share; others see why. */
  shareEntry(): MenuEntry[] {
    const state = shareState(this.store, this.meta as never, this.record as never)
    if (!state.offered) return []
    return [{ section: 'Context', label: 'Share with users and groups', key: 'Z', command: 'share', disabled: state.disabled, run: () => openShareDialog(this.store, this.meta as never, this.primaryKey!, this.title()) }]
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = [
      { section: 'Context', label: 'Edit this record', key: 'F4 e', disabled: permits(this.meta as never, 'edit') ? undefined : 'you may not edit records of this table', run: () => this.onKey({ name: 'f4', sequence: '' }) },
      { section: 'Context', label: 'Copy into a new record', key: 'c', disabled: permits(this.meta as never, 'insert') ? undefined : 'copying needs permission to create records', run: () => openForm(this.store, this.tableName, { mode: 'copy', primaryKey: this.primaryKey }) },
      { section: 'Context', label: 'Delete this record', key: 'F8 d', disabled: permits(this.meta as never, 'delete') ? undefined : 'you may not delete records of this table', run: () => this.deleteRecord() },
      { section: 'Context', label: `New ${this.meta?.label ?? this.tableName}`, key: 'F7 n', run: () => openForm(this.store, this.tableName, { mode: 'create' }) },
      { section: 'Context', label: 'Next record', key: 'PgDn ] Ctrl+N', disabled: this.cursor ? undefined : 'not opened from a list', run: () => this.step(1) },
      { section: 'Context', label: 'Previous record', key: 'PgUp [ Ctrl+P', disabled: this.cursor ? undefined : 'not opened from a list', run: () => this.step(-1) },
      { section: 'Context', label: 'Refresh', key: 'F5 r', run: () => this.refresh() },
      ...this.shareEntry(),
      { section: 'Context', label: 'View settings (columns, label width, child list rows)', key: 'v', run: () => { const o = this.viewSettings(); if (o) this.store.open(o) } },
      { section: 'Context', label: 'Copy as a CLI command', detail: `qqq ${this.cliEquivalent()}`, run: () => this.store.message(`qqq ${this.cliEquivalent()}`, 'info', 'CLI equivalent') },
    ]
    for (const group of this.groups) {
      const child = this.childMeta.get(group.table)
      for (const r of (group.records as QueryRecord[]).slice(0, 30)) {
        for (const f of Object.values(child?.fields ?? {})) {
          const v = valueText(f as FieldMeta, r as never, {})
          if (isBlob(r, f)) out.push({ section: 'Context', label: `Save ${f.label} of ${group.label} ${r.recordLabel ?? ''}`.trim(), run: () => saveBlob(this.store, r, group.table, String(r.values?.[child!.primaryKeyField] ?? ''), f) })
          else if (v.file?.route) {
            const route = v.file.route
            out.push({ section: 'Context', label: `Save ${f.label} of ${group.label} ${r.recordLabel ?? ''}`.trim(), detail: v.file.fileName, run: () => saveFile(this.store, `Save ${v.file!.fileName}`, v.file!.fileName, (p) => this.store.run(this.store.client!.call('downloadRecordFieldFile', { path: route }), (res) => { const b = res.bytes ?? new TextEncoder().encode(String(res.data ?? '')); this.store.message(`Saved ${saveDownload(p, b, { explicit: true })} (${b.length} bytes).`) })) })
          }
        }
      }
      out.push({ section: 'Context', label: `New ${group.label} for this record`, key: 'F7', run: () => this.newChild(group) })
      out.push({ section: 'Context', label: `Query all ${group.label} of this record`, run: () => import('../nav').then((n) => n.openTable(this.store, group.table, this.childFilterOf(group))) })
    }
    const tableNames = Object.keys(this.store.meta?.tables ?? {})
    for (const f of Object.values(this.meta?.fields ?? {})) {
      if (!this.record) break
      const v = valueText(f as FieldMeta, this.record as never, { tableNames })
      if (v.link) out.push({ section: 'Context', label: `Follow ${f.label}`, detail: cell(this.record, f.name), run: () => this.follow([f]) })
      if (v.file) out.push({ section: 'Context', label: `Download ${f.label}`, detail: v.file.fileName, run: () => this.download(f) })
      else if (isBlob(this.record, f)) out.push({ section: 'Context', label: `Save ${f.label}`, detail: blobText(this.record, f.name), run: () => saveBlob(this.store, this.record!, this.tableName, String(this.primaryKey), f) })
      if (v.masked) out.push({ section: 'Context', label: `Reveal ${f.label}`, run: () => this.follow([f]) })
    }
    for (const p of this.recordProcesses()) out.push({ section: 'Context', label: `Run ${p.label} on this record`, run: () => openProcess(this.store, p.name, { recordIds: [String(this.primaryKey)] }) })
    if (this.store.extensions.has('collaboration')) out.push({ section: 'Context', label: 'Tags…', key: 't', command: 'tags', detail: this.tags?.map((x) => x.label).join(', '), run: () => this.openTags() })
    out.push({ section: 'Context', label: 'Audit history', key: 'A', command: 'audits', run: () => this.openAudits() })
    out.push({ section: 'Context', label: 'Developer: security, events, scripts, JSON, metadata, audits, APIs', key: 'D', command: 'dev', run: () => this.openDeveloper() })
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
      ...[3, 5, 8, 10, 15].map((n) => ({ label: `Child list rows: ${n}${v.childRows === n ? ' (current)' : ''}`, value: `rows:${n}` })),
      { label: `Child list rows: profile default (${readChildRows(this.store.status.profile || undefined)})`, value: 'rows:default' },
      { label: 'Reset record view settings', value: 'reset' },
    ]
    return new ChoiceOverlay(this.store, `Record view settings · ${this.meta?.label ?? this.tableName}`, choices, (value) => {
      const next = { ...v }
      if (value === 'auto') delete next.recordColumns
      else if (value === '1' || value === '2') next.recordColumns = Number(value) as 1 | 2
      else if (value === 'rows:default') delete next.childRows
      else if (value.startsWith('rows:')) next.childRows = Number(value.slice(5))
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
