/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { ReactNode } from 'react'
import type { Key } from './keys'

/** A function-key label for the bar: a string, or null when the key does nothing here (the label is hidden). */
export type FKeyLabels = Partial<Record<number, string | null>>

/** One entry of the F9 command center (and of the palette): runnable, searchable, with its shortcut. */
export interface MenuEntry {
  /** Stable identity (the cursor comes back to it after a sub-dialog); defaults to section and label. */
  id?: string
  section: 'Context' | 'Go to' | 'Work' | 'Connection' | 'Settings' | 'Help'
  label: string
  /** Shortcut shown beside the entry. */
  key?: string
  /** The `:` command that does the same, when there is one. */
  command?: string
  /** Shown but not runnable, with the reason (parked, not installed). */
  disabled?: string
  /** Extra text (a count, a state). */
  detail?: string
  run?: () => void
}

/**
 * A screen on the navigation stack. The object is the route entry: its state (cursor, page,
 * filter, selection, scroll) lives here, not in React component state, so going back finds it
 * exactly as it was. Views read from it; key handlers mutate it and ask the store to repaint.
 */
export interface Screen {
  readonly kind: string
  /** Identity for the error boundary (a new identity resets a failed view). */
  readonly id: string
  title(): string
  onKey(key: Key): boolean
  render(width: number, height: number, focused: boolean): ReactNode
  /** Function-key labels that differ from the defaults (null hides a key that does nothing here). */
  fkeys?(): FKeyLabels
  /** Entries for the Context section of the menu. */
  menu?(): MenuEntry[]
  /** Unsaved changes (forms): leaving or quitting asks first. */
  dirty?(): boolean
  /** Work in progress (a running process): quitting warns. */
  busy?(): boolean
  /** Called when this screen is on top again after a screen above it closed. */
  resume?(): void
  refresh?(): void
  dispose?(): void
  /** While true, printable keys belong to the screen (a text field has focus): single-key shortcuts are off. */
  capturesText?(): boolean
  /** The presence scope of the screen (`table:person`, `record:person:3`), for the collaboration slot. */
  presenceScope?(): string | undefined
  /** The CLI command that shows the same thing, for copying. */
  cliEquivalent?(): string | undefined
  /** The view-settings dialog for this screen, when it has one. */
  viewSettings?(): Overlay | undefined
  /** Keys of this screen for the help overlay, listed before the global ones. */
  helpKeys?(): Array<[string, string]>
  /** The help topic: table, process or app name, for F1. */
  helpTopic?(): { kind: 'table' | 'process' | 'app'; name: string } | undefined
}

/** A modal overlay: takes every key while it is on top. */
export interface Overlay {
  readonly id: string
  onKey(key: Key): void
  render(width: number, height: number): ReactNode
}
