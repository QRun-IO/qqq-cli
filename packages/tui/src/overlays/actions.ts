/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { AppStore } from '../store'
import type { MenuEntry, Screen } from '../types'
import { ChoiceOverlay } from './basic'

/** `a`: the screen's actions (the same entries as the F9 Context section) in a list. */
export function actionsOverlay(store: AppStore, screen: Screen): void {
  const entries = (screen.menu?.() ?? []).filter((e) => e.run || e.disabled)
  store.open(new ChoiceOverlay<MenuEntry>(store, `Actions · ${screen.title()}`, entries.map((e) => ({ label: e.label, value: e, detail: e.key ?? e.detail, disabled: e.disabled })), (e) => e.run?.(), 'the F9 Context section'))
}
