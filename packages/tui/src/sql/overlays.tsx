/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The SQL Runner's dialogs: notebooks (F2), cells (F4) and the execution history (F7). */

import type { Key } from '../keys'
import { charOf } from '../keys'
import { overlayId, PromptOverlay } from '../overlays/basic'
import { Frame, Line } from '../overlays/frame'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad, trunc } from '../util/text'
import { cellSummary, type Notebook } from './model'
import type { SqlRunnerScreen } from './screen'

/** One line of key help that drops whole tokens from the end when it does not fit. */
function hint(tokens: string[], width: number): string {
  let out = ''
  for (const t of tokens) {
    const next = out ? `${out} · ${t}` : t
    if (next.length + 1 > width) break
    out = next
  }
  return ` ${out}`
}

function Row(props: { text: string; width: number; selected: boolean; fg?: string }) {
  const t = theme()
  return <text flexShrink={0} wrapMode="none" fg={props.selected ? t.selFg : props.fg ?? t.fg} bg={props.selected ? t.selBg : undefined}>{pad(props.text, props.width)}</text>
}

/** A scrolling list window around a cursor. */
function windowOf<T>(list: T[], cursor: number, rows: number): { top: number; shown: T[] } {
  const top = Math.max(0, Math.min(cursor - Math.floor(rows / 2), list.length - rows))
  return { top, shown: list.slice(top, top + rows) }
}

/** GET /notebooks summaries. */
interface NotebookSummary {
  id: number
  title: string
  description?: string | null
  visibility?: string
  ownerName?: string | null
  defaultBackendName?: string | null
  currentVersion?: number
  canEdit?: boolean
  modifyDate?: string | null
}

/** F2: the notebook library (Mine and Shared), with open, new, save, save as, duplicate, delete and publish. */
export class NotebooksOverlay implements Overlay {
  readonly id = overlayId('sql-notebooks')
  scope: 'mine' | 'shared' = 'mine'
  list: NotebookSummary[] = []
  cursor = 0
  loading = true
  error?: string

  constructor(private store: AppStore, private screen: SqlRunnerScreen) {
    this.load()
  }

  load(): void {
    this.loading = true
    this.store.client!.data<{ notebooks?: NotebookSummary[] }>('sqlWorkbenchListNotebooks', { query: { scope: this.scope } }).then((d) => {
      this.list = d.notebooks ?? []
      this.error = undefined
      const at = this.list.findIndex((n) => n.id === this.screen.notebook.id)
      this.cursor = at >= 0 ? at : Math.min(this.cursor, Math.max(0, this.list.length - 1))
    }).catch((e) => { this.error = errorText(e) }).finally(() => {
      this.loading = false
      this.store.bump()
    })
  }

  private close(): void {
    this.store.closeOverlay(this)
  }

  onKey(key: Key): void {
    const s = this.store
    const item = this.list[this.cursor]
    const ch = charOf(key)
    const canShare = Boolean(this.screen.caps?.canShare)
    if (key.name === 'escape') return this.close()
    if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
      this.scope = this.scope === 'mine' ? 'shared' : 'mine'
      this.cursor = 0
      return this.load()
    }
    if (key.name === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key.name === 'down') { this.cursor = Math.min(this.list.length - 1, this.cursor + 1); return }
    if (key.name === 'pageup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key.name === 'pagedown') { this.cursor = Math.min(this.list.length - 1, this.cursor + 10); return }
    if (key.name === 'return') {
      if (!item) return
      this.close()
      return this.screen.openNotebook(item.id)
    }
    if (ch === 'n') { this.close(); return this.screen.newNotebook() }
    if (ch === 's') { this.close(); return this.screen.save() }
    if (ch === 'a') { this.close(); return this.screen.saveAs() }
    if (ch === 'r') return this.load()
    if (!item) return
    if (ch === 'u') {
      return s.run(s.client!.data<Notebook>('sqlWorkbenchDuplicateNotebook', { path: { id: String(item.id) }, json: {} }), (nb) => {
        s.flash(`duplicated as ${nb.title}`)
        this.scope = 'mine'
        this.load()
      })
    }
    if (ch === 'd') {
      if (item.canEdit === false) return s.flash('only the owner can delete a notebook', 'error')
      return s.confirm(`Delete the notebook ${item.title}, its cells, versions and pinned results?`, () => s.run(s.client!.call('sqlWorkbenchDeleteNotebook', { path: { id: String(item.id) } }), () => {
        s.flash(`deleted ${item.title}`)
        if (this.screen.notebook.id === item.id) {
          this.screen.notebook = { ...this.screen.notebook, id: undefined, title: `${item.title} (deleted)` }
          this.screen.edited = true
        }
        this.load()
      }))
    }
    if (ch === 'p') {
      if (!canShare) return s.flash('publishing needs the sql_workbench.share permission', 'error')
      if (item.canEdit === false) return s.flash('only the owner can publish a notebook', 'error')
      const shared = item.visibility !== 'SHARED'
      return s.run(s.client!.data<Notebook>('sqlWorkbenchPublishNotebook', { path: { id: String(item.id) }, json: { shared } }), () => {
        s.flash(shared ? `${item.title} is in the shared library` : `${item.title} is personal again`)
        this.load()
      })
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 100)
    const iw = width - 2
    const rows = Math.max(3, Math.min(Math.max(this.list.length, 3), sh - 10))
    const { top, shown } = windowOf(this.list, this.cursor, rows)
    const tabs = ` ${this.scope === 'mine' ? '[Mine]' : ' Mine '} ${this.scope === 'shared' ? '[Shared]' : ' Shared '}   ${this.loading ? 'loading…' : `${this.list.length} notebook${this.list.length === 1 ? '' : 's'}`}`
    const current = this.screen.notebook
    return (
      <Frame title="Notebooks" width={width} height={rows + 5} screenWidth={sw} screenHeight={sh}>
        <Line text={tabs} width={iw} fg={t.acc} />
        <Line text={trunc(` open: ${current.id !== undefined ? current.title : 'Untitled (not saved)'}${this.screen.edited ? ' · unsaved changes' : ''}`, iw)} width={iw} fg={t.dim} />
        {shown.map((n, i) => {
          const mark = n.id === current.id ? glyphs().pointer : ' '
          const flags = [n.visibility === 'SHARED' ? 'shared' : '', n.canEdit === false ? `by ${n.ownerName ?? 'someone else'}` : '', n.currentVersion ? `v${n.currentVersion}` : '', n.defaultBackendName ?? ''].filter(Boolean).join(' · ')
          const room = Math.max(10, iw - flags.length - 4)
          return <Row key={n.id} text={` ${mark} ${pad(trunc(n.title, room), room)} ${flags}`} width={iw} selected={top + i === this.cursor} />
        })}
        {Array.from({ length: rows - shown.length }, (_, i) => <Line key={`e${i}`} text={i === 0 && !shown.length ? (this.error ? ` ${this.error}` : this.loading ? '' : this.scope === 'mine' ? ' (no notebooks yet: s saves this one)' : ' (nothing shared with you)') : ''} width={iw} fg={this.error ? t.err : t.dim} />)}
        <Line text={hint(['Enter open', 'Tab mine/shared', 's save', 'a save as', 'n new', 'u duplicate', 'd delete', ...(this.screen.caps?.canShare ? ['p publish'] : []), 'Esc'], iw)} width={iw} fg={t.dim} />
      </Frame>
    )
  }
}

/** F4: the notebook's cells, with go to, add, move, title, backend, delete and run all. */
export class CellsOverlay implements Overlay {
  readonly id = overlayId('sql-cells')
  cursor: number

  constructor(private store: AppStore, private screen: SqlRunnerScreen) {
    this.cursor = screen.cellIndex
  }

  onKey(key: Key): void {
    const sc = this.screen
    const cells = sc.notebook.cells
    const ch = charOf(key)
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'up' && key.shift) { this.cursor = sc.moveCellBy(this.cursor, -1); return }
    if (key.name === 'down' && key.shift) { this.cursor = sc.moveCellBy(this.cursor, 1); return }
    if (key.name === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key.name === 'down') { this.cursor = Math.min(cells.length - 1, this.cursor + 1); return }
    if (key.name === 'return') {
      this.store.closeOverlay(this)
      sc.goCell(this.cursor)
      sc.focus = 'editor'
      return
    }
    if (ch === 'K') { this.cursor = sc.moveCellBy(this.cursor, -1); return }
    if (ch === 'J') { this.cursor = sc.moveCellBy(this.cursor, 1); return }
    if (ch === 'a' || ch === 'm') {
      this.store.closeOverlay(this)
      if (sc.cellIndex !== this.cursor) sc.goCell(this.cursor)
      return sc.addCell(ch === 'a' ? 'SQL' : 'MARKDOWN')
    }
    if (ch === 'R') {
      this.store.closeOverlay(this)
      return sc.runAll()
    }
    if (ch === 't') {
      const cell = cells[this.cursor]
      return this.store.open(new PromptOverlay(this.store, `Title of cell ${this.cursor + 1}`, 'Shown in the cell list and the Next UI; empty removes it.', (v) => sc.setCellTitle(this.cursor, v), cell?.title ?? ''))
    }
    if (ch === 'b') {
      if (cells[this.cursor]?.cellType !== 'SQL') return this.store.flash('only SQL cells run on a backend')
      return sc.chooseBackend(this.cursor)
    }
    if (ch === 'd') {
      const cell = cells[this.cursor]
      if (!cell) return
      return this.store.confirm(`Delete cell ${this.cursor + 1} (${trunc(cellSummary(cell), 40)})?`, () => {
        sc.deleteCell(this.cursor)
        this.cursor = Math.min(this.cursor, sc.notebook.cells.length - 1)
      })
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 90)
    const iw = width - 2
    const cells = this.screen.notebook.cells
    const rows = Math.max(3, Math.min(cells.length, sh - 9))
    const { top, shown } = windowOf(cells, this.cursor, rows)
    return (
      <Frame title={`Cells of ${this.screen.notebook.id !== undefined ? this.screen.notebook.title : 'Untitled'}`} width={width} height={rows + 4} screenWidth={sw} screenHeight={sh}>
        {shown.map((c, i) => {
          const index = top + i
          const backend = c.cellType === 'SQL' ? this.screen.backendOf(c) ?? '' : ''
          const mark = index === this.screen.cellIndex ? glyphs().pointer : ' '
          const right = `${c.cellType === 'SQL' ? 'SQL' : 'MD '} ${backend}`
          const room = Math.max(8, iw - right.length - 8)
          return <Row key={c.cellKey} text={` ${mark} ${String(index + 1).padStart(2)} ${pad(trunc(cellSummary(c), room), room)} ${right}`} width={iw} selected={index === this.cursor} />
        })}
        {Array.from({ length: rows - shown.length }, (_, i) => <Line key={`e${i}`} text="" width={iw} />)}
        <Line text={hint(['Enter edit', 'a add SQL', 'm add notes', 'R run all', 'Esc'], iw)} width={iw} fg={t.dim} />
        <Line text={hint(['K J or Shift+↑↓ move', 't title', 'b backend', 'd delete'], iw)} width={iw} fg={t.dim} />
      </Frame>
    )
  }
}

/** An audited execution from GET /history. */
export interface HistoryEntry {
  executionUuid?: string
  backendName?: string
  mode?: string
  status?: string
  sqlText?: string
  notebookId?: number | null
  startTime?: string | null
  durationMs?: number | null
  rowsReturned?: number | null
  rowsAffected?: number | null
  errorMessage?: string | null
}

/** One history entry as a line: time, status, duration, rows, mode, SQL. */
export function historyLine(e: HistoryEntry, width: number, ascii = false): string {
  const d = e.startTime ? new Date(e.startTime) : undefined
  const two = (n: number) => String(n).padStart(2, '0')
  const time = d && !Number.isNaN(d.getTime()) ? `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : '?'.padEnd(14)
  const ok = e.status === 'SUCCEEDED' ? (ascii ? 'ok' : '✓') : e.status === 'RUNNING' ? '…' : (ascii ? 'x ' : '✗')
  const rows = e.rowsAffected !== null && e.rowsAffected !== undefined ? `${e.rowsAffected} aff` : e.rowsReturned !== null && e.rowsReturned !== undefined ? `${e.rowsReturned} rows` : ''
  const mode = e.mode && e.mode !== 'READ_ONLY' ? ` ${e.mode.toLowerCase()}` : ''
  const head = `${time} ${ok} ${String(e.durationMs ?? '').padStart(5)} ms ${rows.padStart(9)}${mode} `
  return trunc(head + (e.sqlText ?? '').replace(/\s+/g, ' '), width)
}

/** F7: the caller's audited executions; Enter opens the SQL, r re-runs it. */
export class HistoryOverlay implements Overlay {
  readonly id = overlayId('sql-history')
  cursor = 0
  filter = ''

  constructor(private store: AppStore, readonly entries: HistoryEntry[], private pick: (entry: HistoryEntry, rerun: boolean) => void) {}

  matches(): HistoryEntry[] {
    const n = this.filter.toLowerCase()
    return n ? this.entries.filter((e) => (e.sqlText ?? '').toLowerCase().includes(n) || (e.status ?? '').toLowerCase().includes(n)) : this.entries
  }

  onKey(key: Key): void {
    const list = this.matches()
    if (key.name === 'escape') {
      if (this.filter) { this.filter = ''; this.cursor = 0; return }
      return this.store.closeOverlay(this)
    }
    if (key.name === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key.name === 'down') { this.cursor = Math.min(list.length - 1, this.cursor + 1); return }
    if (key.name === 'pageup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key.name === 'pagedown') { this.cursor = Math.min(list.length - 1, this.cursor + 10); return }
    const e = list[this.cursor]
    if (key.name === 'return' || (key.ctrl && key.name === 'r')) {
      if (!e) return
      this.store.closeOverlay(this)
      return this.pick(e, key.name !== 'return')
    }
    if (key.name === 'backspace') { this.filter = this.filter.slice(0, -1); this.cursor = 0; return }
    const ch = charOf(key)
    if (ch) {
      this.filter += ch
      this.cursor = 0
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 120)
    const iw = width - 2
    const list = this.matches()
    const rows = Math.max(3, Math.min(Math.max(list.length, 3), sh - 11))
    const { top, shown } = windowOf(list, this.cursor, rows)
    const e = list[this.cursor]
    const ascii = Boolean(glyphs().border)
    const detail = e?.errorMessage ? `error: ${e.errorMessage}` : e ? `${e.backendName ?? ''} · ${e.mode ?? ''} · ${e.status ?? ''}${e.executionUuid ? ` · ${e.executionUuid}` : ''}` : ''
    return (
      <Frame title="History (your audited runs)" width={width} height={rows + 5} screenWidth={sw} screenHeight={sh}>
        <Line text={this.filter ? ` filter: ${this.filter}` : ' type to filter'} width={iw} fg={this.filter ? t.acc2 : t.dim} />
        {shown.map((h, i) => <Row key={`${h.executionUuid ?? i}`} text={` ${historyLine(h, iw - 2, ascii)}`} width={iw} selected={top + i === this.cursor} fg={h.status === 'SUCCEEDED' ? t.fg : t.err} />)}
        {Array.from({ length: rows - shown.length }, (_, i) => <Line key={`e${i}`} text={i === 0 && !shown.length ? ' (no runs yet)' : ''} width={iw} fg={t.dim} />)}
        <Line text={trunc(` ${detail.replace(/\s+/g, ' ')}`, iw)} width={iw} fg={e?.errorMessage ? t.err : t.dim} />
        <Line text={hint(['Enter open in the editor', 'Ctrl+R re-run', 'type to filter', 'Esc'], iw)} width={iw} fg={t.dim} />
      </Frame>
    )
  }
}
