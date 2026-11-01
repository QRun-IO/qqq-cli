/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Collaboration presence: "N others viewing" for a screen scope (`table:person`, `record:person:3`).
 * The interface the TUI draws from; the collaboration extension's kernel hook (presence over the
 * realtime stream, being built on another branch) plugs in through `setPresenceSource`. Without
 * the extension the source is a no-op and the title bar slot and footer segment stay empty.
 */

import { useSyncExternalStore } from 'react'
import { Collaboration, type ExtensionRegistry, type PresenceHandle } from '@qrun-io/qqq-core'
import type { TuiClient } from './client'

export interface PresencePerson {
  name: string
  since?: string
}

export interface Presence {
  /** Others on the scope (this user not counted). */
  count: number
  people: PresencePerson[]
  /** Everyone on the scope as the server reports it, this user included (the record header lists them). */
  everyone?: Array<PresencePerson & { self?: boolean }>
}

export interface PresenceSource {
  /** Current presence of a scope. */
  get(scope: string): Presence
  /** Subscribes to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Announces that this client views a scope (and stops for the previous one). */
  enter?(scope: string | undefined): void
}

const NONE: Presence = { count: 0, people: [] }

const noop: PresenceSource = {
  get: () => NONE,
  subscribe: () => () => undefined,
}

let source: PresenceSource = noop

export function setPresenceSource(next: PresenceSource | undefined): void {
  source = next ?? noop
}

export function presenceSource(): PresenceSource {
  return source
}

/** React hook: presence of a scope, updated live (empty without the collaboration extension). */
export function usePresence(scope: string | undefined): Presence {
  return useSyncExternalStore(source.subscribe, () => (scope ? source.get(scope) : NONE), () => NONE)
}

/** Title-bar text for presence, empty when nobody else is there. */
export function presenceText(p: Presence): string {
  if (!p.count) return ''
  const names = p.people.slice(0, 3).map((x) => x.name).join(', ')
  return `${p.count} other${p.count === 1 ? '' : 's'} viewing${names ? `: ${names}${p.count > 3 ? ', …' : ''}` : ''}`
}

/**
 * Presence from the kernel's collaboration module: joins the scope of the screen on top (a lease
 * renewed by the kernel), leaves the previous one. Others only: this client is not counted.
 */
export function collaborationPresence(registry: ExtensionRegistry, client: TuiClient, selfName?: string): PresenceSource | undefined {
  const collab = new Collaboration(registry, { call: (id, input) => client.call(id, input) })
  if (!collab.available) return undefined
  const listeners = new Set<() => void>()
  let current: { scope: string; handle?: PresenceHandle; value: Presence } | undefined
  const notify = () => { for (const l of listeners) l() }
  return {
    get: (scope) => (current?.scope === scope ? current.value : NONE),
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    enter: (scope) => {
      if (current?.scope === scope) return
      void current?.handle?.stop()
      current = undefined
      if (!scope) return notify()
      const [kind, table, ...pk] = scope.split(':')
      if (!table || (kind !== 'table' && kind !== 'record')) return
      const entry: { scope: string; handle?: PresenceHandle; value: Presence } = { scope, value: NONE }
      current = entry
      collab.joinPresence(kind === 'record' ? { table, pk: pk.join(':') } : { table }, {
        onChange: (state) => {
          const everyone = state.people.map((p) => ({ name: p.name, since: p.since.toISOString(), self: p.name === selfName }))
          const people = everyone.filter((p) => !p.self).map(({ name, since }) => ({ name, since }))
          entry.value = { count: people.length, people, everyone }
          notify()
        },
      }).then((h) => { entry.handle = h }).catch(() => undefined)
    },
  }
}
