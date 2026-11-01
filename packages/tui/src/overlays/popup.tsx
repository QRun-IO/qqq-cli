/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A completion popup: a short list of what fits at the cursor (value, label, dim detail), filtered
 * by what is typed, ↑↓ to move, Enter or Tab to insert, Esc to close. The SQL editor and the `:`
 * command line share it. Every line is cut to the popup's width; the border follows the ASCII setting.
 */

import type { Key } from '../keys'
import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'
import { glyphs, theme } from '../theme'
import { pad, trunc } from '../util/text'

export interface PopupItem {
  value: string
  label?: string
  detail?: string
}

export class CompletionPopup {
  cursor = 0
  top = 0
  filter: string

  constructor(readonly items: PopupItem[], filter = '') {
    this.filter = filter
  }

  /** Items whose value or label starts with the filter (ignoring case), then those that contain it. */
  matches(): PopupItem[] {
    const f = this.filter.toLowerCase()
    if (!f) return this.items
    const starts = this.items.filter((i) => i.value.toLowerCase().startsWith(f) || (i.label ?? '').toLowerCase().startsWith(f))
    const contains = this.items.filter((i) => !starts.includes(i) && (i.value.toLowerCase().includes(f) || (i.label ?? '').toLowerCase().includes(f)))
    return [...starts, ...contains]
  }

  setFilter(filter: string): void {
    this.filter = filter
    this.cursor = 0
    this.top = 0
  }

  selected(): PopupItem | undefined {
    return this.matches()[this.cursor]
  }

  /** Movement keys; returns 'insert' (Enter, Tab), 'close' (Esc), true when moved, false for any other key. */
  handle(key: Key, rows = 8): 'insert' | 'close' | boolean {
    const n = this.matches().length
    switch (key.name) {
      case 'escape': return 'close'
      case 'return': case 'tab': return n ? 'insert' : 'close'
      case 'up': this.cursor = Math.max(0, this.cursor - 1); return true
      case 'down': this.cursor = Math.min(n - 1, this.cursor + 1); return true
      case 'pageup': this.cursor = Math.max(0, this.cursor - rows); return true
      case 'pagedown': this.cursor = Math.min(n - 1, this.cursor + rows); return true
      default: return false
    }
  }

  /**
   * The popup's size for the matches: wide enough for the longest name and description, at least
   * `min` (60) and at most `max` (120) columns, never wider than `room` (the screen's inner width).
   * The name column fits the longest name; only descriptions that need the room push it below that
   * (never under 40% of the popup).
   */
  layout(room: number, min = 60, max = 120): PopupLayout {
    const list = this.matches()
    const width = Math.max(Math.min(room, min), Math.min(room, max, 2 + 1 + Math.max(0, ...list.map((i) => labelOf(i).length)) + SEP.length + Math.max(0, ...list.map((i) => (i.detail ?? '').length)) + 1))
    const inner = width - 2
    // the name column fits the longest name; it gives way (down to 40%) only to descriptions that need the room
    const longestName = Math.max(4, ...list.map((i) => labelOf(i).length))
    const longestDetail = Math.max(0, ...list.map((i) => (i.detail ?? '').length))
    const nameW = Math.max(4, Math.min(longestName, Math.max(Math.floor(inner * 0.4), inner - 1 - SEP.length - longestDetail - 1)))
    return { width, inner, nameW, descW: Math.max(1, inner - 1 - nameW - SEP.length - 1) }
  }

  /** An item's lines: `name  ·  description`, the description wrapped onto one more line instead of cut. */
  static rowLines(item: PopupItem, layout: PopupLayout): string[] {
    const name = labelOf(item)
    const detail = (item.detail ?? '').replace(/\s+/g, ' ').trim()
    const head = ` ${pad(name, layout.nameW)}`
    if (!detail) return [pad(head, layout.inner)]
    const parts = wrapWords(detail, layout.descW)
    const lines = [pad(`${head}${SEP}${parts[0] ?? ''}`, layout.inner)]
    if (parts.length > 1) {
      const rest = parts.slice(1).join(' ')
      lines.push(pad(`${' '.repeat(1 + layout.nameW + SEP.length)}${trunc(rest, layout.descW)}`, layout.inner))
    }
    return lines
  }

  /** The items that fit in `maxLines` lines (items may take two), scrolled to keep the cursor visible. */
  windowLines(maxLines: number, layout: PopupLayout): Array<{ item: PopupItem; index: number; lines: string[] }> {
    const list = this.matches()
    this.cursor = Math.min(this.cursor, Math.max(0, list.length - 1))
    if (this.cursor < this.top) this.top = this.cursor
    const fill = () => {
      const out: Array<{ item: PopupItem; index: number; lines: string[] }> = []
      let used = 0
      for (let i = this.top; i < list.length; i++) {
        const lines = CompletionPopup.rowLines(list[i]!, layout)
        if (used + lines.length > maxLines && out.length) break
        out.push({ item: list[i]!, index: i, lines: lines.slice(0, Math.max(1, maxLines - used)) })
        used += lines.length
      }
      return out
    }
    let shown = fill()
    while (shown.length && this.cursor > shown[shown.length - 1]!.index && this.top < this.cursor) {
      this.top++
      shown = fill()
    }
    return shown
  }
}

export interface PopupLayout {
  width: number
  inner: number
  nameW: number
  descW: number
}

const SEP = '  ·  '

function labelOf(item: PopupItem): string {
  return (item.label ?? item.value).replace(/\s+/g, ' ')
}

/** Words into lines of `width` (a word longer than the line is cut). */
function wrapWords(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width) line = next
    else {
      if (line) out.push(line)
      line = word.length > width ? trunc(word, width) : word
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * The popup drawn as a bordered box at (left, top) inside its parent: a dim header with the column
 * titles and the match count, then `name  ·  description` rows (descriptions wrap to a second line),
 * the selected row highlighted across the whole width. `room` is the width it may take; it shows at
 * most `maxLines` rows of items.
 */
export function PopupBox(props: { popup: CompletionPopup; left: number; top: number; room: number; maxLines: number; columns?: [string, string]; insert?: () => void }) {
  const t = theme()
  const g = glyphs()
  const list = props.popup.matches()
  const layout = props.popup.layout(props.room)
  const shown = props.popup.windowLines(Math.max(1, props.maxLines), layout)
  const used = Math.max(1, shown.reduce((a, r) => a + r.lines.length, 0))
  const [nameTitle, descTitle] = props.columns ?? ['name', 'description']
  const count = `${list.length} match${list.length === 1 ? '' : 'es'}${props.popup.filter ? ` for "${props.popup.filter}"` : ''}`
  const titles = ` ${pad(nameTitle, layout.nameW)}${' '.repeat(SEP.length)}${descTitle}`
  // the match count goes at the right of the header line, or on the border when the titles fill the line
  const countFits = titles.length + count.length + 2 <= layout.inner
  const header = countFits ? pad(titles, layout.inner - count.length - 1) + count + ' ' : pad(titles, layout.inner)
  const n = list.length
  const sep = g.border ? '.' : '·'
  // the mouse: the wheel moves the choice, a click selects a row, a double-click inserts it
  return (
    <Zone onClick={() => undefined} onWheel={(e) => {
      if (e.direction !== 'up' && e.direction !== 'down') return false
      props.popup.cursor = Math.max(0, Math.min(n - 1, props.popup.cursor + (e.direction === 'up' ? -e.lines : e.lines)))
    }}>
    <box position="absolute" left={props.left} top={props.top} width={layout.width} height={used + 3} flexDirection="column" overflow="hidden" border borderStyle="single"
      borderColor={t.focusBorder} {...(g.border ? { customBorderChars: g.border } : {})} backgroundColor={t.overlayBg} zIndex={40} {...(countFits ? {} : { title: trunc(` ${count} `, Math.max(0, layout.width - 4)) })}>
      <text flexShrink={0} wrapMode="none" fg={t.dim} bg={t.overlayBg}>{header}</text>
      {shown.length ? shown.map(({ index, lines }) => {
        const selected = index === props.popup.cursor
        return (
          <Zone key={index} {...pickRow(() => { props.popup.cursor = index }, props.insert)}>
            <box flexDirection="column" flexShrink={0}>
              {lines.map((l, j) => {
                const name = j === 0 ? l.slice(0, 1 + layout.nameW) : l.slice(0, 1 + layout.nameW + SEP.length)
                const rest = j === 0 ? l.slice(1 + layout.nameW) : l.slice(name.length)
                const shownRest = j === 0 && rest.startsWith(SEP) ? `  ${sep}  ${rest.slice(SEP.length)}` : rest
                return (
                  <text key={j} flexShrink={0} wrapMode="none" bg={selected ? t.selBg : t.overlayBg}>
                    <span fg={selected ? t.selFg : t.fg} bg={selected ? t.selBg : t.overlayBg}>{name}</span>
                    <span fg={selected ? t.selFg : t.dim} bg={selected ? t.selBg : t.overlayBg}>{shownRest}</span>
                  </text>
                )
              })}
            </box>
          </Zone>
        )
      }) : <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(' (nothing fits here)', layout.inner)}</text>}
    </box>
    </Zone>
  )
}
