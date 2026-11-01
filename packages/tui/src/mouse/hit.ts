/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The hit-testing model: pure functions that map a cell (x, y) to what is drawn there. Screens draw
 * with fixed-width text, so where a thing is follows from the same arithmetic that drew it; these
 * mirror that arithmetic and are unit tested on their own.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/**
 * The function key under column x of the F-key bar (app.tsx FKeyBar): every key gets
 * max(7, floor(width / count)) cells and the last takes what is left; undefined past the end.
 */
export function fkeyAt(x: number, width: number, keys: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]): number | undefined {
  if (x < 0 || x >= width || !keys.length) return undefined
  const cell = Math.max(7, Math.floor(width / keys.length))
  let used = 0
  for (let i = 0; i < keys.length; i++) {
    const w = i === keys.length - 1 ? Math.max(0, width - used) : cell
    if (x >= used && x < used + w) return keys[i]
    used += w
  }
  return undefined
}

/** A grid column as drawn: its cells start after a lead (the selection mark) and are one apart. */
export interface DrawnColumn {
  width: number
}

/** Start cell of each drawn column: `lead` cells, then each column and one space. */
export function columnStarts(cols: DrawnColumn[], lead = 2): number[] {
  const out: number[] = []
  let x = lead
  for (const c of cols) {
    out.push(x)
    x += c.width + 1
  }
  return out
}

/** The drawn column under local x (its cells or the space after it); undefined in the lead or past the last. */
export function columnAt(x: number, cols: DrawnColumn[], lead = 2): number | undefined {
  const starts = columnStarts(cols, lead)
  for (let i = 0; i < cols.length; i++) if (x >= starts[i]! && x < starts[i]! + cols[i]!.width + 1) return i
  return undefined
}

/**
 * The column whose right edge is at local x (the separator space after it, or its last cell): a drag
 * there resizes that column. Undefined elsewhere (a drag there moves the column).
 */
export function boundaryAt(x: number, cols: DrawnColumn[], lead = 2): number | undefined {
  const starts = columnStarts(cols, lead)
  for (let i = 0; i < cols.length; i++) {
    const edge = starts[i]! + cols[i]!.width
    if (x === edge || x === edge - 1) return i
  }
  return undefined
}

/** A column width after dragging its right edge by dx cells (3 to 120, as the view settings allow). */
export function resizedWidth(width: number, dx: number): number {
  return Math.max(3, Math.min(120, width + dx))
}

/** `order` with the item at `from` moved to `to`. */
export function moved<T>(order: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= order.length) return order
  const out = [...order]
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item!)
  return out
}

/** A row of a list drawn from `top`, one line each (or `perRow` lines): the item index at local y, or undefined. */
export function rowAt(y: number, top: number, count: number, perRow = 1): number | undefined {
  if (y < 0) return undefined
  const i = top + Math.floor(y / Math.max(1, perRow))
  return i < count ? i : undefined
}

/** In a tree line indented one cell per depth, the expand glyph sits at the depth: a click there toggles. */
export function treeHit(x: number, depth: number, hasChildren: boolean): 'toggle' | 'node' {
  return hasChildren && x >= depth && x <= depth + 1 ? 'toggle' : 'node'
}

/** Which of the `tokens` (in order, each found after the previous) covers column x of `text`. */
export function tokenAt<T extends string>(text: string, x: number, tokens: T[]): T | undefined {
  let from = 0
  for (const token of tokens) {
    const at = text.indexOf(token, from)
    if (at < 0) continue
    if (x >= at && x < at + token.length) return token
    from = at + token.length
  }
  return undefined
}

/** Tabs drawn left to right as `labels` joined by `gap` after a `lead`: the tab under x. */
export function tabAt(x: number, labels: string[], gap = 1, lead = 0): number | undefined {
  let at = lead
  for (let i = 0; i < labels.length; i++) {
    const w = labels[i]!.length
    if (x >= at && x < at + w) return i
    at += w + gap
  }
  return undefined
}
