/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { AppStore } from '../store'
import type { MenuEntry, Screen } from '../types'
import { ChoiceOverlay } from './basic'
import { printScreen } from '../printing'

/** `a`: the screen's actions (the same entries as the F9 Context section) in a list. */
export function actionsOverlay(store: AppStore, screen: Screen): void {
  const entries = withPrintEntry(store, (screen.menu?.() ?? []).filter((e) => e.run || e.disabled))
  store.open(new ChoiceOverlay<MenuEntry>(store, `Actions · ${screen.title()}`, entries.map((e) => ({ label: e.label, value: e, detail: e.key ?? e.detail, disabled: e.disabled })), (e) => e.run?.(), 'the F9 Context section'))
}

/** Every screen can print what it shows (Ctrl+P); screens without their own Print entry get this one. */
export function withPrintEntry(store: AppStore, entries: MenuEntry[]): MenuEntry[] {
  if (entries.some((e) => e.label.startsWith('Print…'))) return entries
  const label = store.extensions.has('printing') ? 'Print… (this screen as text)' : 'Print… (saves the screen as a file: no printing on this server)'
  return [...entries, { section: 'Context', label, key: 'Ctrl+P', command: 'print', run: () => printScreen(store) }]
}
