/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { ReactNode } from 'react'
import type { Key } from '../keys'
import { borderProps, theme } from '../theme'
import type { StyledLine } from '../widgets'
import { pad } from '../util/text'

/** A row of a scrolling list: a line, optionally selectable with an action. */
export interface Row extends StyledLine {
  action?: () => void
  /** Stable identity of a selectable row (kept across reloads). */
  key?: string
}

/**
 * A scrolling list of lines where some rows are selectable. The cursor moves between selectable
 * rows; PgUp/PgDn/Home/End page; the viewport follows the cursor. State lives in the object.
 */
export class ListModel {
  rows: Row[] = []
  cursor = 0
  top = 0
  height = 10

  setRows(rows: Row[]): void {
    const key = this.rows[this.cursor]?.key
    this.rows = rows
    const again = key ? rows.findIndex((r) => r.key === key) : -1
    if (again >= 0) this.cursor = again
    else if (!rows[this.cursor]?.action) this.cursor = this.firstSelectable(0, 1) ?? 0
  }

  get current(): Row | undefined {
    return this.rows[this.cursor]
  }

  private firstSelectable(from: number, dir: 1 | -1): number | undefined {
    for (let i = from; i >= 0 && i < this.rows.length; i += dir) if (this.rows[i]!.action) return i
    return undefined
  }

  /** Arrow, page and enter keys; returns whether handled. */
  onKey(raw: Key): boolean {
    const page = Math.max(1, this.height - 1)
    // Space and Shift+Space page too (PgUp/PgDn may be taken by the terminal or tmux)
    const key: Key = raw.name === 'space' ? { name: raw.shift ? 'pageup' : 'pagedown', sequence: '' } : raw
    switch (key.name) {
      case 'down': this.cursor = this.firstSelectable(this.cursor + 1, 1) ?? this.cursor; break
      case 'up': this.cursor = this.firstSelectable(this.cursor - 1, -1) ?? this.cursor; break
      case 'pagedown': this.cursor = this.firstSelectable(Math.min(this.rows.length - 1, this.cursor + page), 1) ?? this.firstSelectable(this.rows.length - 1, -1) ?? this.cursor; this.top = Math.min(Math.max(0, this.rows.length - this.height), this.top + page); break
      case 'pageup': this.cursor = this.firstSelectable(Math.max(0, this.cursor - page), -1) ?? this.firstSelectable(0, 1) ?? this.cursor; this.top = Math.max(0, this.top - page); break
      case 'home': this.cursor = this.firstSelectable(0, 1) ?? 0; this.top = 0; break
      case 'end': this.cursor = this.firstSelectable(this.rows.length - 1, -1) ?? this.cursor; this.top = Math.max(0, this.rows.length - this.height); break
      case 'return': this.current?.action?.(); break
      default: return false
    }
    return true
  }

  /** Draws the visible rows. */
  view(width: number, height: number, focused: boolean): ReactNode {
    const t = theme()
    this.height = height
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + height) this.top = this.cursor - height + 1
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - height)))
    const shown = this.rows.slice(this.top, this.top + height)
    const lines = shown.map((r, i) => {
      const sel = this.top + i === this.cursor && Boolean(r.action)
      const text = pad(r.text, width)
      return <text key={i} fg={sel ? (focused ? t.selFg : t.fg) : r.fg ?? t.fg} bg={sel ? (focused ? t.selBg : t.selInactiveBg) : r.bg}>{r.bold ? <strong>{text}</strong> : text}</text>
    })
    while (lines.length < height) lines.push(<text key={`pad${lines.length}`}>{pad('', width)}</text>)
    return <>{lines}</>
  }
}

/** A bordered panel with a title, sized to the screen area. */
export function Panel(props: { title: string; width: number; height: number; focused: boolean; children: ReactNode; bottomTitle?: string }) {
  return (
    <box flexDirection="column" width={props.width} height={props.height} {...borderProps(props.focused)} title={` ${props.title} `} {...(props.bottomTitle ? { bottomTitle: ` ${props.bottomTitle} ` } : {})}>
      {props.children}
    </box>
  )
}
