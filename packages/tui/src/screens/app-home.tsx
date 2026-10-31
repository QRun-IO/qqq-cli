/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readViewSettings, widgetToBlocks, writeViewSettings, type RenderBlock } from '@qrun-io/qqq-core'
import type { AppTreeNode } from '../client'
import type { Key } from '../keys'
import { openApp, openProcess, openTable } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { errorText, num, pad } from '../util/text'
import { blockLines } from '../widgets'
import { ListModel, Panel, type Row } from './list'

interface AppMeta {
  name: string
  label: string
  widgets?: string[]
  sections?: Array<{ name: string; label: string; role?: string; tables?: string[]; processes?: string[]; reports?: string[]; widgets?: string[] }>
  children?: AppTreeNode[]
}

/** An app's home: its widgets drawn from render blocks, then its sections (tables with counts, processes, reports, sub-apps). */
export class AppHomeScreen implements Screen {
  readonly kind = 'app'
  readonly id: string
  readonly list = new ListModel()
  widgets = new Map<string, RenderBlock[] | { error: string }>()
  counts = new Map<string, number | string>()
  width = 100
  /** Lazy loading: what each widget or count row needs, by the row it is drawn on; at most 4 requests at once. */
  private tasks = new Map<string, { row: number; run: () => Promise<void> }>()
  private started = new Set<string>()
  private active = 0
  private readonly abort = new AbortController()
  static readonly CONCURRENCY = 4

  constructor(private store: AppStore, readonly appName: string) {
    this.id = `app:${appName}`
    this.load()
  }

  get app(): AppMeta | undefined {
    return (this.store.meta?.apps as Record<string, AppMeta> | undefined)?.[this.appName]
  }

  title(): string {
    return this.app?.label ?? this.appName
  }

  helpTopic() {
    return { kind: 'app' as const, name: this.appName }
  }

  fkeys(): FKeyLabels {
    return { 3: 'Open', 4: null, 6: null, 7: null, 8: null }
  }

  widgetOrder(): string[] {
    const declared = this.app?.widgets ?? []
    const saved = readViewSettings(this.id).widgetOrder ?? []
    return [...saved.filter((w) => declared.includes(w)), ...declared.filter((w) => !saved.includes(w))]
  }

  load(): void {
    this.build()
  }

  /** Starts the requests whose rows are on screen or one page below, four at a time. */
  pump(): void {
    const client = this.store.client
    if (!client || this.abort.signal.aborted) return
    const limit = this.list.top + this.list.height * 2
    const ready = [...this.tasks.entries()].filter(([k, t]) => !this.started.has(k) && t.row <= limit).sort((a, b) => a[1].row - b[1].row)
    for (const [key, task] of ready) {
      if (this.active >= AppHomeScreen.CONCURRENCY) break
      this.started.add(key)
      this.active++
      task.run().finally(() => {
        this.active--
        if (this.abort.signal.aborted) return
        this.build()
        this.store.bump()
        queueMicrotask(() => this.pump())
      })
    }
  }

  dispose(): void {
    this.abort.abort()
  }

  private widgetTask(w: string, row: number): void {
    if (this.started.has(`w:${w}`)) return
    const client = this.store.client!.withSignal(this.abort.signal)
    this.tasks.set(`w:${w}`, { row, run: () => client.widget(w).then((data) => { this.widgets.set(w, widgetToBlocks(data)) }).catch((e) => { if (!this.abort.signal.aborted) this.widgets.set(w, { error: errorText(e) }) }) })
  }

  private countTask(t: string, row: number): void {
    if (this.started.has(`c:${t}`)) return
    const client = this.store.client!.withSignal(this.abort.signal)
    this.tasks.set(`c:${t}`, { row, run: () => client.count(t, { criteria: [], booleanOperator: 'AND' }).then((n) => { this.counts.set(t, n) }).catch(() => { this.counts.set(t, '?') }) })
  }

  tableNames(): string[] {
    const names = new Set<string>()
    for (const s of this.app?.sections ?? []) for (const t of s.tables ?? []) names.add(t)
    for (const c of this.app?.children ?? []) if (c.type === 'TABLE') names.add(c.name)
    return [...names]
  }

  build(): void {
    const t = theme()
    const g = glyphs()
    const meta = this.store.meta
    const rows: Row[] = []
    const width = this.width
    for (const w of this.widgetOrder()) {
      const data = this.widgets.get(w)
      const label = (meta?.widgets as Record<string, { label?: string }> | undefined)?.[w]?.label ?? w
      // widget headings are selectable (Enter reloads it), so the cursor starts at the top and only visible widgets load
      const reload = () => { this.widgets.delete(w); this.started.delete(`w:${w}`); this.build(); this.store.bump() }
      if (!data) {
        this.widgetTask(w, rows.length)
        rows.push({ text: label, fg: t.acc, bold: true, key: `w:${w}`, action: reload })
        rows.push({ text: '  loading…', fg: t.dim })
      } else if ('error' in data) {
        rows.push({ text: label, fg: t.acc, bold: true, key: `w:${w}`, action: reload })
        rows.push({ text: `  ${data.error}`, fg: t.err })
      } else {
        const heading = data[0]?.kind === 'heading' ? data[0] : undefined
        rows.push({ text: heading ? heading.text : label, fg: t.acc, bold: true, key: `w:${w}`, action: reload })
        if (heading?.sub) rows.push({ text: `  ${heading.sub}`, fg: t.dim })
        rows.push(...blockLines(heading ? data.slice(1) : data, width - 4).map((l) => ({ ...l, text: '  ' + l.text })))
      }
      rows.push({ text: g.rule.repeat(Math.min(width - 2, 80)), fg: t.border })
    }
    const sections = this.app?.sections?.length ? this.app.sections : [{ name: this.appName, label: this.title(), tables: this.app?.children?.filter((c) => c.type === 'TABLE').map((c) => c.name), processes: this.app?.children?.filter((c) => c.type === 'PROCESS').map((c) => c.name) }]
    for (const s of sections) {
      rows.push({ text: s.label, fg: t.acc, bold: true })
      for (const name of s.tables ?? []) {
        const label = meta?.tables?.[name]?.label ?? name
        const c = this.counts.get(name)
        if (c === undefined && this.store.client) this.countTask(name, rows.length)
        rows.push({ text: `    ${pad(label, 34)} ${typeof c === 'number' ? num(c) + ' records' : c ?? '…'}`, key: `t:${name}`, action: () => openTable(this.store, name) })
      }
      for (const name of s.processes ?? []) rows.push({ text: `  ${g.process} ${meta?.processes?.[name]?.label ?? name}`, key: `p:${name}`, action: () => openProcess(this.store, name) })
      for (const name of s.reports ?? []) rows.push({ text: `  ${g.report} ${(meta?.reports as Record<string, { label?: string }> | undefined)?.[name]?.label ?? name}  (run with :report run ${name})`, key: `r:${name}`, action: () => this.store.commands().commandLine(`report run ${name} --format csv`) })
    }
    const listed = new Set(sections.flatMap((s) => [...(s.tables ?? []), ...(s.processes ?? []), ...(s.reports ?? [])]))
    const others = (this.app?.children ?? []).filter((c) => !listed.has(c.name))
    if (others.length) {
      rows.push({ text: 'More', fg: t.acc, bold: true })
      for (const c of others) {
        if (c.type === 'APP') rows.push({ text: `  ${g.app} ${c.label}`, key: `a:${c.name}`, action: () => openApp(this.store, c.name) })
        else if (c.type === 'TABLE') rows.push({ text: `    ${c.label}`, key: `t:${c.name}`, action: () => openTable(this.store, c.name) })
        else if (c.type === 'PROCESS') rows.push({ text: `  ${g.process} ${c.label}`, key: `p:${c.name}`, action: () => openProcess(this.store, c.name) })
      }
    }
    if (!rows.length) rows.push({ text: '(this app has no widgets or sections)', fg: t.dim })
    this.list.setRows(rows)
  }

  onKey(key: Key): boolean {
    if (key.name === 'f3') {
      this.list.current?.action?.()
      return true
    }
    return this.list.onKey(key)
  }

  refresh(): void {
    this.widgets.clear()
    this.counts.clear()
    this.started.clear()
    this.tasks.clear()
    this.load()
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = []
    for (const r of this.list.rows) if (r.action && r.key) out.push({ section: 'Context', label: `Open ${r.text.trim().replace(/\s{2,}.*/, '')}`, detail: r.key.startsWith('t:') ? String(this.counts.get(r.key.slice(2)) ?? '') : undefined, run: r.action })
    out.push({ section: 'Context', label: 'Refresh widgets and counts', key: 'F5', run: () => this.refresh() })
    return out
  }

  viewSettings(): Overlay | undefined {
    const order = this.widgetOrder()
    if (!order.length) return undefined
    return new WidgetOrderOverlay(this.store, this, order)
  }

  render(width: number, height: number, focused: boolean) {
    if (width !== this.width) {
      this.width = width
      this.build()
    }
    const view = this.list.view(width - 2, height - 2, focused)
    queueMicrotask(() => this.pump())
    return <Panel title={this.title()} width={width} height={height} focused={focused}>{view}</Panel>
  }
}

/** View settings of an app home: widget order (Shift+↑↓ or +/- moves the selected widget). */
class WidgetOrderOverlay extends ChoiceOverlay<string> {
  constructor(private s: AppStore, private screen: AppHomeScreen, private order: string[]) {
    super(s, 'Widget order', order.map((w) => ({ label: w, value: w })), () => undefined, '+/- move · Enter saves')
  }
  override onKey(key: Key): void {
    const move = (dir: number) => {
      const i = this.index
      const j = i + dir
      if (j < 0 || j >= this.order.length) return
      ;[this.order[i], this.order[j]] = [this.order[j]!, this.order[i]!]
      this.choices.splice(0, this.choices.length, ...this.order.map((w) => ({ label: w, value: w })))
      this.index = j
    }
    if (key.sequence === '+' || (key.shift && key.name === 'down')) return move(1)
    if (key.sequence === '-' || (key.shift && key.name === 'up')) return move(-1)
    if (key.name === 'return') {
      writeViewSettings(this.screen.id, { ...readViewSettings(this.screen.id), widgetOrder: this.order })
      this.s.closeOverlay(this)
      this.screen.build()
      return
    }
    super.onKey(key)
  }
}
