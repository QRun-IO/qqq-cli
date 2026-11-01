/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A 5-row block font for the screen saver: letters (either case), digits, the clock's colon and
 * `. , - _ / % …`. A name with any other character is drawn as plain text instead (`canDraw`).
 */

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
  'a': ['.##.', '#..#', '####', '#..#', '#..#'],
  'b': ['###.', '#..#', '###.', '#..#', '###.'],
  'c': ['.###', '#...', '#...', '#...', '.###'],
  'd': ['###.', '#..#', '#..#', '#..#', '###.'],
  'e': ['####', '#...', '###.', '#...', '####'],
  'f': ['####', '#...', '###.', '#...', '#...'],
  'g': ['.###', '#...', '#.##', '#..#', '.###'],
  'h': ['#..#', '#..#', '####', '#..#', '#..#'],
  'i': ['###', '.#.', '.#.', '.#.', '###'],
  'j': ['..##', '...#', '...#', '#..#', '.##.'],
  'l': ['#...', '#...', '#...', '#...', '####'],
  'm': ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  'n': ['#..#', '##.#', '#.##', '#..#', '#..#'],
  'o': ['.##.', '#..#', '#..#', '#..#', '.##.'],
  'p': ['###.', '#..#', '###.', '#...', '#...'],
  'r': ['###.', '#..#', '###.', '#.#.', '#..#'],
  's': ['.###', '#...', '.##.', '...#', '###.'],
  't': ['####', '.#..', '.#..', '.#..', '.#..'],
  'u': ['#..#', '#..#', '#..#', '#..#', '.##.'],
  'v': ['#..#', '#..#', '#..#', '.##.', '..#.'],
  'w': ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'x': ['#..#', '#..#', '.##.', '#..#', '#..#'],
  'y': ['#..#', '#..#', '.##.', '..#.', '..#.'],
  'z': ['####', '...#', '.##.', '#...', '####'],
  '_': ['....', '....', '....', '....', '####'],
  ' ': ['..', '..', '..', '..', '..'],
}

export const FONT_HEIGHT = 5

/** Whether the block font can draw every character of the text. */
export function canDraw(text: string): boolean {
  return [...text].every((c) => glyph(c))
}

/** A character's glyph; letters fall back to lower case (`M` has its own, for millions). */
function glyph(c: string): string[] | undefined {
  return GLYPHS[c] ?? GLYPHS[c.toLowerCase()]
}

/** Cells wide the text takes in the block font (one blank column between glyphs). */
export function blockWidth(text: string): number {
  const chars = [...text].filter((c) => glyph(c))
  return chars.reduce((w, c) => w + glyph(c)![0]!.length, 0) + Math.max(0, chars.length - 1)
}

/** The text in block letters: 5 rows, `█` (or `#` for the ASCII glyph set) on spaces. */
export function blockText(text: string, ascii = false): string[] {
  const on = ascii ? '#' : '█'
  const rows = ['', '', '', '', '']
  const chars = [...text].filter((c) => glyph(c))
  chars.forEach((c, i) => {
    const g = glyph(c)!
    for (let r = 0; r < FONT_HEIGHT; r++) rows[r] += g[r]!.replace(/#/g, on).replace(/\./g, ' ') + (i < chars.length - 1 ? ' ' : '')
  })
  return rows
}
