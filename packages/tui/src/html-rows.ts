/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * HTML widgets that lay rows out with styled spans (a label, a status pill, a detail: the alerts
 * setup checklist) lose their columns when the tags are stripped ("Channels Set up1 channel…").
 * This reads each top-level block of the HTML as a row of its text runs and, when most rows have
 * the same few cells, returns them as aligned columns (a headerless table block) with each row's
 * first link, so the TUI can pad them and Enter can open the linked table.
 */

import { decodeEntities, type RenderBlock } from '@qrun-io/qqq-core'

interface HtmlRow {
  cells: string[]
  href?: string
}

const BLOCK = /^(div|p|li|tr|section|article|h\d)$/i
const VOID = /^(br|img|hr|input|meta|link|wbr)$/i

/** Splits HTML into its top-level blocks, each as its text runs (one per run of text between tags) and first link. */
export function htmlBlocks(html: string): HtmlRow[] {
  const rows: HtmlRow[] = []
  let depth = 0
  let current: HtmlRow | undefined
  let run = ''
  const flush = () => {
    const text = decodeEntities(run).replace(/\s+/g, ' ').trim()
    run = ''
    if (!text) return
    if (!current) {
      current = { cells: [] }
      rows.push(current)
    }
    current.cells.push(text)
  }
  const re = /<(\/?)([A-Za-z][\w-]*)([^>]*)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      run += m[4]
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2]!
    const attrs = m[3] ?? ''
    // inline formatting inside one text run (b, i, em, code) does not split it; spans and links do
    if (/^(b|i|em|code|u|small|sup|sub|abbr)$/i.test(tag)) continue
    flush()
    if (VOID.test(tag) || attrs.trim().endsWith('/')) continue
    if (BLOCK.test(tag)) {
      if (closing) {
        depth = Math.max(0, depth - 1)
        if (depth === 0) current = undefined
      } else {
        if (depth === 0) current = undefined
        depth++
      }
      continue
    }
    if (!closing && /^a$/i.test(tag)) {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs)
      if (href && !current?.href) {
        if (!current) {
          current = { cells: [] }
          rows.push(current)
        }
        current.href = decodeEntities(href[1] ?? href[2] ?? '')
      }
    }
  }
  flush()
  return rows.filter((r) => r.cells.length)
}

/**
 * Render blocks for row-shaped HTML: single-run blocks as text, runs of two to four cells as an
 * aligned headerless table; undefined when the HTML is not row-shaped (fewer than two such rows).
 */
export function htmlRowBlocks(html: string): RenderBlock[] | undefined {
  const rows = htmlBlocks(html)
  const multi = rows.filter((r) => r.cells.length >= 2 && r.cells.length <= 4)
  if (multi.length < 2 || multi.length < rows.length / 2) return undefined
  const width = Math.max(...multi.map((r) => r.cells.length))
  const out: RenderBlock[] = []
  let table: Array<Record<string, unknown>> = []
  const columns = Array.from({ length: width }, (_, i) => `c${i}`)
  const close = () => {
    if (table.length) out.push({ kind: 'table', columns, headers: columns.map(() => ''), rows: table })
    table = []
  }
  for (const r of rows) {
    if (r.cells.length < 2 || r.cells.length > 4) {
      close()
      out.push({ kind: 'text', text: r.cells.join(' ') })
      continue
    }
    // short rows keep their last cell in the last (wrapping) column
    const cells = r.cells.length < width ? [...r.cells.slice(0, -1), ...Array(width - r.cells.length).fill(''), r.cells[r.cells.length - 1]!] : r.cells
    table.push({ ...Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])), ...(r.href ? { __href: r.href } : {}) })
  }
  close()
  return out
}
