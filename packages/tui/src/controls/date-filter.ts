/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The date control in the filter dialog's value cell: Enter opens the calendar (from, then to,
 * for between), `p` on the calendar opens the expression presets, and a digit typed on it goes to
 * typed entry in the cell. The row model is untouched: the result is the cell's values.
 */

import { parseCanonical, type FilterValue } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { DatePickerOverlay } from './date-picker'
import { dateSettingsFor, serverZoneOf } from './date-settings'

export interface FilterDatesOptions {
  /** The title: field label and comparison (`Birth Date between`). */
  label: string
  type: string
  between: boolean
  values: FilterValue[]
  onValues: (values: FilterValue[]) => void
  /** A character typed on the calendar: typed entry in the cell, starting with it. */
  onType: (seed: string) => void
  onPresets?: () => void
}

/** Opens the calendar for a date value cell (one, or from and to). */
export function pickFilterDates(store: AppStore, options: FilterDatesOptions): void {
  const kind = String(options.type).toUpperCase() === 'DATE_TIME' ? 'DATE_TIME' : 'DATE'
  const settings = dateSettingsFor(store)
  const serverZone = serverZoneOf(store)
  const start = (v: FilterValue | undefined) => {
    const w = typeof v === 'string' ? parseCanonical(v) : undefined
    return w ? { initial: w } : {}
  }
  const open = (title: string, initial: FilterValue | undefined, then: (value: string) => void, extra: { onPresets?: () => void } = {}) =>
    store.open(new DatePickerOverlay(store, { title, kind, settings, ...(serverZone ? { serverZone } : {}), ...start(initial), onAccept: then, onType: options.onType, ...extra }))
  if (!options.between) {
    open(options.label, options.values[0], (v) => options.onValues([v]), options.onPresets ? { onPresets: options.onPresets } : {})
    return
  }
  open(`${options.label}: from`, options.values[0], (from) => {
    open(`${options.label}: to`, options.values[1] ?? from, (to) => options.onValues([from, to]))
  })
}
