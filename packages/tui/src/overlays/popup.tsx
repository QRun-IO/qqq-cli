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

  /** The visible lines (label, detail, selected) for `rows` rows, scrolled to the cursor. */
  window(rows: number): Array<{ item: PopupItem; selected: boolean }> {
    const list = this.matches()
    this.cursor = Math.min(this.cursor, Math.max(0, list.length - 1))
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + rows) this.top = this.cursor - rows + 1
    return list.slice(this.top, this.top + rows).map((item, i) => ({ item, selected: this.top + i === this.cursor }))
  }

  /** One popup line in a width: label left, detail right (the label wins the room). */
  static line(item: PopupItem, width: number): { label: string; detail: string } {
    const label = item.label ?? item.value
    const detail = item.detail ?? ''
    const room = Math.max(1, width - 2)
    const shownDetail = detail && label.length + 2 < room ? trunc(detail, Math.min(detail.length, room - label.length - 2, Math.floor(room / 2))) : ''
    const labelW = room - (shownDetail ? shownDetail.length + 1 : 0)
    return { label: ` ${pad(label, labelW)}`, detail: shownDetail ? `${shownDetail} ` : ' ' }
  }
}

/** The popup drawn as a bordered box at (left, top) inside its parent, `width` wide, up to `rows` items. */
export function PopupBox(props: { popup: CompletionPopup; left: number; top: number; width: number; rows: number; title?: string }) {
  const t = theme()
  const g = glyphs()
  const list = props.popup.matches()
  const rows = Math.max(1, Math.min(props.rows, list.length || 1))
  const inner = props.width - 2
  const lines = props.popup.window(rows)
  const title = props.title ?? `${list.length} match${list.length === 1 ? '' : 'es'}${props.popup.filter ? ` · ${props.popup.filter}` : ''}`
  return (
    <box position="absolute" left={props.left} top={props.top} width={props.width} height={rows + 2} flexDirection="column" overflow="hidden" border borderStyle="single"
      borderColor={t.focusBorder} {...(g.border ? { customBorderChars: g.border } : {})} backgroundColor={t.overlayBg} title={trunc(` ${title} `, Math.max(0, props.width - 4))} zIndex={40}>
      {lines.length ? lines.map(({ item, selected }, i) => {
        const { label, detail } = CompletionPopup.line(item, inner)
        return (
          <text key={i} flexShrink={0} wrapMode="none" bg={selected ? t.selBg : t.overlayBg}>
            <span fg={selected ? t.selFg : t.fg} bg={selected ? t.selBg : t.overlayBg}>{label}</span>
            <span fg={selected ? t.selFg : t.dim} bg={selected ? t.selBg : t.overlayBg}>{pad(detail, inner - label.length)}</span>
          </text>
        )
      }) : <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(' (nothing fits here)', inner)}</text>}
    </box>
  )
}
