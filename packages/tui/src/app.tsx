/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react'
import { Component, useEffect, useReducer, type ReactNode } from 'react'
import { FKeyZone, PaneZone, StatusZone, useMouseDispatcher } from './mouse/app-zones'
import { MouseCapture, MouseLayer, MouseRoot } from './mouse/zone'
import { presenceText, usePresence } from './presence'
import { ShiftRow, barRows } from './keys/shift-row'
import type { AppStore } from './store'
import { breadcrumbs } from './breadcrumbs'

export { appPath, breadcrumbs } from './breadcrumbs'
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
          <text flexShrink={0} wrapMode="none" fg={t.err}>{trunc(` ${this.state.error.message}`, this.props.width - 2)}</text>
          <text flexShrink={0} wrapMode="none" fg={t.dim}>{trunc(' Esc goes back · F5 retries · this is a bug in the screen; please report the steps', this.props.width - 2)}</text>
        </box>
      )
    }
    return this.props.children
  }
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
  const right = [others, store.status.user, store.status.alerts ? `alerts ${store.status.alerts}` : '', store.status.jobs !== 'n/a' && store.status.jobs !== '0' ? `jobs ${store.status.jobs}` : '', store.status.print ?? ''].filter(Boolean).join('  ') + ' '
  const room = Math.max(0, width - right.length)
  return <text flexShrink={0} wrapMode="none" fg={t.titleFg} bg={t.titleBg}>{pad(trunc(left, room), room) + trunc(right, width - room)}</text>
}

function StatusLine({ store, width }: { store: AppStore; width: number }) {
  const t = theme()
  const s = store.status
  const presence = usePresence(store.screen?.presenceScope?.())
  if (store.flashText) {
    return <text flexShrink={0} wrapMode="none" fg={store.flashText.kind === 'error' ? t.err : t.acc2} bg={t.statusBg}>{pad(` ${store.flashText.text}`, width)}</text>
  }
  const ping = s.pingMs === null ? 'ping --' : `ping ${s.pingMs.toFixed(0)} ms`
  const streamColor = s.stream === 'connected' ? t.ok : s.stream === 'reconnecting' ? t.warn : t.statusFg
  // the connection segment: server · profile short name · sign-in (Ctrl+O switches)
  const profile = s.short || s.profile
  const left = ` ${s.server.replace(/^https?:\/\//, '')} · ${profile}${s.auth ? ` · ${s.auth}` : ''} · UI API ${s.apiVersion} · ${ping} · `
  const stream = `stream ${s.stream}`
  const right = ` · jobs ${s.jobs}${s.print ? ` · ${s.print}` : ''}${presence.count ? ` · ${presence.count} viewing` : ''} · ${s.lastEvent} · ${s.build} · ${s.clock} `
  // the connection segment (server, profile, sign-in): a click opens the connection entries
  const connection = ` ${s.server.replace(/^https?:\/\//, '')} · ${profile}${s.auth ? ` · ${s.auth}` : ''}`.length
  if (left.length + stream.length + right.length > width) {
    const short = ` ${profile} · ${ping} · ${stream} · jobs ${s.jobs}${s.print ? ` · ${s.print}` : ''} · ${s.clock} `
    return <StatusZone store={store} segment={profile.length + 1}><text flexShrink={0} wrapMode="none" fg={t.statusFg} bg={t.statusBg}>{pad(short, width)}</text></StatusZone>
  }
  return (
    <StatusZone store={store} segment={connection}>
      <text flexShrink={0} wrapMode="none" bg={t.statusBg}>
        <span fg={t.statusFg} bg={t.statusBg}>{left}</span>
        <span fg={streamColor} bg={t.statusBg}>{stream}</span>
        <span fg={t.statusFg} bg={t.statusBg}>{pad(right, width - left.length - stream.length)}</span>
      </text>
    </StatusZone>
  )
}

/** Short labels for narrow terminals (below ~100 columns), so nothing clips at 80. */
const SHORT: Record<string, string> = { Help: 'Help', Search: 'Search', 'Go to': 'Go', View: 'View', Edit: 'Edit', Refresh: 'Refr', Filter: 'Filt', New: 'New', Delete: 'Del', Menu: 'Menu', Quit: 'Quit', NewChild: 'Child', 'Re-run': 'Again', Open: 'Open', Ask: 'Ask' }

function FKeyBar({ store, width }: { store: AppStore; width: number }) {
  const t = theme()
  const keys = store.fkeys()
  const cell = Math.max(7, Math.floor(width / keys.length))
  const narrow = width < 100
  let used = 0
  return (
    <FKeyZone store={store} width={width} keys={keys.map((k) => k.n)}>
    <text flexShrink={0} wrapMode="none">
      {keys.map((k) => {
        const w = k === keys[keys.length - 1] ? Math.max(0, width - used) : cell
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
    </FKeyZone>
  )
}

export function App({ store }: { store: AppStore }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  const { width, height } = useTerminalDimensions()
  useEffect(() => store.subscribe(force), [store])
  useEffect(() => {
    if (width !== store.width || height !== store.height) store.resize(width, height)
  }, [width, height, store])
  const mouse = useMouseDispatcher(store)
  useKeyboard((key) => store.handleKey(key))
  usePaste((event) => store.handlePaste(new TextDecoder().decode(event.bytes)))
  const t = theme()
  const w = Math.max(20, width)
  const h = Math.max(8, height)
  // the F-key bar: the primary row, and the Shift row under it with two rows (keys/shift-row.tsx)
  const rows = barRows(store, h)
  const bodyHeight = h - 2 - rows
  const assistant = store.assistantLayout()
  const full = assistant?.mode === 'full'
  const sidebarWidth = store.showSidebar && !full ? (w >= 160 ? 32 : 28) : 0
  const assistantWidth = assistant?.mode === 'side' ? assistant.width : 0
  const contentWidth = w - sidebarWidth - assistantWidth
  const screen = store.screen
  const top = store.overlays[store.overlays.length - 1]
  const overlays = store.overlays.map((o, i) => <MouseLayer key={o.id} layer={i + 1}><ErrorBoundary resetKey={o.id} width={Math.min(60, w)} label="Dialog">{o.render(w, h)}</ErrorBoundary></MouseLayer>)
  if (screen?.kind === 'splash') {
    // the start-up splash has the whole terminal: no title bar, status line or key bar yet
    return (
      <MouseRoot dispatcher={mouse} press={store.pressKey}>
      <box flexDirection="column" overflow="hidden" width={w} height={h}>
        <ErrorBoundary resetKey={screen.id} width={w} label="Splash">{screen.render(w, h, !top)}</ErrorBoundary>
        {overlays}
        <MouseCapture width={w} height={h} />
      </box>
      </MouseRoot>
    )
  }
  return (
    <MouseRoot dispatcher={mouse} press={store.pressKey}>
    <box flexDirection="column" overflow="hidden" width={w} height={h}>
      <TitleBar store={store} width={w} />
      <box flexDirection="row" overflow="hidden" width={w} height={bodyHeight}>
        {sidebarWidth > 0 && store.sidebar && (
          <PaneZone store={store} pane="sidebar" width={sidebarWidth} height={bodyHeight}><ErrorBoundary resetKey="sidebar" width={sidebarWidth} label="Apps">{store.sidebar.render(sidebarWidth, bodyHeight, store.focus === 'sidebar' && !top)}</ErrorBoundary></PaneZone>
        )}
        {full && store.assistant
          ? <ErrorBoundary resetKey={store.assistant.id} width={w} label="Assistant">{store.assistant.render(w, bodyHeight, store.focus === 'assistant' && !top)}</ErrorBoundary>
          : screen
            ? <PaneZone key={screen.id} store={store} pane="content" width={contentWidth} height={bodyHeight}><ErrorBoundary resetKey={screen.id} width={contentWidth} label="Screen">{screen.render(contentWidth, bodyHeight, store.focus === 'content' && !top)}</ErrorBoundary></PaneZone>
            : <box width={contentWidth} height={bodyHeight}><text flexShrink={0} wrapMode="none" fg={t.dim}>{' starting…'}</text></box>}
        {assistantWidth > 0 && store.assistant && <ErrorBoundary resetKey={store.assistant.id} width={assistantWidth} label="Assistant">{store.assistant.render(assistantWidth, bodyHeight, store.focus === 'assistant' && !top)}</ErrorBoundary>}
      </box>
      <StatusLine store={store} width={w} />
      {rows === 1 && store.shiftRowShown() ? <ShiftRow store={store} width={w} slots={store.fkeys().length} /> : <FKeyBar store={store} width={w} />}
      {rows === 2 && <ShiftRow store={store} width={w} slots={store.fkeys().length} />}
      {overlays}
      {store.lock && <ErrorBoundary key="lock" resetKey="lock" width={w} label="Lock">{store.lock.render(w, h)}</ErrorBoundary>}
      <MouseCapture width={w} height={h} />
    </box>
    </MouseRoot>
  )
}
