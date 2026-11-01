/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The small markdown the assistant writes, parsed into blocks both heads draw: headings, paragraphs,
 * bullet and numbered lists, pipe tables, and inline **bold**, `code` and [links](/app/...). HTML
 * entities are decoded (`&#58;` is `:`). Links are numbered in reading order, one number per target
 * (two links to the same record share it), so a client can make them Tab targets and never show a
 * URL. Exact duplicate paragraphs are collapsed (models sometimes restate a sentence word for word).
 */

import { parseAppHref } from '../extensions/assistant.js'
import { layoutTable } from './output.js'
import { decodeEntities } from './text.js'

/** A run of text with one style; a link carries its number. */
export interface MdInline {
  text: string
  style?: 'bold' | 'code' | 'link'
  href?: string
  /** For links: the index into {@link MdDocument.links}. */
  link?: number
}

export type MdAlign = 'left' | 'right' | 'center'

export type MdBlock =
  | { kind: 'heading'; level: number; inlines: MdInline[] }
  | { kind: 'paragraph'; inlines: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'table'; headers: MdInline[][]; aligns: MdAlign[]; rows: MdInline[][][] }

export interface MdLink {
  label: string
  href: string
  /** What the link points at (see {@link linkTargetKey}): links with the same key are one link. */
  key: string
}

export interface MdDocument {
  blocks: MdBlock[]
  /** Every link target, in reading order, once. */
  links: MdLink[]
}

/** The primary key field of a table, for telling a filter on the key from a record link. */
export type PrimaryKeyOf = (table: string) => string | undefined

/**
 * What a link points at, so equal targets compare equal: `record:{table}:{id}` (also for a filter
 * that is exactly "primary key EQUALS one value"), `table:{table}:{canonical filter}`, or the href.
 * Filters in JSON or base64 JSON compare by content (keys sorted, empty criteria dropped).
 */
export function linkTargetKey(href: string, primaryKeyOf: PrimaryKeyOf = () => 'id'): string {
  const target = parseAppHref(href)
  if (!target?.tableName) return `href:${href}`
  if (target.recordId !== undefined) return `record:${target.tableName}:${target.recordId}`
  const filter = target.filter as { criteria?: Array<{ fieldName?: string; operator?: string; values?: unknown[] }>; subFilters?: unknown[] } | undefined
  const criteria = filter?.criteria ?? []
  const pk = primaryKeyOf(target.tableName) ?? 'id'
  if (criteria.length === 1 && !filter?.subFilters?.length && criteria[0]!.fieldName === pk && criteria[0]!.operator === 'EQUALS' && criteria[0]!.values?.length === 1) {
    return `record:${target.tableName}:${String(criteria[0]!.values[0])}`
  }
  if (!criteria.length && !filter?.subFilters?.length) return `table:${target.tableName}:`
  return `table:${target.tableName}:${canonical({ criteria, subFilters: filter?.subFilters ?? [], booleanOperator: (filter as { booleanOperator?: string }).booleanOperator ?? 'AND' })}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}

/** Parses inline markdown: links, bold, code; entities decoded in text and labels. */
function inlines(source: string, register: (label: string, href: string) => number): MdInline[] {
  const out: MdInline[] = []
  const push = (text: string, style?: MdInline['style']) => {
    if (!text) return
    const last = out[out.length - 1]
    if (!style && last && !last.style) last.text += text
    else out.push(style ? { text, style } : { text })
  }
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/g
  let at = 0
  for (const m of source.matchAll(pattern)) {
    push(decodeEntities(source.slice(at, m.index)))
    if (m[1] !== undefined) {
      const label = decodeEntities(m[1]).replace(/\*\*|__|`/g, '')
      const href = decodeEntities(m[2]!)
      out.push({ text: label, style: 'link', href, link: register(label, href) })
    } else if (m[3] !== undefined || m[4] !== undefined) push(decodeEntities(m[3] ?? m[4]!), 'bold')
    else push(decodeEntities(m[5]!), 'code')
    at = m.index + m[0].length
  }
  push(decodeEntities(source.slice(at)))
  return out
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function cells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  // split on pipes that are not inside a link target or escaped
  const out: string[] = []
  let cell = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue }
    if (ch === '(' && text[i - 1] === ']') depth++
    else if (ch === ')' && depth > 0) depth--
    if (ch === '|' && depth === 0) { out.push(cell.trim()); cell = '' } else cell += ch
  }
  out.push(cell.trim())
  return out
}

/** Parses the assistant's markdown into blocks and numbered links. */
export function parseMarkdown(text: string, primaryKeyOf?: PrimaryKeyOf): MdDocument {
  const links: MdLink[] = []
  const register = (label: string, href: string): number => {
    const key = linkTargetKey(href, primaryKeyOf)
    const found = links.findIndex((l) => l.key === key)
    if (found >= 0) return found
    links.push({ label, href, key })
    return links.length - 1
  }
  const blocks: MdBlock[] = []
  const seenParagraphs = new Set<string>()
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l)
  const isHeading = (l: string) => /^\s{0,3}#{1,6}\s+/.test(l)
  const isTableStart = (n: number) => lines[n]?.includes('|') && TABLE_RULE.test(lines[n + 1] ?? '')
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    if (isHeading(line)) {
      const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)!
      blocks.push({ kind: 'heading', level: m[1]!.length, inlines: inlines(m[2]!, register) })
      i++
      continue
    }
    if (isTableStart(i)) {
      const headers = cells(line).map((c) => inlines(c, register))
      const aligns: MdAlign[] = cells(lines[i + 1]!).map((c) => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left')
      const rows: MdInline[][][] = []
      i += 2
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        rows.push(cells(lines[i]!).map((c) => inlines(c, register)))
        i++
      }
      blocks.push({ kind: 'table', headers, aligns, rows })
      continue
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: MdInline[][] = []
      while (i < lines.length && isList(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        i++
        // continuation lines indented under the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !isList(lines[i]!)) item += ' ' + lines[i++]!.trim()
        items.push(inlines(item, register))
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i]!.trim() && !isHeading(lines[i]!) && !isList(lines[i]!) && !isTableStart(i)) paragraph.push(lines[i++]!.trim())
    const joined = paragraph.join(' ')
    const norm = decodeEntities(joined).replace(/\s+/g, ' ').trim()
    if (seenParagraphs.has(norm)) continue
    seenParagraphs.add(norm)
    blocks.push({ kind: 'paragraph', inlines: inlines(joined, register) })
  }
  return { blocks, links }
}

/** The plain text of inlines; links as `label ↗` (or what `link` returns). */
export function inlineText(parts: MdInline[], link: (part: MdInline) => string = (p) => `${p.text} ↗`): string {
  return parts.map((p) => (p.style === 'link' ? link(p) : p.text)).join('')
}

/** Word-wraps plain text to a width (long words are cut); `indent` goes before continuation lines. */
export function wrapPlain(text: string, width: number, first = '', rest = first): string[] {
  const out: string[] = []
  const w = Math.max(4, width)
  let line = first
  let empty = true
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const prefixLen = (out.length ? rest : first).length
    if (!empty && line.length + 1 + word.length > w) {
      out.push(line)
      line = rest
      empty = true
    }
    let piece = word
    while ((empty ? line.length : line.length + 1) + piece.length > w && piece.length > w - prefixLen) {
      const room = w - line.length - (empty ? 0 : 1)
      line += (empty ? '' : ' ') + piece.slice(0, room)
      out.push(line)
      line = rest
      piece = piece.slice(room)
      empty = true
    }
    line += (empty ? '' : ' ') + piece
    empty = false
  }
  if (!empty || !out.length) out.push(line)
  return out
}

/**
 * The document as terminal text for a width: headings and paragraphs wrapped, lists with `-` or
 * `1.`, tables laid out like the CLI's sub-tables (columns that do not fit are left out, cells cut
 * with `…`). `link` renders a link (default `label ↗`).
 */
export function markdownText(doc: MdDocument, width = 100, link?: (part: MdInline) => string): string {
  const out: string[] = []
  for (const block of doc.blocks) {
    if (out.length) out.push('')
    if (block.kind === 'heading') out.push(...wrapPlain(inlineText(block.inlines, link), width))
    else if (block.kind === 'paragraph') out.push(...wrapPlain(inlineText(block.inlines, link), width))
    else if (block.kind === 'list') {
      block.items.forEach((item, n) => {
        const bullet = block.ordered ? `${n + 1}. ` : '- '
        out.push(...wrapPlain(inlineText(item, link), width, bullet, ' '.repeat(bullet.length)))
      })
    } else {
      const columns = block.headers.map((_, i) => `c${i}`)
      const rows = block.rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, inlineText(r[i] ?? [], link)])))
      const { text, hidden } = layoutTable(rows, columns, block.headers.map((h) => inlineText(h, link)), { width, maxCell: Math.max(8, width) })
      out.push(...text.split('\n'))
      if (hidden.length) out.push(`(${hidden.length} more column${hidden.length === 1 ? '' : 's'} do not fit)`)
    }
  }
  return out.join('\n')
}

/**
 * An assistant answer as a document, plus the answer's links that the text does not already show
 * (records and tables from tool results), once per target: the "→" list a client draws under the text.
 * The document's links come first, then these, so numbering them in that order is reading order.
 */
export function answerDocument(answer: { text: string; links: Array<{ label: string; href: string }> }, primaryKeyOf?: PrimaryKeyOf): { doc: MdDocument; extraLinks: MdLink[] } {
  const doc = parseMarkdown(answer.text, primaryKeyOf)
  const keys = new Set(doc.links.map((l) => l.key))
  const extraLinks: MdLink[] = []
  for (const link of answer.links) {
    const key = linkTargetKey(link.href, primaryKeyOf)
    if (keys.has(key)) continue
    keys.add(key)
    extraLinks.push({ label: link.label, href: link.href, key })
  }
  return { doc, extraLinks }
}
