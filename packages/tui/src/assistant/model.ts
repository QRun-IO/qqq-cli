/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The assistant panel's conversation as lines for a width: each question, the answer's markdown
 * rendered (entities decoded, headings, wrapped paragraphs, lists, **bold**, `code`, pipe tables laid
 * out like the grid and clipped with `…`), its numbers, and the links. A link shows as `label ↗`,
 * never its URL; links are numbered across the conversation in reading order, once per target (the
 * text's links, then the tool results' links the text does not show), so the panel can move a cursor
 * over them. Every line fits the width it was built for.
 */

import { answerDocument, fitColumns, type AssistantAnswer, type AssistantPageContext, type MdBlock, type MdInline, type MdLink, type PrimaryKeyOf } from '@qrun-io/qqq-core'
import { cellWidth, trunc } from '../util/text'

/** One question and its answer (streaming until `answer.status` leaves RUNNING). */
export interface Exchange {
  question: string
  /** "Person #3" when the question was asked from a record or grid. */
  contextLabel?: string
  context?: AssistantPageContext
  answer?: AssistantAnswer
  /** What the assistant is doing while nothing is written yet (the last tool summary). */
  activity?: string
  /** A refusal or failure, shown in red. */
  error?: string
  startedAt: number
}

export type LineRole = 'question' | 'context' | 'text' | 'heading' | 'header' | 'rule' | 'number' | 'link' | 'activity' | 'error' | 'meta' | 'blank'

/** A run of a line with one look; `link` is the link number it opens. */
export interface Seg {
  text: string
  style?: 'bold' | 'code' | 'link' | 'dim'
  link?: number
}

export interface ChatLine {
  /** The line as plain text (what the segments add up to). */
  text: string
  role: LineRole
  /** The first link on the line (a click opens it). */
  link?: number
  segs?: Seg[]
}

/** The answer's markdown as plain text (bold, code and heading markers dropped). */
export function plainText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
}

/** Word-wraps text to a width in cells (long words are cut); keeps blank lines. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue
      const candidate = line + word
      if (cellWidth(candidate) <= w) {
        line = candidate
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = /^\s+$/.test(word) ? '' : word
      while (cellWidth(line) > w) {
        let cut = ''
        for (const ch of line) {
          if (cellWidth(cut + ch) > w) break
          cut += ch
        }
        out.push(cut)
        line = line.slice(cut.length)
      }
    }
    if (line.trim()) out.push(line.trimEnd())
  }
  return out
}

/** An answer's links in reading order with their offset into the conversation's numbering. */
function answerLinks(answer: AssistantAnswer, primaryKeyOf?: PrimaryKeyOf): { blocks: MdBlock[]; text: MdLink[]; extra: MdLink[] } {
  const { doc, extraLinks } = answerDocument(answer, primaryKeyOf)
  return { blocks: doc.blocks, text: doc.links, extra: extraLinks }
}

/** Every link of the conversation, in reading order, once per target per answer (what the link cursor moves over). */
export function chatLinks(exchanges: Exchange[], primaryKeyOf?: PrimaryKeyOf): Array<{ label: string; href: string }> {
  return exchanges.flatMap((e) => {
    if (!e.answer) return []
    const { text, extra } = answerLinks(e.answer, primaryKeyOf)
    return [...text, ...extra]
  })
}

function segsFrom(inlines: MdInline[], offset: number): Seg[] {
  return inlines.map((p) => p.style === 'link' ? { text: `${p.text} ↗`, style: 'link' as const, link: offset + p.link! } : { text: p.text, ...(p.style ? { style: p.style } : {}) })
}

/** Wraps styled runs to a width, word by word; `first`/`rest` go before the first and later lines. */
export function wrapSegs(segs: Seg[], width: number, role: LineRole, first = '', rest = first): ChatLine[] {
  const words: Seg[] = []
  for (const s of segs) {
    for (const part of s.text.split(/(\s+)/)) if (part) words.push({ ...s, text: part })
  }
  const lines: ChatLine[] = []
  let cur: Seg[] = [{ text: first }]
  let used = cellWidth(first)
  let content = false
  let pendingSpace: Seg | undefined
  const flush = () => {
    lines.push(line(cur, role))
    cur = [{ text: rest }]
    used = cellWidth(rest)
    content = false
    pendingSpace = undefined
  }
  for (const word of words) {
    if (/^\s+$/.test(word.text)) {
      if (content) pendingSpace = { ...word, text: ' ' }
      continue
    }
    let text = word.text
    let w = cellWidth(text)
    if (content && used + (pendingSpace ? 1 : 0) + w > width) flush()
    if (pendingSpace && content) {
      cur.push(pendingSpace)
      used += 1
    }
    pendingSpace = undefined
    while (used + w > width) {
      let cut = ''
      for (const ch of text) {
        if (used + cellWidth(cut + ch) > width) break
        cut += ch
      }
      if (!cut) break
      cur.push({ ...word, text: cut })
      flush()
      text = text.slice(cut.length)
      w = cellWidth(text)
    }
    if (text) {
      cur.push({ ...word, text })
      used += w
      content = true
    }
  }
  if (content) flush()
  return lines
}

function line(segs: Seg[], role: LineRole): ChatLine {
  const merged: Seg[] = []
  for (const s of segs) {
    if (!s.text) continue
    const last = merged[merged.length - 1]
    if (last && last.style === s.style && last.link === s.link) last.text += s.text
    else merged.push({ ...s })
  }
  const link = merged.find((s) => s.link !== undefined)?.link
  return { text: merged.map((s) => s.text).join(''), role, segs: merged, ...(link !== undefined ? { link } : {}) }
}

/** A pipe table laid out like the grid: columns fitted to the width (the rest left out), cells cut with `…`. */
function tableLines(block: Extract<MdBlock, { kind: 'table' }>, width: number, offset: number): ChatLine[] {
  const cellSegs = (inl: MdInline[]) => segsFrom(inl, offset)
  const plain = (segs: Seg[]) => segs.map((s) => s.text).join('').replace(/\s+/g, ' ')
  const headers = block.headers.map((h) => plain(cellSegs(h)))
  const rows = block.rows.map((r) => block.headers.map((_, i) => cellSegs(r[i] ?? [])))
  const natural = headers.map((h, i) => Math.max(cellWidth(h), ...rows.map((r) => cellWidth(plain(r[i]!)))))
  const { widths, shown } = fitColumns(natural, width)
  const fit = (text: string, w: number, align: string) => {
    const t = trunc(text, w)
    const room = Math.max(0, w - cellWidth(t))
    return align === 'right' ? ' '.repeat(room) + t : t + ' '.repeat(room)
  }
  const out: ChatLine[] = []
  out.push(line(headers.slice(0, shown).flatMap((h, i) => [{ text: fit(h, widths[i]!, block.aligns[i] ?? 'left'), style: 'bold' as const }, { text: i < shown - 1 ? '  ' : '' }]), 'header'))
  out.push(line([{ text: widths.map((w) => '─'.repeat(w)).join('  '), style: 'dim' }], 'rule'))
  for (const r of rows) {
    const segs: Seg[] = []
    r.slice(0, shown).forEach((cell, i) => {
      const text = fit(plain(cell), widths[i]!, block.aligns[i] ?? 'left')
      const linked = cell.find((s) => s.link !== undefined)
      segs.push(linked ? { text, style: 'link', link: linked.link } : { text })
      if (i < shown - 1) segs.push({ text: '  ' })
    })
    out.push(line(segs, 'text'))
  }
  if (shown < headers.length) out.push(line([{ text: trunc(`(${headers.length - shown} more column${headers.length - shown === 1 ? '' : 's'}: ${headers.slice(shown).join(', ')})`, width), style: 'dim' }], 'meta'))
  return out.map((l) => (cellWidth(l.text) > width ? { ...l, text: trunc(l.text, width), segs: [{ text: trunc(l.text, width), style: l.segs?.[0]?.style }] } : l))
}

/** An answer's markdown as lines (links numbered from `offset`). */
export function answerLines(blocks: MdBlock[], width: number, offset: number): ChatLine[] {
  const out: ChatLine[] = []
  for (const block of blocks) {
    if (out.length) out.push({ text: '', role: 'blank' })
    if (block.kind === 'heading') out.push(...wrapSegs(segsFrom(block.inlines, offset).map((s) => ({ ...s, style: s.style ?? 'bold' })), width, 'heading'))
    else if (block.kind === 'paragraph') out.push(...wrapSegs(segsFrom(block.inlines, offset), width, 'text'))
    else if (block.kind === 'list') block.items.forEach((item, n) => {
      const bullet = block.ordered ? `${n + 1}. ` : '• '
      out.push(...wrapSegs(segsFrom(item, offset), width, 'text', bullet, ' '.repeat(cellWidth(bullet))))
    })
    else out.push(...tableLines(block, width, offset))
  }
  return out
}

/** The conversation as lines for a width (the panel's inner width). */
export function chatLines(exchanges: Exchange[], width: number, now = Date.now(), primaryKeyOf?: PrimaryKeyOf): ChatLine[] {
  const lines: ChatLine[] = []
  let offset = 0
  const add = (text: string, role: LineRole, prefix = '', link?: number) => {
    const rest = ' '.repeat(cellWidth(prefix))
    wrap(text, width - cellWidth(prefix)).forEach((l, i) => lines.push({ text: (i === 0 ? prefix : rest) + l, role, ...(link !== undefined ? { link } : {}) }))
  }
  exchanges.forEach((e, n) => {
    if (n > 0) lines.push({ text: '', role: 'blank' })
    add(e.question, 'question', 'You: ')
    if (e.contextLabel) add(`on ${e.contextLabel}`, 'context', '     ')
    const answer = e.answer
    const running = !e.error && (!answer || answer.status === 'RUNNING')
    const parsed = answer ? answerLinks(answer, primaryKeyOf) : { blocks: [], text: [], extra: [] }
    if (parsed.blocks.length) lines.push(...answerLines(parsed.blocks, width, offset))
    if (running && !parsed.blocks.length) add(`${e.activity ?? 'thinking'}… ${Math.max(0, Math.round((now - e.startedAt) / 1000))} s`, 'activity')
    for (const num of answer?.numbers ?? []) add(`${num.label}: ${num.value}`, 'number', '# ')
    // the tool results' links the text does not show, once per target
    parsed.extra.forEach((link, i) => {
      const index = offset + parsed.text.length + i
      wrapSegs([{ text: `${link.label} ↗`, style: 'link', link: index }], width, 'link', '→ ', '  ').forEach((l) => lines.push(l))
    })
    offset += parsed.text.length + parsed.extra.length
    for (const notice of answer?.notices ?? []) add(notice.text, notice.level === 'error' ? 'error' : 'meta', `${notice.level}: `)
    if (e.error) add(e.error, 'error')
    else if (answer?.error) add(`${answer.error.message} (${answer.error.code})`, 'error')
    if (answer && !running && answer.elapsedMs !== undefined) {
      const tokens = answer.usage?.inputTokens !== undefined ? ` · ${answer.usage.inputTokens} in / ${answer.usage.outputTokens ?? 0} out tokens` : ''
      add(`${(answer.elapsedMs / 1000).toFixed(1)} s${tokens}${answer.status === 'CANCELLED' ? ' · stopped' : ''}`, 'meta')
    }
  })
  return lines
}

/** "Person #3" / "Person (filtered)" / "Person" for a page context and the table's label. */
export function contextLabel(context: AssistantPageContext | undefined, tableLabel?: string): string | undefined {
  if (!context?.tableName) return undefined
  const label = tableLabel ?? context.tableName
  if (context.recordId !== undefined) return `${label} #${String(context.recordId)}`
  return context.filter ? `${label} (filtered)` : label
}
