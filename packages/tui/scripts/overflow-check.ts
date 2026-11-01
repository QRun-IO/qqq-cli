/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Checks tmux captures of the TUI for text outside its container:
 *  - no line wider than the terminal, no more lines than its height;
 *  - every box (single, double or rounded border) is closed: each top corner has its matching top
 *    corner on the same row, and each side runs straight down to its bottom corner. Text that ran
 *    past a border would overwrite or shift it, so a broken side is reported with its row.
 * A side hidden by a box drawn over it (a dialog, the : command line) is not a break, nor is a box
 * cut by the bottom border of the scrolling box that holds it (that is clipping, as it should be).
 *   bun run scripts/overflow-check.ts WIDTH HEIGHT capture.txt [...]   (exit 1 on any violation)
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

interface Style { tl: string; tr: string; bl: string; br: string; left: string; right: string }
const STYLES: Style[] = [
  { tl: '╔', tr: '╗', bl: '╚', br: '╝', left: '║╟╠', right: '║╢╣' },
  { tl: '┌', tr: '┐', bl: '└', br: '┘', left: '│├┝┞┟┠', right: '│┤┥┦┧┨' },
  { tl: '╭', tr: '╮', bl: '╰', br: '╯', left: '│├', right: '│┤' },
]

function cellWidth(ch: string): number {
  return ch.charCodeAt(0) < 0x7f ? 1 : Bun.stringWidth(ch)
}

/** A captured line as terminal cells (a wide character takes its cell and an empty one after it). */
export function toCells(line: string): string[] {
  const cells: string[] = []
  for (const ch of line) {
    const w = cellWidth(ch)
    if (w === 0) continue
    cells.push(ch)
    if (w === 2) cells.push('')
  }
  return cells
}

interface Rect { top: number; left: number; bottom: number; right: number }

/** Violations in one capture (empty when clean). */
export function checkCapture(text: string, width: number, height: number): string[] {
  const lines = text.replace(/\n$/, '').split('\n')
  const grid = lines.map(toCells)
  const out: string[] = []
  if (lines.length > height) out.push(`${lines.length} lines, more than the height ${height}`)
  grid.forEach((cells, r) => { if (cells.length > width) out.push(`row ${r + 1}: ${cells.length} cells, wider than ${width}`) })
  const at = (r: number, c: number) => grid[r]?.[c] ?? ' '
  // every box: its corners, and where a side breaks (if it does)
  interface Box extends Rect { style: Style; problems: Array<{ r: number; c: number; text: string }>; closed: boolean }
  const found: Box[] = []
  for (const style of STYLES) {
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r]!.length; c++) {
        if (grid[r]![c] !== style.tl) continue
        let right = -1
        for (let x = c + 1; x < grid[r]!.length; x++) if (grid[r]![x] === style.tr) { right = x; break }
        const box: Box = { style, top: r, left: c, bottom: -1, right, problems: [], closed: false }
        found.push(box)
        if (right < 0) { box.problems.push({ r, c, text: `row ${r + 1} col ${c + 1}: ${style.tl} without a ${style.tr} on its row (box wider than the screen)` }); continue }
        let leftBottom = -1
        for (let y = r + 1; y < grid.length; y++) {
          const ch = at(y, c)
          if (ch === style.bl) { leftBottom = y; break }
          if (!style.left.includes(ch)) { box.problems.push({ r: y, c, text: `row ${y + 1} col ${c + 1}: left border of the box at row ${r + 1} broken by ${JSON.stringify(ch)}` }); break }
        }
        for (let y = r + 1; y < grid.length; y++) {
          const ch = at(y, right)
          if (ch === style.br) { box.bottom = y; break }
          if (!style.right.includes(ch)) {
            const around = (grid[y] ?? []).slice(Math.max(0, right - 12), right + 4).join('')
            box.problems.push({ r: y, c: right, text: `row ${y + 1} col ${right + 1}: right border of the box at row ${r + 1} broken by ${JSON.stringify(ch)} (…${around}…)` })
            break
          }
        }
        if (box.bottom < 0 && !box.problems.length) box.problems.push({ r: grid.length - 1, c: right, text: `the box at row ${r + 1} runs past the bottom of the screen` })
        if (leftBottom >= 0 && box.bottom >= 0 && leftBottom !== box.bottom) box.problems.push({ r: box.bottom, c: right, text: `the box at row ${r + 1} has its bottom corners on rows ${leftBottom + 1} and ${box.bottom + 1}` })
        box.closed = !box.problems.length
      }
    }
  }
  // a side may be hidden by a box drawn over it (a dialog, the : command line): a closed box that holds
  // the break but not this box's own corner. Boxes nested inside this one do not excuse it.
  const inside = (b: Rect, r: number, c: number) => r >= b.top && r <= b.bottom && c >= b.left && c <= b.right
  for (const box of found) {
    // a box drawn over this one's top edge hides its real top-right corner: the pairing is a guess, skip it
    const topHidden = found.some((o) => o !== box && o.closed && o.top <= box.top && o.bottom >= box.top && o.left > box.left && o.left < (box.right < 0 ? Number.MAX_SAFE_INTEGER : box.right) && !inside(o, box.top, box.left))
    if (topHidden) continue
    for (const p of box.problems) {
      const hidden = found.some((o) => o !== box && o.closed && inside(o, p.r, p.c) && !inside(o, box.top, box.left))
      // a box scrolled past the bottom of the box that holds it is clipped there, which is the rule
      const scrolled = found.some((o) => o !== box && o.bottom === p.r && inside(o, box.top, box.left))
      if (!hidden && !scrolled) out.push(p.text)
    }
  }
  return out
}

if (import.meta.main) {
  const [w, h, ...files] = process.argv.slice(2)
  const width = Number(w)
  const height = Number(h)
  if (!width || !height || !files.length) {
    console.error('usage: overflow-check.ts WIDTH HEIGHT capture.txt [...]')
    process.exit(2)
  }
  let bad = 0
  for (const f of files) {
    const problems = checkCapture(readFileSync(f, 'utf8'), width, height)
    if (problems.length) {
      bad++
      console.log(`FAIL ${basename(f)} (${width}x${height})`)
      for (const p of problems) console.log(`     ${p}`)
    }
  }
  process.exit(bad ? 1 : 0)
}
