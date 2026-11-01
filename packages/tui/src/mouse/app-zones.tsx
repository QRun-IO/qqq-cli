/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The application-wide zones: the Apps pane and the screen (a click focuses the pane, the wheel
 * scrolls it, a right click opens the actions), the F-key bar (a click presses the key) and the
 * footer's connection segment (a click opens the connection entries of the menu).
 */

import { useMemo, type ReactNode } from 'react'
import type { AppStore } from '../store'
import { MouseDispatcher } from './dispatch'
import { fkeyAt } from './hit'
import { key, wheelAsKeys } from './keys'
import { LOCK_LAYER } from './registry'
import { Zone } from './zone'

/** One dispatcher per App: the live layer follows the store's dialogs and lock screen. */
export function useMouseDispatcher(store: AppStore): MouseDispatcher {
  return useMemo(() => new MouseDispatcher({
    layer: () => (store.lock ? LOCK_LAYER : store.overlays.length),
    enabled: () => store.settings.mouse,
    after: () => {
      store.lastInput = Date.now()
      store.bump()
    },
    error: (e) => store.error(e),
    unhandled: () => {
      if (!store.lock) return false
      store.lock.onKey(key('mouse'))
      return true
    },
  }), [store])
}

/** The Apps pane or the screen: a click focuses it, the wheel scrolls it, a right click opens the actions. */
export function PaneZone(props: { store: AppStore; pane: 'sidebar' | 'content'; width: number; height: number; children: ReactNode }) {
  const { store, pane } = props
  const focus = () => {
    if (pane === 'content' || store.showSidebar) store.focus = pane
  }
  return (
    <Zone
      onClick={() => focus()}
      onWheel={(e) => {
        focus()
        return wheelAsKeys(e, (k) => store.handleKey(k))
      }}
      onRight={() => {
        focus()
        if (pane === 'content') void store.commands().run('actions')
      }}
    >
      <box flexDirection="column" overflow="hidden" width={props.width} height={props.height}>{props.children}</box>
    </Zone>
  )
}

/** The F-key bar: a click presses the key under the pointer (with a dialog open too, as the key would). */
export function FKeyZone(props: { store: AppStore; width: number; keys: number[]; children: ReactNode }) {
  return (
    <Zone global onClick={(e) => {
      const n = fkeyAt(e.x, props.width, props.keys)
      if (n !== undefined) props.store.handleKey(key(`f${n}`))
    }}>
      {props.children}
    </Zone>
  )
}

/** Opens the connection entries: the Servers menu when there is one, else the menu at its Connection section. */
export function openConnectionMenu(store: AppStore): void {
  const commands = store.commands() as { servers?: () => void }
  if (typeof commands.servers === 'function') return commands.servers()
  store.lastMenuSection = 3 // SECTIONS: Context, Go to, Work, Connection, …
  store.commands().menu()
}

/** The footer: a click on its connection segment (the first `segment` cells) opens the connection entries. */
export function StatusZone(props: { store: AppStore; segment: number; children: ReactNode }) {
  return (
    <Zone onClick={(e) => {
      if (e.x >= props.segment) return false
      openConnectionMenu(props.store)
    }}>
      {props.children}
    </Zone>
  )
}
