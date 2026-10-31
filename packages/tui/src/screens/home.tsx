/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Home screen, the terminal counterpart of the Next UI dashboard landing page: who and where
 * you are, counts, recently viewed records, quick actions, application cards, work (jobs, alerts,
 * my work, release notes) when the server has them, and the instance home app's widgets when the
 * metadata declares one. Panels are focused with Tab, arrows move inside, Enter opens, PgUp/PgDn
 * scroll; the panel order is a view setting. Built from cached metadata and the kernel index;
 * the only requests are the optional counts, which load after it is shown.
 */

import { Collaboration, readRecents, readViewSettings, widgetToBlocks, writeViewSettings, type RecentItem, type RenderBlock } from '@qrun-io/qqq-core'
import type { AppTreeNode } from '../client'
import type { Key } from '../keys'
import { openApp, openForm, openProcess, openRecord, openTable } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Overlay, Screen } from '../types'
import { errorText, num, pad, trunc } from '../util/text'
import { blockLines, type StyledLine } from '../widgets'

/** Counts the tables, processes and reports under an app node, recursively. */
export function countUnder(node: AppTreeNode): { tables: number; processes: number; reports: number; apps: number } {
  const c = { tables: 0, processes: 0, reports: 0, apps: 0 }
  for (const ch of node.children ?? []) {
    if (ch.type === 'TABLE') c.tables++
    else if (ch.type === 'PROCESS') c.processes++
    else if (ch.type === 'REPORT') c.reports++
    else if (ch.type === 'APP') {
      c.apps++
      const sub = countUnder(ch)
      c.tables += sub.tables
      c.processes += sub.processes
      c.reports += sub.reports
    }
  }
  return c
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

type PanelId = 'recent' | 'actions' | 'apps' | 'work' | 'homeApp'
export const DEFAULT_PANELS: PanelId[] = ['homeApp', 'recent', 'actions', 'apps', 'work']
const PANEL_TITLES: Record<PanelId, string> = { recent: 'Recently viewed', actions: 'Quick actions', apps: 'Applications', work: 'Work', homeApp: 'Home dashboard' }

interface Item {
  label: string
  detail?: string
  run?: () => void
  /** Card lines (applications grid). */
  card?: string[]
}

interface PanelModel {
  id: PanelId
  title: string
  items: Item[]
  grid: boolean
  /** Lines drawn without selection (widgets, empty states). */
  static?: StyledLine[]
}

type Seg = { text: string; fg?: string; bg?: string; bold?: boolean }

export class HomeScreen implements Screen {
  readonly kind = 'home'
  readonly id = 'home'
  panelIndex = 0
  cursors = new Map<PanelId, number>()
  scroll = 0
  height = 20
  width = 100
  homeWidgets = new Map<string, RenderBlock[] | { error: string }>()
  work = new Map<string, string>()
  private loaded = false
  private readonly abort = new AbortController()

  constructor(private store: AppStore) {}

  title(): string {
    return 'Home'
  }

  fkeys(): FKeyLabels {
    return { 3: 'Open', 4: null, 6: null, 7: null, 8: null }
  }

  homeAppName(): string | undefined {
    const name = (this.store.meta as { homeAppName?: string } | undefined)?.homeAppName
    return name && (this.store.meta?.apps as Record<string, unknown> | undefined)?.[name] ? name : undefined
  }

  order(): PanelId[] {
    const saved = (readViewSettings('home').panels as PanelId[] | undefined) ?? []
    return [...saved.filter((p) => DEFAULT_PANELS.includes(p)), ...DEFAULT_PANELS.filter((p) => !saved.includes(p))]
  }

  /** Optional numbers that need a request: jobs, alerts, my work; the home app's widgets. */
  loadExtras(): void {
    if (this.loaded || !this.store.client) return
    this.loaded = true
    const s = this.store
    const client = s.client!.withSignal(this.abort.signal)
    if ((s.version?.features ?? []).includes('durableJobs')) {
      client.data<{ activeCount?: number; jobs?: unknown[] }>('listJobs', { query: { scope: 'mine', state: 'active' } })
        .then((r) => this.work.set('jobs', `${r.activeCount ?? r.jobs?.length ?? 0} active`)).catch(() => this.work.set('jobs', 'n/a')).finally(() => s.bump())
    }
    if (s.extensions.has('collaboration')) {
      const collab = new Collaboration(s.extensions.registry, { call: (id, input) => client.call(id, input) })
      collab.myWork().then((w) => this.work.set('mywork', `${w.openTaskCount ?? 0} open tasks · ${w.unreadMentionCount ?? 0} mentions`)).catch(() => undefined).finally(() => s.bump())
      collab.favorites().then((f) => { this.favorites = f.filter((x) => x.available !== false).slice(0, 8).map((x) => ({ label: x.label ?? x.targetName ?? '', type: x.targetType ?? '', name: x.targetName ?? '', recordId: x.recordId ?? undefined })) }).catch(() => undefined).finally(() => s.bump())
    }
    const home = this.homeAppName()
    const widgets = home ? ((s.meta?.apps as Record<string, { widgets?: string[] }>)[home]?.widgets ?? []).slice(0, 8) : []
    for (const w of widgets) client.widget(w).then((d) => this.homeWidgets.set(w, widgetToBlocks(d))).catch((e) => this.homeWidgets.set(w, { error: errorText(e) })).finally(() => s.bump())
  }

  favorites: Array<{ label: string; type: string; name: string; recordId?: string }> = []

  dispose(): void {
    this.abort.abort()
  }

  panels(): PanelModel[] {
    const s = this.store
    const meta = s.meta
    const g = glyphs()
    const t = theme()
    const out: PanelModel[] = []
    for (const id of this.order()) {
      if (id === 'recent') {
        let recents: RecentItem[] = []
        try {
          recents = s.client ? readRecents(s.client.server).filter((r) => r.kind === 'record').slice(0, 8) : []
        } catch {
          recents = []
        }
        out.push({
          id, title: PANEL_TITLES[id], grid: false,
          items: recents.map((r) => ({ label: r.label, detail: `${meta?.tables?.[r.table ?? '']?.label ?? r.table} · ${timeAgo(r.at)}`, run: () => openRecord(s, r.table!, r.key) })),
          static: recents.length ? undefined : [{ text: 'No recently viewed records; records you open appear here.', fg: t.dim }],
        })
      } else if (id === 'actions') {
        const tree = (meta?.appTree ?? []) as AppTreeNode[]
        const tables: AppTreeNode[] = []
        const procs: AppTreeNode[] = []
        const walk = (nodes: AppTreeNode[]) => {
          for (const n of nodes) {
            if (n.type === 'TABLE' && tables.length < 6 && (meta?.tables?.[n.name] as { insertPermission?: boolean } | undefined)?.insertPermission) tables.push(n)
            else if (n.type === 'PROCESS' && procs.length < 6 && (meta?.processes?.[n.name] as { hasPermission?: boolean } | undefined)?.hasPermission !== false) procs.push(n)
            if (n.children && (tables.length < 6 || procs.length < 6)) walk(n.children)
          }
        }
        walk(tree)
        const items: Item[] = [
          ...procs.map((p) => ({ label: `${g.process} ${p.label}`, detail: 'run', run: () => openProcess(s, p.name) })),
          ...tables.map((x) => ({ label: `+ New ${x.label}`, detail: 'create', run: () => openForm(s, x.name, { mode: 'create' }) })),
          ...this.favorites.map((f) => ({ label: `★ ${f.label}`, detail: 'favorite', run: () => (f.recordId ? openRecord(s, f.name, f.recordId) : f.type === 'process' ? openProcess(s, f.name) : openTable(s, f.name)) })),
        ]
        out.push({ id, title: PANEL_TITLES[id], grid: false, items, static: items.length ? undefined : [{ text: 'No quick actions available.', fg: t.dim }] })
      } else if (id === 'apps') {
        const apps = ((meta?.appTree ?? []) as AppTreeNode[]).filter((a) => a.type === 'APP')
        const icons = meta?.apps as Record<string, { icon?: { name?: string }; widgets?: string[] }> | undefined
        out.push({
          id, title: `${PANEL_TITLES[id]} (${apps.length})`, grid: true,
          items: apps.map((a) => {
            const c = countUnder(a)
            const icon = icons?.[a.name]?.icon?.name
            const widgets = icons?.[a.name]?.widgets?.length ?? 0
            const parts = [c.tables && `${num(c.tables)} tables`, c.processes && `${num(c.processes)} processes`, c.reports && `${num(c.reports)} reports`, c.apps && `${c.apps} apps`, widgets && `${widgets} widgets`].filter(Boolean) as string[]
            return { label: a.label, run: () => openApp(s, a.name), card: [`${g.app} ${a.label}`, icon ? `[${icon}]` : '', parts.slice(0, 2).join(' · '), parts.slice(2).join(' · ')] }
          }),
        })
      } else if (id === 'work') {
        const items: Item[] = []
        const features = s.version?.features ?? []
        if (features.includes('durableJobs')) items.push({ label: 'Jobs', detail: this.work.get('jobs') ?? '…', run: () => void s.commands().run('jobs') })
        if (s.extensions.has('alerts')) items.push({ label: 'Notifications', detail: s.status.alerts !== undefined ? `${s.status.alerts} unread` : 'alerts extension', run: () => void s.commands().run('api --list') })
        if (s.extensions.has('collaboration')) items.push({ label: 'My work', detail: this.work.get('mywork') ?? '…' })
        if (s.extensions.has('release-notes')) items.push({ label: "What's new", detail: `release notes ${s.extensions.get('release-notes')?.version ?? ''}`, run: () => void s.commands().run('api --list') })
        for (const e of s.extensions.all()) if (!['alerts', 'collaboration', 'release-notes'].includes(e.name)) items.push({ label: `Extension ${e.name} ${e.version ?? ''}`, detail: trunc(e.description ?? '', 60) })
        if (items.length) out.push({ id, title: PANEL_TITLES[id], grid: false, items })
      } else if (id === 'homeApp') {
        const home = this.homeAppName()
        if (!home) continue
        const lines: StyledLine[] = []
        const app = (meta?.apps as Record<string, { label?: string; widgets?: string[] }>)[home]!
        for (const w of (app.widgets ?? []).slice(0, 8)) {
          const d = this.homeWidgets.get(w)
          if (!d) lines.push({ text: `${w}: loading…`, fg: t.dim })
          else if ('error' in d) lines.push({ text: `${w}: ${d.error}`, fg: t.err })
          else lines.push(...blockLines(d, Math.max(20, this.width - 6)))
          lines.push({ text: '' })
        }
        out.push({ id, title: app.label ?? PANEL_TITLES[id], grid: false, items: [{ label: `Open ${app.label ?? home}`, run: () => openApp(s, home) }], static: lines })
      }
    }
    return out
  }

  current(panels = this.panels()): { panel?: PanelModel; index: number } {
    const panel = panels[Math.min(this.panelIndex, panels.length - 1)]
    return { panel, index: panel ? Math.min(this.cursors.get(panel.id) ?? 0, Math.max(0, panel.items.length - 1)) : 0 }
  }

  cardsPerRow(): number {
    return Math.max(1, Math.floor((this.width - 4) / 30))
  }

  onKey(key: Key): boolean {
    const panels = this.panels()
    const { panel, index } = this.current(panels)
    if (key.name === 'tab' && panels.length) {
      if (!key.shift && this.panelIndex >= panels.length - 1) {
        this.panelIndex = 0
        return false // on to the Apps pane
      }
      this.panelIndex = (this.panelIndex + (key.shift ? panels.length - 1 : 1)) % panels.length
      return true
    }
    if (!panel) return false
    const set = (i: number) => this.cursors.set(panel.id, Math.max(0, Math.min(panel.items.length - 1, i)))
    const step = panel.grid ? this.cardsPerRow() : 1
    switch (key.name) {
      case 'down':
        if (index + step <= panel.items.length - 1) set(index + step)
        else if (this.panelIndex < panels.length - 1) this.panelIndex++
        return true
      case 'up':
        if (index - step >= 0) set(index - step)
        else if (this.panelIndex > 0) this.panelIndex--
        return true
      case 'right': if (panel.grid) set(index + 1); return true
      case 'left': if (panel.grid) set(index - 1); return true
      case 'home': this.panelIndex = 0; this.scroll = 0; return true
      case 'end': this.panelIndex = panels.length - 1; return true
      case 'pagedown': this.scroll += Math.max(1, this.height - 2); return true
      case 'pageup': this.scroll = Math.max(0, this.scroll - Math.max(1, this.height - 2)); return true
      case 'return': case 'f3': panel.items[index]?.run?.(); return true
      default: return false
    }
  }

  resume(): void {
    // recents and favorites may have changed
  }

  refresh(): void {
    this.loaded = false
    this.homeWidgets.clear()
    this.work.clear()
    this.store.run(this.store.client!.metaData(true).then((m) => this.store.setMeta(m)))
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = []
    for (const p of this.panels()) for (const it of p.items) if (it.run) out.push({ section: 'Context', label: `${p.id === 'apps' ? 'Open app ' : ''}${it.label}`, detail: it.detail, run: it.run })
    out.push({ section: 'Context', label: 'Home view settings (panel order)', key: 'v', run: () => { const o = this.viewSettings(); if (o) this.store.open(o) } })
    return out
  }

  viewSettings(): Overlay | undefined {
    return new PanelOrderOverlay(this.store, this.order(), () => this.store.bump())
  }

  /** Lays the panels out as lines of segments, records where each item is, and draws the window. */
  render(width: number, height: number, focused: boolean) {
    this.loadExtras()
    this.width = width
    this.height = height
    const t = theme()
    const g = glyphs()
    const s = this.store
    const inner = width - 2
    const lines: Seg[][] = []
    const meta = s.meta
    const brand = (meta?.branding as { appName?: string } | undefined)?.appName ?? 'QQQ'
    const hour = new Date().getHours()
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
    const first = s.status.user.split(/[\s@]/)[0]
    lines.push([{ text: ` ${greeting}${first ? `, ${first}` : ''} · ${brand}`, fg: t.acc, bold: true }])
    lines.push([{ text: ` ${s.status.server.replace(/^https?:\/\//, '')} · profile ${s.status.profile} · ${s.status.auth} · UI API ${s.status.apiVersion} · ${s.extensions.describe()}`, fg: t.dim }])
    lines.push([{ text: ` ${s.index?.describe() ?? ''}`, fg: t.fg }])
    lines.push([{ text: '' }])
    const panels = this.panels()
    const { panel: active, index: activeIndex } = this.current(panels)
    let activeLine = 0
    const frame = (p: PanelModel, w: number): { rows: Seg[][]; activeRow?: number } => {
      const isActive = p === active && focused
      const border = isActive ? t.focusBorder : t.border
      const h = g.rule
      const v = g.sep
      const rows: Seg[][] = []
      const title = ` ${p.title} `
      rows.push([{ text: `${g.border ? '+' : '┌'}${h}${title}${h.repeat(Math.max(0, w - title.length - 3))}${g.border ? '+' : '┐'}`, fg: border }])
      let activeRow: number | undefined
      const body = (segs: Seg[]) => rows.push([{ text: v, fg: border }, ...segs, { text: v, fg: border }])
      for (const l of p.static ?? []) body([{ text: pad(` ${l.text}`, w - 2), fg: l.fg, bold: l.bold }])
      if (p.grid) {
        const per = Math.max(1, Math.floor((w - 2) / 30))
        const cw = Math.floor((w - 2) / per)
        for (let r = 0; r * per < p.items.length; r++) {
          const row = p.items.slice(r * per, r * per + per)
          if (row.some((_, k) => r * per + k === activeIndex && isActive)) activeRow = rows.length
          const cardLines = 4
          for (let li = 0; li < cardLines; li++) {
            const segs: Seg[] = row.map((it, k) => {
              const sel = isActive && r * per + k === activeIndex
              const text = pad(` ${it.card?.[li] ?? ''}`, cw - 1) + ' '
              return { text, fg: sel ? t.selFg : li === 0 ? t.fg : t.dim, bg: sel ? t.selBg : undefined, bold: li === 0 }
            })
            const used = row.length * cw
            body([...segs, { text: ' '.repeat(Math.max(0, w - 2 - used)) }])
          }
          if ((r + 1) * per < p.items.length) body([{ text: ' '.repeat(w - 2) }])
        }
      } else {
        p.items.forEach((it, i) => {
          const sel = isActive && i === activeIndex
          if (sel) activeRow = rows.length
          const detail = it.detail ? `  ${it.detail}` : ''
          const label = trunc(it.label, Math.max(4, w - 4 - detail.length))
          body([{ text: pad(` ${label}${detail ? ' '.repeat(Math.max(1, w - 4 - label.length - detail.length)) + it.detail : ''}`, w - 2), fg: sel ? t.selFg : t.fg, bg: sel ? t.selBg : undefined }])
        })
      }
      rows.push([{ text: `${g.border ? '+' : '└'}${h.repeat(Math.max(0, w - 2))}${g.border ? '+' : '┘'}`, fg: border }])
      return { rows, activeRow }
    }
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]!
      const next = panels[i + 1]
      // recently viewed and quick actions side by side when there is room (as the web dashboard)
      if (next && inner >= 110 && ((p.id === 'recent' && next.id === 'actions') || (p.id === 'actions' && next.id === 'recent'))) {
        const left = Math.floor(inner * 0.62)
        const a = frame(p, left)
        const b = frame(next, inner - left)
        const n = Math.max(a.rows.length, b.rows.length)
        const blank = (w: number) => [{ text: ' '.repeat(w) }]
        const start = lines.length
        for (let r = 0; r < n; r++) lines.push([...(a.rows[r] ?? blank(left)), ...(b.rows[r] ?? blank(inner - left))])
        if (a.activeRow !== undefined) activeLine = start + a.activeRow
        if (b.activeRow !== undefined) activeLine = start + b.activeRow
        i++
        continue
      }
      const f = frame(p, inner)
      if (f.activeRow !== undefined) activeLine = lines.length + f.activeRow
      lines.push(...f.rows)
    }
    lines.push([{ text: ' Tab panels · arrows move · Enter opens · PgUp PgDn scroll · v panel order · F9 menu · : command line', fg: t.dim }])
    // keep the selection in view
    const view = height - 2
    if (activeLine < this.scroll) this.scroll = Math.max(0, activeLine - 1)
    if (activeLine >= this.scroll + view) this.scroll = activeLine - view + 2
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - view)))
    const shown = lines.slice(this.scroll, this.scroll + view)
    while (shown.length < view) shown.push([{ text: '' }])
    return (
      <box flexDirection="column" width={width} height={height} border borderColor={focused ? t.focusBorder : t.border} {...(g.border ? { customBorderChars: g.border } : {})} title={` ${brand} `}>
        {shown.map((segs, i) => {
          const used = segs.reduce((a, x) => a + x.text.length, 0)
          return (
            <text key={i}>
              {segs.map((x, k) => <span key={k} fg={x.fg ?? t.fg} bg={x.bg}>{x.bold ? <strong>{x.text}</strong> : x.text}</span>)}
              <span>{' '.repeat(Math.max(0, inner - used))}</span>
            </text>
          )
        })}
      </box>
    )
  }
}

/** Home view settings: the order of the panels (+/- or Shift+arrows move the selected one). */
class PanelOrderOverlay extends ChoiceOverlay<PanelId> {
  constructor(private s: AppStore, private orderList: PanelId[], private done: () => void) {
    super(s, 'Home panels: order', orderList.map((p) => ({ label: PANEL_TITLES[p], value: p })), () => undefined, '+/- move · Enter saves')
  }
  override onKey(key: Key): void {
    const move = (dir: number) => {
      const i = this.index
      const j = i + dir
      if (j < 0 || j >= this.orderList.length) return
      ;[this.orderList[i], this.orderList[j]] = [this.orderList[j]!, this.orderList[i]!]
      this.choices.splice(0, this.choices.length, ...this.orderList.map((p) => ({ label: PANEL_TITLES[p], value: p })))
      this.index = j
    }
    if (key.sequence === '+' || (key.shift && key.name === 'down')) return move(1)
    if (key.sequence === '-' || (key.shift && key.name === 'up')) return move(-1)
    if (key.name === 'return') {
      writeViewSettings('home', { ...readViewSettings('home'), panels: this.orderList })
      this.s.closeOverlay(this)
      this.done()
      return
    }
    super.onKey(key)
  }
}
