/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** A 5-row block font for the screen saver: digits, the clock's colon, a few signs and `q`. */

const GLYPHS: Record<string, string[]> = {
  '0': ['####', '#..#', '#..#', '#..#', '####'],
  '1': ['..#.', '.##.', '..#.', '..#.', '.###'],
  '2': ['####', '...#', '####', '#...', '####'],
  '3': ['####', '...#', '.###', '...#', '####'],
  '4': ['#..#', '#..#', '####', '...#', '...#'],
  '5': ['####', '#...', '####', '...#', '####'],
  '6': ['####', '#...', '####', '#..#', '####'],
  '7': ['####', '...#', '..#.', '.#..', '.#..'],
  '8': ['####', '#..#', '####', '#..#', '####'],
  '9': ['####', '#..#', '####', '...#', '####'],
  ':': ['.', '#', '.', '#', '.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '#', '#'],
  '-': ['...', '...', '###', '...', '...'],
  '/': ['...#', '..#.', '.#..', '#...', '....'],
  '%': ['#..#', '..#.', '.#..', '#..#', '....'],
  'k': ['#...', '#.#.', '##..', '#.#.', '#..#'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  'q': ['....', '####', '#..#', '####', '...#'],
  '…': ['.....', '.....', '.....', '.....', '#.#.#'],
  '?': ['###', '..#', '.##', '...', '.#.'],
  ' ': ['..', '..', '..', '..', '..'],
}

export const FONT_HEIGHT = 5

/** Whether the block font can draw every character of the text. */
export function canDraw(text: string): boolean {
  return [...text].every((c) => c in GLYPHS)
}

/** Cells wide the text takes in the block font (one blank column between glyphs). */
export function blockWidth(text: string): number {
  const chars = [...text].filter((c) => c in GLYPHS)
  return chars.reduce((w, c) => w + GLYPHS[c]![0]!.length, 0) + Math.max(0, chars.length - 1)
}

/** The text in block letters: 5 rows, `█` (or `#` for the ASCII glyph set) on spaces. */
export function blockText(text: string, ascii = false): string[] {
  const on = ascii ? '#' : '█'
  const rows = ['', '', '', '', '']
  const chars = [...text].filter((c) => c in GLYPHS)
  chars.forEach((c, i) => {
    const g = GLYPHS[c]!
    for (let r = 0; r < FONT_HEIGHT; r++) rows[r] += g[r]!.replace(/#/g, on).replace(/\./g, ' ') + (i < chars.length - 1 ? ' ' : '')
  })
  return rows
}
