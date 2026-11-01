/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A character grid the screen saver paints into: every write is clipped to the grid, so nothing
 * can spill past the screen whatever the terminal size. Rows come out as runs of one style for
 * <text>/<span>.
 */

export interface Style {
  fg?: string
  bg?: string
  bold?: boolean
}

export interface Run extends Style {
  text: string
}

interface Cell extends Style {
  ch: string
}

export class Canvas {
  private cells: Cell[][]

  constructor(readonly width: number, readonly height: number, private readonly base: Style = {}) {
    this.cells = Array.from({ length: Math.max(0, height) }, () => Array.from({ length: Math.max(0, width) }, () => ({ ch: ' ', ...base })))
  }

  /** Writes text at (x, y), clipped; `transparent` leaves spaces showing what is underneath. */
  put(x: number, y: number, text: string, style: Style = {}, transparent = false): void {
    if (y < 0 || y >= this.height) return
    const row = this.cells[y]!
    let col = Math.round(x)
    for (const ch of text) {
      if (col >= this.width) break
      if (col >= 0 && !(transparent && ch === ' ')) {
        const cell = row[col]!
        row[col] = { ch, fg: style.fg ?? cell.fg ?? this.base.fg, bg: style.bg ?? cell.bg ?? this.base.bg, bold: style.bold ?? false }
      }
      col++
    }
  }

  /** Several rows of text from (x, y) down. */
  block(x: number, y: number, rows: readonly string[], style: Style = {}, transparent = true): void {
    rows.forEach((r, i) => this.put(x, y + i, r, style, transparent))
  }

  /** Fills a rectangle (clipped) with a background and spaces. */
  fill(x: number, y: number, w: number, h: number, style: Style): void {
    for (let r = 0; r < h; r++) this.put(x, y + r, ' '.repeat(Math.max(0, w)), style)
  }

  /** A framed box; returns the inner rectangle. */
  box(x: number, y: number, w: number, h: number, style: Style & { border?: string; title?: string }, ascii: boolean): { x: number; y: number; w: number; h: number } {
    const [tl, tr, bl, br, hz, vt] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['╭', '╮', '╰', '╯', '─', '│']
    const b: Style = { fg: style.border ?? style.fg, bg: style.bg }
    this.fill(x, y, w, h, { bg: style.bg, fg: style.fg })
    const title = style.title ? ` ${style.title} ` : ''
    this.put(x, y, tl + hz.repeat(Math.max(0, w - 2)) + tr, b)
    if (title) this.put(x + 1, y, title.slice(0, Math.max(0, w - 2)), { ...b, bold: true })
    for (let r = 1; r < h - 1; r++) {
      this.put(x, y + r, vt, b)
      this.put(x + w - 1, y + r, vt, b)
    }
    if (h > 1) this.put(x, y + h - 1, bl + hz.repeat(Math.max(0, w - 2)) + br, b)
    return { x: x + 1, y: y + 1, w: Math.max(0, w - 2), h: Math.max(0, h - 2) }
  }

  /** Dims everything: each colour moves `amount` (0…1) of the way to the background (burn-in guard). */
  dim(amount: number): void {
    const bg = this.base.bg
    for (const row of this.cells) {
      for (const cell of row) {
        cell.fg = mix(cell.fg ?? this.base.fg, cell.bg ?? bg, amount)
        cell.bg = mix(cell.bg ?? bg, bg, amount)
      }
    }
  }

  /** The grid as text (tests, captures). */
  text(): string {
    return this.cells.map((r) => r.map((c) => c.ch).join('')).join('\n')
  }

  /** One row as runs of the same style. */
  runs(y: number): Run[] {
    const out: Run[] = []
    for (const c of this.cells[y] ?? []) {
      const last = out[out.length - 1]
      if (last && last.fg === c.fg && last.bg === c.bg && Boolean(last.bold) === Boolean(c.bold)) last.text += c.ch
      else out.push({ text: c.ch, fg: c.fg, bg: c.bg, bold: c.bold })
    }
    return out
  }
}

/** `#rrggbb` colours blended; anything else (named colours, undefined) stays as it is. */
function mix(from: string | undefined, to: string | undefined, amount: number): string | undefined {
  const a = /^#([0-9a-f]{6})$/i.exec(from ?? '')
  const b = /^#([0-9a-f]{6})$/i.exec(to ?? '')
  if (!a || !b) return from
  const channel = (hex: string, i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  let out = '#'
  for (let i = 0; i < 3; i++) out += Math.round(channel(a[1]!, i) + (channel(b[1]!, i) - channel(a[1]!, i)) * amount).toString(16).padStart(2, '0')
  return out
}
