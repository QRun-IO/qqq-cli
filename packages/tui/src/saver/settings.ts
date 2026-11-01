/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Screen saver settings in ~/.config/qqq/config.json (a `saver` section; the kernel keeps sections
 * it does not know): the style, the refresh interval, the burn-in guard (everything drifts) and the
 * dim-after minutes, and per profile the favourite tables whose
 * record counts get a tile (`profiles.<name>.saver.tables`).
 */

import { readConfig, writeConfig } from '@qrun-io/qqq-core'

export const SAVER_STYLES = ['bounce', 'starfield', 'flip', 'big'] as const
export type SaverStyle = (typeof SAVER_STYLES)[number]
export type SaverStyleSetting = SaverStyle | 'auto'

export const STYLE_LABELS: Record<SaverStyleSetting, string> = {
  auto: 'Auto: cycle every 3 minutes',
  bounce: 'Bounce: Query and the qqq logo drift, tiles in a corner',
  starfield: 'Starfield: stars fly past, Query drifts through',
  flip: 'Flip clock: big clock and date, tiles beneath',
  big: 'Big numbers: the most interesting metric, large',
}

export const REFRESH_CHOICES = [10, 15, 20, 30] as const
export const DEFAULT_REFRESH_SECONDS = 15
/** The favourite tables that get a count tile: "a couple". */
export const MAX_TABLES = 3

/** Minutes of saver before everything dims a little (0: never). */
export const DEFAULT_DIM_MINUTES = 10
export const DIM_CHOICES = [0, 5, 10, 20, 30] as const

export interface SaverSettings {
  style: SaverStyleSetting
  refreshSeconds: number
  tables: string[]
  /** Burn-in guard: every element drifts (default on); off keeps the fixed layout. */
  burnin: boolean
  /** Dim the saver after this many minutes (0: never). */
  dimMinutes: number
}

interface SaverSection {
  style?: string
  refreshSeconds?: number
  tables?: string[]
  burnin?: boolean
  dimMinutes?: number
}

/** Clamps the dim delay to whole minutes, 1 to 600; 0 (or anything not a number) is off. */
export function clampDim(minutes: number): number {
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(600, Math.round(minutes)) : 0
}

export function isStyle(value: string | undefined): value is SaverStyleSetting {
  return value === 'auto' || (SAVER_STYLES as readonly string[]).includes(value ?? '')
}

/** Clamps a refresh interval to 10–30 s. */
export function clampRefresh(seconds: number): number {
  return Number.isFinite(seconds) ? Math.min(30, Math.max(10, Math.round(seconds))) : DEFAULT_REFRESH_SECONDS
}

export function readSaverSettings(profile?: string): SaverSettings {
  let config: ReturnType<typeof readConfig>
  try {
    config = readConfig()
  } catch {
    return { style: 'auto', refreshSeconds: DEFAULT_REFRESH_SECONDS, tables: [], burnin: true, dimMinutes: DEFAULT_DIM_MINUTES }
  }
  const global = (config.saver ?? {}) as SaverSection
  const own = (profile ? (config.profiles[profile] as { saver?: SaverSection } | undefined)?.saver : undefined) ?? {}
  const tables = (own.tables ?? global.tables ?? []).filter((t) => typeof t === 'string' && t).slice(0, MAX_TABLES)
  return {
    style: isStyle(global.style) ? global.style : 'auto',
    refreshSeconds: clampRefresh(Number(global.refreshSeconds ?? DEFAULT_REFRESH_SECONDS)),
    tables,
    burnin: global.burnin !== false,
    dimMinutes: global.dimMinutes === undefined ? DEFAULT_DIM_MINUTES : clampDim(Number(global.dimMinutes)),
  }
}

/** Saves the style and interval globally; tables for the profile (globally without one). */
export function writeSaverSettings(change: Partial<SaverSettings>, profile?: string): void {
  const config = readConfig()
  const global = { ...((config.saver ?? {}) as SaverSection) }
  if (change.style !== undefined) global.style = change.style
  if (change.refreshSeconds !== undefined) global.refreshSeconds = clampRefresh(change.refreshSeconds)
  if (change.burnin !== undefined) global.burnin = change.burnin
  if (change.dimMinutes !== undefined) global.dimMinutes = clampDim(change.dimMinutes)
  if (change.tables !== undefined) {
    const tables = change.tables.slice(0, MAX_TABLES)
    if (profile && config.profiles[profile]) {
      const p = config.profiles[profile] as { saver?: SaverSection }
      p.saver = { ...p.saver, tables }
    } else {
      global.tables = tables
    }
  }
  config.saver = global
  writeConfig(config)
}
