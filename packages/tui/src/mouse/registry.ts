/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The mouse layer: one transparent box over the whole terminal takes every mouse event (so OpenTUI's
 * own text selection and focus never start), and this registry says what is under the pointer.
 * Screens and dialogs register zones (rectangles measured from what they drew) with handlers; a
 * click goes to the innermost zone of the top layer that handles it, and bubbles outwards while a
 * handler returns false. Layer 0 is the screen; each open dialog is one layer up, and only the top
 * layer is live, so clicking beside a dialog does nothing.
 */

import { contains, type Rect } from './hit'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** A mouse event in a zone's own coordinates. */
export interface ZoneEvent {
  /** Cell inside the zone (0, 0 is its top-left). */
  x: number
  y: number
  /** Terminal cell. */
  absX: number
  absY: number
  width: number
  height: number
  shift: boolean
  alt: boolean
  ctrl: boolean
  /** Wheel direction (Shift+wheel arrives as left / right). */
  direction?: Direction
  /** Lines to scroll for a wheel notch (3). */
  lines: number
  /** Where a drag started, in the zone's coordinates. */
  startX: number
  startY: number
}

/** A handler that returns false lets the event bubble to the enclosing zone. */
export type ZoneHandler = (event: ZoneEvent) => void | boolean

export interface ZoneHandlers {
  onClick?: ZoneHandler
  onDouble?: ZoneHandler
  onRight?: ZoneHandler
  onWheel?: ZoneHandler
  onDrag?: ZoneHandler
  /** The button came up after a drag. */
  onDrop?: ZoneHandler
}

export type ZoneKind = keyof ZoneHandlers

export interface Zone {
  layer: number
  depth: number
  /** Live in every layer but the lock screen (the F-key bar: pressing a key is the same with a dialog open). */
  global?: boolean
  rect(): Rect | undefined
  handlers(): ZoneHandlers
}

interface Entry extends Zone {
  seq: number
}

export class MouseRegistry {
  private zones = new Set<Entry>()
  private seq = 0

  add(zone: Zone): () => void {
    const entry: Entry = { ...zone, seq: ++this.seq }
    this.zones.add(entry)
    return () => this.zones.delete(entry)
  }

  get size(): number {
    return this.zones.size
  }

  /** Zones at (x, y) that are live in `layer`, innermost first. */
  at(x: number, y: number, layer: number): Zone[] {
    return hitTest([...this.zones], x, y, layer)
  }
}

/**
 * The zones under (x, y) live in `layer` (zones of that layer, and global zones), innermost first:
 * the higher layer, then the deeper zone, then the smaller one, then the later one.
 */
export function hitTest<T extends Zone & { seq?: number }>(zones: T[], x: number, y: number, layer: number): T[] {
  const hits: Array<{ z: T; area: number }> = []
  for (const z of zones) {
    if (z.layer !== layer && !(z.global && layer < LOCK_LAYER)) continue
    const r = z.rect()
    if (!r || !contains(r, x, y)) continue
    hits.push({ z, area: r.width * r.height })
  }
  hits.sort((a, b) => b.z.layer - a.z.layer || b.z.depth - a.z.depth || a.area - b.area || (b.z.seq ?? 0) - (a.z.seq ?? 0))
  return hits.map((h) => h.z)
}

/** The lock screen's layer: above every dialog, and global zones are off. */
export const LOCK_LAYER = 10_000
