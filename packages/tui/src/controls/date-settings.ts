/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The date settings in effect for the TUI (the profile's `ui.dates` over the global one, then the
 * locale, then ISO / 24-hour / Monday) and the `:dates` command that changes them.
 */

import { localeFromEnv, readDateSettings, resolveDateSettings, writeDateSettings, type DateSettings, type ResolvedDateSettings } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'

/** The resolved settings for the store's profile. */
export function dateSettingsFor(store: Pick<AppStore, 'target'>): ResolvedDateSettings {
  let saved: DateSettings = {}
  try {
    saved = readDateSettings(store.target?.name)
  } catch {
    saved = {}
  }
  return resolveDateSettings(saved, localeFromEnv())
}

/** The zone the server declares for date-time functions (instance ui settings), when it declares one. */
export function serverZoneOf(store: Pick<AppStore, 'meta'>): string | undefined {
  const sup = (store.meta as { supplementalInstanceMetaData?: { uiSettings?: Record<string, unknown> } } | undefined)?.supplementalInstanceMetaData
  const args = (sup?.uiSettings?.weekdayCriteriaSettings as { dateTimeFieldFunctionArguments?: { timeZoneId?: unknown } } | undefined)?.dateTimeFieldFunctionArguments
  return typeof args?.timeZoneId === 'string' ? args.timeZoneId : undefined
}

export const DATES_USAGE = 'dates [order ymd|mdy|dmy] [clock 24h|12h] [week monday|sunday] [weeknumbers on|off] [enter picker|next]'

/** Describes the settings in one line. */
export function describeDateSettings(s: ResolvedDateSettings): string {
  return `dates: order ${s.order.toLowerCase()} · clock ${s.clock} · week starts ${s.weekStart} · week numbers ${s.weekNumbers ? 'on' : 'off'} · Enter on an empty date ${s.pickerOnEnter ? 'opens the picker' : 'moves on'}`
}

/**
 * `:dates key value …` saves settings for the current profile (`:dates` alone shows them).
 * Returns the message to flash, or throws with the usage.
 */
export function datesCommand(store: Pick<AppStore, 'target'>, args: string[]): string {
  if (!args.length) return describeDateSettings(dateSettingsFor(store))
  const patch: DateSettings = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!.toLowerCase()
    const value = (args[i + 1] ?? '').toLowerCase()
    if (key === 'order' && ['ymd', 'mdy', 'dmy'].includes(value)) patch.order = value.toUpperCase() as DateSettings['order']
    else if (key === 'clock' && (value === '24h' || value === '12h')) patch.clock = value
    else if ((key === 'week' || key === 'weekstart') && (value === 'monday' || value === 'sunday')) patch.weekStart = value
    else if ((key === 'weeknumbers' || key === 'weeks') && (value === 'on' || value === 'off')) patch.weekNumbers = value === 'on'
    else if (key === 'enter' && (value === 'picker' || value === 'next')) patch.pickerOnEnter = value === 'picker'
    else throw new Error(`usage: :${DATES_USAGE}`)
  }
  writeDateSettings(patch, { profile: store.target?.name })
  return `${describeDateSettings(dateSettingsFor(store))} (saved${store.target?.name ? ` for ${store.target.name}` : ''})`
}
