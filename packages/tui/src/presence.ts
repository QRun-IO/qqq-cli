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

export interface PresencePerson {
  name: string
  since?: string
}

export interface Presence {
  count: number
  people: PresencePerson[]
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
