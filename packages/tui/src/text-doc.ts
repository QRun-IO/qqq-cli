/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Text and HTML widgets as a small document, drawn with the hierarchy the web gives them (the Next
 * UI renders the HTML itself): headings in the accent colour with a blank line before and their
 * block indented under them, status words (OK, WARN, FAIL, …) as fixed-width coloured badges,
 * `Label: value` items as an aligned two-column list, body text wrapped at a reading measure (~100
 * cells) with a blank line between paragraphs, enumerations as bullets, and ISO timestamps in the
 * profile's date format. Parsing is pure; drawing gives StyledLines that the panes clip.
 */

import { decodeEntities } from '@qrun-io/qqq-core'
import { trunc } from './util/text'
import { glyphs, isAscii, theme } from './theme'
import { clipLine, type Segment, type StyledLine } from './widgets'

export type Tone = 'ok' | 'warn' | 'err' | 'info'

export interface Badge {
  text: string
  tone: Tone
}

export interface DocItem {
  label?: string
  value: string
  badge?: Badge
  href?: string
}

export type DocBlock =
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'para'; text: string; badge?: Badge; card?: number }
  | { kind: 'list'; items: DocItem[]; ordered?: boolean }

export interface DocOptions {
  /** Formats an ISO instant for people (the profile's date format); unchanged when absent. */
  date?: (iso: string) => string
}

const STATUS: Record<string, Tone> = {
  OK: 'ok', PASS: 'ok', PASSED: 'ok', HEALTHY: 'ok', UP: 'ok', READY: 'ok', SUCCESS: 'ok', ACTIVE: 'ok', ENABLED: 'ok', RUNNING: 'ok',
  WARN: 'warn', WARNING: 'warn', DEGRADED: 'warn', PAUSED: 'warn', PENDING: 'warn', STALE: 'warn', SLOW: 'warn',
  FAIL: 'err', FAILED: 'err', FAILING: 'err', ERROR: 'err', DOWN: 'err', CRITICAL: 'err', DISABLED: 'err', UNREACHABLE: 'err',
  INFO: 'info', NOTE: 'info',
}

/** The tone of a status word, or undefined when it is not one. */
export function statusTone(word: string): Tone | undefined {
  return STATUS[word.trim().replace(/[.:!]+$/, '').toUpperCase()]
}

/** The width every badge is padded to, so lines with and without one align. */
export const BADGE_WIDTH = 8

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g

function tidy(text: string, options: DocOptions): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return options.date ? t.replace(ISO, (iso) => options.date!(iso)) : t
}

/** A `Label: value` item: the label ends with a colon and is short. */
function splitLabel(text: string): { label?: string; value: string } {
  const m = /^([^:]{1,48}?):\s+(.+)$/.exec(text)
  if (!m || /https?$/.test(m[1]!) || m[1]!.split(' ').length > 8) return { value: text }
  return { label: m[1]!.trim(), value: m[2]!.trim() }
}

/** The tone of a value under a label: none or 0 under a failure label is good news, a number is bad. */
function valueTone(label: string | undefined, value: string): Tone | undefined {
  const status = statusTone(value)
  if (status) return status
  if (!label || !/fail|error|problem|backoff|exception/i.test(label)) return undefined
  if (/^(none|0|no|never)$/i.test(value.trim())) return 'ok'
  return /^\d+$/.test(value.trim()) ? 'err' : undefined
}

/**
 * Parses widget HTML: h1-h6 headings, paragraphs (a leading <strong> status word is a badge),
 * lists (an item's leading <strong>Label:</strong> makes it a label/value pair). Text outside any
 * block element is a paragraph; <br> ends a paragraph.
 */
export function htmlDocument(html: string, options: DocOptions = {}): DocBlock[] {
  const out: DocBlock[] = []
  type Open = { tag: string; text: string; strongFirst?: string; strongDone?: boolean; href?: string; card?: number; links?: Array<{ text: string; href: string }>; outside?: string }
  let link: { text: string; href: string } | undefined
  let block: Open | undefined
  // open <div>s: the leaf divs of one parent div are the lines of one card (a stat card: label, number, caption)
  const divs: number[] = []
  let divCount = 0
  let list: { items: DocItem[]; ordered: boolean } | undefined
  let item: Open | undefined
  let strong: string | undefined
  const target = () => item ?? block
  const flushBlock = () => {
    if (!block) return
    const text = tidy(block.text, options)
    // a block of only links (button rows): one followable item per link
    if (block.links && block.links.length >= 2 && !(block.outside ?? '').trim()) {
      out.push({ kind: 'list', items: block.links.map((l) => ({ value: tidy(l.text, options), href: l.href })) })
      block = undefined
      return
    }
    if (text) {
      if (/^h\d$/.test(block.tag)) out.push({ kind: 'heading', text, level: Number(block.tag[1]) })
      else {
        const first = block.strongFirst ? tidy(block.strongFirst, options) : undefined
        const tone = first ? statusTone(first) : undefined
        if (first && tone && text.startsWith(first)) out.push({ kind: 'para', text: text.slice(first.length).trim(), badge: { text: first.toUpperCase(), tone } })
        else if (block.card !== undefined) out.push({ kind: 'para', text, card: block.card })
        else out.push(...paragraphs(text))
      }
    }
    block = undefined
  }
  const flushItem = () => {
    if (!item || !list) return
    const text = tidy(item.text, options)
    if (text) {
      const first = item.strongFirst ? tidy(item.strongFirst, options) : undefined
      const pair = first && /:$/.test(first) && text.startsWith(first) ? { label: first.replace(/:$/, '').trim(), value: text.slice(first.length).trim() } : splitLabel(text)
      const tone = valueTone(pair.label, pair.value)
      list.items.push({ ...pair, ...(tone ? { badge: { text: pair.value, tone } } : {}), ...(item.href ? { href: item.href } : {}) })
    }
    item = undefined
  }
  const flushList = () => {
    flushItem()
    if (list?.items.length) out.push({ kind: 'list', items: list.items, ordered: list.ordered })
    list = undefined
  }
  const re = /<(\/?)([A-Za-z][\w-]*)([^>]*)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      const text = decodeEntities(m[4])
      if (!target()) {
        if (!text.trim()) continue
        block = { tag: 'p', text: '' }
      }
      const t = target()!
      if (link) link.text += text
      else t.outside = (t.outside ?? '') + text
      if (strong !== undefined) strong += text
      else if (!t.text.trim() && !text.trim()) continue
      else if (!t.strongDone) t.strongDone = Boolean(t.text.trim() || text.trim())
      t.text += text
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    const attrs = m[3] ?? ''
    if (tag === 'br') {
      if (item) item.text += ' '
      else flushBlock()
      continue
    }
    if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'div' || tag === 'section' || tag === 'blockquote' || tag === 'pre') {
      if (closing) {
        flushBlock()
        if (tag === 'div') divs.pop()
      } else {
        flushBlock()
        if (list && !item) flushList()
        if (tag === 'div') divs.push(++divCount)
        if (!item) block = { tag, text: '', ...(tag === 'div' && divs.length >= 2 ? { card: divs[divs.length - 2] } : {}) }
      }
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      if (closing) flushList()
      else {
        flushBlock()
        flushList()
        list = { items: [], ordered: tag === 'ol' }
      }
      continue
    }
    if (tag === 'li') {
      if (closing) flushItem()
      else {
        flushItem()
        list ??= { items: [], ordered: false }
        item = { tag: 'li', text: '' }
      }
      continue
    }
    if (tag === 'strong' || tag === 'b') {
      const t = target()
      if (!closing) {
        if (!t) block = { tag: 'p', text: '' }
        strong = ''
      } else if (strong !== undefined) {
        const tt = target()
        if (tt && tt.strongFirst === undefined && !tt.text.slice(0, tt.text.length - strong.length).trim()) tt.strongFirst = strong
        strong = undefined
      }
      continue
    }
    if (tag === 'a' && !closing) {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs)
      if (!target()) block = { tag: 'p', text: '' }
      const t = target()!
      const url = href ? decodeEntities(href[1] ?? href[2] ?? '') : ''
      if (url && !t.href) t.href = url
      // adjacent links keep a gap between their texts
      if (t.links?.length && !/\s$/.test(t.text)) t.text += ' · '
      if (url) link = { text: '', href: url }
    } else if (tag === 'a' && closing && link) {
      const t = target()
      if (t) (t.links ??= []).push(link)
      link = undefined
    }
  }
  flushBlock()
  flushList()
  return out
}

/**
 * A paragraph, with enumerations split out: a sentence "Prefix: A, B, C." whose items are three or
 * more short, capitalised names becomes the prefix and a bulleted list.
 */
export function paragraphs(text: string): DocBlock[] {
  const sentences = text.match(/[^.;]+(?:[.;]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text]
  const out: DocBlock[] = []
  let prose: string[] = []
  const flush = () => {
    if (prose.length) out.push({ kind: 'para', text: prose.join(' ') })
    prose = []
  }
  for (const s of sentences) {
    const items = enumeration(s)
    if (!items) {
      prose.push(s)
      continue
    }
    flush()
    out.push({ kind: 'para', text: items.prefix })
    out.push({ kind: 'list', items: items.list.map((value) => ({ value })) })
  }
  flush()
  return out
}

/** "On X (Actions): Add A, Apply B, Remove C." → prefix and items; undefined when it is prose. */
export function enumeration(sentence: string): { prefix: string; list: string[] } | undefined {
  const m = /^(.{0,80}?:)\s+(.+?)[.;]?$/.exec(sentence.trim())
  const body = m ? m[2]! : sentence.trim().replace(/[.;]$/, '')
  const parts = body.split(/,\s+/).map((p) => p.trim().replace(/^(?:and|or)\s+/, '')).filter(Boolean)
  if (parts.length < 3) return undefined
  const named = parts.filter((p) => /^[A-Z0-9]/.test(p) && p.split(/\s+/).length <= 6 && !/[.!?]/.test(p))
  if (named.length / parts.length < 0.8) return undefined
  return { prefix: m ? m[1]! : '', list: parts }
}

/**
 * Plain text as a document: `#` markdown headings, and a short line without a full stop followed
 * by a block is a heading; blank lines separate paragraphs; `- ` / `* ` / `• ` lines are a list.
 */
export function textDocument(text: string, options: DocOptions = {}): DocBlock[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: DocBlock[] = []
  let para: string[] = []
  let items: DocItem[] = []
  const flush = () => {
    if (para.length) out.push(...paragraphs(tidy(para.join(' '), options)))
    if (items.length) out.push({ kind: 'list', items })
    para = []
    items = []
  }
  lines.forEach((raw, i) => {
    const line = raw.trim()
    const next = lines[i + 1]?.trim() ?? ''
    if (!line) return flush()
    const md = /^(#{1,4})\s+(.+)$/.exec(line)
    if (md) {
      flush()
      out.push({ kind: 'heading', text: tidy(md[2]!, options), level: md[1]!.length })
      return
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line)
    if (bullet) {
      if (para.length) { out.push(...paragraphs(tidy(para.join(' '), options))); para = [] }
      const pair = splitLabel(tidy(bullet[1]!, options))
      const tone = valueTone(pair.label, pair.value)
      items.push({ ...pair, ...(tone ? { badge: { text: pair.value, tone } } : {}) })
      return
    }
    if (!para.length && !items.length && next && line.length <= 50 && !/[.:;,!?]$/.test(line) && !statusTone(line.split(' ')[0]!)) {
      flush()
      out.push({ kind: 'heading', text: tidy(line, options), level: 4 })
      return
    }
    const status = /^(\S+)\s+(.+)$/.exec(line)
    if (!para.length && status && statusTone(status[1]!) && status[1] === status[1]!.toUpperCase()) {
      flush()
      out.push({ kind: 'para', text: tidy(status[2]!, options), badge: { text: status[1]!, tone: statusTone(status[1]!)! } })
      return
    }
    para.push(line)
  })
  flush()
  return out
}

/** Whether a document has structure worth drawing (a heading, a badge, a list or several paragraphs). */
export function structured(doc: DocBlock[]): boolean {
  return doc.some((b) => b.kind !== 'para' || b.badge) || doc.length > 2
}

/** Wraps text at a width; long words are cut. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= w) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
    while (line.length > w) {
      out.push(line.slice(0, w))
      line = line.slice(w)
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

/** The reading measure for a pane width: ~100 cells, less when narrower. */
export function measureFor(width: number): number {
  return Math.max(20, Math.min(100, width))
}

/** A line made of coloured segments (its text is their concatenation). */
function segmented(segments: Segment[]): StyledLine {
  return { text: segments.map((s) => s.text).join(''), segments }
}

/** Draws a document at a width (every line fits it). */
export function docLines(doc: DocBlock[], width: number): StyledLine[] {
  const t = theme()
  const g = glyphs()
  const ascii = isAscii()
  const bullet = ascii ? '*' : '•'
  const measure = measureFor(width)
  const toneColor = (tone: Tone) => (tone === 'ok' ? t.ok : tone === 'warn' ? t.warn : tone === 'err' ? t.err : t.acc)
  const out: StyledLine[] = []
  let indent = ''
  const blank = () => { if (out.length && out[out.length - 1]!.text !== '') out.push({ text: '' }) }
  const fit = (line: StyledLine): StyledLine => clipLine(line, width)
  for (const b of doc) {
    if (b.kind === 'heading') {
      blank()
      const level = Math.max(1, Math.min(4, b.level))
      out.push(fit({ text: b.text, fg: t.acc, bold: true }))
      if (level <= 2) out.push(fit({ text: g.rule.repeat(Math.min(measure, Math.max(4, b.text.length))), fg: t.dim }))
      indent = '  '
      continue
    }
    if (b.kind === 'para') {
      const prev = doc[doc.indexOf(b) - 1]
      const sameCard = b.card !== undefined && prev?.kind === 'para' && prev.card === b.card
      if (!sameCard && out.length && out[out.length - 1]!.text !== '' && out[out.length - 1]!.fg !== t.acc) blank()
      const room = measure - indent.length
      if (b.badge) {
        const label = ` ${b.badge.text} `.padEnd(BADGE_WIDTH).slice(0, BADGE_WIDTH)
        const lines = wrapText(b.text, room - BADGE_WIDTH - 1)
        const shown = ascii ? `[${b.badge.text}]`.padEnd(BADGE_WIDTH).slice(0, BADGE_WIDTH) : label
        const color = toneColor(b.badge.tone)
        lines.forEach((l, i) => out.push(fit(i === 0
          ? segmented([{ text: indent }, { text: shown, fg: ascii ? color : t.selFg, bg: ascii ? undefined : color, bold: true }, { text: ` ${l}` }])
          : { text: `${indent}${' '.repeat(BADGE_WIDTH + 1)}${l}` })))
      } else for (const l of wrapText(b.text, room)) out.push(fit({ text: `${indent}${l}` }))
      continue
    }
    // lists: label/value items aligned in two columns, the rest bulleted
    const labelled = b.items.filter((i) => i.label).length
    // labels get what the values leave (short values: whole labels), at least half the measure
    const longestValue = Math.max(0, ...b.items.filter((i) => i.label).map((i) => i.value.length))
    const labelWidth = Math.min(Math.max(0, ...b.items.map((i) => (i.label?.length ?? 0))), Math.max(Math.floor(measure * 0.55), measure - indent.length - Math.min(longestValue, 40) - 2))
    if (out.length && out[out.length - 1]!.text !== '' && out[out.length - 1]!.fg !== t.acc && !(doc[doc.indexOf(b) - 1]?.kind === 'para' && /:$/.test((doc[doc.indexOf(b) - 1] as { text: string }).text))) blank()
    b.items.forEach((it, n) => {
      const mark = b.ordered ? `${n + 1}.` : bullet
      if (it.label && labelled >= Math.ceil(b.items.length / 2)) {
        const lead = `${indent}${trunc(it.label, labelWidth).padEnd(labelWidth)}  `
        const lines = wrapText(it.value, measure - lead.length)
        lines.forEach((l, i) => out.push(fit(i === 0
          ? { ...segmented([{ text: lead, fg: t.dim }, { text: l, fg: it.badge ? toneColor(it.badge.tone) : undefined, bold: Boolean(it.badge) }]), ...(it.href ? { href: it.href } : {}) }
          : { text: `${' '.repeat(lead.length)}${l}` })))
      } else {
        const lead = `${indent}${mark} `
        const text = it.label ? `${it.label}: ${it.value}` : it.value
        const lines = wrapText(text, measure - lead.length)
        lines.forEach((l, i) => out.push(fit({ text: i === 0 ? `${lead}${l}` : `${' '.repeat(lead.length)}${l}`, ...(i === 0 && it.href ? { href: it.href } : {}) })))
      }
    })
  }
  while (out.length && out[out.length - 1]!.text === '') out.pop()
  return out
}
