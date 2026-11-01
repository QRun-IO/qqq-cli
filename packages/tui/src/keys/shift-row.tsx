/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Shift row of the F-key bar: under the primary row when the bar has two rows, or in its place
 * for a moment after a Shift+F press in one-row mode. It uses the primary row's arithmetic (mouse/hit.ts
 * fkeyAt), so the keys line up and a click hits the key drawn there; the first number carries the ⇧.
 */

import type { AppStore } from '../store'
import { fkeyAt } from '../mouse/hit'
import { key } from '../mouse/keys'
import { Zone } from '../mouse/zone'
import { glyphs, theme } from '../theme'
import { pad } from '../util/text'
import { fkeyBarRows, shiftSlots, type ShiftSlot } from './shift-bank'

/** The cells of each slot, as the primary row lays them out: max(7, width / count), the last takes the rest. */
export function slotWidths(width: number, count: number): number[] {
  const cell = Math.max(7, Math.floor(width / count))
  const out: number[] = []
  let used = 0
  for (let i = 0; i < count; i++) {
    const w = i === count - 1 ? Math.max(0, width - used) : cell
    out.push(w)
    used += w
  }
  return out
}

/** The text of each slot (number, then the label padded to the slot), clipped to the width. */
export function shiftRowCells(slots: ShiftSlot[], width: number, ascii = false): Array<{ n: number; num: string; label: string; active: boolean }> {
  const widths = slotWidths(width, slots.length)
  const narrow = width < 100
  return slots.map((s, i) => {
    const w = widths[i]!
    const num = i === 0 ? `${ascii ? 'S' : '⇧'}${s.n}` : String(s.n).padStart(2)
    const base = s.label ?? s.global
    const label = narrow || base.length > w - 2 ? s.short : base
    return { n: s.n, num: num.slice(0, w), label: pad(label, Math.max(0, w - 2)).slice(0, Math.max(0, w - 2)), active: s.label !== null }
  })
}

export function ShiftRow({ store, width, slots }: { store: AppStore; width: number; slots: number }) {
  const t = theme()
  const shift = shiftSlots(store, slots)
  const cells = shiftRowCells(shift, width, glyphs().border !== undefined)
  return (
    <Zone global onClick={(e) => {
      const n = fkeyAt(e.x, width, shift.map((s) => s.n))
      if (n !== undefined) store.handleKey(key(`shift+f${n}`, { shift: true }))
    }}>
      <text flexShrink={0} wrapMode="none">
        {cells.map((c) => (
          <span key={c.n}>
            <span fg={t.keyNum}>{c.num}</span>
            <span fg={c.active ? t.keyLabelFg : t.dim} bg={c.active ? t.keyLabelBg : undefined}>{c.label}</span>
          </span>
        ))}
      </text>
    </Zone>
  )
}

/** How many rows the bar takes now (the body is that much shorter). */
export function barRows(store: AppStore, height: number): 1 | 2 {
  return fkeyBarRows(store.settings.fkeyBar, height)
}
