/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { Component, useEffect, useReducer, type ReactNode } from 'react'
import type { AppTreeNode } from './client'
import { presenceText, usePresence } from './presence'
import type { AppStore } from './store'
import { glyphs, theme } from './theme'
import { pad, trunc } from './util/text'

/** Catches a failing screen or overlay so it shows its error in place; the rest of the TUI keeps working. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string; width: number; label: string }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  override render() {
    if (this.state.error) {
      const t = theme()
      return (
        <box flexDirection="column" border borderColor={t.err} width={this.props.width} title={` ${this.props.label} error `}>
          <text fg={t.err}>{trunc(` ${this.state.error.message}`, this.props.width - 2)}</text>
          <text fg={t.dim}>{trunc(' Esc goes back · F5 retries · this is a bug in the screen; please report the steps', this.props.width - 2)}</text>
        </box>
      )
    }
    return this.props.children
  }
}

/** The apps above a table, process or app in the app tree (labels, outermost first). */
export function appPath(nodes: AppTreeNode[], name: string, type: string, path: string[] = []): string[] | undefined {
  for (const n of nodes) {
    if (n.name === name && n.type === type) return path
    if (n.children) {
      const found = appPath(n.children, name, type, [...path, n.label])
      if (found) return found
    }
  }
  return undefined
}

/** The title-bar path of the top screen: its apps, the table, then the record or form. */
export function breadcrumbs(store: AppStore): string[] {
  const top = store.screen as (import('./types').Screen & { tableName?: string; processName?: string; appName?: string }) | undefined
  if (!top) return []
  const tree = (store.meta?.appTree ?? []) as AppTreeNode[]
  const tableLabel = top.tableName ? store.meta?.tables?.[top.tableName]?.label ?? top.tableName : undefined
  if (top.kind === 'table') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), top.title()]
  if (top.kind === 'record') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), tableLabel!, top.title()]
  if (top.kind === 'form') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), top.title()]
  if (top.kind === 'process') return [...(appPath(tree, top.processName!, 'PROCESS') ?? []), top.title()]
  if (top.kind === 'app') return [...(appPath(tree, top.appName!, 'APP') ?? []), top.title()]
  return [top.title()]
}

function TitleBar({ store, width }: { store: AppStore; width: number }) {
  const t = theme()
  const presence = usePresence(store.screen?.presenceScope?.())
  const brand = (store.meta?.branding as { appName?: string } | undefined)?.appName ?? 'QQQ'
  const crumbs = breadcrumbs(store)
  const shown = crumbs.length > 5 ? ['…', ...crumbs.slice(-5)] : crumbs
  const ascii = glyphs().border !== undefined
  const left = ` ${brand} ${ascii ? '-' : '─'} ${shown.join(ascii ? ' > ' : ' › ')}`
  // collaboration presence slot: "N others viewing" (empty without the collaboration extension)
  const others = presenceText(presence)
  const right = [others, store.status.user, store.status.alerts ? `alerts ${store.status.alerts}` : '', store.status.jobs !== 'n/a' && store.status.jobs !== '0' ? `jobs ${store.status.jobs}` : ''].filter(Boolean).join('  ') + ' '
  const room = Math.max(0, width - right.length)
  return <text fg={t.titleFg} bg={t.titleBg}>{pad(trunc(left, room), room) + trunc(right, width - room)}</text>
}

function StatusLine({ store, width }: { store: AppStore; width: number }) {
  const t = theme()
  const s = store.status
  const presence = usePresence(store.screen?.presenceScope?.())
  if (store.flashText) {
    return <text fg={store.flashText.kind === 'error' ? t.err : t.acc2} bg={t.statusBg}>{pad(` ${store.flashText.text}`, width)}</text>
  }
  const ping = s.pingMs === null ? 'ping --' : `ping ${s.pingMs.toFixed(0)} ms`
  const streamColor = s.stream === 'connected' ? t.ok : s.stream === 'reconnecting' ? t.warn : t.statusFg
  const left = ` ${s.server.replace(/^https?:\/\//, '')} · ${s.profile}${s.auth ? ` · ${s.auth}` : ''} · UI API ${s.apiVersion} · ${ping} · `
  const stream = `stream ${s.stream}`
  const right = ` · jobs ${s.jobs}${presence.count ? ` · ${presence.count} viewing` : ''} · ${s.lastEvent} · ${s.build} · ${s.clock} `
  if (left.length + stream.length + right.length > width) {
    const short = ` ${s.profile} · ${ping} · ${stream} · jobs ${s.jobs} · ${s.clock} `
    return <text fg={t.statusFg} bg={t.statusBg}>{pad(short, width)}</text>
  }
  return (
    <text bg={t.statusBg}>
      <span fg={t.statusFg} bg={t.statusBg}>{left}</span>
      <span fg={streamColor} bg={t.statusBg}>{stream}</span>
      <span fg={t.statusFg} bg={t.statusBg}>{pad(right, width - left.length - stream.length)}</span>
    </text>
  )
}

/** Short labels for narrow terminals (below ~100 columns), so nothing clips at 80. */
const SHORT: Record<string, string> = { Help: 'Help', 'Go to': 'Go', View: 'View', Edit: 'Edit', Refresh: 'Refr', Filter: 'Filt', New: 'New', Delete: 'Del', Menu: 'Menu', Quit: 'Quit', NewChild: 'Child', 'Re-run': 'Again', Open: 'Open' }

function FKeyBar({ store, width }: { store: AppStore; width: number }) {
  const t = theme()
  const keys = store.fkeys()
  const cell = Math.max(7, Math.floor(width / keys.length))
  const narrow = width < 100
  let used = 0
  return (
    <text>
      {keys.map((k) => {
        const w = k.n === 10 ? Math.max(0, width - used) : cell
        used += w
        const num = String(k.n).padStart(2)
        // a key that does nothing here still shows its global label, dimmed, so the bar teaches the keymap
        const active = k.label !== null
        const base = active ? k.label! : k.global
        const label = narrow || base.length > w - 2 ? SHORT[base] ?? base : base
        return (
          <span key={k.n}>
            <span fg={t.keyNum}>{num}</span>
            <span fg={active ? t.keyLabelFg : t.dim} bg={active ? t.keyLabelBg : undefined}>{pad(label, Math.max(0, w - 2))}</span>
          </span>
        )
      })}
    </text>
  )
}

export function App({ store }: { store: AppStore }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  const { width, height } = useTerminalDimensions()
  useEffect(() => store.subscribe(force), [store])
  useEffect(() => {
    if (width !== store.width || height !== store.height) store.resize(width, height)
  }, [width, height, store])
  useKeyboard((key) => store.handleKey(key))
  const t = theme()
  const w = Math.max(20, width)
  const h = Math.max(8, height)
  const bodyHeight = h - 3
  const sidebarWidth = store.showSidebar ? (w >= 160 ? 32 : 28) : 0
  const contentWidth = w - sidebarWidth
  const screen = store.screen
  const top = store.overlays[store.overlays.length - 1]
  return (
    <box flexDirection="column" width={w} height={h}>
      <TitleBar store={store} width={w} />
      <box flexDirection="row" width={w} height={bodyHeight}>
        {sidebarWidth > 0 && store.sidebar && (
          <ErrorBoundary resetKey="sidebar" width={sidebarWidth} label="Apps">{store.sidebar.render(sidebarWidth, bodyHeight, store.focus === 'sidebar' && !top)}</ErrorBoundary>
        )}
        {screen
          ? <ErrorBoundary key={screen.id} resetKey={screen.id} width={contentWidth} label="Screen">{screen.render(contentWidth, bodyHeight, store.focus === 'content' && !top)}</ErrorBoundary>
          : <box width={contentWidth} height={bodyHeight}><text fg={t.dim}>{' starting…'}</text></box>}
      </box>
      <StatusLine store={store} width={w} />
      <FKeyBar store={store} width={w} />
      {store.overlays.map((o) => <ErrorBoundary key={o.id} resetKey={o.id} width={Math.min(60, w)} label="Dialog">{o.render(w, h)}</ErrorBoundary>)}
      {store.lock && <ErrorBoundary key="lock" resetKey="lock" width={w} label="Lock">{store.lock.render(w, h)}</ErrorBoundary>}
    </box>
  )
}
