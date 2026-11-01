/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The SQL Runner: the terminal face of the qbit-sql-workbench notebook (the Next UI's Runner page,
 * a SQL_WORKBENCH widget). Laid out like a classic database TUI: the SQL editor on top, the result
 * grid below with a status line, an optional schema browser on the right. Everything goes through
 * the `sql-workbench` UI API extension: capabilities, schema, execute and paged rows, EXPLAIN,
 * history, notebooks, export. Read-only runs only (the server's default session).
 */

import { writeFileSync } from 'node:fs'
import type { ReactNode } from 'react'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { ChoiceOverlay, MessageOverlay, PromptOverlay, wrap } from '../overlays/basic'
import { saveFile } from '../overlays/files-helpers'
import { visibleFrom, type GridColumn } from '../screens/table'
import type { AppStore } from '../store'
import { borderProps, glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { errorText, num, pad, padLeft, shellQuote, trunc } from '../util/text'
import { runnerApps } from './apps'
import {
  SqlBuffer, SqlHistory, cellSummary, coerceParameter, commonPrefix, complete, errorPosition, extractParameters, keywordSet, markdownLines,
  moveCell, newCellKey, notebookRequest, scratchNotebook, schemaTables, statementAt, tokenLines, type Notebook, type NotebookCell, type SqlPosition, type SqlSchema, type Token,
} from './model'
import { CellsOverlay, HistoryOverlay, NotebooksOverlay, type HistoryEntry } from './overlays'
import { ResultPager, barLines, fullValueText, numericColumns, planLineText, planLines, sqlColumns, valueText, type ExecuteResponse, type ExplainResponse, type RowsResponse } from './results'

/** GET /sql-workbench/capabilities. */
export interface Capabilities {
  version?: string
  canWrite?: boolean
  canShare?: boolean
  writeModeEnabled?: boolean
  limits?: { maxRows?: number; pageSize?: number; maxPageSize?: number; statementTimeoutSeconds?: number; maxSqlLength?: number }
  backends?: Array<{ name: string; label?: string; vendor?: string; dialect?: string; readOnlyCredentials?: boolean; readOnlyEnforced?: boolean; transactionalDdl?: boolean; writeAllowed?: boolean }>
}

/** What a cell shows below the editor: its last result, plan or error, and the grid's cursor. */
interface CellState {
  response?: ExecuteResponse
  pager?: ResultPager
  explain?: ExplainResponse
  error?: { message: string; status?: string; sqlState?: string | null; position?: SqlPosition; statementStart: number }
  view: 'grid' | 'plan' | 'chart'
  row: number
  top: number
  col: number
  left: number
  planCursor: number
  planTop: number
  collapsed: Set<string>
  raw: boolean
  chartValue?: number
  chartLabel?: number
  ms?: number
  backend?: string
  cols?: { key: string; cols: GridColumn[] }
}

interface Seg { text: string; fg?: string; bg?: string }

/** Cuts styled segments to exactly `width` cells (padding the rest). */
function fitSegs(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    if (used >= width) break
    const text = used + s.text.length > width ? trunc(s.text, width - used) : s.text
    out.push({ ...s, text })
    used += text.length
  }
  if (used < width) out.push({ text: ' '.repeat(width - used) })
  return out
}

function SegLine(props: { segs: Seg[]; width: number; bg?: string; fg?: string }) {
  return (
    <text flexShrink={0} wrapMode="none" fg={props.fg ?? theme().fg} bg={props.bg}>
      {fitSegs(props.segs, props.width).map((s, i) => <span key={i} fg={s.fg ?? props.fg ?? theme().fg} bg={s.bg ?? props.bg}>{s.text}</span>)}
    </text>
  )
}

function PlainLine(props: { text: string; width: number; fg?: string; bg?: string }) {
  return <text flexShrink={0} wrapMode="none" fg={props.fg ?? theme().fg} bg={props.bg}>{pad(props.text, props.width)}</text>
}

const CHUNK = 100
let ids = 0

/** The schema browser on the right: backends → tables → columns, filtered as you type. */
class SchemaPane {
  expanded = new Set<string>()
  cursor = 0
  top = 0
  filter = ''

  items(screen: SqlRunnerScreen): Array<{ key: string; depth: number; text: string; detail?: string; kind: 'backend' | 'table' | 'column' | 'note'; name: string; backend: string }> {
    const out: ReturnType<SchemaPane['items']> = []
    const needle = this.filter.toUpperCase()
    for (const b of screen.caps?.backends ?? []) {
      const bkey = `b:${b.name}`
      const open = this.expanded.has(bkey) || Boolean(needle)
      out.push({ key: bkey, depth: 0, text: `${open ? glyphs().open : glyphs().closed} ${b.label ?? b.name}`, detail: b.dialect, kind: 'backend', name: b.name, backend: b.name })
      if (!open) continue
      const schema = screen.schemas.get(b.name)
      if (!schema || schema === 'loading') {
        out.push({ key: `${bkey}:loading`, depth: 1, text: schema === 'loading' ? 'loading…' : '→ loads the tables', kind: 'note', name: '', backend: b.name })
        continue
      }
      if ('error' in schema) {
        out.push({ key: `${bkey}:error`, depth: 1, text: `cannot read: ${schema.error}`, kind: 'note', name: '', backend: b.name })
        continue
      }
      const tables = schemaTables(schema).filter((t) => !needle || t.name.toUpperCase().includes(needle) || t.columns.some((c) => c.name.toUpperCase().includes(needle)))
      if (!tables.length) out.push({ key: `${bkey}:none`, depth: 1, text: needle ? '(no table matches)' : '(no tables)', kind: 'note', name: '', backend: b.name })
      for (const t of tables) {
        const tkey = `t:${b.name}:${t.schema}.${t.name}`
        const topen = this.expanded.has(tkey)
        out.push({ key: tkey, depth: 1, text: `${topen ? glyphs().open : glyphs().closed} ${t.name}`, detail: `${t.columns.length}`, kind: 'table', name: t.name, backend: b.name })
        if (topen) for (const c of t.columns) out.push({ key: `${tkey}:${c.name}`, depth: 2, text: c.name, detail: c.typeName, kind: 'column', name: c.name, backend: b.name })
      }
      if ((schema as SqlSchema).truncated) out.push({ key: `${bkey}:trunc`, depth: 1, text: '(more tables: the server caps the list)', kind: 'note', name: '', backend: b.name })
    }
    return out
  }
}

export class SqlRunnerScreen implements Screen {
  readonly kind = 'sql'
  readonly id = `sql:${++ids}`
  notebook: Notebook
  cellIndex = 0
  readonly buffer = new SqlBuffer('')
  edited = false
  caps?: Capabilities
  capsError?: string
  readonly schemas = new Map<string, SqlSchema | 'loading' | { error: string }>()
  readonly states = new Map<string, CellState>()
  focus: 'editor' | 'results' | 'schema' = 'editor'
  showSchema = false
  readonly schemaPane = new SchemaPane()
  completion?: { from: number; candidates: string[]; index: number; base: string }
  running?: { uuid: string; cellKey: string; label: string; at: number }
  /** Parameter values by name (what was typed last; notebook defaults first). */
  values: Record<string, string> = {}
  history: SqlHistory
  private readonly abort = new AbortController()
  private lastRender = { editorLines: 6, gridRows: 10, width: 80 }

  constructor(private store: AppStore, options: { sql?: string; run?: boolean; notebookId?: number; history?: SqlHistory } = {}) {
    this.notebook = scratchNotebook(options.sql ?? '')
    this.buffer.set(options.sql ?? '')
    this.history = options.history ?? new SqlHistory()
    this.load(options)
  }

  private get client() {
    return this.store.client!.withSignal(this.abort.signal)
  }

  get cell(): NotebookCell {
    return this.notebook.cells[this.cellIndex]!
  }

  state(cell: NotebookCell = this.cell): CellState {
    let s = this.states.get(cell.cellKey)
    if (!s) {
      s = { view: 'grid', row: 0, top: 0, col: 0, left: 0, planCursor: 0, planTop: 0, collapsed: new Set(), raw: false }
      this.states.set(cell.cellKey, s)
    }
    return s
  }

  /** The backend a cell runs on: its own, the notebook default, else the first the server offers. */
  backendOf(cell: NotebookCell = this.cell): string | undefined {
    const names = (this.caps?.backends ?? []).map((b) => b.name)
    for (const n of [cell.backendName, this.notebook.defaultBackendName]) if (n && (!names.length || names.includes(n))) return n
    return names[0]
  }

  backendInfo(name = this.backendOf()) {
    return this.caps?.backends?.find((b) => b.name === name)
  }

  private load(options: { run?: boolean; notebookId?: number }): void {
    this.store.client!.data<Capabilities>('sqlWorkbenchGetCapabilities').then((caps) => {
      this.caps = caps
      this.capsError = undefined
      const backend = this.backendOf()
      if (backend) {
        this.schemaPane.expanded.add(`b:${backend}`)
        this.loadSchema(backend)
      }
      if (options.notebookId !== undefined) this.openNotebook(options.notebookId)
      else if (options.run && this.buffer.text.trim()) this.run()
      this.store.bump()
    }).catch((e) => {
      this.capsError = errorText(e)
      this.store.bump()
    })
  }

  loadSchema(backend: string, refresh = false): void {
    const have = this.schemas.get(backend)
    if (have && have !== 'loading' && !refresh) return
    if (have === 'loading') return
    this.schemas.set(backend, 'loading')
    this.client.data<SqlSchema>('sqlWorkbenchGetSchema', { path: { backendName: backend }, query: refresh ? { refresh: 'true' } : undefined })
      .then((s) => this.schemas.set(backend, s))
      .catch((e) => this.schemas.set(backend, { error: errorText(e) }))
      .finally(() => this.store.bump())
  }

  schemaOf(backend = this.backendOf()): SqlSchema | undefined {
    const s = backend ? this.schemas.get(backend) : undefined
    return s && s !== 'loading' && !('error' in s) ? s : undefined
  }

  // ---- Screen ----

  title(): string {
    const name = this.notebook.id !== undefined ? ` · ${this.notebook.title}` : ''
    return `SQL Runner${name}${this.edited ? ' *' : ''}`
  }

  dirty(): boolean {
    return this.edited
  }

  busy(): boolean {
    return Boolean(this.running)
  }

  capturesText(): boolean {
    return this.focus === 'editor' || this.focus === 'schema'
  }

  /** F2 opens the notebooks here instead of the palette (Ctrl+K and the menu still reach it). */
  claimsKey(key: Key): boolean {
    return key.name === 'f2'
  }

  helpTopic() {
    const app = runnerApps(this.store.meta)[0]
    return app ? { kind: 'app' as const, name: app } : undefined
  }

  paste(text: string): void {
    if (this.focus === 'editor') {
      this.buffer.insert(text)
      this.changed()
    } else if (this.focus === 'schema') {
      this.schemaPane.filter += text.replace(/\s+/g, ' ')
    }
  }

  dispose(): void {
    this.abort.abort()
    if (this.running) this.store.client?.call('sqlWorkbenchCancelExecution', { path: { uuid: this.running.uuid }, json: {} }).catch(() => undefined)
  }

  refresh(): void {
    this.schemas.clear()
    this.load({})
  }

  cliEquivalent(): string | undefined {
    const statement = statementAt(this.buffer.text, this.buffer.offset())
    const backend = this.backendOf()
    if (!statement || !backend || this.cell.cellType !== 'SQL') return undefined
    return `qqq sql-workbench post-execute -b ${shellQuote(JSON.stringify({ backendName: backend, sql: statement.text }))}`
  }

  fkeys(): FKeyLabels {
    const wide = this.store.width >= 100
    return { 2: wide ? 'Notebooks' : 'Books', 3: 'Schema', 4: 'Cells', 5: 'Run', 6: wide ? 'Explain' : 'Plan', 7: wide ? 'History' : 'Hist', 8: null }
  }

  /** The keys of this screen, for F1. */
  helpKeys(): Array<[string, string]> {
    return [
      ['F5  Ctrl+Enter', 'run the statement under the cursor (Ctrl+J where Ctrl+Enter is Enter)'], ['F6', 'EXPLAIN: the plan as a tree'], ['F2', 'notebooks: open, save, save as, new'],
      ['F3', 'schema browser (Enter inserts the name)'], ['F4', 'cells: go to, add, move, delete, run all'], ['F7', 'history of runs (Enter opens, Ctrl+R re-runs)'],
      ['Tab', 'complete table and column names; Shift+Tab to the results'], ['Ctrl+↑ Ctrl+↓', 'earlier and later SQL from the history'], ['Ctrl+PgUp/PgDn', 'previous and next cell'],
      ['Esc', 'cancel a run · leave the results · leave the runner'], ['s  V  x', 'results: sort, whole value, export'], ['g  c  p', 'results: grid, chart, plan'],
    ]
  }

  menu(): MenuEntry[] {
    const caps = this.caps
    const st = this.state()
    const out: MenuEntry[] = [
      { section: 'Context', label: 'Run the statement under the cursor', key: 'F5', run: () => this.run() },
      { section: 'Context', label: 'Run all cells', run: () => this.runAll() },
      { section: 'Context', label: 'Explain', key: 'F6', run: () => this.explain(false) },
      { section: 'Context', label: 'Explain analyze', disabled: caps?.canWrite && caps.writeModeEnabled !== false ? undefined : 'needs the sql_workbench.write permission (it runs the statement)', run: () => this.explain(true) },
      { section: 'Context', label: 'Cancel the running statement', key: 'Esc', disabled: this.running ? undefined : 'nothing is running', run: () => this.cancel() },
      { section: 'Context', label: `Backend: ${this.backendOf() ?? '(none)'}`, detail: this.backendDetail(), run: () => this.chooseBackend() },
      { section: 'Context', label: 'Parameters…', disabled: this.paramNames().length ? undefined : 'the SQL has no :name parameters', run: () => this.askParameters(this.paramNames(), true, () => undefined) },
      { section: 'Context', label: 'Notebooks', key: 'F2', run: () => this.openNotebooks() },
      { section: 'Context', label: 'Save notebook', run: () => this.save() },
      { section: 'Context', label: 'Save notebook as…', run: () => this.saveAs() },
      { section: 'Context', label: 'New notebook', run: () => this.newNotebook() },
      { section: 'Context', label: 'Cells', key: 'F4', run: () => this.openCells() },
      { section: 'Context', label: 'Add a SQL cell', run: () => this.addCell('SQL') },
      { section: 'Context', label: 'Add a markdown cell', run: () => this.addCell('MARKDOWN') },
      { section: 'Context', label: this.showSchema ? 'Hide the schema browser' : 'Show the schema browser', key: 'F3', run: () => this.toggleSchema() },
      { section: 'Context', label: 'Refresh the schema', run: () => { const b = this.backendOf(); if (b) this.loadSchema(b, true) } },
      { section: 'Context', label: 'History', key: 'F7', run: () => this.openHistory() },
      { section: 'Context', label: 'Export the result…', key: 'x', disabled: st.pager ? undefined : 'run a query first', run: () => this.exportResult() },
      { section: 'Context', label: 'Whole value of the cell', key: 'V', disabled: st.pager?.total ? undefined : 'no rows', run: () => this.wholeValue() },
      { section: 'Context', label: 'Quick chart', key: 'c', disabled: st.pager && numericColumns(st.pager.columns).length ? undefined : 'needs a result with a number column', run: () => this.setView('chart') },
      { section: 'Context', label: 'Plan', key: 'p', disabled: st.explain?.plan ? undefined : 'explain first (F6)', run: () => this.setView('plan') },
    ]
    if (caps?.canWrite) out.push({ section: 'Context', label: 'Write mode', disabled: 'not in the terminal yet: use the Next UI Runner for gated writes' })
    return out
  }

  backendDetail(name = this.backendOf()): string {
    const b = this.backendInfo(name)
    if (!b) return ''
    const ro = b.readOnlyEnforced ? 'read-only enforced' : 'read-only by classifier'
    return `${b.dialect ?? b.vendor ?? ''} · ${ro}${b.readOnlyCredentials ? ' · read-only credentials' : ''}`
  }

  // ---- keys ----

  onKey(key: Key): boolean {
    switch (key.name) {
      case 'f2': this.openNotebooks(); return true
      case 'f3': this.toggleSchema(); return true
      case 'f4': this.openCells(); return true
      case 'f5': this.run(); return true
      case 'f6': this.explain(false); return true
      case 'f7': this.openHistory(); return true
      default: break
    }
    if ((key.name === 'return' && key.ctrl) || key.name === 'linefeed' || (key.ctrl && key.name === 'j')) {
      this.run()
      return true
    }
    if (key.name === 'escape') {
      if (this.completion) {
        this.completion = undefined
        return true
      }
      if (this.running) {
        this.cancel()
        return true
      }
      if (this.focus === 'schema' && this.schemaPane.filter) {
        this.schemaPane.filter = ''
        return true
      }
      if (this.focus !== 'editor') {
        this.focus = 'editor'
        return true
      }
      if (this.edited && this.store.routes.length > 1) {
        this.store.confirm(`Leave the SQL Runner? Unsaved changes${this.notebook.id !== undefined ? ` to ${this.notebook.title}` : ''} are lost.`, () => {
          this.edited = false
          this.store.back()
        })
        return true
      }
      return false
    }
    if (key.ctrl && (key.name === 'pageup' || key.name === 'pagedown')) {
      this.goCell(this.cellIndex + (key.name === 'pageup' ? -1 : 1))
      return true
    }
    if (this.focus === 'editor') return this.editorKey(key)
    if (this.focus === 'schema') return this.schemaKey(key)
    return this.resultsKey(key)
  }

  private changed(): void {
    this.edited = true
    this.cell.content = this.buffer.text
    const st = this.state()
    if (st.error) st.error = undefined
  }

  private editorKey(key: Key): boolean {
    if (key.name === 'tab' && !key.shift) {
      this.tabComplete()
      return true
    }
    if (key.name !== 'tab') this.completion = undefined
    if (key.name === 'tab' && key.shift) {
      this.focus = 'results'
      return true
    }
    if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
      const text = this.history.step(key.name === 'up' ? 1 : -1, this.buffer.text)
      if (text === undefined) this.store.flash(key.name === 'up' ? 'no earlier SQL in the history' : 'back at what you were writing')
      else {
        this.buffer.set(text)
        this.changed()
      }
      return true
    }
    if (key.name === 'return' && !key.ctrl && !key.meta) {
      this.buffer.newline()
      this.changed()
      return true
    }
    const before = this.buffer.text
    if (this.buffer.handle(key, Math.max(1, this.lastRender.editorLines - 1))) {
      if (this.buffer.text !== before) this.changed()
      return true
    }
    return false
  }

  /** Tab: completes the word at the cursor; repeated Tabs cycle the candidates. */
  tabComplete(): void {
    if (this.cell.cellType !== 'SQL') {
      this.buffer.insert('  ')
      this.changed()
      return
    }
    const c = this.completion
    if (c && c.candidates.length > 1) {
      c.index = (c.index + 1) % c.candidates.length
      const word = this.buffer.offset() - c.from
      this.buffer.replaceBefore(word, c.candidates[c.index]!)
      this.cell.content = this.buffer.text
      return
    }
    const result = complete(this.buffer.text, this.buffer.offset(), this.schemaOf())
    if (!result.candidates.length) {
      if (!result.prefix && !/\.\s*$/.test(this.buffer.line.slice(0, this.buffer.col))) {
        this.buffer.insert('  ')
        this.changed()
        return
      }
      this.store.flash(this.schemaOf() ? `nothing completes "${result.prefix}"` : 'no schema loaded yet: completion knows only keywords')
      return
    }
    if (result.candidates.length === 1) {
      this.buffer.replaceBefore(result.prefix.length, result.candidates[0]!)
      this.changed()
      this.completion = undefined
      return
    }
    const common = commonPrefix(result.candidates)
    if (common.length > result.prefix.length) {
      this.buffer.replaceBefore(result.prefix.length, common)
      this.changed()
    }
    this.completion = { from: result.from, candidates: result.candidates, index: -1, base: common }
  }

  private schemaKey(key: Key): boolean {
    const pane = this.schemaPane
    const items = pane.items(this)
    const item = items[pane.cursor]
    switch (key.name) {
      case 'up': pane.cursor = Math.max(0, pane.cursor - 1); return true
      case 'down': pane.cursor = Math.min(items.length - 1, pane.cursor + 1); return true
      case 'pageup': pane.cursor = Math.max(0, pane.cursor - 10); return true
      case 'pagedown': pane.cursor = Math.min(items.length - 1, pane.cursor + 10); return true
      case 'home': pane.cursor = 0; return true
      case 'end': pane.cursor = Math.max(0, items.length - 1); return true
      case 'tab': this.focus = 'editor'; return true
      case 'right': case 'space':
        if (item && (item.kind === 'backend' || item.kind === 'table')) {
          if (key.name === 'space' && pane.expanded.has(item.key)) pane.expanded.delete(item.key)
          else pane.expanded.add(item.key)
          if (item.kind === 'backend') this.loadSchema(item.backend)
        }
        return true
      case 'left':
        if (item && pane.expanded.has(item.key)) pane.expanded.delete(item.key)
        else if (item && item.depth > 0) {
          const parent = [...items.slice(0, pane.cursor)].reverse().find((x) => x.depth < item.depth)
          if (parent) pane.cursor = items.indexOf(parent)
        }
        return true
      case 'return':
        if (!item) return true
        if (item.kind === 'backend') {
          this.setBackend(item.backend)
          pane.expanded.add(item.key)
        } else if (item.kind === 'table' || item.kind === 'column') {
          this.buffer.insert(item.name)
          this.changed()
          this.focus = 'editor'
        }
        return true
      case 'backspace':
        pane.filter = pane.filter.slice(0, -1)
        pane.cursor = 0
        return true
      default: {
        const ch = charOf(key)
        if (ch && ch !== ' ') {
          pane.filter += ch
          pane.cursor = 0
          return true
        }
        return false
      }
    }
  }

  private resultsKey(key: Key): boolean {
    const st = this.state()
    const ch = charOf(key)
    if (key.name === 'tab') {
      this.focus = key.shift || !this.showSchema ? 'editor' : 'schema'
      return true
    }
    if (ch === 'g') return this.setView('grid'), true
    if (ch === 'c') return this.setView('chart'), true
    if (ch === 'p') return this.setView('plan'), true
    if (ch === 'e' || ch === 'i') {
      this.focus = 'editor'
      return true
    }
    if (st.view === 'plan') return this.planKey(key, st)
    const pager = st.pager
    if (!pager) return false
    const rows = Math.max(1, this.lastRender.gridRows)
    const last = Math.max(0, pager.total - 1)
    if (st.view === 'chart') {
      const numeric = numericColumns(pager.columns)
      if ((key.name === 'left' || key.name === 'right') && numeric.length) {
        const at = Math.max(0, numeric.indexOf(st.chartValue ?? numeric[0]!))
        st.chartValue = numeric[(at + (key.name === 'right' ? 1 : numeric.length - 1)) % numeric.length]
        return true
      }
      if (ch === 'l') {
        st.chartLabel = ((st.chartLabel ?? -1) + 2) % (pager.columns.length + 1) - 1
        return true
      }
    }
    switch (key.name) {
      case 'up': st.row = Math.max(0, st.row - 1); break
      case 'down': st.row = Math.min(last, st.row + 1); break
      case 'pageup': st.row = Math.max(0, st.row - rows); st.top = Math.max(0, st.top - rows); break
      case 'pagedown': st.row = Math.min(last, st.row + rows); st.top = Math.min(Math.max(0, pager.total - rows), st.top + rows); break
      case 'home': st.row = 0; break
      case 'end': st.row = last; break
      case 'left': st.col = Math.max(0, st.col - 1); break
      case 'right': st.col = Math.min(pager.columns.length - 1, st.col + 1); break
      case 'return': this.wholeValue(); return true
      default:
        if (ch === 's') {
          this.store.run(pager.sortBy(st.col).then(() => { st.row = 0; st.top = 0 }))
          return true
        }
        if (ch === 'V') return this.wholeValue(), true
        if (ch === 'x') return this.exportResult(), true
        return false
    }
    this.ensureRows(st)
    return true
  }

  private planKey(key: Key, st: CellState): boolean {
    if (!st.explain?.plan) return false
    const lines = planLines(st.explain.plan, st.collapsed)
    const line = lines[st.planCursor]
    switch (key.name) {
      case 'up': st.planCursor = Math.max(0, st.planCursor - 1); return true
      case 'down': st.planCursor = Math.min(lines.length - 1, st.planCursor + 1); return true
      case 'pageup': st.planCursor = Math.max(0, st.planCursor - 10); return true
      case 'pagedown': st.planCursor = Math.min(lines.length - 1, st.planCursor + 10); return true
      case 'home': st.planCursor = 0; return true
      case 'end': st.planCursor = lines.length - 1; return true
      case 'left': if (line?.hasChildren) st.collapsed.add(line.path); return true
      case 'right': if (line) st.collapsed.delete(line.path); return true
      case 'return': case 'space':
        if (line?.hasChildren) {
          if (st.collapsed.has(line.path)) st.collapsed.delete(line.path)
          else st.collapsed.add(line.path)
        }
        return true
      default:
        if (charOf(key) === 'r') {
          st.raw = !st.raw
          return true
        }
        return false
    }
  }

  private ensureRows(st: CellState): void {
    const pager = st.pager
    if (!pager) return
    const rows = Math.max(1, this.lastRender.gridRows)
    if (st.row < st.top) st.top = st.row
    if (st.row >= st.top + rows) st.top = st.row - rows + 1
    if (!pager.has(st.top, rows)) this.store.run(pager.ensure(st.top, rows + CHUNK / 2))
  }

  setView(view: CellState['view']): void {
    const st = this.state()
    if (view === 'plan' && !st.explain) return this.store.flash('no plan yet: F6 explains the statement under the cursor')
    if (view === 'chart' && !(st.pager && numericColumns(st.pager.columns).length)) return this.store.flash('a quick chart needs a result with a number column')
    st.view = view
    this.focus = 'results'
  }

  toggleSchema(): void {
    if (this.showSchema && this.focus !== 'schema') {
      this.focus = 'schema'
      return
    }
    this.showSchema = !this.showSchema
    this.focus = this.showSchema ? 'schema' : 'editor'
    const b = this.backendOf()
    if (this.showSchema && b) this.loadSchema(b)
  }

  // ---- cells ----

  /** Stores the editor into the current cell and shows another one. */
  goCell(index: number): void {
    if (index < 0 || index >= this.notebook.cells.length) return this.store.flash(index < 0 ? 'this is the first cell' : 'this is the last cell')
    this.cell.content = this.buffer.text
    this.cellIndex = index
    this.buffer.set(this.cell.content)
    this.buffer.setOffset(0)
    this.completion = undefined
  }

  addCell(type: 'SQL' | 'MARKDOWN', content = ''): void {
    this.cell.content = this.buffer.text
    const cell: NotebookCell = { cellKey: newCellKey(), cellType: type, content, title: null, backendName: null }
    this.notebook.cells.splice(this.cellIndex + 1, 0, cell)
    this.cellIndex++
    this.buffer.set(content)
    this.edited = true
    this.focus = 'editor'
  }

  deleteCell(index: number): void {
    if (this.notebook.cells.length <= 1) {
      this.notebook.cells[0] = { ...this.notebook.cells[0]!, content: '', title: null }
      this.buffer.set('')
    } else {
      const [gone] = this.notebook.cells.splice(index, 1)
      if (gone) this.states.delete(gone.cellKey)
      this.cellIndex = Math.min(this.cellIndex >= index && this.cellIndex > 0 ? this.cellIndex - 1 : this.cellIndex, this.notebook.cells.length - 1)
      this.buffer.set(this.cell.content)
    }
    this.edited = true
  }

  moveCellBy(index: number, delta: number): number {
    this.cell.content = this.buffer.text
    const current = this.cell
    const to = moveCell(this.notebook.cells, index, delta)
    this.cellIndex = this.notebook.cells.indexOf(current)
    if (to !== index) this.edited = true
    return to
  }

  openCells(): void {
    this.cell.content = this.buffer.text
    this.store.open(new CellsOverlay(this.store, this))
  }

  setCellTitle(index: number, title: string): void {
    const cell = this.notebook.cells[index]
    if (!cell) return
    cell.title = title.trim() || null
    this.edited = true
  }

  chooseBackend(index = this.cellIndex): void {
    const backends = this.caps?.backends ?? []
    if (!backends.length) return this.store.flash(this.capsError ?? 'the server offers no backends to run SQL on', 'error')
    const cell = this.notebook.cells[index]!
    this.store.open(new ChoiceOverlay(this.store, 'Run this cell on', backends.map((b) => ({ label: `${b.label ?? b.name} (${b.dialect ?? b.vendor ?? '?'})`, value: b.name, detail: this.backendDetail(b.name) })), (name) => {
      if (index === this.cellIndex) this.setBackend(name)
      else {
        cell.backendName = name
        this.edited = true
      }
    }, 'the notebook default otherwise', Math.max(0, backends.findIndex((b) => b.name === this.backendOf(cell)))))
  }

  setBackend(name: string): void {
    if (this.cell.backendName !== name) this.edited = true
    this.cell.backendName = name
    this.loadSchema(name)
    this.store.flash(`this cell runs on ${name}`)
  }

  // ---- running ----

  paramNames(sql = this.cell.cellType === 'SQL' ? this.buffer.text : ''): string[] {
    return extractParameters(sql)
  }

  /** Asks for parameter values (only the missing ones unless `all`), then continues. */
  askParameters(names: string[], all: boolean, then: () => void): void {
    const todo = names.filter((n) => all || !(n in this.values))
    const next = (i: number) => {
      const name = todo[i]
      if (name === undefined) return then()
      const declared = this.notebook.parameters?.find((p) => p.name === name)
      const initial = this.values[name] ?? declared?.defaultValue ?? ''
      this.store.open(new PromptOverlay(this.store, `Value for :${name}${declared?.type && declared.type !== 'STRING' ? ` (${declared.type})` : ''}`, 'Bound as a value, never pasted into the SQL. Empty is NULL. Esc cancels the run.', (value) => {
        this.values[name] = value
        next(i + 1)
      }, initial))
    }
    next(0)
  }

  paramsFor(sql: string): Record<string, unknown> | undefined {
    const names = extractParameters(sql)
    if (!names.length) return undefined
    return Object.fromEntries(names.map((n) => [n, coerceParameter(this.values[n], this.notebook.parameters?.find((p) => p.name === n)?.type)]))
  }

  /** F5: runs the statement under the cursor (the whole cell when it has one statement). */
  run(): void {
    this.completion = undefined
    if (this.cell.cellType !== 'SQL') return this.store.flash('a markdown cell has nothing to run: F4 lists the cells')
    if (this.running) return this.store.flash('a statement is running: Esc cancels it')
    const text = this.buffer.text
    const statement = statementAt(text, this.buffer.offset())
    if (!statement) return this.store.flash('nothing to run: write a SQL statement first')
    const backend = this.backendOf()
    if (!backend) return this.store.flash(this.capsError ?? (this.caps ? 'the server offers no backends to run SQL on' : 'still reading the capabilities…'), 'error')
    this.askParameters(extractParameters(statement.text), false, () => void this.execute(this.cell, statement.text, statement.start))
  }

  /** Runs every SQL cell in order; stops at the first that fails. */
  runAll(): void {
    if (this.running) return this.store.flash('a statement is running: Esc cancels it')
    this.cell.content = this.buffer.text
    const cells = this.notebook.cells.filter((c) => c.cellType === 'SQL' && c.content.trim())
    if (!cells.length) return this.store.flash('no SQL cells to run')
    const names = [...new Set(cells.flatMap((c) => extractParameters(c.content)))]
    this.askParameters(names, false, async () => {
      let ok = 0
      for (const cell of cells) {
        const statement = statementAt(cell.content, cell.content.length)
        if (!statement) continue
        const good = await this.execute(cell, statement.text, statement.start, false)
        if (!good) {
          this.cellIndex = this.notebook.cells.indexOf(cell)
          this.buffer.set(cell.content)
          this.store.flash(`run all stopped at cell ${this.cellIndex + 1} (${ok} ran)`, 'error')
          return
        }
        ok++
      }
      this.store.flash(`ran ${ok} SQL cell${ok === 1 ? '' : 's'}`)
    })
  }

  private async execute(cell: NotebookCell, sql: string, statementStart: number, focusResults = true): Promise<boolean> {
    const backend = this.backendOf(cell)!
    const uuid = newCellKey()
    const st = this.state(cell)
    this.running = { uuid, cellKey: cell.cellKey, label: trunc(sql, 40), at: Date.now() }
    this.history.add(sql)
    this.store.bump()
    const pageSize = Math.min(CHUNK, this.caps?.limits?.maxPageSize ?? CHUNK)
    try {
      const response = await this.client.data<ExecuteResponse>('sqlWorkbenchExecute', {
        json: { backendName: backend, sql, params: this.paramsFor(sql), mode: 'READ_ONLY', pageSize, executionUuid: uuid, ...(this.notebook.id !== undefined ? { notebookId: this.notebook.id, cellKey: cell.cellKey } : {}) },
      })
      st.backend = backend
      st.ms = response.durationMs ?? Date.now() - this.running.at
      if (response.status !== 'SUCCEEDED') {
        const message = response.error ?? `${response.status}`
        st.error = { message, status: response.status, sqlState: response.sqlState, position: errorPosition(message, sql), statementStart }
        return false
      }
      st.error = undefined
      st.response = response
      st.pager = new ResultPager(response, (offset, limit, sort) => this.client.data<RowsResponse>('sqlWorkbenchGetRows', { path: { uuid: response.executionUuid }, query: { offset: String(offset), limit: String(limit), ...(sort ? { sort: String(sort.column), dir: sort.dir } : {}) } }), pageSize)
      st.row = 0
      st.top = 0
      st.col = 0
      st.left = 0
      st.cols = undefined
      st.view = 'grid'
      if (focusResults && response.columns?.length) this.focus = 'results'
      return true
    } catch (e) {
      if (this.abort.signal.aborted) return false
      const message = errorText(e)
      st.error = { message, position: errorPosition(message, sql), statementStart }
      return false
    } finally {
      this.running = undefined
      this.store.bump()
    }
  }

  cancel(): void {
    const r = this.running
    if (!r) return
    this.store.client!.call('sqlWorkbenchCancelExecution', { path: { uuid: r.uuid }, json: {} })
      .then(() => this.store.flash('cancel sent'))
      .catch((e) => this.store.flash(`cannot cancel: ${errorText(e)}`, 'error'))
  }

  /** F6: the plan of the statement under the cursor, as an indented tree. */
  explain(analyze: boolean): void {
    if (this.cell.cellType !== 'SQL') return this.store.flash('a markdown cell has no plan')
    const statement = statementAt(this.buffer.text, this.buffer.offset())
    if (!statement) return this.store.flash('nothing to explain: write a SQL statement first')
    const backend = this.backendOf()
    if (!backend) return this.store.flash(this.capsError ?? 'no backend to explain on', 'error')
    if (analyze && !(this.caps?.canWrite && this.caps.writeModeEnabled !== false)) return this.store.flash('EXPLAIN ANALYZE needs the sql_workbench.write permission', 'error')
    const cell = this.cell
    const st = this.state(cell)
    this.askParameters(extractParameters(statement.text), false, () => {
      this.store.run(this.client.data<ExplainResponse>('sqlWorkbenchExplain', { json: { backendName: backend, sql: statement.text, params: this.paramsFor(statement.text), analyze } }), (r) => {
        if (r.status && r.status !== 'SUCCEEDED') {
          const message = r.error ?? r.status
          st.error = { message, status: r.status, sqlState: r.sqlState, position: errorPosition(message, statement.text), statementStart: statement.start }
          return
        }
        st.error = undefined
        st.explain = r
        st.collapsed = new Set()
        st.planCursor = 0
        st.planTop = 0
        st.raw = !r.plan
        st.view = 'plan'
        this.focus = 'results'
      })
    })
  }

  // ---- results actions ----

  wholeValue(): void {
    const st = this.state()
    const pager = st.pager
    const row = pager?.get(st.row)
    if (!pager || !row) return this.store.flash('no row under the cursor')
    const col = pager.columns[st.col]
    const label = col?.label || col?.name || 'value'
    this.store.open(new MessageOverlay(this.store, `${label}${col?.typeName ? ` (${col.typeName})` : ''}, row ${num(st.row + 1)}:\n\n${fullValueText(row[st.col], col?.kind)}`, 'info', trunc(label, 30)))
  }

  exportResult(): void {
    const st = this.state()
    const uuid = st.response?.executionUuid
    if (!uuid) return this.store.flash('run a query first: export writes the last result')
    this.store.open(new ChoiceOverlay(this.store, 'Export the result', [
      { label: 'csv', value: 'csv' }, { label: 'xlsx', value: 'xlsx', detail: 'Excel' }, { label: 'json', value: 'json', detail: 'rows keyed by column label' },
    ], (format) => {
      saveFile(this.store, `Export the result as ${format}`, `sql-result-${uuid.slice(0, 8)}.${format}`, (path) => {
        this.store.run(this.store.client!.call('sqlWorkbenchExportResult', { path: { uuid }, query: { format } }), (result) => {
          const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2))
          writeFileSync(path, bytes)
          this.store.message(`Wrote ${path} (${num(bytes.length)} bytes, up to ${num(this.caps?.limits?.maxRows)} rows).`)
        })
      })
    }, 'the server writes the cached result'))
  }

  // ---- notebooks ----

  openNotebooks(): void {
    this.cell.content = this.buffer.text
    this.store.open(new NotebooksOverlay(this.store, this))
  }

  /** Opens a notebook (asking first when the current one has unsaved changes). */
  openNotebook(id: number): void {
    const go = () => this.store.run(this.client.data<Notebook>('sqlWorkbenchGetNotebook', { path: { id: String(id) } }), (nb) => this.showNotebook(nb))
    if (this.edited) this.store.confirm('Open another notebook? Unsaved changes here are lost.', go)
    else go()
  }

  showNotebook(nb: Notebook): void {
    this.notebook = { ...nb, cells: nb.cells?.length ? [...nb.cells].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) : scratchNotebook().cells }
    this.cellIndex = 0
    this.buffer.set(this.cell.content)
    this.buffer.setOffset(0)
    this.states.clear()
    this.edited = false
    for (const p of nb.parameters ?? []) if (p.defaultValue !== null && p.defaultValue !== undefined && !(p.name in this.values)) this.values[p.name] = p.defaultValue
    const backend = this.backendOf()
    if (backend) this.loadSchema(backend)
    this.focus = 'editor'
    this.store.flash(`opened ${nb.title}${nb.canEdit === false ? ' (read-only: save as makes your copy)' : ''}`)
  }

  newNotebook(): void {
    const go = () => {
      this.notebook = scratchNotebook()
      this.cellIndex = 0
      this.buffer.set('')
      this.states.clear()
      this.edited = false
      this.focus = 'editor'
    }
    if (this.edited) this.store.confirm('Start a new notebook? Unsaved changes here are lost.', go)
    else go()
  }

  /** Saves: a new version of an owned notebook, else asks for a title and creates one. */
  save(): void {
    this.cell.content = this.buffer.text
    if (this.notebook.id === undefined || this.notebook.canEdit === false) return this.saveAs()
    const id = this.notebook.id
    this.store.run(this.client.data<Notebook>('sqlWorkbenchUpdateNotebook', { path: { id: String(id) }, json: notebookRequest(this.notebook, this.values) }), (nb) => {
      this.adopt(nb)
      this.store.flash(`saved ${nb.title}, version ${nb.currentVersion ?? '?'}`)
    })
  }

  saveAs(): void {
    this.cell.content = this.buffer.text
    const initial = this.notebook.id !== undefined ? `${this.notebook.title} (copy)` : this.notebook.title === 'Untitled' ? '' : this.notebook.title
    this.store.open(new PromptOverlay(this.store, 'Save the notebook as', 'A new personal notebook with these cells (version 1).', (title) => {
      if (!title.trim()) return this.store.flash('a notebook needs a title', 'error')
      const body = notebookRequest({ ...this.notebook, title: title.trim() }, this.values)
      this.store.run(this.client.data<Notebook>('sqlWorkbenchCreateNotebook', { json: body }), (nb) => {
        this.adopt(nb)
        this.store.flash(`saved as ${nb.title}`)
      })
    }, initial))
  }

  /** Takes the server's copy after a save, keeping the cursor and results (cells keep their keys). */
  private adopt(nb: Notebook): void {
    const index = this.cellIndex
    const offset = this.buffer.offset()
    this.notebook = { ...nb, cells: nb.cells?.length ? [...nb.cells].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) : this.notebook.cells }
    this.cellIndex = Math.min(index, this.notebook.cells.length - 1)
    this.buffer.set(this.cell.content)
    this.buffer.setOffset(offset)
    this.edited = false
  }

  openHistory(): void {
    this.store.run(this.client.data<{ executions?: HistoryEntry[] }>('sqlWorkbenchGetHistory', { query: { limit: '100' } }), (data) => {
      this.store.open(new HistoryOverlay(this.store, data.executions ?? [], (entry, rerun) => this.fromHistory(entry, rerun)))
    })
  }

  /** A history entry into the editor: the current cell when it is empty, else a new cell; `rerun` runs it. */
  fromHistory(entry: HistoryEntry, rerun: boolean): void {
    const sql = entry.sqlText ?? ''
    if (this.buffer.text.trim() && this.cell.cellType === 'SQL') this.addCell('SQL', sql)
    else {
      if (this.cell.cellType !== 'SQL') this.addCell('SQL', sql)
      else {
        this.buffer.set(sql)
        this.changed()
      }
    }
    if (entry.backendName && (this.caps?.backends ?? []).some((b) => b.name === entry.backendName) && entry.backendName !== this.backendOf()) this.cell.backendName = entry.backendName
    this.focus = 'editor'
    if (rerun) this.run()
  }

  // ---- drawing ----

  render(width: number, height: number, focused: boolean): ReactNode {
    const t = theme()
    const schemaW = this.showSchema ? Math.max(22, Math.min(36, Math.floor(width * 0.3))) : 0
    const mainW = width - schemaW
    const iw = mainW - 2
    const strip = this.notebook.id !== undefined || this.notebook.cells.length > 1
    const st = this.state()
    const errLines = this.errorLines(st, mainW)
    const edInner = Math.max(3, Math.min(14, Math.floor((height - (strip ? 1 : 0)) * 0.3)))
    const resultsH = Math.max(5, height - (strip ? 1 : 0) - (edInner + 2) - errLines.length)
    this.lastRender = { editorLines: edInner, gridRows: Math.max(1, resultsH - 2 - 3), width: mainW }
    const main = (
      <box flexDirection="column" width={mainW} height={height} overflow="hidden">
        {strip && <SegLine segs={this.stripSegs()} width={mainW} bg={t.statusBg} fg={t.statusFg} />}
        {this.renderEditor(mainW, edInner, focused && this.focus === 'editor')}
        {errLines.map((l, i) => <PlainLine key={`err${i}`} text={l} width={mainW} fg={t.err} />)}
        {this.renderResults(mainW, resultsH, iw, focused && this.focus === 'results')}
      </box>
    )
    if (!schemaW) return main
    return (
      <box flexDirection="row" width={width} height={height} overflow="hidden">
        {main}
        {this.renderSchema(schemaW, height, focused && this.focus === 'schema')}
      </box>
    )
  }

  private stripSegs(): Seg[] {
    const t = theme()
    const nb = this.notebook
    const segs: Seg[] = [{ text: ` ${nb.id !== undefined ? nb.title : 'Untitled'}${this.edited ? ' *' : ''}${nb.canEdit === false ? ' (read-only)' : ''}${nb.visibility === 'SHARED' ? ' · shared' : ''} ` }]
    nb.cells.forEach((c, i) => {
      const label = ` ${i + 1} ${c.cellType === 'SQL' ? 'SQL' : 'MD'} ${trunc(cellSummary(c), 14)} `
      segs.push({ text: ' ' })
      segs.push(i === this.cellIndex ? { text: label, fg: t.selFg, bg: t.selBg } : { text: label, fg: t.statusFg })
    })
    return segs
  }

  private renderEditor(mainW: number, inner: number, focused: boolean): ReactNode {
    const t = theme()
    const g = glyphs()
    const iw = mainW - 2
    const gutter = 4
    const tw = Math.max(4, iw - gutter)
    const buf = this.buffer
    buf.scrollTo(inner, tw)
    const cell = this.cell
    const isSql = cell.cellType === 'SQL'
    const keywords = keywordSet(this.schemaOf())
    const lines: Token[][] = isSql ? tokenLines(buf.text, keywords) : buf.lines.map((l) => (l ? [{ kind: 'ident' as const, text: l, start: 0 }] : []))
    const st = this.state()
    const errAt = st.error?.position?.offset !== undefined ? st.error.statementStart + st.error.position.offset : undefined
    const errRowCol = errAt !== undefined ? (() => { const tmp = new SqlBuffer(buf.text); tmp.setOffset(errAt); return { row: tmp.row, col: tmp.col } })() : undefined
    const color: Record<string, string> = { keyword: t.acc, string: t.ok, quoted: t.acc2, number: t.warn, comment: t.dim, param: t.acc2, ident: t.fg, punct: t.fg, space: t.fg }
    const rows: ReactNode[] = []
    for (let r = buf.top; r < buf.top + inner; r++) {
      if (r >= buf.lines.length) {
        rows.push(<SegLine key={r} segs={[{ text: r === 0 ? '' : '', fg: t.dim }, { text: r === buf.top && !buf.text ? `    ${isSql ? 'SELECT … (F5 runs, Tab completes, F3 schema)' : 'notes in markdown'}` : '' , fg: t.dim }]} width={iw} />)
        continue
      }
      const chars: Array<{ ch: string; fg: string; bg?: string }> = []
      const lineText = buf.lines[r]!
      const toks = lines[r] ?? []
      let pos = 0
      for (const tok of toks) {
        for (const ch of tok.text) chars[pos++] = { ch, fg: color[tok.kind] ?? t.fg }
      }
      for (let i = 0; i < lineText.length; i++) chars[i] ??= { ch: lineText[i]!, fg: t.fg }
      if (errRowCol && errRowCol.row === r) {
        const c = Math.min(errRowCol.col, lineText.length)
        chars[c] = { ch: lineText[c] ?? ' ', fg: t.selFg, bg: t.err }
      }
      if (focused && r === buf.row) {
        const c = buf.col
        chars[c] = { ch: lineText[c] ?? ' ', fg: t.selFg, bg: t.selBg }
      }
      const visible = chars.slice(buf.left, buf.left + tw)
      const segs: Seg[] = [{ text: `${String(r + 1).padStart(3)} `, fg: t.dim }]
      for (const c of visible) {
        const cur = c ?? { ch: ' ', fg: t.fg }
        const last = segs[segs.length - 1]!
        if (segs.length > 1 && last.fg === cur.fg && last.bg === cur.bg) last.text += cur.ch
        else segs.push({ text: cur.ch, fg: cur.fg, bg: cur.bg })
      }
      if (buf.left > 0 && segs[1]) segs[1] = { ...segs[1], text: g.ellipsis + segs[1].text.slice(1) }
      if (chars.length > buf.left + tw && segs.length > 1) {
        const lastSeg = segs[segs.length - 1]!
        segs[segs.length - 1] = { ...lastSeg, text: lastSeg.text.slice(0, -1) + g.ellipsis }
      }
      rows.push(<SegLine key={r} segs={segs} width={iw} />)
    }
    const b = this.backendInfo()
    const ro = this.caps ? (b?.writeAllowed && this.caps.canWrite ? 'read-only run' : 'READ-ONLY') : ''
    const titleText = isSql
      ? ` SQL · cell ${this.cellIndex + 1}/${this.notebook.cells.length} · ${this.backendOf() ?? (this.capsError ? 'no backend' : '…')}${b?.dialect && b.dialect !== b.name ? ` (${b.dialect})` : ''}${ro ? ` · ${ro}` : ''} `
      : ` Notes (markdown) · cell ${this.cellIndex + 1}/${this.notebook.cells.length} `
    const comp = this.completion
    const bottom = comp
      ? ` ${comp.candidates.map((c, i) => (i === comp.index ? `[${c}]` : c)).join(' ')} `
      : focused ? (isSql ? ' F5 run · Tab complete · Ctrl+↑↓ history · Shift+Tab results ' : ' Tab indents · F4 cells ') : ''
    return (
      <box flexDirection="column" overflow="hidden" width={mainW} height={inner + 2} {...borderProps(focused)} title={trunc(titleText, Math.max(0, mainW - 4))} {...(bottom ? { bottomTitle: trunc(bottom, Math.max(0, mainW - 4)) } : {})}>
        {rows}
      </box>
    )
  }

  private errorLines(st: CellState, width: number): string[] {
    const e = st.error
    if (!e) return []
    const where = e.position ? ` at line ${e.position.line}${e.position.col !== undefined ? `, col ${e.position.col}` : ''}` : ''
    const head = `${glyphs().border ? 'x' : '✗'} ${e.status ?? 'ERROR'}${e.sqlState ? ` (SQLSTATE ${e.sqlState})` : ''}${where}: `
    const lines = wrap((head + e.message).replace(/\s*\n\s*/g, ' '), width - 2)
    const out = lines.slice(0, 3).map((l) => ` ${l}`)
    if (lines.length > 3) out[2] = trunc(`${out[2]!} ${lines[3]}`, width - 1)
    return out
  }

  private renderResults(mainW: number, h: number, iw: number, focused: boolean): ReactNode {
    const t = theme()
    const st = this.state()
    const inner = h - 2
    let title = ' Results '
    let lines: ReactNode[]
    if (this.cell.cellType === 'MARKDOWN') {
      title = ' Notes '
      const md = markdownLines(this.buffer.text)
      lines = md.slice(0, inner).map((l, i) => <PlainLine key={i} text={` ${l.text}`} width={iw} fg={l.style === 'heading' ? t.acc : l.style === 'code' ? t.acc2 : l.style === 'quote' ? t.dim : t.fg} />)
    } else if (st.view === 'plan' && st.explain) {
      title = ` Plan${st.explain.analyze ? ' (analyze)' : ''} `
      lines = this.planBody(st, iw, inner, focused)
    } else if (st.view === 'chart' && st.pager) {
      title = ' Chart '
      lines = this.chartBody(st, iw, inner)
    } else if (st.pager) {
      lines = this.gridBody(st, iw, inner, focused)
    } else {
      lines = this.emptyBody(iw)
    }
    while (lines.length < inner) lines.push(<PlainLine key={`pad${lines.length}`} text="" width={iw} />)
    const tabs = st.pager || st.explain ? ` ${st.view === 'grid' ? '[g grid]' : 'g grid'} ${st.view === 'chart' ? '[c chart]' : 'c chart'} ${st.view === 'plan' ? '[p plan]' : 'p plan'} ` : ''
    return (
      <box flexDirection="column" overflow="hidden" width={mainW} height={h} {...borderProps(focused)} title={trunc(title, Math.max(0, mainW - 4))} {...(tabs && mainW > 40 ? { bottomTitle: trunc(tabs, Math.max(0, mainW - 4)) } : {})}>
        {lines.slice(0, inner)}
      </box>
    )
  }

  private emptyBody(iw: number): ReactNode[] {
    const t = theme()
    const text: Array<[string, string?]> = []
    if (this.running) text.push([` running ${this.running.label} … (${((Date.now() - this.running.at) / 1000).toFixed(1)} s) · Esc cancels`, t.acc2])
    else if (this.capsError) text.push([` cannot read the SQL workbench capabilities: ${this.capsError}`, t.err])
    else if (!this.caps) text.push([' reading the SQL workbench capabilities…', t.dim])
    else if (!(this.caps.backends ?? []).length) text.push([' the server offers no backends to run SQL on (allowed/excluded backends in the qbit config)', t.warn])
    else {
      text.push([' Write SQL above. F5 runs the statement under the cursor (Ctrl+Enter where the terminal sends it).', t.dim])
      text.push([' F6 explains it · F3 schema · Tab completes names · F7 history · F2 notebooks · F4 cells', t.dim])
      const l = this.caps.limits
      text.push([` Read-only: one statement per run · up to ${num(l?.maxRows)} rows · ${l?.statementTimeoutSeconds ?? '?'} s timeout · every run is audited`, t.dim])
    }
    return text.map(([s, fg], i) => <PlainLine key={`e${i}`} text={s} width={iw} fg={fg} />)
  }

  private gridBody(st: CellState, iw: number, inner: number, focused: boolean): ReactNode[] {
    const t = theme()
    const g = glyphs()
    const pager = st.pager!
    const rowsShown = Math.max(1, inner - 3)
    const width = iw - 1
    const key = `${width}`
    if (!st.cols || st.cols.key !== key) st.cols = { key, cols: sqlColumns(pager.columns, pager.window(0, CHUNK).filter((r): r is unknown[] => Boolean(r)), width) }
    const cols = st.cols.cols
    st.col = Math.min(st.col, Math.max(0, cols.length - 1))
    if (st.col < st.left) st.left = st.col
    while (st.left < st.col && !visibleFrom(cols, st.left, width).some((c) => c.name === cols[st.col]!.name)) st.left++
    if (st.row < st.top) st.top = st.row
    if (st.row >= st.top + rowsShown) st.top = st.row - rowsShown + 1
    if (!pager.has(st.top, rowsShown) && !pager.loading) queueMicrotask(() => this.store.run(pager.ensure(st.top, rowsShown + CHUNK / 2)))
    const shown = visibleFrom(cols, st.left, width)
    const out: ReactNode[] = []
    const header: Seg[] = [{ text: ' ' }]
    shown.forEach((c, i) => {
      const index = Number(c.name)
      const mark = pager.sort?.column === index ? (pager.sort.dir === 'asc' ? g.up : g.down) : ''
      const label = trunc(c.label, c.width - mark.length) + mark
      header.push({ text: (i ? ' ' : '') + (c.numeric ? padLeft(label, c.width) : pad(label, c.width)), fg: index === st.col && focused ? t.acc2 : t.acc })
    })
    out.push(<SegLine key="h" segs={header} width={iw} />)
    out.push(<PlainLine key="r" text={g.rule.repeat(iw)} width={iw} fg={t.border} />)
    if (!pager.columns.length) {
      const r = st.response
      out.push(<PlainLine key="none" text={` ${r?.rowsAffected !== undefined && r?.rowsAffected !== null ? `${num(r.rowsAffected)} rows affected` : 'the statement returned no columns'}`} width={iw} fg={t.dim} />)
    }
    const window = pager.window(st.top, rowsShown)
    window.forEach((row, i) => {
      const index = st.top + i
      const sel = index === st.row
      const bg = sel ? (focused ? t.selBg : t.selInactiveBg) : undefined
      const fg = sel ? (focused ? t.selFg : t.fg) : t.fg
      if (!row) {
        out.push(<PlainLine key={`l${i}`} text=" loading…" width={iw} fg={t.dim} bg={bg} />)
        return
      }
      const segs: Seg[] = [{ text: ' ' }]
      shown.forEach((c, j) => {
        const ci = Number(c.name)
        const v = row[ci]
        const text = valueText(v, pager.columns[ci]?.kind)
        const cellText = (j ? ' ' : '') + (c.numeric ? padLeft(text, c.width) : pad(text, c.width))
        segs.push({ text: cellText, fg: v === null || v === undefined ? (sel ? fg : t.dim) : sel && ci === st.col && focused ? fg : fg, bg: sel && ci === st.col && focused ? t.acc2 : undefined })
      })
      out.push(<SegLine key={`d${i}`} segs={segs} width={iw} bg={bg} fg={fg} />)
    })
    if (!pager.total && pager.columns.length) out.push(<PlainLine key="empty" text=" (no rows)" width={iw} fg={t.dim} />)
    while (out.length < inner - 1) out.push(<PlainLine key={`p${out.length}`} text="" width={iw} />)
    out.push(<PlainLine key="status" text={this.statusText(st, cols.length)} width={iw} fg={pager.error ? t.err : t.dim} />)
    return out
  }

  /**
   * The status line under the grid: rows, elapsed, backend, read-only, limit and sort are kept; the
   * cursor position and loading notes are dropped first when the line does not fit.
   */
  statusText(st: CellState, colCount: number, width = this.lastRender.width - 2): string {
    const pager = st.pager!
    const backend = st.backend ?? this.backendOf() ?? '?'
    const dialect = this.backendInfo(backend)?.dialect
    const tokens: Array<[string, number]> = [
      [`${num(pager.total)} row${pager.total === 1 ? '' : 's'}${pager.truncated ? ` (cut at the limit: ${pager.truncatedReason ?? 'ROWS'})` : ''}`, 0],
      [`${num(st.ms)} ms`, 0],
      [`${backend}${dialect && dialect !== backend ? ` (${dialect})` : ''}`, 0],
      ['read-only', 1],
      [`limit ${num(this.caps?.limits?.maxRows)}`, 1],
      [pager.sort ? `sort ${pager.columns[pager.sort.column]?.label ?? pager.sort.column} ${pager.sort.dir}` : '', 0],
      [pager.total ? `row ${num(st.row + 1)}` : '', 2],
      [colCount ? `col ${st.col + 1}/${colCount}` : '', 3],
      [pager.loading ? 'loading' : '', 2],
      [pager.error ? `error: ${pager.error}` : '', 0],
    ]
    let kept = tokens.filter(([t]) => t)
    const join = () => ` ${kept.map(([t]) => t).join(' · ')}`
    while (join().length > width && kept.some(([, d]) => d > 0)) {
      const worst = Math.max(...kept.map(([, d]) => d))
      const at = kept.map(([, d]) => d).lastIndexOf(worst)
      kept = kept.filter((_, i) => i !== at)
    }
    return join()
  }

  private planBody(st: CellState, iw: number, inner: number, focused: boolean): ReactNode[] {
    const t = theme()
    const g = glyphs()
    const ex = st.explain!
    const out: ReactNode[] = []
    const rowsShown = Math.max(1, inner - 1)
    out.push(<PlainLine key="ph" text={` EXPLAIN${ex.analyze ? ' ANALYZE' : ''} · ${ex.dialect ?? ''}${ex.durationMs !== undefined && ex.durationMs !== null ? ` · ${ex.durationMs} ms` : ''} · ${st.raw ? 'raw text (r tree)' : '←→ fold · r raw text'}`} width={iw} fg={t.dim} />)
    if (st.raw || !ex.plan) {
      const raw = (ex.raw ?? '').split('\n')
      raw.slice(st.planTop, st.planTop + rowsShown).forEach((l, i) => out.push(<PlainLine key={`raw${i}`} text={` ${l}`} width={iw} />))
      return out
    }
    const lines = planLines(ex.plan, st.collapsed)
    st.planCursor = Math.min(st.planCursor, lines.length - 1)
    if (st.planCursor < st.planTop) st.planTop = st.planCursor
    if (st.planCursor >= st.planTop + rowsShown) st.planTop = st.planCursor - rowsShown + 1
    lines.slice(st.planTop, st.planTop + rowsShown).forEach((l, i) => {
      const sel = st.planTop + i === st.planCursor
      out.push(<PlainLine key={`pl${i}`} text={` ${planLineText(l, iw - 2, { open: g.open, closed: g.closed, bar: g.bar })}`} width={iw} fg={sel ? (focused ? t.selFg : t.fg) : l.depth === 0 ? t.acc : t.fg} bg={sel ? (focused ? t.selBg : t.selInactiveBg) : undefined} />)
    })
    return out
  }

  private chartBody(st: CellState, iw: number, inner: number): ReactNode[] {
    const t = theme()
    const pager = st.pager!
    const numeric = numericColumns(pager.columns)
    const value = st.chartValue !== undefined && numeric.includes(st.chartValue) ? st.chartValue : numeric.includes(st.col) ? st.col : numeric[0]!
    st.chartValue = value
    const labelCol = st.chartLabel ?? pager.columns.findIndex((c, i) => i !== value && c.kind !== 'number')
    const rowsShown = Math.max(1, inner - 1)
    const rows = pager.window(st.top, rowsShown).filter((r): r is unknown[] => Boolean(r))
    const items = rows.map((r, i) => ({ label: labelCol >= 0 ? valueText(r[labelCol], pager.columns[labelCol]?.kind) : `row ${st.top + i + 1}`, value: Number(r[value] ?? 0) || 0 }))
    const head = ` ${pager.columns[value]?.label ?? value} by ${labelCol >= 0 ? pager.columns[labelCol]?.label : 'row'} · rows ${num(st.top + 1)}–${num(st.top + rows.length)} of ${num(pager.total)} · ←→ value · l label · PgDn more`
    const out: ReactNode[] = [<PlainLine key="ch" text={head} width={iw} fg={t.dim} />]
    barLines(items, iw - 2, glyphs().bar).forEach((l, i) => out.push(<PlainLine key={`b${i}`} text={` ${l}`} width={iw} fg={t.acc} />))
    return out
  }

  private renderSchema(w: number, h: number, focused: boolean): ReactNode {
    const t = theme()
    const pane = this.schemaPane
    const inner = h - 2
    const iw = w - 2
    const items = pane.items(this)
    pane.cursor = Math.min(pane.cursor, Math.max(0, items.length - 1))
    const rowsShown = Math.max(1, inner - 1)
    if (pane.cursor < pane.top) pane.top = pane.cursor
    if (pane.cursor >= pane.top + rowsShown) pane.top = pane.cursor - rowsShown + 1
    const out: ReactNode[] = [<PlainLine key="f" text={pane.filter ? ` filter: ${pane.filter}` : focused ? ' type to filter' : ''} width={iw} fg={pane.filter ? t.acc2 : t.dim} />]
    items.slice(pane.top, pane.top + rowsShown).forEach((it, i) => {
      const sel = pane.top + i === pane.cursor
      const indent = '  '.repeat(it.depth)
      const detail = it.detail ? ` ${it.detail}` : ''
      const room = iw - 1 - indent.length
      // the name first: the detail (type, column count) gets what is left
      const label = trunc(it.text, it.kind === 'column' ? room - Math.min(detail.length, Math.max(0, room - it.text.length)) : room - Math.min(detail.length, 6))
      const text = ` ${indent}${label}`
      const right = trunc(detail, Math.max(0, iw - text.length))
      const line = pad(text, iw - right.length) + right
      out.push(<PlainLine key={it.key} text={line} width={iw} fg={sel && focused ? t.selFg : it.kind === 'backend' ? t.acc : it.kind === 'note' ? t.dim : t.fg} bg={sel ? (focused ? t.selBg : t.selInactiveBg) : undefined} />)
    })
    while (out.length < inner) out.push(<PlainLine key={`p${out.length}`} text="" width={iw} />)
    return (
      <box flexDirection="column" overflow="hidden" width={w} height={h} {...borderProps(focused)} title=" Schema " {...(focused ? { bottomTitle: trunc(' Enter inserts · →← fold ', w - 4) } : {})}>
        {out}
      </box>
    )
  }
}
