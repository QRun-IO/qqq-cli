/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Shift bank: Shift+F1…F10, a second row of ten function keys (like Norton Commander's Shift
 * bar). The assignments are this one table; each key names an action (actions.ts), so changing a key
 * is changing a row here. Like the primary bar, a key that does not apply on the screen is dimmed
 * and pressing it says why.
 */

import { readConfig, writeConfig } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { ACTIONS, runAction, type ActionName, type NamedAction } from './actions'

export interface ShiftKey {
  n: number
  /** The bar label (and the help's). */
  label: string
  /** At most 5 characters, for narrow terminals. */
  short: string
  action: ActionName
  /** What it does, for the `?` help. */
  help: string
}

export const SHIFT_BANK: ShiftKey[] = [
  { n: 1, label: 'Keys', short: 'Keys', action: 'help.keys', help: 'Keys: this reference (as ?)' },
  { n: 2, label: 'Servers', short: 'Servr', action: 'servers', help: 'Servers dialog (as Ctrl+O)' },
  { n: 3, label: 'SQL', short: 'SQL', action: 'sql.open', help: 'SQL Runner' },
  { n: 4, label: 'Bulk', short: 'Bulk', action: 'grid.bulk', help: 'Bulk actions on the grid (as b)' },
  { n: 5, label: 'Metadata', short: 'Meta', action: 'meta.refresh', help: 'Refresh the metadata' },
  { n: 6, label: 'Views', short: 'Views', action: 'grid.views', help: 'Saved views of the grid' },
  { n: 7, label: 'Copy', short: 'Copy', action: 'record.copy', help: 'Copy into a new record (as c)' },
  { n: 8, label: 'Export', short: 'Exprt', action: 'export', help: 'Export the grid (as x)' },
  { n: 9, label: 'History', short: 'Hist', action: 'history', help: 'History screen' },
  { n: 10, label: 'Assistant', short: 'Asst', action: 'assistant.toggle', help: 'Assistant panel (as F12, Ctrl+G)' },
]

/** The bank key for a number, if bound. */
export function shiftKey(n: number): ShiftKey | undefined {
  return SHIFT_BANK.find((k) => k.n === n)
}

/** One slot of the Shift row as drawn: a label, or null where the key does nothing here (dimmed). */
export interface ShiftSlot {
  n: number
  label: string | null
  global: string
  short: string
  why?: string
}

/**
 * The Shift row for the current screen, `slots` keys wide (the primary row's count, so both rows line
 * up; unbound keys are blank).
 */
export function shiftSlots(store: AppStore, slots = 10): ShiftSlot[] {
  const out: ShiftSlot[] = []
  for (let n = 1; n <= Math.max(10, slots); n++) {
    const k = shiftKey(n)
    if (!k) {
      out.push({ n, label: null, global: '', short: '' })
      continue
    }
    const action: NamedAction = ACTIONS[k.action]
    let why: string | undefined
    try {
      why = action.unavailable(store)
    } catch {
      why = 'not available'
    }
    out.push({ n, label: why ? null : k.label, global: k.label, short: k.short, why })
  }
  return out
}

/** Shift+Fn pressed: runs its action (or says why not) and, in one-row mode, shows the Shift row for a moment. */
export function runShiftKey(store: AppStore, n: number): void {
  store.showShiftRow(SHIFT_ROW_MS)
  const k = shiftKey(n)
  if (!k) return store.flash(`Shift+F${n} does nothing`)
  runAction(store, k.action, `Shift+F${n} ${k.label}`)
}

/** The keys for the `?` help's Shift bank group. */
export function shiftBankHelp(store: AppStore): Array<[string, string]> {
  return shiftSlots(store).filter((s) => shiftKey(s.n)).map((s) => {
    const k = shiftKey(s.n)!
    return [`Shift+F${s.n}`, `${k.help}${s.why ? ' · not here' : ''}`]
  })
}

// ---- the F-key bar setting ----

export type FKeyBarMode = 'one' | 'two' | 'auto'
export const FKEY_BAR_MODES: FKeyBarMode[] = ['auto', 'one', 'two']
/** From this height `auto` draws both rows. */
export const TWO_ROW_MIN_HEIGHT = 30
/** How long one-row mode shows the Shift row after a Shift+F press. */
export const SHIFT_ROW_MS = 2000

export function readFKeyBar(env: NodeJS.ProcessEnv = process.env): FKeyBarMode {
  try {
    const v = readConfig(env).ui?.fkeyBar
    return v === 'one' || v === 'two' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export function writeFKeyBar(mode: FKeyBarMode, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  config.ui = { ...config.ui, fkeyBar: mode }
  writeConfig(config, env)
}

/** Settings › F-key bar and `:fkeys one|two|auto`: applies now and saves it. */
export function setFKeyBar(store: AppStore, mode: FKeyBarMode): void {
  store.settings.fkeyBar = mode
  store.bump()
  try {
    writeFKeyBar(mode)
  } catch (e) {
    return store.error(e)
  }
  store.flash(`F-key bar: ${describeFKeyBar(mode)} (saved)`)
}

export function describeFKeyBar(mode: FKeyBarMode): string {
  return mode === 'one' ? 'one row (Shift row for 2 s after Shift+F)' : mode === 'two' ? 'two rows' : `auto (two rows from ${TWO_ROW_MIN_HEIGHT} lines)`
}

/** How many rows the bar takes at this terminal height. */
export function fkeyBarRows(mode: FKeyBarMode | undefined, height: number): 1 | 2 {
  if (mode === 'two') return 2
  if (mode === 'one') return 1
  return height >= TWO_ROW_MIN_HEIGHT ? 2 : 1
}
