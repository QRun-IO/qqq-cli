/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Drawing for the developer view: section items as screen lines for a width (grids through the main
 * grid's column layout, JSON through the developer JSON renderer), the scrollable pane with its
 * cursor and scroll bar, and the section bar.
 */

import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'
import type { ReactNode } from 'react'
import type { FieldMetaData } from '../client'
import type { Key } from '../keys'
import { layoutColumns, visibleFrom } from '../screens/table'
import { glyphs, theme, type ThemeTokens } from '../theme'
import { pad, trunc } from '../util/text'
import { clipLine, codeSegLines, jsonSegLines, wrapText, type SegLine, type Tone } from './json'
import { targetText, type Item, type ItemTone, type LinkTarget, type Section } from './model'

/** A span of a screen line. */
export interface Span {
  text: string
  fg?: string
  bold?: boolean
}

/** What `v` opens in the value viewer. */
export interface Viewable {
  title: string
  value?: unknown
  code?: string
  language?: string
}

/** One line of the pane; selectable when it has an id. */
export interface PaneLine {
  spans: Span[]
  id?: string
  /** Enter. */
  run?: () => void
  /** `v` (and Enter when there is no run). */
  view?: Viewable
  /** `y`. */
  copy?: string
  /** Describes the line in the menu. */
  label?: string
}

/** Turns a link target into its action (the screen knows the store). */
export type TargetAction = (target: LinkTarget) => (() => void) | undefined

export function toneColor(t: ThemeTokens, tone: ItemTone | undefined): string {
  return tone ? t[tone] : t.fg
}

export function segColor(t: ThemeTokens, tone: Tone): string {
  switch (tone) {
    case 'key': return t.acc
    case 'string': return t.ok
    case 'number': return t.acc2
    case 'literal': return t.warn
    case 'punct': return t.dim
    default: return t.fg
  }
}

/** Cell text with `—` for empty. */
export function cellText(v: string): string {
  return v.trim() === '' ? '—' : v
}

/**
 * Grid lines for headers and rows in a width: column widths from the main grid's layout
 * (`layoutColumns`), shrunk from the widest when they do not fit, cells cut with `…`, `—` for empty.
 * Columns that still do not fit are left out with a dim line saying how many.
 */
export function gridLines(headers: string[], rows: string[][], width: number): { header: Span[]; rule: Span[]; rows: Span[][]; hidden: number } {
  const t = theme()
  const fields = headers.map((h, i) => ({ name: `c${i}`, label: h, type: 'STRING', adornments: null }) as unknown as FieldMetaData)
  const records = rows.map((r) => ({ values: Object.fromEntries(r.map((v, i) => [`c${i}`, cellText(v)])) }))
  // the grid's layout, without the growth it leaves for values on later pages (these grids have one
  // page): each column at most its longest value or header, plus the gap the grid keeps for a sort mark
  const longestOf = (i: number) => Math.max(headers[i]!.length, ...rows.map((r) => cellText(r[i] ?? '').length)) + 1
  const cols = layoutColumns(fields, records as never, width, { fit: 'natural' } as never).map((c, i) => ({ ...c, width: Math.min(c.width, 40, longestOf(i)) }))
  // too wide: every column gives up width in proportion to what it has above its floor (its longest
  // value up to 10 cells), so headers are cut before short values are
  const longest = headers.map((_, i) => Math.max(1, ...rows.map((r) => cellText(r[i] ?? '').length)))
  const total = cols.reduce((a, c) => a + c.width, 0) + Math.max(0, cols.length - 1)
  if (total > width) {
    const floor = (c: { name: string; width: number }) => Math.min(c.width, Math.max(3, Math.min(10, longest[Number(c.name.slice(1))]!)))
    const slack = cols.reduce((a, c) => a + c.width - floor(c), 0)
    const deficit = Math.min(slack, total - width)
    let taken = 0
    cols.forEach((c, i) => {
      const share = i === cols.length - 1 ? deficit - taken : Math.min(deficit - taken, Math.round((deficit * (c.width - floor(c))) / Math.max(1, slack)))
      c.width -= share
      taken += share
    })
  }
  // visibleFrom counts a gap after every column; the last one needs none
  const shown = visibleFrom(cols, 0, width + 1)
  const index = (name: string) => Number(name.slice(1))
  const header: Span[] = shown.map((c, i) => ({ text: (i ? ' ' : '') + pad(c.label, c.width), fg: t.acc, bold: true }))
  const used = shown.reduce((a, c, i) => a + c.width + (i ? 1 : 0), 0)
  const rule: Span[] = [{ text: glyphs().rule.repeat(Math.max(0, used)), fg: t.border }]
  const body = rows.map((r) => shown.map((c, i) => {
    const raw = r[index(c.name)] ?? ''
    const empty = raw.trim() === ''
    return { text: (i ? ' ' : '') + pad(empty ? '—' : raw, c.width), fg: empty ? t.dim : t.fg }
  }))
  return { header, rule, rows: body, hidden: cols.length - shown.length }
}

/** Lines of JSON or code cut to a width (one source line, one screen line), indented. */
export function codeLines(item: { code?: string; value?: unknown; language?: string }, width: number, indent = 2): { lines: SegLine[]; json?: unknown } {
  const parsed = item.code !== undefined ? codeSegLines(item.code, item.language) : { lines: jsonSegLines(item.value), json: item.value }
  const prefix: SegLine = indent ? [{ text: ' '.repeat(indent), tone: 'plain' }] : []
  return { lines: parsed.lines.map((l) => clipLine([...prefix, ...l], width, glyphs().ellipsis)), ...(parsed.json !== undefined ? { json: parsed.json } : {}) }
}

/** The text a viewable copies (pretty JSON, or the code as written). */
export function viewableText(v: Viewable): string {
  if (v.code !== undefined) {
    const parsed = codeSegLines(v.code, v.language)
    return parsed.json !== undefined ? JSON.stringify(parsed.json, null, 2) : v.code
  }
  return typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2) ?? ''
}

/** A section's items as pane lines for a width. */
export function itemLines(section: Section, width: number, act: TargetAction): PaneLine[] {
  const t = theme()
  const g = glyphs()
  const out: PaneLine[] = []
  const gap = () => { if (out.length && out[out.length - 1]!.spans.length) out.push({ spans: [] }) }
  section.items.forEach((item: Item, n) => {
    switch (item.kind) {
      case 'heading':
        gap()
        out.push({ spans: [{ text: trunc(item.text, width), fg: t.acc, bold: true }] })
        break
      case 'text':
        for (const line of wrapText(item.text, width)) out.push({ spans: [{ text: line, fg: toneColor(t, item.tone) }] })
        break
      case 'empty':
        for (const line of wrapText(item.text, width)) out.push({ spans: [{ text: line, fg: t.dim }] })
        break
      case 'pairs': {
        const lw = Math.min(24, Math.max(4, ...item.pairs.map((p) => p.label.length)), Math.max(4, Math.floor(width / 3)))
        item.pairs.forEach((p, i) => {
          const action = p.target ? act(p.target) : undefined
          const room = width - lw - 2
          const browserOnly = p.target?.kind === 'browser'
          const mark = p.target && !browserOnly ? ` ${g.link}` : ''
          const value = cellText(p.value)
          const spans: Span[] = [{ text: pad(p.label, lw) + '  ', fg: t.dim }, { text: trunc(value + mark, room), fg: p.value.trim() === '' ? t.dim : p.target && !browserOnly ? t.acc : t.fg }]
          out.push({ spans, id: `${section.id}:${n}:p${i}`, label: `${p.label}: ${p.value}`, copy: p.value, ...(action ? { run: action } : {}), ...(value.length + mark.length > room ? { view: { title: p.label, value: p.value } } : {}) })
        })
        break
      }
      case 'grid': {
        if (!item.rows.length) {
          out.push({ spans: [{ text: trunc(item.empty ?? 'No rows.', width), fg: t.dim }] })
          break
        }
        const grid = gridLines(item.headers, item.rows.map((r) => r.cells), width)
        out.push({ spans: grid.header })
        out.push({ spans: grid.rule })
        grid.rows.forEach((spans, i) => {
          const row = item.rows[i]!
          const value = row.value ?? Object.fromEntries(item.headers.map((h, k) => [h, row.cells[k]]))
          out.push({ spans, id: `${section.id}:${n}:r${i}`, label: `${item.title ?? 'Row'}: ${row.cells.filter(Boolean).slice(0, 3).join(' · ')}`, copy: JSON.stringify(value, null, 2), view: { title: `${item.title ?? section.title} · ${row.cells[0] ?? ''}`, value }, ...(row.run ? { run: row.run } : {}) })
        })
        if (grid.hidden) out.push({ spans: [{ text: trunc(`+${grid.hidden} more column${grid.hidden === 1 ? '' : 's'}: v on a row shows all of it`, width), fg: t.dim }] })
        if (item.note) for (const line of wrapText(item.note, width)) out.push({ spans: [{ text: line, fg: t.dim }] })
        break
      }
      case 'code': {
        gap()
        const view: Viewable = { title: item.label, ...(item.code !== undefined ? { code: item.code } : { value: item.value }), ...(item.language ? { language: item.language } : {}) }
        const hint = 'v view · y copy'
        const titles = wrapText(`${item.label}${item.language ? ` (${item.language})` : ''}`, width)
        const last = titles[titles.length - 1]!
        const inline = last.length + 2 + hint.length <= width
        titles.forEach((text, i) => {
          const spans: Span[] = [{ text, fg: t.acc, bold: true }]
          if (i === titles.length - 1 && inline) spans.push({ text: `  ${hint}`, fg: t.dim })
          out.push({ spans, ...(i === 0 ? { id: `${section.id}:${n}:code`, label: `View ${item.label}`, view, copy: viewableText(view) } : {}) })
        })
        if (!inline) out.push({ spans: [{ text: trunc(hint, width), fg: t.dim }] })
        for (const line of codeLines(item, width).lines) out.push({ spans: line.map((s) => ({ text: s.text, fg: segColor(t, s.tone) })) })
        break
      }
      case 'link': {
        const action = act(item.target)
        const browser = item.target.kind === 'browser'
        const head = `${g.link} ${item.label}`
        const tail = browser ? `  ${item.target.kind === 'browser' ? item.target.url : ''}  (browser only)` : `  ${g.pointer} ${targetText(item.target)}`
        out.push({
          spans: [{ text: trunc(head, width), fg: browser ? t.fg : t.acc }, { text: trunc(tail, Math.max(0, width - head.length)), fg: t.dim }],
          id: `${section.id}:${n}:link`,
          label: browser ? `${item.label} (browser only)` : item.label,
          copy: item.target.kind === 'browser' ? item.target.url : targetText(item.target),
          ...(action ? { run: action } : {}),
        })
        if (item.description) out.push({ spans: [{ text: trunc(`  ${item.description}`, width), fg: t.dim }] })
        break
      }
      case 'action':
        out.push({ spans: [{ text: trunc(`${g.closed} ${item.label}`, width), fg: t.acc2 }, { text: item.detail ? trunc(`  ${item.detail}`, Math.max(0, width - item.label.length - 2)) : '', fg: t.dim }], id: `${section.id}:${n}:action`, label: item.label, run: item.run })
        break
    }
  })
  return out
}

/**
 * A scrollable pane over lines: a free scroll offset plus a cursor on the selectable line, if one is
 * in view. ↑↓ move to the next selectable line when it is in view, else scroll one line; PgUp PgDn
 * Space page; Home End.
 */
export class PaneModel {
  top = 0
  /** The id of the selected line. */
  selected?: string
  height = 10
  lines: PaneLine[] = []

  get cursor(): number {
    return this.selected === undefined ? -1 : this.lines.findIndex((l) => l.id === this.selected)
  }

  get current(): PaneLine | undefined {
    const i = this.cursor
    return i >= 0 ? this.lines[i] : undefined
  }

  private maxTop(): number {
    return Math.max(0, this.lines.length - this.height)
  }

  private visible(i: number): boolean {
    return i >= this.top && i < this.top + this.height
  }

  /** Keeps the selection on a visible selectable line (the first one in view when it scrolled away). */
  private settle(prefer: 1 | -1 = 1): void {
    this.top = Math.max(0, Math.min(this.top, this.maxTop()))
    const i = this.cursor
    if (i >= 0 && this.visible(i)) return
    const range = prefer === 1 ? [...Array(this.height).keys()].map((k) => this.top + k) : [...Array(this.height).keys()].map((k) => this.top + this.height - 1 - k)
    const hit = range.find((k) => this.lines[k]?.id)
    this.selected = hit !== undefined ? this.lines[hit]!.id : undefined
  }

  /** Sets the lines (each render) and the height; keeps the selection when its line is still there. */
  update(lines: PaneLine[], height: number): void {
    this.lines = lines
    this.height = Math.max(1, height)
    if (this.selected !== undefined && this.cursor < 0) this.selected = undefined
    this.settle()
  }

  private step(dir: 1 | -1): void {
    const i = this.cursor
    const from = i >= 0 ? i : dir === 1 ? this.top - 1 : this.top + this.height
    for (let k = from + dir; k >= 0 && k < this.lines.length; k += dir) {
      if (!this.lines[k]!.id) continue
      // the next selectable line, when it is in view or one line past the edge (scroll to it)
      if (this.visible(k)) { this.selected = this.lines[k]!.id; return }
      if (dir === 1 && k === this.top + this.height) { this.top++; this.selected = this.lines[k]!.id; return }
      if (dir === -1 && k === this.top - 1) { this.top--; this.selected = this.lines[k]!.id; return }
      break
    }
    this.top = Math.max(0, Math.min(this.maxTop(), this.top + dir))
    if (i >= 0 && !this.visible(i)) this.selected = undefined
    this.settle(dir)
  }

  onKey(raw: Key): boolean {
    const key = raw.name === 'space' ? (raw.shift ? 'pageup' : 'pagedown') : raw.name
    const page = Math.max(1, this.height - 1)
    switch (key) {
      case 'down': this.step(1); break
      case 'up': this.step(-1); break
      case 'pagedown': this.top = Math.min(this.maxTop(), this.top + page); this.settle(1); break
      case 'pageup': this.top = Math.max(0, this.top - page); this.settle(1); break
      case 'home': this.top = 0; this.selected = undefined; this.settle(1); break
      case 'end': this.top = this.maxTop(); this.selected = undefined; this.settle(-1); break
      default: return false
    }
    return true
  }

  /** "lines 1–20 of 48", or "" when everything fits. */
  position(): string {
    if (this.lines.length <= this.height) return ''
    return `lines ${this.top + 1}–${Math.min(this.lines.length, this.top + this.height)} of ${this.lines.length}`
  }

  /** The visible lines after a one-cell margin, with the scroll bar in the last column; `activate` is a double-click (Enter). */
  view(width: number, focused: boolean, activate?: () => void): ReactNode {
    const t = theme()
    const ascii = glyphs().border !== undefined
    const scroll = this.lines.length > this.height
    const inner = width - 1 - (scroll ? 1 : 0)
    const thumbSize = scroll ? Math.max(1, Math.round((this.height * this.height) / this.lines.length)) : 0
    const thumbTop = scroll ? Math.round((this.top / Math.max(1, this.lines.length - this.height)) * (this.height - thumbSize)) : 0
    const cursor = this.cursor
    const rows: ReactNode[] = []
    for (let k = 0; k < this.height; k++) {
      const i = this.top + k
      const line = this.lines[i]
      const sel = i === cursor && line?.id !== undefined
      const bar = scroll ? (k >= thumbTop && k < thumbTop + thumbSize ? (ascii ? '#' : '█') : (ascii ? '|' : '░')) : ''
      let used = 0
      const spans = (line?.spans ?? []).map((s, j) => {
        const text = trunc(s.text, Math.max(0, inner - used))
        used += text.length
        return <span key={j} fg={sel ? (focused ? t.selFg : t.fg) : s.fg ?? t.fg} bg={sel ? (focused ? t.selBg : t.selInactiveBg) : undefined}>{s.bold ? <strong>{text}</strong> : text}</span>
      })
      const select = () => {
        if (this.lines[i]?.id !== undefined) this.selected = this.lines[i]!.id
      }
      rows.push(
        <Zone key={k} {...pickRow(select, activate && line?.id !== undefined ? activate : undefined)}>
        <text flexShrink={0} wrapMode="none">
          <span> </span>
          {spans}
          <span bg={sel ? (focused ? t.selBg : t.selInactiveBg) : undefined}>{' '.repeat(Math.max(0, inner - used))}</span>
          {scroll ? <span fg={t.dim}>{bar}</span> : null}
        </text>
        </Zone>,
      )
    }
    return <>{rows}</>
  }
}

/** The section bar: `1 Security  2 Events …`, the active one highlighted, windowed with ‹ › when it does not fit. */
export function sectionBar(sections: Section[], active: number, width: number, focused: boolean, pick?: (index: number) => void): ReactNode {
  const t = theme()
  const ascii = glyphs().border !== undefined
  const labels = sections.map((s, i) => `${i < 9 ? `${i + 1} ` : ''}${s.label}`)
  // padded cells when they all fit, else tighter ones (then a window around the active section)
  const padded = labels.map((l) => ` ${l} `)
  const cells = padded.reduce((n, c) => n + c.length, 0) <= width ? padded : labels.map((l) => ` ${l}`)
  // the window of sections that fits, keeping the active one in view
  let from = 0
  let to = cells.length
  const size = (a: number, b: number) => cells.slice(a, b).reduce((n, c) => n + c.length, 0) + (a > 0 ? 1 : 0) + (b < cells.length ? 1 : 0)
  while (size(from, to) > width && to - from > 1) {
    if (active - from > to - 1 - active) from++
    else to--
  }
  const left = from > 0 ? (ascii ? '<' : '‹') : ''
  const right = to < cells.length ? (ascii ? '>' : '›') : ''
  let used = left.length + right.length
  // where each section's cell is drawn, for a click
  const at: Array<{ x: number; w: number; i: number }> = []
  let x = left.length
  const spans = cells.slice(from, to).map((c, k) => {
    const i = from + k
    const text = trunc(c, Math.max(0, width - used))
    used += text.length
    at.push({ x, w: text.length, i })
    x += text.length
    const on = i === active
    return <span key={i} fg={on ? (focused ? t.selFg : t.fg) : t.acc} bg={on ? (focused ? t.selBg : t.selInactiveBg) : undefined}>{on ? <strong>{text}</strong> : text}</span>
  })
  return (
    <Zone onClick={(e) => {
      const hit = at.find((a) => e.x >= a.x && e.x < a.x + a.w)
      if (!hit || !pick) return false
      pick(hit.i)
      return false
    }}>
    <text flexShrink={0} wrapMode="none">
      <span fg={t.dim}>{left}</span>
      {spans}
      <span fg={t.dim}>{right}</span>
      <span>{' '.repeat(Math.max(0, width - used))}</span>
    </text>
    </Zone>
  )
}

/** The section's title line: title · status (tone colour). */
export function sectionTitle(section: Section, full: number): ReactNode {
  const t = theme()
  const width = full - 1
  const status = section.status ? `  ${section.status}` : ''
  const title = trunc(section.title, Math.max(1, width - status.length))
  return (
    <text flexShrink={0} wrapMode="none">
      <span> </span>
      <span fg={t.fg}><strong>{title}</strong></span>
      <span fg={toneColor(t, section.statusTone ?? 'dim')}>{trunc(status, Math.max(0, width - title.length))}</span>
      <span>{' '.repeat(Math.max(0, width - title.length - Math.min(status.length, Math.max(0, width - title.length))))}</span>
    </text>
  )
}

/** Plain text of a pane line (tests, menu). */
export function paneText(line: PaneLine): string {
  return line.spans.map((s) => s.text).join('')
}
