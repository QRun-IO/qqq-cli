/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readRecents } from '@qrun-io/qqq-core'
import type { AppTreeNode } from '../client'
import type { Key } from '../keys'
import { openApp, openRecord, openTable, openProcess } from '../nav'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { pad } from '../util/text'
import { ListModel, Panel, type Row } from './list'

/** Counts the tables and processes under an app node, recursively. */
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

/** The landing screen: apps with counts, the server's totals, and recently viewed records. */
export class HomeScreen implements Screen {
  readonly kind = 'home'
  readonly id = 'home'
  readonly list = new ListModel()

  constructor(private store: AppStore) {
    this.build()
  }

  title(): string {
    return 'Home'
  }

  fkeys(): FKeyLabels {
    return { 3: 'Open', 4: null, 6: null, 7: null, 8: null }
  }

  build(): void {
    const t = theme()
    const g = glyphs()
    const meta = this.store.meta
    const rows: Row[] = []
    const tables = Object.values(meta?.tables ?? {}).filter((x) => !x.isHidden).length
    const processes = Object.values(meta?.processes ?? {}).filter((x) => !x.isHidden).length
    const apps = (meta?.appTree ?? []) as AppTreeNode[]
    rows.push({ text: `${apps.length} apps · ${tables} tables · ${processes} processes · ${Object.keys(meta?.widgets ?? {}).length} widgets · UI API ${this.store.status.apiVersion}`, fg: t.dim })
    rows.push({ text: '' })
    rows.push({ text: 'Apps', fg: t.acc, bold: true })
    for (const app of apps) {
      const c = countUnder(app)
      const parts = [c.tables && `${c.tables} tables`, c.processes && `${c.processes} processes`, c.reports && `${c.reports} reports`, c.apps && `${c.apps} apps`].filter(Boolean).join(' · ')
      if (app.type === 'APP') rows.push({ text: `  ${g.app} ${pad(app.label, 30)} ${parts}`, key: `app:${app.name}`, action: () => openApp(this.store, app.name) })
      else if (app.type === 'TABLE') rows.push({ text: `    ${pad(app.label, 30)} table`, key: `t:${app.name}`, action: () => openTable(this.store, app.name) })
      else if (app.type === 'PROCESS') rows.push({ text: `  ${g.process} ${pad(app.label, 30)} process`, key: `p:${app.name}`, action: () => openProcess(this.store, app.name) })
    }
    let recents: ReturnType<typeof readRecents> = []
    try {
      recents = this.store.client ? readRecents(this.store.client.server).slice(0, 8) : []
    } catch {
      recents = []
    }
    if (recents.length) {
      rows.push({ text: '' })
      rows.push({ text: 'Recently viewed', fg: t.acc, bold: true })
      for (const r of recents) {
        const label = r.kind === 'record' ? `${meta?.tables?.[r.table ?? '']?.label ?? r.table} › ${r.label}` : r.label
        rows.push({ text: `    ${pad(label, 50)} ${r.kind}`, key: `r:${r.kind}:${r.table}:${r.key}:${r.name}`, action: () => {
          if (r.kind === 'record' && r.table) openRecord(this.store, r.table, r.key)
          else if (r.kind === 'table' && r.table) openTable(this.store, r.table)
          else if (r.kind === 'process' && r.name) openProcess(this.store, r.name)
        } })
      }
    }
    rows.push({ text: '' })
    rows.push({ text: 'Enter opens · F2 or / goes anywhere by name · F9 menu · : command line (try  :table query person -w "lastName STARTS_WITH S")', fg: t.dim })
    this.list.setRows(rows)
  }

  onKey(key: Key): boolean {
    if (key.name === 'f3') {
      this.list.current?.action?.()
      return true
    }
    return this.list.onKey(key)
  }

  resume(): void {
    this.build()
  }

  refresh(): void {
    this.store.run(this.store.client!.metaData(true).then((m) => {
      this.store.meta = m
      this.build()
    }))
  }

  menu(): MenuEntry[] {
    return ((this.store.meta?.appTree ?? []) as AppTreeNode[]).filter((a) => a.type === 'APP').map((a) => ({ section: 'Context' as const, label: `Open app ${a.label}`, run: () => openApp(this.store, a.name) }))
  }

  render(width: number, height: number, focused: boolean) {
    const brand = (this.store.meta?.branding as { appName?: string } | undefined)?.appName ?? 'QQQ'
    return <Panel title={brand} width={width} height={height} focused={focused}>{this.list.view(width - 2, height - 2, focused)}</Panel>
  }
}
