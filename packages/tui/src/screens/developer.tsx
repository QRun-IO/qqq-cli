/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { SELECT_HINT } from '../mouse/settings'
import { writeFileSync } from 'node:fs'
import { auditSource, displayDateTime, getAudits, getRecordDeveloper, getScriptLogs, getScriptRevisionFiles, getTableApiDocument, listDeveloperPanels, listTableApis, scriptText, storeScript, testScript, type AssociatedScript, type AuditEntry, type DeveloperPanel, type RecordDeveloper, type TableApi } from '@qrun-io/qqq-core'
import type { TableMetaData } from '../client'
import { emptySection, esbTableItems, loadingSection, metadataItems, panelSection, SectionNav, type Item, type LinkContext, type LinkTarget, type Section } from '../developer/model'
import { itemLines, PaneModel, sectionBar, sectionTitle, segColor, viewableText, type PaneLine, type Viewable } from '../developer/pane'
import { codeSegLines, jsonSegLines, textSegLines, wrapLine, wrapText } from '../developer/json'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openProcess, openRecord, openTable } from '../nav'
import { ChoiceOverlay, PromptOverlay } from '../overlays/basic'
import { saveFile } from '../overlays/files-helpers'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { errorText, trunc } from '../util/text'
import { Panel } from './list'

type J = Record<string, unknown>

const values = (record: unknown): J => (((record as J | undefined)?.values ?? {}) as J)

/** Copies text to the clipboard through the store, with a message saying how (or why it could not). */
function copy(store: AppStore, text: string, what: string): void {
  const how = store.copyText(text)
  if (how) store.flash(`copied ${what} (${text.length} characters, ${how})`)
  else store.flash('no clipboard here (no pbcopy, wl-copy, xclip or xsel, and the terminal has no OSC 52); v shows the value to select', 'error')
}

/**
 * The full value viewer: JSON pretty-printed and tinted, code and text as written; lines longer than
 * the width are soft-wrapped (every character kept, in order). y copies, Esc goes back.
 */
export class ValueScreen implements Screen {
  readonly kind = 'value'
  readonly id: string
  readonly pane = new PaneModel()

  constructor(private store: AppStore, readonly viewable: Viewable) {
    this.id = `value:${viewable.title}:${Date.now()}`
  }

  title(): string {
    return this.viewable.title
  }

  /** The value's lines soft-wrapped to a width. */
  lines(width: number): PaneLine[] {
    const t = theme()
    const v = this.viewable
    const source = v.code !== undefined ? codeSegLines(v.code, v.language).lines : typeof v.value === 'string' ? textSegLines(v.value) : jsonSegLines(v.value)
    return source.flatMap((line) => wrapLine(line, width).map((piece) => ({ spans: piece.map((s) => ({ text: s.text, fg: segColor(t, s.tone) })) })))
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: null }
  }

  onKey(key: Key): boolean {
    if (this.pane.onKey(key)) return true
    if (charOf(key) === 'y') {
      copy(this.store, viewableText(this.viewable), this.viewable.title)
      return true
    }
    return false
  }

  menu(): MenuEntry[] {
    return [{ section: 'Context', label: `Copy ${this.viewable.title}`, key: 'y', run: () => copy(this.store, viewableText(this.viewable), this.viewable.title) }]
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const inner = width - 2
    this.pane.update(this.lines(Math.max(1, inner - 2)), height - 3)
    return (
      <Panel title={this.title()} width={width} height={height} focused={focused} {...(this.pane.position() ? { bottomTitle: this.pane.position() } : {})}>
        {this.pane.view(inner, focused)}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{trunc(` ↑↓ PgUp PgDn scroll · y copy · Esc back${this.store.settings.mouse ? ` · ${SELECT_HINT}` : ''}`, inner).padEnd(inner)}</text>
      </Panel>
    )
  }
}

/** Text in the value viewer (a script revision, run logs, an OpenAPI document). */
export function textScreen(store: AppStore, title: string, text: string, language?: string): ValueScreen {
  return new ValueScreen(store, { title, code: text, ...(language ? { language } : {}) })
}

/**
 * The developer view shared by records and tables (docs/developer-view.md): a section bar (← → or
 * 1-9), the section's title, status and description, and its body in a scrollable pane with a
 * scroll bar. Enter follows the selected line, v opens the value viewer, y copies.
 */
abstract class DeveloperView implements Screen {
  abstract readonly kind: string
  readonly id: string
  readonly nav = new SectionNav()
  private panes = new Map<string, PaneModel>()
  protected loading = 0

  constructor(protected store: AppStore, readonly tableName: string, readonly heading: string) {
    this.id = `${heading}:${Date.now()}`
  }

  abstract refresh(): void
  /** The sections from what is loaded so far. */
  protected abstract sections(): Section[]
  /** F3: the record or the grid this view belongs to. */
  protected abstract up(): void
  protected abstract upLabel(): string

  title(): string {
    return this.heading
  }

  protected tableLabel(): string {
    return this.store.meta?.tables?.[this.tableName]?.label ?? this.tableName
  }

  /** Rebuilds the sections (after each load), staying on the same one. */
  protected rebuild(): void {
    this.nav.set(this.sections())
    this.store.bump()
  }

  /** Runs a load; the view repaints as each part arrives. */
  protected load<T>(work: Promise<T>, done: (value: T) => void, failed: (error: unknown) => void): void {
    this.loading++
    work.then(done, failed).finally(() => {
      this.loading--
      this.rebuild()
    })
  }

  protected linkContext(): LinkContext {
    return { server: this.store.client?.server ?? '', tables: (this.store.meta?.tables ?? {}) as Record<string, unknown>, processes: (this.store.meta?.processes ?? {}) as Record<string, unknown> }
  }

  /** What Enter does on a link: TUI screens for TUI destinations; browser-only ones say so. */
  readonly act = (target: LinkTarget): (() => void) | undefined => {
    const s = this.store
    switch (target.kind) {
      case 'table-developer': return () => s.push(new TableDeveloperScreen(s, target.table))
      case 'record-developer': return () => s.push(new DeveloperScreen(s, target.table, target.primaryKey))
      case 'record': return () => openRecord(s, target.table, target.primaryKey)
      case 'table': return () => openTable(s, target.table)
      case 'process': return () => openProcess(s, target.process, target.recordId !== undefined ? { recordIds: [target.recordId] } : {})
      case 'browser': return () => s.flash(`browser only: ${target.url} (the TUI has no screen for it; y copies the URL)`)
    }
  }

  pane(): PaneModel {
    const id = this.nav.current?.id ?? ''
    let pane = this.panes.get(id)
    if (!pane) {
      pane = new PaneModel()
      this.panes.set(id, pane)
    }
    return pane
  }

  /** Opens the value viewer on a viewable. */
  view(v: Viewable): void {
    this.store.push(new ValueScreen(this.store, v))
  }

  fkeys(): FKeyLabels {
    return { 3: this.upLabel(), 4: null, 6: null, 7: null, 8: null }
  }

  keyLine(): string {
    const single = this.store.singleKeys
    return `←→${single ? ` ${this.nav.digits()}` : ''} section · ↑↓ scroll · Enter open${single ? ' · v view · y copy' : ''} · Esc back`
  }

  /** Developer keys for the help overlay (F1, ?). */
  helpKeys(): Array<[string, string]> {
    const names = this.nav.sections.slice(0, 9).map((s, i) => `${i + 1} ${s.label}`).join(', ')
    return [
      ['← →  1-9', `developer section: ${names}`],
      ['↑↓ PgUp PgDn', 'scroll the section; the cursor stops on lines that do something'],
      ['Enter', 'follow the line: open a link, a revision, a row, a value'],
      ['v', 'view the selected value in full (JSON pretty-printed, long lines wrapped)'],
      ['y', 'copy the selected value to the clipboard'],
      [`F3`, this.upLabel() === 'Record' ? 'the record this view is for' : 'the table grid'],
      ['F5', 'reload every section'],
      ['Esc', 'back, to the row you were on'],
    ]
  }

  onKey(key: Key): boolean {
    const pane = this.pane()
    const ch = charOf(key)
    if (key.name === 'left' || key.name === 'right' || (this.store.singleKeys && /^[1-9]$/.test(ch ?? '') && !key.ctrl && !key.meta)) {
      return this.nav.onKey(key.name === 'left' || key.name === 'right' ? key.name : ch!)
    }
    if (pane.onKey(key)) return true
    const line = pane.current
    if (key.name === 'return') {
      if (line?.run) line.run()
      else if (line?.view) this.view(line.view)
      return true
    }
    if (key.name === 'f3') {
      this.up()
      return true
    }
    if (this.store.singleKeys && ch === 'v') {
      if (line?.view) this.view(line.view)
      else this.store.flash('nothing to view on this line: move to a value, a row or a JSON block')
      return true
    }
    if (this.store.singleKeys && ch === 'y') {
      if (line?.copy !== undefined) copy(this.store, line.copy, line.label ?? 'the value')
      else this.store.flash('nothing to copy on this line')
      return true
    }
    return false
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = this.nav.sections.map((s, i) => ({ section: 'Context' as const, label: `Section: ${s.label}${s.status ? ` (${s.status})` : ''}`, ...(i < 9 ? { key: String(i + 1) } : {}), run: () => { this.nav.index = i } }))
    const line = this.pane().current
    if (line?.view) out.push({ section: 'Context', label: `View ${line.label ?? 'the value'}`, key: 'v', run: () => this.view(line.view!) })
    if (line?.copy !== undefined) out.push({ section: 'Context', label: `Copy ${line.label ?? 'the value'}`, key: 'y', run: () => copy(this.store, line.copy!, line.label ?? 'the value') })
    for (const l of this.pane().lines.filter((x) => x.run).slice(0, 20)) out.push({ section: 'Context', label: l.label ?? 'Open', run: l.run })
    out.push({ section: 'Context', label: this.upLabel() === 'Record' ? 'View the record' : 'Back to the grid', key: 'F3', run: () => this.up() })
    return out
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const inner = width - 2
    if (!this.nav.sections.length) this.nav.set(this.sections())
    const section = this.nav.current
    const description = section?.description ? wrapText(section.description, inner - 1).slice(0, 2) : []
    const bodyHeight = Math.max(1, height - 2 - 1 - 1 - description.length - 1 - 1)
    const pane = this.pane()
    // the body: a one-cell margin, the lines, and a column for the scroll bar
    pane.update(section ? itemLines(section, Math.max(1, inner - 2), this.act) : [], bodyHeight)
    const busy = this.loading > 0 ? ' · loading…' : ''
    return (
      <Panel title={this.heading} width={width} height={height} focused={focused} {...(pane.position() ? { bottomTitle: pane.position() } : {})}>
        {sectionBar(this.nav.sections, this.nav.index, inner, focused, (i) => { this.nav.index = i })}
        {section ? sectionTitle(section, inner) : <text flexShrink={0} wrapMode="none">{''.padEnd(inner)}</text>}
        {description.map((d, i) => <text flexShrink={0} wrapMode="none" key={`d${i}`} fg={t.dim}>{` ${trunc(d, inner - 1)}`.padEnd(inner)}</text>)}
        <text flexShrink={0} wrapMode="none" fg={t.border}>{glyphs().rule.repeat(Math.max(0, inner))}</text>
        {pane.view(inner, focused, () => this.onKey({ name: 'return', sequence: '' }))}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{trunc(` ${this.keyLine()}${busy}`, inner).padEnd(inner)}</text>
      </Panel>
    )
  }
}

/** The metadata, JSON and APIs sections, shared by the record and table views. */
function apisItems(view: DeveloperView, store: AppStore, tableName: string, apis: TableApi[]): Item[] {
  if (!apis.length) return [{ kind: 'empty', text: 'No application API exposes this table.' }]
  const items: Item[] = []
  for (const a of apis) {
    items.push({ kind: 'heading', text: `${a.label} (${a.name})` })
    items.push({ kind: 'pairs', pairs: [{ label: 'Path', value: a.path }, { label: 'Current version', value: a.currentVersion ?? '' }] })
    items.push({
      kind: 'grid', title: a.label, headers: ['Version', 'Current', 'Semantic version', 'Table spec'], empty: 'The API has no versions.',
      rows: a.versions.map((v) => ({ cells: [v.version, v.version === a.currentVersion ? 'current' : '', v.semanticVersion ?? '', v.tableSpecPath ?? ''], value: v, run: () => apiDocument(view, store, tableName, a.name, v.version) })),
    })
  }
  items.push({ kind: 'text', text: 'Enter on a version opens its OpenAPI document (view it here or save it to a file).', tone: 'dim' })
  return items
}

function apiDocument(view: DeveloperView, store: AppStore, tableName: string, api: string, version: string): void {
  const c = store.client!
  store.run(getTableApiDocument(c.server, c.fetch, tableName, api, version), (doc) => {
    const text = JSON.stringify(doc, null, 2)
    store.open(new ChoiceOverlay(store, `${api} ${version} OpenAPI document`, [{ label: 'View it here', value: 'view' }, { label: 'Save it to a file', value: 'save' }], (what) => {
      if (what === 'view') view.view({ title: `${api} ${version} · ${tableName}`, value: doc })
      else saveFile(store, 'Save the OpenAPI document', `${tableName}-${api}-${version}.json`, (path) => { writeFileSync(path, text); store.message(`Wrote ${path}.`) })
    }))
  })
}

/**
 * Developer mode for a record (REC-053, REC-054): Security, Events, Scripts, JSON, Metadata, Audits
 * and APIs sections, then one section per further developer panel (Quick Search, SQL Workbench…).
 */
export class DeveloperScreen extends DeveloperView {
  readonly kind = 'developer'
  private panels?: DeveloperPanel[]
  private panelsError?: string
  private developer?: RecordDeveloper
  private developerError?: string
  private meta?: TableMetaData
  private metaError?: string
  private audits?: { entries: AuditEntry[]; total: number | null }
  private auditsError?: string
  private apis?: TableApi[]
  private apisError?: string

  constructor(store: AppStore, tableName: string, readonly primaryKey: string) {
    super(store, tableName, `Developer · ${store.meta?.tables?.[tableName]?.label ?? tableName} ${primaryKey}`)
    this.refresh()
  }

  protected upLabel(): string {
    return 'Record'
  }

  protected up(): void {
    const below = this.store.routes[this.store.routes.length - 2] as { kind?: string; tableName?: string; primaryKey?: unknown } | undefined
    if (below?.kind === 'record' && below.tableName === this.tableName && String(below.primaryKey) === this.primaryKey) this.store.back()
    else openRecord(this.store, this.tableName, this.primaryKey)
  }

  helpTopic() {
    return { kind: 'table' as const, name: this.tableName }
  }

  refresh(): void {
    const s = this.store
    const c = s.client!
    this.panels = this.developer = this.meta = this.audits = this.apis = undefined
    this.panelsError = this.developerError = this.metaError = this.auditsError = this.apisError = undefined
    this.load(listDeveloperPanels(c.server, c.fetch, this.tableName, this.primaryKey), (p) => { this.panels = p }, (e) => { this.panelsError = errorText(e); this.panels = [] })
    this.load(getRecordDeveloper(c.server, c.fetch, this.tableName, this.primaryKey), (d) => { this.developer = d }, (e) => { this.developerError = errorText(e) })
    this.load(listTableApis(c.server, c.fetch, this.tableName), (a) => { this.apis = a }, (e) => { this.apisError = errorText(e) })
    this.load(c.tableMeta(this.tableName).then((meta) => {
      this.meta = meta
      const source = auditSource(meta as never, (s.meta ?? {}) as never)
      if (!source) throw new Error(`No audit history is available for ${meta.label}: there is no audit process or audit table you may read.`)
      return getAudits(c.server, c.fetch, source, this.tableName, this.primaryKey)
    }), (a) => { this.audits = a }, (e) => { this.auditsError = errorText(e) })
    this.rebuild()
  }

  protected sections(): Section[] {
    const ctx = this.linkContext()
    const out: Section[] = []
    const panel = (id: string) => this.panels?.find((p) => p.id === id)
    const panelOr = (id: string, sid: string, label: string, title: string, why: string): Section => {
      if (!this.panels) return loadingSection(sid, label, title)
      const p = panel(id)
      if (p) return panelSection(p, ctx, { id: sid, label, recordId: this.primaryKey })
      return emptySection(sid, label, title, this.panelsError ? `The developer panels could not be loaded: ${this.panelsError}` : why)
    }
    out.push(panelOr('recordSecurity', 'security', 'Security', 'Record Security', 'The server has no record security panel for this table (the provider is not installed).'))
    out.push(panelOr('esb', 'events', 'Events', 'ESB Events', 'The server has no ESB panel for this table: the ESB module is not installed, or the table does not publish events.'))
    out.push(this.scriptsSection())
    out.push(this.jsonSection())
    out.push(this.metaError ? emptySection('metadata', 'Metadata', 'Table Metadata', `The table metadata could not be loaded: ${this.metaError}`) : this.meta ? { id: 'metadata', label: 'Metadata', title: 'Table Metadata', description: `${this.meta.label} (${this.meta.name}): fields, sections, permissions and capabilities.`, items: metadataItems(this.meta as unknown as J) } : loadingSection('metadata', 'Metadata', 'Table Metadata'))
    out.push(this.auditsSection())
    out.push(this.apisError ? emptySection('apis', 'APIs', 'Application APIs', `The application APIs could not be listed: ${this.apisError}`) : this.apis ? { id: 'apis', label: 'APIs', title: 'Application APIs', description: 'The application APIs that expose this table, with their OpenAPI documents.', items: apisItems(this, this.store, this.tableName, this.apis) } : loadingSection('apis', 'APIs', 'Application APIs'))
    for (const p of this.panels ?? []) if (p.id !== 'recordSecurity' && p.id !== 'esb') out.push(panelSection(p, ctx, { recordId: this.primaryKey }))
    return out
  }

  private fieldLabel(name: string): string {
    return this.meta?.fields?.[name]?.label ?? name
  }

  private scriptsSection(): Section {
    const base = { id: 'scripts', label: 'Scripts', title: 'Associated Scripts' }
    if (this.developerError) return emptySection(base.id, base.label, base.title, `The record's developer data could not be loaded: ${this.developerError}`)
    if (!this.developer) return loadingSection(base.id, base.label, base.title)
    const scripts = this.developer.scripts
    if (!scripts.length) return emptySection(base.id, base.label, base.title, 'This table has no associated script fields.')
    const items: Item[] = []
    for (const script of scripts) {
      const v = values(script.script)
      const type = values(script.scriptType)
      const current = script.revisions.find((r) => String(values(r).id) === String(v.currentScriptRevisionId))
      items.push({ kind: 'heading', text: `${this.fieldLabel(script.fieldName)} (${script.fieldName})` })
      items.push({ kind: 'pairs', pairs: [
        { label: 'Script', value: script.script ? `${String(v.name ?? '')} (id ${String(v.id ?? '')})` : '' },
        { label: 'Type', value: String(type.name ?? script.scriptTypeId ?? '') },
        { label: 'Current revision', value: current ? `v${String(values(current).sequenceNo ?? '?')}` : '' },
        { label: 'Test inputs', value: script.testInputFields.map((f) => String(f.label ?? f.name ?? '')).join(', ') },
      ] })
      items.push({ kind: 'action', label: script.script ? 'Store a new version from $EDITOR' : 'Create the script from $EDITOR', detail: 'opens the latest code in your editor, then asks for a commit message', run: () => this.storeVersion(script) })
      items.push({
        kind: 'grid', title: `${script.fieldName} revisions`, headers: ['Version', 'Message', 'Author', 'Created'], empty: 'No revisions yet: the line above stores the first version.',
        rows: script.revisions.slice(0, 50).map((r) => {
          const rv = values(r)
          return { cells: [`v${String(rv.sequenceNo ?? '?')}`, String(rv.commitMessage ?? ''), String(rv.author ?? ''), rv.createDate ? displayDateTime(rv.createDate) : ''], value: rv, run: () => this.revisionActions(script, String(rv.id), `v${String(rv.sequenceNo ?? '?')} ${String(rv.commitMessage ?? '')}`.trim()) }
        }),
      })
    }
    items.push({ kind: 'text', text: 'Enter on a revision: show its code, its run logs, or test-run it.', tone: 'dim' })
    return { ...base, description: 'Scripts referenced by this record, with their revisions; store new versions, read code and logs, run tests.', items }
  }

  private jsonSection(): Section {
    const base = { id: 'json', label: 'JSON', title: 'Record JSON' }
    if (this.developerError) return emptySection(base.id, base.label, base.title, `The record could not be loaded: ${this.developerError}`)
    if (!this.developer) return loadingSection(base.id, base.label, base.title)
    const record = this.developer.record
    const raw = values(record)
    const display = ((record.displayValues ?? {}) as J)
    const server = this.store.client?.server.replace(/\/+$/, '') ?? ''
    const path = `/qqq/v1/table/${encodeURIComponent(this.tableName)}/${encodeURIComponent(this.primaryKey)}`
    const names = [...Object.keys(raw), ...Object.keys(display).filter((f) => !(f in raw))]
    const show = (x: unknown) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))
    return {
      ...base,
      description: 'The record as the API returns it: its endpoints, each field\'s display and raw value, and the raw values as JSON.',
      items: [
        { kind: 'heading', text: 'API' },
        { kind: 'pairs', pairs: [{ label: 'Get', value: `GET ${server}${path}` }, { label: 'Update', value: `PATCH ${server}${path}` }, { label: 'Delete', value: `DELETE ${server}${path}` }] },
        { kind: 'heading', text: 'Values' },
        { kind: 'grid', title: 'Field', headers: ['Field', 'Name', 'Display value', 'Raw value'], rows: names.map((f) => ({ cells: [this.fieldLabel(f), f, show(display[f]), show(raw[f])], value: { field: f, displayValue: display[f], rawValue: raw[f] } })), empty: 'The record has no values.' },
        { kind: 'code', label: 'Record raw values', language: 'json', value: raw },
      ],
    }
  }

  private auditsSection(): Section {
    const base = { id: 'audits', label: 'Audits', title: 'Audits' }
    if (this.auditsError) return emptySection(base.id, base.label, base.title, this.auditsError)
    if (!this.audits) return loadingSection(base.id, base.label, base.title)
    const { entries, total } = this.audits
    if (!entries.length) return emptySection(base.id, base.label, base.title, 'No audit entries: this record has not been changed since auditing started.')
    const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v))
    const changeText = (e: AuditEntry) => [e.message, ...e.changes.map((c) => c.message ?? `${c.fieldName}: ${show(c.oldValue)} → ${show(c.newValue)}`)].filter(Boolean).join('\n')
    return {
      ...base,
      description: `${entries.length}${total !== null ? ` of ${total}` : ''} audit entr${entries.length === 1 ? 'y' : 'ies'}, newest first. Enter shows an entry's changes.`,
      items: [{
        kind: 'grid', title: 'Audit', headers: ['When', 'User', 'Action', 'Changes'],
        rows: entries.map((e) => ({ cells: [displayDateTime(e.timestamp), e.user || '(unknown user)', e.action, e.changes.length ? `${e.changes.length}: ${e.changes.map((c) => c.fieldName).join(', ')}` : e.message], value: e, run: () => this.view({ title: `Audit · ${displayDateTime(e.timestamp)} · ${e.user || '(unknown user)'} · ${e.action}`, code: changeText(e) || '(no field changes recorded)', language: 'text' }) })),
      }],
    }
  }

  revisionActions(script: AssociatedScript, revisionId: string, label: string): void {
    const s = this.store
    const c = s.client!
    const canTest = Boolean(s.meta?.processes?.testScript) && script.script !== undefined
    const choices = [{ label: 'Show the code', value: 'code' }, { label: 'Show the run logs', value: 'logs' }, ...(canTest ? [{ label: 'Test-run this revision', value: 'test' }] : [])]
    s.open(new ChoiceOverlay(s, `${script.fieldName} · ${label}`, choices, (what) => {
      const revision = script.revisions.find((r) => String(values(r).id) === revisionId)
      if (what === 'code') {
        s.run(getScriptRevisionFiles(c.server, c.fetch, revisionId), (files) => s.push(textScreen(s, `${script.fieldName} · ${label}`, scriptText(revision, files) || '(this revision has no code)')))
      } else if (what === 'logs') {
        s.run(getScriptLogs(c.server, c.fetch, this.tableName, this.primaryKey, script.fieldName, revisionId), (logs) => {
          const text = logs.length ? logs.map((l) => [`${l.startTimestamp} → ${l.endTimestamp}${l.hadError ? `  ERROR ${l.error}` : ''}`, ...l.lines.map((x) => `  ${x.timestamp}  ${x.text}`)].join('\n')).join('\n\n') : '(no runs logged for this revision)'
          s.push(textScreen(s, `Logs · ${script.fieldName} · ${label}`, text, 'text'))
        })
      } else {
        this.testRun(script, revision, label)
      }
    }))
  }

  /** Asks for each test input, then runs the revision's code with the testScript process. */
  private testRun(script: AssociatedScript, revision: J | undefined, label: string): void {
    const s = this.store
    const c = s.client!
    const rv = values(revision)
    const fields = script.testInputFields.map((f) => ({ name: String(f.name ?? ''), label: String(f.label ?? f.name ?? '') })).filter((f) => f.name)
    const inputs: Record<string, string> = {}
    const ask = (i: number) => {
      if (i >= fields.length) {
        s.run(getScriptRevisionFiles(c.server, c.fetch, String(rv.id)).then((files) => testScript(c.server, c.fetch, {
          scriptId: values(script.script).id,
          ...(rv.apiName ? { apiName: String(rv.apiName) } : {}),
          ...(rv.apiVersion ? { apiVersion: String(rv.apiVersion) } : {}),
          files: files.length ? files : [{ fileName: 'script.js', contents: scriptText(revision, files) }],
          inputs,
        })), (result) => {
          this.view({ title: `Test run · ${script.fieldName} · ${label}`, value: { output: result.output ?? null, ...(result.exception ? { exception: result.exception } : {}), logLines: result.logLines } })
        })
        return
      }
      const f = fields[i]!
      s.open(new PromptOverlay(s, `Test input: ${f.label}`, `${i + 1} of ${fields.length} · Enter goes on, Esc cancels the test run`, (value) => { inputs[f.name] = value; ask(i + 1) }))
    }
    ask(0)
  }

  storeVersion(script: AssociatedScript): void {
    const s = this.store
    const c = s.client!
    const latest = script.revisions[0]
    const load = latest ? getScriptRevisionFiles(c.server, c.fetch, String(values(latest).id)).then((files) => scriptText(latest, files)) : Promise.resolve('')
    s.run(load.then((text) => s.editExternal(text)), (edited) => {
      s.open(new PromptOverlay(s, 'Commit message', `A new version of ${script.fieldName} is stored with this message.`, (message) => {
        s.run(storeScript(c.server, c.fetch, this.tableName, this.primaryKey, script.fieldName, edited, message || undefined), (r) => {
          s.flash(`stored ${r.scriptName} version ${r.scriptRevisionSequenceNo}`)
          this.refresh()
        })
      }))
    })
  }
}

/** Developer mode for a table: Events (the ESB with counters), JSON (the metadata), Metadata and APIs. */
export class TableDeveloperScreen extends DeveloperView {
  readonly kind = 'table-developer'
  private meta?: TableMetaData
  private metaError?: string
  private esb?: J
  private esbError?: string
  private apis?: TableApi[]
  private apisError?: string

  constructor(store: AppStore, tableName: string) {
    super(store, tableName, `Developer · ${store.meta?.tables?.[tableName]?.label ?? tableName}`)
    this.refresh()
  }

  protected upLabel(): string {
    return 'Table'
  }

  protected up(): void {
    const below = this.store.routes[this.store.routes.length - 2] as { kind?: string; tableName?: string } | undefined
    if (below?.kind === 'table' && below.tableName === this.tableName) this.store.back()
    else openTable(this.store, this.tableName)
  }

  helpTopic() {
    return { kind: 'table' as const, name: this.tableName }
  }

  refresh(): void {
    const c = this.store.client!
    this.meta = this.esb = this.apis = undefined
    this.metaError = this.esbError = this.apisError = undefined
    this.load(c.tableMeta(this.tableName, true), (m) => { this.meta = m }, (e) => { this.metaError = errorText(e) })
    this.load(c.data<J>('getEsbTableByTable', { path: { table: this.tableName } }), (d) => { this.esb = d }, (e) => { this.esbError = errorText(e) })
    this.load(listTableApis(c.server, c.fetch, this.tableName), (a) => { this.apis = a }, (e) => { this.apisError = errorText(e) })
    this.rebuild()
  }

  protected sections(): Section[] {
    const ctx = this.linkContext()
    const label = this.tableLabel()
    const events: Section = this.esbError
      ? emptySection('events', 'Events', 'ESB Events', `No ESB information: the ESB module is not installed on this server, or you may not read it (${this.esbError}).`)
      : this.esb
        ? { id: 'events', label: 'Events', title: 'ESB Events', description: `What ${label} publishes to the ESB and which processes its events trigger, with message counters since the server started.`, items: esbTableItems(this.esb, ctx, (iso) => displayDateTime(iso)) }
        : loadingSection('events', 'Events', 'ESB Events')
    const json: Section = this.metaError ? emptySection('json', 'JSON', 'Table JSON', `The table metadata could not be loaded: ${this.metaError}`) : this.meta ? { id: 'json', label: 'JSON', title: 'Table JSON', description: 'The full table metadata as the server sends it.', items: [{ kind: 'code', label: 'Full table metadata', language: 'json', value: this.meta }] } : loadingSection('json', 'JSON', 'Table JSON')
    const metadata: Section = this.metaError ? emptySection('metadata', 'Metadata', 'Table Metadata', `The table metadata could not be loaded: ${this.metaError}`) : this.meta ? { id: 'metadata', label: 'Metadata', title: 'Table Metadata', description: `${this.meta.label} (${this.meta.name}): fields, sections, permissions and capabilities.`, items: metadataItems(this.meta as unknown as J) } : loadingSection('metadata', 'Metadata', 'Table Metadata')
    const apis: Section = this.apisError ? emptySection('apis', 'APIs', 'Application APIs', `The application APIs could not be listed: ${this.apisError}`) : this.apis ? { id: 'apis', label: 'APIs', title: 'Application APIs', description: 'The application APIs that expose this table, with their OpenAPI documents.', items: apisItems(this, this.store, this.tableName, this.apis) } : loadingSection('apis', 'APIs', 'Application APIs')
    return [events, json, metadata, apis]
  }
}
