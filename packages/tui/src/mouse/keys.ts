/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The mouse is additive: where it can, a click does what a key does, through the same dispatch, so
 * keyboard and mouse never disagree. These helpers press keys for zone handlers.
 */

import type { Key } from '../keys'
import type { ZoneEvent, ZoneHandlers } from './registry'

export function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, sequence: '', ...extra }
}

/** Presses `name` n times through `press` (the store's handleKey, a screen's or a dialog's onKey). */
export function pressKeys(press: (k: Key) => unknown, name: string, n = 1): void {
  for (let i = 0; i < n; i++) press(key(name))
}

/** The arrow key a wheel notch stands for: up / down, and left / right when `sideways` (Shift+wheel). */
export function wheelKey(e: ZoneEvent, sideways = false): string | undefined {
  const d = e.direction
  if (d === 'up' || d === 'down') return d
  return sideways ? d : undefined
}

/** A wheel notch as arrow keys (3 lines); false when the direction does not apply (bubbles). */
export function wheelAsKeys(e: ZoneEvent, press: (k: Key) => unknown, sideways = false): boolean {
  const name = wheelKey(e, sideways)
  if (!name) return false
  pressKeys(press, name, e.lines)
  return true
}

/**
 * A row of a list in a dialog or pane: a click selects it, a double-click selects and activates it
 * (as Enter would), a right click selects it and bubbles (the pane opens its actions there).
 */
export function pickRow(select: () => void, activate?: () => void): ZoneHandlers {
  return {
    onClick: () => {
      select()
      return false
    },
    onRight: () => {
      select()
      return false
    },
    ...(activate ? { onDouble: () => { select(); activate() } } : {}),
  }
}
