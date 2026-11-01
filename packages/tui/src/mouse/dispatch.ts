/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Turns OpenTUI's decoded mouse events (SGR 1006 from the terminal) into zone events: left press is a
 * click (a second one on the same cell within 400 ms is a double-click), right press is the context
 * menu, the wheel scrolls 3 lines (Shift+wheel sideways), and a left drag stays with the zone it
 * started in until the button comes up. Moves without a button (hover) are never asked for.
 */

import type { Rect } from './hit'
import { MouseRegistry, type Direction, type Zone, type ZoneEvent, type ZoneKind } from './registry'

/** What OpenTUI hands a renderable's mouse handler (its MouseEvent), as far as the layer reads it. */
export interface RawMouse {
  type: string
  button: number
  x: number
  y: number
  modifiers?: { shift?: boolean; alt?: boolean; ctrl?: boolean }
  scroll?: { direction: Direction }
}

export interface DispatchHost {
  /** The live layer: 0 for the screen, n with n dialogs open, LOCK_LAYER on the lock screen. */
  layer(): number
  /** The Mouse setting. */
  enabled(): boolean
  /** After a handled event (repaint, idle timer). */
  after(): void
  error(e: unknown): void
  /** A press no zone took (the screen saver and lock: a click wakes them, as a key does). */
  unhandled?(raw: RawMouse): boolean
}

export const DOUBLE_CLICK_MS = 400
export const WHEEL_LINES = 3

export class MouseDispatcher {
  readonly registry = new MouseRegistry()
  private lastClick?: { x: number; y: number; at: number }
  private press?: { zone: Zone; rect: Rect; x: number; y: number; dragged: boolean }

  constructor(private host: DispatchHost, private now: () => number = Date.now) {}

  /** Handles one event; true when a zone took it. */
  handle(raw: RawMouse): boolean {
    if (!this.host.enabled()) return false
    try {
      const handled = this.route(raw) || (raw.type === 'down' && Boolean(this.host.unhandled?.(raw)))
      if (handled) this.host.after()
      return handled
    } catch (e) {
      this.host.error(e)
      this.host.after()
      return true
    }
  }

  private route(raw: RawMouse): boolean {
    const layer = this.host.layer()
    switch (raw.type) {
      case 'down': {
        if (raw.button === 2) return this.deliver('onRight', raw, layer)
        if (raw.button !== 0) return false
        const at = this.now()
        const last = this.lastClick
        const double = last !== undefined && last.y === raw.y && Math.abs(last.x - raw.x) <= 1 && at - last.at <= DOUBLE_CLICK_MS
        this.lastClick = double ? undefined : { x: raw.x, y: raw.y, at }
        const zones = this.registry.at(raw.x, raw.y, layer)
        const dragger = zones.find((z) => z.handlers().onDrag)
        const rect = dragger?.rect()
        this.press = dragger && rect ? { zone: dragger, rect, x: raw.x, y: raw.y, dragged: false } : undefined
        // a double-click where nothing has a double action is a click
        if (double && this.deliver('onDouble', raw, layer, zones)) return true
        return this.deliver('onClick', raw, layer, zones)
      }
      case 'drag': {
        const p = this.press
        if (!p || raw.button !== 0) return false
        p.dragged = true
        this.lastClick = undefined
        return this.call(p.zone, 'onDrag', raw, p)
      }
      case 'up': {
        const p = this.press
        this.press = undefined
        if (!p?.dragged) return false
        return this.call(p.zone, 'onDrop', raw, p)
      }
      case 'scroll': {
        const d = raw.scroll?.direction
        if (!d) return false
        const direction: Direction = raw.modifiers?.shift && (d === 'up' || d === 'down') ? (d === 'up' ? 'left' : 'right') : d
        return this.deliver('onWheel', raw, layer, undefined, direction)
      }
      default:
        return false
    }
  }

  private deliver(kind: ZoneKind, raw: RawMouse, layer: number, zones = this.registry.at(raw.x, raw.y, layer), direction?: Direction): boolean {
    for (const z of zones) {
      const handler = z.handlers()[kind]
      if (!handler) continue
      const r = z.rect()
      if (!r) continue
      if (handler(event(raw, r, direction)) !== false) return true
    }
    return false
  }

  private call(zone: Zone, kind: ZoneKind, raw: RawMouse, p: { rect: Rect; x: number; y: number }): boolean {
    const handler = zone.handlers()[kind]
    if (!handler) return false
    const r = zone.rect() ?? p.rect
    return handler({ ...event(raw, r), startX: p.x - r.x, startY: p.y - r.y }) !== false
  }
}

function event(raw: RawMouse, r: Rect, direction?: Direction): ZoneEvent {
  const x = raw.x - r.x
  const y = raw.y - r.y
  return {
    x, y, absX: raw.x, absY: raw.y, width: r.width, height: r.height,
    shift: Boolean(raw.modifiers?.shift), alt: Boolean(raw.modifiers?.alt), ctrl: Boolean(raw.modifiers?.ctrl),
    lines: WHEEL_LINES, startX: x, startY: y, ...(direction ? { direction } : {}),
  }
}
